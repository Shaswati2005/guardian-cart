import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { appSecret, caregiverPin } from './config.js';

// Personas: entering as Margaret sets a signed role cookie with one click. Sarah's dashboard can
// approve, refund and change rules, so it needs CAREGIVER_PIN (share it with judges in the
// submission notes). Every endpoint checks the role: Margaret's page can never approve, refund,
// reset or change rules, and Sarah's page can't shop.
export type Role = 'elder' | 'caregiver';
export const ROLES: Role[] = ['elder', 'caregiver'];

// One cookie per persona, so Margaret and Sarah can be open side by side in the same browser
const cookieName = (role: Role) => `gc_${role}`;
// Local development without APP_SECRET only (production refuses to start): sessions reset on restart
const fallbackSecret = crypto.randomBytes(32).toString('hex');

function secret(): string {
  return appSecret() ?? fallbackSecret;
}

function sign(role: Role): string {
  return crypto.createHmac('sha256', secret()).update(`role:${role}`).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  // Hash first so the comparison is constant-time even when the lengths differ
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function hasValidCookie(req: Request, role: Role): boolean {
  const name = cookieName(role);
  const raw = (req.headers.cookie || '')
    .split(';')
    .map(c => c.trim())
    .find(c => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!raw) return false;
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return false;
  }
  const [cookieRole, sig] = value.split('.');
  return cookieRole === role && Boolean(sig) && safeEqual(sign(role), sig);
}

/** Without a PIN configured (local development only) the caregiver persona stays one-click. */
export function caregiverPinRequired(): boolean {
  return caregiverPin() !== null;
}

export function checkCaregiverPin(pin: unknown): boolean {
  const expected = caregiverPin();
  if (!expected) return true;
  return typeof pin === 'string' && safeEqual(pin.trim(), expected);
}

export function setRole(req: Request, res: Response, role: Role) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${cookieName(role)}=${encodeURIComponent(`${role}.${sign(role)}`)}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

export function hasRole(req: Request, role: Role): boolean {
  return hasValidCookie(req, role);
}

/** Every persona this browser has entered as. */
export function currentRoles(req: Request): Role[] {
  return ROLES.filter(role => hasValidCookie(req, role));
}

export function requireRole(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const roles = currentRoles(req);
    if (roles.length === 0) return res.status(401).json({ error: 'Please choose Margaret or Sarah first.' });
    if (!roles.some(role => allowed.includes(role))) {
      // roleMismatch tells the page it needs to enter as its own persona first
      return res.status(403).json({
        error: roles.includes('elder') ? 'Only Sarah can do that from her dashboard.' : "Only Margaret can do that from her page.",
        roleMismatch: true
      });
    }
    next();
  };
}
