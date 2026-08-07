import { Hono } from 'hono';
import { getSupabase, Env } from '../lib/supabase';
import { verifyJWT, AuthedContext } from '../middleware/auth';
import { requireAdmin, requirePermission } from '../middleware/permission';
import { userStatusBodySchema, permissionBodySchema, validateData } from '../lib/validators';

type Vars = { userId?: string; profile?: any; tempAccess?: any };
const router = new Hono<{ Bindings: Env; Variables: Vars }>();
router.use('*', verifyJWT);

// GET /users
router.get('/', requirePermission('user.manage'), async (c: AuthedContext) => {
  try {
    const supabase = getSupabase(c.env);
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

    return c.json(profilesWithPerms);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

// PATCH /users/:id/status
router.patch('/:id/status', requireAdmin(), async (c: AuthedContext) => {
  const id = c.req.param('id');
  const currentUserId = c.get('userId');

  try {
    const body = await c.req.json();
    const parsed = validateData(body, userStatusBodySchema);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.issues }, 400);
    }
    const { status } = parsed.data;

    // Prevent admin from demoting themselves
    if (id === currentUserId && status !== 'approved') {
      return c.json({ error: 'Cannot change your own status' }, 400);
    }

    const supabase = getSupabase(c.env);
    const update: Record<string, unknown> = { status };
    if (status === 'approved') {
      update.approved_at = new Date().toISOString();
      update.approved_by = currentUserId;
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
    return c.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

// GET /users/:id/permissions
router.get('/:id/permissions', requirePermission('user.manage'), async (c: AuthedContext) => {
  const id = c.req.param('id');
  try {
    const supabase = getSupabase(c.env);
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

    return c.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

// PATCH /users/:id/permissions/:key
router.patch('/:id/permissions/:key', requireAdmin(), async (c: AuthedContext) => {
  const id = c.req.param('id');
  const key = c.req.param('key');
  const currentUserId = c.get('userId');

  try {
    const body = await c.req.json();
    const parsed = validateData(body, permissionBodySchema);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.issues }, 400);
    }
    const { granted } = parsed.data;

    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('user_permissions')
      .upsert(
        {
          user_id: id,
          permission_key: key,
          granted: Boolean(granted),
          granted_by: currentUserId,
          granted_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,permission_key' }
      )
      .select()
      .single();

    if (error) throw error;
    return c.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

export default router;
