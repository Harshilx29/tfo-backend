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
// Fetch all pending rows where file_number IS NULL and is_completed IS TRUE
router.get(
  '/pending',
  requirePermission('batchlog.view'),
  async (c: AuthedContext) => {
    try {
      const supabase = getSupabase(c.env);

      // Select rows where file_number is null/empty and batch is completed
      const { data, error } = await supabase
        .from('main')
        .select('id, uid, created_at, is_completed, confirmed')
        .or('file_number.is.null,file_number.eq.""')
        .eq('is_completed', true)
        .order('created_at', { ascending: true });

      if (error) {
        // Fallback if columns are not yet created on database
        const { data: fallbackData, error: fallbackErr } = await supabase
          .from('main')
          .select('id, uid, created_at')
          .or('file_number.is.null,file_number.eq.""')
          .order('created_at', { ascending: true });

        if (fallbackErr) throw fallbackErr;
        return c.json(fallbackData ?? []);
      }

      // Only allow rows where confirmed is true (or not false) and is_completed is true
      const validRows = (data ?? []).filter((r: any) => r.confirmed !== false && r.is_completed === true);
      return c.json(validRows);
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
// Conditional update: WHERE uid = $1 AND is_completed = true AND (file_number IS NULL OR file_number = '')
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
          // Conditional update: only succeeds if batch is completed and file_number is still null/empty
          const { data, error } = await supabase
            .from('main')
            .update({ file_number })
            .eq('uid', uid)
            .eq('is_completed', true)
            .or('file_number.is.null,file_number.eq.""')
            .select('uid, file_number');

          if (error) {
            const isUniqueViolation =
              error.code === '23505' ||
              (error.message &&
                (error.message.toLowerCase().includes('unique') ||
                 error.message.toLowerCase().includes('duplicate') ||
                 error.message.includes('23505')));

            if (isUniqueViolation) {
              results.push({
                uid,
                file_number,
                ok: false,
                error: `Conflict: Label "${file_number}" was claimed by another device at the same time.`,
              });
            } else {
              results.push({ uid, file_number, ok: false, error: error.message });
            }
          } else if (!data || data.length === 0) {
            // Affected row count is 0 -> conflict (already claimed)
            results.push({
              uid,
              file_number,
              ok: false,
              error: `Conflict: Paper "${uid}" was already claimed or updated by another device.`,
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

export default router;

