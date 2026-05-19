// Upstream WS connection to Google Gemini Live.
//
// Day 1 scope:
//   - Open the WS with API key in the `?key=` query param (AI Studio path).
//   - Send the initial `setup` message with model + system_instruction +
//     response_modalities so Google knows what we're asking for.
//   - Hand the open WebSocket back to the caller, which wires up the
//     bidirectional pipe to the client.
//
// We intentionally do not parse mid-session messages here — the gateway
// just forwards bytes. If we ever need to inspect (cost tracking, content
// moderation), that lives in a separate decorator around the WS.

import WebSocket from "ws";
import { loadEnv } from "./env.js";
import { logger } from "./logger.js";

const env = loadEnv();

// Hardcoded Day-1 system prompt. Phrased to keep the model in
// "English conversation tutor for a hispanophone developer" mode.
// We'll move this to a prompts/ table in Week 5 when prompt rotation lands.
const DAY1_SYSTEM_INSTRUCTION = `
You are a friendly English conversation tutor for a Spanish-speaking
software developer (your "student"). The student wants to practise
spoken English in short daily sessions.

Rules:
- Always speak English. If the student switches to Spanish for a phrase
  they don't know, gently model the English version and continue in
  English.
- Keep your turns short and natural (1-3 sentences). This is a
  conversation, not a monologue.
- Don't lecture. Don't correct every mistake. Pick at most one thing
  per turn to gently reformulate.
- Stay on tech-adjacent topics by default (their day at work, a
  technology they used recently, a small career question). The student
  may steer to other topics — follow them.
- If the student goes silent for a few seconds, ask a short follow-up
  question to keep the conversation alive.
`.trim();

export interface OpenUpstreamOptions {
  model?: string;
}

export interface UpstreamConnection {
  ws: WebSocket;
  /** Closes the upstream socket if it's still open, swallowing errors. */
  close(): void;
}

export function openUpstream(
  options: OpenUpstreamOptions = {},
): Promise<UpstreamConnection> {
  const model = options.model ?? env.GEMINI_MODEL;
  const url = `${env.GEMINI_LIVE_WS_URL}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      // Larger buffer so a big audio output chunk doesn't trigger a write
      // back-pressure storm.
      perMessageDeflate: false,
    });

    const closeIfOpen = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };

    const cleanupListeners = () => {
      ws.removeListener("open", onOpen);
      ws.removeListener("error", onError);
    };

    const onOpen = () => {
      // Send setup message — model + system instruction + response modalities.
      // We ask for AUDIO output (and TEXT for transcripts, useful for the
      // live transcription UX on the client). Google echoes user audio
      // transcripts back via `input_audio_transcription` if enabled.
      const setupMessage = {
        setup: {
          model: model.startsWith("models/") ? model : `models/${model}`,
          generation_config: {
            response_modalities: ["AUDIO"],
          },
          system_instruction: {
            parts: [{ text: DAY1_SYSTEM_INSTRUCTION }],
          },
          // Server-side voice activity detection — Google manages turn
          // boundaries. Cheaper + more reliable than client VAD.
          realtime_input_config: {
            automatic_activity_detection: {},
          },
          // Ask the upstream to also send the user's transcribed audio
          // back as text — the client renders this live above the orb.
          input_audio_transcription: {},
          output_audio_transcription: {},
        },
      };
      try {
        ws.send(JSON.stringify(setupMessage));
        logger.info({ model }, "upstream opened, setup sent");
        cleanupListeners();
        resolve({
          ws,
          close: closeIfOpen,
        });
      } catch (err) {
        cleanupListeners();
        closeIfOpen();
        reject(err);
      }
    };

    const onError = (err: Error) => {
      cleanupListeners();
      closeIfOpen();
      reject(err);
    };

    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}
