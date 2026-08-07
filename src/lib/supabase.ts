import { createClient } from '@supabase/supabase-js';

/**
 * On Workers there is no `process.env`. Every function that needs these
 * clients must call `getSupabase(env)` / `getSupabaseAuth(env)` and pass
 * the `Env` bindings object Cloudflare hands to your fetch handler.
 *
 * Supabase-js is fetch/WebSocket based under the hood (not a raw TCP
 * Postgres driver), so it works unmodified inside Workers and Durable
 * Objects — this file is the one part of `lib/supabase.ts` that ports
 * over with only the env-access pattern changed.
 */
export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_ANON_KEY: string;
  SESSION_SECRET: string;
  FRONTEND_URL: string;
  BACKEND_URL: string;
  ADMIN_EMAIL: string;
  REALTIME_ROOM: DurableObjectNamespace;
  API_RATE_LIMITER: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
  AUTH_RATE_LIMITER: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
  TEMP_LINK_RATE_LIMITER: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
}

/**
 * Admin Supabase client (service_role key).
 * Bypasses RLS — server-side only, same as before.
 */
export function getSupabase(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Supabase client used strictly for user JWT/refresh operations,
 * kept separate to avoid header pollution — same as before.
 */
export function getSupabaseAuth(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
