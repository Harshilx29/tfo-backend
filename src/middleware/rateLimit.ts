import { Next } from 'hono';
import { AuthedContext } from './auth';

/**
 * express-rate-limit kept counts in a process-local Map, which relied on
 * every request hitting the same long-lived Node process. Workers has no
 * such guarantee — different requests can land on different isolates —
 * so counting has to live in a globally consistent service instead.
 * Cloudflare's Rate Limiting binding (declared in wrangler.toml) does
 * that natively at the edge, so this file is a genuine redesign, not a
 * port: same external behavior (429s past a threshold), different
 * mechanism.
 */
function clientKey(c: AuthedContext): string {
  // CF-Connecting-IP is the real client IP at the edge (equivalent to
  // trusting X-Forwarded-For with `app.set('trust proxy', 1)` before).
  return c.req.header('CF-Connecting-IP') || 'unknown';
}

async function limit(
  c: AuthedContext,
  next: Next,
  limiter: { limit: (opts: { key: string }) => Promise<{ success: boolean }> },
  message: string
): Promise<Response | void> {
  const { success } = await limiter.limit({ key: clientKey(c) });
  if (!success) return c.json({ error: message }, 429);
  await next();
}

/** Global limiter — 100 req/min per IP. Skip /health in the route setup. */
export const apiLimiter = (c: AuthedContext, next: Next) =>
  limit(c, next, c.env.API_RATE_LIMITER, 'Too many requests — please slow down and try again.');

/** Auth limiter — 10 attempts per minute per IP. */
export const authLimiter = (c: AuthedContext, next: Next) =>
  limit(c, next, c.env.AUTH_RATE_LIMITER, 'Too many login attempts — please wait a minute and try again.');

/** Temp-link validation limiter — 20 attempts per 5 minutes per IP. */
export const tempLinkLimiter = (c: AuthedContext, next: Next) =>
  limit(c, next, c.env.TEMP_LINK_RATE_LIMITER, 'Too many link validation attempts — please wait and try again.');
