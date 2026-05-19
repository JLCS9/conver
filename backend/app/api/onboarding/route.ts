// POST /api/onboarding
// Requires a valid Clerk session (enforced by middleware.ts).
// Persists the wizard answers to public.users and marks the row as
// onboarding-complete. Idempotent: re-sending the payload overwrites
// the same fields and refreshes onboarding_completed_at.
//
// Body shape (all required except role which defaults to 'tech' per the
// v1 vertical lock):
//   {
//     role?: 'tech',
//     level: 'beginner' | 'intermediate' | 'advanced',
//     goal: 'job' | 'interviews' | 'confidence' | 'other',
//     dailySessionTime: 'HH:MM',    // 24h local time, e.g. '08:30'
//     timezone: string              // IANA, e.g. 'Europe/Madrid'
//   }
//
// Returns 200 with the updated user row on success. Manual validation
// for now — zod will land when we have a second endpoint that justifies
// formalizing a schema package.

import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

const ALLOWED_LEVELS = ["beginner", "intermediate", "advanced"] as const;
const ALLOWED_GOALS = ["job", "interviews", "confidence", "other"] as const;
// "HH:MM" 24h, hours 00-23, minutes 00-59.
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

type Level = (typeof ALLOWED_LEVELS)[number];
type Goal = (typeof ALLOWED_GOALS)[number];

interface OnboardingBody {
  role?: "tech";
  level: Level;
  goal: Goal;
  dailySessionTime: string;
  timezone: string;
}

function badRequest(reason: string) {
  return Response.json({ error: "bad_request", reason }, { status: 400 });
}

function isLevel(v: unknown): v is Level {
  return typeof v === "string" && (ALLOWED_LEVELS as readonly string[]).includes(v);
}

function isGoal(v: unknown): v is Goal {
  return typeof v === "string" && (ALLOWED_GOALS as readonly string[]).includes(v);
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("invalid_json");
  }

  if (!body || typeof body !== "object") return badRequest("body_must_be_object");
  const b = body as Partial<OnboardingBody>;

  if (b.role !== undefined && b.role !== "tech") return badRequest("invalid_role");
  if (!isLevel(b.level)) return badRequest("invalid_level");
  if (!isGoal(b.goal)) return badRequest("invalid_goal");
  if (typeof b.dailySessionTime !== "string" || !TIME_REGEX.test(b.dailySessionTime)) {
    return badRequest("invalid_daily_session_time");
  }
  if (typeof b.timezone !== "string" || b.timezone.length === 0 || b.timezone.length > 64) {
    return badRequest("invalid_timezone");
  }

  const supabase = supabaseAdmin();

  const { data, error } = await supabase
    .from("users")
    .update({
      role: "tech",
      level: b.level,
      goal: b.goal,
      daily_session_time: b.dailySessionTime,
      timezone: b.timezone,
      onboarding_completed_at: new Date().toISOString(),
    })
    .eq("clerk_user_id", userId)
    .select(
      "id, clerk_user_id, email, role, level, goal, daily_session_time, timezone, locale, region, onboarding_completed_at, created_at",
    )
    .single();

  if (error) {
    console.error("[/api/onboarding] supabase update failed", error);
    return Response.json(
      { error: "db_error", details: error.message },
      { status: 500 },
    );
  }

  if (!data) {
    // User row should exist (GET /api/me creates it). If it doesn't, the
    // mobile client jumped onboarding without ever hitting /api/me first.
    return Response.json({ error: "user_not_found" }, { status: 404 });
  }

  return Response.json({ user: data });
}
