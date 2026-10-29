import { useEffect, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, CircleX, ExternalLink, Search, ShieldAlert, X } from 'lucide-react';
import { api, money, safeHttpUrl } from '../api';
import type { RuleCheckResult, Transaction } from '../types';
import { Button, ProductImage, StatusPill, VerdictBadge } from './ui';

const OUTCOME_ICON: Record<RuleCheckResult['outcome'], { Icon: typeof CircleCheck; className: string }> = {
  PASS: { Icon: CircleCheck, className: 'text-ok' },
  HOLD: { Icon: CircleAlert, className: 'text-hold' },
  BLOCK: { Icon: CircleX, className: 'text-danger' }
};

const TOOL_LABEL: Record<string, string> = {
  search_products: 'Search',
  check_policy: 'Policy check',
  propose_purchase: 'Proposed'
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line px-6 py-4">
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted">{title}</h3>
      {children}
    </section>
  );
}

export function ReceiptModal({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  const r = tx.decisionReceipt;
  const p = r.selectedProduct;
  const storeUrl = p.source === 'CHANNEL3' ? safeHttpUrl(p.itemUrl) : undefined;
  const [orderJson, setOrderJson] = useState<unknown>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [loadingOrder, setLoadingOrder] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const loadOrder = async () => {
    if (!tx.paypalOrderId) return;
    setLoadingOrder(true);
    setOrderError(null);
    try {
      setOrderJson(await api.paypalOrder(tx.paypalOrderId));
    } catch (err) {
      setOrderError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingOrder(false);
    }
  };

  const paypalIds: Array<[string, string | undefined]> = [
    ['Order', tx.paypalOrderId],
    ['Authorization (hold)', tx.paypalAuthorizationId],
    ['Capture', tx.paypalCaptureId],
    ['Refund', tx.paypalRefundId]
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 md:p-10" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Decision receipt"
        className="w-full max-w-2xl overflow-hidden rounded-2xl bg-surface shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-start gap-4 px-6 py-5">
          <ProductImage src={p.imageUrl} category={p.category} className="h-20 w-20 shrink-0 rounded-xl border border-line" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold uppercase tracking-wider text-muted">Decision receipt</p>
            <h2 className="mt-1 text-lg font-bold leading-snug">{p.title}</h2>
            <p className="mt-1 text-muted">
              {money(tx.amount, tx.currency)} · {p.merchant} · {new Date(tx.createdAt).toLocaleString()}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <StatusPill status={tx.status} />
              <VerdictBadge verdict={r.policyVerdict} />
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-muted hover:bg-paper" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </header>

        <Section title="What was asked">
          <p className="italic">“{r.goal}”</p>
          <p className="mt-2">
            <span className="font-bold">Agent's reason: </span>
            {r.reasoningSummary}
          </p>
        </Section>

        <Section title="Rule checks (decided by the policy engine, not the AI)">
          <ul className="space-y-2">
            {r.ruleChecks.map((c, i) => {
              const { Icon, className } = OUTCOME_ICON[c.outcome];
              return (
                <li key={i} className="flex gap-2">
                  <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${className}`} aria-label={c.outcome} />
                  <span>
                    <span className="font-bold">{c.rule}.</span> {c.explanation}
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>

        {r.scamCheck && r.scamCheck.risk !== 'LOW' && (
          <Section title="Scam shield">
            <p className="flex items-center gap-2 font-bold text-hold">
              <ShieldAlert className="h-5 w-5" /> {r.scamCheck.risk} risk
            </p>
            <p className="mt-1">{r.scamCheck.explanation}</p>
          </Section>
        )}

        <Section title={`What the AI agent did (${r.agentTrace.length} steps)`}>
          <ol className="space-y-1.5">
            {r.agentTrace.map((s, i) => (
              <li key={i} className="flex gap-2 text-sm">
                <span className="w-24 shrink-0 font-bold text-brand">{TOOL_LABEL[s.tool] || s.tool}</span>
                <span className="text-ink">{s.summary}</span>
              </li>
            ))}
          </ol>
          {r.rejectedCandidates.length > 0 && (
            <>
              <p className="mt-4 text-sm font-bold">Also considered</p>
              <ul className="mt-1 space-y-1 text-sm text-muted">
                {r.rejectedCandidates.map(c => (
                  <li key={c.id || c.title}>
                    {c.title} ({money(c.price)}, {c.merchant}): {c.rejectionReason}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="mt-3 text-xs text-muted">
            Product data: {p.source === 'CHANNEL3' ? 'live from Channel3' : 'curated demo catalog'}
            {storeUrl && (
              <a href={storeUrl} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 text-brand underline">
                view at store <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </p>
        </Section>

        <Section title="PayPal (sandbox)">
          {tx.captureStatus && tx.captureStatus !== 'COMPLETED' && (
            <p className="mb-2 text-sm text-hold">PayPal capture status: {tx.captureStatus}</p>
          )}
          {tx.status === 'BLOCKED' ? (
            <p className="text-muted">Blocked before payment: no PayPal order was created.</p>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {paypalIds
                .filter(([, id]) => id)
                .map(([label, id]) => (
                  <div key={label} className="contents">
                    <dt className="text-muted">{label}</dt>
                    <dd className="font-mono break-all">{id}</dd>
                  </div>
                ))}
            </dl>
          )}
          {tx.paypalEvents && tx.paypalEvents.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {tx.paypalEvents.map(e => (
                <li key={e.id}>
                  <span className="font-mono text-paypal">{e.type}</span>{' '}
                  <span className="text-muted">webhook · {new Date(e.receivedAt).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          )}
          {tx.paypalOrderId && (
            <div className="mt-3">
              <Button variant="secondary" onClick={loadOrder} busy={loadingOrder} className="text-sm">
                <Search className="h-4 w-4" /> Fetch this order from PayPal
              </Button>
              {orderError && <p className="mt-2 text-sm text-danger">{orderError}</p>}
              {orderJson !== null && (
                <pre className="mt-3 max-h-72 overflow-auto rounded-xl bg-ink p-3 text-xs text-white">
                  {JSON.stringify(orderJson, null, 2)}
                </pre>
              )}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
