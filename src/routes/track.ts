import { Router } from 'express';
import { supabase } from '../lib/supabase';
import {
  verifyJWT,
  verifyJWTOrTemp,
  AuthenticatedRequest,
} from '../middleware/auth';
import { requirePermission, requireReadAccess } from '../middleware/permission';
import {
  uidSchema,
  windingBodySchema,
  tfoBodySchema,
  boilerBodySchema,
  warpingBodySchema,
  machineBodySchema,
  validateBody,
  validateParams,
} from '../lib/validators';

const router = Router();

// ── Helper: ensure main row exists for this uid ─────────
async function ensureMainExists(uid: string): Promise<void> {
  const { data: existing } = await supabase
    .from('main')
    .select('uid')
    .eq('uid', uid)
    .maybeSingle();

  if (!existing) {
    const { error } = await supabase.from('main').insert({ uid });
    if (error && error.code !== '23505') {
      // 23505 = unique_violation (race condition), safe to ignore
      throw error;
    }
  }
}

// ── GET /track/search?q=xxx ─────────────────────────────
// Search UIDs (for the search dropdown).
router.get(
  '/search',
  verifyJWTOrTemp,
  requireReadAccess('track', 'track.view'),
  async (req: AuthenticatedRequest, res) => {
    // Sanitize search query: strip to safe chars only, limit length
    const raw = ((req.query.q as string) || '').trim();
    const q = raw.replace(/[^\w\-\s]/g, '').substring(0, 100);
    try {
      let query = supabase
        .from('main')
        .select('uid, file_number, created_at')
        .order('created_at', { ascending: false })
        .limit(20);

      if (q) {
        query = query.ilike('uid', `%${q}%`);
      }

      const { data, error } = await query;
      if (error) throw error;
      return res.json(data ?? []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return res.status(500).json({ error: msg });
    }
  }
);

// ── GET /track/open-batches ─────────────────────────────
// Fetch all open batches (where file_number is empty) and join winding details.
router.get(
  '/open-batches',
  verifyJWTOrTemp,
  requireReadAccess('track', 'track.view'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { data, error } = await supabase
        .from('main')
        .select(`
          uid,
          created_at,
          file_number,
          winding:winding_details(yarn_type, company)
        `)
        .or('file_number.is.null,file_number.eq.""')
        .order('created_at', { ascending: false });

      if (error) throw error;
      return res.json(data ?? []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return res.status(500).json({ error: msg });
    }
  }
);

// ── GET /track/:uid ────────────────────────────────────
// Load all 5 stage records for one uid.
router.get(
  '/:uid',
  verifyJWTOrTemp,
  requireReadAccess('track', 'track.view'),
  async (req: AuthenticatedRequest, res) => {
    const uidParsed = uidSchema.safeParse(req.params.uid);
    if (!uidParsed.success) {
      return res.status(400).json({ error: 'Invalid UID', details: uidParsed.error.issues.map(i => i.message) });
    }
    const uid = uidParsed.data;
    if (!uid) return;
    try {
      const [
        { data: main },
        { data: winding },
        { data: tfo },
        { data: boiler },
        { data: warping },
        { data: machine },
      ] = await Promise.all([
        supabase.from('main').select('*').eq('uid', uid).maybeSingle(),
        supabase.from('winding_details').select('*').eq('uid', uid).maybeSingle(),
        supabase.from('tfo_details').select('*').eq('uid', uid).maybeSingle(),
        supabase.from('boiler_details').select('*').eq('uid', uid).maybeSingle(),
        supabase.from('warping').select('*').eq('uid', uid).maybeSingle(),
        supabase
          .from('machine_log')
          .select('*')
          .eq('uid', uid)
          .order('sr_no', { ascending: true }),
      ]);

      return res.json({
        main,
        winding,
        tfo,
        boiler,
        warping,
        machine: machine ?? [],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return res.status(500).json({ error: msg });
    }
  }
);

// ── PUT /track/:uid/winding ────────────────────────────
router.put(
  '/:uid/winding',
  verifyJWT,
  requirePermission('track.winding.save'),
  async (req: AuthenticatedRequest, res) => {
    const uidParsed = uidSchema.safeParse(req.params.uid);
    if (!uidParsed.success) {
      return res.status(400).json({ error: 'Invalid UID', details: uidParsed.error.issues.map(i => i.message) });
    }
    const uid = uidParsed.data;
    const body = validateBody(req, res, windingBodySchema);
    if (!body) return;
    try {
      await ensureMainExists(uid);

      const { id: _id, created_at: _ca, uid: _uid, ...rest } = body as any;

      // Validate Company if provided
      let validatedCompanyId: string | null = rest.company_id || null;
      let validatedCompanyName: string | null = rest.company || null;

      if (validatedCompanyId || (validatedCompanyName && validatedCompanyName.trim())) {
        let compRecord: { id: string; name: string } | null = null;

        if (validatedCompanyId) {
          const { data: byId } = await supabase
            .from('companies')
            .select('id, name')
            .eq('id', validatedCompanyId)
            .maybeSingle();
          if (byId) compRecord = byId;
        }

        if (!compRecord && validatedCompanyName && validatedCompanyName.trim()) {
          const { data: byName } = await supabase
            .from('companies')
            .select('id, name')
            .ilike('name', validatedCompanyName.trim())
            .maybeSingle();
          if (byName) compRecord = byName;
        }

        if (!compRecord) {
          return res.status(400).json({ error: 'No matching company found — please select from the list or add it in the Company page' });
        }

        validatedCompanyId = compRecord.id;
        validatedCompanyName = compRecord.name;
      }

      // Validate Yarn if provided
      let validatedYarnId: string | null = rest.yarn_id || null;
      let validatedYarnType: string | null = rest.yarn_type || null;

      if (validatedYarnId || (validatedYarnType && validatedYarnType.trim())) {
        let yarnRecord: { id: string; whole_name: string } | null = null;

        if (validatedYarnId) {
          const { data: byId } = await supabase
            .from('yarns')
            .select('id, whole_name')
            .eq('id', validatedYarnId)
            .maybeSingle();
          if (byId) yarnRecord = byId;
        }

        if (!yarnRecord && validatedYarnType && validatedYarnType.trim()) {
          const { data: byName } = await supabase
            .from('yarns')
            .select('id, whole_name')
            .ilike('whole_name', validatedYarnType.trim())
            .maybeSingle();
          if (byName) yarnRecord = byName;
        }

        if (!yarnRecord) {
          return res.status(400).json({ error: 'No matching yarn found — please select from the list or add it in the Yarn page' });
        }

        validatedYarnId = yarnRecord.id;
        validatedYarnType = yarnRecord.whole_name;
      }

      const updatePayload: Record<string, any> = { uid, ...rest };
      if (validatedCompanyName !== null || validatedCompanyId !== null) {
        updatePayload.company = validatedCompanyName;
        updatePayload.company_id = validatedCompanyId;
      }
      if (validatedYarnType !== null || validatedYarnId !== null) {
        updatePayload.yarn_type = validatedYarnType;
        updatePayload.yarn_id = validatedYarnId;
      }

      const { data, error } = await supabase
        .from('winding_details')
        .upsert(updatePayload, { onConflict: 'uid' })
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

// ── PUT /track/:uid/tfo ───────────────────────────────
router.put(
  '/:uid/tfo',
  verifyJWT,
  requirePermission('track.tfo.save'),
  async (req: AuthenticatedRequest, res) => {
    const uidParsed = uidSchema.safeParse(req.params.uid);
    if (!uidParsed.success) {
      return res.status(400).json({ error: 'Invalid UID', details: uidParsed.error.issues.map(i => i.message) });
    }
    const uid = uidParsed.data;
    const body = validateBody(req, res, tfoBodySchema);
    if (!body) return;
    try {
      await ensureMainExists(uid);

      const { id: _id, created_at: _ca, uid: _uid, ...rest } = body as any;
      const { data, error } = await supabase
        .from('tfo_details')
        .upsert({ uid, ...rest }, { onConflict: 'uid' })
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

// ── PUT /track/:uid/boiler ──────────────────────────────
router.put(
  '/:uid/boiler',
  verifyJWT,
  requirePermission('track.boiler.save'),
  async (req: AuthenticatedRequest, res) => {
    const uidParsed = uidSchema.safeParse(req.params.uid);
    if (!uidParsed.success) {
      return res.status(400).json({ error: 'Invalid UID', details: uidParsed.error.issues.map(i => i.message) });
    }
    const uid = uidParsed.data;
    const body = validateBody(req, res, boilerBodySchema);
    if (!body) return;
    try {
      await ensureMainExists(uid);

      const { id: _id, created_at: _ca, uid: _uid, ...rest } = body as any;
      const { data, error } = await supabase
        .from('boiler_details')
        .upsert({ uid, ...rest }, { onConflict: 'uid' })
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

// ── PUT /track/:uid/warping ──────────────────────────────
router.put(
  '/:uid/warping',
  verifyJWT,
  requirePermission('track.warping.save'),
  async (req: AuthenticatedRequest, res) => {
    const uidParsed = uidSchema.safeParse(req.params.uid);
    if (!uidParsed.success) {
      return res.status(400).json({ error: 'Invalid UID', details: uidParsed.error.issues.map(i => i.message) });
    }
    const uid = uidParsed.data;
    const body = validateBody(req, res, warpingBodySchema);
    if (!body) return;
    try {
      await ensureMainExists(uid);

      const { id: _id, created_at: _ca, uid: _uid, ...rest } = body as any;
      const { data, error } = await supabase
        .from('warping')
        .upsert({ uid, ...rest }, { onConflict: 'uid' })
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

// ── PUT /track/:uid/machine ──────────────────────────────
// Atomic replace via SECURITY DEFINER Postgres function.
router.put(
  '/:uid/machine',
  verifyJWT,
  requirePermission('track.machine.save'),
  async (req: AuthenticatedRequest, res) => {
    const uidParsed = uidSchema.safeParse(req.params.uid);
    if (!uidParsed.success) {
      return res.status(400).json({ error: 'Invalid UID', details: uidParsed.error.issues.map(i => i.message) });
    }
    const uid = uidParsed.data;
    const body = validateBody(req, res, machineBodySchema);
    if (!body) return;
    const rows = body.rows;

    try {
      await ensureMainExists(uid);

      const cleanRows = rows.map((r, idx) => ({
        sr_no: r.sr_no ?? idx + 1,
        date_and_time: r.date_and_time || null,
        company: r.company || null,
        cops: r.cops !== undefined && r.cops !== null ? Number(r.cops) : null,
        name: r.name || null,
      }));

      const { data, error } = await supabase.rpc('replace_machine_log', {
        p_uid: uid,
        p_rows: cleanRows,
      });

      if (error) throw error;
      return res.json(data ?? []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return res.status(500).json({ error: msg });
    }
  }
);

// ── DELETE /track/:uid/machine/:rowId ──────────────────
router.delete(
  '/:uid/machine/:rowId',
  verifyJWT,
  requirePermission('track.machine.delete_row'),
  async (_req: AuthenticatedRequest, res) => {
    const { rowId } = _req.params;
    // Validate rowId is a safe integer to prevent injection via parseInt
    const rowIdNum = parseInt(rowId, 10);
    if (isNaN(rowIdNum) || rowIdNum <= 0) {
      return res.status(400).json({ error: 'Invalid row ID' });
    }
    try {
      const { error } = await supabase
        .from('machine_log')
        .delete()
        .eq('id', rowIdNum);

      if (error) throw error;
      return res.json({ success: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return res.status(500).json({ error: msg });
    }
  }
);

export default router;
