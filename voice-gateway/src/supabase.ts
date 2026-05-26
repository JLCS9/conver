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

/** Progressive user profile, learned across sessions. All fields optional —
 *  the post-session analyser fills them in as it discovers new facts.
 *  Stored as a single JSONB column so we can evolve the shape without
 *  schema migrations. Inject into the system prompt at session start. */
export interface UserContext {
  profession?: string;
  interests?: string[];
  speaking_level?: "beginner" | "intermediate" | "advanced";
  last_topics?: string[];
  focus_areas?: string[]; // e.g. ['past tense', 'phrasal verbs']
}

export interface UserWithContext extends UserRow {
  user_context: UserContext;
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
 * Same as findUserByClerkId but also pulls user_context + the top N
 * vocabulary words + the most recent grammar corrections. This is the
 * single batch we hand to buildSystemPrompt at session start.
 */
export async function findUserWithMemory(
  clerkUserId: string,
  opts: { vocabLimit?: number; correctionsLimit?: number } = {},
): Promise<{
  user: UserWithContext;
  topVocabulary: { word: string; count: number; level: string | null }[];
  recentCorrections: { original_text: string; corrected_text: string; error_type: string }[];
} | null> {
  const vocabLimit = opts.vocabLimit ?? 50;
  const correctionsLimit = opts.correctionsLimit ?? 10;

  const { data: userData, error: userErr } = await client
    .from("users")
    .select("id, clerk_user_id, user_context")
    .eq("clerk_user_id", clerkUserId)
    .single();
  if (userErr || !userData) return null;

  // Fetch top vocabulary by count and recent grammar corrections in
  // parallel. Both are best-effort: if either fails (e.g. brand-new
  // user with empty tables) we still hand back the user with empty arrays.
  const [vocabRes, correctionsRes] = await Promise.all([
    client
      .from("user_vocabulary")
      .select("word, count, level")
      .eq("user_id", userData.id)
      .order("count", { ascending: false })
      .limit(vocabLimit),
    client
      .from("user_grammar_corrections")
      .select("original_text, corrected_text, error_type")
      .eq("user_id", userData.id)
      .order("created_at", { ascending: false })
      .limit(correctionsLimit),
  ]);

  return {
    user: {
      id: userData.id,
      clerk_user_id: userData.clerk_user_id,
      user_context: (userData.user_context as UserContext) ?? {},
    },
    topVocabulary: vocabRes.data ?? [],
    recentCorrections: correctionsRes.data ?? [],
  };
}

/**
 * Persist a single conversation turn. Fire-and-forget — we never block
 * the live pipeline on a Supabase write. If it fails we log and move on;
 * a few missing turns is preferable to a stuttering conversation.
 */
export async function insertTranscriptTurn(args: {
  sessionId: string;
  userId: string;
  turnIndex: number;
  role: "user" | "model";
  text: string;
}): Promise<void> {
  const { error } = await client.from("conversation_transcripts").insert({
    session_id: args.sessionId,
    user_id: args.userId,
    turn_index: args.turnIndex,
    role: args.role,
    text: args.text,
  });
  if (error) {
    console.warn("[supabase] insertTranscriptTurn failed", error.message);
  }
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
