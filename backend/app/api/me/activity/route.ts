// GET /api/me/activity
//
// Powers the Home dashboard. One round trip returns everything the
// "last 7 days at a glance" header needs:
//
//   {
//     streak_days: N,
//     days: [{ date: "2026-05-21", minutes, sessions }, ... 7 entries
//            oldest → newest, last entry is today in user's timezone],
//     avg_session_minutes: number,   // mean over the 7-day window only
//     total_words: number,           // distinct vocabulary entries
//     total_sessions_window: number, // total sessions over the 7-day window
//   }
//
// Streak rule: consecutive days, ending at today or yesterday (so the
// streak survives until the end of the next day if the user hasn't
// practised yet), where the user completed at least one session. If the
// most recent session is older than yesterday, streak = 0.
//
// We pull 30 days of completed sessions in one query and bucket in JS:
// dataset is tiny (≤90-180 rows per user), and the bucketing logic
// needs to honour the user's timezone — keeping it in JS is simpler
// than wrestling Postgres date_trunc with a per-row timezone.

import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 7;
const LOOKBACK_DAYS = 30; // enough to compute streaks up to ~30 days

export async function GET() {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = supabaseAdmin();

  const { data: user, error: userErr } = await supabase
    .from("users")
    .select("id, timezone")
    .eq("clerk_user_id", clerkUserId)
    .single();
  if (userErr || !user) {
    return Response.json({ error: "user_not_found" }, { status: 404 });
  }

  const tz = user.timezone || "Europe/Madrid";

  const lookbackSinceIso = new Date(
    Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [sessionsRes, vocabRes] = await Promise.all([
    supabase
      .from("sessions")
      .select("started_at, duration_seconds")
      .eq("user_id", user.id)
      .eq("status", "completed")
      .gte("started_at", lookbackSinceIso)
      .order("started_at", { ascending: false }),
    supabase
      .from("user_vocabulary")
      .select("word", { count: "exact", head: true })
      .eq("user_id", user.id),
  ]);

  type SessionRow = { started_at: string; duration_seconds: number | null };
  const sessions: SessionRow[] = sessionsRes.data ?? [];

  // Bucket sessions by the user's local date (YYYY-MM-DD).
  const dayBuckets = new Map<string, { minutes: number; sessions: number }>();
  for (const s of sessions) {
    const dateKey = isoDateInTz(new Date(s.started_at), tz);
    const cur = dayBuckets.get(dateKey) ?? { minutes: 0, sessions: 0 };
    cur.minutes += Math.round((s.duration_seconds ?? 0) / 60);
    cur.sessions += 1;
    dayBuckets.set(dateKey, cur);
  }

  // Build the 7-day window (oldest → newest, today is last).
  const today = isoDateInTz(new Date(), tz);
  const days: { date: string; minutes: number; sessions: number }[] = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i -= 1) {
    const d = addDays(today, -i);
    const bucket = dayBuckets.get(d) ?? { minutes: 0, sessions: 0 };
    days.push({ date: d, minutes: bucket.minutes, sessions: bucket.sessions });
  }

  // Streak: walk backwards from today; allow today itself to be empty
  // (user might not have practised yet) but require the chain to start
  // no earlier than yesterday.
  let streak = 0;
  let cursor = today;
  if ((dayBuckets.get(cursor)?.sessions ?? 0) === 0) {
    // today empty — start counting from yesterday
    cursor = addDays(today, -1);
  }
  while ((dayBuckets.get(cursor)?.sessions ?? 0) > 0) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }

  // Window totals + avg.
  const windowMinutes = days.reduce((a, d) => a + d.minutes, 0);
  const windowSessions = days.reduce((a, d) => a + d.sessions, 0);
  const avgSessionMinutes =
    windowSessions > 0 ? +(windowMinutes / windowSessions).toFixed(1) : 0;

  return Response.json({
    streak_days: streak,
    days,
    avg_session_minutes: avgSessionMinutes,
    total_words: vocabRes.count ?? 0,
    total_sessions_window: windowSessions,
  });
}

// "2026-05-27"-style date string for the given instant in the given IANA
// timezone. Intl gives us the locale-formatted parts safely; no
// dependency on Temporal or date-fns-tz.
function isoDateInTz(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${day}`;
}

function addDays(iso: string, delta: number): string {
  // Parse as UTC noon so DST shifts in any tz can't bump the date.
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10));
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + delta);
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}-${String(base.getUTCDate()).padStart(2, "0")}`;
}
