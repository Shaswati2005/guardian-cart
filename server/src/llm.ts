import { GoogleGenAI, Content, FunctionDeclaration, FunctionCallingConfigMode, Part, GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import { AgentTraceStep } from './types.js';

export const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();

let client: GoogleGenAI | null = null;

export function isLlmConfigured(): boolean {
  return Boolean((process.env.GEMINI_API_KEY || '').trim());
}

function getClient(): GoogleGenAI {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in server/.env');
  }
  // The SDK sends the key as a header, not in the URL
  client ??= new GoogleGenAI({ apiKey, httpOptions: { timeout: 30_000 } });
  return client;
}

export async function generateStructured<T>(params: {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
}): Promise<T> {
  const response = await getClient().models.generateContent({
    model: GEMINI_MODEL,
    contents: params.prompt,
    config: {
      systemInstruction: params.system,
      responseMimeType: 'application/json',
      responseSchema: params.schema,
      temperature: 0
    }
  });
  const text = response.text;
  if (!text) {
    throw new Error(`Gemini returned no content (finish reason: ${response.candidates?.[0]?.finishReason ?? 'unknown'})`);
  }
  return JSON.parse(text) as T;
}

export interface AgentTool {
  declaration: FunctionDeclaration;
  run: (args: Record<string, any>) => Promise<{ result: unknown; summary: string }>;
}

/**
 * Standard function-calling loop: the model calls tools until it answers in text.
 * Capped at maxSteps model turns so a confused model can't loop (or spend) forever.
 */
export async function runToolLoop(params: {
  system: string;
  history: Content[];
  tools: AgentTool[];
  maxSteps?: number;
  onStep?: (step: AgentTraceStep) => void;
  signal?: AbortSignal; // stops the loop (and the in-flight Gemini call) when the person leaves
  generate?: (request: GenerateContentParameters) => Promise<GenerateContentResponse>; // tests swap in a fake model
}): Promise<{ text: string; trace: AgentTraceStep[] }> {
  const generate = params.generate ?? (request => getClient().models.generateContent(request));
  const contents: Content[] = [...params.history];
  const trace: AgentTraceStep[] = [];
  const declarations = params.tools.map(t => t.declaration);
  const maxSteps = params.maxSteps ?? 6;

  const checkAborted = () => {
    if (params.signal?.aborted) throw new Error('The request was cancelled');
  };

  for (let step = 0; step < maxSteps; step++) {
    checkAborted();
    const response = await generate({
      model: GEMINI_MODEL,
      contents,
      config: {
        systemInstruction: params.system,
        tools: [{ functionDeclarations: declarations }],
        temperature: 0.3,
        abortSignal: params.signal
      }
    });

    // Echo the model turn back verbatim (keeps any thought signatures intact)
    const modelContent = response.candidates?.[0]?.content;
    if (modelContent) contents.push(modelContent);

    const calls = response.functionCalls;
    if (!calls || calls.length === 0) {
      return { text: response.text?.trim() || '', trace };
    }

    const responseParts: Part[] = [];
    for (const call of calls) {
      const name = call.name || '';
      const args = (call.args || {}) as Record<string, any>;
      const tool = params.tools.find(t => t.declaration.name === name);
      let output: Record<string, unknown>;
      let summary: string;

      if (!tool) {
        output = { error: `Unknown tool ${name}` };
        summary = `Unknown tool ${name}`;
      } else {
        try {
          const result = await tool.run(args);
          output = { result: result.result };
          summary = result.summary;
        } catch (err: any) {
          output = { error: err.message || String(err) };
          summary = `Error: ${err.message || err}`;
        }
      }

      const traceStep: AgentTraceStep = { tool: name, args, summary, at: new Date().toISOString() };
      trace.push(traceStep);
      params.onStep?.(traceStep);
      responseParts.push({ functionResponse: { id: call.id, name, response: output } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  // Step budget used up: force a plain-text answer
  checkAborted();
  const final = await generate({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction: params.system,
      tools: [{ functionDeclarations: declarations }],
      toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } },
      abortSignal: params.signal
    }
  });
  return { text: final.text?.trim() || '', trace };
}
