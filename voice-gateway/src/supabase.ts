// Supabase service-role client + the lookups the gateway needs.
//
// Uses service_role so all writes bypass RLS — same pattern as the
// Next.js backend. The gateway is server-side trusted code.

import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./env.js";

const env = loadEnv();

const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

export interface SessionRow {
  id: string;
  user_id: string;
  status: "active" | "completed" | "aborted" | "error";
  started_at: string;
  prompt_format: string | null;
  model_used: string | null;
}

export interface UserRow {
  id: string;
  clerk_user_id: string;
}

/**
 * Resolves the internal user row for the given Clerk id, returning null
 * if the Clerk user has no Supabase mirror (means they never hit /api/me).
 */
export async function findUserByClerkId(
  clerkUserId: string,
): Promise<UserRow | null> {
  const { data, error } = await client
    .from("users")
    .select("id, clerk_user_id")
    .eq("clerk_user_id", clerkUserId)
    .single();
  if (error || !data) return null;
  return data;
}

/**
 * Fetches the session by id, returning null if it doesn't exist.
 * Caller is responsible for validating status + ownership.
 */
export async function findSessionById(
  sessionId: string,
): Promise<SessionRow | null> {
  const { data, error } = await client
    .from("sessions")
    .select("id, user_id, status, started_at, prompt_format, model_used")
    .eq("id", sessionId)
    .single();
  if (error || !data) return null;
  return data;
}

/**
 * Marks a session as completed with the observed duration in seconds.
 * Called when the WS closes cleanly from either side.
 */
export async function markSessionCompleted(
  sessionId: string,
  durationSeconds: number,
): Promise<void> {
  await client
    .from("sessions")
    .update({
      status: "completed",
      ended_at: new Date().toISOString(),
      duration_seconds: Math.round(durationSeconds),
    })
    .eq("id", sessionId);
}

/**
 * Marks a session as aborted (gateway killed it, error, or never reached
 * upstream). `error_reason` is optional context.
 */
export async function markSessionAborted(
  sessionId: string,
  durationSeconds: number,
  errorReason?: string,
): Promise<void> {
  await client
    .from("sessions")
    .update({
      status: "aborted",
      ended_at: new Date().toISOString(),
      duration_seconds: Math.round(durationSeconds),
      error_reason: errorReason ?? null,
    })
    .eq("id", sessionId);
}
