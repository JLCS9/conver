// useVoiceSession — orchestrates a full voice round-trip for the Day-2 spike.
//
// What it does:
//   1. Calls POST /api/realtime/session → gets { sessionId, wsUrl }.
//   2. Opens a WS to our voice-gateway with Bearer-subprotocol auth.
//   3. Configures the iOS audio session for duplex (PlayAndRecord+VoiceChat).
//   4. Starts mic capture via @siteed/expo-audio-stream — 50 ms PCM 16 kHz
//      mono chunks emitted via onAudioStream callback.
//   5. Pumps each chunk through the WS as `realtime_input.media_chunks`.
//   6. Counts bytes / times the FIRST inbound binary frame.
//
// What it intentionally does NOT do in Day 2:
//   - Decode the binary frames Google sends back (they're protobuf-wrapped
//     PCM; we'll add server-side decoding in the voice-gateway in Day 3
//     and forward raw PCM to mobile then). Today we just measure round-trip
//     latency and prove the loop wiring.
//   - Play audio. Same reason — without the decoder, we can't extract PCM.
//   - Handle reconnect, cap warnings, interruptions. Day 3-5.
//
// Returns a small state machine + metrics so the screen can render status.

import { useAuth } from "@clerk/clerk-expo";
import { useAudioRecorder } from "@siteed/expo-audio-stream";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/src/lib/api";
import {
  GEMINI_RECORDING_CONFIG,
  chunkToBase64,
} from "@/src/services/voice/audioCapture";
import {
  configureForVoiceSession,
  releaseAudioSession,
} from "@/src/services/voice/audioSession";
import { RealtimeClient } from "@/src/services/voice/realtimeClient";

type Phase = "idle" | "starting" | "live" | "stopping" | "ended" | "error";

interface SessionMetadata {
  sessionId: string;
  wsUrl: string;
  model: string;
  maxDurationSeconds: number;
}

interface Metrics {
  bytesSent: number;
  chunksSent: number;
  bytesReceived: number;
  chunksReceived: number;
  /** ms between first audio chunk SENT and first binary frame RECEIVED. */
  timeToFirstResponseMs: number | null;
}

export interface UseVoiceSessionResult {
  phase: Phase;
  error: string | null;
  metadata: SessionMetadata | null;
  metrics: Metrics;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

const EMPTY_METRICS: Metrics = {
  bytesSent: 0,
  chunksSent: 0,
  bytesReceived: 0,
  chunksReceived: 0,
  timeToFirstResponseMs: null,
};

interface RealtimeSessionResponse {
  sessionId: string;
  wsUrl: string;
  model: string;
  maxDurationSeconds: number;
}

export function useVoiceSession(): UseVoiceSessionResult {
  const { getToken } = useAuth();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<SessionMetadata | null>(null);
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS);

  // Refs for things we don't want to re-render on.
  const clientRef = useRef<RealtimeClient | null>(null);
  const firstSentAtRef = useRef<number | null>(null);
  const ttfrRecordedRef = useRef(false);

  // @siteed/expo-audio-stream hook. Recording starts when we call .startRecording.
  const recorder = useAudioRecorder();

  const handleAudioStream = useCallback(
    async (event: Parameters<typeof chunkToBase64>[0]) => {
      const base64 = chunkToBase64(event);
      if (!base64) return;

      const client = clientRef.current;
      if (!client) return;

      client.sendAudioChunk(base64);

      if (firstSentAtRef.current === null) {
        firstSentAtRef.current = performance.now();
      }

      setMetrics((m) => ({
        ...m,
        chunksSent: m.chunksSent + 1,
        bytesSent: m.bytesSent + event.eventDataSize,
      }));
    },
    [],
  );

  const start = useCallback(async () => {
    console.log("[voice] start() called, current phase=", phase);
    if (phase !== "idle" && phase !== "ended" && phase !== "error") return;

    setError(null);
    setMetrics(EMPTY_METRICS);
    firstSentAtRef.current = null;
    ttfrRecordedRef.current = false;
    setPhase("starting");

    try {
      // 1. Handshake — get sessionId + wsUrl from our backend.
      console.log("[voice] step 1: POST /api/realtime/session...");
      const session = await api<RealtimeSessionResponse>(
        "/api/realtime/session",
        { method: "POST", body: JSON.stringify({}), getToken },
      );
      console.log("[voice] step 1 done, sessionId=", session.sessionId.slice(0, 8), "wsUrl=", session.wsUrl);
      setMetadata({
        sessionId: session.sessionId,
        wsUrl: session.wsUrl,
        model: session.model,
        maxDurationSeconds: session.maxDurationSeconds,
      });

      // 2. Clerk JWT for the WS auth.
      console.log("[voice] step 2: getToken for WS bearer...");
      const bearer = await getToken();
      if (!bearer) throw new Error("Clerk getToken returned null");
      console.log("[voice] step 2 done, bearer len=", bearer.length);

      // 3. Open the WS.
      console.log("[voice] step 3: opening WS...");
      const client = new RealtimeClient({
        wsUrl: session.wsUrl,
        bearer,
        onBinary: (data) => {
          const now = performance.now();
          setMetrics((m) => {
            const next = {
              ...m,
              chunksReceived: m.chunksReceived + 1,
              bytesReceived: m.bytesReceived + data.byteLength,
            };
            if (
              !ttfrRecordedRef.current &&
              firstSentAtRef.current !== null &&
              data.byteLength > 5_000 // first big audio chunk
            ) {
              ttfrRecordedRef.current = true;
              next.timeToFirstResponseMs = now - firstSentAtRef.current;
            }
            return next;
          });
        },
        onText: (text) => {
          // Won't normally fire — Live API in v1beta sends binary — but
          // we log it just in case for debugging.
          console.log("[voice] text frame received:", text.slice(0, 200));
        },
        onError: (err) => {
          console.warn("[voice] ws error", err);
        },
      });
      clientRef.current = client;
      await client.open();
      console.log("[voice] step 3 done, WS open");

      // 4. Audio session.
      console.log("[voice] step 4: configureForVoiceSession...");
      await configureForVoiceSession();
      console.log("[voice] step 4 done");

      // 5. Start mic capture.
      console.log("[voice] step 5: recorder.startRecording...");
      await recorder.startRecording({
        ...GEMINI_RECORDING_CONFIG,
        onAudioStream: handleAudioStream,
      });
      console.log("[voice] step 5 done — going live");

      setPhase("live");
    } catch (e) {
      setError((e as { message?: string }).message ?? "Failed to start voice session");
      setPhase("error");
      // Defensive cleanup.
      try { await recorder.stopRecording(); } catch { /* ignore */ }
      try { clientRef.current?.close(); } catch { /* ignore */ }
      try { await releaseAudioSession(); } catch { /* ignore */ }
      clientRef.current = null;
    }
  }, [getToken, handleAudioStream, phase, recorder]);

  const stop = useCallback(async () => {
    if (phase !== "live") return;
    setPhase("stopping");
    try {
      await recorder.stopRecording();
    } catch { /* ignore */ }
    try { clientRef.current?.close(); } catch { /* ignore */ }
    clientRef.current = null;
    try { await releaseAudioSession(); } catch { /* ignore */ }
    setPhase("ended");
  }, [phase, recorder]);

  // On unmount, make sure we don't leave the mic running.
  useEffect(() => {
    return () => {
      if (clientRef.current) {
        try { clientRef.current.close(); } catch { /* ignore */ }
      }
      // recorder.stopRecording is async but useEffect cleanup is sync — best-effort.
      void recorder.stopRecording().catch(() => undefined);
      void releaseAudioSession().catch(() => undefined);
    };
  }, [recorder]);

  return { phase, error, metadata, metrics, start, stop };
}
