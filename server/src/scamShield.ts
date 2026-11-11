import { generateStructured, isLlmConfigured } from './llm.js';
import { ScamCheck } from './types.js';

// Patterns drawn from common elder-fraud scripts (FTC / FBI IC3 guidance):
// the scammer needs an untraceable payment method plus a pretext and pressure.
const PAYMENT_SIGNALS: Array<[string, RegExp]> = [
  ['Gift cards requested', /gift ?cards?|itunes|google play card|steam card|apple card code/],
  ['Cryptocurrency requested', /bitcoin|crypto|\bbtc\b|coinbase|crypto atm/],
  ['Wire or cash transfer requested', /wire (the )?money|wire transfer|western union|moneygram|zelle|cash ?app|send cash|money order/]
];

const PRETEXT_SIGNALS: Array<[string, RegExp]> = [
  // Mentioning a grandchild is normal; it's the emergency story around it that signals the scam
  ['Family emergency / impersonation', /\bbail\b|\bjail\b|arrested|in trouble|lawyer|(grand(son|daughter|child|kid)|nephew|niece)\b.{0,80}\b(accident|hospital|stranded|stuck)/],
  ['Government impersonation', /\birs\b|social security|medicare (number|card)|warrant|tax (debt|bill)|police/],
  ['Tech-support scam', /tech support|microsoft|apple support|computer (is )?(infected|hacked)|virus|remote access|teamviewer|anydesk/],
  ['Prize or lottery', /\bwon\b|lottery|sweepstakes|prize|claim (your|my) (reward|prize)|inheritance/],
  ['Romance / new online friend', /(boyfriend|girlfriend|friend) (i met )?online|stuck overseas|needs money to (fly|travel)/]
];

const PRESSURE_SIGNALS: Array<[string, RegExp]> = [
  ['Urgency or pressure', /urgent|right away|right now|immediately|today or|before it'?s too late|hurry/],
  ['Secrecy requested', /don'?t tell|keep (this|it) (a )?secret|not tell (my|your)|between us/],
  ['Unsolicited contact', /(someone|a man|a woman|they) (called|emailed|texted|messaged)|got a call|phone call from/]
];

function matchAll(text: string, signals: Array<[string, RegExp]>): string[] {
  return signals.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

// Judged on the current message. Earlier messages only add pretext/pressure when the
// current one asks for a scam payment method ("they said to pay with gift cards"),
// so one scary message doesn't taint every harmless message after it.
function rulesCheck(message: string, recentContext: string[]): ScamCheck {
  const lower = message.toLowerCase();
  const payment = matchAll(lower, PAYMENT_SIGNALS);
  const scope = payment.length ? [...recentContext.slice(-3), message].join('\n').toLowerCase() : lower;
  const pretext = matchAll(scope, PRETEXT_SIGNALS);
  const pressure = matchAll(scope, PRESSURE_SIGNALS);
  const signals = [...payment, ...pretext, ...pressure];

  let risk: ScamCheck['risk'] = 'LOW';
  if (payment.length && (pretext.length || pressure.length)) risk = 'HIGH';
  else if (payment.length || (pretext.length && pressure.length)) risk = 'MEDIUM';

  return {
    risk,
    signals,
    explanation: signals.length ? `Matched known scam patterns: ${signals.join(', ')}.` : 'No known scam patterns matched.',
    engine: 'RULES_ONLY'
  };
}

const RISK_ORDER: ScamCheck['risk'][] = ['LOW', 'MEDIUM', 'HIGH'];

const SCAM_SCHEMA = {
  type: 'object',
  properties: {
    risk: { type: 'string', enum: RISK_ORDER },
    signals: { type: 'array', items: { type: 'string' }, description: 'Short names of the warning signs present.' },
    explanation: { type: 'string', description: 'One or two sentences for the caregiver explaining the assessment.' }
  },
  required: ['risk', 'signals', 'explanation'],
  additionalProperties: false
};

const SCAM_SYSTEM = `You protect an older adult who shops through an AI assistant. Assess whether their latest message shows signs they are being scammed, pressured or exploited (e.g. grandparent scam, government or tech-support impersonation, romance scam, prize scam, someone asking them to buy gift cards, crypto or send money).
- HIGH: clear signs of an active scam or someone directing them to pay.
- MEDIUM: ambiguous signs worth the caregiver knowing about.
- LOW: ordinary shopping or conversation. Buying a gift for a family member, by itself, is LOW.
Judge only what is in the conversation; do not speculate beyond it.`;

/**
 * Rules set a floor; Claude may raise the risk but never lower it, so an LLM
 * mistake can't wave through a message that matched hard scam patterns.
 */
export async function checkForScam(message: string, recentContext: string[] = []): Promise<ScamCheck> {
  const rules = rulesCheck(message, recentContext);
  if (!isLlmConfigured()) return rules;

  try {
    const ai = await generateStructured<{ risk: ScamCheck['risk']; signals: string[]; explanation: string }>({
      system: SCAM_SYSTEM,
      prompt: `Recent conversation:\n${recentContext.slice(-6).join('\n') || '(none)'}\n\nLatest message from the older adult:\n"${message}"`,
      schema: SCAM_SCHEMA,
      effort: 'low' // a quick classification; keeps the chat responsive
    });
    const aiRisk = RISK_ORDER.includes(ai.risk) ? ai.risk : 'LOW';
    const risk = RISK_ORDER[Math.max(RISK_ORDER.indexOf(rules.risk), RISK_ORDER.indexOf(aiRisk))];
    return {
      risk,
      signals: [...new Set([...rules.signals, ...(ai.signals || [])])],
      explanation: ai.explanation || rules.explanation,
      engine: 'CLAUDE_AI'
    };
  } catch (err: any) {
    console.error('[ScamShield] Claude check failed, using rules only:', err.message);
    return rules;
  }
}
