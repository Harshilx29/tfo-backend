import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { requirePermission } from '../middleware/permission';
import { verifyJWT } from '../middleware/auth';

const router = Router();
router.use(verifyJWT);


// ==========================================
// GET /companies
// List all companies
// ==========================================
router.get('/', requirePermission('company.view'), async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('companies')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      console.error('Error fetching companies:', error);
      return res.status(500).json({ error: 'Failed to fetch companies' });
    }

    res.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// GET /companies/dropdown
// Lightweight endpoint for dropdown options (all authenticated users)
// ==========================================
router.get('/dropdown', async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('companies')
      .select('id, name')
      .eq('show_in_dropdown', true)
      .order('name', { ascending: true });

    if (error) {
      console.error('Error fetching company dropdown:', error);
      return res.status(500).json({ error: 'Failed to fetch companies' });
    }

    res.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// GET /companies/:id
// Get a single company by ID
// ==========================================
router.get('/:id', requirePermission('company.view'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('companies')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// GET /companies/:id/batches
// Get associated batches for a company
// ==========================================
router.get('/:id/batches', requirePermission('company.view'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // First get the company to know its name
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .select('name')
      .eq('id', id)
      .single();

    if (companyError || !company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Now query winding_details matching the name or company_id
    // We check both because historical data only has the name string, 
    // while new data will have the company_id.
    const { data: batches, error: batchesError } = await supabase
      .from('winding_details')
      .select('uid, date, yarn_type, lot_number')
      .or(`company.eq."${company.name}",company_id.eq.${id}`)
      .order('date', { ascending: false });

    if (batchesError) {
      console.error('Error fetching associated batches:', batchesError);
      return res.status(500).json({ error: 'Failed to fetch batches' });
    }

    res.json(batches);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// POST /companies
// Create a new company
// ==========================================
router.post('/', requirePermission('company.manage'), async (req: Request, res: Response) => {
  try {
    const { name, address, gst_number, phone_number, show_in_dropdown } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Company name is required' });
    }

    // Check GST uniqueness if provided
    if (gst_number) {
      const { data: existing } = await supabase
        .from('companies')
        .select('id')
        .eq('gst_number', gst_number)
        .single();
      
      if (existing) {
        return res.status(400).json({ error: 'A company with this GST number already exists' });
      }
    }

    const { data, error } = await supabase
      .from('companies')
      .insert({
        name,
        address: address || null,
        gst_number: gst_number || null,
        phone_number: phone_number || null,
        show_in_dropdown: show_in_dropdown !== undefined ? show_in_dropdown : true
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating company:', error);
      return res.status(500).json({ error: 'Failed to create company' });
    }

    res.status(201).json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// PUT /companies/:id
// Update an existing company
// ==========================================
router.put('/:id', requirePermission('company.manage'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, address, gst_number, phone_number, show_in_dropdown } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Company name is required' });
    }

    // Check GST uniqueness if provided (exclude current company)
    if (gst_number) {
      const { data: existing } = await supabase
        .from('companies')
        .select('id')
        .eq('gst_number', gst_number)
        .neq('id', id)
        .single();
      
      if (existing) {
        return res.status(400).json({ error: 'A company with this GST number already exists' });
      }
    }

    const { data, error } = await supabase
      .from('companies')
      .update({
        name,
        address: address || null,
        gst_number: gst_number || null,
        phone_number: phone_number || null,
        show_in_dropdown: show_in_dropdown !== undefined ? show_in_dropdown : true
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating company:', error);
      return res.status(500).json({ error: 'Failed to update company' });
    }

    res.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
