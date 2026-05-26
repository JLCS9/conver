// POST /api/sessions/[id]/analyze
//
// Triggered by the mobile client after a voice session ends. Reads all
// transcripts of the session, asks Gemini Flash to extract vocabulary +
// grammar corrections + profile updates, and persists them so the next
// session's coach starts with richer context.
//
// Idempotent-ish: safe to retry. Vocabulary UPSERTs increment count;
// grammar corrections INSERT (we accept dupes as a feature — pattern
// frequency matters). Context updates MERGE into the JSONB column.
//
// Auth: Clerk session required (validated by middleware). The session
// must belong to the calling user.

import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { analyzeConversation, type AnalyzedTurn } from "@/lib/sessionAnalyzer";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_req: Request, ctx: RouteContext) {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id: sessionId } = await ctx.params;
  if (!sessionId) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const supabase = supabaseAdmin();

  // 1. Resolve internal user id + verify session belongs to them.
  const { data: user, error: userErr } = await supabase
    .from("users")
    .select("id, user_context")
    .eq("clerk_user_id", clerkUserId)
    .single();
  if (userErr || !user) {
    return Response.json({ error: "user_not_found" }, { status: 404 });
  }

  const { data: session, error: sessErr } = await supabase
    .from("sessions")
    .select("id, user_id")
    .eq("id", sessionId)
    .single();
  if (sessErr || !session) {
    return Response.json({ error: "session_not_found" }, { status: 404 });
  }
  if (session.user_id !== user.id) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  // 2. Load the full transcript (ordered).
  const { data: turns, error: turnsErr } = await supabase
    .from("conversation_transcripts")
    .select("role, text, turn_index")
    .eq("session_id", sessionId)
    .order("turn_index", { ascending: true });

  if (turnsErr) {
    console.error("[/api/sessions/:id/analyze] transcripts read failed", turnsErr);
    return Response.json(
      { error: "db_error", message: turnsErr.message },
      { status: 500 },
    );
  }

  const transcript: AnalyzedTurn[] = (turns ?? []).map((t) => ({
    role: t.role as "user" | "model",
    text: t.text,
  }));

  if (transcript.length === 0) {
    return Response.json({
      ok: true,
      sessionId,
      turnsAnalyzed: 0,
      vocabularyAdded: 0,
      correctionsAdded: 0,
      message: "no transcripts to analyze",
    });
  }

  // 3. Run the LLM extraction. Failures surface as 502 so the client
  //    knows the transcript IS there but the analysis didn't complete —
  //    they can retry the endpoint later without re-running the session.
  let analysis;
  try {
    analysis = await analyzeConversation(transcript);
  } catch (err) {
    console.error("[/api/sessions/:id/analyze] LLM extraction failed", err);
    return Response.json(
      {
        error: "extraction_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  // 4. Persist findings, in parallel where possible.
  //    Vocabulary: UPSERT increments count + updates last_used_at. We
  //                rely on Postgres ON CONFLICT for the increment via
  //                a small RPC-like pattern: select-then-upsert in JS.
  //    Corrections: plain INSERT, dupes allowed (we track frequency).
  //    Context: merge into JSONB without clobbering existing keys.

  let vocabularyAdded = 0;
  let correctionsAdded = 0;

  if (analysis.vocabulary.length > 0) {
    // For each new word, INSERT … ON CONFLICT (user_id, word) DO UPDATE
    // SET count = count + 1, last_used_at = NOW(). Supabase JS upsert
    // doesn't natively support 'increment'; we do per-row upsert with
    // a manual increment fetch+update. Batching: pull current counts
    // for all words in one query, then write deltas in one upsert.
    const words = analysis.vocabulary.map((v) => v.word.toLowerCase().trim());
    const { data: existing } = await supabase
      .from("user_vocabulary")
      .select("word, count")
      .eq("user_id", user.id)
      .in("word", words);

    const countByWord = new Map<string, number>(
      (existing ?? []).map((r) => [r.word, r.count]),
    );

    const rows = analysis.vocabulary.map((v) => {
      const word = v.word.toLowerCase().trim();
      const nextCount = (countByWord.get(word) ?? 0) + 1;
      return {
        user_id: user.id,
        word,
        count: nextCount,
        last_used_at: new Date().toISOString(),
        example_sentence: v.example_sentence,
        level: v.level,
      };
    });

    const { error: vocabErr } = await supabase
      .from("user_vocabulary")
      .upsert(rows, { onConflict: "user_id,word" });
    if (vocabErr) {
      console.error("[/api/sessions/:id/analyze] vocabulary upsert failed", vocabErr);
    } else {
      vocabularyAdded = rows.length;
    }
  }

  if (analysis.corrections.length > 0) {
    const correctionRows = analysis.corrections.map((c) => ({
      user_id: user.id,
      session_id: sessionId,
      original_text: c.original_text,
      corrected_text: c.corrected_text,
      error_type: c.error_type,
      explanation: c.explanation ?? null,
    }));
    const { error: corrErr } = await supabase
      .from("user_grammar_corrections")
      .insert(correctionRows);
    if (corrErr) {
      console.error("[/api/sessions/:id/analyze] corrections insert failed", corrErr);
    } else {
      correctionsAdded = correctionRows.length;
    }
  }

  // 5. Merge context updates into users.user_context. We do a manual
  //    JSON merge in JS (instead of jsonb || in SQL) so we can union
  //    arrays like interests/topics rather than overwriting.
  const updates = analysis.context_updates;
  if (Object.keys(updates).length > 0) {
    type UserContext = {
      profession?: string;
      interests?: string[];
      speaking_level?: "beginner" | "intermediate" | "advanced";
      last_topics?: string[];
      focus_areas?: string[];
    };
    const existingCtx = (user.user_context as UserContext) ?? {};

    const mergeArr = (a: string[] = [], b: string[] = []) =>
      Array.from(new Set([...a, ...b].map((s) => s.toLowerCase().trim()).filter(Boolean))).slice(0, 20);

    const nextCtx: UserContext = {
      profession: updates.profession ?? existingCtx.profession,
      speaking_level: updates.speaking_level ?? existingCtx.speaking_level,
      interests: updates.interests
        ? mergeArr(existingCtx.interests, updates.interests)
        : existingCtx.interests,
      // last_topics: replace rather than union — we want recency.
      last_topics: updates.last_topics ?? existingCtx.last_topics,
      // focus_areas: union, with most recent at front.
      focus_areas: updates.focus_areas
        ? Array.from(
            new Set([...(updates.focus_areas ?? []), ...(existingCtx.focus_areas ?? [])]),
          ).slice(0, 10)
        : existingCtx.focus_areas,
    };

    const { error: ctxErr } = await supabase
      .from("users")
      .update({ user_context: nextCtx })
      .eq("id", user.id);
    if (ctxErr) {
      console.error("[/api/sessions/:id/analyze] context update failed", ctxErr);
    }
  }

  return Response.json({
    ok: true,
    sessionId,
    turnsAnalyzed: transcript.length,
    vocabularyAdded,
    correctionsAdded,
    contextUpdated: Object.keys(updates).length > 0,
  });
}
