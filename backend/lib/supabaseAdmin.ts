import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Lazy-initialised Supabase client using the service_role key.
// Bypasses RLS — only call from trusted server code, never from a route
// that echoes the result back to an unauthenticated caller.
//
// Lazy init keeps the Docker build green even when env vars are absent
// (the build doesn't hit this code path). Runtime calls without env fail
// loudly.

let cached: SupabaseClient | undefined;

export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "supabaseAdmin: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.",
    );
  }

  cached = createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return cached;
}
