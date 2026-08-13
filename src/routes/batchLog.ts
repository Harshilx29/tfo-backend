import { Hono } from 'hono';
import { getSupabase, Env } from '../lib/supabase';
import { verifyJWT, AuthedContext } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { z } from 'zod';

type Vars = { userId?: string; profile?: any; tempAccess?: any };
const router = new Hono<{ Bindings: Env; Variables: Vars }>();

router.use('*', verifyJWT);

// ── Zod schema ───────────────────────────────────────────────
const confirmBodySchema = z.object({
  records: z.array(
    z.object({
      uid:         z.string().min(1).max(100).regex(/^[\w\-]+$/),
      file_number: z.string().min(1).max(50),
    })
  ).min(1).max(100),
});

// ── POST /batch-log/confirm ──────────────────────────────────
// Bulk-assigns file_number to main records.
router.post(
  '/confirm',
  requirePermission('batchlog.view'),
  async (c: AuthedContext) => {
    try {
      const body = await c.req.json();
      const parsed = confirmBodySchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'Validation failed', details: parsed.error.issues }, 400);
      }

      const supabase = getSupabase(c.env);
      const { records } = parsed.data;

      const results: { uid: string; file_number: string; ok: boolean; error?: string }[] = [];

      await Promise.all(
        records.map(async ({ uid, file_number }) => {
          const { data: existing } = await supabase
            .from('main')
            .select('uid')
            .eq('uid', uid)
            .maybeSingle();

          if (!existing) {
            results.push({ uid, file_number, ok: false, error: 'Batch not found' });
            return;
          }

          const { error } = await supabase
            .from('main')
            .update({ file_number })
            .eq('uid', uid);

          results.push(error
            ? { uid, file_number, ok: false, error: error.message }
            : { uid, file_number, ok: true }
          );
        })
      );

      const failed = results.filter(r => !r.ok);
      if (failed.length > 0) return c.json({ partial: true, results }, 207);
      return c.json({ success: true, results });
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  }
);

// ── GET /batch-log/recent ────────────────────────────────────
// Returns the 50 most recently file-numbered records.
router.get(
  '/recent',
  requirePermission('batchlog.view'),
  async (c: AuthedContext) => {
    try {
      const supabase = getSupabase(c.env);
      const { data, error } = await supabase
        .from('main')
        .select('uid, file_number, created_at')
        .not('file_number', 'is', null)
        .neq('file_number', '')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;
      return c.json(data ?? []);
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  }
);

export default router;
