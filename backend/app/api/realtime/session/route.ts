// POST /api/realtime/session
// Requires a valid Clerk session.
//
// Mints a new voice session: validates the user's daily cap, inserts a
// `sessions` row with status='active', and returns the metadata the
// mobile client needs to open its WebSocket to the voice-gateway.
//
// The gateway URL is computed server-side so the mobile client doesn't
// hardcode hosts — easier to swap environments.
//
// Day-1 scope: free tier (5 min/day) only. Premium tier handling lands
// alongside the subscription work in Week 7. For now everyone is free.

import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { parseJsonBody, realtimeSessionBodySchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

// Hard limits — also enforced server-side by the voice-gateway. The
// client gets these values so it can show a countdown and close itself
// gracefully a few seconds before the gateway kills the WS.
//
// Both are env-overridable so we can bump them for dev/staging without
// a code change. Defaults are the free-tier production values.
//   - MAX_SESSION_DURATION_SECONDS: hard ceiling per *single* session
//   - FREE_TIER_DAILY_LIMIT_SECONDS: rolling total across all sessions
//     for a UTC day. Hit it and you get HTTP 402 with paywall:true.
// To bump in dev: set in /opt/converflow/backend/.env.local then
// `docker compose up -d backend` (no rebuild needed; env_file is read
// at container start).
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const MAX_SESSION_DURATION_SECONDS = envInt(
  "MAX_SESSION_DURATION_SECONDS",
  720, // 12 min
);
const FREE_TIER_DAILY_LIMIT_SECONDS = envInt(
  "FREE_TIER_DAILY_LIMIT_SECONDS",
  300, // 5 min/day
);

function startOfTodayIso(): string {
  // We treat "today" in UTC for the cap reset. Local timezones drift the
  // boundary but UTC is unambiguous and avoids cross-DST off-by-one.
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return start.toISOString();
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = await parseJsonBody(request, realtimeSessionBodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const supabase = supabaseAdmin();

  // Resolve the internal user id — sessions.user_id references public.users.
  // No onboarding gate: Day 5-B made onboarding optional. The mobile Home
  // screen calls /api/me which upserts the row, so by the time the user
  // hits /api/realtime/session, public.users has a row for them. If it
  // doesn't (e.g. /api/me failed earlier), the .single() lookup below
  // 404s and the client surfaces it.
  const { data: user, error: userErr } = await supabase
    .from("users")
    .select("id")
    .eq("clerk_user_id", userId)
    .single();

  if (userErr || !user) {
    console.error("[/api/realtime/session] user lookup failed", userErr);
    return Response.json({ error: "user_not_found" }, { status: 404 });
  }

  // Sum today's session durations. We could read voice_usage_logs.minutes_used
  // but for the Day 1 cap check, summing closed sessions is enough — open
  // sessions don't count yet because the gateway hasn't begun tracking. Any
  // active session for this user gets aborted by the gateway when a new
  // one opens (no concurrent sessions per user, enforced at WS handshake).
  const { data: todays, error: capErr } = await supabase
    .from("sessions")
    .select("duration_seconds")
    .eq("user_id", user.id)
    .gte("started_at", startOfTodayIso())
    .in("status", ["completed", "aborted"]);

  if (capErr) {
    console.error("[/api/realtime/session] cap query failed", capErr);
    return Response.json({ error: "db_error" }, { status: 500 });
  }

  const usedSeconds = (todays ?? []).reduce(
    (total, row) => total + (row.duration_seconds ?? 0),
    0,
  );

  if (usedSeconds >= FREE_TIER_DAILY_LIMIT_SECONDS) {
    return Response.json(
      {
        error: "daily_cap_reached",
        paywall: true,
        usedSeconds,
        limitSeconds: FREE_TIER_DAILY_LIMIT_SECONDS,
      },
      { status: 402 },
    );
  }

  // Remaining budget = min(remaining today, hard per-session cap). The
  // gateway will kill the WS at this duration if the client hasn't already.
  const remainingTodaySeconds =
    FREE_TIER_DAILY_LIMIT_SECONDS - usedSeconds;
  const sessionMaxSeconds = Math.min(
    MAX_SESSION_DURATION_SECONDS,
    remainingTodaySeconds,
  );

  // Insert the session row. The gateway will UPDATE status + duration on close.
  const { data: session, error: insertErr } = await supabase
    .from("sessions")
    .insert({
      user_id: user.id,
      started_at: new Date().toISOString(),
      prompt_format: body.promptFormat ?? null,
      model_used: process.env.GEMINI_MODEL ?? "gemini-2.5-flash-native-audio-latest",
      status: "active",
    })
    .select("id, started_at, prompt_format, model_used, status")
    .single();

  if (insertErr || !session) {
    console.error("[/api/realtime/session] insert failed", insertErr);
    return Response.json(
      { error: "db_error", details: insertErr?.message },
      { status: 500 },
    );
  }

  const gatewayBase =
    process.env.VOICE_GATEWAY_URL ??
    "wss://api.converflow.tech/voice";

  return Response.json({
    sessionId: session.id,
    wsUrl: `${gatewayBase}?sessionId=${session.id}`,
    model: session.model_used,
    maxDurationSeconds: sessionMaxSeconds,
    promptFormat: session.prompt_format,
  });
}
