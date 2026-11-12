import { useState, type ComponentType, type SVGProps } from 'react';
import { Badge, type BadgeProps } from '@astryxdesign/core/Badge';
import { Icon } from '@astryxdesign/core/Icon';
import {
  Banknote,
  Gift,
  HeartPulse,
  House,
  Package,
  Puzzle,
  Shirt,
  ShoppingBasket,
  Smartphone,
  Sparkles
} from 'lucide-react';
import type { PolicyCategory, PolicyVerdict, Transaction } from '../types';

/** A Lucide icon as an Astryx Icon, so it picks up the button/field's size and color. */
export const icon = (glyph: ComponentType<SVGProps<SVGSVGElement>>, size?: 'xsm' | 'sm' | 'md' | 'lg') => (
  <Icon icon={glyph} size={size} />
);

/** The Guardian Cart mark: a shopping bag with a heart, the same drawing as favicon.svg. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="#c2410c" />
      <path d="M11 12V10a5 5 0 0 1 10 0v2" stroke="#fff7ed" strokeWidth="2.2" fill="none" strokeLinecap="round" />
      <path d="M7.5 12h17l-1.3 13.2a2 2 0 0 1-2 1.8H10.8a2 2 0 0 1-2-1.8z" fill="#fff7ed" />
      <path d="M16 23.2s-4-2.4-4-5.1a2.1 2.1 0 0 1 4-1 2.1 2.1 0 0 1 4 1c0 2.7-4 5.1-4 5.1z" fill="#c2410c" />
    </svg>
  );
}

const CATEGORY_ICON: Record<PolicyCategory, typeof Package> = {
  HEALTH: HeartPulse,
  GROCERY: ShoppingBasket,
  HOUSEHOLD: House,
  PERSONAL_CARE: Sparkles,
  CLOTHING: Shirt,
  ELECTRONICS: Smartphone,
  HOBBIES: Puzzle,
  GIFT_CARDS: Gift,
  FINANCIAL: Banknote,
  OTHER: Package
};

export const categoryLabel = (c: PolicyCategory) =>
  c.charAt(0) + c.slice(1).toLowerCase().replace('_', ' ');

/** Product photo, or a calm category icon when there's no image (curated items) or it fails to load. */
export function ProductImage({ src, category, className = '' }: { src?: string; category: PolicyCategory; className?: string }) {
  const [failed, setFailed] = useState(false);
  const Glyph = CATEGORY_ICON[category] || Package;
  if (src && !failed) {
    return <img src={src} alt="" onError={() => setFailed(true)} className={`bg-white object-contain ${className}`} />;
  }
  return (
    <div className={`flex items-center justify-center bg-accent-muted text-accent ${className}`} aria-hidden>
      <Glyph className="h-1/2 w-1/2" strokeWidth={1.6} />
    </div>
  );
}

type BadgeVariant = BadgeProps['variant'];

// Loud status colors only where Sarah may need to act (waiting, blocked, failed); settled states stay calm
const STATUS_BADGE: Record<Transaction['status'], { label: string; variant: BadgeVariant }> = {
  AUTO_EXECUTED: { label: 'Paid', variant: 'green' },
  APPROVED_BY_HUMAN: { label: 'Approved & paid', variant: 'green' },
  PENDING_APPROVAL: { label: 'Waiting for OK', variant: 'warning' },
  REJECTED: { label: 'Declined', variant: 'neutral' },
  REFUNDED: { label: 'Refunded', variant: 'blue' },
  BLOCKED: { label: 'Blocked', variant: 'error' },
  EXPIRED: { label: 'Hold expired', variant: 'neutral' },
  FAILED: { label: 'Payment failed', variant: 'error' }
};

export function StatusPill({ status }: { status: Transaction['status'] }) {
  const s = STATUS_BADGE[status];
  return <Badge label={s.label} variant={s.variant} />;
}

const VERDICT_BADGE: Record<PolicyVerdict, { label: string; variant: BadgeVariant }> = {
  APPROVE: { label: 'Within the rules', variant: 'green' },
  HOLD: { label: 'Needs caregiver OK', variant: 'warning' },
  BLOCK: { label: 'Blocked by rules', variant: 'error' }
};

export function VerdictBadge({ verdict }: { verdict: PolicyVerdict }) {
  const v = VERDICT_BADGE[verdict];
  return <Badge label={v.label} variant={v.variant} />;
}
