import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, sanitizePolicy, PolicyContext } from '../src/policy.js';
import { checkForScam } from '../src/scamShield.js';
import { mapCategory } from '../src/products.js';
import { CandidateProduct, Policy } from '../src/types.js';
import { signApprovalAction, verifyApprovalAction } from '../src/notify.js';

// Scam tests exercise the deterministic floor only
delete process.env.ANTHROPIC_API_KEY;
process.env.APP_SECRET = 'test-secret-0123456789';

const policy: Policy = sanitizePolicy({
  weeklyBudget: 60,
  perItemMax: 150,
  approvalAbove: 40,
  allowedCategories: ['HEALTH', 'GROCERY', 'HOUSEHOLD', 'PERSONAL_CARE'],
  approvalCategories: [],
  blockedCategories: ['GIFT_CARDS', 'FINANCIAL'],
  trustedMerchants: ['walgreens.com', 'cvs.com'],
  newMerchantNeedsApproval: true,
  unenforcedRules: []
});

const ctx: PolicyContext = { spentThisWeek: 0, reservedThisWeek: 0, frozen: false, knownMerchants: [] };

function product(overrides: Partial<CandidateProduct>): CandidateProduct {
  return {
    id: 'p1',
    title: 'Replacement Blood Pressure Cuff',
    merchant: 'walgreens.com',
    category: 'HEALTH',
    price: 24.99,
    originalPrice: 24.99,
    discountPercent: 0,
    currency: 'USD',
    rating: 4.5,
    inStock: true,
    imageUrl: '',
    itemUrl: '',
    keyFeatures: [],
    source: 'CURATED',
    ...overrides
  };
}

test('in-policy item from a trusted store is approved', () => {
  assert.equal(evaluate(product({}), policy, ctx).verdict, 'APPROVE');
});

test('price above auto-buy limit is held for the caregiver', () => {
  assert.equal(evaluate(product({ price: 59.99 }), policy, ctx).verdict, 'HOLD');
});

test('price above hard per-item limit is blocked', () => {
  assert.equal(evaluate(product({ price: 199 }), policy, ctx).verdict, 'BLOCK');
});

test('blocked category is blocked regardless of price', () => {
  assert.equal(evaluate(product({ category: 'GIFT_CARDS', price: 10, title: 'Gift card' }), policy, ctx).verdict, 'BLOCK');
});

test('category outside the allowed list is held, not silently bought', () => {
  assert.equal(evaluate(product({ category: 'ELECTRONICS' }), policy, ctx).verdict, 'HOLD');
});

test('weekly budget counts spent plus pending holds', () => {
  const nearlySpent = { ...ctx, spentThisWeek: 30, reservedThisWeek: 20 };
  assert.equal(evaluate(product({ price: 24.99 }), policy, nearlySpent).verdict, 'HOLD');
});

test('new store needs approval; a store used before does not', () => {
  const p = product({ merchant: 'medsupplydeals.shop' });
  assert.equal(evaluate(p, policy, ctx).verdict, 'HOLD');
  assert.equal(evaluate(p, policy, { ...ctx, knownMerchants: ['medsupplydeals.shop'] }).verdict, 'APPROVE');
});

test('paused spending blocks everything', () => {
  assert.equal(evaluate(product({}), policy, { ...ctx, frozen: true }).verdict, 'BLOCK');
});

test('sanitizePolicy clamps LLM output: approvalAbove <= perItemMax, unknown categories dropped', () => {
  const p = sanitizePolicy({
    weeklyBudget: -5,
    perItemMax: 50,
    approvalAbove: 500,
    allowedCategories: ['HEALTH', 'WEAPONS'],
    blockedCategories: ['GIFT_CARDS'],
    approvalCategories: ['GIFT_CARDS'],
    trustedMerchants: ['https://www.CVS.com/pharmacy'],
    newMerchantNeedsApproval: true,
    unenforcedRules: []
  });
  assert.equal(p.weeklyBudget, 50);
  assert.equal(p.approvalAbove, 50);
  assert.deepEqual(p.allowedCategories, ['HEALTH']);
  assert.deepEqual(p.approvalCategories, []);
  assert.deepEqual(p.trustedMerchants, ['cvs.com']);
});

test('grandparent scam asking for gift cards is HIGH risk', async () => {
  const r = await checkForScam('My grandson called, he is in jail and needs me to buy $500 of gift cards right away');
  assert.equal(r.risk, 'HIGH');
});

test('tech-support scam asking for bitcoin is HIGH risk', async () => {
  const r = await checkForScam('Microsoft says my computer is hacked and I must pay them in bitcoin');
  assert.equal(r.risk, 'HIGH');
});

test('ordinary shopping is LOW risk', async () => {
  const r = await checkForScam("I'm almost out of my blood pressure cuffs, can you get me another?");
  assert.equal(r.risk, 'LOW');
});

test('a gift card on its own is flagged MEDIUM (policy still blocks the purchase)', async () => {
  const r = await checkForScam("I'd like a gift card for my granddaughter's birthday");
  assert.equal(r.risk, 'MEDIUM');
});

test('a harmless message after a scam message is not flagged', async () => {
  const r = await checkForScam('I need more blood pressure cuffs', ['My grandson is in jail and needs gift cards right now']);
  assert.equal(r.risk, 'LOW');
});

test('a payment request that follows a scam story is HIGH risk', async () => {
  const r = await checkForScam('They said to pay with gift cards', ['A man called, my grandson is in jail']);
  assert.equal(r.risk, 'HIGH');
});

test('category mapping is deterministic and catches scam payment instruments', () => {
  assert.equal(mapCategory('Apple Gift Card $200'), 'GIFT_CARDS');
  assert.equal(mapCategory('Health & Household > Blood Pressure Monitors', 'Omron cuff'), 'HEALTH');
  assert.equal(mapCategory('Compression Socks for Circulation'), 'HEALTH');
  assert.equal(mapCategory('Twinings English Breakfast Tea'), 'GROCERY');
  assert.equal(mapCategory('Something unrecognizable'), 'OTHER');
});

test('category mapping: substrings no longer mislabel everyday items', () => {
  assert.equal(mapCategory("Women's Winter Coat"), 'CLOTHING'); // was GROCERY via "oat"
  assert.equal(mapCategory('Raincoat'), 'CLOTHING');
  assert.equal(mapCategory('Boat shoes'), 'CLOTHING');
  assert.equal(mapCategory('Memory Foam Pillow'), 'HOUSEHOLD'); // was HEALTH via "pill"
  assert.equal(mapCategory('Electronics > Home Theater > 55 inch TV'), 'ELECTRONICS'); // was HOUSEHOLD via "home"
  assert.equal(mapCategory('8" Tablet with Large-Text Mode', 'Video calls', '12-hour battery'), 'ELECTRONICS');
  assert.equal(mapCategory('Vitamin D3, 100 tablets'), 'HEALTH');
  assert.equal(mapCategory('Weekly Pill Organizer'), 'HEALTH');
  assert.equal(mapCategory('Old Fashioned Rolled Oats'), 'GROCERY');
  assert.equal(mapCategory('Hurricane lamp'), 'OTHER');
});

test('category mapping: gift-card look-alikes are caught', () => {
  assert.equal(mapCategory('Vanilla Visa $100 Prepaid Digital Code'), 'GIFT_CARDS');
  assert.equal(mapCategory('Nintendo eShop $50 Digital Code'), 'GIFT_CARDS');
  assert.equal(mapCategory('Visa Reloadable Prepaid Card'), 'GIFT_CARDS');
  assert.equal(mapCategory('Gift Cards > Retail', 'Store credit'), 'GIFT_CARDS');
});

test('#3 category mapping: realistic titles that used to be mislabeled', () => {
  // Wrongly blocked before
  assert.equal(mapCategory('Dial Gold Bar Soap, 8 Bars'), 'PERSONAL_CARE');
  assert.equal(mapCategory('Regift Bag Set'), 'OTHER');
  // Wrongly auto-buyable before
  assert.equal(mapCategory('Peppermint Candy Canes'), 'GROCERY');
  assert.equal(mapCategory('Johnnie Walker Black Label'), 'OTHER');
  assert.equal(mapCategory('Digital Meat Thermometer'), 'OTHER');
  assert.equal(mapCategory('Large Print Address Book'), 'HOBBIES');
  assert.equal(mapCategory('Horseshoe Set'), 'OTHER');
  assert.equal(mapCategory('Mr. Coffee 12-Cup Coffee Maker'), 'HOUSEHOLD');
  assert.equal(mapCategory('Food Processor, 8 Cup'), 'HOUSEHOLD');
  assert.equal(mapCategory('Purina Dog Food, 30 lb'), 'OTHER');
  // Common health items that used to fall to OTHER
  assert.equal(mapCategory('Tylenol Extra Strength Caplets'), 'HEALTH');
  assert.equal(mapCategory('Advil Ibuprofen, 300 tablets'), 'HEALTH');
  assert.equal(mapCategory('Band-Aid Bandages, Assorted'), 'HEALTH');
  assert.equal(mapCategory('Depend Underwear for Women'), 'HEALTH');
  assert.equal(mapCategory('Readers +2.00, 3 Pack'), 'HEALTH');
  assert.equal(mapCategory('Folding Walker with Wheels'), 'HEALTH');
  assert.equal(mapCategory('Offset Walking Cane'), 'HEALTH');
  // Still caught
  assert.equal(mapCategory('Gold Bars 1 oz Bullion'), 'FINANCIAL');
  assert.equal(mapCategory('Amazon eGift Card'), 'GIFT_CARDS');
  assert.equal(mapCategory('Summer Dress with Pockets'), 'CLOTHING');
  assert.equal(mapCategory('Raincoat'), 'CLOTHING');
});

test('unrecognized items are held even when no allowed list is set', () => {
  const open = { ...policy, allowedCategories: [] };
  assert.equal(evaluate(product({ category: 'OTHER', title: 'Thing' }), open, ctx).verdict, 'HOLD');
  assert.equal(evaluate(product({ category: 'OTHER', title: 'Thing' }), { ...open, allowedCategories: ['OTHER'] }, ctx).verdict, 'APPROVE');
});

test('sanitizePolicy keeps the current value when the AI returns a bad number', () => {
  const current = { ...policy, weeklyBudget: 80, perItemMax: 200, approvalAbove: 30 };
  const p = sanitizePolicy({ weeklyBudget: 'lots', perItemMax: NaN, approvalAbove: -1, blockedCategories: ['GIFT_CARDS'] }, current);
  assert.equal(p.weeklyBudget, 80);
  assert.equal(p.perItemMax, 200);
  assert.equal(p.approvalAbove, 30);
});

test('sanitizePolicy minRating: null, 0 and out of range are dropped', () => {
  assert.equal(sanitizePolicy({ minRating: null }).minRating, undefined);
  assert.equal(sanitizePolicy({ minRating: 0 }).minRating, undefined);
  assert.equal(sanitizePolicy({ minRating: 6 }).minRating, undefined);
  assert.equal(sanitizePolicy({ minRating: 4 }).minRating, 4);
  assert.deepEqual(sanitizePolicy(null).allowedCategories, []);
});

test('email approval links: valid once signed, rejected when expired, tampered or for another action', () => {
  const now = Date.now();
  const token = signApprovalAction('req_1', 'approve', now);
  assert.equal(verifyApprovalAction('req_1', 'approve', token, now), true);
  assert.equal(verifyApprovalAction('req_1', 'decline', token, now), false);
  assert.equal(verifyApprovalAction('req_2', 'approve', token, now), false);
  assert.equal(verifyApprovalAction('req_1', 'approve', token, now + 4 * 24 * 60 * 60 * 1000), false);
  const [exp, sig] = token.split('.');
  assert.equal(verifyApprovalAction('req_1', 'approve', `${Number(exp) + 999999}.${sig}`, now), false);
  assert.equal(verifyApprovalAction('req_1', 'approve', 'garbage', now), false);
});

test('scam rules: every labeled scam is flagged and no labeled benign message is blocked', async () => {
  const { SCAM_PROMPTS } = await import('../scripts/scam-prompts.js');
  for (const p of SCAM_PROMPTS) {
    const r = await checkForScam(p.message);
    if (p.label === 'scam') assert.notEqual(r.risk, 'LOW', `missed scam: ${p.message}`);
    else assert.notEqual(r.risk, 'HIGH', `blocked benign: ${p.message}`);
  }
});

test('someone else pushing Margaret to buy is flagged MEDIUM so Sarah gets a heads-up', async () => {
  for (const msg of [
    'The salesman keeps calling me and insists I buy this vacuum',
    'A man on the phone said I have to buy a new laptop today',
    "I'm being pressured to order this water filter",
    'My new friend is pushing me to pay for his plane ticket'
  ]) {
    assert.equal((await checkForScam(msg)).risk, 'MEDIUM', msg);
  }
});

test('Margaret deciding for herself is not mistaken for pressure', async () => {
  for (const msg of [
    'I want to buy a new kettle',
    'My grandson is visiting next week, can you order some cookies he likes?',
    'I need more Tylenol right away, my knee hurts',
    'She said she loves blue, can you find a blue scarf for my daughter?'
  ]) {
    assert.equal((await checkForScam(msg)).risk, 'LOW', msg);
  }
});

test('being pushed in an earlier message does not taint her own next request', async () => {
  const r = await checkForScam('Can you get me some English breakfast tea?', ['The salesman insists I buy this vacuum']);
  assert.equal(r.risk, 'LOW');
});
