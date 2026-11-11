import Anthropic from '@anthropic-ai/sdk';
import { AgentTraceStep } from './types.js';

export const AI_MODEL = (process.env.CLAUDE_MODEL || 'claude-opus-5-5').trim();

type Effort = 'low' | 'medium' | 'high';
type CreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming;
type CreateFn = (params: CreateParams, options?: { signal?: AbortSignal }) => Promise<Anthropic.Beta.BetaMessage>;

// If the model declines a request for policy reasons, the API retries it on a server-chosen fallback model
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

let client: Anthropic | null = null;

const apiKey = () => (process.env.ANTHROPIC_API_KEY || '').trim();

export function isLlmConfigured(): boolean {
  return apiKey() !== '';
}

function getClient(): Anthropic {
  if (!isLlmConfigured()) {
    throw new Error('Claude is not configured: set ANTHROPIC_API_KEY in server/.env (or in the host environment)');
  }
  client ??= new Anthropic({ apiKey: apiKey(), timeout: 60_000, maxRetries: 2 });
  return client;
}

const defaultCreate: CreateFn = (params, options) => getClient().beta.messages.create(params, options);

function textOf(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
}

function assertNotRefused(message: Anthropic.Beta.BetaMessage) {
  if (message.stop_reason === 'refusal') {
    throw new Error(`Claude declined this request${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}`);
  }
}

/** One request that must answer with JSON matching `schema` (Claude structured outputs). */
export async function generateStructured<T>(params: {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  effort?: Effort;
  create?: CreateFn; // tests swap in a fake model
}): Promise<T> {
  const create = params.create ?? defaultCreate;
  const message = await create({
    model: AI_MODEL,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    system: params.system,
    messages: [{ role: 'user', content: params.prompt }],
    output_config: { effort: params.effort ?? 'medium', format: { type: 'json_schema', schema: params.schema } }
  });
  assertNotRefused(message);
  const text = textOf(message);
  if (!text) throw new Error(`Claude returned no content (stop reason: ${message.stop_reason ?? 'unknown'})`);
  return JSON.parse(text) as T;
}

export interface AgentTool {
  declaration: Anthropic.Beta.BetaTool;
  run: (args: Record<string, any>) => Promise<{ result: unknown; summary: string }>;
}

/**
 * Standard tool-use loop: Claude calls tools until it answers in text.
 * Capped at maxSteps model turns so a confused model can't loop (or spend) forever.
 */
export async function runToolLoop(params: {
  system: string;
  history: Anthropic.Beta.BetaMessageParam[];
  tools: AgentTool[];
  maxSteps?: number;
  effort?: Effort;
  onStep?: (step: AgentTraceStep) => void;
  signal?: AbortSignal; // stops the loop (and the in-flight Claude call) when the person leaves
  create?: CreateFn; // tests swap in a fake model
}): Promise<{ text: string; trace: AgentTraceStep[] }> {
  const create = params.create ?? defaultCreate;
  const messages: Anthropic.Beta.BetaMessageParam[] = [...params.history];
  const trace: AgentTraceStep[] = [];
  const tools = params.tools.map(t => t.declaration);
  const maxSteps = params.maxSteps ?? 6;

  const checkAborted = () => {
    if (params.signal?.aborted) throw new Error('The request was cancelled');
  };
  const request = (toolChoice: Anthropic.Beta.BetaToolChoice): CreateParams => ({
    model: AI_MODEL,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    system: params.system,
    tools,
    tool_choice: toolChoice,
    messages,
    output_config: { effort: params.effort ?? 'medium' }
  });

  for (let step = 0; step < maxSteps; step++) {
    checkAborted();
    const response = await create(request({ type: 'auto' }), { signal: params.signal });
    assertNotRefused(response);

    const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (calls.length === 0) return { text: textOf(response), trace };

    // Echo the assistant turn back unchanged (keeps thinking blocks valid for the next request)
    messages.push({ role: 'assistant', content: response.content });

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      const args = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, any>;
      const tool = params.tools.find(t => t.declaration.name === call.name);
      let output: Record<string, unknown>;
      let summary: string;
      let isError = false;

      if (!tool) {
        output = { error: `Unknown tool ${call.name}` };
        summary = `Unknown tool ${call.name}`;
        isError = true;
      } else {
        try {
          const result = await tool.run(args);
          output = { result: result.result };
          summary = result.summary;
        } catch (err: any) {
          output = { error: err.message || String(err) };
          summary = `Error: ${err.message || err}`;
          isError = true;
        }
      }

      const traceStep: AgentTraceStep = { tool: call.name, args, summary, at: new Date().toISOString() };
      trace.push(traceStep);
      params.onStep?.(traceStep);
      results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(output), is_error: isError });
    }
    // All results for one assistant turn go back in a single user message
    messages.push({ role: 'user', content: results });
  }

  // Step budget used up: no more tools, answer in plain text
  checkAborted();
  const final = await create(request({ type: 'none' }), { signal: params.signal });
  assertNotRefused(final);
  return { text: textOf(final), trace };
}
