import { Hono } from 'hono';
import { getSupabase, Env } from '../lib/supabase';
import { verifyJWT, verifyJWTOrTemp, AuthedContext } from '../middleware/auth';
import { requirePermission, requireReadAccess } from '../middleware/permission';
import {
  uidSchema,
  windingBodySchema,
  tfoBodySchema,
  boilerBodySchema,
  warpingBodySchema,
  machineBodySchema,
  validateData,
} from '../lib/validators';

type Vars = { userId?: string; profile?: any; tempAccess?: any };
const router = new Hono<{ Bindings: Env; Variables: Vars }>();

// ── Helper: ensure main row exists for this uid ─────────
async function ensureMainExists(c: AuthedContext, uid: string): Promise<void> {
  const supabase = getSupabase(c.env);
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
  async (c: AuthedContext) => {
    const raw = (c.req.query('q') || '').trim();
    const q = raw.replace(/[^\w\-\s]/g, '').substring(0, 100);
    try {
      const supabase = getSupabase(c.env);
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
      return c.json(data ?? []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: msg }, 500);
    }
  }
);

// ── GET /track/open-batches ─────────────────────────────
// Fetch all open batches (where file_number is empty) and join winding details.
router.get(
  '/open-batches',
  verifyJWTOrTemp,
  requireReadAccess('track', 'track.view'),
  async (c: AuthedContext) => {
    try {
      const supabase = getSupabase(c.env);
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
      return c.json(data ?? []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: msg }, 500);
    }
  }
);

// ── GET /track/:uid ────────────────────────────────────
// Load all 5 stage records for one uid.
router.get(
  '/:uid',
  verifyJWTOrTemp,
  requireReadAccess('track', 'track.view'),
  async (c: AuthedContext) => {
    const uidParam = c.req.param('uid');
    const uidParsed = uidSchema.safeParse(uidParam);
    if (!uidParsed.success) {
      return c.json({ error: 'Invalid UID', details: uidParsed.error.issues.map(i => i.message) }, 400);
    }
    const uid = uidParsed.data;
    if (!uid) return c.json({ error: 'Invalid UID' }, 400);

    try {
      const supabase = getSupabase(c.env);
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

      return c.json({
        main,
        winding,
        tfo,
        boiler,
        warping,
        machine: machine ?? [],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: msg }, 500);
    }
  }
);

// ── PUT /track/:uid/winding ────────────────────────────
router.put(
  '/:uid/winding',
  verifyJWT,
  requirePermission('track.section1.write', 'track.section1.update', 'track.winding.save'),
  async (c: AuthedContext) => {
    const uidParam = c.req.param('uid');
    const uidParsed = uidSchema.safeParse(uidParam);
    if (!uidParsed.success) {
      return c.json({ error: 'Invalid UID', details: uidParsed.error.issues.map(i => i.message) }, 400);
    }
    const uid = uidParsed.data;
    if (!uid) return c.json({ error: 'Invalid UID' }, 400);

    try {
      const body = await c.req.json();
      const parsed = validateData(body, windingBodySchema);
      if (!parsed.success) {
        return c.json({ error: 'Validation failed', details: parsed.issues }, 400);
      }
      const validatedBody = parsed.data;

      const supabase = getSupabase(c.env);
      await ensureMainExists(c, uid);

      const { id: _id, created_at: _ca, uid: _uid, ...rest } = validatedBody as any;

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
          return c.json({ error: 'No matching company found — please select from the list or add it in the Company page' }, 400);
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
          return c.json({ error: 'No matching yarn found — please select from the list or add it in the Yarn page' }, 400);
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
      return c.json(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: msg }, 500);
    }
  }
);

// ── PUT /track/:uid/tfo ───────────────────────────────
router.put(
  '/:uid/tfo',
  verifyJWT,
  requirePermission('track.section1.write', 'track.section1.update', 'track.tfo.save'),
  async (c: AuthedContext) => {
    const uidParam = c.req.param('uid');
    const uidParsed = uidSchema.safeParse(uidParam);
    if (!uidParsed.success) {
      return c.json({ error: 'Invalid UID', details: uidParsed.error.issues.map(i => i.message) }, 400);
    }
    const uid = uidParsed.data;
    if (!uid) return c.json({ error: 'Invalid UID' }, 400);

    try {
      const body = await c.req.json();
      const parsed = validateData(body, tfoBodySchema);
      if (!parsed.success) {
        return c.json({ error: 'Validation failed', details: parsed.issues }, 400);
      }
      const validatedBody = parsed.data;

      const supabase = getSupabase(c.env);
      await ensureMainExists(c, uid);

      const { id: _id, created_at: _ca, uid: _uid, ...rest } = validatedBody as any;

      // ── Machine occupancy logic ────────────────────────────
      const incomingMachineNo: number | null = rest.tfo_no ?? null;
      const incomingLoadDate: string | null  = rest.loading_date   ?? null;
      const incomingUnloadDate: string | null = rest.unloading_date ?? null;

      let targetMachineId: string | null = null;

      if (incomingMachineNo !== null) {
        // Fetch the machine record
        const { data: machine, error: machineErr } = await supabase
          .from('machines')
          .select('id, occupancy_status, enabled')
          .eq('machine_number', incomingMachineNo)
          .single();

        if (machineErr || !machine) {
          return c.json({
            error: `Machine ${incomingMachineNo} not found in the registry. Please add it via the Machine Management page.`,
          }, 400);
        }

        // Always attach machine_id FK whenever tfo_no is specified
        rest.machine_id = machine.id;
        targetMachineId = machine.id;
      }

      // If machine_id not in payload, check existing record for this UID
      if (!targetMachineId) {
        const { data: existingTfo } = await supabase
          .from('tfo_details')
          .select('machine_id, loading_date, unloading_date')
          .eq('uid', uid)
          .maybeSingle();
        if (existingTfo?.machine_id) {
          targetMachineId = existingTfo.machine_id;
        }
      }

      // Upsert into tfo_details
      const { data, error } = await supabase
        .from('tfo_details')
        .upsert({ uid, ...rest }, { onConflict: 'uid' })
        .select()
        .single();

      if (error) {
        if (error.code === '23505' || error.message?.includes('idx_tfo_one_open_batch_per_machine')) {
          return c.json({
            error: `Machine ${incomingMachineNo || 'selected'} is currently loaded with another active batch. Unload the active batch before loading a new one.`,
          }, 409);
        }
        throw error;
      }

      // App-level fail-safe sync for machines.occupancy_status
      if (targetMachineId) {
        const finalLoadDate = incomingLoadDate ?? data?.loading_date ?? null;
        const finalUnloadDate = incomingUnloadDate ?? data?.unloading_date ?? null;
        const newStatus = (finalLoadDate && !finalUnloadDate) ? 'loaded' : 'free';

        await supabase
          .from('machines')
          .update({ occupancy_status: newStatus })
          .eq('id', targetMachineId);
      }

      return c.json(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: msg }, 500);
    }
  }
);

// ── PUT /track/:uid/boiler ──────────────────────────────
router.put(
  '/:uid/boiler',
  verifyJWT,
  requirePermission('track.section1.write', 'track.section1.update', 'track.boiler.save'),
  async (c: AuthedContext) => {
    const uidParam = c.req.param('uid');
    const uidParsed = uidSchema.safeParse(uidParam);
    if (!uidParsed.success) {
      return c.json({ error: 'Invalid UID', details: uidParsed.error.issues.map(i => i.message) }, 400);
    }
    const uid = uidParsed.data;
    if (!uid) return c.json({ error: 'Invalid UID' }, 400);

    try {
      const body = await c.req.json();
      const parsed = validateData(body, boilerBodySchema);
      if (!parsed.success) {
        return c.json({ error: 'Validation failed', details: parsed.issues }, 400);
      }
      const validatedBody = parsed.data;

      const supabase = getSupabase(c.env);
      await ensureMainExists(c, uid);

      const { id: _id, created_at: _ca, uid: _uid, ...rest } = validatedBody as any;

      // ── Merge separate date + time → "date and time" column ─
      if ('date' in rest || 'time' in rest) {
        const dateStr = (rest.date as string | null) || null;
        const timeStr = (rest.time as string | null) || '00:00';

        if (dateStr) {
          rest['date and time'] = new Date(`${dateStr}T${timeStr}`).toISOString();
        } else {
          rest['date and time'] = null;
        }
        delete rest.date;
        delete rest.time;
      }
      // ─────────────────────────────────────────────────────────

      const { data, error } = await supabase
        .from('boiler_details')
        .upsert({ uid, ...rest }, { onConflict: 'uid' })
        .select()
        .single();

      if (error) throw error;
      return c.json(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: msg }, 500);
    }
  }
);

// ── PUT /track/:uid/warping ──────────────────────────────
router.put(
  '/:uid/warping',
  verifyJWT,
  requirePermission('track.section2.write', 'track.section2.update', 'track.warping.save'),
  async (c: AuthedContext) => {
    const uidParam = c.req.param('uid');
    const uidParsed = uidSchema.safeParse(uidParam);
    if (!uidParsed.success) {
      return c.json({ error: 'Invalid UID', details: uidParsed.error.issues.map(i => i.message) }, 400);
    }
    const uid = uidParsed.data;
    if (!uid) return c.json({ error: 'Invalid UID' }, 400);

    try {
      const body = await c.req.json();
      const parsed = validateData(body, warpingBodySchema);
      if (!parsed.success) {
        return c.json({ error: 'Validation failed', details: parsed.issues }, 400);
      }
      const validatedBody = parsed.data;

      const supabase = getSupabase(c.env);
      await ensureMainExists(c, uid);

      const { id: _id, created_at: _ca, uid: _uid, ...rest } = validatedBody as any;
      const { data, error } = await supabase
        .from('warping')
        .upsert({ uid, ...rest }, { onConflict: 'uid' })
        .select()
        .single();

      if (error) throw error;

      // Automatically mark batch as completed in main table upon Warping submit
      await supabase
        .from('main')
        .update({ is_completed: true })
        .eq('uid', uid);

      return c.json(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: msg }, 500);
    }
  }
);

// ── PUT /track/:uid/complete ───────────────────────────
router.put(
  '/:uid/complete',
  verifyJWT,
  requirePermission('track.section2.write', 'track.section2.update'),
  async (c: AuthedContext) => {
    const uidParam = c.req.param('uid');
    const uidParsed = uidSchema.safeParse(uidParam);
    if (!uidParsed.success) {
      return c.json({ error: 'Invalid UID', details: uidParsed.error.issues.map(i => i.message) }, 400);
    }
    const uid = uidParsed.data;
    if (!uid) return c.json({ error: 'Invalid UID' }, 400);

    try {
      const supabase = getSupabase(c.env);
      await ensureMainExists(c, uid);

      const [{ data: boiler }, { data: tfo }, { data: machine }, { data: warping }] = await Promise.all([
        supabase.from('boiler_details').select('cops').eq('uid', uid).maybeSingle(),
        supabase.from('tfo_details').select('cops').eq('uid', uid).maybeSingle(),
        supabase.from('machine_log').select('cops').eq('uid', uid),
        supabase.from('warping').select('id').eq('uid', uid).maybeSingle(),
      ]);

      const targetCops = Number(boiler?.cops) || Number(tfo?.cops) || 0;
      const totalMachineCops = (machine || []).reduce((sum: number, r: any) => sum + (Number(r.cops) || 0), 0);

      const isWarpingDone = !!warping;
      const isMachineDone = targetCops > 0 && totalMachineCops === targetCops;

      if (!isWarpingDone && !isMachineDone) {
        return c.json({
          error: `Cannot complete batch: Total cops used in Machine Matrix (${totalMachineCops}) does not equal total COPs in Boiler (${targetCops}).`,
        }, 400);
      }

      const { data, error } = await supabase
        .from('main')
        .update({ is_completed: true })
        .eq('uid', uid)
        .select()
        .single();

      if (error) throw error;
      return c.json({ success: true, main: data });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: msg }, 500);
    }
  }
);

// ── PUT /track/:uid/machine ──────────────────────────────
router.put(
  '/:uid/machine',
  verifyJWT,
  requirePermission('track.section2.write', 'track.section2.update', 'track.machine.save'),
  async (c: AuthedContext) => {
    const uidParam = c.req.param('uid');
    const uidParsed = uidSchema.safeParse(uidParam);
    if (!uidParsed.success) {
      return c.json({ error: 'Invalid UID', details: uidParsed.error.issues.map(i => i.message) }, 400);
    }
    const uid = uidParsed.data;
    if (!uid) return c.json({ error: 'Invalid UID' }, 400);

    try {
      const body = await c.req.json();
      const parsed = validateData(body, machineBodySchema);
      if (!parsed.success) {
        return c.json({ error: 'Validation failed', details: parsed.issues }, 400);
      }
      const { rows } = parsed.data;

      const supabase = getSupabase(c.env);
      await ensureMainExists(c, uid);

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
      return c.json(data ?? []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: msg }, 500);
    }
  }
);

// ── DELETE /track/:uid/machine/:rowId ──────────────────
router.delete(
  '/:uid/machine/:rowId',
  verifyJWT,
  requirePermission('track.section2.write', 'track.section2.update', 'track.machine.delete_row'),
  async (c: AuthedContext) => {
    const rowId = c.req.param('rowId');
    const rowIdNum = parseInt(rowId || '', 10);
    if (isNaN(rowIdNum) || rowIdNum <= 0) {
      return c.json({ error: 'Invalid row ID' }, 400);
    }

    try {
      const supabase = getSupabase(c.env);
      const { error } = await supabase
        .from('machine_log')
        .delete()
        .eq('id', rowIdNum);

      if (error) throw error;
      return c.json({ success: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: msg }, 500);
    }
  }
);

export default router;
