import { NextFunction, Request, Response } from 'express';

// In-memory fixed-window limiter. One instance serves the hosted demo, so no shared store is needed.
// Protects the Gemini and Channel3 quotas from a single visitor (or bot) burning them.
export function rateLimit({ windowMs, max, name, global = false }: { windowMs: number; max: number; name: string; global?: boolean }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = global ? '*' : req.ip || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      }
    }
    entry.count++;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: global
          ? 'The demo has reached its AI limit for today. Please try again later.'
          : `Too many requests, please wait ${retryAfter} seconds and try again.`,
        limit: name
      });
    }
    next();
  };
}
