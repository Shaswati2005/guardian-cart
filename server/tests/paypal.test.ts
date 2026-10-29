// PayPal client behavior with fetch stubbed out (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PAYPAL_CLIENT_ID = 'test-client-id';
process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';
process.env.PAYPAL_API_BASE_URL = 'https://api-m.sandbox.paypal.com';

const { createVaultedOrder, getOrder } = await import('../src/paypal.js');

const requests: Array<{ url: string; headers: Record<string, string> }> = [];

function stubPayPal(order: unknown) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), headers: (init?.headers || {}) as Record<string, string> });
    if (String(url).endsWith('/v1/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify(order), { status: 201 });
  }) as typeof fetch;
}

const order = (authStatus: string) => ({
  id: 'ORDER123',
  status: 'COMPLETED',
  purchase_units: [{ payments: { authorizations: [{ id: 'AUTH123', status: authStatus, expiration_time: '2026-11-26T00:00:00Z' }] } }]
});

test('#5 a hold PayPal puts under review (PENDING) is recorded, not thrown away', async () => {
  stubPayPal(order('PENDING'));
  const result = await createVaultedOrder({
    vaultId: 'VAULT1', intent: 'AUTHORIZE', amount: 59.99, currency: 'USD', description: 'test', referenceId: 'tx_1', idempotencyKey: 'prop_1'
  });
  assert.equal(result.authorizationId, 'AUTH123');
  assert.equal(result.authorizationExpiresAt, '2026-11-26T00:00:00Z');
  // Keyed on the proposal only, so a retry repeats the same request
  assert.equal(requests.at(-1)!.headers['PayPal-Request-Id'], 'gc-order-prop_1');
});

test('a denied authorization is still an error', async () => {
  stubPayPal(order('DENIED'));
  await assert.rejects(
    createVaultedOrder({ vaultId: 'VAULT1', intent: 'AUTHORIZE', amount: 10, currency: 'USD', description: 'x', referenceId: 'tx_2', idempotencyKey: 'prop_2' }),
    /did not authorize/
  );
});

test('ids that are not PayPal ids never reach a PayPal URL', async () => {
  stubPayPal({});
  const before = requests.length;
  await assert.rejects(getOrder('../../v1/identity'), /Invalid PayPal id/);
  assert.equal(requests.length, before);
});

test('a declined auto-buy capture is returned for the caller to record, not thrown', async () => {
  stubPayPal({ id: 'ORDER9', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP9', status: 'DECLINED' }] } }] });
  const result = await createVaultedOrder({ vaultId: 'VAULT1', intent: 'CAPTURE', amount: 10, currency: 'USD', description: 'x', referenceId: 'tx_9', idempotencyKey: 'prop_9' });
  assert.equal(result.captureStatus, 'DECLINED');
});
