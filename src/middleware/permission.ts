import { Next } from 'hono';
import { AuthedContext } from './auth';
import { getSupabase } from '../lib/supabase';

/**
 * requirePermission(...keys)
 * Admin always passes. For non-admin approved users, checks if ANY of the specified permission keys is granted.
 */
export function requirePermission(...keys: string[]) {
  return async (c: AuthedContext, next: Next): Promise<Response | void> => {
    const profile = c.get('profile');
    if (!profile) return c.json({ error: 'Not authenticated' }, 401);
    if (profile.role === 'admin') return next();
    if (profile.status !== 'approved') return c.json({ error: 'Account pending admin approval' }, 403);

    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('user_permissions')
      .select('permission_key, granted')
      .eq('user_id', profile.id)
      .in('permission_key', keys)
      .eq('granted', true);

    if (error || !data || data.length === 0) {
      return c.json({ error: `You don't have permission for this action`, permissions: keys }, 403);
    }
    await next();
  };
}

/**
 * requireAdmin()
 * Hard admin-role check.
 */
export function requireAdmin() {
  return (c: AuthedContext, next: Next): Response | Promise<void> => {
    const profile = c.get('profile');
    if (!profile || profile.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }
    return next();
  };
}

/**
 * requireReadAccess(page, permissionKey?)
 * Accepts both JWT users and temp-access tokens.
 */
export function requireReadAccess(page: string, permissionKey?: string) {
  return async (c: AuthedContext, next: Next): Promise<Response | void> => {
    const tempAccess = c.get('tempAccess');
    if (tempAccess) {
      if (tempAccess.allowed_pages.includes(page)) return next();
      return c.json({ error: `Temp link does not allow access to "${page}"` }, 403);
    }

    const profile = c.get('profile');
    if (!profile) return c.json({ error: 'Not authenticated' }, 401);
    if (profile.role === 'admin') return next();
    if (profile.status !== 'approved') return c.json({ error: 'Account pending admin approval' }, 403);

    if (permissionKey) {
      const supabase = getSupabase(c.env);
      const { data, error } = await supabase
        .from('user_permissions')
        .select('granted')
        .eq('user_id', profile.id)
        .eq('permission_key', permissionKey)
        .single();

      if (error || !data || !data.granted) {
        return c.json({ error: `You don't have permission for this`, permission: permissionKey }, 403);
      }
    }
    await next();
  };
}
