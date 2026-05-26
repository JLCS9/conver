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

// Day 5-K system prompt — rewritten after the first end-to-end test on a
// real iPhone. The Day-4 version asked the model to repeat back "Sorry,
// could you say that again?" whenever STT was uncertain. In practice
// Gemini's STT misrecognizes accented English very often (transcribes as
// Khmer, Thai, Arabic — phoneme-similar scripts) and the repeat-prompt
// killed conversational flow on every other turn. New strategy: stay in
// the conversation. If STT gives a non-English fragment, treat it as
// silence and keep listening; if it gives partial English, respond to
// what was understood. Only ask to repeat if the student has actively
// produced clear speech that we genuinely couldn't parse.
const DAY1_SYSTEM_INSTRUCTION = `
You are a friendly English conversation coach for a Spanish-speaking
adult professional. Speak only English, in short natural turns of 1-2
sentences. Keep things warm and encouraging.

HANDLING IMPERFECT TRANSCRIPTION
The student is speaking English with a Spanish accent through a phone
mic, so the speech-to-text upstream often misrecognises their words —
sometimes outputting fragments in unrelated scripts (Khmer, Thai,
Arabic, random Latin gibberish). When that happens:
- Treat the misrecognised fragment as if the student said nothing at
  all and stay silent. Wait for their next attempt.
- Do NOT respond with "Sorry, could you say that again?" on every
  unclear turn — that breaks the conversation. Use it sparingly, only
  when the student has clearly tried to speak and you genuinely cannot
  pick up any English content across multiple chunks.
- If you got even one or two recognisable English words, work with
  those rather than asking to repeat. The student values flow over
  perfect comprehension.

WHAT NOT TO HALLUCINATE
- Never invent context the student did not provide (don't assume they
  had a busy day, a difficult bug, etc. unless they said so).
- If the input is silence or just a noise marker, stay quiet.
- Never paraphrase or "guess" what the student probably meant —
  respond only to words you actually heard.

STYLE
- Don't lecture. Reformulate at most one small error per turn, gently,
  by repeating it back the natural way.
- Default to tech-adjacent topics (work, projects, learning) but
  follow the student wherever they steer.
- If the student uses a Spanish word, model the English version once
  and continue in English.
- Open the conversation with a warm one-sentence greeting, then ask
  one easy open-ended question (e.g. "Hi! What are you working on
  today?").
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
      // Day-4 audit findings baked in — SAFE SUBSET version.
      //
      // First version of this fix (commit c9c86ea) added several fields
      // from Google's most recent Live API docs (`media_resolution`,
      // `proactivity`, `enable_affective_dialog`, VAD sensitivity enums,
      // `activity_handling`, `turn_coverage`). User reported the loop
      // went silent after deploy — strongly suggests Gemini's v1beta
      // endpoint rejected the setup on one of those experimental fields
      // (no setupComplete arrives → no audio flows in either direction).
      //
      // Rolling back to a minimal proven-safe config that still addresses
      // the hallucination root cause:
      //   - `temperature: 0.6` is universal generation_config, safe.
      //   - System prompt rewrite (DAY1_SYSTEM_INSTRUCTION) does most of
      //     the heavy lifting against hallucination on its own — it
      //     explicitly tells the model not to guess.
      // Everything else is left at Gemini's default to avoid the silent
      // setup rejection. We'll add the VAD/proactivity tuning back one
      // field at a time once we know which one was rejected.
      const setupMessage = {
        setup: {
          model: model.startsWith("models/") ? model : `models/${model}`,
          generation_config: {
            response_modalities: ["AUDIO"],
            temperature: 0.6,
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
          // Server-side voice activity detection — defaults. We left the
          // tuning out for now; the system prompt is the primary lever
          // against hallucination.
          realtime_input_config: {
            automatic_activity_detection: {},
          },
          // Ask the upstream to also send the user's transcribed audio
          // back as text — the client renders this live above the orb.
          //
          // Day 5-J revert: tried adding `language_code: "en-US"` here
          // (Day 5-F) to force Gemini's STT to interpret input as
          // English. Gemini's v1beta DOES NOT ACCEPT that field on
          // these sub-configs — only on `speech_config`. It rejected
          // every setup with 1007 "Unknown name language_code at
          // 'setup.input_audio_transcription'" → upstream closed
          // abnormally → gateway aborted client WS → user saw
          // "No script URL / WS closed 1005" on iPhone. Back to empty
          // objects, which DO enable the transcription stream (the
          // logs from Day 4 confirmed user/model transcripts flowed
          // with this exact shape). Language hinting for STT input is
          // already handled by `speech_config.language_code` above
          // (per Google's docs the speech_config rate applies to both
          // input STT and TTS output).
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
