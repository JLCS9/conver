// Gemini Flash text completion. The new audio pipeline keeps Gemini
// strictly in the text role: Deepgram has already done STT, ElevenLabs
// will do TTS — Gemini just generates the reply text given conversation
// history + the latest user message, streamed token-by-token so we can
// start feeding ElevenLabs before the full reply is ready.
//
// Choice rationale: Gemini 2.5 Flash sits in the cost sweet spot
// ($0.075/M input tokens, $0.30/M output as of late 2026). A typical
// 1-2 sentence tutor reply is ~30-60 output tokens, so per-turn cost is
// well under a cent. If we ever want a smarter model for premium tier,
// we just swap the model id in env.

import { GoogleGenAI } from "@google/genai";
import type { Logger } from "pino";
import { loadEnv } from "./env.js";

const env = loadEnv();
const client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

export type Role = "user" | "model";
export interface ChatMessage {
  role: Role;
  text: string;
}

export interface StreamLLMOptions {
  /** Full conversation history (does NOT include `userMessage` — we
   *  append that internally). */
  history: ChatMessage[];
  /** The user's latest utterance (Deepgram final transcript). */
  userMessage: string;
  /** System prompt — passed via systemInstruction so it doesn't eat
   *  history tokens on every turn. */
  systemInstruction: string;
  /** Aborts the stream mid-generation. Used for barge-in. */
  signal?: AbortSignal;
  log: Logger;
}

/**
 * Streams the model's reply chunk-by-chunk. Each yielded string is an
 * incremental text delta — the consumer should accumulate them for the
 * final reply and forward each delta to ElevenLabs as it arrives so TTS
 * can start synthesising before the LLM finishes.
 *
 * Generator pattern over callbacks because the consumer is a single
 * orchestrator coroutine; back-pressure naturally falls out of the
 * `for await` loop.
 */
export async function* streamLLMResponse(
  opts: StreamLLMOptions,
): AsyncGenerator<string, void, void> {
  const { history, userMessage, systemInstruction, signal, log } = opts;

  // Convert our internal {role,text} shape to Gemini's contents shape.
  // Gemini uses `parts: [{text}]` and the role "model" for assistant
  // turns (not "assistant" like OpenAI).
  const contents = [
    ...history.map((m) => ({
      role: m.role,
      parts: [{ text: m.text }],
    })),
    {
      role: "user" as const,
      parts: [{ text: userMessage }],
    },
  ];

  let stream;
  try {
    stream = await client.models.generateContentStream({
      model: env.GEMINI_MODEL,
      contents,
      config: {
        systemInstruction,
        // Keep replies short — this is conversational, not essay-writing.
        // 1-2 sentences * ~30 tokens/sentence ≈ 80 tokens cap.
        maxOutputTokens: 200,
        // Slightly creative but mostly grounded. Higher and the model
        // starts inventing context the student didn't provide
        // (the Day-4 hallucination report we already fought).
        temperature: 0.7,
      },
    });
  } catch (err) {
    log.error({ err }, "gemini stream init failed");
    throw err;
  }

  for await (const chunk of stream) {
    if (signal?.aborted) {
      log.info("gemini stream aborted (barge-in)");
      return;
    }
    // The SDK returns chunks shaped like a partial GenerateContentResponse.
    // The text we want is concatenation of all candidate parts.
    const delta = chunk?.text ?? "";
    if (delta) yield delta;
  }
}

/** Inputs into the dynamic system prompt — everything we know about
 *  the user that should bias the coach's behaviour this session. */
export interface SystemPromptInputs {
  profession?: string;
  interests?: string[];
  speakingLevel?: "beginner" | "intermediate" | "advanced";
  lastTopics?: string[];
  /** Words the user already uses a lot — coach should suggest synonyms
   *  or richer alternatives instead of leaning on these. */
  overusedWords?: string[];
  /** Grammar patterns the user has consistently got wrong — coach
   *  should look for opportunities to model the correct form. */
  focusGrammar?: string[];
}

/**
 * Builds the per-session system prompt. The base instructions cover
 * style + grammar correction approach + how to handle STT noise; the
 * user-specific sections (added at the end) personalise tone, topic
 * preference, and what the coach should actively try to teach this
 * session. All personalisation is OPTIONAL — for a brand-new user
 * with empty memory, this returns a clean generic coach prompt.
 */
export function buildSystemPrompt(inputs: SystemPromptInputs = {}): string {
  const base = `
You are a friendly English conversation coach for a Spanish-speaking
adult. Speak only English, in short natural turns of 1–2 sentences.
Keep things warm and encouraging.

CORE PURPOSE — GRAMMAR CORRECTION VIA MODELLING
When the student makes a grammar mistake, gently model the correct
form by naturally repeating their idea the right way, then move the
conversation forward. NEVER lecture, NEVER explain rules, NEVER quote
grammar terms.

  Examples:
    Student: "I goed to the store yesterday."
    Coach:   "Oh nice, you went to the store yesterday! What did you buy?"

    Student: "I have 30 years."
    Coach:   "30 years old — a great age. What are you up to these days?"

    Student: "I am living in Madrid since 2020."
    Coach:   "Living in Madrid since 2020 — you've been there a while! What
              do you love about it?"

Correct at most one error per turn. Pick the most important one. If
the student's sentence is grammatically fine, just continue naturally.

HANDLING IMPERFECT TRANSCRIPTION
The student speaks English with a Spanish accent through a phone mic,
so the speech-to-text upstream sometimes garbles short utterances or
runs words together.
- If you got even a few recognisable English words, work with those
  rather than asking the student to repeat — flow beats accuracy.
- Use "Sorry, could you say that again?" only as a last resort when
  the transcript is genuinely unparseable across multiple turns.
- Never invent context the student didn't provide.

STYLE
- Default tone: warm, curious, conversational. NOT lecturer.
- If the student uses a Spanish word, model the English version once
  and continue in English without making a big deal of it.
- Open new sessions with one warm greeting and one easy open-ended
  question. Don't dump multiple questions at once.
  `.trim();

  // Build the personalisation section only if we have something to say.
  const sections: string[] = [];

  if (inputs.profession || (inputs.interests && inputs.interests.length > 0)) {
    const lines: string[] = ["ABOUT THIS STUDENT (use naturally, don't recite):"];
    if (inputs.profession) lines.push(`- They work as: ${inputs.profession}`);
    if (inputs.interests && inputs.interests.length > 0) {
      lines.push(`- They're interested in: ${inputs.interests.join(", ")}`);
    }
    sections.push(lines.join("\n"));
  }

  if (inputs.lastTopics && inputs.lastTopics.length > 0) {
    sections.push(
      `RECENT TOPICS (it's fine to reference these casually if relevant):\n- ${inputs.lastTopics.slice(0, 3).join("\n- ")}`,
    );
  }

  if (inputs.overusedWords && inputs.overusedWords.length > 0) {
    sections.push(
      `VOCABULARY EXPANSION
The student leans heavily on these basic words: ${inputs.overusedWords.slice(0, 10).join(", ")}.
When the natural moment comes, introduce a richer alternative by
using it yourself or asking a question that invites it. Don't push
new vocab unprompted — wait for the conversation to call for it.`,
    );
  }

  if (inputs.focusGrammar && inputs.focusGrammar.length > 0) {
    sections.push(
      `GRAMMAR FOCUS THIS SESSION
The student has recently struggled with these patterns:
${inputs.focusGrammar.slice(0, 5).map((p) => `- ${p}`).join("\n")}
Look for opportunities to model the correct form when these come up.`,
    );
  }

  if (inputs.speakingLevel) {
    const levelHint =
      inputs.speakingLevel === "beginner"
        ? "Use simple vocabulary and short sentences. Speak slowly and clearly."
        : inputs.speakingLevel === "advanced"
        ? "You can use rich vocabulary, idioms, and complex sentence structures. Challenge them."
        : "Use natural, everyday vocabulary. Mix short and slightly longer sentences.";
    sections.push(`SPEAKING LEVEL: ${inputs.speakingLevel} — ${levelHint}`);
  }

  if (sections.length === 0) {
    return base;
  }

  return `${base}\n\n---\n\n${sections.join("\n\n")}`;
}

/**
 * @deprecated Static constant kept for any callers still importing it
 * during the Day 7 transition. Equivalent to calling buildSystemPrompt()
 * with no inputs — the generic, brand-new-user coach prompt.
 */
export const SYSTEM_INSTRUCTION = buildSystemPrompt();
