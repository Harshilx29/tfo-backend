import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { verifyJWTOrTemp } from '../middleware/auth';
import { requireReadAccess } from '../middleware/permission';
import { AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// ── GET /dashboard/summary ─────────────────────────────
// Batch counts per stage.
router.get(
  '/summary',
  verifyJWTOrTemp,
  requireReadAccess('dashboard', 'dashboard.view'),
  async (_req: AuthenticatedRequest, res) => {
    try {
      const [
        { count: totalBatches },
        { count: windingCount },
        { count: tfoCount },
        { count: boilerCount },
        { count: warpingCount },
        { count: machineCount },
      ] = await Promise.all([
        supabase.from('main').select('*', { count: 'exact', head: true }),
        supabase.from('winding_details').select('*', { count: 'exact', head: true }),
        supabase.from('tfo_details').select('*', { count: 'exact', head: true }),
        supabase.from('boiler_details').select('*', { count: 'exact', head: true }),
        supabase.from('warping').select('*', { count: 'exact', head: true }),
        supabase.from('machine_log').select('*', { count: 'exact', head: true }),
      ]);

      // Recent 5 batches
      const { data: recent } = await supabase
        .from('main')
        .select('uid, file_number, created_at')
        .order('created_at', { ascending: false })
        .limit(5);

      return res.json({
        totalBatches: totalBatches ?? 0,
        stages: {
          winding: windingCount ?? 0,
          tfo: tfoCount ?? 0,
          boiler: boilerCount ?? 0,
          warping: warpingCount ?? 0,
          machine: machineCount ?? 0,
        },
        recentBatches: recent ?? [],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return res.status(500).json({ error: msg });
    }
  }
);

export default router;
