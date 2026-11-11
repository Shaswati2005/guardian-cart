// npm run eval:scam — runs the labeled prompt set through the scam shield and reports
// detection and false-positive rates. Uses Gemini + rules when Gemini is configured, rules only otherwise.
import 'dotenv/config';
import { checkForScam } from '../src/scamShield.js';
import { isLlmConfigured, GEMINI_MODEL } from '../src/llm.js';
import { SCAM_PROMPTS } from './scam-prompts.js';

const engine = isLlmConfigured() ? `Gemini (${GEMINI_MODEL}) + rules` : 'rules only (Gemini not configured)';
console.log(`Scam shield eval: ${SCAM_PROMPTS.length} labeled messages, engine: ${engine}\n`);

let caught = 0, blocked = 0, falseBlocks = 0, headsUps = 0;
const scams = SCAM_PROMPTS.filter(p => p.label === 'scam').length;
const benign = SCAM_PROMPTS.length - scams;
const rows: string[] = [];

for (const p of SCAM_PROMPTS) {
  const result = await checkForScam(p.message);
  const flagged = result.risk !== 'LOW';
  // A benign MEDIUM only sends Sarah a heads-up (the chat continues), so it's reported separately from a false block
  const correct = p.label === 'scam' ? flagged : result.risk !== 'HIGH';
  if (p.label === 'scam' && flagged) caught++;
  if (p.label === 'scam' && result.risk === 'HIGH') blocked++;
  if (p.label === 'benign' && result.risk === 'HIGH') falseBlocks++;
  if (p.label === 'benign' && result.risk === 'MEDIUM') headsUps++;
  rows.push(`${!correct ? 'MISS' : p.label === 'benign' && flagged ? 'warn' : 'ok  '} ${p.label.padEnd(6)} ${result.risk.padEnd(6)} ${p.kind.padEnd(12)} ${p.message.slice(0, 70)}`);
}

console.log(rows.join('\n'));
console.log(`
Scams flagged (MEDIUM/HIGH): ${caught}/${scams} (${Math.round((caught / scams) * 100)}%)
Scams blocked outright (HIGH): ${blocked}/${scams} (${Math.round((blocked / scams) * 100)}%)
Benign messages blocked (HIGH):     ${falseBlocks}/${benign} (${Math.round((falseBlocks / benign) * 100)}%)
Benign with a heads-up to caregiver: ${headsUps}/${benign} (${Math.round((headsUps / benign) * 100)}%)`);
