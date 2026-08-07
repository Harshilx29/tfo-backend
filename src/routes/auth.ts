import { Hono } from 'hono';
import { getSupabase, Env } from '../lib/supabase';
import { verifyJWT, setSessionCookies, clearSessionCookies, extractToken, AuthedContext } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimit';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';

type Vars = { userId?: string; profile?: any; tempAccess?: any };
const router = new Hono<{ Bindings: Env; Variables: Vars }>();

// ── PKCE helpers ────────────────────────────────────────
// Node's `crypto` module worked via nodejs_compat, but PKCE only needs
// random bytes + SHA-256, which the Workers-native Web Crypto API does
// directly — no compat shim required, so this part is a clean rewrite
// rather than a port.

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = btoa(String.fromCharCode(...arr));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64url(digest);
}

// ── Profile upsert (shared by callback) ─────────────────

async function upsertProfile(
  env: Env,
  userId: string,
  email: string,
  fullName?: string,
  avatarUrl?: string
) {
  const supabase = getSupabase(env);
  const adminEmail = (env.ADMIN_EMAIL || '').toLowerCase().trim();
  const isAdmin = adminEmail.length > 0 && email.toLowerCase().trim() === adminEmail;

  const { data: existing } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();

  if (!existing) {
    const { data, error } = await supabase
      .from('profiles')
      .insert({
        id: userId,
        email,
        full_name: fullName ?? null,
        avatar_url: avatarUrl ?? null,
        status: isAdmin ? 'approved' : 'pending',
        role: isAdmin ? 'admin' : 'user',
        approved_at: isAdmin ? new Date().toISOString() : null,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from('profiles')
    .update({
      full_name: fullName ?? existing.full_name,
      avatar_url: avatarUrl ?? existing.avatar_url,
    })
    .eq('id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── GET /auth/google ─────────────────────────────────

router.get('/google', authLimiter, async (c: AuthedContext) => {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const callbackUrl = `${c.env.BACKEND_URL}/auth/callback`;

  setCookie(c, 'tm_pkce', verifier, {
    httpOnly: true,
    maxAge: 5 * 60,
    sameSite: 'None',
    secure: true,
    path: '/',
  });

  const params = new URLSearchParams({
    provider: 'google',
    redirect_to: callbackUrl,
    code_challenge: challenge,
    code_challenge_method: 's256',
  });

  return c.redirect(`${c.env.SUPABASE_URL}/auth/v1/authorize?${params.toString()}`);
});

// ── GET /auth/callback ───────────────────────────────

router.get('/callback', authLimiter, async (c: AuthedContext) => {
  const code = c.req.query('code');
  const verifier = getCookie(c, 'tm_pkce');
  deleteCookie(c, 'tm_pkce', { path: '/' });

  if (!code || !verifier) {
    console.error('OAuth callback: missing code or PKCE verifier');
    return c.redirect(`${c.env.FRONTEND_URL}/login?error=auth_failed`);
  }

  try {
    const tokenRes = await fetch(`${c.env.SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: c.env.SUPABASE_ANON_KEY },
      body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
    });

    if (!tokenRes.ok) {
      console.error('PKCE token exchange failed:', await tokenRes.text());
      return c.redirect(`${c.env.FRONTEND_URL}/login?error=token_exchange_failed`);
    }

    const session = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      user: { id: string; email: string; user_metadata: { full_name?: string; avatar_url?: string } };
    };

    const { access_token, refresh_token, user } = session;
    await upsertProfile(c.env, user.id, user.email, user.user_metadata?.full_name, user.user_metadata?.avatar_url);
    setSessionCookies(c, access_token, refresh_token);

    return c.redirect(c.env.FRONTEND_URL + '/');
  } catch (err: any) {
    // No filesystem on Workers — `wrangler tail` / the dashboard Logs tab
    // replace the old error_log.txt file for debugging.
    console.error('OAuth callback error:', err?.message, err?.stack);
    return c.redirect(
      `${c.env.FRONTEND_URL}/login?error=server_error&details=${encodeURIComponent(err?.message || 'unknown')}`
    );
  }
});

// ── GET /auth/me ────────────────────────────────────────

router.get('/me', verifyJWT, async (c: AuthedContext) => {
  try {
    const supabase = getSupabase(c.env);
    const userId = c.get('userId')!;
    const { data: profile, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
    if (error || !profile) return c.json({ error: 'Profile not found' }, 404);

    const { data: perms } = await supabase
      .from('user_permissions')
      .select('permission_key')
      .eq('user_id', userId)
      .eq('granted', true);

    return c.json({ ...profile, permissions: (perms ?? []).map((p) => p.permission_key) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

// ── DELETE /auth/logout ─────────────────────────────────

router.delete('/logout', verifyJWT, async (c: AuthedContext) => {
  try {
    const token = extractToken(c);
    if (token) {
      await fetch(`${c.env.SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: c.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      });
    }
  } catch {
    // Non-fatal — clear cookies regardless.
  }
  clearSessionCookies(c);
  return c.json({ success: true });
});

export default router;
