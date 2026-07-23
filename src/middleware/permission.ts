import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth';
import { supabase } from '../lib/supabase';

/**
 * requirePermission(key)
 * Admin always passes. For non-admin approved users, checks user_permissions table.
 * Returns 403 if permission is not granted.
 */
export function requirePermission(key: string) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const profile = req.profile;

    if (!profile) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Admins bypass every permission check
    if (profile.role === 'admin') {
      next();
      return;
    }

    // User must be approved
    if (profile.status !== 'approved') {
      res.status(403).json({ error: 'Account pending admin approval' });
      return;
    }

    // Check the grants table
    const { data, error } = await supabase
      .from('user_permissions')
      .select('granted')
      .eq('user_id', profile.id)
      .eq('permission_key', key)
      .single();

    if (error || !data || !data.granted) {
      res.status(403).json({
        error: `You don't have permission for this action`,
        permission: key,
      });
      return;
    }

    next();
  };
}

/**
 * requireAdmin()
 * Hard admin-role check — use on the most sensitive admin-only operations.
 */
export function requireAdmin() {
  return (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): void => {
    if (!req.profile || req.profile.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    next();
  };
}

/**
 * requireReadAccess(page, permissionKey?)
 * Accepts both JWT users and temp-access tokens.
 * Temp users: checks allowed_pages. JWT users: checks permission key (admin bypasses).
 */
export function requireReadAccess(page: string, permissionKey?: string) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    // Temp access path
    if (req.tempAccess) {
      if (req.tempAccess.allowed_pages.includes(page)) {
        next();
        return;
      }
      res.status(403).json({ error: `Temp link does not allow access to "${page}"` });
      return;
    }

    // Regular user path
    const profile = req.profile;
    if (!profile) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    if (profile.role === 'admin') {
      next();
      return;
    }

    if (profile.status !== 'approved') {
      res.status(403).json({ error: 'Account pending admin approval' });
      return;
    }

    if (permissionKey) {
      const { data, error } = await supabase
        .from('user_permissions')
        .select('granted')
        .eq('user_id', profile.id)
        .eq('permission_key', permissionKey)
        .single();

      if (error || !data || !data.granted) {
        res.status(403).json({
          error: `You don't have permission for this`,
          permission: permissionKey,
        });
        return;
      }
    }

    next();
  };
}
