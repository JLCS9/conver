// Deepgram STT streaming client. Wraps `@deepgram/sdk`'s ListenLiveClient
// in a small interface tailored to our pipeline: forward raw PCM 16 kHz
// mono bytes from the mobile client, get back partial + final transcripts
// plus an utterance-end signal we use to mark turn boundaries.
//
// Why a wrapper:
//   - The SDK exposes a low-level event emitter; we only care about a
//     handful of events and the rest are noise.
//   - We want a single `close()` path for cleanup regardless of who
//     initiated the end (client gone, session timeout, error mid-turn).
//   - Easier to mock in tests / swap to another STT provider later — the
//     orchestrator never imports `@deepgram/sdk` directly.

import {
  createClient,
  LiveTranscriptionEvents,
  type LiveClient,
} from "@deepgram/sdk";
import type { Logger } from "pino";
import { loadEnv } from "./env.js";

const env = loadEnv();

export interface DeepgramSttCallbacks {
  /** Interim transcript — text grows/changes as more audio arrives.
   *  Useful for live "you said:" rendering on the client. */
  onPartial: (text: string) => void;
  /** Stable transcript — Deepgram is confident it's not going to change. */
  onFinal: (text: string) => void;
  /** Fired when Deepgram's endpointing detects the user has finished a
   *  full utterance (silence > utterance_end_ms). Trigger LLM here. */
  onUtteranceEnd: () => void;
  /** Fatal — connection lost or rejected. Caller should abort the turn. */
  onError: (err: Error) => void;
  /** Fired when the WS closes cleanly. */
  onClose?: () => void;
}

export interface DeepgramSttClient {
  /** Forward a raw PCM 16 kHz mono int16 LE audio chunk to Deepgram. */
  sendAudio(buffer: Buffer): void;
  /** Manually finalize the current utterance (rarely needed; Deepgram's
   *  endpointing handles it most of the time). */
  finalize(): void;
  /** Close the upstream connection and stop receiving events. */
  close(): void;
}

/**
 * Opens a Deepgram streaming connection configured for our exact wire
 * format and returns a thin handle for the orchestrator to drive.
 *
 * Config rationale:
 *   - `model: nova-3` (env-overridable) — best accent-robust STT we
 *     benchmarked for Spanish-speaker English.
 *   - `encoding: linear16, sample_rate: 16000` — matches the iOS
 *     expo-audio capture exactly. No transcoding needed.
 *   - `interim_results: true` — gives us partial transcripts for live
 *     UI rendering. The client only commits to history on `onFinal`.
 *   - `smart_format: true` — punctuation + capitalisation. Saves the
 *     LLM from having to guess sentence boundaries.
 *   - `utterance_end_ms: 1000` — fire utterance-end after 1s of silence.
 *     Shorter felt jumpy in casual testing; longer felt laggy.
 *   - `endpointing: 300` — VAD detects end-of-speech after 300ms. Used
 *     internally by Deepgram to flush final transcripts.
 *   - `vad_events: true` — also surface SpeechStarted events so the
 *     orchestrator can interrupt an in-flight TTS.
 *   - `language: "en"` — pin to English. Don't try multilingual yet.
 */
export function openDeepgramStt(
  callbacks: DeepgramSttCallbacks,
  log: Logger,
): DeepgramSttClient {
  const dg = createClient(env.DEEPGRAM_API_KEY);

  const live: LiveClient = dg.listen.live({
    model: env.DEEPGRAM_MODEL,
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    interim_results: true,
    smart_format: true,
    utterance_end_ms: 1000,
    endpointing: 300,
    vad_events: true,
    language: "en",
  });

  let isOpen = false;

  live.on(LiveTranscriptionEvents.Open, () => {
    isOpen = true;
    log.info("deepgram open");
  });

  live.on(LiveTranscriptionEvents.Transcript, (data) => {
    // `data.channel.alternatives[0].transcript` is the text. `is_final`
    // tells us if Deepgram considers this chunk stable.
    const alt = data?.channel?.alternatives?.[0];
    const text = (alt?.transcript ?? "").trim();
    if (!text) return; // silence / whitespace-only transcripts
    if (data.is_final) {
      callbacks.onFinal(text);
    } else {
      callbacks.onPartial(text);
    }
  });

  live.on(LiveTranscriptionEvents.UtteranceEnd, () => {
    callbacks.onUtteranceEnd();
  });

  live.on(LiveTranscriptionEvents.SpeechStarted, () => {
    // Surface upstream as a partial signal — the orchestrator uses this
    // to interrupt an in-flight model response (barge-in).
    callbacks.onPartial("");
  });

  live.on(LiveTranscriptionEvents.Error, (err: unknown) => {
    log.error({ err }, "deepgram error");
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  });

  live.on(LiveTranscriptionEvents.Close, () => {
    isOpen = false;
    log.info("deepgram closed");
    callbacks.onClose?.();
  });

  return {
    sendAudio(buffer) {
      if (!isOpen) return;
      try {
        // Deepgram SDK's typings demand ArrayBuffer / SharedArrayBuffer
        // / Blob — Node Buffer satisfies the runtime contract but trips
        // the TS check. Pull the underlying ArrayBuffer slice that
        // exactly covers this Buffer's view.
        const ab = buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        ) as ArrayBuffer;
        live.send(ab);
      } catch (err) {
        log.warn({ err }, "deepgram send failed (likely closed mid-send)");
      }
    },
    finalize() {
      if (!isOpen) return;
      try {
        // Deepgram exposes a `Finalize` message; the SDK exposes it as
        // a `requestClose()` semantic. We use it sparingly because in
        // most cases utterance_end_ms triggers correctly.
        live.send(JSON.stringify({ type: "Finalize" }));
      } catch {
        /* ignore */
      }
    },
    close() {
      try {
        live.requestClose();
      } catch {
        /* ignore */
      }
    },
  };
}
