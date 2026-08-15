import { getSupabase, getSupabaseAuth, Env } from '../lib/supabase';
import { unsignTokenFromCookieHeader } from '../middleware/auth';

/**
 * Replaces src/ws/realtime.ts (socket.io + Supabase Realtime bridge).
 *
 * Why a Durable Object: Workers are request-scoped and can't run the
 * long-lived background process the old code used to stay subscribed to
 * Supabase Realtime. A Durable Object is a single stateful instance that
 * *can* hold that subscription open indefinitely, plus hold the map of
 * connected client WebSockets in memory — which is actually a closer
 * match to socket.io's room model than plain Workers would be.
 *
 * @supabase/supabase-js's realtime client uses the standard `WebSocket`
 * global, which Workers/Durable Objects provide natively — so the
 * `supabase.channel(...).on('postgres_changes', ...)` calls below are
 * copied over from the old file almost unchanged.
 *
 * Cost note: as long as this DO holds an open outbound WebSocket to
 * Supabase Realtime, Cloudflare bills it as active (it can't hibernate
 * while that connection is open), unlike the per-client WebSockets which
 * do support hibernation. For a single-tenant internal tool like this
 * that's a small, predictable cost — flagging it so it's a known
 * tradeoff rather than a surprise on the bill.
 */

const TRACK_TABLES = ['main', 'winding_details', 'tfo_details', 'boiler_details', 'warping', 'machine_log'] as const;

interface ClientMeta {
  userId: string | null;
  tempToken: string | null;
  rooms: Set<string>;
}

export class RealtimeRoom {
  state: DurableObjectState;
  env: Env;
  clients: Map<WebSocket, ClientMeta> = new Map();
  subscribed = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.subscribed) {
      this.subscribeToSupabaseRealtime();
      this.subscribed = true;
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const cookieHeader = request.headers.get('Cookie') || '';
    const token = unsignTokenFromCookieHeader(cookieHeader, this.env.SESSION_SECRET);

    const url = new URL(request.url);
    const tempToken = url.searchParams.get('tempToken');

    let userId: string | null = null;
    if (token) {
      const supabaseAuth = getSupabaseAuth(this.env);
      const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
      if (!error && user) userId = user.id;
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernatable API — the DO can be evicted from memory between
    // messages on this socket and Cloudflare will wake it on the next
    // one, so idle viewers don't cost ongoing compute.
    this.state.acceptWebSocket(server);

    const meta: ClientMeta = { userId, tempToken, rooms: new Set() };
    this.clients.set(server, meta);

    if (userId) meta.rooms.add(`user:${userId}`);
    if (await this.checkTrackViewPermission(userId, tempToken)) meta.rooms.add('track:all');
    if (await this.checkCompanyViewPermission(userId)) meta.rooms.add('companies:all');
    if (await this.checkYarnViewPermission(userId)) meta.rooms.add('yarns:all');

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Hibernation event handlers ─────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const meta = this.clients.get(ws);
    if (!meta) return;
    try {
      const msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
      if (msg.type === 'join-track' && typeof msg.uid === 'string' && msg.uid) {
        meta.rooms.add(`track:${msg.uid}`);
      } else if (msg.type === 'leave-track' && typeof msg.uid === 'string') {
        meta.rooms.delete(`track:${msg.uid}`);
      }
    } catch {
      // ignore malformed client messages
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.clients.delete(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.clients.delete(ws);
  }

  // ── Broadcast helper — replaces io.to(room).emit(...) ──

  private broadcast(room: string, payload: unknown) {
    const data = JSON.stringify(payload);
    for (const [ws, meta] of this.clients) {
      if (meta.rooms.has(room)) {
        try {
          ws.send(data);
        } catch {
          this.clients.delete(ws);
        }
      }
    }
  }

  // ── Permission checks — copied unchanged from the old ws/realtime.ts ──

  private async checkTrackViewPermission(userId: string | null, tempToken: string | null): Promise<boolean> {
    const supabase = getSupabase(this.env);
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

  private async checkCompanyViewPermission(userId: string | null): Promise<boolean> {
    if (!userId) return false;
    const supabase = getSupabase(this.env);
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

  private async checkYarnViewPermission(userId: string | null): Promise<boolean> {
    if (!userId) return false;
    const supabase = getSupabase(this.env);
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

  // ── Supabase Realtime subscriptions — same tables/events as before ──

  private subscribeToSupabaseRealtime() {
    const supabase = getSupabase(this.env);

    TRACK_TABLES.forEach((table) => {
      supabase
        .channel(`rt-${table}`)
        .on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
          const uid = (payload.new as Record<string, unknown>)?.uid || (payload.old as Record<string, unknown>)?.uid;
          if (typeof uid === 'string' && uid) {
            this.broadcast(`track:${uid}`, { type: 'track_update', table });
            this.broadcast('track:all', {
              type: 'rt_track_change',
              table,
              eventType: payload.eventType,
              new: payload.new,
              old: payload.old,
              uid,
            });
          }
        })
        .subscribe();
    });

    supabase
      .channel('rt-companies')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'companies' }, (payload) => {
        this.broadcast('companies:all', {
          type: 'companies_update',
          eventType: payload.eventType,
          new: payload.new,
          old: payload.old,
        });
      })
      .subscribe();

    supabase
      .channel('rt-yarns')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'yarns' }, (payload) => {
        this.broadcast('yarns:all', {
          type: 'yarns_update',
          eventType: payload.eventType,
          new: payload.new,
          old: payload.old,
        });
      })
      .subscribe();

    supabase
      .channel('rt-cop-colors')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cop_colors' }, (payload) => {
        // Old code did io.emit(...) (all connected sockets) — mirror
        // that by broadcasting to every client regardless of room.
        for (const ws of this.clients.keys()) {
          try {
            ws.send(
              JSON.stringify({
                type: 'cop_colors_update',
                eventType: payload.eventType,
                new: payload.new,
                old: payload.old,
              })
            );
          } catch {
            this.clients.delete(ws);
          }
        }
      })
      .subscribe();

    supabase
      .channel('rt-machines')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'machines' }, (payload) => {
        const machineId = (payload.new as Record<string, unknown>)?.id || (payload.old as Record<string, unknown>)?.id;
        if (typeof machineId === 'string' && machineId) {
          this.scheduleEnrichedMachineBroadcast(machineId, payload.eventType, payload.old);
        }
      })
      .subscribe();

    supabase
      .channel('rt-tfo-details-machines')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tfo_details' }, (payload) => {
        const machineId = (payload.new as Record<string, unknown>)?.machine_id || (payload.old as Record<string, unknown>)?.machine_id;
        if (typeof machineId === 'string' && machineId) {
          this.scheduleEnrichedMachineBroadcast(machineId, payload.eventType, payload.old);
        }
      })
      .subscribe();

    supabase
      .channel('rt-winding-details-machines')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'winding_details' }, async (payload) => {
        const uid =
          (payload.new as Record<string, unknown>)?.uid || (payload.old as Record<string, unknown>)?.uid;
        if (typeof uid === 'string' && uid) {
          const supabaseAdmin = getSupabase(this.env);
          const { data: activeTfo } = await supabaseAdmin
            .from('tfo_details')
            .select('machine_id')
            .eq('uid', uid)
            .is('unloading_date', null)
            .maybeSingle();

          if (activeTfo?.machine_id) {
            this.scheduleEnrichedMachineBroadcast(activeTfo.machine_id, 'UPDATE', null);
          }
        }
      })
      .subscribe();

    supabase
      .channel('rt-profiles')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, async (payload) => {
        const profileId = (payload.new as Record<string, unknown>)?.id;
        if (typeof profileId === 'string' && profileId) {
          this.broadcast(`user:${profileId}`, { type: 'profile_update', profile: payload.new });
          await this.refreshPermissionsForUser(profileId);
        }
      })
      .subscribe();

    supabase
      .channel('rt-user-permissions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_permissions' }, async (payload) => {
        const userId =
          (payload.new as Record<string, unknown>)?.user_id || (payload.old as Record<string, unknown>)?.user_id;
        if (typeof userId === 'string' && userId) {
          this.broadcast(`user:${userId}`, { type: 'permissions_update' });
          await this.refreshPermissionsForUser(userId);
        }
      })
      .subscribe();

    supabase
      .channel('rt-temp-access-links')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'temp_access_links' }, async (payload) => {
        const token =
          (payload.new as Record<string, unknown>)?.token || (payload.old as Record<string, unknown>)?.token;
        if (typeof token !== 'string' || !token) return;
        for (const [ws, meta] of this.clients) {
          if (meta.tempToken === token) {
            const hasAccess = await this.checkTrackViewPermission(meta.userId, token);
            const inTrackAll = meta.rooms.has('track:all');
            if (hasAccess && !inTrackAll) {
              meta.rooms.add('track:all');
            } else if (!hasAccess && inTrackAll) {
              meta.rooms.delete('track:all');
              try {
                ws.send(JSON.stringify({ type: 'track_access_revoked' }));
              } catch {
                this.clients.delete(ws);
              }
            }
          }
        }
      })
      .subscribe();
  }

  private debounceMap = new Map<string, ReturnType<typeof setTimeout>>();

  private scheduleEnrichedMachineBroadcast(machineId: string, eventType: string, oldRow: any) {
    if (!machineId) return;

    if (this.debounceMap.has(machineId)) {
      clearTimeout(this.debounceMap.get(machineId)!);
    }

    const timer = setTimeout(async () => {
      this.debounceMap.delete(machineId);
      await this.broadcastEnrichedMachine(machineId, eventType, oldRow);
    }, 100);

    this.debounceMap.set(machineId, timer);
  }

  private async broadcastEnrichedMachine(machineId: string, eventType: string, oldRow: any) {
    try {
      const supabase = getSupabase(this.env);

      const { data: row, error } = await (supabase
        .from('machines')
        .select(`
          *,
          tfo_details!tfo_details_machine_id_fkey!left(
            uid,
            tpm,
            loading_date,
            color_s,
            color_z,
            cop_color_s:cop_colors!tfo_details_color_s_id_fkey!left(id, name, hex_code),
            cop_color_z:cop_colors!tfo_details_color_z_id_fkey!left(id, name, hex_code)
          )
        ` as any)
        .eq('id', machineId)
        .is('tfo_details.unloading_date', null)
        .maybeSingle() as any);

      if (error || !row) {
        if (eventType === 'DELETE') {
          this.broadcastToAll({ type: 'machines_update', eventType: 'DELETE', old: oldRow });
        }
        return;
      }

      const activeTfoList = row.tfo_details || [];
      const activeTfo = Array.isArray(activeTfoList) ? activeTfoList[0] : activeTfoList;

      const { tfo_details: _, ...machineData } = row;

      let yarnType: string | null = null;
      if (activeTfo?.uid) {
        const { data: windingRow } = await supabase
          .from('winding_details')
          .select('yarn_type')
          .eq('uid', activeTfo.uid)
          .maybeSingle();
        yarnType = windingRow?.yarn_type ?? null;
      }

      const enrichedMachine = {
        ...machineData,
        active_batch: activeTfo
          ? {
              uid: activeTfo.uid,
              yarn_type: yarnType,
              tpm: activeTfo.tpm ?? null,
              loading_date: activeTfo.loading_date ?? null,
              color_s: activeTfo.cop_color_s
                ? { name: activeTfo.cop_color_s.name, hex_code: activeTfo.cop_color_s.hex_code }
                : activeTfo.color_s ? { name: activeTfo.color_s, hex_code: null } : null,
              color_z: activeTfo.cop_color_z
                ? { name: activeTfo.cop_color_z.name, hex_code: activeTfo.cop_color_z.hex_code }
                : activeTfo.color_z ? { name: activeTfo.color_z, hex_code: null } : null,
            }
          : null,
      };

      this.broadcastToAll({
        type: 'machines_update',
        eventType,
        new: enrichedMachine,
        old: oldRow,
      });
    } catch (err) {
      console.error('Failed to broadcast enriched machine:', err);
    }
  }

  private broadcastToAll(msg: Record<string, unknown>) {
    const json = JSON.stringify(msg);
    for (const ws of this.clients.keys()) {
      try {
        ws.send(json);
      } catch {
        this.clients.delete(ws);
      }
    }
  }

  /** Mirrors updateSocketPermissionsForUser from the old bridge. */
  private async refreshPermissionsForUser(userId: string) {
    for (const [ws, meta] of this.clients) {
      if (meta.userId !== userId) continue;

      const checks: [string, boolean][] = [
        ['track:all', await this.checkTrackViewPermission(userId, meta.tempToken)],
        ['companies:all', await this.checkCompanyViewPermission(userId)],
        ['yarns:all', await this.checkYarnViewPermission(userId)],
      ];
      const revokeEvent: Record<string, string> = {
        'track:all': 'track_access_revoked',
        'companies:all': 'company_access_revoked',
        'yarns:all': 'yarn_access_revoked',
      };

      for (const [room, hasAccess] of checks) {
        const inRoom = meta.rooms.has(room);
        if (hasAccess && !inRoom) {
          meta.rooms.add(room);
        } else if (!hasAccess && inRoom) {
          meta.rooms.delete(room);
          try {
            ws.send(JSON.stringify({ type: revokeEvent[room] }));
          } catch {
            this.clients.delete(ws);
          }
        }
      }
    }
  }
}
