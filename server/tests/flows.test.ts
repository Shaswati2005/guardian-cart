// Money flows end to end against a fake PayPal gateway and a throwaway data directory.
// Each test file runs in its own process, so these env vars only affect this file.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-cart-test-'));
process.env.PAYPAL_VAULT_ID = 'TESTVAULT';
delete process.env.RESEND_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { db, getDefaultAgents } = await import('../src/db.js');
const agentModule = await import('../src/agent.js');
const { PayPalApiError } = await import('../src/paypal.js');
const { getProduct } = await import('../src/products.js');
const { runToolLoop } = await import('../src/llm.js');
const {
  paymentGateway,
  acceptProposal,
  declineProposal,
  approveEscalatedTransaction,
  rejectEscalatedTransaction,
  refundSettledTransaction,
  expireStaleHolds,
  applyPayPalEvent,
  resetDemo,
  buildTools
} = agentModule;
import type { Proposal } from '../src/types.js';

const AGENT = 'agent-margaret';
const calls: Array<{ fn: string; args: any }> = [];
let seq = 0;

// Fake PayPal: records every call; individual tests override single methods
function installFakeGateway() {
  calls.length = 0;
  Object.assign(paymentGateway, {
    createVaultedOrder: async (args: any) => {
      calls.push({ fn: 'createVaultedOrder', args });
      await new Promise(r => setTimeout(r, 5)); // let concurrent callers interleave if they could
      const n = ++seq;
      return args.intent === 'CAPTURE'
        ? { orderId: `ORDER${n}`, status: 'COMPLETED', captureId: `CAP${n}`, captureStatus: 'COMPLETED', raw: {} }
        : { orderId: `ORDER${n}`, status: 'COMPLETED', authorizationId: `AUTH${n}`, authorizationExpiresAt: new Date(Date.now() + 29 * 864e5).toISOString(), raw: {} };
    },
    captureAuthorization: async (id: string) => {
      calls.push({ fn: 'captureAuthorization', args: id });
      return { captureId: `CAP-${id}`, status: 'COMPLETED', raw: {} };
    },
    voidAuthorization: async (id: string) => {
      calls.push({ fn: 'voidAuthorization', args: id });
    },
    refundCapture: async (args: any) => {
      calls.push({ fn: 'refundCapture', args });
      return { refundId: `REF-${args.captureId}`, status: 'COMPLETED', refundedAt: new Date().toISOString(), raw: {} };
    },
    getCaptureStatus: async (id: string) => {
      calls.push({ fn: 'getCaptureStatus', args: id });
      return 'PENDING';
    }
  });
}

function propose(productId: string): Proposal {
  const product = getProduct(productId)!;
  const proposal: Proposal = {
    id: `prop_t${++seq}`,
    agentId: AGENT,
    goal: 'test',
    product: { ...product },
    alternatives: [],
    reasonForUser: 'test',
    policyPreview: { verdict: 'APPROVE', checks: [] },
    agentTrace: [],
    status: 'PROPOSED',
    createdAt: new Date().toISOString()
  };
  return db.saveProposal(proposal);
}

beforeEach(async () => {
  installFakeGateway();
  db.resetDemoData();
  // Reset keeps the caregiver's rules, so restore the seed rules explicitly between tests
  db.saveAgent({ ...getDefaultAgents()[0] });
});

test('in-policy purchase captures once, keyed on the proposal so a retry cannot pay twice', async () => {
  const p = propose('cur-bp-cuff'); // $24.99 at walgreens.com, HEALTH
  const { transaction } = await acceptProposal(p.id);
  assert.equal(transaction.status, 'AUTO_EXECUTED');
  assert.equal(transaction.captureStatus, 'COMPLETED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.idempotencyKey, p.id);
  assert.equal(calls[0].args.intent, 'CAPTURE');
  await assert.rejects(acceptProposal(p.id), /no longer available/);
  assert.equal(calls.length, 1);
});

test('two Yes taps at the same moment cannot both pass the weekly budget', async () => {
  // $60 budget, each item is $34.99 (under the $40 auto-buy limit): only one fits
  const a = propose('cur-heating-pad');
  const b = propose('cur-heating-pad');
  const [ra, rb] = await Promise.all([acceptProposal(a.id), acceptProposal(b.id)]);
  const statuses = [ra.transaction.status, rb.transaction.status].sort();
  assert.deepEqual(statuses, ['AUTO_EXECUTED', 'PENDING_APPROVAL']);
  assert.deepEqual(calls.map(c => c.args.intent).sort(), ['AUTHORIZE', 'CAPTURE']);
});

test('held purchase: approve captures the authorization', async () => {
  const { approvalRequest, transaction } = await acceptProposal(propose('cur-bp-monitor').id); // $59.99 > $40
  assert.equal(transaction.status, 'PENDING_APPROVAL');
  assert.ok(transaction.authorizationExpiresAt);
  const tx = await approveEscalatedTransaction(approvalRequest!.id);
  assert.equal(tx.status, 'APPROVED_BY_HUMAN');
  assert.equal(tx.paypalCaptureId, `CAP-${transaction.paypalAuthorizationId}`);
  assert.equal(db.getApproval(approvalRequest!.id)!.status, 'APPROVED');
  await assert.rejects(approveEscalatedTransaction(approvalRequest!.id), /already resolved/);
});

test('held purchase: decline still resolves when PayPal already closed the hold', async () => {
  const { approvalRequest } = await acceptProposal(propose('cur-bp-monitor').id);
  paymentGateway.voidAuthorization = async () => {
    throw new PayPalApiError('voided', 422, 'AUTHORIZATION_VOIDED');
  };
  const tx = await rejectEscalatedTransaction(approvalRequest!.id);
  assert.equal(tx.status, 'REJECTED');
  assert.equal(db.getApprovals().length, 0);
});

test('held purchase: a real PayPal error on decline is not swallowed', async () => {
  const { approvalRequest } = await acceptProposal(propose('cur-bp-monitor').id);
  paymentGateway.voidAuthorization = async () => {
    throw new PayPalApiError('server error', 500, 'INTERNAL_SERVER_ERROR');
  };
  await assert.rejects(rejectEscalatedTransaction(approvalRequest!.id), /server error/);
  assert.equal(db.getApproval(approvalRequest!.id)!.status, 'PENDING');
});

test('expired holds leave "Needs your OK" and approving one pays nothing', async () => {
  const { approvalRequest, transaction } = await acceptProposal(propose('cur-bp-monitor').id);
  const tx = db.getTransaction(transaction.id)!;
  db.saveTransaction({ ...tx, authorizationExpiresAt: new Date(Date.now() - 1000).toISOString() });
  await assert.rejects(approveEscalatedTransaction(approvalRequest!.id), /expired/);
  assert.equal(db.getTransaction(transaction.id)!.status, 'EXPIRED');
  assert.ok(!calls.some(c => c.fn === 'captureAuthorization'));

  const second = await acceptProposal(propose('cur-bp-monitor').id);
  const tx2 = db.getTransaction(second.transaction.id)!;
  db.saveTransaction({ ...tx2, authorizationExpiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(expireStaleHolds(), 1);
  assert.equal(db.getApprovals().length, 0);
});

test('refund of a still-pending capture is refused until PayPal completes it', async () => {
  paymentGateway.createVaultedOrder = async (args: any) => ({
    orderId: 'ORDERP', status: 'COMPLETED', captureId: 'CAPP', captureStatus: 'PENDING', raw: args
  });
  const { transaction } = await acceptProposal(propose('cur-bp-cuff').id);
  await assert.rejects(refundSettledTransaction(transaction.id), /hasn't finished/);
  assert.ok(!calls.some(c => c.fn === 'refundCapture'));

  paymentGateway.getCaptureStatus = async () => 'COMPLETED';
  const refunded = await refundSettledTransaction(transaction.id);
  assert.equal(refunded.status, 'REFUNDED');
  await assert.rejects(refundSettledTransaction(transaction.id), /Cannot refund/);
});

test('weekly spend: refunds free the budget, holds are reserved, older purchases drop out', async () => {
  const paid = await acceptProposal(propose('cur-bp-cuff').id);
  await acceptProposal(propose('cur-bp-monitor').id); // held
  let spend = db.getWeeklySpend(AGENT);
  assert.equal(spend.spent, 24.99);
  assert.equal(spend.reserved, 59.99);

  await refundSettledTransaction(paid.transaction.id);
  spend = db.getWeeklySpend(AGENT);
  assert.equal(spend.spent, 0);

  const old = await acceptProposal(propose('cur-tea').id);
  db.saveTransaction({ ...db.getTransaction(old.transaction.id)!, createdAt: new Date(Date.now() - 8 * 864e5).toISOString() });
  assert.equal(db.getWeeklySpend(AGENT).spent, 0);
});

test('verified webhooks update state: outside refund, denied capture, voided hold, retries ignored', async () => {
  const paid = await acceptProposal(propose('cur-bp-cuff').id);
  const capId = paid.transaction.paypalCaptureId!;
  const refund = {
    id: 'WH-1',
    event_type: 'PAYMENT.CAPTURE.REFUNDED',
    resource: { id: 'REFUND9', create_time: '2026-10-28T00:00:00Z', links: [{ rel: 'up', href: `https://api/v2/payments/captures/${capId}` }] }
  };
  assert.equal(applyPayPalEvent(refund)!.status, 'REFUNDED');
  assert.equal(db.getTransaction(paid.transaction.id)!.paypalRefundId, 'REFUND9');
  applyPayPalEvent(refund);
  assert.equal(db.getTransaction(paid.transaction.id)!.paypalEvents!.length, 1);

  const second = await acceptProposal(propose('cur-tea').id);
  applyPayPalEvent({ id: 'WH-2', event_type: 'PAYMENT.CAPTURE.DENIED', resource: { id: second.transaction.paypalCaptureId, status: 'DECLINED' } });
  assert.equal(db.getTransaction(second.transaction.id)!.status, 'FAILED');

  const held = await acceptProposal(propose('cur-bp-monitor').id);
  applyPayPalEvent({ id: 'WH-3', event_type: 'PAYMENT.AUTHORIZATION.VOIDED', resource: { id: held.transaction.paypalAuthorizationId } });
  assert.equal(db.getTransaction(held.transaction.id)!.status, 'REJECTED');
  assert.equal(db.getApproval(held.approvalRequest!.id)!.status, 'REJECTED');
});

test('reset releases open PayPal holds and keeps the caregiver rules and pause state', async () => {
  const held = await acceptProposal(propose('cur-bp-monitor').id);
  const agent = db.getAgent(AGENT)!;
  db.saveAgent({ ...agent, policy: { ...agent.policy, weeklyBudget: 10 } });
  db.updateAgentStatus(AGENT, 'PAUSED');

  const { voidFailures } = await resetDemo();
  assert.equal(voidFailures, 0);
  assert.ok(calls.some(c => c.fn === 'voidAuthorization' && c.args === held.transaction.paypalAuthorizationId));
  const after = db.getAgent(AGENT)!;
  assert.equal(after.policy.weeklyBudget, 10);
  assert.equal(after.status, 'PAUSED');
  assert.equal(db.getTransactions().length, 0);
});

test('decline after PayPal already captured the hold records it as paid instead of looping forever', async () => {
  const { approvalRequest, transaction } = await acceptProposal(propose('cur-bp-monitor').id);
  paymentGateway.voidAuthorization = async () => {
    throw new PayPalApiError('captured', 422, 'PREVIOUSLY_CAPTURED');
  };
  await assert.rejects(rejectEscalatedTransaction(approvalRequest!.id), /can no longer be declined/);
  assert.equal(db.getTransaction(transaction.id)!.status, 'APPROVED_BY_HUMAN');
  assert.equal(db.getApprovals().length, 0);
});

test('a retry after a crash repeats the first PayPal request even if the rules changed in between', async () => {
  const p = propose('cur-bp-cuff'); // APPROVE → CAPTURE
  paymentGateway.createVaultedOrder = async (args: any) => {
    calls.push({ fn: 'createVaultedOrder', args });
    throw new Error('crash after PayPal received the request');
  };
  await assert.rejects(acceptProposal(p.id), /crash/);
  assert.equal(db.getProposal(p.id)!.paymentIntent, 'CAPTURE');

  // Sarah tightens the rules so the item would now be HOLD; the retry must still send CAPTURE
  const agent = db.getAgent(AGENT)!;
  db.saveAgent({ ...agent, policy: { ...agent.policy, approvalAbove: 5 } });
  installFakeGateway();
  const { transaction } = await acceptProposal(p.id);
  assert.equal(calls[0].args.intent, 'CAPTURE');
  assert.equal(calls[0].args.idempotencyKey, p.id);
  assert.equal(transaction.status, 'AUTO_EXECUTED');
});

test('reset blocks new purchases until it finishes, so no hold is left behind', async () => {
  await acceptProposal(propose('cur-bp-monitor').id);
  let releaseVoid!: () => void;
  paymentGateway.voidAuthorization = async (id: string) => {
    calls.push({ fn: 'voidAuthorization', args: id });
    await new Promise<void>(r => (releaseVoid = r));
  };
  const resetting = resetDemo();
  await new Promise(r => setTimeout(r, 10));
  const p = propose('cur-tea');
  const accepting = acceptProposal(p.id); // must wait for the reset
  releaseVoid();
  await resetting;
  // The reset cleared proposals, so the queued accept finds nothing to buy rather than an orphan hold
  await assert.rejects(accepting, /no longer available/);
  assert.equal(db.getTransactions().length, 0);
});

test('#1 a failed Yes never lets a later Yes skip a pause: no mandate does not pin the intent', async () => {
  const p = propose('cur-bp-cuff');
  const saved = process.env.PAYPAL_VAULT_ID;
  delete process.env.PAYPAL_VAULT_ID;
  try {
    await assert.rejects(acceptProposal(p.id), /No PayPal payment mandate/);
  } finally {
    process.env.PAYPAL_VAULT_ID = saved;
  }
  assert.equal(db.getProposal(p.id)!.paymentIntent, undefined);
  assert.equal(calls.length, 0);
});

test('#1 BLOCK always wins over a remembered intent (paused after a crashed attempt)', async () => {
  const p = propose('cur-bp-cuff');
  paymentGateway.createVaultedOrder = async () => {
    throw new Error('network timeout');
  };
  await assert.rejects(acceptProposal(p.id), /network timeout/);
  assert.equal(db.getProposal(p.id)!.paymentIntent, 'CAPTURE'); // unknown outcome: kept for a safe retry

  db.updateAgentStatus(AGENT, 'PAUSED');
  installFakeGateway();
  const { transaction, decisionReceipt } = await acceptProposal(p.id);
  assert.equal(transaction.status, 'BLOCKED');
  assert.equal(decisionReceipt.policyVerdict, 'BLOCK');
  assert.equal(calls.length, 0);
});

test('#1 BLOCK wins for a remembered hold too (now over the hard per-item limit)', async () => {
  const p = propose('cur-bp-monitor'); // HOLD → AUTHORIZE
  paymentGateway.createVaultedOrder = async () => {
    throw new Error('crash');
  };
  await assert.rejects(acceptProposal(p.id));
  assert.equal(db.getProposal(p.id)!.paymentIntent, 'AUTHORIZE');
  const agent = db.getAgent(AGENT)!;
  db.saveAgent({ ...agent, policy: { ...agent.policy, perItemMax: 10, approvalAbove: 10 } });
  installFakeGateway();
  assert.equal((await acceptProposal(p.id)).transaction.status, 'BLOCKED');
  assert.equal(calls.length, 0);
});

test('#1 a definite PayPal rejection (4xx, no order created) clears the remembered intent', async () => {
  const p = propose('cur-bp-cuff');
  paymentGateway.createVaultedOrder = async () => {
    throw new PayPalApiError('bad request', 422, 'PAYEE_ACCOUNT_RESTRICTED');
  };
  await assert.rejects(acceptProposal(p.id), /bad request/);
  assert.equal(db.getProposal(p.id)!.paymentIntent, undefined);
});

test('#4 a hold captured outside the app is recorded as paid, and refund points to PayPal', async () => {
  const { approvalRequest, transaction } = await acceptProposal(propose('cur-bp-monitor').id);
  paymentGateway.captureAuthorization = async () => {
    throw new PayPalApiError('already captured', 422, 'AUTHORIZATION_ALREADY_CAPTURED');
  };
  const tx = await approveEscalatedTransaction(approvalRequest!.id);
  assert.equal(tx.status, 'APPROVED_BY_HUMAN');
  assert.equal(tx.captureStatus, 'CAPTURED_OUTSIDE_APP');
  await assert.rejects(refundSettledTransaction(transaction.id), /PayPal dashboard/);
  assert.ok(!calls.some(c => c.fn === 'refundCapture'));
});

test('R4#1 approving a hold PayPal declines is a failed payment, not "Approved & paid"', async () => {
  const { approvalRequest, transaction } = await acceptProposal(propose('cur-bp-monitor').id);
  paymentGateway.captureAuthorization = async (id: string) => ({ captureId: `CAP-${id}`, status: 'DECLINED', raw: {} });
  await assert.rejects(approveEscalatedTransaction(approvalRequest!.id), /declined this payment/);
  const tx = db.getTransaction(transaction.id)!;
  assert.equal(tx.status, 'FAILED');
  assert.equal(tx.captureStatus, 'DECLINED');
  assert.equal(db.getApproval(approvalRequest!.id)!.status, 'APPROVED');
  assert.equal(db.getWeeklySpend(AGENT).spent, 0);
});

test('R4#1 a refund PayPal fails leaves the purchase as paid', async () => {
  const { transaction } = await acceptProposal(propose('cur-bp-cuff').id);
  paymentGateway.refundCapture = async () => ({ refundId: 'REF1', status: 'FAILED', refundedAt: new Date().toISOString(), raw: {} });
  await assert.rejects(refundSettledTransaction(transaction.id), /didn't complete the refund/);
  assert.equal(db.getTransaction(transaction.id)!.status, 'AUTO_EXECUTED');
  assert.ok(db.getWeeklySpend(AGENT).spent > 0);
});

test('R4#3 a declined auto-buy is recorded as failed with an alert, and the suggestion is closed', async () => {
  const p = propose('cur-bp-cuff');
  paymentGateway.createVaultedOrder = async () => ({ orderId: 'ORDERX', status: 'COMPLETED', captureId: 'CAPX', captureStatus: 'DECLINED', raw: {} });
  const { transaction } = await acceptProposal(p.id);
  assert.equal(transaction.status, 'FAILED');
  assert.equal(db.getProposal(p.id)!.status, 'ACCEPTED');
  assert.ok(db.getAlerts(AGENT).some(a => a.title.startsWith('PayPal declined')));
  assert.equal(db.getWeeklySpend(AGENT).spent, 0);
});

test('R4#4 a capture webhook for a hold captured outside the app makes in-app refunds possible', async () => {
  const { approvalRequest, transaction } = await acceptProposal(propose('cur-bp-monitor').id);
  paymentGateway.captureAuthorization = async () => {
    throw new PayPalApiError('already captured', 422, 'AUTHORIZATION_ALREADY_CAPTURED');
  };
  await approveEscalatedTransaction(approvalRequest!.id);
  applyPayPalEvent({
    id: 'WH-OUT',
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: 'CAPOUTSIDE1', supplementary_data: { related_ids: { authorization_id: transaction.paypalAuthorizationId } } }
  });
  assert.equal(db.getTransaction(transaction.id)!.paypalCaptureId, 'CAPOUTSIDE1');
  assert.equal((await refundSettledTransaction(transaction.id)).status, 'REFUNDED');
});

test('R4#6 declining a hold that already lapsed is recorded as expired, without calling PayPal', async () => {
  const { approvalRequest, transaction } = await acceptProposal(propose('cur-bp-monitor').id);
  db.saveTransaction({ ...db.getTransaction(transaction.id)!, authorizationExpiresAt: new Date(Date.now() - 1000).toISOString() });
  const tx = await rejectEscalatedTransaction(approvalRequest!.id);
  assert.equal(tx.status, 'EXPIRED');
  assert.equal(db.getApproval(approvalRequest!.id)!.status, 'EXPIRED');
  assert.ok(!calls.some(c => c.fn === 'voidAuthorization'));
});

test('#6 "No thanks" waits for a Yes already in flight instead of being overwritten', async () => {
  const p = propose('cur-bp-cuff');
  let release!: () => void;
  const original = paymentGateway.createVaultedOrder;
  paymentGateway.createVaultedOrder = async (args: any) => {
    await new Promise<void>(r => (release = r));
    return original(args);
  };
  const accepting = acceptProposal(p.id);
  await new Promise(r => setTimeout(r, 10));
  const declining = declineProposal(p.id);
  release();
  const { transaction } = await accepting;
  await assert.rejects(declining, /no longer available/);
  assert.equal(db.getProposal(p.id)!.status, 'ACCEPTED');
  assert.equal(transaction.status, 'AUTO_EXECUTED');

  // And the other order: a decline first means a later Yes buys nothing
  const q = propose('cur-tea');
  await declineProposal(q.id);
  await assert.rejects(acceptProposal(q.id), /no longer available/);
});

test('a PayPal connection deleted on PayPal stays disconnected even with PAYPAL_VAULT_ID set', () => {
  assert.equal(db.getMandate()?.paymentTokenId, 'TESTVAULT');
  applyPayPalEvent({ id: 'WH-V', event_type: 'VAULT.PAYMENT-TOKEN.DELETED', resource: { id: 'TESTVAULT' } });
  assert.equal(db.getMandate(), undefined);
  db.resetDemoData();
  assert.equal(db.getMandate(), undefined);
});

test('agent tools: a blocked item cannot be proposed and bad arguments are rejected', async () => {
  const state: any = { goal: 'x', trace: [], scamCheck: { risk: 'LOW', signals: [], explanation: '', engine: 'RULES_ONLY' } };
  const tools = buildTools(db.getAgent(AGENT)!, state);
  const tool = (name: string) => tools.find(t => t.declaration.name === name)!;
  await assert.rejects(tool('propose_purchase').run({ product_id: 'cur-gc-apple', reason_for_user: 'x' }), /block/);
  await assert.rejects(tool('search_products').run({}), /query is required/);
  await assert.rejects(tool('check_policy').run({ product_id: 42 }), /Unknown product_id/);
  const ok = await tool('propose_purchase').run({ product_id: 'cur-bp-cuff', reason_for_user: 'x', alternative_ids: 'cur-tea' });
  assert.equal((ok.result as any).verdict, 'APPROVE');
  assert.equal(state.proposal.alternatives.length, 0);
});

test('tool loop: tool errors go back to the model, and the step cap forces a text answer', async () => {
  const sent: any[] = [];
  let turn = 0;
  const create = async (request: any) => {
    sent.push(structuredClone(request.messages));
    turn++;
    if (request.tool_choice?.type === 'none') {
      return { content: [{ type: 'text', text: 'Here is my answer.' }], stop_reason: 'end_turn' } as any;
    }
    return {
      content: [{ type: 'tool_use', id: `c${turn}`, name: turn === 1 ? 'broken' : 'nope', input: {} }],
      stop_reason: 'tool_use'
    } as any;
  };
  const tools = [{ declaration: { name: 'broken', input_schema: { type: 'object' as const } }, run: async () => { throw new Error('boom'); } }];
  const result = await runToolLoop({ system: 's', history: [], tools, maxSteps: 2, create });
  assert.equal(result.text, 'Here is my answer.');
  assert.equal(turn, 3); // 2 tool steps + 1 forced answer
  const lastToolReply = sent[1].at(-1).content[0];
  assert.equal(lastToolReply.is_error, true);
  assert.equal(JSON.parse(lastToolReply.content).error, 'boom');
  assert.deepEqual(result.trace.map(s => s.summary), ['Error: boom', 'Unknown tool nope']);
});

test('tool loop stops when the request is cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runToolLoop({ system: 's', history: [], tools: [], signal: controller.signal, create: async () => ({}) as any }),
    /cancelled/
  );
});
