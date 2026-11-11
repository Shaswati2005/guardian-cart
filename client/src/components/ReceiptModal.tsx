import { useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, CircleX, ExternalLink, Search, ShieldAlert } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Text } from '@astryxdesign/core/Text';
import { api, money, safeHttpUrl } from '../api';
import type { RuleCheckResult, Transaction } from '../types';
import { icon, ProductImage, StatusPill, VerdictBadge } from './ui';

const OUTCOME_ICON: Record<RuleCheckResult['outcome'], { Icon: typeof CircleCheck; className: string }> = {
  PASS: { Icon: CircleCheck, className: 'text-success' },
  HOLD: { Icon: CircleAlert, className: 'text-warning' },
  BLOCK: { Icon: CircleX, className: 'text-error' }
};

const TOOL_LABEL: Record<string, string> = {
  search_products: 'Search',
  check_policy: 'Policy check',
  propose_purchase: 'Proposed'
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border px-6 py-4">
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-secondary">{title}</h3>
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
    <Dialog isOpen onOpenChange={open => !open && onClose()} width={680} maxHeight="88dvh" padding={0}>
      {/* The dialog has no padding so section dividers run edge to edge; the header gets its own */}
      <div className="px-6 pt-5 pb-3">
        <DialogHeader title="Decision receipt" subtitle={`${money(tx.amount, tx.currency)} · ${p.merchant}`} onOpenChange={open => !open && onClose()} />
      </div>
      <div>
        <div className="flex items-start gap-4 px-6 pb-5">
          <ProductImage src={p.imageUrl} category={p.category} className="h-20 w-20 shrink-0 rounded-md border border-border" />
          <div className="min-w-0 flex-1">
            <p className="text-lg font-bold leading-snug">{p.title}</p>
            <Text type="supporting" display="block" className="mt-1">
              {new Date(tx.createdAt).toLocaleString()}
            </Text>
            <div className="mt-2 flex flex-wrap gap-2">
              <StatusPill status={tx.status} />
              <VerdictBadge verdict={r.policyVerdict} />
            </div>
          </div>
        </div>

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
            <p className="flex items-center gap-2 font-bold text-warning">
              <ShieldAlert className="h-5 w-5" /> {r.scamCheck.risk} risk
            </p>
            <p className="mt-1">{r.scamCheck.explanation}</p>
          </Section>
        )}

        <Section title={`What the AI agent did (${r.agentTrace.length} steps)`}>
          <ol className="space-y-1.5">
            {r.agentTrace.map((s, i) => (
              <li key={i} className="flex gap-2 text-sm">
                <span className="w-24 shrink-0 font-bold text-accent">{TOOL_LABEL[s.tool] || s.tool}</span>
                <span>{s.summary}</span>
              </li>
            ))}
          </ol>
          {r.rejectedCandidates.length > 0 && (
            <>
              <p className="mt-4 text-sm font-bold">Also considered</p>
              <ul className="mt-1 space-y-1 text-sm text-secondary">
                {r.rejectedCandidates.map(c => (
                  <li key={c.id || c.title}>
                    {c.title} ({money(c.price)}, {c.merchant}): {c.rejectionReason}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="mt-3 text-xs text-secondary">
            Product data: {p.source === 'CHANNEL3' ? 'live from Channel3' : 'curated demo catalog'}
            {storeUrl && (
              <a href={storeUrl} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 text-accent underline">
                view at store <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </p>
        </Section>

        <Section title="PayPal (sandbox)">
          {tx.captureStatus && tx.captureStatus !== 'COMPLETED' && (
            <p className="mb-2 text-sm font-bold text-warning">PayPal capture status: {tx.captureStatus}</p>
          )}
          {tx.status === 'BLOCKED' ? (
            <p className="text-secondary">Blocked before payment: no PayPal order was created.</p>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {paypalIds
                .filter(([, id]) => id)
                .map(([label, id]) => (
                  <div key={label} className="contents">
                    <dt className="text-secondary">{label}</dt>
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
                  <span className="text-secondary">webhook · {new Date(e.receivedAt).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          )}
          {tx.paypalOrderId && (
            <div className="mt-3">
              <Button label="Fetch this order from PayPal" variant="secondary" size="sm" icon={icon(Search)} isLoading={loadingOrder} onClick={loadOrder} />
              {orderError && <p className="mt-2 text-sm text-error">{orderError}</p>}
              {orderJson !== null && (
                <CodeBlock
                  code={JSON.stringify(orderJson, null, 2)}
                  language="json"
                  title="PayPal order"
                  size="sm"
                  width="100%"
                  maxHeight={288}
                  className="mt-3"
                />
              )}
            </div>
          )}
        </Section>
      </div>
    </Dialog>
  );
}
