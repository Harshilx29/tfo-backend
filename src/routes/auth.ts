import { Router, Request } from 'express';
import { supabase } from '../lib/supabase';
import {
  verifyJWT,
  AuthenticatedRequest,
  setSessionCookies,
  clearSessionCookies,
} from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimit';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const router = Router();

const SUPABASE_URL   = process.env.SUPABASE_URL   || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const BACKEND_URL    = process.env.BACKEND_URL    || 'http://localhost:3001';
const FRONTEND_URL   = process.env.FRONTEND_URL   || 'http://localhost:5173';
const ADMIN_EMAIL    = (process.env.ADMIN_EMAIL   || '').toLowerCase().trim();

// ── PKCE helpers ────────────────────────────────────────

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ── Profile upsert (shared by callback) ─────────────────

async function upsertProfile(userId: string, email: string, fullName?: string, avatarUrl?: string) {
  const isAdmin = ADMIN_EMAIL.length > 0 && email.toLowerCase().trim() === ADMIN_EMAIL;

  const { data: existing } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (!existing) {
    const { data, error } = await supabase
      .from('profiles')
      .insert({
        id:          userId,
        email,
        full_name:   fullName  ?? null,
        avatar_url:  avatarUrl ?? null,
        status:      isAdmin ? 'approved' : 'pending',
        role:        isAdmin ? 'admin'    : 'user',
        approved_at: isAdmin ? new Date().toISOString() : null,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // Existing user — only update name/avatar (preserve status/role)
  const { data, error } = await supabase
    .from('profiles')
    .update({
      full_name:  fullName  ?? existing.full_name,
      avatar_url: avatarUrl ?? existing.avatar_url,
    })
    .eq('id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── GET /auth/google ─────────────────────────────────
// Step 1: Redirect browser to Google OAuth via Supabase with PKCE.
// authLimiter: max 10 login initiations per minute per IP — blocks login abuse.

router.get('/google', authLimiter, (req: Request, res) => {
  const verifier   = generateCodeVerifier();
  const challenge  = generateCodeChallenge(verifier);
  const callbackUrl = `${BACKEND_URL}/auth/callback`;

  // Store the verifier in a short-lived signed httpOnly cookie
  (res as any).cookie('tm_pkce', verifier, {
    httpOnly: true,
    signed:   true,
    maxAge:   5 * 60 * 1000, // 5 min
    // CROSS-ORIGIN SECURE COOKIE SETTINGS FOR DEV TUNNELS
    sameSite: 'none',
    secure:   true,
  });

  const params = new URLSearchParams({
    provider:               'google',
    redirect_to:            callbackUrl,
    code_challenge:         challenge,
    code_challenge_method:  's256',
  });

  res.redirect(`${SUPABASE_URL}/auth/v1/authorize?${params.toString()}`);
});

// ── GET /auth/callback ───────────────────────────────
// Step 2: Supabase redirects here with ?code=.
// We exchange the code for tokens and set httpOnly session cookies.
// authLimiter prevents callback replay / token stuffing attacks.

router.get('/callback', authLimiter, async (req: Request, res) => {
  const code     = req.query.code as string | undefined;
  const verifier = (req as any).signedCookies?.tm_pkce as string | undefined;

  // Clear the PKCE cookie whether we succeed or fail
  res.clearCookie('tm_pkce');

  if (!code || !verifier) {
    console.error('OAuth callback: missing code or PKCE verifier');
    return res.redirect(`${FRONTEND_URL}/login?error=auth_failed`);
  }

  try {
    // Exchange authorization code + verifier for session tokens
    const tokenRes = await fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=pkce`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          auth_code:     code,
          code_verifier: verifier,
        }),
      }
    );

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error('PKCE token exchange failed:', err);
      return res.redirect(`${FRONTEND_URL}/login?error=token_exchange_failed`);
    }

    const session = await tokenRes.json() as {
      access_token:  string;
      refresh_token: string;
      user: {
        id: string;
        email: string;
        user_metadata: { full_name?: string; avatar_url?: string };
      };
    };

    const { access_token, refresh_token, user } = session;

    // Create or update the user's profile row
    await upsertProfile(
      user.id,
      user.email,
      user.user_metadata?.full_name,
      user.user_metadata?.avatar_url
    );

    // Set httpOnly session cookies
    setSessionCookies(res, access_token, refresh_token);

    return res.redirect(FRONTEND_URL + '/');
  } catch (err: any) {
    console.error('OAuth callback error:', err);
    try {
      const fs = require('fs');
      const path = require('path');
      const logFile = path.join(__dirname, '../../error_log.txt');
      const errDetails = {
        message: err?.message || 'No message',
        name: err?.name,
        stack: err?.stack,
        code: err?.code,
        details: err?.details,
        hint: err?.hint,
        status: err?.status,
        timestamp: new Date().toISOString()
      };
      fs.writeFileSync(logFile, JSON.stringify(errDetails, null, 2));
    } catch (logErr) {
      console.error('Failed to write error to log file:', logErr);
    }
    return res.redirect(`${FRONTEND_URL}/login?error=server_error&details=${encodeURIComponent(err?.message || 'unknown')}`);
  }
});

// ── GET /auth/me ────────────────────────────────────────
// Returns current user's profile + permissions.
// Frontend calls this on every app load to bootstrap auth state.

router.get('/me', verifyJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', req.userId!)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const { data: perms } = await supabase
      .from('user_permissions')
      .select('permission_key')
      .eq('user_id', req.userId!)
      .eq('granted', true);

    return res.json({
      ...profile,
      permissions: (perms ?? []).map((p) => p.permission_key),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: msg });
  }
});

// ── DELETE /auth/logout ─────────────────────────────────
// Clears session cookies and signs out from Supabase.

router.delete('/logout', verifyJWT, async (req: AuthenticatedRequest, res) => {
  // Best-effort sign-out from Supabase
  try {
    const token = req.signedCookies?.tm_access;
    if (token) {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          'apikey':        SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`,
        },
      });
    }
  } catch {
    // Non-fatal — we clear cookies regardless
  }

  clearSessionCookies(res);
  return res.json({ success: true });
});

export default router;
