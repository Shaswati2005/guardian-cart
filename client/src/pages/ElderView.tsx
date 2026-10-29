import { useEffect, useRef, useState } from 'react';
import { Mic, Send, ShieldAlert, Store, Volume2, VolumeX } from 'lucide-react';
import { api, chatStream, money } from '../api';
import { usePolling } from '../hooks/usePolling';
import { speak, useSpeechInput } from '../hooks/useSpeech';
import { ProductImage, Spinner } from '../components/ui';
import type { Agent, AgentTraceStep, ChatMessage, Proposal, Transaction } from '../types';

const SUGGESTIONS = [
  "I'm almost out of my blood pressure cuffs",
  'Could you get me some English breakfast tea?',
  'I keep tripping in the hallway at night',
  'A man called, my grandson is in jail and needs gift cards right away'
];

function stepText(step: AgentTraceStep, caregiver: string): string {
  if (step.tool === 'search_products') return `Looking for ${String(step.args.query ?? 'that')}…`;
  if (step.tool === 'check_policy') return `Checking it against ${caregiver}'s rules…`;
  if (step.tool === 'propose_purchase') return 'Getting it ready to show you…';
  return 'Working on it…';
}

function outcomeText(tx: Transaction | undefined, caregiver: string): { text: string; tone: string } | null {
  if (!tx) return null;
  switch (tx.status) {
    case 'AUTO_EXECUTED':
    case 'APPROVED_BY_HUMAN':
      return { text: 'Bought! Paid safely with PayPal.', tone: 'bg-ok-soft text-ok' };
    case 'PENDING_APPROVAL':
      return { text: `Sent to ${caregiver} for an OK. I'll let you know.`, tone: 'bg-hold-soft text-hold' };
    case 'REJECTED':
      return { text: `${caregiver} decided not to get this one.`, tone: 'bg-line/60 text-muted' };
    case 'REFUNDED':
      return { text: 'This was refunded.', tone: 'bg-paypal-soft text-paypal' };
    case 'BLOCKED':
      return { text: "This one isn't allowed by your shopping rules.", tone: 'bg-danger-soft text-danger' };
    case 'EXPIRED':
      return { text: `${caregiver} didn't get to this in time, so nothing was paid. You can ask again.`, tone: 'bg-line/60 text-muted' };
    case 'FAILED':
      return { text: "PayPal couldn't complete this payment, so nothing was bought.", tone: 'bg-danger-soft text-danger' };
  }
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
  const outcome = outcomeText(tx, caregiver);

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
    <div className="mt-3 overflow-hidden rounded-2xl border-2 border-line bg-surface">
      <div className="flex gap-4 p-4">
        <ProductImage src={p.imageUrl} category={p.category} className="h-28 w-28 shrink-0 rounded-xl border border-line" />
        <div className="min-w-0">
          <p className="text-xl font-bold leading-snug">{p.title}</p>
          <p className="mt-1 text-3xl font-bold text-brand">{money(p.price, p.currency)}</p>
          <p className="mt-1 flex items-center gap-1.5 text-lg text-muted">
            <Store className="h-5 w-5" aria-hidden /> {p.merchant}
            {p.rating ? <span>· {p.rating}★</span> : null}
          </p>
        </div>
      </div>

      {proposal.status === 'PROPOSED' && (
        <div className="border-t border-line p-4">
          {proposal.policyPreview.verdict === 'HOLD' && (
            <p className="mb-3 text-lg text-hold">{caregiver} will be asked to OK this first.</p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => run('yes', onAccept)}
              disabled={busy !== null}
              className="flex min-h-16 items-center justify-center gap-2 rounded-2xl bg-ok px-4 text-2xl font-bold text-white disabled:opacity-60"
            >
              {busy === 'yes' && <Spinner className="h-6 w-6" />} Yes, buy it
            </button>
            <button
              onClick={() => run('no', onDecline)}
              disabled={busy !== null}
              className="min-h-16 rounded-2xl border-2 border-line bg-surface px-4 text-2xl font-bold text-ink disabled:opacity-60"
            >
              No thanks
            </button>
          </div>
          {error && <p className="mt-3 text-lg text-danger">Sorry, that didn't work: {error}</p>}
        </div>
      )}

      {proposal.status === 'DECLINED' && <p className="border-t border-line bg-paper p-4 text-lg text-muted">You said no to this one.</p>}
      {outcome && <p className={`border-t border-line p-4 text-xl font-bold ${outcome.tone}`}>{outcome.text}</p>}
    </div>
  );
}

export function ElderView() {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [readAloud, setReadAloud] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
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
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
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
    const outcome = outcomeText(result.transaction, caregiver);
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

  return (
    <div className="mx-auto flex min-h-[calc(100vh-64px)] max-w-3xl flex-col px-4">
      <header className="flex items-start justify-between gap-4 py-6">
        <div>
          <h1 className="text-3xl font-bold md:text-4xl">Hello, {agent?.name || 'there'}</h1>
          <p className="mt-1 text-xl text-muted">Tell me what you need. {caregiver} helps keep your shopping safe.</p>
        </div>
        <button
          onClick={() => {
            if (readAloud) window.speechSynthesis?.cancel();
            setReadAloud(r => !r);
          }}
          className="flex shrink-0 items-center gap-2 rounded-xl border-2 border-line bg-surface px-3 py-2 text-lg font-bold"
          aria-pressed={readAloud}
        >
          {readAloud ? <Volume2 className="h-6 w-6" /> : <VolumeX className="h-6 w-6" />}
          <span className="hidden sm:inline">{readAloud ? 'Reading aloud' : 'Silent'}</span>
        </button>
      </header>

      {/* Screen readers hear new replies and the current step here, not every re-render of the chat */}
      <p className="sr-only" role="status" aria-live="polite">
        {busy ? steps[steps.length - 1] || 'Thinking' : lastReply}
      </p>

      <main className="flex-1 space-y-4 pb-6">
        {loadError && (
          <div role="alert" className="rounded-2xl border-2 border-danger/50 bg-danger-soft p-5 text-xl">
            Sorry, I couldn't start up just now. Please refresh the page in a moment.
            <span className="mt-2 block text-lg">({loadError})</span>
          </div>
        )}
        {messages.length === 0 && (
          <div className="rounded-2xl border-2 border-dashed border-line p-5">
            <p className="text-xl font-bold">You could say:</p>
            <div className="mt-3 flex flex-col gap-2">
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-xl bg-surface px-4 py-3 text-left text-xl border border-line hover:border-brand"
                >
                  “{s}”
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map(m => {
          const proposal = m.proposalId ? proposals[m.proposalId] : undefined;
          const isScamReply = m.role === 'assistant' && m.kind === 'scam_warning';
          return (
            <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
              <div
                className={`max-w-[92%] rounded-2xl px-5 py-4 text-xl leading-relaxed md:text-2xl ${
                  m.role === 'user'
                    ? 'bg-brand text-white'
                    : isScamReply
                      ? 'border-2 border-danger/50 bg-danger-soft'
                      : 'border border-line bg-surface'
                }`}
              >
                {isScamReply && <ShieldAlert className="mb-2 h-8 w-8 text-danger" aria-label="Safety warning" />}
                {m.text}
              </div>
              {proposal && (
                <ProposalCard
                  proposal={proposal}
                  tx={proposal.transactionId ? txById.get(proposal.transactionId) : undefined}
                  caregiver={caregiver}
                  onAccept={() => accept(proposal)}
                  onDecline={() => decline(proposal)}
                />
              )}
            </div>
          );
        })}

        {busy && (
          <div className="rounded-2xl border border-line bg-surface px-5 py-4 text-xl text-muted">
            <div className="flex items-center gap-3">
              <Spinner className="h-6 w-6 text-brand" />
              {steps[steps.length - 1] || 'Thinking…'}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </main>

      <footer className="sticky bottom-0 -mx-4 border-t border-line bg-paper/95 px-4 py-4 backdrop-blur">
        {(speech.listening || speech.interim) && (
          <p className="mb-2 text-xl text-muted">{speech.interim || 'Listening… go ahead and talk.'}</p>
        )}
        {speech.error && <p className="mb-2 text-lg text-danger">{speech.error}</p>}
        <form
          className="flex items-end gap-3"
          onSubmit={e => {
            e.preventDefault();
            send(input);
          }}
        >
          {speech.supported && (
            <button
              type="button"
              onClick={speech.listening ? speech.stop : speech.start}
              disabled={busy}
              className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-white disabled:opacity-50 ${
                speech.listening ? 'listening bg-danger' : 'bg-brand'
              }`}
              aria-label={speech.listening ? 'Stop listening' : 'Talk'}
            >
              <Mic className="h-8 w-8" />
            </button>
          )}
          <label className="sr-only" htmlFor="elder-input">
            Type what you need
          </label>
          <textarea
            id="elder-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={1}
            placeholder={speech.supported ? 'Talk or type here' : 'Type what you need'}
            className="min-h-16 flex-1 resize-none rounded-2xl border-2 border-line bg-surface px-4 py-4 text-xl outline-none focus:border-brand"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-ink text-white disabled:opacity-40"
            aria-label="Send"
          >
            <Send className="h-7 w-7" />
          </button>
        </form>
      </footer>
    </div>
  );
}
