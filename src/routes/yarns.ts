import { Hono } from 'hono';
import { getSupabase, Env } from '../lib/supabase';
import { requirePermission } from '../middleware/permission';
import { verifyJWT, AuthedContext } from '../middleware/auth';

type Vars = { userId?: string; profile?: any; tempAccess?: any };
const router = new Hono<{ Bindings: Env; Variables: Vars }>();
router.use('*', verifyJWT);

// GET /yarns
router.get('/', requirePermission('yarn.view'), async (c: AuthedContext) => {
  try {
    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('yarns')
      .select('*')
      .order('whole_name', { ascending: true });

    if (error) {
      console.error('Error fetching yarns:', error);
      return c.json({ error: 'Failed to fetch yarns' }, 500);
    }

    return c.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /yarns/dropdown
router.get('/dropdown', async (c: AuthedContext) => {
  try {
    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('yarns')
      .select('id, whole_name')
      .eq('show_in_dropdown', true)
      .order('whole_name', { ascending: true });

    if (error) {
      console.error('Error fetching yarn dropdown:', error);
      return c.json({ error: 'Failed to fetch yarns' }, 500);
    }

    return c.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /yarns/:id
router.get('/:id', requirePermission('yarn.view'), async (c: AuthedContext) => {
  try {
    const id = c.req.param('id');
    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('yarns')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      return c.json({ error: 'Yarn not found' }, 404);
    }

    return c.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /yarns/:id/batches
router.get('/:id/batches', requirePermission('yarn.view'), async (c: AuthedContext) => {
  try {
    const id = c.req.param('id');
    const supabase = getSupabase(c.env);

    // First get the yarn to know its whole_name
    const { data: yarn, error: yarnError } = await supabase
      .from('yarns')
      .select('whole_name')
      .eq('id', id)
      .single();

    if (yarnError || !yarn) {
      return c.json({ error: 'Yarn not found' }, 404);
    }

    // Query winding_details matching the name or yarn_id
    const { data: batches, error: batchesError } = await supabase
      .from('winding_details')
      .select('uid, date, company, lot_number')
      .or(`yarn_type.eq."${yarn.whole_name}",yarn_id.eq.${id}`)
      .order('date', { ascending: false });

    if (batchesError) {
      console.error('Error fetching associated batches:', batchesError);
      return c.json({ error: 'Failed to fetch batches' }, 500);
    }

    return c.json(batches);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /yarns
router.post('/', requirePermission('yarn.manage'), async (c: AuthedContext) => {
  try {
    const body = await c.req.json();
    const { denier, filament, colour, type, show_in_dropdown } = body;

    if (!denier || !filament || !type) {
      return c.json({ error: 'Denier, filament, and type are required' }, 400);
    }

    const validTypes = ['Nylon', 'Cat', 'Poly'];
    if (!validTypes.includes(type)) {
      return c.json({ error: `Type must be one of: ${validTypes.join(', ')}` }, 400);
    }

    if (typeof denier !== 'number' || denier <= 0) {
      return c.json({ error: 'Denier must be a positive number' }, 400);
    }

    if (typeof filament !== 'number' || filament <= 0) {
      return c.json({ error: 'Filament must be a positive number' }, 400);
    }

    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('yarns')
      .insert({
        denier,
        filament,
        colour: colour?.trim() || '',
        type,
        show_in_dropdown: show_in_dropdown !== undefined ? show_in_dropdown : true,
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating yarn:', error);
      return c.json({ error: 'Failed to create yarn' }, 500);
    }

    return c.json(data, 201);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// PUT /yarns/:id
router.put('/:id', requirePermission('yarn.manage'), async (c: AuthedContext) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const { denier, filament, colour, type, show_in_dropdown } = body;

    if (!denier || !filament || !type) {
      return c.json({ error: 'Denier, filament, and type are required' }, 400);
    }

    const validTypes = ['Nylon', 'Cat', 'Poly'];
    if (!validTypes.includes(type)) {
      return c.json({ error: `Type must be one of: ${validTypes.join(', ')}` }, 400);
    }

    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('yarns')
      .update({
        denier,
        filament,
        colour: colour?.trim() || '',
        type,
        show_in_dropdown: show_in_dropdown !== undefined ? show_in_dropdown : true,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating yarn:', error);
      return c.json({ error: 'Failed to update yarn' }, 500);
    }

    return c.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default router;
