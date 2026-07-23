import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { requirePermission } from '../middleware/permission';
import { verifyJWT } from '../middleware/auth';

const router = Router();
router.use(verifyJWT);

// ==========================================
// GET /yarns
// List all yarns
// ==========================================
router.get('/', requirePermission('yarn.view'), async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('yarns')
      .select('*')
      .order('whole_name', { ascending: true });

    if (error) {
      console.error('Error fetching yarns:', error);
      return res.status(500).json({ error: 'Failed to fetch yarns' });
    }

    res.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// GET /yarns/dropdown
// Lightweight endpoint for dropdown options (all authenticated users)
// ==========================================
router.get('/dropdown', async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('yarns')
      .select('id, whole_name')
      .eq('show_in_dropdown', true)
      .order('whole_name', { ascending: true });

    if (error) {
      console.error('Error fetching yarn dropdown:', error);
      return res.status(500).json({ error: 'Failed to fetch yarns' });
    }

    res.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// GET /yarns/:id
// Get a single yarn by ID
// ==========================================
router.get('/:id', requirePermission('yarn.view'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('yarns')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Yarn not found' });
    }

    res.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// GET /yarns/:id/batches
// Get associated batches for a yarn
// ==========================================
router.get('/:id/batches', requirePermission('yarn.view'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // First get the yarn to know its whole_name
    const { data: yarn, error: yarnError } = await supabase
      .from('yarns')
      .select('whole_name')
      .eq('id', id)
      .single();

    if (yarnError || !yarn) {
      return res.status(404).json({ error: 'Yarn not found' });
    }

    // Query winding_details matching the name or yarn_id
    // Historical data only has the yarn_type string,
    // new data will have the yarn_id.
    const { data: batches, error: batchesError } = await supabase
      .from('winding_details')
      .select('uid, date, company, lot_number')
      .or(`yarn_type.eq."${yarn.whole_name}",yarn_id.eq.${id}`)
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
// POST /yarns
// Create a new yarn
// ==========================================
router.post('/', requirePermission('yarn.manage'), async (req: Request, res: Response) => {
  try {
    const { denier, filament, colour, type, show_in_dropdown } = req.body;

    if (!denier || !filament || !type) {
      return res.status(400).json({ error: 'Denier, filament, and type are required' });
    }

    const validTypes = ['Nylon', 'Cat', 'Poly'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Type must be one of: ${validTypes.join(', ')}` });
    }

    if (typeof denier !== 'number' || denier <= 0) {
      return res.status(400).json({ error: 'Denier must be a positive number' });
    }

    if (typeof filament !== 'number' || filament <= 0) {
      return res.status(400).json({ error: 'Filament must be a positive number' });
    }

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
      return res.status(500).json({ error: 'Failed to create yarn' });
    }

    res.status(201).json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// PUT /yarns/:id
// Update an existing yarn
// ==========================================
router.put('/:id', requirePermission('yarn.manage'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { denier, filament, colour, type, show_in_dropdown } = req.body;

    if (!denier || !filament || !type) {
      return res.status(400).json({ error: 'Denier, filament, and type are required' });
    }

    const validTypes = ['Nylon', 'Cat', 'Poly'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Type must be one of: ${validTypes.join(', ')}` });
    }

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
      return res.status(500).json({ error: 'Failed to update yarn' });
    }

    res.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
