import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables.\n' +
    'Copy backend/.env and fill in your Supabase credentials.'
  );
}

/**
 * Admin Supabase client (service_role key).
 * This bypasses RLS — use only on the server, never expose to browser.
 * Do NOT use auth methods on this client to avoid header pollution.
 */
export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/**
 * Supabase client used strictly for user JWT/refresh authentication operations
 * to prevent setting authentication headers globally on the admin DB client.
 */
export const supabaseAuth = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

