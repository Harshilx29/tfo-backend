import { Hono } from 'hono';
import { getSupabase, Env } from '../lib/supabase';
import { requirePermission } from '../middleware/permission';
import { verifyJWT, AuthedContext } from '../middleware/auth';

type Vars = { userId?: string; profile?: any; tempAccess?: any };
const router = new Hono<{ Bindings: Env; Variables: Vars }>();
router.use('*', verifyJWT);

// GET /companies — list all
router.get('/', requirePermission('company.view'), async (c: AuthedContext) => {
  try {
    const supabase = getSupabase(c.env);
    const { data, error } = await supabase.from('companies').select('*').order('name', { ascending: true });
    if (error) {
      console.error('Error fetching companies:', error);
      return c.json({ error: 'Failed to fetch companies' }, 500);
    }
    return c.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /companies/dropdown — lightweight, any authenticated user
router.get('/dropdown', async (c: AuthedContext) => {
  try {
    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('companies')
      .select('id, name')
      .eq('show_in_dropdown', true)
      .order('name', { ascending: true });
    if (error) {
      console.error('Error fetching company dropdown:', error);
      return c.json({ error: 'Failed to fetch companies' }, 500);
    }
    return c.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /companies/:id
router.get('/:id', requirePermission('company.view'), async (c: AuthedContext) => {
  try {
    const id = c.req.param('id');
    const supabase = getSupabase(c.env);
    const { data, error } = await supabase.from('companies').select('*').eq('id', id).single();
    if (error) return c.json({ error: 'Company not found' }, 404);
    return c.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /companies/:id/batches
router.get('/:id/batches', requirePermission('company.view'), async (c: AuthedContext) => {
  try {
    const id = c.req.param('id');
    const supabase = getSupabase(c.env);
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .select('name')
      .eq('id', id)
      .single();
    if (companyError || !company) return c.json({ error: 'Company not found' }, 404);

    const { data: batches, error: batchesError } = await supabase
      .from('winding_details')
      .select('uid, date, yarn_type, lot_number')
      .or(`company.eq."${company.name}",company_id.eq.${id}`)
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

// POST /companies
router.post('/', requirePermission('company.manage'), async (c: AuthedContext) => {
  try {
    const body = await c.req.json();
    const { name, address, gst_number, phone_number, show_in_dropdown } = body;
    if (!name) return c.json({ error: 'Company name is required' }, 400);

    const supabase = getSupabase(c.env);
    if (gst_number) {
      const { data: existing } = await supabase.from('companies').select('id').eq('gst_number', gst_number).single();
      if (existing) return c.json({ error: 'A company with this GST number already exists' }, 400);
    }

    const { data, error } = await supabase
      .from('companies')
      .insert({
        name,
        address: address || null,
        gst_number: gst_number || null,
        phone_number: phone_number || null,
        show_in_dropdown: show_in_dropdown !== undefined ? show_in_dropdown : true,
      })
      .select()
      .single();
    if (error) {
      console.error('Error creating company:', error);
      return c.json({ error: 'Failed to create company' }, 500);
    }
    return c.json(data, 201);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// PUT /companies/:id
router.put('/:id', requirePermission('company.manage'), async (c: AuthedContext) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const { name, address, gst_number, phone_number, show_in_dropdown } = body;
    if (!name) return c.json({ error: 'Company name is required' }, 400);

    const supabase = getSupabase(c.env);
    if (gst_number) {
      const { data: existing } = await supabase
        .from('companies')
        .select('id')
        .eq('gst_number', gst_number)
        .neq('id', id)
        .single();
      if (existing) return c.json({ error: 'A company with this GST number already exists' }, 400);
    }

    const { data, error } = await supabase
      .from('companies')
      .update({
        name,
        address: address || null,
        gst_number: gst_number || null,
        phone_number: phone_number || null,
        show_in_dropdown: show_in_dropdown !== undefined ? show_in_dropdown : true,
      })
      .eq('id', id)
      .select()
      .single();
    if (error) {
      console.error('Error updating company:', error);
      return c.json({ error: 'Failed to update company' }, 500);
    }
    return c.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default router;
