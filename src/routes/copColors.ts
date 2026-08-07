import { Hono } from 'hono';
import { getSupabase, Env } from '../lib/supabase';
import { requirePermission } from '../middleware/permission';
import { verifyJWT, AuthedContext } from '../middleware/auth';

type Vars = { userId?: string; profile?: any; tempAccess?: any };
const router = new Hono<{ Bindings: Env; Variables: Vars }>();
router.use('*', verifyJWT);

// GET /cop-colors/dropdown
router.get('/dropdown', async (c: AuthedContext) => {
  try {
    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('cop_colors')
      .select('id, name, hex_code')
      .eq('show_in_dropdown', true)
      .order('name', { ascending: true });

    if (error) {
      console.error('Error fetching cop colors dropdown:', error);
      return c.json({ error: 'Failed to fetch cop colors' }, 500);
    }

    return c.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /cop-colors
router.get('/', requirePermission('cop.view'), async (c: AuthedContext) => {
  try {
    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('cop_colors')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      console.error('Error fetching cop colors:', error);
      return c.json({ error: 'Failed to fetch cop colors' }, 500);
    }

    return c.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /cop-colors/:id
router.get('/:id', requirePermission('cop.view'), async (c: AuthedContext) => {
  try {
    const id = c.req.param('id');
    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('cop_colors')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      return c.json({ error: 'Cop color not found' }, 404);
    }

    return c.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /cop-colors
router.post('/', requirePermission('cop.manage'), async (c: AuthedContext) => {
  try {
    const body = await c.req.json();
    const { name, hex_code, show_in_dropdown } = body;

    if (!name || !name.trim()) {
      return c.json({ error: 'Color name is required' }, 400);
    }

    if (!hex_code || !hex_code.trim()) {
      return c.json({ error: 'Hex code is required' }, 400);
    }

    let formattedHex = hex_code.trim();
    if (!formattedHex.startsWith('#')) {
      formattedHex = `#${formattedHex}`;
    }

    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('cop_colors')
      .insert({
        name: name.trim(),
        hex_code: formattedHex,
        show_in_dropdown: show_in_dropdown !== undefined ? show_in_dropdown : true,
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating cop color:', error);
      return c.json({ error: 'Failed to create cop color' }, 500);
    }

    return c.json(data, 201);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// PUT /cop-colors/:id
router.put('/:id', requirePermission('cop.manage'), async (c: AuthedContext) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const { name, hex_code, show_in_dropdown } = body;

    if (!name || !name.trim()) {
      return c.json({ error: 'Color name is required' }, 400);
    }

    if (!hex_code || !hex_code.trim()) {
      return c.json({ error: 'Hex code is required' }, 400);
    }

    let formattedHex = hex_code.trim();
    if (!formattedHex.startsWith('#')) {
      formattedHex = `#${formattedHex}`;
    }

    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('cop_colors')
      .update({
        name: name.trim(),
        hex_code: formattedHex,
        show_in_dropdown: show_in_dropdown !== undefined ? show_in_dropdown : true,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating cop color:', error);
      return c.json({ error: 'Failed to update cop color' }, 500);
    }

    return c.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// DELETE /cop-colors/:id
router.delete('/:id', requirePermission('cop.manage'), async (c: AuthedContext) => {
  try {
    const id = c.req.param('id');
    const supabase = getSupabase(c.env);
    const { error } = await supabase
      .from('cop_colors')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting cop color:', error);
      return c.json({ error: 'Failed to delete cop color' }, 500);
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default router;
