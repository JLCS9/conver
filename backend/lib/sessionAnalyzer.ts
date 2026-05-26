// Post-session conversation analyzer.
//
// Reads all conversation_transcripts rows for a given session, sends them
// to Gemini 2.5 Flash with a strict JSON-output prompt, and returns three
// structured signals that downstream callers can persist to Supabase:
//
//   1. vocabulary   — words the user actually said (NOT the coach), with
//                     CEFR-ish difficulty level and an example sentence.
//   2. corrections  — grammar mistakes the user made + the natural
//                     repair the coach used (or should have used).
//   3. context_updates — newly-learned facts about the user (profession,
//                       interests, speaking level, topics) we should
//                       merge into users.user_context for next session.
//
// This module is pure — no Supabase, no Clerk. The caller (the
// /api/sessions/[id]/analyze route) handles persistence so we can unit-
// test the extraction logic in isolation.

import { GoogleGenAI } from "@google/genai";

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  // Don't throw at module load — the analyzer endpoint will surface a
  // 500 with the missing-key error so we get a clear log line instead
  // of crashing the whole backend boot.
  console.warn("[sessionAnalyzer] GEMINI_API_KEY missing — analyze calls will fail");
}

const client = apiKey ? new GoogleGenAI({ apiKey }) : null;

export interface AnalyzedTurn {
  role: "user" | "model";
  text: string;
}

export interface ExtractedVocabulary {
  word: string;
  level: "basic" | "intermediate" | "advanced";
  example_sentence: string;
}

export interface ExtractedCorrection {
  original_text: string;
  corrected_text: string;
  error_type: string;
  explanation?: string;
}

export interface ExtractedContextDelta {
  profession?: string;
  interests?: string[];
  speaking_level?: "beginner" | "intermediate" | "advanced";
  last_topics?: string[];
  focus_areas?: string[];
}

export interface AnalysisResult {
  vocabulary: ExtractedVocabulary[];
  corrections: ExtractedCorrection[];
  context_updates: ExtractedContextDelta;
}

const EXTRACTION_PROMPT = `
You are a post-session analyser for an English conversation app. The
transcript below is from a session between a Spanish-speaking student
and an AI coach. Extract structured signals from it.

Return ONE JSON object that matches this exact TypeScript shape (no
extra fields, no prose around it):

{
  "vocabulary": [
    {
      "word": "string (lowercased, lemmatised — e.g. 'work' not 'worked')",
      "level": "basic" | "intermediate" | "advanced",
      "example_sentence": "string — the actual sentence the student said where this word appeared"
    }
  ],
  "corrections": [
    {
      "original_text": "string — what the student actually said (verbatim)",
      "corrected_text": "string — the natural way to say it",
      "error_type": "verb_tense" | "preposition" | "subject_verb_agreement" | "article" | "pluralization" | "word_order" | "phrasal_verb" | "other",
      "explanation": "string — ONE short line, plain Spanish"
    }
  ],
  "context_updates": {
    "profession": "string (only include if new evidence)",
    "interests": ["string"],
    "speaking_level": "beginner" | "intermediate" | "advanced",
    "last_topics": ["string"],
    "focus_areas": ["string — grammar pattern the student needs to practice"]
  }
}

RULES:
- Vocabulary: ONLY words the STUDENT said (role=user turns), not the
  coach's words. Skip very common stopwords (a, the, is, and, of, in,
  to, you, I...). Cap at 30 most meaningful words. Level the student's
  actual production, not perfect English.
- Corrections: only include CLEAR grammar errors the student made.
  Skip pronunciation issues. Skip acceptable informal speech. Cap at 10.
- Context updates: include ONLY fields where the transcript provides
  evidence. Leave others out (do NOT default-fill). interests/topics
  should be 1-3 items each, not laundry lists.
- If the student barely said anything (e.g. ≤2 short utterances),
  return empty arrays / object.
- Output ONLY the JSON object. No markdown fences, no commentary.

TRANSCRIPT:
`.trim();

/**
 * Extract vocabulary, grammar corrections and profile updates from a
 * conversation. The transcript can be short — the LLM is instructed to
 * return empty fields rather than fabricate.
 *
 * Throws on missing API key or LLM failure. Returns zero-filled results
 * if the LLM responds with valid JSON but no findings.
 */
export async function analyzeConversation(
  turns: AnalyzedTurn[],
): Promise<AnalysisResult> {
  if (!client) throw new Error("GEMINI_API_KEY missing");

  if (turns.length === 0) {
    return { vocabulary: [], corrections: [], context_updates: {} };
  }

  // Format the transcript as alternating speaker lines. Newer transcripts
  // typically alternate user/model so this reads naturally.
  const transcriptText = turns
    .map((t) => `${t.role === "user" ? "STUDENT" : "COACH"}: ${t.text}`)
    .join("\n");

  const response = await client.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        role: "user",
        parts: [{ text: `${EXTRACTION_PROMPT}\n\n${transcriptText}` }],
      },
    ],
    config: {
      // Strict JSON mode — we parse the output, no room for prose.
      responseMimeType: "application/json",
      // Bias toward grounded extraction over creative interpretation.
      temperature: 0.2,
      maxOutputTokens: 4000,
    },
  });

  const raw = response.text?.trim() ?? "";
  if (!raw) {
    throw new Error("LLM returned empty extraction response");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `LLM returned non-JSON: ${(err as Error).message} | first 200B: ${raw.slice(0, 200)}`,
    );
  }

  // Light validation + coercion. We don't use Zod here for speed — the
  // shape is small and the LLM is well-behaved in JSON mode. Worst case
  // a missing field falls back to its empty default.
  const result = parsed as Partial<AnalysisResult>;
  return {
    vocabulary: Array.isArray(result.vocabulary) ? result.vocabulary : [],
    corrections: Array.isArray(result.corrections) ? result.corrections : [],
    context_updates: typeof result.context_updates === "object" && result.context_updates
      ? result.context_updates
      : {},
  };
}
