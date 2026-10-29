// Runs every money flow against the real PayPal sandbox using the vaulted mandate.
// Prerequisite: connect PayPal once in the app (creates the mandate in data/db.json).
// Usage: npm run e2e:sandbox
import 'dotenv/config';
import { db } from '../src/db.js';
import {
  createVaultedOrder,
  captureAuthorization,
  voidAuthorization,
  refundCapture,
  getOrder
} from '../src/paypal.js';

const mandate = db.getMandate();
if (!mandate) {
  console.error('No mandate found. Start the app, click "Connect PayPal", approve with a sandbox personal account, then re-run.');
  process.exit(1);
}

const vaultId = mandate.paymentTokenId;
const runId = Date.now().toString(36);
let failures = 0;

async function step(name: string, fn: () => Promise<string>) {
  try {
    console.log(`PASS  ${name}: ${await fn()}`);
  } catch (err: any) {
    failures++;
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

await step('in-policy purchase captures immediately, then refunds', async () => {
  const order = await createVaultedOrder({
    vaultId, intent: 'CAPTURE', amount: 12.5, currency: 'USD',
    description: 'E2E capture', referenceId: `e2e-cap-${runId}`
  });
  const refund = await refundCapture({ captureId: order.captureId!, amount: 12.5, currency: 'USD', reason: 'E2E refund' });
  if (refund.status !== 'COMPLETED' && refund.status !== 'PENDING') throw new Error(`refund status ${refund.status}`);
  return `order ${order.orderId}, capture ${order.captureId}, refund ${refund.refundId} (${refund.status})`;
});

await step('held purchase is authorized, then captured on approval', async () => {
  const order = await createVaultedOrder({
    vaultId, intent: 'AUTHORIZE', amount: 45, currency: 'USD',
    description: 'E2E hold then approve', referenceId: `e2e-auth-${runId}`
  });
  const capture = await captureAuthorization(order.authorizationId!);
  return `order ${order.orderId}, authorization ${order.authorizationId}, capture ${capture.captureId} (${capture.status})`;
});

await step('held purchase is voided on rejection', async () => {
  const order = await createVaultedOrder({
    vaultId, intent: 'AUTHORIZE', amount: 30, currency: 'USD',
    description: 'E2E hold then reject', referenceId: `e2e-void-${runId}`
  });
  await voidAuthorization(order.authorizationId!);
  const after = await getOrder(order.orderId);
  const status = after.purchase_units?.[0]?.payments?.authorizations?.[0]?.status;
  if (status !== 'VOIDED') throw new Error(`authorization status after void is ${status}`);
  return `order ${order.orderId}, authorization ${order.authorizationId} VOIDED`;
});

console.log(failures ? `\n${failures} flow(s) failed` : '\nAll sandbox flows passed. Cross-check the IDs in the sandbox business account activity.');
process.exit(failures ? 1 : 0);
