import { ArrowRight, MessageCircleHeart, ShieldCheck, Wallet, WandSparkles } from 'lucide-react';

const STEPS = [
  {
    Icon: MessageCircleHeart,
    title: 'Ask in plain words',
    text: 'Margaret types or speaks what she needs. A Gemini agent asks a simple follow-up if needed and finds real products.'
  },
  {
    Icon: WandSparkles,
    title: 'Rules in your own words',
    text: 'Sarah writes rules like "ask me above $40". AI turns them into exact limits, and Sarah confirms before they apply.'
  },
  {
    Icon: ShieldCheck,
    title: 'Code decides, not the AI',
    text: 'Every purchase is checked by a policy engine the AI cannot override. Scam patterns like gift-card requests are stopped and Sarah is alerted.'
  },
  {
    Icon: Wallet,
    title: 'Paid safely with PayPal',
    text: 'Sarah approves PayPal once. Allowed purchases are paid right away; anything else is held on PayPal until Sarah approves or releases it.'
  }
];

function PersonaCard({ href, emoji, name, who, what }: { href: string; emoji: string; name: string; who: string; what: string }) {
  return (
    <a
      href={href}
      className="group flex flex-col rounded-2xl border-2 border-line bg-surface p-6 transition hover:border-brand hover:shadow-md"
    >
      <span className="text-5xl" aria-hidden>
        {emoji}
      </span>
      <span className="mt-4 text-2xl font-bold">Enter as {name}</span>
      <span className="text-muted">{who}</span>
      <span className="mt-3 flex-1">{what}</span>
      <span className="mt-4 inline-flex items-center gap-2 font-bold text-brand">
        Open <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
      </span>
    </a>
  );
}

export function Landing() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <p className="font-bold uppercase tracking-wider text-brand">Guardian Cart</p>
      <h1 className="mt-2 max-w-3xl text-4xl font-bold leading-tight md:text-5xl">
        Independence for older adults. Peace of mind for the family.
      </h1>
      <p className="mt-4 max-w-2xl text-xl text-muted">
        An AI shopping helper that older adults can simply talk to. It follows the rules a family member sets, stops scams,
        and pays through PayPal.
      </p>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <PersonaCard
          href="#/margaret"
          emoji="👵"
          name="Margaret"
          who="78, lives alone"
          what="Large text and voice. Ask for what you need, then tap Yes or No."
        />
        <PersonaCard
          href="#/caregiver"
          emoji="👩"
          name="Sarah"
          who="Margaret's daughter, two states away"
          what="Approve held purchases, see scam alerts, change the rules, and check every PayPal payment."
        />
      </div>
      <p className="mt-3 text-sm text-muted">Tip for the demo: open Margaret and Sarah in two windows side by side.</p>

      <h2 className="mt-12 text-2xl font-bold">How it works</h2>
      <ol className="mt-4 grid gap-4 md:grid-cols-2">
        {STEPS.map(({ Icon, title, text }) => (
          <li key={title} className="flex gap-4 rounded-2xl border border-line bg-surface p-5">
            <Icon className="h-8 w-8 shrink-0 text-brand" aria-hidden />
            <div>
              <p className="font-bold">{title}</p>
              <p className="mt-1 text-muted">{text}</p>
            </div>
          </li>
        ))}
      </ol>

      <p className="mt-10 text-sm text-muted">
        Built with Google Gemini (tool-calling agent, rule translation, scam detection), PayPal sandbox (Vault, Orders,
        Authorizations, Refunds, Webhooks), Channel3 product search and AG Grid. Payments use the PayPal sandbox; deliveries
        from stores are simulated.
      </p>
    </div>
  );
}
