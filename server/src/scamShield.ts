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

// Margaret choosing to buy something is normal; another person pushing her to buy or pay is not.
// Each pattern needs both who is pushing ("he", "the caller", "my new friend"...) and how.
const PUSHED_SIGNALS: Array<[string, RegExp]> = [
  [
    'Someone else is pushing a purchase',
    new RegExp(
      [
        /\b(he|she|they|someone|somebody|a man|a woman|the man|the woman|the caller|a caller|a salesman|the salesman|my (new )?friend|this (man|woman|guy|lady))\b.{0,40}\b(insist\w*|pushing|pressur\w*|forcing|forced|making me|keeps? (telling|asking|calling) me|won'?t (stop|leave me alone)|threaten\w*)\b/.source,
        /\b(he|she|they|someone|somebody|a man|a woman|the caller|a salesman|the salesman)\b.{0,30}\b(told|tells|said|says)\b.{0,15}\bi (must|have to|need to|had better)\b.{0,20}\b(buy|pay|order|purchase|send)\b/.source,
        /\b(pressured|pushed|forced|bullied|talked) (me )?into (buying|paying|ordering)\b/.source,
        /\b(i'?m|i am|i feel) (being )?(pressured|pushed|forced|rushed)\b/.source
      ].join('|')
    )
  ]
];

function matchAll(text: string, signals: Array<[string, RegExp]>): string[] {
  return signals.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

// Judged on the current message. Earlier messages only add pretext/pressure when the
// current one asks for a scam payment method ("they said to pay with gift cards"),
// so one scary message doesn't taint every harmless message after it.
export function rulesCheck(message: string, recentContext: string[] = []): ScamCheck {
  const lower = message.toLowerCase();
  const payment = matchAll(lower, PAYMENT_SIGNALS);
  const scope = payment.length ? [...recentContext.slice(-3), message].join('\n').toLowerCase() : lower;
  const pretext = matchAll(scope, PRETEXT_SIGNALS);
  const pressure = matchAll(scope, PRESSURE_SIGNALS);
  // Current message only: being pushed earlier doesn't make her own next request suspicious
  const pushed = matchAll(lower, PUSHED_SIGNALS);
  const signals = [...payment, ...pretext, ...pressure, ...pushed];

  let risk: ScamCheck['risk'] = 'LOW';
  if (payment.length && (pretext.length || pressure.length || pushed.length)) risk = 'HIGH';
  else if (payment.length || pushed.length || (pretext.length && pressure.length)) risk = 'MEDIUM';

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

const SCAM_SYSTEM = `You protect an older adult who shops through an AI assistant. Assess ONLY their latest message: does it show they are being scammed, pressured or exploited right now (e.g. grandparent scam, government or tech-support impersonation, romance scam, prize scam, someone asking them to buy gift cards, crypto or send money)?
- HIGH: clear signs of an active scam, or someone directing them to pay with gift cards, crypto, wire transfers or cash.
- MEDIUM: another person is pushing, rushing or pressuring them to buy or pay for something, or other ambiguous signs worth the caregiver knowing about.
- LOW: the person deciding for themselves to buy something, ordinary shopping or conversation. Buying a gift for a family member, by itself, is LOW. Being in a hurry for something they need (medicine, groceries) is LOW.
Earlier messages are context only. If an earlier message was suspicious but the latest message is the person's own ordinary request (for example tea or a phone charger), rate it LOW. Rate it higher only if the latest message continues the earlier situation (for example "OK, I'll get the cards he wanted").
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
      prompt: `Earlier messages from the older adult (context only):\n${recentContext.slice(-4).join('\n') || '(none)'}\n\nLatest message to assess:\n"${message}"`,
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
