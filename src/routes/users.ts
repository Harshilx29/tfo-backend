import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { verifyJWT, AuthenticatedRequest } from '../middleware/auth';
import { requireAdmin, requirePermission } from '../middleware/permission';
import { userStatusBodySchema, permissionBodySchema, validateBody } from '../lib/validators';

const router = Router();

// ── GET /users ─────────────────────────────────────────
// All profiles with their permission maps.
router.get(
  '/',
  verifyJWT,
  requirePermission('user.manage'),
  async (_req: AuthenticatedRequest, res) => {
    try {
      const { data: profiles, error } = await supabase
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      const { data: allPerms } = await supabase
        .from('user_permissions')
        .select('user_id, permission_key, granted');

      const profilesWithPerms = (profiles ?? []).map((p) => ({
        ...p,
        permissions: Object.fromEntries(
          (allPerms ?? [])
            .filter((perm) => perm.user_id === p.id)
            .map((perm) => [perm.permission_key, perm.granted])
        ),
      }));

      return res.json(profilesWithPerms);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return res.status(500).json({ error: msg });
    }
  }
);

// ── PATCH /users/:id/status ────────────────────────────
// Approve / suspend / reject a user.
router.patch(
  '/:id/status',
  verifyJWT,
  requireAdmin(),
  async (req: AuthenticatedRequest, res) => {
    const { id } = req.params;

    // Validate status via Zod (enum-safe, no manual array check needed)
    const body = validateBody(req, res, userStatusBodySchema);
    if (!body) return;
    const { status } = body;

    // Prevent admin from demoting themselves
    if (id === req.userId && status !== 'approved') {
      return res.status(400).json({ error: 'Cannot change your own status' });
    }

    try {
      const update: Record<string, unknown> = { status };
      if (status === 'approved') {
        update.approved_at = new Date().toISOString();
        update.approved_by = req.userId;
      } else {
        update.approved_at = null;
        update.approved_by = null;
      }

      const { data, error } = await supabase
        .from('profiles')
        .update(update)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return res.json(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return res.status(500).json({ error: msg });
    }
  }
);

// ── GET /users/:id/permissions ─────────────────────────
// All permissions from catalog, each annotated with granted flag.
router.get(
  '/:id/permissions',
  verifyJWT,
  requirePermission('user.manage'),
  async (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    try {
      const [{ data: catalog }, { data: userPerms }] = await Promise.all([
        supabase.from('permissions').select('*').order('category').order('key'),
        supabase
          .from('user_permissions')
          .select('permission_key, granted')
          .eq('user_id', id),
      ]);

      const result = (catalog ?? []).map((p) => ({
        ...p,
        granted:
          (userPerms ?? []).find((up) => up.permission_key === p.key)
            ?.granted ?? false,
      }));

      return res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return res.status(500).json({ error: msg });
    }
  }
);

// ── PATCH /users/:id/permissions/:key ─────────────────
// Toggle a single permission grant for a user.
router.patch(
  '/:id/permissions/:key',
  verifyJWT,
  requireAdmin(),
  async (req: AuthenticatedRequest, res) => {
    const { id, key } = req.params;

    // Validate granted is a boolean (rejects strings like '"true"', undefined, etc.)
    const body = validateBody(req, res, permissionBodySchema);
    if (!body) return;
    const { granted } = body;

    try {
      const { data, error } = await supabase
        .from('user_permissions')
        .upsert(
          {
            user_id: id,
            permission_key: key,
            granted: Boolean(granted),
            granted_by: req.userId,
            granted_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,permission_key' }
        )
        .select()
        .single();

      if (error) throw error;
      return res.json(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return res.status(500).json({ error: msg });
    }
  }
);

export default router;
