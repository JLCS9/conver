// GET /api/me/insights
//
// Returns a high-level summary of the user's learning progress, for the
// "Mi perfil" screen. One round trip, multiple aggregates batched in
// parallel:
//
//   {
//     user_context: { profession?, interests?, ... },
//     vocabulary: { total, by_level: { basic, intermediate, advanced } },
//     grammar: {
//       total_corrections: N,
//       top_error_types: [{ error_type, count }, ...] (top 5),
//       recent: [{ original, corrected, error_type }, ...] (last 5)
//     },
//     sessions: { completed: N, total_minutes: M }
//   }

import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

export async function GET() {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = supabaseAdmin();

  const { data: user, error: userErr } = await supabase
    .from("users")
    .select("id, user_context")
    .eq("clerk_user_id", clerkUserId)
    .single();
  if (userErr || !user) {
    return Response.json({ error: "user_not_found" }, { status: 404 });
  }

  // Batch four read-only aggregates in parallel — each is cheap on its
  // own and ordering doesn't matter for assembly.
  const [vocabAll, grammarAll, grammarRecent, sessionsAgg] = await Promise.all([
    supabase
      .from("user_vocabulary")
      .select("level", { count: "exact" })
      .eq("user_id", user.id),
    supabase
      .from("user_grammar_corrections")
      .select("error_type", { count: "exact" })
      .eq("user_id", user.id),
    supabase
      .from("user_grammar_corrections")
      .select("original_text, corrected_text, error_type, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("sessions")
      .select("duration_seconds", { count: "exact" })
      .eq("user_id", user.id)
      .eq("status", "completed"),
  ]);

  // Tally vocabulary by level in JS — Supabase JS doesn't expose
  // GROUP BY directly without an RPC, and the dataset is small.
  const byLevel = { basic: 0, intermediate: 0, advanced: 0 } as Record<string, number>;
  for (const v of vocabAll.data ?? []) {
    if (v.level && byLevel[v.level] !== undefined) byLevel[v.level] += 1;
  }
  // unlevelled words get counted into the total separately
  const vocabTotal = vocabAll.count ?? vocabAll.data?.length ?? 0;

  // Tally grammar error types — top 5.
  const errorCounts = new Map<string, number>();
  for (const c of grammarAll.data ?? []) {
    const key = c.error_type;
    errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
  }
  const topErrorTypes = Array.from(errorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([error_type, count]) => ({ error_type, count }));

  // Sum session minutes.
  const totalSeconds = (sessionsAgg.data ?? []).reduce(
    (sum, s) => sum + (s.duration_seconds ?? 0),
    0,
  );

  return Response.json({
    user_context: user.user_context ?? {},
    vocabulary: {
      total: vocabTotal,
      by_level: byLevel,
    },
    grammar: {
      total_corrections: grammarAll.count ?? 0,
      top_error_types: topErrorTypes,
      recent: grammarRecent.data ?? [],
    },
    sessions: {
      completed: sessionsAgg.count ?? 0,
      total_minutes: Math.round(totalSeconds / 60),
    },
  });
}
