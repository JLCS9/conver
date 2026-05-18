// GET /api/me
// Requires a valid Clerk session (enforced by middleware.ts).
// Upserts the user row in Supabase keyed by clerk_user_id, then returns
// the persisted profile. First-time callers get a freshly created row.

import { auth, currentUser } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    // Middleware should have caught this, but belt-and-braces.
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const clerkUser = await currentUser();
  const email =
    clerkUser?.emailAddresses?.[0]?.emailAddress ?? "unknown@example.com";

  const supabase = supabaseAdmin();

  const { data, error } = await supabase
    .from("users")
    .upsert(
      { clerk_user_id: userId, email },
      { onConflict: "clerk_user_id", ignoreDuplicates: false },
    )
    .select(
      "id, clerk_user_id, email, role, level, goal, daily_session_time, timezone, locale, region, onboarding_completed_at, created_at",
    )
    .single();

  if (error) {
    console.error("[/api/me] supabase upsert failed", error);
    return Response.json(
      { error: "db_error", details: error.message },
      { status: 500 },
    );
  }

  return Response.json({ user: data });
}
