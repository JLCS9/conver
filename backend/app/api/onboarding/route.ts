// POST /api/onboarding
// Requires a valid Clerk session (enforced by middleware.ts).
// Persists the wizard answers to public.users and marks the row as
// onboarding-complete. Idempotent: re-sending the payload overwrites
// the same fields and refreshes onboarding_completed_at.
//
// Body validated by `onboardingBodySchema` in lib/schemas.ts.
// Returns 200 with the updated user row on success.

import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { onboardingBodySchema, parseJsonBody } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = await parseJsonBody(request, onboardingBodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const supabase = supabaseAdmin();

  const { data, error } = await supabase
    .from("users")
    .update({
      role: "tech",
      level: body.level,
      goal: body.goal,
      daily_session_time: body.dailySessionTime,
      timezone: body.timezone,
      onboarding_completed_at: new Date().toISOString(),
    })
    .eq("clerk_user_id", userId)
    .select(
      "id, clerk_user_id, email, role, level, goal, daily_session_time, timezone, locale, region, onboarding_completed_at, created_at",
    )
    .single();

  if (error) {
    console.error("[/api/onboarding] supabase update failed", {
      message: error.message,
      code: error.code,
      hint: error.hint,
      details: error.details,
    });
    return Response.json(
      {
        error: "db_error",
        message: error.message,
        code: error.code,
        hint: error.hint,
        details: error.details,
      },
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
