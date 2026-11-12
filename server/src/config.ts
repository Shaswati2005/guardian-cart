import { assertSandboxConfig } from './paypal.js';

// Render sets RENDER=true on every service; NODE_ENV=production covers other hosts
export const IS_PRODUCTION = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);

export function appSecret(): string | null {
  const secret = (process.env.APP_SECRET || '').trim();
  return secret.length >= 16 ? secret : null;
}

/**
 * Fails fast on settings that would otherwise break at the worst moment (first payment, first email)
 * Local development only gets warnings.
 */
export function validateConfig(): void {
  assertSandboxConfig();
  const problems: string[] = [];
  if (!appSecret()) problems.push('APP_SECRET must be set to 16+ random characters (signs sessions and email links)');
  if (problems.length === 0) return;
  if (IS_PRODUCTION) {
    throw new Error(`Refusing to start:\n- ${problems.join('\n- ')}`);
  }
  for (const p of problems) console.warn(`[Config] ${p}. Allowed in local development only.`);
}
