import { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import * as cookie from 'cookie';
// nodejs_compat (enabled in wrangler.toml) polyfills node:crypto, so
// cookie-signature works unmodified — same signing scheme as Express's
// cookie-parser, so existing signed cookies from the old backend keep working.
import * as cookieSig from 'cookie-signature';
import { getSupabase, getSupabaseAuth, Env } from '../lib/supabase';

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  status: 'pending' | 'approved' | 'suspended' | 'rejected';
  role: 'admin' | 'user';
  created_at: string;
  approved_at: string | null;
}

export interface TempAccess {
  allowed_pages: string[];
}

// Hono stores per-request values on c.set/c.get instead of mutating req.
// These keys mirror the old req.userId / req.profile / req.tempAccess.
type Vars = {
  userId?: string;
  profile?: Profile;
  tempAccess?: TempAccess;
};
export type AuthedContext = Context<{ Bindings: Env; Variables: Vars }>;

// ── Cookie helpers ───────────────────────────────────────

function unsign(signed: string, secret: string): string | null {
  if (!signed?.startsWith('s:')) return null;
  const result = cookieSig.unsign(signed.slice(2), secret);
  return result || null;
}

export function extractToken(c: AuthedContext): string | null {
  const raw = getCookie(c, 'tm_access');
  if (!raw) return null;
  return unsign(raw, c.env.SESSION_SECRET);
}

function extractRefreshToken(c: AuthedContext): string | null {
  const raw = getCookie(c, 'tm_refresh');
  if (!raw) return null;
  return unsign(raw, c.env.SESSION_SECRET);
}

export function setSessionCookies(c: AuthedContext, access_token: string, refresh_token: string): void {
  const sign = (val: string) => 's:' + cookieSig.sign(val, c.env.SESSION_SECRET);
  const base = { httpOnly: true, sameSite: 'None' as const, secure: true, path: '/' };
  setCookie(c, 'tm_access', sign(access_token), { ...base, maxAge: 60 * 60 });
  setCookie(c, 'tm_refresh', sign(refresh_token), { ...base, maxAge: 30 * 24 * 60 * 60 });
}

export function clearSessionCookies(c: AuthedContext): void {
  deleteCookie(c, 'tm_access', { path: '/' });
  deleteCookie(c, 'tm_refresh', { path: '/' });
}

/** Parse + unsign tm_access from a raw Cookie header — used by the
 * Durable Object realtime layer, same job as the old socket.io auth. */
export function unsignTokenFromCookieHeader(cookieHeader: string, secret: string): string | null {
  try {
    const parsed = cookie.parse(cookieHeader);
    const raw = parsed['tm_access'];
    if (!raw) return null;
    return unsign(raw, secret);
  } catch {
    return null;
  }
}

// ── Attempt token refresh ────────────────────────────────

async function tryRefresh(c: AuthedContext): Promise<{ access_token: string; user_id: string } | null> {
  const refreshToken = extractRefreshToken(c);
  if (!refreshToken) return null;

  try {
    const supabaseAuth = getSupabaseAuth(c.env);
    const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) return null;

    const { access_token, refresh_token } = data.session;
    setSessionCookies(c, access_token, refresh_token);
    return { access_token, user_id: data.session.user.id };
  } catch {
    return null;
  }
}

// ── Main auth middleware ─────────────────────────────────

export async function verifyJWT(c: AuthedContext, next: Next): Promise<Response | void> {
  let token = extractToken(c);

  if (!token) {
    const refreshed = await tryRefresh(c);
    if (!refreshed) return c.json({ error: 'Not authenticated — please sign in' }, 401);
    token = refreshed.access_token;
  }

  try {
    const supabaseAuth = getSupabaseAuth(c.env);
    const supabase = getSupabase(c.env);
    let { data: { user }, error } = await supabaseAuth.auth.getUser(token);

    if (error || !user) {
      const refreshed = await tryRefresh(c);
      if (!refreshed) {
        clearSessionCookies(c);
        return c.json({ error: 'Session expired — please sign in again' }, 401);
      }
      const { data } = await supabaseAuth.auth.getUser(refreshed.access_token);
      user = data.user;
      if (!user) {
        clearSessionCookies(c);
        return c.json({ error: 'Session expired — please sign in again' }, 401);
      }
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return c.json({ error: 'Profile not found — please sign in again' }, 401);
    }
    if (profile.status === 'suspended') return c.json({ error: 'Account is suspended' }, 403);
    if (profile.status === 'rejected') return c.json({ error: 'Account was rejected' }, 403);

    c.set('userId', user.id);
    c.set('profile', profile as Profile);
    await next();
  } catch (err) {
    console.error('verifyJWT error:', err);
    return c.json({ error: 'Token verification failed' }, 401);
  }
}

// ── JWT-or-TempToken middleware ─────────────────────────

export async function verifyJWTOrTemp(c: AuthedContext, next: Next): Promise<Response | void> {
  const tempToken = c.req.header('x-temp-token');
  const token = extractToken(c);

  if (token) return verifyJWT(c, next);

  if (tempToken) {
    const supabase = getSupabase(c.env);
    const { data: link, error } = await supabase
      .from('temp_access_links')
      .select('id, allowed_pages, expires_at, max_uses, use_count, is_active')
      .eq('token', tempToken)
      .eq('is_active', true)
      .single();

    if (error || !link) return c.json({ error: 'Invalid temp access token' }, 403);
    if (new Date(link.expires_at) < new Date()) return c.json({ error: 'Temp access link has expired' }, 403);
    if (link.max_uses !== null && link.use_count >= link.max_uses) {
      return c.json({ error: 'Temp access link has reached maximum uses' }, 403);
    }

    c.set('tempAccess', { allowed_pages: link.allowed_pages });
    await next();
    return;
  }

  return c.json({ error: 'Authentication required' }, 401);
}
