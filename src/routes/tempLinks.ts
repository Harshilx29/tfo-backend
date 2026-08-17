import { Hono } from 'hono';
import { getSupabase, Env } from '../lib/supabase';
import { verifyJWT, AuthedContext } from '../middleware/auth';
import { requireAdmin } from '../middleware/permission';
import { tempLinkLimiter } from '../middleware/rateLimit';
import { tempLinkCreateSchema, validateData } from '../lib/validators';

type Vars = { userId?: string; profile?: any; tempAccess?: any };
const router = new Hono<{ Bindings: Env; Variables: Vars }>();

// GET /temp-links/validate/:token
// PUBLIC — no auth. Called by frontend when a user opens an access link.
// Increments use_count and logs access on every valid call.
router.get('/validate/:token', tempLinkLimiter, async (c: AuthedContext) => {
  const token = c.req.param('token');
  const ua = (c.req.header('User-Agent') || '').substring(0, 500);
  const ip = c.req.header('CF-Connecting-IP') || '';

  try {
    const supabase = getSupabase(c.env);
    const { data: link, error } = await supabase
      .from('temp_access_links')
      .select('*')
      .eq('token', token)
      .eq('is_active', true)
      .single();

    if (error || !link) {
      return c.json({ error: 'Invalid or revoked link' }, 404);
    }

    if (new Date(link.expires_at) < new Date()) {
      return c.json({ error: 'Link has expired' }, 403);
    }

    if (link.max_uses !== null && link.use_count >= link.max_uses) {
      return c.json({ error: 'Link has reached its maximum uses' }, 403);
    }

    // Log and increment in parallel (best-effort, non-blocking)
    c.executionCtx.waitUntil(
      Promise.all([
        supabase.from('temp_access_logs').insert({
          link_id: link.id,
          ip_address: ip,
          user_agent: ua,
        }),
        supabase
          .from('temp_access_links')
          .update({ use_count: link.use_count + 1 })
          .eq('id', link.id),
      ])
    );

    return c.json({
      valid: true,
      allowed_pages: link.allowed_pages,
      label: link.label,
      expires_at: link.expires_at,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

// GET /temp-links
router.get('/', verifyJWT, requireAdmin(), async (c: AuthedContext) => {
  try {
    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('temp_access_links')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return c.json(data ?? []);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

// POST /temp-links
router.post('/', verifyJWT, requireAdmin(), async (c: AuthedContext) => {
  try {
    const body = await c.req.json();
    const parsed = validateData(body, tempLinkCreateSchema);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.issues }, 400);
    }

    const { label, expires_at, max_uses, allowed_pages } = parsed.data;
    const userId = c.get('userId');
    const supabase = getSupabase(c.env);

    // Generate a URL-safe token (32 hex chars) using native Web Crypto randomUUID
    const token = crypto.randomUUID().replace(/-/g, '');

    const { data, error } = await supabase
      .from('temp_access_links')
      .insert({
        token,
        label: label?.trim() || null,
        created_by: userId,
        allowed_pages: allowed_pages ?? ['dashboard', 'track', 'tfo_status', 'batch_log'],
        expires_at,
        max_uses: max_uses ?? null,
      })
      .select()
      .single();

    if (error) throw error;
    return c.json(data, 201);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

// DELETE /temp-links/:id
// Soft-delete (set is_active = false).
router.delete('/:id', verifyJWT, requireAdmin(), async (c: AuthedContext) => {
  const id = c.req.param('id');
  try {
    const supabase = getSupabase(c.env);
    const { error } = await supabase
      .from('temp_access_links')
      .update({ is_active: false })
      .eq('id', id);

    if (error) throw error;
    return c.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

export default router;
