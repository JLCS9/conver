// GET /api/me/vocabulary
//
// Returns the authenticated user's full vocabulary list — words they've
// actually said in past sessions, with usage count, CEFR level, and the
// most recent example sentence. Ordered by usage frequency desc by
// default; query params override.
//
// Query params:
//   ?sort=count|recent       (default: count)
//   ?level=basic|intermediate|advanced
//   ?limit=200               (default: 200, max: 1000)

import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const sort = url.searchParams.get("sort") === "recent" ? "recent" : "count";
  const level = url.searchParams.get("level");
  const limit = Math.min(1000, Number(url.searchParams.get("limit") ?? 200));

  const supabase = supabaseAdmin();

  // Resolve internal user id from clerk id.
  const { data: user, error: userErr } = await supabase
    .from("users")
    .select("id")
    .eq("clerk_user_id", clerkUserId)
    .single();
  if (userErr || !user) {
    return Response.json({ error: "user_not_found" }, { status: 404 });
  }

  let query = supabase
    .from("user_vocabulary")
    .select("word, count, level, example_sentence, first_used_at, last_used_at")
    .eq("user_id", user.id);

  if (level && ["basic", "intermediate", "advanced"].includes(level)) {
    query = query.eq("level", level);
  }

  query = sort === "recent"
    ? query.order("last_used_at", { ascending: false })
    : query.order("count", { ascending: false });

  const { data, error } = await query.limit(limit);
  if (error) {
    console.error("[/api/me/vocabulary] query failed", error);
    return Response.json({ error: "db_error", message: error.message }, { status: 500 });
  }

  return Response.json({
    vocabulary: data ?? [],
    count: data?.length ?? 0,
  });
}
