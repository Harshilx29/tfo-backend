import { Hono } from 'hono';
import { getSupabase, Env } from '../lib/supabase';
import { verifyJWT, AuthedContext } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { z } from 'zod';

type Vars = { userId?: string; profile?: any; tempAccess?: any };
const router = new Hono<{ Bindings: Env; Variables: Vars }>();

router.use('*', verifyJWT);

// ── Zod schemas ──────────────────────────────────────────────
const confirmBodySchema = z.object({
  records: z.array(
    z.object({
      uid:         z.string().min(1).max(100).regex(/^[\w\-]+$/),
      file_number: z.string().min(1).max(50),
    })
  ).min(1).max(100),
});

// ── GET /batch-log/pending ───────────────────────────────────
// Fetch up to 80 pending rows where file_number IS NULL
router.get(
  '/pending',
  requirePermission('batchlog.view'),
  async (c: AuthedContext) => {
    try {
      const supabase = getSupabase(c.env);
      const { data, error } = await supabase
        .from('main')
        .select('id, uid, created_at')
        .or('file_number.is.null,file_number.eq.""')
        .order('created_at', { ascending: true })
        .limit(80);

      if (error) throw error;
      return c.json(data ?? []);
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  }
);

// ── GET /batch-log/next-paper-number?fileId=X ──────────────
// Re-derives true next paper number from DB for the specified fileId
router.get(
  '/next-paper-number',
  requirePermission('batchlog.view'),
  async (c: AuthedContext) => {
    try {
      const fileIdStr = (c.req.query('fileId') || '1').trim();
      const fileId = parseInt(fileIdStr, 10);
      if (isNaN(fileId) || fileId < 1) {
        return c.json({ error: 'Invalid fileId' }, 400);
      }

      const supabase = getSupabase(c.env);
      const { data, error } = await supabase
        .from('main')
        .select('file_number')
        .like('file_number', `${fileId}-%`);

      if (error) throw error;

      let maxNum = 0;
      if (data) {
        for (const row of data) {
          if (row.file_number) {
            const parts = row.file_number.split('-');
            if (parts.length === 2) {
              const num = parseInt(parts[1], 10);
              if (!isNaN(num) && num > maxNum) {
                maxNum = num;
              }
            }
          }
        }
      }

      return c.json({ fileId, nextPaperNumber: maxNum + 1 });
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  }
);

// ── POST /batch-log/confirm ──────────────────────────────────
// Conditional update: WHERE uid = $1 AND (file_number IS NULL OR file_number = '')
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
          // Conditional update: only succeeds if file_number is still null/empty
          const { data, error } = await supabase
            .from('main')
            .update({ file_number })
            .eq('uid', uid)
            .or('file_number.is.null,file_number.eq.""')
            .select('uid, file_number');

          if (error) {
            results.push({ uid, file_number, ok: false, error: error.message });
          } else if (!data || data.length === 0) {
            // Affected row count is 0 -> conflict
            results.push({
              uid,
              file_number,
              ok: false,
              error: 'Conflict: This batch has already been assigned or claimed by another device.',
            });
          } else {
            results.push({ uid, file_number, ok: true });
          }
        })
      );

      const failed = results.filter(r => !r.ok);
      if (failed.length > 0) {
        return c.json({ partial: failed.length < records.length, results }, 207);
      }
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

