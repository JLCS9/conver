// GET /api/me/grammar-corrections
//
// Returns the authenticated user's grammar correction history — every
// time the post-session analyser detected a mistake and what the
// natural fix was. Ordered newest first.
//
// Query params:
//   ?type=verb_tense|preposition|...  (filter by error_type)
//   ?limit=100                         (default: 100, max: 500)

import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const errorType = url.searchParams.get("type");
  const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 100));

  const supabase = supabaseAdmin();

  const { data: user, error: userErr } = await supabase
    .from("users")
    .select("id")
    .eq("clerk_user_id", clerkUserId)
    .single();
  if (userErr || !user) {
    return Response.json({ error: "user_not_found" }, { status: 404 });
  }

  let query = supabase
    .from("user_grammar_corrections")
    .select("id, original_text, corrected_text, error_type, explanation, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (errorType) {
    query = query.eq("error_type", errorType);
  }

  const { data, error } = await query.limit(limit);
  if (error) {
    console.error("[/api/me/grammar-corrections] query failed", error);
    return Response.json({ error: "db_error", message: error.message }, { status: 500 });
  }

  return Response.json({
    corrections: data ?? [],
    count: data?.length ?? 0,
  });
}
