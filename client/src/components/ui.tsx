import { useState, type ReactNode } from 'react';
import {
  Banknote,
  Gift,
  HeartPulse,
  House,
  LoaderCircle,
  Package,
  Puzzle,
  Shirt,
  ShoppingBasket,
  Smartphone,
  Sparkles
} from 'lucide-react';
import type { PolicyCategory, PolicyVerdict, Transaction } from '../types';

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
  const Icon = CATEGORY_ICON[category] || Package;
  if (src && !failed) {
    return <img src={src} alt="" onError={() => setFailed(true)} className={`object-contain bg-white ${className}`} />;
  }
  return (
    <div className={`flex items-center justify-center bg-brand-soft text-brand ${className}`} aria-hidden>
      <Icon className="h-1/2 w-1/2" strokeWidth={1.6} />
    </div>
  );
}

const STATUS_STYLE: Record<Transaction['status'], { label: string; className: string }> = {
  AUTO_EXECUTED: { label: 'Paid', className: 'bg-ok-soft text-ok' },
  APPROVED_BY_HUMAN: { label: 'Approved & paid', className: 'bg-ok-soft text-ok' },
  PENDING_APPROVAL: { label: 'Waiting for OK', className: 'bg-hold-soft text-hold' },
  REJECTED: { label: 'Declined', className: 'bg-line/60 text-muted' },
  REFUNDED: { label: 'Refunded', className: 'bg-paypal-soft text-paypal' },
  BLOCKED: { label: 'Blocked', className: 'bg-danger-soft text-danger' },
  EXPIRED: { label: 'Hold expired', className: 'bg-line/60 text-muted' },
  FAILED: { label: 'Payment failed', className: 'bg-danger-soft text-danger' }
};

export function StatusPill({ status }: { status: Transaction['status'] }) {
  const s = STATUS_STYLE[status];
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${s.className}`}>{s.label}</span>;
}

const VERDICT_STYLE: Record<PolicyVerdict, { label: string; className: string }> = {
  APPROVE: { label: 'Within the rules', className: 'bg-ok-soft text-ok' },
  HOLD: { label: 'Needs caregiver OK', className: 'bg-hold-soft text-hold' },
  BLOCK: { label: 'Blocked by rules', className: 'bg-danger-soft text-danger' }
};

export function VerdictBadge({ verdict }: { verdict: PolicyVerdict }) {
  const v = VERDICT_STYLE[verdict];
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${v.className}`}>{v.label}</span>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-line bg-surface p-5 ${className}`}>{children}</section>;
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return <LoaderCircle className={`animate-spin ${className}`} aria-hidden />;
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled,
  busy,
  className = '',
  type = 'button'
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ok';
  disabled?: boolean;
  busy?: boolean;
  className?: string;
  type?: 'button' | 'submit';
}) {
  const styles = {
    primary: 'bg-brand text-white hover:bg-brand-strong',
    ok: 'bg-ok text-white hover:brightness-95',
    danger: 'bg-surface text-danger border border-danger/40 hover:bg-danger-soft',
    secondary: 'bg-surface text-ink border border-line hover:bg-paper'
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 font-bold transition disabled:opacity-50 ${styles} ${className}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}
