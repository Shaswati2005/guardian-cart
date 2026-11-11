// npm run check:ai: checks that ANTHROPIC_API_KEY can reach Claude, and that structured output works
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { AI_MODEL, generateStructured, isLlmConfigured } from '../src/llm.js';

if (!isLlmConfigured()) {
  console.log('No key found. Put your key in server/.env as ANTHROPIC_API_KEY=<your key> (from console.anthropic.com) and run this again.');
  process.exit(1);
}

console.log(`Model: ${AI_MODEL}\n`);

try {
  const out = await generateStructured<{ reply: string }>({
    system: 'You are a connectivity check.',
    prompt: 'Reply with the word OK.',
    schema: { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false },
    effort: 'low'
  });
  console.log(`✔ Claude API: replied "${out.reply}"`);
} catch (err) {
  if (err instanceof Anthropic.AuthenticationError) {
    console.log('✘ Claude API: the key was rejected (401). Create a new key at console.anthropic.com → API Keys.');
  } else if (err instanceof Anthropic.PermissionDeniedError) {
    console.log('✘ Claude API: the key has no access to this model (403). Check the key\'s workspace, or set CLAUDE_MODEL.');
  } else if (err instanceof Anthropic.NotFoundError) {
    console.log(`✘ Claude API: model "${AI_MODEL}" was not found (404). Check CLAUDE_MODEL.`);
  } else if (err instanceof Anthropic.RateLimitError) {
    console.log('✘ Claude API: rate limited or out of credit (429). Check Plans & Billing at console.anthropic.com.');
  } else if (err instanceof Anthropic.APIError) {
    console.log(`✘ Claude API error ${err.status}: ${err.message}`);
  } else {
    console.log(`✘ ${(err as Error).message}`);
  }
  process.exit(1);
}
