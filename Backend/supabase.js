// lib/supabase.js
// Supabase client — use supabaseAdmin for server-side API routes
// (service role bypasses RLS), use supabase for client-side calls

import { createClient } from "@supabase/supabase-js";

// Public client (browser-safe, respects RLS)
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

// Admin client (server only — never expose to browser)
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
