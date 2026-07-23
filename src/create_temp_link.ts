import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function run() {
  const { data: existingLinks, error: err1 } = await supabase
    .from('temp_access_links')
    .select('*')
    .limit(10);
  
  console.log('Existing Links:', existingLinks);

  const token = 'devtoken123456789012345678901234';
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);

  const { data, error } = await supabase
    .from('temp_access_links')
    .upsert({
      token,
      label: 'Dev Access Link',
      allowed_pages: ['dashboard', 'track'],
      expires_at: expiresAt.toISOString(),
    }, { onConflict: 'token' })
    .select();

  if (error) {
    console.error('Error creating token:', error);
  } else {
    console.log('Created dev token:', data);
  }
}

run();
