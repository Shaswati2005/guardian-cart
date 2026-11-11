import { useEffect, useRef, useState } from 'react';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { CircleCheck, Mic, ShieldCheck, Square, Store, Volume2, VolumeX } from 'lucide-react';
import { Banner, type BannerProps } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import {
  ChatComposer,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatSystemMessage
} from '@astryxdesign/core/Chat';
import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { IconButton } from '@astryxdesign/core/IconButton';
import { HStack, Layout, LayoutContent, LayoutHeader, VStack } from '@astryxdesign/core/Layout';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import { api, chatStream, money } from '../api';
import { usePolling } from '../hooks/usePolling';
import { speak, useSpeechInput } from '../hooks/useSpeech';
import { icon, ProductImage } from '../components/ui';
import type { Agent, AgentTraceStep, ChatMessage as Message, Proposal, Transaction } from '../types';

const SUGGESTIONS = [
  { heading: 'Running low on something', prompt: "I'm almost out of my blood pressure cuffs" },
  { heading: 'Groceries', prompt: 'Could you get me some English breakfast tea?' },
  { heading: 'Staying safe at home', prompt: 'I keep tripping in the hallway at night' },
  { heading: 'Someone asked me for money', prompt: 'A man called, my grandson is in jail and needs gift cards right away' }
];

function stepText(step: AgentTraceStep, caregiver: string): string {
  if (step.tool === 'search_products') return `Looking for ${String(step.args.query ?? 'that')}`;
  if (step.tool === 'check_policy') return `Checking it against ${caregiver}'s rules`;
  if (step.tool === 'propose_purchase') return 'Getting it ready to show you';
  return 'Working on it';
}

type Outcome = { text: string; status: BannerProps['status'] };

function outcomeFor(tx: Transaction | undefined, caregiver: string): Outcome | null {
  if (!tx) return null;
  switch (tx.status) {
    case 'AUTO_EXECUTED':
    case 'APPROVED_BY_HUMAN':
      return { text: 'Bought! Paid safely with PayPal.', status: 'success' };
    case 'PENDING_APPROVAL':
      return { text: `Sent to ${caregiver} for an OK. I'll let you know.`, status: 'warning' };
    case 'REJECTED':
      return { text: `${caregiver} decided not to get this one.`, status: 'info' };
    case 'REFUNDED':
      return { text: 'This was refunded.', status: 'info' };
    case 'BLOCKED':
      return { text: "This one isn't allowed by your shopping rules.", status: 'error' };
    case 'EXPIRED':
      return { text: `${caregiver} didn't get to this in time, so nothing was paid. You can ask again.`, status: 'info' };
    case 'FAILED':
      return { text: "PayPal couldn't complete this payment, so nothing was bought.", status: 'error' };
  }
}

/** The helper's avatar: the same shield as the app logo, so Margaret knows who is talking. */
function HelperAvatar() {
  return (
    <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-on-accent" aria-hidden>
      {icon(ShieldCheck, 'md')}
    </span>
  );
}

function ProposalCard({
  proposal,
  tx,
  caregiver,
  onAccept,
  onDecline
}: {
  proposal: Proposal;
  tx?: Transaction;
  caregiver: string;
  onAccept: () => Promise<void>;
  onDecline: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const p = proposal.product;
  const outcome = outcomeFor(tx, caregiver);

  const run = async (which: 'yes' | 'no', fn: () => Promise<void>) => {
    setBusy(which);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card padding={0} elevation="low" className="overflow-hidden">
      <div className="flex flex-wrap items-start gap-4 p-4">
        <ProductImage src={p.imageUrl} category={p.category} className="h-28 w-28 shrink-0 rounded-md border border-border" />
        <VStack gap={1} className="min-w-0 flex-1 basis-56">
          <Heading level={3}>{p.title}</Heading>
          <Text type="display-3" color="accent" weight="bold">
            {money(p.price, p.currency)}
          </Text>
          <Text color="secondary" className="flex items-center gap-2">
            <Store className="h-5 w-5" aria-hidden /> {p.merchant}
            {p.rating ? ` · ${p.rating}★` : ''}
          </Text>
        </VStack>
      </div>

      {proposal.status === 'PROPOSED' && (
        <VStack gap={3} padding={4} className="border-t border-border">
          {proposal.policyPreview.verdict === 'HOLD' && (
            <Text weight="bold" className="text-on-warning-muted">
              {caregiver} will be asked to OK this first.
            </Text>
          )}
          <Grid columns={{ minWidth: 220, repeat: 'fit' }} gap={3}>
            <Button
              label="Yes, buy it"
              variant="primary"
              size="lg"
              width="100%"
              isLoading={busy === 'yes'}
              isDisabled={busy !== null && busy !== 'yes'}
              onClick={() => run('yes', onAccept)}
            />
            <Button
              label="No thanks"
              size="lg"
              width="100%"
              isLoading={busy === 'no'}
              isDisabled={busy !== null && busy !== 'no'}
              onClick={() => run('no', onDecline)}
            />
          </Grid>
          {error && <Banner status="error" title="Sorry, that didn't work" description={error} />}
        </VStack>
      )}

      {proposal.status === 'DECLINED' && !outcome && (
        <Text as="p" color="secondary" className="block border-t border-border p-4">
          You said no to this one.
        </Text>
      )}
      {outcome && <Banner status={outcome.status} title={outcome.text} container="section" />}
    </Card>
  );
}

export function ElderView() {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [readAloud, setReadAloud] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // On phones the avatar column costs too much width, so the helper's replies use the full row
  const isPhone = useMediaQuery('(max-width: 639px)');
  const { data: transactions, refresh: refreshTx } = usePolling(api.transactions, 4000);

  const caregiver = agent?.caregiverName || 'your family';
  const lastReply = [...messages].reverse().find(m => m.role === 'assistant')?.text ?? '';
  const txById = new Map((transactions || []).map(t => [t.id, t]));

  useEffect(() => {
    api
      .agents()
      .then(async agents => {
        const a = agents[0];
        setAgent(a);
        const history = await api.chatHistory(a.id);
        setMessages(history.messages);
        setProposals(Object.fromEntries(history.proposals.map(p => [p.id, p])));
      })
      .catch(err => setLoadError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, steps]);

  const say = (text: string) => readAloud && speak(text);

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || !agent || busy) return;
    setInput('');
    setBusy(true);
    setSteps([]);
    setMessages(m => [...m, { id: `local-${Date.now()}`, role: 'user', text, createdAt: new Date().toISOString() }]);
    try {
      const result = await chatStream(agent.id, text, step => setSteps(s => [...s, stepText(step, caregiver)]));
      if (result.proposal) setProposals(p => ({ ...p, [result.proposal!.id]: result.proposal! }));
      setMessages(m => [
        ...m,
        {
          id: `reply-${Date.now()}`,
          role: 'assistant',
          text: result.reply,
          proposalId: result.proposal?.id,
          kind: result.blocked ? 'scam_warning' : undefined,
          createdAt: new Date().toISOString()
        }
      ]);
      say(result.reply);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const reply = `Sorry, I couldn't do that just now. Please try again in a moment. (${reason})`;
      setMessages(m => [...m, { id: `err-${Date.now()}`, role: 'assistant', text: reply, createdAt: new Date().toISOString() }]);
    } finally {
      setBusy(false);
      setSteps([]);
    }
  };

  const speech = useSpeechInput(text => send(text));

  // After a failed Yes/No the suggestion may have changed elsewhere (other tab, reset, earlier timeout):
  // reload it from the server so the card shows what really happened instead of live buttons
  const resyncProposals = async () => {
    if (!agent) return;
    try {
      const history = await api.chatHistory(agent.id);
      setProposals(Object.fromEntries(history.proposals.map(p => [p.id, p])));
      await refreshTx();
    } catch {
      // Keep the current cards; the error is already shown
    }
  };

  const accept = async (proposal: Proposal) => {
    const result = await api.acceptProposal(proposal.id).catch(async err => {
      await resyncProposals();
      throw err;
    });
    setProposals(p => ({ ...p, [proposal.id]: { ...proposal, status: 'ACCEPTED', transactionId: result.transaction.id } }));
    await refreshTx();
    const outcome = outcomeFor(result.transaction, caregiver);
    if (outcome) say(outcome.text);
  };

  const decline = async (proposal: Proposal) => {
    // The server waits for any purchase in flight, so this may report it was already bought
    await api.declineProposal(proposal.id).catch(async err => {
      await resyncProposals();
      throw err;
    });
    setProposals(p => ({ ...p, [proposal.id]: { ...proposal, status: 'DECLINED' } }));
    say("OK, I won't get that one.");
  };

  // Voice first: a large Talk button sits in the composer, next to Send
  const micButton = speech.supported ? (
    <IconButton
      label={speech.listening ? 'Stop listening' : 'Talk'}
      tooltip={speech.listening ? 'Stop listening' : 'Talk instead of typing'}
      variant={speech.listening ? 'destructive' : 'primary'}
      size="lg"
      icon={icon(speech.listening ? Square : Mic, 'lg')}
      isDisabled={busy}
      onClick={speech.listening ? speech.stop : speech.start}
      className={`rounded-full ${speech.listening ? 'listening' : ''}`}
    />
  ) : null;

  const emptyState = (
    <VStack gap={6} paddingBlock={6}>
      <VStack gap={2}>
        <Heading level={2}>What do you need today?</Heading>
        <Text color="secondary">
          {speech.supported ? 'Press the green Talk button and just say it, or type below. ' : 'Type what you need below. '}
          You can also start with one of these:
        </Text>
      </VStack>
      <Grid columns={{ minWidth: 300, repeat: 'fit' }} gap={3}>
        {SUGGESTIONS.map(s => (
          <ClickableCard key={s.prompt} label={s.prompt} onClick={() => send(s.prompt)} padding={4} isDisabled={!agent || busy}>
            <VStack gap={1}>
              <Text type="supporting" color="secondary">
                {s.heading}
              </Text>
              <Text weight="medium">“{s.prompt}”</Text>
            </VStack>
          </ClickableCard>
        ))}
      </Grid>
    </VStack>
  );

  return (
    <div className="elder-scale h-full">
      <Layout
        height="fill"
        contentWidth={860}
        header={
          <LayoutHeader padding={4} hasDivider>
            <HStack gap={4} vAlign="center" hAlign="between">
              <VStack gap={0}>
                <Heading level={1}>Hello, {agent?.name || 'there'}</Heading>
                <Text color="secondary">{caregiver} helps keep your shopping safe.</Text>
              </VStack>
              <ToggleButton
                label="Read replies aloud"
                size="lg"
                isPressed={readAloud}
                onPressedChange={next => {
                  if (!next) window.speechSynthesis?.cancel();
                  setReadAloud(next);
                }}
                icon={icon(VolumeX, 'md')}
                pressedIcon={icon(Volume2, 'md')}
              >
                <span className="hidden sm:inline">{readAloud ? 'Reading aloud' : 'Silent'}</span>
              </ToggleButton>
            </HStack>
          </LayoutHeader>
        }
        content={
          <LayoutContent padding={0} isScrollable={false}>
            {/* Screen readers hear new replies and the current step here, not every re-render of the chat */}
            <p className="sr-only" role="status" aria-live="polite">
              {busy ? steps[steps.length - 1] || 'Thinking' : lastReply}
            </p>
            <ChatLayout
              density="spacious"
              className="h-full"
              emptyState={loadError ? undefined : emptyState}
              composer={
                <ChatComposer
                  density="spacious"
                  value={input}
                  onChange={setInput}
                  onSubmit={send}
                  placeholder={speech.supported ? 'Talk or type here' : 'Type what you need'}
                  isDisabled={busy || !agent}
                  status={speech.error ? { type: 'warning', message: speech.error } : undefined}
                  statusPosition="top"
                  sendActions={micButton}
                />
              }
            >
              {(messages.length > 0 || busy || loadError) && (
                <ChatMessageList>
                  {loadError && (
                    <div role="alert">
                      <Banner
                        status="error"
                        title="Sorry, I couldn't start up just now."
                        description={`Please refresh the page in a moment. (${loadError})`}
                      />
                    </div>
                  )}

                  {messages.map(m => {
                    if (m.role === 'user') {
                      return (
                        <ChatMessage key={m.id} sender="user" name="You">
                          <ChatMessageBubble>{m.text}</ChatMessageBubble>
                        </ChatMessage>
                      );
                    }
                    const proposal = m.proposalId ? proposals[m.proposalId] : undefined;
                    return (
                      <ChatMessage key={m.id} sender="assistant" name="Your helper" avatar={isPhone ? undefined : <HelperAvatar />}>
                        {m.kind === 'scam_warning' ? (
                          <ChatMessageBubble variant="ghost" width="100%" className="w-full px-0">
                            <Banner status="error" title="I stopped this to keep you safe" description={m.text} />
                          </ChatMessageBubble>
                        ) : (
                          <ChatMessageBubble variant="ghost">{m.text}</ChatMessageBubble>
                        )}
                        {proposal && (
                          <ChatMessageBubble variant="ghost" width="100%" className="w-full px-0">
                            <ProposalCard
                              proposal={proposal}
                              tx={proposal.transactionId ? txById.get(proposal.transactionId) : undefined}
                              caregiver={caregiver}
                              onAccept={() => accept(proposal)}
                              onDecline={() => decline(proposal)}
                            />
                          </ChatMessageBubble>
                        )}
                      </ChatMessage>
                    );
                  })}

                  {/* Glass box: Margaret sees each step the helper takes, in plain words */}
                  {busy && (
                    <ChatMessage sender="assistant" name="Your helper" avatar={isPhone ? undefined : <HelperAvatar />}>
                      <ChatMessageBubble variant="ghost">
                        <VStack gap={2}>
                          {steps.slice(0, -1).map((s, i) => (
                            <Text key={i} color="secondary" className="flex items-center gap-2">
                              <span className="text-success">{icon(CircleCheck, 'md')}</span> {s}
                            </Text>
                          ))}
                          <HStack gap={2} vAlign="center">
                            <Spinner size="lg" />
                            <Text>{steps[steps.length - 1] || 'Thinking'}…</Text>
                          </HStack>
                        </VStack>
                      </ChatMessageBubble>
                    </ChatMessage>
                  )}

                  {(speech.listening || speech.interim) && (
                    <ChatSystemMessage>{speech.interim || 'Listening… go ahead and talk.'}</ChatSystemMessage>
                  )}
                  <div ref={bottomRef} />
                </ChatMessageList>
              )}
            </ChatLayout>
          </LayoutContent>
        }
      />
    </div>
  );
}
