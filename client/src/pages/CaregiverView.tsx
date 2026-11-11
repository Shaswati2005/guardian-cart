import { useCallback, useState, type ReactNode } from 'react';
import { Bell, CircleCheck, FileText, Pause, Play, ShieldCheck, Wallet } from 'lucide-react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Divider } from '@astryxdesign/core/Divider';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { HStack, Layout, LayoutContent, LayoutHeader, LayoutPanel, StackItem, VStack } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { Spinner } from '@astryxdesign/core/Spinner';
import { StatusDot, type StatusDotProps } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { api, money } from '../api';
import { usePolling } from '../hooks/usePolling';
import { icon, ProductImage } from '../components/ui';
import { Ledger } from '../components/Ledger';
import { ReceiptModal } from '../components/ReceiptModal';
import { PolicySummary, RulesEditor } from '../components/RulesEditor';
import type { Alert, ApprovalRequest, Transaction } from '../types';

// One request per poll keeps several open dashboards (or judges on one Wi-Fi) under the rate limit
async function loadDashboard() {
  const { status, agents, approvals, alerts, transactions } = await api.dashboard();
  return { status, agent: agents[0], approvals, alerts, transactions };
}

type DotVariant = StatusDotProps['variant'];

const ALERT_DOT: Record<Alert['kind'], { variant: DotVariant; label: string }> = {
  SCAM_BLOCKED: { variant: 'error', label: 'Scam blocked' },
  SCAM_WARNING: { variant: 'warning', label: 'Worth a check-in' },
  POLICY_BLOCKED: { variant: 'neutral', label: 'Blocked by rules' },
  APPROVAL_NEEDED: { variant: 'warning', label: 'Needs your OK' }
};

/** A headline number: status dot + label, the value, and one line of context (dashboard KPI tile). */
function KpiTile({ dot, dotLabel, label, value, detail, children }: {
  dot: DotVariant;
  dotLabel: string;
  label: string;
  value: string;
  detail: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card padding={4}>
      <VStack gap={2}>
        <HStack gap={2} vAlign="center">
          <StatusDot variant={dot} label={dotLabel} tooltip={dotLabel} />
          <Text type="label" color="secondary">
            {label}
          </Text>
        </HStack>
        <Heading level={2} className="tabular-nums">
          {value}
        </Heading>
        {children}
        <Text type="supporting">{detail}</Text>
      </VStack>
    </Card>
  );
}

/** Heading + one line of context above a page region. */
function SectionTitle({ title, detail, end }: { title: string; detail: string; end?: ReactNode }) {
  return (
    <HStack gap={3} vAlign="end" hAlign="between" wrap="wrap">
      <VStack gap={0.5}>
        <Heading level={2}>{title}</Heading>
        <Text type="supporting">{detail}</Text>
      </VStack>
      {end}
    </HStack>
  );
}

function AlertsFeed({ alerts, busyId, onSeen, sticky }: {
  alerts: Alert[];
  busyId: string | null;
  onSeen: (a: Alert) => void;
  sticky?: boolean;
}) {
  const unread = alerts.filter(a => !a.readAt).length;
  return (
    <VStack gap={0}>
      <div className={sticky ? 'sticky top-0 z-10 bg-surface' : undefined}>
        <VStack gap={1} padding={4} className="bg-muted">
          <HStack gap={2} vAlign="center">
            <span className={unread > 0 ? 'text-error' : 'text-secondary'}>{icon(Bell, 'sm')}</span>
            <StackItem size="fill">
              <Heading level={3}>Alerts</Heading>
            </StackItem>
            <Badge label={unread > 0 ? `${unread} new` : 'All seen'} variant={unread > 0 ? 'error' : 'neutral'} />
          </HStack>
          <Text type="supporting">Scam attempts and blocked purchases, newest first</Text>
        </VStack>
        <Divider />
      </div>
      {alerts.length === 0 ? (
        <EmptyState
          isCompact
          title="All clear"
          description="Scam attempts and blocked purchases will show up here."
          icon={<span className="text-success">{icon(ShieldCheck, 'lg')}</span>}
        />
      ) : (
        <List hasDividers>
          {alerts.map(a => {
            const dot = ALERT_DOT[a.kind];
            const isNew = !a.readAt;
            return (
              <ListItem
                key={a.id}
                align="start"
                label={<Text weight={isNew ? 'bold' : 'normal'}>{a.title}</Text>}
                description={
                  <VStack gap={1}>
                    <Text type="supporting" color="primary">
                      {a.message}
                    </Text>
                    {a.signals.length > 0 && <Text type="supporting">Signs: {a.signals.join(' · ')}</Text>}
                    <HStack gap={2} vAlign="center">
                      <Timestamp value={a.createdAt} format="relative" />
                      {isNew && (
                        <Button
                          label="Mark as seen"
                          variant="ghost"
                          size="sm"
                          isLoading={busyId === `read:${a.id}`}
                          onClick={() => onSeen(a)}
                        />
                      )}
                    </HStack>
                  </VStack>
                }
                startContent={
                  <StatusDot
                    variant={isNew ? dot.variant : 'neutral'}
                    label={isNew ? dot.label : 'Seen'}
                    isPulsing={isNew && a.kind === 'SCAM_BLOCKED'}
                  />
                }
              />
            );
          })}
        </List>
      )}
    </VStack>
  );
}

function ApprovalRow({ a, tx, busyId, onAct, onWhy }: {
  a: ApprovalRequest;
  tx?: Transaction;
  busyId: string | null;
  onAct: (id: string, fn: () => Promise<unknown>) => void;
  onWhy: (tx: Transaction) => void;
}) {
  const product = tx?.decisionReceipt.selectedProduct;
  return (
    <div className="flex flex-wrap items-center gap-4 p-4">
      {product && (
        <ProductImage src={product.imageUrl} category={product.category} className="h-16 w-16 shrink-0 rounded-md border border-border" />
      )}
      <VStack gap={0.5} className="min-w-0 flex-1 basis-64">
        <Text weight="bold">{a.itemName}</Text>
        <Text className="text-on-warning-muted" weight="medium">
          {a.reason}
        </Text>
        <Text type="supporting">
          Held on PayPal{tx?.authorizationExpiresAt ? ` until ${new Date(tx.authorizationExpiresAt).toLocaleDateString()}` : ''} · order{' '}
          {a.paypalOrderId}
        </Text>
      </VStack>
      <Text type="large" weight="bold" className="tabular-nums">
        {money(a.amount, a.currency)}
      </Text>
      <HStack gap={2} wrap="wrap">
        <Button
          label="Approve"
          variant="primary"
          isLoading={busyId === `approve:${a.id}`}
          isDisabled={busyId !== null && busyId !== `approve:${a.id}`}
          onClick={() => onAct(`approve:${a.id}`, () => api.approve(a.id))}
        />
        <Button
          label="Decline"
          isLoading={busyId === `decline:${a.id}`}
          isDisabled={busyId !== null && busyId !== `decline:${a.id}`}
          onClick={() => onAct(`decline:${a.id}`, () => api.decline(a.id))}
        />
        {tx && <Button label="Why?" variant="ghost" icon={icon(FileText)} onClick={() => onWhy(tx)} />}
      </HStack>
    </div>
  );
}

function PayPalSetup({ mode, error }: { mode: string; error: string | null }) {
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  if (mode === 'MANDATE_ACTIVE') return null;
  if (mode === 'AWAITING_CREDENTIALS') {
    return (
      <Banner
        status="error"
        title="PayPal sandbox isn't configured on the server"
        description={error || 'Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in the server environment.'}
      />
    );
  }
  return (
    <Banner
      status="info"
      icon={icon(Wallet)}
      title="Connect PayPal once"
      description={
        <>
          You approve a PayPal billing agreement one time. After that the helper can pay within your rules, and anything else
          waits for you.
          {startError && <span className="mt-1 block text-error">{startError}</span>}
        </>
      }
      endContent={
        <Button
          label="Connect PayPal"
          variant="primary"
          icon={icon(Wallet)}
          isLoading={busy}
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
        />
      }
    />
  );
}

export function CaregiverView() {
  const { data, error, refresh } = usePolling(loadDashboard, 5000);
  const [receiptTx, setReceiptTx] = useState<Transaction | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Below 1024px the alerts rail folds into the page, right under the headline tiles
  const isNarrow = useMediaQuery('(max-width: 1024px)');

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
      <div className="flex h-full items-center justify-center px-4">
        {error ? (
          <div className="w-full max-w-2xl">
            <Banner status="error" title="Can't reach the server" description={error} />
          </div>
        ) : (
          <Spinner size="xl" label="Loading Sarah's dashboard…" />
        )}
      </div>
    );
  }

  const { status, agent, approvals, alerts, transactions } = data;
  const budget = agent.policy.weeklyBudget;
  const reserved = agent.reservedAmount || 0;
  const spentPct = Math.min(100, (agent.totalSpent / budget) * 100);
  const reservedPct = Math.min(100 - spentPct, (reserved / budget) * 100);
  const paused = agent.status !== 'ACTIVE';
  const txById = new Map(transactions.map(t => [t.id, t]));
  const scamsStopped = alerts.filter(a => a.kind === 'SCAM_BLOCKED');
  const unreadScams = scamsStopped.filter(a => !a.readAt).length;
  const onSeen = (a: Alert) => act(`read:${a.id}`, () => api.markAlertRead(a.id));

  const header = (
    <LayoutHeader padding={6} hasDivider>
      <HStack gap={4} vAlign="center" hAlign="between" wrap="wrap">
        <VStack gap={0.5}>
          <Text type="label" color="secondary">
            {agent.caregiverName}'s dashboard
          </Text>
          <Heading level={1}>
            {agent.avatar} Looking after {agent.name}
          </Heading>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <StatusDot
              variant={error ? 'warning' : paused ? 'error' : 'success'}
              label={error ? 'Reconnecting' : paused ? 'Paused' : 'Live'}
              isPulsing={!error && !paused}
              tooltip="Updates every 5 seconds"
            />
            <Text type="supporting">
              {paused ? 'Shopping paused' : 'Shopping on'} · {agent.role}
              {status.mode === 'MANDATE_ACTIVE' && ` · PayPal connected${status.mandate?.payerEmail ? ` (${status.mandate.payerEmail})` : ''}`}
            </Text>
          </HStack>
        </VStack>
        <Button
          label={paused ? 'Resume shopping' : 'Pause all shopping'}
          variant={paused ? 'primary' : 'secondary'}
          size="lg"
          icon={icon(paused ? Play : Pause)}
          isLoading={busyId === 'pause'}
          onClick={() => act('pause', () => api.setAgentStatus(agent.id, paused ? 'ACTIVE' : 'PAUSED'))}
        />
      </HStack>
    </LayoutHeader>
  );

  const content = (
    <LayoutContent padding={6}>
      <VStack gap={10}>
        <VStack gap={4}>
          {/* System state first: anything that stops the helper from working */}
          <PayPalSetup mode={status.mode} error={status.error} />
          {!status.ai.configured && (
            <Banner
              status="warning"
              title="The AI helper is offline"
              description="No Claude API key is set on the server, so the shopping helper and rule translator are off. The scam shield's rule layer still works."
            />
          )}
          {paused && <Banner status="error" title="Shopping is paused" description="The helper can still chat, but nothing will be bought." />}
          {actionError && (
            <div role="alert">
              <Banner status="error" title="That didn't work" description={actionError} isDismissable onDismiss={() => setActionError(null)} />
            </div>
          )}
          {error && (
            <div role="status">
              <Banner
                status="warning"
                title="Couldn't refresh just now"
                description={`${error}. What you see may be out of date; it will retry automatically.`}
              />
            </div>
          )}

          {/* At a glance */}
          <Grid columns={{ minWidth: 210, repeat: 'fit' }} gap={3}>
            <KpiTile
              dot={approvals.length > 0 ? 'warning' : 'success'}
              dotLabel={approvals.length > 0 ? 'Waiting for you' : 'Nothing waiting'}
              label="Needs your OK"
              value={String(approvals.length)}
              detail={approvals.length > 0 ? 'Held on PayPal until you decide' : 'Nothing waiting for you'}
            />
            <KpiTile
              dot={spentPct >= 90 ? 'warning' : 'success'}
              dotLabel={spentPct >= 90 ? 'Close to the budget' : 'Within budget'}
              label="Spent, last 7 days"
              value={money(agent.totalSpent)}
              detail={`of ${money(budget)} weekly budget · ${money(reserved)} on hold`}
            >
              <div
                className="flex h-2 overflow-hidden rounded-full bg-track"
                role="img"
                aria-label={`${money(agent.totalSpent)} spent, ${money(reserved)} on hold, of ${money(budget)}`}
              >
                <div className="bg-success" style={{ width: `${spentPct}%` }} />
                <div className="bg-warning" style={{ width: `${reservedPct}%` }} />
              </div>
            </KpiTile>
            <KpiTile
              dot={unreadScams > 0 ? 'error' : 'success'}
              dotLabel={unreadScams > 0 ? 'New scam attempt' : 'No new scams'}
              label="Scams stopped"
              value={String(scamsStopped.length)}
              detail={unreadScams > 0 ? `${unreadScams} new, see Alerts` : 'Nothing new'}
            />
            <KpiTile
              dot="accent"
              dotLabel="Purchases"
              label="Purchases"
              value={String(transactions.length)}
              detail="Every request, paid or not, with its receipt"
            />
          </Grid>
        </VStack>

        {isNarrow && (
          <Card padding={0} className="overflow-hidden">
            <AlertsFeed alerts={alerts} busyId={busyId} onSeen={onSeen} />
          </Card>
        )}

        <VStack gap={4}>
          <SectionTitle
            title="Needs your OK"
            detail="Purchases outside your rules. The money is held on PayPal, not taken, until you decide."
          />
          {approvals.length === 0 ? (
            <Card>
              <EmptyState
                isCompact
                title="Nothing waiting"
                description="When the helper wants to buy something outside your rules, it will wait here for you."
                icon={<span className="text-success">{icon(CircleCheck, 'lg')}</span>}
              />
            </Card>
          ) : (
            <Card padding={0} className="overflow-hidden border-warning">
              {approvals.map((a, i) => (
                <div key={a.id}>
                  {i > 0 && <Divider />}
                  <ApprovalRow a={a} tx={txById.get(a.transactionId)} busyId={busyId} onAct={act} onWhy={setReceiptTx} />
                </div>
              ))}
            </Card>
          )}
        </VStack>

        <VStack gap={4}>
          <SectionTitle title="All purchases" detail="Every request, with its decision receipt. Refunds go back through PayPal." />
          <Card>
            <Ledger
              transactions={transactions}
              onViewReceipt={setReceiptTx}
              onRefund={onRefund}
              refundingId={busyId?.startsWith('refund:') ? busyId.slice(7) : null}
            />
          </Card>
        </VStack>

        <VStack gap={4}>
          <SectionTitle
            title="Shopping rules"
            detail="Enforced by code on every purchase. The AI can suggest items but can't change or skip these."
          />
          <Grid columns={{ minWidth: 340, repeat: 'fit' }} gap={4} align="start">
            <Card>
              <VStack gap={3}>
                <Heading level={3}>Change the rules</Heading>
                <RulesEditor key={agent.semanticRules.join('|')} agent={agent} onSaved={refresh} />
              </VStack>
            </Card>
            <Card>
              <VStack gap={3}>
                <Heading level={3}>Rules in force now</Heading>
                <PolicySummary policy={agent.policy} />
              </VStack>
            </Card>
          </Grid>
        </VStack>
      </VStack>
    </LayoutContent>
  );

  return (
    <>
      <Layout
        height="fill"
        header={header}
        content={content}
        end={
          isNarrow ? undefined : (
            <LayoutPanel width={380} padding={0} hasDivider role="complementary" label="Alerts" isScrollable>
              <AlertsFeed alerts={alerts} busyId={busyId} onSeen={onSeen} sticky />
            </LayoutPanel>
          )
        }
      />
      {receiptTx && <ReceiptModal tx={txById.get(receiptTx.id) || receiptTx} onClose={() => setReceiptTx(null)} />}
    </>
  );
}
