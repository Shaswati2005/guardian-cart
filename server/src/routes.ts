import { Router, Request, Response } from 'express';
import { db } from './db.js';
import {
  chat,
  acceptProposal,
  declineProposal,
  approveEscalatedTransaction,
  rejectEscalatedTransaction,
  refundSettledTransaction,
  applyPayPalEvent,
  expireStaleHolds,
  resetDemo,
  AbortedError
} from './agent.js';
import {
  getPayPalAccessToken,
  getPayPalBaseUrl,
  getOrder,
  createSetupToken,
  createPaymentToken,
  verifyWebhookSignature,
  isPayPalId
} from './paypal.js';
import { compilePolicy, sanitizePolicy, describePolicy } from './policy.js';
import { getCuratedCatalog } from './products.js';
import { isLlmConfigured, AI_MODEL } from './llm.js';
import { verifyApprovalAction, resultPage, confirmPage, publicBaseUrl, ApprovalAction } from './notify.js';
import { requireRole, setRole, hasRole, currentRoles, ROLES, Role } from './session.js';
import { rateLimit } from './rateLimit.js';

export const apiRouter = Router();

const elder = requireRole('elder');
const caregiver = requireRole('caregiver');
const anyone = requireRole('elder', 'caregiver');
// Each AI request can cost several Claude calls (scam check + tool loop), and searches spend Channel3 credits
const aiPerVisitor = rateLimit({ name: 'ai-visitor', windowMs: 60_000, max: 12 });
const aiPerDay = rateLimit({ name: 'ai-daily', windowMs: 24 * 60 * 60_000, max: Number(process.env.AI_DAILY_LIMIT) || 600, global: true });
const paymentsPerVisitor = rateLimit({ name: 'payments', windowMs: 60_000, max: 20 });

apiRouter.use(rateLimit({ name: 'api', windowMs: 60_000, max: 300 }));

// 0. Persona session
apiRouter.post('/session', (req: Request, res: Response) => {
  const role = req.body?.role;
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'role must be elder or caregiver' });
  setRole(req, res, role as Role);
  res.json({ role });
});

apiRouter.get('/session', (req: Request, res: Response) => {
  res.json({ roles: currentRoles(req) });
});

// 1. Health & PayPal status. Details (payer email, PayPal errors) are for the caregiver only.
async function buildStatus(detailed: boolean) {
  let paypalConnected = false;
  let authError: string | null = null;
  try {
    paypalConnected = Boolean(await getPayPalAccessToken());
  } catch (err: any) {
    authError = err.message || 'PayPal authentication failed';
    console.error('[PayPal] status check failed:', authError);
  }

  const mandate = db.getMandate();
  return {
    status: 'ONLINE',
    paypalConnected,
    mode: !paypalConnected ? 'AWAITING_CREDENTIALS' : mandate ? 'MANDATE_ACTIVE' : 'AWAITING_MANDATE',
    paypalEndpoint: getPayPalBaseUrl(),
    mandate: mandate ? { payerEmail: detailed ? mandate.payerEmail : undefined, createdAt: mandate.createdAt } : null,
    ai: { configured: isLlmConfigured(), model: AI_MODEL },
    productSearch: process.env.CHANNEL3_API_KEY ? 'CHANNEL3' : 'CURATED',
    error: authError ? (detailed ? authError : 'PayPal is not connected') : null,
    timestamp: new Date().toISOString()
  };
}

apiRouter.get('/status', async (req: Request, res: Response) => {
  res.json(await buildStatus(hasRole(req, 'caregiver')));
});

// 1b. PayPal Vault: caregiver approves a one-time payment mandate. The return URL only accepts a
// setup token this server created recently, and only from the caregiver's session.
const SETUP_TOKEN_TTL_MS = 30 * 60_000;
const pendingSetupTokens = new Map<string, number>();

apiRouter.post('/paypal/vault/setup', caregiver, async (_req: Request, res: Response) => {
  const base = publicBaseUrl();
  try {
    const { setupTokenId, approveUrl } = await createSetupToken({
      returnUrl: `${base}/api/paypal/vault/return`,
      cancelUrl: `${base}/api/paypal/vault/cancel`,
      description: 'Guardian Cart: purchases your family member makes within the rules you set'
    });
    const now = Date.now();
    for (const [id, at] of pendingSetupTokens) if (now - at > SETUP_TOKEN_TTL_MS) pendingSetupTokens.delete(id);
    pendingSetupTokens.set(setupTokenId, now);
    res.json({ approveUrl });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to start PayPal vault setup' });
  }
});

apiRouter.get('/paypal/vault/return', async (req: Request, res: Response) => {
  const clientUrl = process.env.CLIENT_URL || '/';
  const setupTokenId = String(req.query.approval_token_id || req.query.token || '');
  const startedAt = pendingSetupTokens.get(setupTokenId);
  if (!hasRole(req, 'caregiver') || !startedAt || Date.now() - startedAt > SETUP_TOKEN_TTL_MS) {
    return res.redirect(`${clientUrl}?vault=error`);
  }
  pendingSetupTokens.delete(setupTokenId);
  try {
    const token = await createPaymentToken(setupTokenId);
    db.saveMandate({ ...token, createdAt: new Date().toISOString() });
    console.log(`[PayPal Vault] mandate saved. To keep it across restarts on an ephemeral host, set PAYPAL_VAULT_ID=${token.paymentTokenId}`);
    res.redirect(`${clientUrl}?vault=connected`);
  } catch (err: any) {
    console.error('[PayPal Vault] payment token exchange failed:', err.message);
    res.redirect(`${clientUrl}?vault=error`);
  }
});

apiRouter.get('/paypal/vault/cancel', (_req: Request, res: Response) => {
  res.redirect(`${process.env.CLIENT_URL || '/'}?vault=cancelled`);
});

// 1c. PayPal webhooks (signature verified with PayPal before anything is trusted)
apiRouter.post('/paypal/webhook', async (req: Request, res: Response) => {
  const event = req.body;
  try {
    const verified = await verifyWebhookSignature(req.headers as Record<string, string | undefined>, event);
    if (!verified) {
      return res.status(400).json({ error: 'Webhook signature verification failed' });
    }
  } catch (err: any) {
    console.error('[PayPal Webhook] verification error:', err.message);
    return res.status(400).json({ error: 'Webhook verification error' });
  }

  applyPayPalEvent(event);
  res.json({ received: true });
});

// 2. Agents Endpoints
apiRouter.get('/agents', anyone, (_req: Request, res: Response) => {
  res.json(db.getAgents());
});

apiRouter.patch('/agents/:id/status', caregiver, (req: Request, res: Response) => {
  const { status } = req.body || {};
  if (!['ACTIVE', 'PAUSED', 'FROZEN'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const updated = db.updateAgentStatus(req.params.id, status);
  if (!updated) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  res.json(updated);
});

// Everything Sarah's dashboard shows, in one request (keeps polling well under the rate limit)
apiRouter.get('/dashboard', caregiver, async (_req: Request, res: Response) => {
  expireStaleHolds();
  res.json({
    status: await buildStatus(true),
    agents: db.getAgents(),
    approvals: db.getApprovals(),
    alerts: db.getAlerts(),
    transactions: db.getTransactions()
  });
});

// 3. Transactions & Refunds
// Margaret's page reads these too, to show what happened to each thing she said yes to
apiRouter.get('/transactions', anyone, (_req: Request, res: Response) => {
  res.json(db.getTransactions());
});

apiRouter.post('/transactions/:id/refund', caregiver, paymentsPerVisitor, async (req: Request, res: Response) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 255) : undefined;
    const refundedTx = await refundSettledTransaction(req.params.id, reason);
    res.json({ success: true, transaction: refundedTx });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to refund transaction' });
  }
});

// 4. Human-in-the-Loop Approvals
apiRouter.get('/approvals', caregiver, (_req: Request, res: Response) => {
  expireStaleHolds();
  res.json(db.getApprovals());
});

apiRouter.post('/approvals/:id/approve', caregiver, paymentsPerVisitor, async (req: Request, res: Response) => {
  try {
    const updatedTx = await approveEscalatedTransaction(req.params.id);
    res.json({ success: true, transaction: updatedTx });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to approve' });
  }
});

apiRouter.post('/approvals/:id/reject', caregiver, paymentsPerVisitor, async (req: Request, res: Response) => {
  try {
    const updatedTx = await rejectEscalatedTransaction(req.params.id);
    res.json({ success: true, transaction: updatedTx });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to reject' });
  }
});

// Decisions from the caregiver's email (HMAC-signed, expiring links). Opening the link (GET) only
// shows a confirmation page, so email scanners that prefetch links can't approve anything; the
// action itself needs the POST from that page.
function readDecision(req: Request, source: Record<string, unknown>): { action: ApprovalAction; token: string } | null {
  const action = source.action === 'approve' ? 'approve' : source.action === 'decline' ? 'decline' : null;
  const token = typeof source.token === 'string' ? source.token : '';
  if (!action) return null;
  try {
    return verifyApprovalAction(req.params.id, action, token) ? { action, token } : null;
  } catch {
    return null;
  }
}

const INVALID_LINK = resultPage('Link not valid', 'This approval link is invalid or has expired. Please use the dashboard.', false);

apiRouter.get('/approvals/:id/decide', paymentsPerVisitor, (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  const decision = readDecision(req, req.query as Record<string, unknown>);
  if (!decision) return res.status(403).send(INVALID_LINK);
  const approval = db.getApproval(req.params.id);
  if (!approval || approval.status !== 'PENDING') {
    return res.send(resultPage('Already decided', 'This purchase was already approved, declined or has expired.', true));
  }
  res.send(confirmPage(approval, decision.action, decision.token));
});

apiRouter.post('/approvals/:id/decide', paymentsPerVisitor, async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  const decision = readDecision(req, (req.body || {}) as Record<string, unknown>);
  if (!decision) return res.status(403).send(INVALID_LINK);
  try {
    const tx = decision.action === 'approve'
      ? await approveEscalatedTransaction(req.params.id)
      : await rejectEscalatedTransaction(req.params.id);
    res.send(
      decision.action === 'approve'
        ? resultPage('Approved', `${tx.itemName} ($${tx.amount.toFixed(2)}) was paid with PayPal.`, true)
        : tx.status === 'EXPIRED'
          ? resultPage('Hold expired', `The PayPal hold for ${tx.itemName} had already expired, so nothing was paid.`, true)
          : resultPage('Declined', `${tx.itemName} was declined and the PayPal hold was released.`, true)
    );
  } catch (err: any) {
    res.status(400).send(resultPage('Could not complete', err.message || 'Something went wrong.', false));
  }
});

// 5. Chat with the shopping agent
apiRouter.get('/agents/:id/chat', anyone, (req: Request, res: Response) => {
  const messages = db.getChat(req.params.id);
  const proposals = messages
    .filter(m => m.proposalId)
    .map(m => db.getProposal(m.proposalId!))
    .filter(Boolean);
  res.json({ messages, proposals });
});

// Streams each tool step (search, policy check, propose) as it happens
apiRouter.post('/agents/:id/chat-stream', elder, aiPerVisitor, aiPerDay, async (req: Request, res: Response) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.slice(0, 1000) : '';
  if (!message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const sendEvent = (payload: unknown) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // If Margaret closes the page, stop the Claude loop instead of spending quota on an answer nobody sees
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });

  try {
    const result = await chat(req.params.id, message, step => sendEvent({ type: 'STEP', step }), abort.signal);
    sendEvent({ type: 'COMPLETE', ...result });
  } catch (err: any) {
    if (!(err instanceof AbortedError) && !abort.signal.aborted) {
      sendEvent({ type: 'ERROR', error: err.message || 'Agent failed to respond' });
    }
  }
  res.end();
});

// 6. Proposals: the person says yes/no; policy + PayPal take it from there
apiRouter.post('/proposals/:id/accept', elder, paymentsPerVisitor, async (req: Request, res: Response) => {
  try {
    res.json({ success: true, ...(await acceptProposal(req.params.id)) });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to complete purchase' });
  }
});

apiRouter.post('/proposals/:id/decline', elder, async (req: Request, res: Response) => {
  try {
    res.json({ success: true, proposal: await declineProposal(req.params.id) });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to decline' });
  }
});

// 7. Policy: caregiver writes rules in English -> Claude compiles -> caregiver confirms
const cleanRules = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.filter((r): r is string => typeof r === 'string' && Boolean(r.trim())).map(r => r.trim().slice(0, 300)).slice(0, 30)
    : [];

apiRouter.post('/agents/:id/policy/compile', caregiver, aiPerVisitor, aiPerDay, async (req: Request, res: Response) => {
  const agent = db.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const rules = cleanRules(req.body?.rules);
  if (rules.length === 0) return res.status(400).json({ error: 'rules must be a non-empty array of strings' });

  try {
    const proposed = await compilePolicy(rules, agent.policy);
    res.json({ rules, current: agent.policy, proposed, summary: describePolicy(proposed) });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to compile rules' });
  }
});

apiRouter.put('/agents/:id/policy', caregiver, (req: Request, res: Response) => {
  const agent = db.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { rules, policy } = req.body || {};
  if (!Array.isArray(rules) || !policy || typeof policy !== 'object') return res.status(400).json({ error: 'rules and policy are required' });

  const saved = db.saveAgent({ ...agent, semanticRules: cleanRules(rules), policy: sanitizePolicy(policy, agent.policy) });
  res.json(saved);
});

// 8. Alerts for the caregiver (scam blocks, approvals needed, policy blocks)
apiRouter.get('/alerts', caregiver, (req: Request, res: Response) => {
  res.json(db.getAlerts(typeof req.query.agentId === 'string' ? req.query.agentId : undefined));
});

apiRouter.post('/alerts/:id/read', caregiver, (req: Request, res: Response) => {
  const alert = db.getAlerts().find(a => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  res.json(db.saveAlert({ ...alert, readAt: alert.readAt || new Date().toISOString() }));
});

apiRouter.get('/catalog', (_req: Request, res: Response) => {
  res.json(getCuratedCatalog());
});

// 9. Live PayPal Order Inspection
apiRouter.get('/paypal/orders/:orderId', caregiver, async (req: Request, res: Response) => {
  // Only real order ids reach PayPal: anything else could steer the request to another endpoint
  if (!isPayPalId(req.params.orderId)) return res.status(400).json({ error: 'Invalid PayPal order id' });
  try {
    const details = await getOrder(req.params.orderId);
    res.json(details);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to inspect PayPal order' });
  }
});

// 10. Reset demo state (caregiver only; open PayPal holds are released first, rules are kept)
apiRouter.post('/reset', caregiver, async (_req: Request, res: Response) => {
  try {
    const { voidFailures } = await resetDemo();
    res.json({
      success: true,
      voidFailures,
      agents: db.getAgents(),
      transactions: db.getTransactions(),
      approvals: db.getApprovals()
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Reset failed' });
  }
});
