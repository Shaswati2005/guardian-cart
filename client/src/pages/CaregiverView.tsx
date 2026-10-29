import { useCallback, useState } from 'react';
import { Bell, CircleCheck, CircleX, FileText, Pause, Play, ShieldAlert, ShieldX, TriangleAlert, Wallet } from 'lucide-react';
import { api, money } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Button, Card, Spinner } from '../components/ui';
import { Ledger } from '../components/Ledger';
import { ReceiptModal } from '../components/ReceiptModal';
import { PolicySummary, RulesEditor } from '../components/RulesEditor';
import type { Alert, Transaction } from '../types';

// One request per poll keeps several open dashboards (or judges on one Wi-Fi) under the rate limit
async function loadDashboard() {
  const { status, agents, approvals, alerts, transactions } = await api.dashboard();
  return { status, agent: agents[0], approvals, alerts, transactions };
}

const ALERT_STYLE: Record<Alert['kind'], { Icon: typeof Bell; className: string }> = {
  SCAM_BLOCKED: { Icon: ShieldX, className: 'border-danger/40 bg-danger-soft text-danger' },
  SCAM_WARNING: { Icon: ShieldAlert, className: 'border-hold/40 bg-hold-soft text-hold' },
  POLICY_BLOCKED: { Icon: CircleX, className: 'border-line bg-paper text-ink' },
  APPROVAL_NEEDED: { Icon: Bell, className: 'border-line bg-paper text-ink' }
};

function PayPalSetup({ mode, email, error }: { mode: string; email?: string; error: string | null }) {
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  if (mode === 'MANDATE_ACTIVE') {
    return (
      <p className="flex items-center gap-2 text-sm text-ok">
        <CircleCheck className="h-4 w-4" /> PayPal connected{email ? ` (${email})` : ''}. Sandbox mode.
      </p>
    );
  }
  if (mode === 'AWAITING_CREDENTIALS') {
    return (
      <div className="flex gap-3 rounded-xl border border-danger/40 bg-danger-soft p-4 text-danger">
        <TriangleAlert className="h-5 w-5 shrink-0" />
        <div>
          <p className="font-bold">PayPal sandbox isn't configured on the server.</p>
          <p className="text-sm">{error || 'Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in the server environment.'}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-paypal/30 bg-paypal-soft p-4">
      <div>
        <p className="font-bold text-paypal">Connect PayPal once</p>
        <p className="text-sm">
          You approve a PayPal billing agreement one time. After that the helper can pay within your rules, and anything else waits
          for you.
        </p>
        {startError && <p className="mt-1 text-sm text-danger">{startError}</p>}
      </div>
      <Button
        className="bg-paypal text-white hover:bg-paypal"
        busy={busy}
        onClick={async () => {
          setBusy(true);
          setStartError(null);
          try {
            window.location.href = (await api.startVault()).approveUrl;
          } catch (err) {
            setStartError(err instanceof Error ? err.message : String(err));
            setBusy(false);
          }
        }}
      >
        <Wallet className="h-4 w-4" /> Connect PayPal
      </Button>
    </div>
  );
}

export function CaregiverView() {
  const { data, error, refresh } = usePolling(loadDashboard, 5000);
  const [receiptTx, setReceiptTx] = useState<Transaction | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = useCallback(
    async (id: string, fn: () => Promise<unknown>) => {
      setBusyId(id);
      setActionError(null);
      try {
        await fn();
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [refresh]
  );

  const onRefund = useCallback(
    (tx: Transaction) => {
      if (confirm(`Refund ${tx.itemName} (${money(tx.amount)}) through PayPal?`)) {
        act(`refund:${tx.id}`, () => api.refund(tx.id));
      }
    },
    [act]
  );

  if (!data) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-muted">
        {error ? <span className="text-danger">Can't reach the server: {error}</span> : <><Spinner /> Loading…</>}
      </div>
    );
  }

  const { status, agent, approvals, alerts, transactions } = data;
  const budget = agent.policy.weeklyBudget;
  const spentPct = Math.min(100, (agent.totalSpent / budget) * 100);
  const reservedPct = Math.min(100 - spentPct, ((agent.reservedAmount || 0) / budget) * 100);
  const paused = agent.status !== 'ACTIVE';
  const txById = new Map(transactions.map(t => [t.id, t]));
  const unread = alerts.filter(a => !a.readAt);

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-bold uppercase tracking-wider text-muted">{agent.caregiverName}'s dashboard</p>
          <h1 className="text-3xl font-bold">
            {agent.avatar} Looking after {agent.name}
          </h1>
          <p className="text-muted">{agent.role}</p>
        </div>
        <Button
          variant={paused ? 'ok' : 'danger'}
          busy={busyId === 'pause'}
          onClick={() => act('pause', () => api.setAgentStatus(agent.id, paused ? 'ACTIVE' : 'PAUSED'))}
        >
          {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          {paused ? 'Resume shopping' : 'Pause all shopping'}
        </Button>
      </header>

      <PayPalSetup mode={status.mode} email={status.mandate?.payerEmail} error={status.error} />
      {!status.ai.configured && (
        <p className="rounded-xl border border-hold/40 bg-hold-soft p-3 text-sm text-hold">
          GEMINI_API_KEY isn't set, so the shopping helper and rule translator are offline. The scam shield's rule layer still works.
        </p>
      )}
      {paused && (
        <p className="rounded-xl border border-danger/40 bg-danger-soft p-3 font-bold text-danger">
          Shopping is paused. The helper can still chat, but nothing will be bought.
        </p>
      )}
      {actionError && <p className="rounded-xl border border-danger/40 bg-danger-soft p-3 text-danger">{actionError}</p>}
      {error && (
        <p role="status" className="rounded-xl border border-hold/40 bg-hold-soft p-3 text-sm text-hold">
          Couldn't refresh just now ({error}). What you see may be out of date; it will retry automatically.
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <h2 className="text-xl font-bold">Needs your OK {approvals.length > 0 && <span className="text-hold">({approvals.length})</span>}</h2>
            {approvals.length === 0 ? (
              <p className="mt-2 text-muted">Nothing waiting. Purchases outside your rules will show up here.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {approvals.map(a => {
                  const tx = txById.get(a.transactionId);
                  return (
                    <li key={a.id} className="rounded-xl border-2 border-hold/40 bg-hold-soft/60 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-bold">{a.itemName}</p>
                          <p className="text-2xl font-bold">{money(a.amount, a.currency)}</p>
                          <p className="mt-1 text-sm text-hold">{a.reason}</p>
                          <p className="mt-1 text-xs text-muted">
                            Funds held on PayPal · order {a.paypalOrderId}
                            {tx?.authorizationExpiresAt && ` · hold expires ${new Date(tx.authorizationExpiresAt).toLocaleDateString()}`}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button variant="ok" busy={busyId === `approve:${a.id}`} disabled={busyId !== null} onClick={() => act(`approve:${a.id}`, () => api.approve(a.id))}>
                            Approve
                          </Button>
                          <Button variant="danger" busy={busyId === `decline:${a.id}`} disabled={busyId !== null} onClick={() => act(`decline:${a.id}`, () => api.decline(a.id))}>
                            Decline
                          </Button>
                          {tx && (
                            <Button variant="secondary" onClick={() => setReceiptTx(tx)}>
                              <FileText className="h-4 w-4" /> Why?
                            </Button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="text-xl font-bold">Alerts {unread.length > 0 && <span className="text-danger">({unread.length} new)</span>}</h2>
            {alerts.length === 0 ? (
              <p className="mt-2 text-muted">No alerts. Scam attempts and blocked purchases are reported here.</p>
            ) : (
              <ul className="mt-3 max-h-96 space-y-2 overflow-y-auto">
                {alerts.map(a => {
                  const { Icon, className } = ALERT_STYLE[a.kind];
                  return (
                    <li key={a.id} className={`flex gap-3 rounded-xl border p-3 ${className} ${a.readAt ? 'opacity-60' : ''}`}>
                      <Icon className="mt-0.5 h-5 w-5 shrink-0" />
                      <div className="min-w-0 flex-1 text-ink">
                        <p className="font-bold">{a.title}</p>
                        <p className="text-sm">{a.message}</p>
                        {a.signals.length > 0 && <p className="mt-1 text-xs text-muted">Signs: {a.signals.join(' · ')}</p>}
                        <p className="mt-1 text-xs text-muted">{new Date(a.createdAt).toLocaleString()}</p>
                      </div>
                      {!a.readAt && (
                        <button onClick={() => act(`read:${a.id}`, () => api.markAlertRead(a.id))} className="self-start text-sm font-bold text-brand hover:underline">
                          Seen
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <h2 className="text-xl font-bold">Last 7 days</h2>
            <p className="mt-2 text-3xl font-bold">
              {money(agent.totalSpent)} <span className="text-base font-normal text-muted">of {money(budget)}</span>
            </p>
            <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-line" role="img" aria-label={`${money(agent.totalSpent)} spent, ${money(agent.reservedAmount || 0)} on hold, of ${money(budget)}`}>
              <div className="bg-ok" style={{ width: `${spentPct}%` }} />
              <div className="bg-hold" style={{ width: `${reservedPct}%` }} />
            </div>
            <div className="mt-2 flex gap-4 text-sm text-muted">
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-ok" /> Paid</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-hold" /> On hold {money(agent.reservedAmount || 0)}</span>
            </div>
          </Card>
          <Card>
            <h2 className="mb-3 text-xl font-bold">Rules in force</h2>
            <PolicySummary policy={agent.policy} />
            <p className="mt-3 text-xs text-muted">
              Enforced by code on every purchase. The AI can suggest items but can't change or skip these.
            </p>
          </Card>
        </div>
      </div>

      <Card>
        <h2 className="mb-3 text-xl font-bold">Change the rules</h2>
        <RulesEditor key={agent.semanticRules.join('|')} agent={agent} onSaved={refresh} />
      </Card>

      <Card>
        <h2 className="mb-3 text-xl font-bold">All purchases</h2>
        <Ledger
          transactions={transactions}
          onViewReceipt={setReceiptTx}
          onRefund={onRefund}
          refundingId={busyId?.startsWith('refund:') ? busyId.slice(7) : null}
        />
      </Card>

      {receiptTx && <ReceiptModal tx={txById.get(receiptTx.id) || receiptTx} onClose={() => setReceiptTx(null)} />}
    </div>
  );
}
