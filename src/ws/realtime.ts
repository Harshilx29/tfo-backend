import { Server as SocketIOServer, Socket } from 'socket.io';
import { supabase, supabaseAuth } from '../lib/supabase';
import { unsignTokenFromCookieHeader } from '../middleware/auth';

// Tables that feed the Track page (scoped by uid)
const TRACK_TABLES = [
  'main',
  'winding_details',
  'tfo_details',
  'boiler_details',
  'warping',
  'machine_log',
] as const;

/**
 * Checks if a user or temporary link has permission to view track data.
 */
async function checkTrackViewPermission(
  userId: string | null,
  tempToken: string | null
): Promise<boolean> {
  if (tempToken) {
    const { data: link, error } = await supabase
      .from('temp_access_links')
      .select('allowed_pages, expires_at, max_uses, use_count, is_active')
      .eq('token', tempToken)
      .eq('is_active', true)
      .single();

    if (error || !link) return false;
    if (new Date(link.expires_at) < new Date()) return false;
    if (link.max_uses !== null && link.use_count >= link.max_uses) return false;
    return link.allowed_pages.includes('track');
  }

  if (userId) {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role, status')
      .eq('id', userId)
      .single();

    if (profileError || !profile) return false;
    if (profile.role === 'admin') return true;
    if (profile.status !== 'approved') return false;

    const { data: perm, error: permError } = await supabase
      .from('user_permissions')
      .select('granted')
      .eq('user_id', userId)
      .eq('permission_key', 'track.view')
      .single();

    if (permError || !perm) return false;
    return perm.granted;
  }

  return false;
}

/**
 * Checks if a user has permission to view companies data.
 */
async function checkCompanyViewPermission(userId: string | null): Promise<boolean> {
  if (!userId) return false;

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, status')
    .eq('id', userId)
    .single();

  if (profileError || !profile) return false;
  if (profile.role === 'admin') return true;
  if (profile.status !== 'approved') return false;

  const { data: perm, error: permError } = await supabase
    .from('user_permissions')
    .select('granted')
    .eq('user_id', userId)
    .eq('permission_key', 'company.view')
    .single();

  if (permError || !perm) return false;
  return perm.granted;
}

/**
 * Checks if a user has permission to view yarns data.
 */
async function checkYarnViewPermission(userId: string | null): Promise<boolean> {
  if (!userId) return false;

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, status')
    .eq('id', userId)
    .single();

  if (profileError || !profile) return false;
  if (profile.role === 'admin') return true;
  if (profile.status !== 'approved') return false;

  const { data: perm, error: permError } = await supabase
    .from('user_permissions')
    .select('granted')
    .eq('user_id', userId)
    .eq('permission_key', 'yarn.view')
    .single();

  if (permError || !perm) return false;
  return perm.granted;
}

/**
 * Re-evaluates permissions for all sockets belonging to a user.
 */
async function updateSocketPermissionsForUser(io: SocketIOServer, userId: string) {
  try {
    const sockets = await io.in(`user:${userId}`).fetchSockets();
    for (const socket of sockets) {
      const tempToken = socket.data.tempToken as string | null;
      const hasAccess = await checkTrackViewPermission(userId, tempToken);
      const inTrackAll = socket.rooms.has('track:all');

      if (hasAccess && !inTrackAll) {
        void socket.join('track:all');
      } else if (!hasAccess && inTrackAll) {
        void socket.leave('track:all');
        socket.emit('track_access_revoked');
      }

      const hasCompanyAccess = await checkCompanyViewPermission(userId);
      const inCompaniesAll = socket.rooms.has('companies:all');

      if (hasCompanyAccess && !inCompaniesAll) {
        void socket.join('companies:all');
      } else if (!hasCompanyAccess && inCompaniesAll) {
        void socket.leave('companies:all');
        socket.emit('company_access_revoked');
      }

      const hasYarnAccess = await checkYarnViewPermission(userId);
      const inYarnsAll = socket.rooms.has('yarns:all');

      if (hasYarnAccess && !inYarnsAll) {
        void socket.join('yarns:all');
      } else if (!hasYarnAccess && inYarnsAll) {
        void socket.leave('yarns:all');
        socket.emit('yarn_access_revoked');
      }
    }
  } catch (err) {
    console.error('Error updating socket permissions:', err);
  }
}

/**
 * initRealtime
 *
 * 1. Authenticates socket.io connections using the tm_access httpOnly cookie.
 * 2. Subscribes to Supabase Realtime for all relevant tables (service_role key).
 * 3. Re-emits postgres_changes events to the correct socket.io rooms:
 *    - "track:{uid}"   → track data tables
 *    - "user:{userId}" → profile + permissions tables
 *    - "track:all"     → global track update events if authorized
 */
export function initRealtime(io: SocketIOServer): void {
  // ── Socket.IO auth middleware ──────────────────────────
  io.use(async (socket: Socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie || '';
    const token = unsignTokenFromCookieHeader(cookieHeader);

    if (!token) {
      // Allow unauthenticated connections (for read-only temp-link sessions)
      // They won't join user rooms but can join track rooms if handshake auth passes
      socket.data.userId = null;
      return next();
    }

    try {
      const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
      if (error || !user) {
        socket.data.userId = null;
      } else {
        socket.data.userId = user.id;
      }
      next();
    } catch {
      socket.data.userId = null;
      next();
    }
  });

  // ── Socket.IO connection handler ───────────────────────
  io.on('connection', async (socket: Socket) => {
    const userId = socket.data.userId as string | null;
    const tempToken = socket.handshake.auth?.tempToken as string | null;
    socket.data.tempToken = tempToken;

    // Authenticated users are auto-joined to their personal room
    if (userId) {
      void socket.join(`user:${userId}`);
    }

    // Join global track updates room if allowed
    const hasAccess = await checkTrackViewPermission(userId, tempToken);
    if (hasAccess) {
      void socket.join('track:all');
    }

    // Join global companies updates room if allowed
    const hasCompanyAccess = await checkCompanyViewPermission(userId);
    if (hasCompanyAccess) {
      void socket.join('companies:all');
    }

    // Join global yarns updates room if allowed
    const hasYarnAccess = await checkYarnViewPermission(userId);
    if (hasYarnAccess) {
      void socket.join('yarns:all');
    }

    // Client joins a track room when it opens a specific UID
    socket.on('join-track', (uid: string) => {
      if (typeof uid === 'string' && uid.length > 0) {
        void socket.join(`track:${uid}`);
      }
    });

    // Client leaves a track room when it closes the UID
    socket.on('leave-track', (uid: string) => {
      if (typeof uid === 'string') {
        void socket.leave(`track:${uid}`);
      }
    });
  });

  // ── Supabase Realtime subscriptions ───────────────────

  // Track tables — emit to track:{uid} rooms & track:all
  TRACK_TABLES.forEach((table) => {
    supabase
      .channel(`rt-${table}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        async (payload) => {
          const uid =
            (payload.new as Record<string, unknown>)?.uid ||
            (payload.old as Record<string, unknown>)?.uid;

          if (typeof uid === 'string' && uid) {
            // Legacy individual room emit
            io.to(`track:${uid}`).emit('track_update', { table });

            // Global updates room broadcast
            io.to('track:all').emit('rt_track_change', {
              table,
              eventType: payload.eventType,
              new: payload.new,
              old: payload.old,
              uid,
            });
          }
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log(`  ✓ Realtime subscribed: ${table}`);
        }
      });
  });

  // Companies table — emit to companies:all room
  supabase
    .channel('rt-companies')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'companies' },
      (payload) => {
        io.to('companies:all').emit('companies_update', {
          eventType: payload.eventType,
          new: payload.new,
          old: payload.old,
        });
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log(`  ✓ Realtime subscribed: companies`);
      }
    });

  // Yarns table — emit to yarns:all room
  supabase
    .channel('rt-yarns')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'yarns' },
      (payload) => {
        io.to('yarns:all').emit('yarns_update', {
          eventType: payload.eventType,
          new: payload.new,
          old: payload.old,
        });
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log(`  ✓ Realtime subscribed: yarns`);
      }
    });

  // Cop Colors table — emit to cop_colors:all room (or broadcast to all approved sockets)
  supabase
    .channel('rt-cop-colors')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'cop_colors' },
      (payload) => {
        io.emit('cop_colors_update', {
          eventType: payload.eventType,
          new: payload.new,
          old: payload.old,
        });
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log(`  ✓ Realtime subscribed: cop_colors`);
      }
    });

  // Profiles table — emit profile_update to user:{id} room
  supabase
    .channel('rt-profiles')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'profiles' },
      async (payload) => {
        const profileId = (payload.new as Record<string, unknown>)?.id;
        if (typeof profileId === 'string' && profileId) {
          io.to(`user:${profileId}`).emit('profile_update', { profile: payload.new });
          await updateSocketPermissionsForUser(io, profileId);
        }
      }
    )
    .subscribe();

  // User permissions table — emit permissions_update to user:{user_id} room
  supabase
    .channel('rt-user-permissions')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'user_permissions' },
      async (payload) => {
        const userId =
          (payload.new as Record<string, unknown>)?.user_id ||
          (payload.old as Record<string, unknown>)?.user_id;

        if (typeof userId === 'string' && userId) {
          io.to(`user:${userId}`).emit('permissions_update', {});
          await updateSocketPermissionsForUser(io, userId);
        }
      }
    )
    .subscribe();

  // Temp access links table — check links changes to add/remove socket access
  supabase
    .channel('rt-temp-access-links')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'temp_access_links' },
      async (payload) => {
        const token =
          (payload.new as Record<string, unknown>)?.token ||
          (payload.old as Record<string, unknown>)?.token;

        if (typeof token === 'string' && token) {
          const sockets = await io.fetchSockets();
          for (const socket of sockets) {
            if (socket.data.tempToken === token) {
              const hasAccess = await checkTrackViewPermission(socket.data.userId, token);
              const rooms = socket.rooms;
              const inTrackAll = rooms.has('track:all');
              
              if (hasAccess && !inTrackAll) {
                void socket.join('track:all');
              } else if (!hasAccess && inTrackAll) {
                void socket.leave('track:all');
                socket.emit('track_access_revoked');
              }
            }
          }
        }
      }
    )
    .subscribe();

  console.log('  🔌 Realtime bridge initialized');
}
