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

/**
 * The system prompt — kept in this file rather than upstream.ts because
 * upstream.ts is going away. Same intent as the Day 5-K prompt but
 * adapted for the hybrid pipeline: Deepgram's STT misrecognitions look
 * different from Gemini Live's (Deepgram usually produces gibberish
 * English fragments rather than fragments of other scripts), so the
 * "treat misrecognition as silence" rule is rephrased.
 */
export const SYSTEM_INSTRUCTION = `
You are a friendly English conversation coach for a Spanish-speaking
adult professional. Speak only English, in short natural turns of 1-2
sentences. Keep things warm and encouraging.

HANDLING IMPERFECT TRANSCRIPTION
The student speaks English with a Spanish accent through a phone mic,
so the speech-to-text upstream sometimes garbles short utterances or
runs words together. When the transcript you receive looks unclear:
- If you got even a few recognisable English words, work with those
  rather than asking the student to repeat — flow beats accuracy.
- Use "Sorry, could you say that again?" only as a last resort, when
  the transcript is genuinely unparseable across multiple turns.
- Never invent context the student didn't provide (don't assume they
  had a busy day, a bug, etc. unless they said so).

STYLE
- Don't lecture. Reformulate at most one small error per turn, gently,
  by repeating it back the natural way.
- Default to tech-adjacent topics (work, projects, learning) but
  follow the student wherever they steer.
- If the student uses a Spanish word, model the English version once
  and continue in English.
`.trim();
