import { Hono } from 'hono';
import { getSupabase, Env } from '../lib/supabase';
import { requirePermission } from '../middleware/permission';
import { verifyJWT, AuthedContext } from '../middleware/auth';
import { machineCreateSchema, machineUpdateSchema, validateData } from '../lib/validators';

type Vars = { userId?: string; profile?: any; tempAccess?: any };
const router = new Hono<{ Bindings: Env; Variables: Vars }>();
router.use('*', verifyJWT);

// GET /machines/dropdown?onlyFree=true
router.get('/dropdown', async (c: AuthedContext) => {
  try {
    const onlyFree = c.req.query('onlyFree') === 'true';
    const supabase = getSupabase(c.env);

    let query = supabase
      .from('machines')
      .select('id, machine_number, occupancy_status')
      .eq('enabled', true)
      .order('machine_number', { ascending: true });

    if (onlyFree) {
      query = query.eq('occupancy_status', 'free');
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching machines dropdown:', error);
      return c.json({ error: 'Failed to fetch machines' }, 500);
    }

    return c.json(data ?? []);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Helper to format enriched machine object with active_batch details
export function formatEnrichedMachine(row: any) {
  if (!row) return null;
  const activeTfoList = row.tfo_details || [];
  const activeTfo = Array.isArray(activeTfoList) ? activeTfoList[0] : activeTfoList;

  const { tfo_details: _, ...machineData } = row;

  return {
    ...machineData,
    active_batch: activeTfo
      ? {
          uid: activeTfo.uid,
          tpm: activeTfo.tpm ?? null,
          loading_date: activeTfo.loading_date ?? null,
          color_s: activeTfo.cop_color_s
            ? { name: activeTfo.cop_color_s.name, hex_code: activeTfo.cop_color_s.hex_code }
            : activeTfo.color_s ? { name: activeTfo.color_s, hex_code: null } : null,
          color_z: activeTfo.cop_color_z
            ? { name: activeTfo.cop_color_z.name, hex_code: activeTfo.cop_color_z.hex_code }
            : activeTfo.color_z ? { name: activeTfo.color_z, hex_code: null } : null,
        }
      : null,
  };
}

// GET /machines
router.get('/', requirePermission('machine.view'), async (c: AuthedContext) => {
  try {
    const supabase = getSupabase(c.env);
    const { data: rows, error } = await (supabase
      .from('machines')
      .select(`
        *,
        tfo_details!tfo_details_machine_id_fkey!left(
          uid,
          tpm,
          loading_date,
          color_s,
          color_z,
          cop_color_s:cop_colors!tfo_details_color_s_id_fkey!left(id, name, hex_code),
          cop_color_z:cop_colors!tfo_details_color_z_id_fkey!left(id, name, hex_code)
        )
      ` as any)
      .is('tfo_details.unloading_date', null)
      .order('machine_number', { ascending: true }) as any);

    if (error) {
      console.error('Error fetching enriched machines:', error);
      return c.json({ error: 'Failed to fetch machines' }, 500);
    }

    const enriched = (rows ?? []).map(formatEnrichedMachine);
    return c.json(enriched);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /machines
router.post('/', requirePermission('machine.manage'), async (c: AuthedContext) => {
  try {
    const body = await c.req.json();
    const parsed = validateData(body, machineCreateSchema);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.issues }, 400);
    }
    const validatedBody = parsed.data;

    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('machines')
      .insert({
        machine_number: validatedBody.machine_number,
        max_capacity:   validatedBody.max_capacity   ?? null,
        vendor_name:    validatedBody.vendor_name    ?? null,
        vendor_phone:   validatedBody.vendor_phone   ?? null,
        purchase_date:  validatedBody.purchase_date  ?? null,
        enabled:        validatedBody.enabled        !== undefined ? validatedBody.enabled : true,
        occupancy_status: 'free',
      })
      .select()
      .single();

    if (error) {
      // Postgres unique violation on machine_number
      if (error.code === '23505') {
        return c.json({ error: `Machine number ${validatedBody.machine_number} already exists` }, 409);
      }
      console.error('Error creating machine:', error);
      return c.json({ error: 'Failed to create machine' }, 500);
    }

    return c.json(data, 201);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// PUT /machines/:id
router.put('/:id', requirePermission('machine.manage'), async (c: AuthedContext) => {
  const id = c.req.param('id');
  try {
    const body = await c.req.json();
    const parsed = validateData(body, machineUpdateSchema);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.issues }, 400);
    }
    const validatedBody = parsed.data;

    // Build update object — only include fields that were sent
    const updatePayload: Record<string, unknown> = {};
    if (validatedBody.machine_number !== undefined) updatePayload.machine_number = validatedBody.machine_number;
    if (validatedBody.max_capacity   !== undefined) updatePayload.max_capacity   = validatedBody.max_capacity;
    if (validatedBody.vendor_name    !== undefined) updatePayload.vendor_name    = validatedBody.vendor_name;
    if (validatedBody.vendor_phone   !== undefined) updatePayload.vendor_phone   = validatedBody.vendor_phone;
    if (validatedBody.purchase_date  !== undefined) updatePayload.purchase_date  = validatedBody.purchase_date;
    if (validatedBody.enabled        !== undefined) updatePayload.enabled        = validatedBody.enabled;

    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('machines')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return c.json({ error: `Machine number ${validatedBody.machine_number} already exists` }, 409);
      }
      console.error('Error updating machine:', error);
      return c.json({ error: 'Failed to update machine' }, 500);
    }

    return c.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default router;
