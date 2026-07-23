import { supabase, supabaseAuth } from '../lib/supabase';
import * as cookie from 'cookie';
import * as cookieSig from 'cookie-signature';
import dotenv from 'dotenv';
import { Request, Response, NextFunction } from 'express';
dotenv.config();

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

export interface AuthenticatedRequest extends Request {
  userId?: string;
  profile?: Profile;
  tempAccess?: TempAccess;
}

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const SUPABASE_URL   = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// ── Cookie helpers ───────────────────────────────────────

/** Read and unsign the tm_access cookie from signed cookies or raw header */
function extractToken(req: AuthenticatedRequest): string | null {
  // cookie-parser already populates req.signedCookies when cookieParser(secret) is used
  const fromSigned = req.signedCookies?.tm_access;
  if (fromSigned) return fromSigned;
  return null;
}

function extractRefreshToken(req: AuthenticatedRequest): string | null {
  return req.signedCookies?.tm_refresh ?? null;
}

export function setSessionCookies(
  res: Response,
  access_token: string,
  refresh_token: string
): void {
  const opts = {
    httpOnly: true,
    signed: true,
    sameSite: 'none' as const,
    secure: true,
  };
  res.cookie('tm_access',  access_token,  { ...opts, maxAge: 60 * 60 * 1000 });         // 1h
  res.cookie('tm_refresh', refresh_token, { ...opts, maxAge: 30 * 24 * 60 * 60 * 1000 }); // 30d
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie('tm_access');
  res.clearCookie('tm_refresh');
}

/** Parse and unsign tm_access from a raw Cookie header string (for socket.io middleware) */
export function unsignTokenFromCookieHeader(cookieHeader: string): string | null {
  try {
    const parsed = cookie.parse(cookieHeader);
    const raw = parsed['tm_access'];
    if (!raw?.startsWith('s:')) return null;
    const result = cookieSig.unsign(raw.slice(2), SESSION_SECRET);
    return result || null;
  } catch {
    return null;
  }
}

// ── Attempt token refresh ────────────────────────────────

async function tryRefresh(
  req: AuthenticatedRequest,
  res: Response
): Promise<{ access_token: string; user_id: string } | null> {
  const refreshToken = extractRefreshToken(req);
  if (!refreshToken) return null;

  try {
    const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) return null;

    const { access_token, refresh_token } = data.session;
    setSessionCookies(res, access_token, refresh_token);
    return { access_token, user_id: data.session.user.id };
  } catch {
    return null;
  }
}

// ── Main auth middleware ─────────────────────────────────

export async function verifyJWT(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  let token = extractToken(req);

  // Try refresh if no access cookie
  if (!token) {
    const refreshed = await tryRefresh(req, res);
    if (!refreshed) {
      res.status(401).json({ error: 'Not authenticated — please sign in' });
      return;
    }
    token = refreshed.access_token;
  }

  try {
    const { data: { user }, error } = await supabaseAuth.auth.getUser(token);

    if (error || !user) {
      // Token may have expired; try refresh
      const refreshed = await tryRefresh(req, res);
      if (!refreshed) {
        clearSessionCookies(res);
        res.status(401).json({ error: 'Session expired — please sign in again' });
        return;
      }
      // Re-fetch user with new token
      const { data: { user: refreshedUser } } = await supabaseAuth.auth.getUser(refreshed.access_token);
      if (!refreshedUser) {
        clearSessionCookies(res);
        res.status(401).json({ error: 'Session expired — please sign in again' });
        return;
      }
    }

    // Load profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user!.id)
      .single();

    if (profileError || !profile) {
      res.status(401).json({ error: 'Profile not found — please sign in again' });
      return;
    }

    if (profile.status === 'suspended') {
      res.status(403).json({ error: 'Account is suspended' });
      return;
    }

    if (profile.status === 'rejected') {
      res.status(403).json({ error: 'Account was rejected' });
      return;
    }

    req.userId  = user!.id;
    req.profile = profile as Profile;
    next();
  } catch (err) {
    console.error('verifyJWT error:', err);
    res.status(401).json({ error: 'Token verification failed' });
  }
}

// ── JWT-or-TempToken middleware ─────────────────────────

export async function verifyJWTOrTemp(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const tempToken = req.headers['x-temp-token'] as string | undefined;

  // Prefer cookie session if present
  const token = extractToken(req);
  if (token) {
    return verifyJWT(req, res, next);
  }

  // Try temp token (for anonymous read-only access links)
  if (tempToken) {
    const { data: link, error } = await supabase
      .from('temp_access_links')
      .select('id, allowed_pages, expires_at, max_uses, use_count, is_active')
      .eq('token', tempToken)
      .eq('is_active', true)
      .single();

    if (error || !link) {
      res.status(403).json({ error: 'Invalid temp access token' });
      return;
    }

    if (new Date(link.expires_at) < new Date()) {
      res.status(403).json({ error: 'Temp access link has expired' });
      return;
    }

    if (link.max_uses !== null && link.use_count >= link.max_uses) {
      res.status(403).json({ error: 'Temp access link has reached maximum uses' });
      return;
    }

    req.tempAccess = { allowed_pages: link.allowed_pages };
    next();
    return;
  }

  res.status(401).json({ error: 'Authentication required' });
}
