// ElevenLabs streaming TTS client. Uses the `stream-input` WebSocket
// endpoint so we can feed text chunks as they arrive from the LLM and
// start receiving audio bytes within ~50ms of the first text chunk.
//
// Wire format reference:
//   wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input
//     ?model_id={model_id}
//     &output_format={format}
//   First message (BOS): { text: " ", voice_settings, xi_api_key }
//   Each subsequent text message: { text: "..." }   ← incremental text
//   Flush: { text: " ", try_trigger_generation: true } at logical breaks
//   End-of-stream: { text: "" }
//   Server messages: { audio: "<base64 PCM>", isFinal: bool, alignment: {...} }
//
// We choose output_format `pcm_24000` to match what the mobile audio
// playback path already expects (Gemini Live previously emitted 24 kHz
// PCM; AudioPlayback.tsx's WAV header is hardcoded for 24 kHz). Keeping
// the same rate means no mobile-side change.

import WebSocket from "ws";
import type { Logger } from "pino";
import { loadEnv } from "./env.js";

const env = loadEnv();

export interface ElevenLabsTtsCallbacks {
  /** Each audio frame as raw PCM 16-bit LE 24 kHz mono bytes. */
  onAudio: (pcm: Buffer) => void;
  /** Fired when ElevenLabs signals the synthesis is fully drained. */
  onComplete: () => void;
  /** Fatal — caller should abort the turn. */
  onError: (err: Error) => void;
}

export interface ElevenLabsTtsClient {
  /** Append an incremental text chunk from the LLM. */
  appendText(text: string): void;
  /** Tell ElevenLabs we have nothing more to send for this turn. */
  flush(): void;
  /** Close the WS unconditionally — used for barge-in. */
  close(): void;
}

/**
 * Opens a TTS streaming session for one model turn. Caller appends
 * text chunks as the LLM produces them, then calls `flush()` when the
 * LLM stream finishes. Audio frames flow through `onAudio`.
 *
 * One client per turn — closing and reopening on each turn is cheap
 * (~50ms WS handshake) and keeps state simple. Future optimisation:
 * pool connections.
 */
export function openElevenLabsTts(
  callbacks: ElevenLabsTtsCallbacks,
  log: Logger,
): ElevenLabsTtsClient {
  const url =
    `wss://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}` +
    `/stream-input?model_id=${env.ELEVENLABS_MODEL_ID}` +
    `&output_format=pcm_24000`;

  const ws = new WebSocket(url, {
    headers: {
      "xi-api-key": env.ELEVENLABS_API_KEY,
    },
  });

  // Buffer text chunks that arrive before the WS opens — we don't want
  // to lose the first ~50ms of LLM output to the handshake.
  const pendingText: string[] = [];
  let isOpen = false;
  let bosSent = false;
  let closed = false;

  const sendRaw = (payload: object) => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      log.warn({ err }, "elevenlabs send failed");
    }
  };

  const sendBosIfNeeded = () => {
    if (bosSent) return;
    bosSent = true;
    // Beginning-of-stream message. The " " (single space) is required
    // by ElevenLabs as the BOS marker. voice_settings here override
    // the default voice profile for this connection only.
    sendRaw({
      text: " ",
      voice_settings: {
        // Stability lower = more expressive. 0.5 is the dashboard default.
        stability: 0.5,
        similarity_boost: 0.8,
        // Speed slightly above 1 keeps the tutor lively without sounding
        // rushed. Adjust by feel after a few demo runs.
        speed: 1.05,
      },
      // Both header (xi-api-key) and query/body auth are accepted; we
      // already sent it as a header. Including in the body is a no-op
      // on success and acts as a fallback if a future ElevenLabs change
      // tightens header parsing.
      xi_api_key: env.ELEVENLABS_API_KEY,
    });
  };

  ws.on("open", () => {
    isOpen = true;
    log.info("elevenlabs open");
    sendBosIfNeeded();
    // Drain any text that came in during the handshake.
    for (const text of pendingText) {
      sendRaw({ text });
    }
    pendingText.length = 0;
  });

  ws.on("message", (raw) => {
    let msg: { audio?: string; isFinal?: boolean; error?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log.warn({ raw: raw.toString().slice(0, 200) }, "elevenlabs non-JSON frame");
      return;
    }

    if (msg.error) {
      const err = new Error(`elevenlabs upstream error: ${msg.error}`);
      log.error({ err }, "elevenlabs error frame");
      callbacks.onError(err);
      return;
    }

    if (msg.audio) {
      const pcm = Buffer.from(msg.audio, "base64");
      callbacks.onAudio(pcm);
    }

    if (msg.isFinal) {
      callbacks.onComplete();
    }
  });

  ws.on("error", (err) => {
    log.error({ err }, "elevenlabs ws error");
    callbacks.onError(err);
  });

  ws.on("close", (code, reason) => {
    log.info({ code, reason: reason?.toString() }, "elevenlabs closed");
  });

  return {
    appendText(text) {
      if (closed) return;
      if (!isOpen) {
        pendingText.push(text);
        return;
      }
      sendBosIfNeeded();
      sendRaw({ text });
    },
    flush() {
      if (closed) return;
      // Empty-string text is the "end-of-stream" marker per ElevenLabs
      // docs. The server will drain its buffer and send isFinal: true,
      // at which point we fire onComplete and close from this side.
      sendRaw({ text: "" });
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
