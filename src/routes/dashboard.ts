import { Hono } from 'hono';
import { getSupabase, Env } from '../lib/supabase';
import { verifyJWTOrTemp, AuthedContext } from '../middleware/auth';
import { requireReadAccess } from '../middleware/permission';

type Vars = { userId?: string; profile?: any; tempAccess?: any };
const router = new Hono<{ Bindings: Env; Variables: Vars }>();

router.get('/summary', verifyJWTOrTemp, requireReadAccess('dashboard', 'dashboard.view'), async (c: AuthedContext) => {
  try {
    const supabase = getSupabase(c.env);
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

    const { data: recent } = await supabase
      .from('main')
      .select('uid, file_number, created_at')
      .order('created_at', { ascending: false })
      .limit(5);

    return c.json({
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
    return c.json({ error: msg }, 500);
  }
});

export default router;
