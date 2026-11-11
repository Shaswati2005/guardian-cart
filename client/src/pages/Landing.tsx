import { CornerDownRight, MessageCircleHeart, ShieldCheck, ShieldX, Wallet, WandSparkles } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Divider } from '@astryxdesign/core/Divider';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack, Layout, LayoutContent, VStack } from '@astryxdesign/core/Layout';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { icon } from '../components/ui';

const STEPS = [
  {
    Glyph: MessageCircleHeart,
    title: 'Margaret asks in plain words',
    text: 'She types or simply talks. The helper asks a short follow-up if it needs one, finds real products, and shows one clear choice with big Yes and No buttons.'
  },
  {
    Glyph: WandSparkles,
    title: 'Sarah sets the rules in her own words',
    text: '"Ask me above $40." AI turns that into exact limits, and Sarah reviews the change before it applies.'
  },
  {
    Glyph: ShieldCheck,
    title: 'Code decides, not the AI',
    text: 'Every purchase goes through a policy engine the AI cannot override. Gift-card and wire-transfer requests are stopped, and Sarah is told.'
  },
  {
    Glyph: Wallet,
    title: 'Paid safely with PayPal',
    text: 'Allowed purchases are paid right away. Anything else is held on PayPal until Sarah approves or releases it.'
  }
];

/** The hero "picture": a still preview of both sides of the product, made from the real components. */
function HeroPreview() {
  return (
    <figure className="mx-auto w-full max-w-[34rem] text-primary" aria-label="Preview of what Margaret and Sarah each see">
      <VStack gap={4}>
          <Card elevation="high" className="w-full">
            <VStack gap={3}>
              <HStack gap={2} vAlign="center">
                <span aria-hidden>👵</span>
                <Text type="label" color="secondary">
                  Margaret's view
                </Text>
              </HStack>
              <div className="self-end rounded-lg rounded-br-sm bg-accent px-4 py-3 text-lg text-on-accent">
                I keep tripping in the hallway at night
              </div>
              <div className="rounded-lg rounded-bl-sm border border-border px-4 py-3 text-lg">
                A motion night light would light the way. This one plugs into the wall:
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
                <div className="min-w-0">
                  <Text weight="bold" display="block" maxLines={1}>
                    Motion-sensor night light, 4 pack
                  </Text>
                  <Text type="large" weight="bold" color="accent" display="block">
                    $24.99
                  </Text>
                </div>
                <Button label="Yes, buy it" variant="primary" size="lg" />
              </div>
            </VStack>
          </Card>

          <Card elevation="high" className="w-full">
            <VStack gap={3}>
              <HStack gap={2} vAlign="center">
                <span aria-hidden>👩</span>
                <Text type="label" color="secondary">
                  Sarah's dashboard
                </Text>
              </HStack>
              <div className="rounded-md border border-border p-3">
                <HStack gap={2} vAlign="center">
                  <StatusDot variant="warning" label="Waiting" />
                  <Text weight="bold">Needs your OK</Text>
                </HStack>
                <Text as="p" display="block" className="mt-1">
                  Blood pressure monitor, $64.00. Over $40, so it's held on PayPal.
                </Text>
                <HStack gap={2} className="mt-3">
                  <Button label="Approve" variant="primary" size="sm" />
                  <Button label="Decline" size="sm" />
                </HStack>
              </div>
              <div className="flex gap-3 rounded-md border border-error bg-error-muted p-3">
                <span className="text-error">{icon(ShieldX, 'md')}</span>
                <div>
                  <Text weight="bold" display="block">
                    Scam stopped
                  </Text>
                  <Text type="supporting" display="block">
                    "My grandson needs gift cards right away." Nothing was bought.
                  </Text>
                </div>
              </div>
            </VStack>
          </Card>
      </VStack>
    </figure>
  );
}

export function Landing() {
  return (
    <Layout
      height="fill"
      content={
        <LayoutContent padding={0}>
          <VStack gap={10}>
            {/* Hero after the Folio reference: night-sky gradient, framed headline with one lime word,
                persona chips, a short caption and a lime pill call to action */}
            <section className="folio-hero relative overflow-hidden text-white">
              <div className="relative mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-6 py-14 md:py-20 lg:grid-cols-[1fr_1.05fr]">
                <div className="order-2 min-w-0 lg:order-1">
                  <HeroPreview />
                </div>

                <div className="relative order-1 min-w-0 rounded-tl-[44px] border-t border-l border-white/25 pt-10 pl-7 md:pl-12 lg:order-2">
                  {/* Tick marks on the frame's edge */}
                  {['top-[46%]', 'top-[64%]', 'top-[76%]'].map(t => (
                    <span key={t} aria-hidden className={`absolute -left-px ${t} h-6 w-0.5 bg-white`} />
                  ))}
                  <h1 className="text-[clamp(2.5rem,7vw,4.5rem)] leading-[0.95] font-bold tracking-tight text-balance text-white">
                    Independence, with a <span className="text-folio-lime">safety</span> net
                  </h1>

                  <div className="mt-8 flex items-center gap-3" aria-label="Margaret, Sarah and PayPal">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-2xl" title="Margaret">
                      👵
                    </span>
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-2xl" title="Sarah">
                      👩
                    </span>
                    <span className="flex h-12 items-center justify-center gap-1.5 rounded-full border border-dashed border-white/50 px-4 text-sm font-bold">
                      {icon(Wallet, 'sm')} PayPal
                    </span>
                  </div>

                  <p className="mt-8 max-w-sm text-lg leading-snug text-folio-lavender">
                    A shopping helper older adults can simply talk to. It follows the rules family set, stops scams, and
                    pays through PayPal.
                  </p>

                  <div className="mt-8 flex flex-wrap items-center gap-3">
                    <a
                      href="#/margaret"
                      className="inline-flex h-14 items-center gap-3 rounded-full bg-folio-lime px-7 text-lg font-bold text-folio-ink transition hover:brightness-95 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-white"
                    >
                      {icon(CornerDownRight, 'md')} Try Margaret's view
                    </a>
                    <a
                      href="#/caregiver"
                      className="inline-flex h-14 items-center rounded-full border border-white/40 px-7 text-lg font-bold text-white transition hover:bg-white/10 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-white"
                    >
                      Open Sarah's dashboard
                    </a>
                  </div>
                  <p className="mt-6 max-w-md pb-2 text-sm text-folio-lavender">
                    Tip: open the two views side by side to watch a purchase go from request to approval.
                  </p>
                </div>
              </div>
            </section>

            {/* How it works */}
            <VStack gap={6} className="mx-auto w-full max-w-5xl px-6">
              <Heading level={2} justify="center">
                How it works
              </Heading>
              <Grid columns={{ minWidth: 380, max: 2, repeat: 'fit' }} columnGap={10} rowGap={8}>
                {STEPS.map(({ Glyph, title, text }, i) => (
                  <HStack key={title} gap={4} vAlign="start">
                    <span
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-folio-ink text-folio-lime"
                      aria-hidden
                    >
                      {icon(Glyph, 'md')}
                    </span>
                    <VStack gap={1}>
                      <Text type="label" color="secondary">
                        Step {i + 1}
                      </Text>
                      <Heading level={3}>{title}</Heading>
                      <Text as="p" color="secondary">
                        {text}
                      </Text>
                    </VStack>
                  </HStack>
                ))}
              </Grid>
            </VStack>

            <Divider />
            <Text type="supporting" justify="center" as="p" className="mx-auto max-w-4xl px-6 pb-8">
              Built with Google Gemini (tool-calling agent, rule translation, scam detection), PayPal sandbox (Vault, Orders,
              Authorizations, Refunds, Webhooks), AG Grid and Render. Products come from a curated demo catalog, payments use the PayPal sandbox,
              and deliveries from stores are simulated.
            </Text>
          </VStack>
        </LayoutContent>
      }
    />
  );
}
