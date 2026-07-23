import { Router, Request } from 'express';
import { supabase } from '../lib/supabase';
import { verifyJWT, AuthenticatedRequest } from '../middleware/auth';
import { requireAdmin } from '../middleware/permission';
import { v4 as uuidv4 } from 'uuid';
import { tempLinkLimiter } from '../middleware/rateLimit';
import { tempLinkCreateSchema, validateBody } from '../lib/validators';

const router = Router();

// ── GET /temp-links/validate/:token ─────────────────────────
// PUBLIC — no auth. Called by frontend when a user opens an access link.
// Increments use_count and logs access on every valid call.
// tempLinkLimiter: 20 attempts per 5 min per IP — prevents token brute-force.
router.get('/validate/:token', tempLinkLimiter, async (req: Request, res) => {
  const { token } = req.params;
  const ua = (req.headers['user-agent'] || '').substring(0, 500);
  const ip =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    '';

  try {
    const { data: link, error } = await supabase
      .from('temp_access_links')
      .select('*')
      .eq('token', token)
      .eq('is_active', true)
      .single();

    if (error || !link) {
      return res.status(404).json({ error: 'Invalid or revoked link' });
    }

    if (new Date(link.expires_at) < new Date()) {
      return res.status(403).json({ error: 'Link has expired' });
    }

    if (link.max_uses !== null && link.use_count >= link.max_uses) {
      return res.status(403).json({ error: 'Link has reached its maximum uses' });
    }

    // Log and increment in parallel (best-effort, non-blocking)
    void Promise.all([
      supabase.from('temp_access_logs').insert({
        link_id: link.id,
        ip_address: ip,
        user_agent: ua,
      }),
      supabase
        .from('temp_access_links')
        .update({ use_count: link.use_count + 1 })
        .eq('id', link.id),
    ]);

    return res.json({
      valid: true,
      allowed_pages: link.allowed_pages,
      label: link.label,
      expires_at: link.expires_at,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: msg });
  }
});

// ── GET /temp-links ────────────────────────────────────
router.get('/', verifyJWT, requireAdmin(), async (_req: AuthenticatedRequest, res) => {
  try {
    const { data, error } = await supabase
      .from('temp_access_links')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data ?? []);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: msg });
  }
});

// ── POST /temp-links ───────────────────────────────────
router.post('/', verifyJWT, requireAdmin(), async (req: AuthenticatedRequest, res) => {
  // Zod validates: expires_at is ISO datetime + in future, max_uses is positive int,
  // allowed_pages only contains known page names, label max 200 chars
  const body = validateBody(req, res, tempLinkCreateSchema);
  if (!body) return;

  const { label, expires_at, max_uses, allowed_pages } = body;

  try {
    // Generate a URL-safe token (32 hex chars)
    const token = uuidv4().replace(/-/g, '');

    const { data, error } = await supabase
      .from('temp_access_links')
      .insert({
        token,
        label: label?.trim() || null,
        created_by: req.userId,
        allowed_pages: allowed_pages ?? ['dashboard', 'track'],
        expires_at,
        max_uses: max_uses ?? null,
      })
      .select()
      .single();

    if (error) throw error;
    return res.status(201).json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: msg });
  }
});

// ── DELETE /temp-links/:id ─────────────────────────────
// Soft-delete (set is_active = false).
router.delete('/:id', verifyJWT, requireAdmin(), async (req: AuthenticatedRequest, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase
      .from('temp_access_links')
      .update({ is_active: false })
      .eq('id', id);

    if (error) throw error;
    return res.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: msg });
  }
});

export default router;
