import crypto from 'crypto';
import { Alert, ApprovalRequest } from './types.js';
import { appSecret } from './config.js';
import { safeEqual } from './session.js';

// Email links stay valid for 3 days, PayPal's honor period for an authorization
const LINK_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export type ApprovalAction = 'approve' | 'decline';

function requireSecret(): string {
  const secret = appSecret();
  if (!secret) throw new Error('APP_SECRET must be set (16+ chars) to sign approval links');
  return secret;
}

// Render sets RENDER_EXTERNAL_URL automatically, so a deploy needs no base-URL config
export function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '');
}

function hmac(approvalId: string, action: ApprovalAction, expiresAt: number): string {
  return crypto.createHmac('sha256', requireSecret()).update(`${approvalId}:${action}:${expiresAt}`).digest('base64url');
}

// Approval links in emails are signed so only the caregiver's email can act on them, expire after
// LINK_TTL_MS, and are single use because the approval must still be PENDING.
export function signApprovalAction(approvalId: string, action: ApprovalAction, now = Date.now()): string {
  const expiresAt = now + LINK_TTL_MS;
  return `${expiresAt}.${hmac(approvalId, action, expiresAt)}`;
}

export function verifyApprovalAction(approvalId: string, action: ApprovalAction, token: string, now = Date.now()): boolean {
  const [expRaw, sig] = token.split('.');
  const expiresAt = Number(expRaw);
  if (!sig || !Number.isSafeInteger(expiresAt) || expiresAt < now) return false;
  return safeEqual(hmac(approvalId, action, expiresAt), sig);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function button(href: string, label: string, color: string): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 22px;margin-right:10px;border-radius:10px;background:${color};color:#fff;font-weight:700;text-decoration:none;font-size:16px">${label}</a>`;
}

/** Best effort: email is optional, so a missing key, missing secret or send failure never breaks the purchase flow. */
export async function emailCaregiver(alert: Alert, approval?: ApprovalRequest): Promise<void> {
  try {
    const apiKey = (process.env.RESEND_API_KEY || '').trim();
    const to = (process.env.CAREGIVER_EMAIL || '').trim();
    const from = (process.env.ALERT_FROM_EMAIL || 'Guardian Cart <onboarding@resend.dev>').trim();
    if (!apiKey || !to) return;

    // Links open a confirmation page; nothing happens until Sarah presses the button there,
    // so email scanners that prefetch links can't approve a purchase
    let actions = '';
    if (approval && appSecret()) {
      const base = `${publicBaseUrl()}/api/approvals/${encodeURIComponent(approval.id)}/decide`;
      actions = `<p style="margin:24px 0">${button(
        `${base}?action=approve&token=${signApprovalAction(approval.id, 'approve')}`,
        `Approve $${approval.amount.toFixed(2)}`,
        '#15803d'
      )}${button(`${base}?action=decline&token=${signApprovalAction(approval.id, 'decline')}`, 'Decline', '#b91c1c')}</p>`;
    }

    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;color:#1f2a37">
      <h2 style="margin:0 0 12px">${escapeHtml(alert.title)}</h2>
      <p style="font-size:16px;line-height:1.5">${escapeHtml(alert.message)}</p>
      ${alert.signals.length ? `<p style="font-size:14px;color:#5b6472">Warning signs: ${escapeHtml(alert.signals.join(', '))}</p>` : ''}
      ${actions}
      <p style="font-size:14px"><a href="${escapeHtml(publicBaseUrl())}/#/caregiver">Open the Guardian Cart dashboard</a></p>
    </div>`;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject: `Guardian Cart: ${alert.title}`, html }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      console.error('[Email] Resend failed:', response.status, (await response.text()).slice(0, 200));
    }
  } catch (err: any) {
    console.error('[Email] send failed:', err.message);
  }
}

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Guardian Cart</title></head>
  <body style="font-family:Arial,sans-serif;background:#faf7f2;color:#1f2a37;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px">
  <div style="background:#fff;border:1px solid #e7e1d6;border-radius:16px;padding:32px;max-width:440px">${body}</div></body></html>`;
}

export function resultPage(title: string, message: string, ok: boolean): string {
  return page(`<h1 style="margin:0 0 12px;font-size:24px;color:${ok ? '#15803d' : '#b91c1c'}">${escapeHtml(title)}</h1>
  <p style="font-size:17px;line-height:1.5">${escapeHtml(message)}</p>
  <p><a href="/#/caregiver">Open the dashboard</a></p>`);
}

/** Shown when an email link is opened: the decision is only made by submitting this form (POST). */
export function confirmPage(approval: ApprovalRequest, action: ApprovalAction, token: string): string {
  const approve = action === 'approve';
  const what = `${escapeHtml(approval.itemName)} (${escapeHtml(`$${approval.amount.toFixed(2)}`)})`;
  return page(`<h1 style="margin:0 0 12px;font-size:24px">${approve ? 'Approve this purchase?' : 'Decline this purchase?'}</h1>
  <p style="font-size:17px;line-height:1.5">${approval.agentName ? `${escapeHtml(approval.agentName)} wants ` : ''}${what}.</p>
  <p style="font-size:15px;color:#5b6472">${escapeHtml(approval.reason)}</p>
  <form method="post" action="/api/approvals/${encodeURIComponent(approval.id)}/decide">
    <input type="hidden" name="action" value="${action}">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <button type="submit" style="padding:14px 22px;border:0;border-radius:10px;background:${approve ? '#15803d' : '#b91c1c'};color:#fff;font-weight:700;font-size:16px;cursor:pointer">
      ${approve ? `Yes, approve and pay` : 'Yes, decline and release the hold'}
    </button>
  </form>
  <p style="margin-top:16px"><a href="/#/caregiver">Open the dashboard instead</a></p>`);
}
