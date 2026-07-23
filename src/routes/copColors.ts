import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { requirePermission } from '../middleware/permission';
import { verifyJWT } from '../middleware/auth';

const router = Router();
router.use(verifyJWT);

// ==========================================
// GET /cop-colors/dropdown
// Lightweight endpoint for dropdown options (all authenticated users)
// ==========================================
router.get('/dropdown', async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('cop_colors')
      .select('id, name, hex_code')
      .eq('show_in_dropdown', true)
      .order('name', { ascending: true });

    if (error) {
      console.error('Error fetching cop colors dropdown:', error);
      return res.status(500).json({ error: 'Failed to fetch cop colors' });
    }

    res.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// GET /cop-colors
// List all cop colors
// ==========================================
router.get('/', requirePermission('cop.view'), async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('cop_colors')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      console.error('Error fetching cop colors:', error);
      return res.status(500).json({ error: 'Failed to fetch cop colors' });
    }

    res.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// GET /cop-colors/:id
// Get single cop color by ID
// ==========================================
router.get('/:id', requirePermission('cop.view'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('cop_colors')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Cop color not found' });
    }

    res.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// POST /cop-colors
// Create a new cop color
// ==========================================
router.post('/', requirePermission('cop.manage'), async (req: Request, res: Response) => {
  try {
    const { name, hex_code, show_in_dropdown } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Color name is required' });
    }

    if (!hex_code || !hex_code.trim()) {
      return res.status(400).json({ error: 'Hex code is required' });
    }

    let formattedHex = hex_code.trim();
    if (!formattedHex.startsWith('#')) {
      formattedHex = `#${formattedHex}`;
    }

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
      return res.status(500).json({ error: 'Failed to create cop color' });
    }

    res.status(201).json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// PUT /cop-colors/:id
// Update an existing cop color
// ==========================================
router.put('/:id', requirePermission('cop.manage'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, hex_code, show_in_dropdown } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Color name is required' });
    }

    if (!hex_code || !hex_code.trim()) {
      return res.status(400).json({ error: 'Hex code is required' });
    }

    let formattedHex = hex_code.trim();
    if (!formattedHex.startsWith('#')) {
      formattedHex = `#${formattedHex}`;
    }

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
      return res.status(500).json({ error: 'Failed to update cop color' });
    }

    res.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// DELETE /cop-colors/:id
// Delete a cop color
// ==========================================
router.delete('/:id', requirePermission('cop.manage'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('cop_colors')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting cop color:', error);
      return res.status(500).json({ error: 'Failed to delete cop color' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
