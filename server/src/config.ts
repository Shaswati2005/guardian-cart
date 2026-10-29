import { assertSandboxConfig } from './paypal.js';

// Render sets RENDER=true on every service; NODE_ENV=production covers other hosts
export const IS_PRODUCTION = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);

export function appSecret(): string | null {
  const secret = (process.env.APP_SECRET || '').trim();
  return secret.length >= 16 ? secret : null;
}

export function caregiverPin(): string | null {
  const pin = (process.env.CAREGIVER_PIN || '').trim();
  return pin.length >= 6 ? pin : null;
}

/**
 * Fails fast on settings that would otherwise break at the worst moment (first payment, first email)
 * or leave the caregiver's dashboard open to anyone. Local development only gets warnings.
 */
export function validateConfig(): void {
  assertSandboxConfig();
  const problems: string[] = [];
  if (!appSecret()) problems.push('APP_SECRET must be set to 16+ random characters (signs sessions and email links)');
  if (!caregiverPin()) problems.push("CAREGIVER_PIN must be set (6+ characters) so only the caregiver can open Sarah's dashboard");
  if (problems.length === 0) return;
  if (IS_PRODUCTION) {
    throw new Error(`Refusing to start:\n- ${problems.join('\n- ')}`);
  }
  for (const p of problems) console.warn(`[Config] ${p}. Allowed in local development only.`);
}
