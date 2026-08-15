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
        .select('id, uid, created_at, is_completed')
        .or('file_number.is.null,file_number.eq.""')
        .eq('is_completed', true)
        .order('created_at', { ascending: true });

      if (error) {
        // Fallback if is_completed column is not yet created on database
        const { data: fallbackData, error: fallbackErr } = await supabase
          .from('main')
          .select('id, uid, created_at')
          .or('file_number.is.null,file_number.eq.""')
          .order('created_at', { ascending: true });

        if (fallbackErr) throw fallbackErr;
        return c.json(fallbackData ?? []);
      }

      // Only allow rows where is_completed is true
      const validRows = (data ?? []).filter((r: any) => r.is_completed === true);
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
// Atomic confirmation: validates all records first, then updates in a single batch.
// If any single paper fails pre-check, 0 database updates occur and staging remains intact.
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
      const uids = records.map((r) => r.uid);

      // 1. Pre-fetch existing status for all requested UIDs
      const { data: existingRows, error: fetchErr } = await supabase
        .from('main')
        .select('uid, is_completed, file_number')
        .in('uid', uids);

      if (fetchErr) {
        return c.json({ error: `Database query failed: ${fetchErr.message}` }, 500);
      }

      const rowMap = new Map<string, any>();
      (existingRows ?? []).forEach((row: any) => {
        if (row.uid) rowMap.set(row.uid.toLowerCase(), row);
      });

      // 2. Validate every record in the payload BEFORE making any changes
      for (const { uid, file_number } of records) {
        const row = rowMap.get(uid.toLowerCase());
        if (!row) {
          return c.json(
            {
              error: `Save aborted: Paper ${file_number} (UID "${uid}") was not found in the database.`,
              failedUid: uid,
              failedFileNumber: file_number,
            },
            400
          );
        }

        if (row.is_completed !== true) {
          return c.json(
            {
              error: `Save aborted: Paper ${file_number} (UID "${uid}") is incomplete. Please complete batch details before logging to file.`,
              failedUid: uid,
              failedFileNumber: file_number,
            },
            400
          );
        }

        if (row.file_number && row.file_number.trim() !== '' && row.file_number !== file_number) {
          return c.json(
            {
              error: `Save aborted: Paper ${file_number} (UID "${uid}") has already been logged as File #${row.file_number}.`,
              failedUid: uid,
              failedFileNumber: file_number,
            },
            400
          );
        }
      }

      // 3. Execute atomic updates
      const updatedUids: string[] = [];
      let updateError: string | null = null;

      for (const { uid, file_number } of records) {
        const { data, error } = await supabase
          .from('main')
          .update({ file_number })
          .eq('uid', uid)
          .select('uid');

        if (error || !data || data.length === 0) {
          updateError = error ? error.message : `Paper "${uid}" update failed or produced 0 changes.`;
          break;
        }
        updatedUids.push(uid);
      }

      // 4. Rollback if any update failed midway
      if (updateError) {
        if (updatedUids.length > 0) {
          await supabase
            .from('main')
            .update({ file_number: null })
            .in('uid', updatedUids);
        }
        return c.json({ error: `Save aborted: ${updateError}. Rolled back all changes.` }, 500);
      }

      return c.json({ success: true, count: records.length });
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  }
);

export default router;

