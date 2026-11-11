// npm run check:ai: finds out how your Google key can reach Gemini (Gemini API or Vertex AI)
// with one tiny request per mode, and tells you what to put in server/.env.
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { GEMINI_MODEL, llmMode } from '../src/llm.js';

const apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
const project = (process.env.GOOGLE_CLOUD_PROJECT || '').trim();
const location = (process.env.GOOGLE_CLOUD_LOCATION || 'us-central1').trim();

const attempts: { name: string; env: string; make: () => GoogleGenAI }[] = [];
if (apiKey) {
  attempts.push({ name: 'Gemini API', env: 'GEMINI_API_KEY=<your key>', make: () => new GoogleGenAI({ apiKey }) });
  attempts.push({
    name: 'Vertex AI express mode',
    env: 'GEMINI_API_KEY=<your key>\nGOOGLE_GENAI_USE_VERTEXAI=true',
    make: () => new GoogleGenAI({ vertexai: true, apiKey })
  });
}
if (project) {
  attempts.push({
    name: `Vertex AI project ${project} (${location})`,
    env: `GOOGLE_GENAI_USE_VERTEXAI=true\nGOOGLE_CLOUD_PROJECT=${project}\nGOOGLE_CLOUD_LOCATION=${location}`,
    make: () => new GoogleGenAI({ vertexai: true, project, location })
  });
}

if (attempts.length === 0) {
  console.log('No key found. Put your key in server/.env as GEMINI_API_KEY=<your key> and run this again.');
  process.exit(1);
}

console.log(`Model: ${GEMINI_MODEL}. Current .env setup: ${llmMode() ?? 'not configured'}\n`);
let working: (typeof attempts)[number] | null = null;
for (const a of attempts) {
  try {
    const res = await a.make().models.generateContent({ model: GEMINI_MODEL, contents: 'Reply with the word OK.' });
    console.log(`✔ ${a.name}: works (replied "${(res.text || '').trim()}")`);
    working ??= a;
  } catch (err: any) {
    console.log(`✘ ${a.name}: ${String(err.message || err).split('\n')[0].slice(0, 220)}`);
  }
}

if (working) {
  console.log(`\nUse this in server/.env (and the same on Render):\n${working.env}`);
} else {
  console.log(
    '\nNothing worked. In the GCP console for the key\'s project, enable "Generative Language API" (for the Gemini API) ' +
      'or "Vertex AI API", and check the key has no API restrictions that block it. Then run this again.'
  );
  process.exit(1);
}
