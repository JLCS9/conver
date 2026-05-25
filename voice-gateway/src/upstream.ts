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

// Day-4 system prompt — rewritten after the Day-4 hallucination report.
// The previous version told the model to "fill silences with follow-up
// questions" which, combined with the default high temperature, caused
// Gemini's native-audio model to invent user turns on unclear audio
// (e.g. responding to a silent simulator with "Sounds like you were
// busy!"). We're now explicit that unclear audio must trigger a clarify
// request, never a guess. We'll move this to a prompts/ table in
// Week 5 when prompt rotation lands.
const DAY1_SYSTEM_INSTRUCTION = `
You are an English conversation tutor for a Spanish-speaking software
developer. Speak only English, in short natural turns of 1-2 sentences.

CRITICAL — handling unclear audio:
- Only respond to words you clearly heard the student say. Never paraphrase,
  summarise, or assume what the student "probably" said.
- If the student's audio is unclear, garbled, partial, or you are not
  confident what they said, ask them to repeat: "Sorry, could you say that
  again?" Do not guess.
- If the student says nothing or only a brief acknowledgement ("hi",
  "yeah", "ok"), respond to exactly that — do not invent context they did
  not provide (e.g. do not assume their day was busy unless they said so).
- If there is silence, stay quiet. Do not fill gaps with follow-ups.

Style:
- Don't lecture. Reformulate at most one small error per turn, gently.
- Stay on tech-adjacent topics by default; follow the student if they steer.
- If the student uses a Spanish word, model the English version once and
  continue in English.
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
      //
      // `speech_config.language_code` pins BOTH the input-transcription
      // language hint AND the TTS output language. Without it Google
      // auto-detects and on noisy / accented audio happily transcribes
      // English-with-a-Spanish-accent as Vietnamese or Arabic. We're
      // teaching English so we hard-code "en-US"; the student speaks
      // English even when broken. (When we add a Spanish onboarding mode
      // later, this becomes a per-session setting.)
      //
      // `voice_name: "Aoede"` is a Google-preset English female voice
      // that works well at conversational pace. Other native-audio
      // voices to evaluate later: Puck, Kore, Charon, Fenrir, Leda.
      // Day-4 audit findings baked in:
      //
      // 1) `temperature: 0.6` — default ~1.0 was letting the native-audio
      //    model invent user statements. 0.6 is the sweet spot for an
      //    instruction-following tutor (still natural, much less drift).
      //    `top_p: 0.85` adds a complementary cap on token sampling.
      //
      // 2) `automatic_activity_detection` with LOW sensitivity +
      //    `silence_duration_ms: 1200` — defaults fired too eagerly,
      //    interpreting any breath as "user speaking", which cut model
      //    turns short and triggered the hallucination cycle.
      //
      // 3) `activity_handling: NO_INTERRUPTION` — explicitly tell the
      //    server NOT to barge into model turns. Cleaner conversation.
      //
      // 4) `proactive_audio: false` — we never want Gemini speaking
      //    spontaneously; turns must be triggered by real user audio.
      //
      // 5) `media_resolution: MEDIA_RESOLUTION_LOW` — audio-only, so the
      //    visual budget is wasted. ~30% fewer tokens billed.
      const setupMessage = {
        setup: {
          model: model.startsWith("models/") ? model : `models/${model}`,
          generation_config: {
            response_modalities: ["AUDIO"],
            temperature: 0.6,
            top_p: 0.85,
            candidate_count: 1,
            media_resolution: "MEDIA_RESOLUTION_LOW",
            speech_config: {
              language_code: "en-US",
              voice_config: {
                prebuilt_voice_config: { voice_name: "Aoede" },
              },
            },
          },
          system_instruction: {
            parts: [{ text: DAY1_SYSTEM_INSTRUCTION }],
          },
          // Server-side voice activity detection — Google manages turn
          // boundaries. Cheaper + more reliable than client VAD.
          realtime_input_config: {
            automatic_activity_detection: {
              disabled: false,
              start_of_speech_sensitivity: "START_SENSITIVITY_LOW",
              end_of_speech_sensitivity: "END_SENSITIVITY_LOW",
              prefix_padding_ms: 200,
              silence_duration_ms: 1200,
            },
            activity_handling: "NO_INTERRUPTION",
            turn_coverage: "TURN_INCLUDES_ONLY_ACTIVITY",
          },
          proactivity: { proactive_audio: false },
          enable_affective_dialog: false,
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
