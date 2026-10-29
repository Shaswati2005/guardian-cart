import { Type } from '@google/genai';
import { generateStructured } from './llm.js';
import { CandidateProduct, Policy, PolicyCategory, PolicyVerdict, POLICY_CATEGORIES, RuleCheckResult } from './types.js';

export interface PolicyContext {
  spentThisWeek: number; // settled purchases in the last 7 days
  reservedThisWeek: number; // pending holds in the last 7 days
  frozen: boolean;
  knownMerchants: string[]; // merchants already bought from successfully
}

const money = (n: number) => `$${n.toFixed(2)}`;
const label = (c: PolicyCategory) => c.replace('_', ' ').toLowerCase();

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
}

/**
 * The only place a purchase decision is made. Pure and deterministic: the LLM can
 * propose anything, but money moves only if this returns APPROVE (or HOLD + a human yes).
 * The strictest outcome across all checks wins.
 */
export function evaluate(
  product: CandidateProduct,
  policy: Policy,
  ctx: PolicyContext
): { verdict: PolicyVerdict; checks: RuleCheckResult[] } {
  const checks: RuleCheckResult[] = [];
  const add = (rule: string, outcome: RuleCheckResult['outcome'], explanation: string) =>
    checks.push({ rule, outcome, passed: outcome === 'PASS', explanation });

  if (ctx.frozen) {
    add('Spending is paused', 'BLOCK', 'The caregiver has paused all purchases.');
  }

  if (policy.blockedCategories.includes(product.category)) {
    add(`Never buy ${label(product.category)}`, 'BLOCK', `"${product.title}" is in a blocked category (${label(product.category)}).`);
  } else if (product.category === 'OTHER' && !policy.allowedCategories.includes('OTHER')) {
    // The deterministic mapper couldn't tell what this is, so it never auto-buys (even with no allowed list)
    add('Unrecognized items need an OK', 'HOLD', `Couldn't tell what kind of item "${product.title}" is, so the caregiver decides.`);
  } else if (policy.approvalCategories.includes(product.category)) {
    add(`Ask first for ${label(product.category)}`, 'HOLD', `${label(product.category)} purchases need the caregiver's OK.`);
  } else if (policy.allowedCategories.length > 0 && !policy.allowedCategories.includes(product.category)) {
    add(
      `Only ${policy.allowedCategories.map(label).join(', ')}`,
      'HOLD',
      `${label(product.category)} is outside the usual categories, so the caregiver decides.`
    );
  } else {
    add('Category allowed', 'PASS', `${label(product.category)} is an allowed category.`);
  }

  if (product.price > policy.perItemMax) {
    add(`Nothing over ${money(policy.perItemMax)}`, 'BLOCK', `${money(product.price)} is above the hard per-item limit.`);
  } else if (product.price > policy.approvalAbove) {
    add(`Ask first above ${money(policy.approvalAbove)}`, 'HOLD', `${money(product.price)} is above the auto-buy limit of ${money(policy.approvalAbove)}.`);
  } else {
    add(`Auto-buy up to ${money(policy.approvalAbove)}`, 'PASS', `${money(product.price)} is within the auto-buy limit.`);
  }

  const committed = ctx.spentThisWeek + ctx.reservedThisWeek;
  if (committed + product.price > policy.weeklyBudget) {
    add(
      `Weekly budget ${money(policy.weeklyBudget)}`,
      'HOLD',
      `${money(committed)} already spent or on hold this week; this would make ${money(committed + product.price)}.`
    );
  } else {
    add(
      `Weekly budget ${money(policy.weeklyBudget)}`,
      'PASS',
      `${money(policy.weeklyBudget - committed - product.price)} would remain this week.`
    );
  }

  const merchant = normalizeDomain(product.merchant);
  const trusted = [...policy.trustedMerchants, ...ctx.knownMerchants].map(normalizeDomain);
  if (policy.newMerchantNeedsApproval && !trusted.includes(merchant)) {
    add('Ask first for new stores', 'HOLD', `${merchant} hasn't been used before.`);
  } else {
    add('Trusted store', 'PASS', `${merchant} is a trusted store.`);
  }

  if (policy.minRating !== undefined) {
    if (product.rating === undefined) {
      add(`Rated ${policy.minRating}+ stars`, 'HOLD', 'This item has no rating to check.');
    } else if (product.rating < policy.minRating) {
      add(`Rated ${policy.minRating}+ stars`, 'HOLD', `Rated ${product.rating}, below ${policy.minRating}.`);
    } else {
      add(`Rated ${policy.minRating}+ stars`, 'PASS', `Rated ${product.rating}.`);
    }
  }

  const verdict: PolicyVerdict = checks.some(c => c.outcome === 'BLOCK')
    ? 'BLOCK'
    : checks.some(c => c.outcome === 'HOLD')
      ? 'HOLD'
      : 'APPROVE';
  return { verdict, checks };
}

export function describePolicy(policy: Policy): string {
  const parts = [
    `Weekly budget ${money(policy.weeklyBudget)}.`,
    `Buys up to ${money(policy.approvalAbove)} automatically; above that the caregiver must approve; nothing over ${money(policy.perItemMax)}.`,
    policy.allowedCategories.length ? `Usual categories: ${policy.allowedCategories.map(label).join(', ')}.` : '',
    policy.approvalCategories.length ? `Ask first: ${policy.approvalCategories.map(label).join(', ')}.` : '',
    policy.blockedCategories.length ? `Never: ${policy.blockedCategories.map(label).join(', ')}.` : '',
    policy.newMerchantNeedsApproval ? `New stores need approval; trusted: ${policy.trustedMerchants.join(', ') || 'none yet'}.` : '',
    policy.minRating !== undefined ? `Prefer items rated ${policy.minRating}+ stars.` : ''
  ];
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Policy compiler: caregiver's plain English -> structured Policy (Gemini
// structured output). The result is shown as a diff and only saved on confirm.
// ---------------------------------------------------------------------------

const categoryArray = { type: Type.ARRAY, items: { type: Type.STRING, enum: [...POLICY_CATEGORIES] } };

const POLICY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    weeklyBudget: { type: Type.NUMBER, description: 'Total USD per rolling 7 days.' },
    perItemMax: { type: Type.NUMBER, description: 'Hard maximum USD for any single item; never bought above this.' },
    approvalAbove: { type: Type.NUMBER, description: 'Items priced above this USD need caregiver approval.' },
    allowedCategories: { ...categoryArray, description: 'Categories bought without asking. Empty means any non-blocked category.' },
    approvalCategories: { ...categoryArray, description: 'Categories that always need caregiver approval.' },
    blockedCategories: { ...categoryArray, description: 'Categories never bought.' },
    minRating: { type: Type.NUMBER, nullable: true, description: 'Minimum star rating (0-5), or null if not mentioned.' },
    trustedMerchants: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Store domains like walgreens.com.' },
    newMerchantNeedsApproval: { type: Type.BOOLEAN },
    unenforcedRules: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Verbatim rules (or parts) that cannot be expressed with the fields above.'
    }
  },
  required: [
    'weeklyBudget',
    'perItemMax',
    'approvalAbove',
    'allowedCategories',
    'approvalCategories',
    'blockedCategories',
    'trustedMerchants',
    'newMerchantNeedsApproval',
    'unenforcedRules'
  ]
};

const COMPILER_SYSTEM = `You convert a family caregiver's plain-English spending rules for an older relative into a structured policy.
- Only encode what the rules actually say. When a value isn't mentioned, keep the value from the current policy.
- Map stores to bare domains (e.g. "Walgreens" -> "walgreens.com").
- Gift cards, cryptocurrency, wire transfers and money orders are common elder-scam payment methods: keep GIFT_CARDS and FINANCIAL blocked unless the caregiver explicitly allows them.
- Keep approvalAbove <= perItemMax.
- Anything you cannot represent goes in unenforcedRules, quoted from the caregiver. Never invent rules.`;

export async function compilePolicy(rules: string[], current: Policy): Promise<Policy> {
  const raw = await generateStructured<Policy & { minRating: number | null }>({
    system: COMPILER_SYSTEM,
    prompt: `Current policy (JSON):\n${JSON.stringify(current)}\n\nCaregiver's rules:\n${rules.map(r => `- ${r}`).join('\n')}`,
    schema: POLICY_SCHEMA
  });
  return sanitizePolicy(raw, current);
}

const isCategory = (c: unknown): c is PolicyCategory => POLICY_CATEGORIES.includes(c as PolicyCategory);

// Used only when there is no current policy to fall back to (first boot)
const DEFAULT_LIMITS = { weeklyBudget: 50, perItemMax: 100, approvalAbove: 25 };

// LLM output is untrusted: clamp numbers and drop unknown values before it can govern spending.
// A missing or invalid number keeps the caregiver's current value rather than a hard-coded one.
export function sanitizePolicy(raw: any, current?: Policy): Policy {
  raw = raw && typeof raw === 'object' ? raw : {};
  const fallback = current ?? DEFAULT_LIMITS;
  const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fb);
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const perItemMax = num(raw.perItemMax, fallback.perItemMax);
  const blocked = list(raw.blockedCategories).filter(isCategory) as PolicyCategory[];
  return {
    weeklyBudget: num(raw.weeklyBudget, fallback.weeklyBudget),
    perItemMax,
    approvalAbove: Math.min(num(raw.approvalAbove, fallback.approvalAbove), perItemMax),
    allowedCategories: list(raw.allowedCategories).filter(isCategory).filter(c => !blocked.includes(c)),
    approvalCategories: list(raw.approvalCategories).filter(isCategory).filter(c => !blocked.includes(c)),
    blockedCategories: blocked,
    minRating: typeof raw.minRating === 'number' && raw.minRating > 0 && raw.minRating <= 5 ? raw.minRating : undefined,
    trustedMerchants: list(raw.trustedMerchants).filter((m): m is string => typeof m === 'string').map(normalizeDomain),
    newMerchantNeedsApproval: Boolean(raw.newMerchantNeedsApproval),
    unenforcedRules: list(raw.unenforcedRules).filter((r): r is string => typeof r === 'string')
  };
}
