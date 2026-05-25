// useVoiceSession — orchestrates a voice round-trip from the mobile client.
//
// Day-3 status: audio CAPTURE is temporarily disabled. The mic recorder
// hook from @siteed/audio-studio installs an iOS recording-interruption
// listener at mount that breaks NSURLSessionWebSocketTask on SDK 56 +
// iOS 26.5 Sim (the WS closes with code=0 before the handshake completes).
// We've proven via two diagnostic buttons in (app)/session.tsx (raw WS
// to fake URL, real-auth WS to gateway) that the WS itself is fine when
// the recorder hook is NOT in the React tree.
//
// To unblock voice-loop development we (1) keep the WS path live so the
// gateway sees real connections from the mobile and the server side can
// be exercised end-to-end, (2) skip mic capture entirely so the recorder
// hook doesn't poison the WS, and (3) park a TODO to switch to expo-audio's
// recorder (we already installed it for setAudioModeAsync) in Day 4.
//
// What it does:
//   1. Calls POST /api/realtime/session → gets { sessionId, wsUrl }.
//   2. Opens a WS to our voice-gateway with `?token=<clerk_jwt>`.
//   3. Configures the iOS audio session for duplex.
//   4. Receives binary frames from upstream Gemini Live (proxied) and
//      counts bytes + times the first one as the response-arrival proxy.
//
// Out of scope until audio recording is wired up:
//   - Sending mic chunks to Google. The session is one-way (server → us)
//     until then. Useful for measuring server-side latency in isolation.
//   - Playback of received audio. Same protobuf-decode-on-gateway problem
//     as before; we'll tackle once mic flows.

import { useAuth } from "@clerk/clerk-expo";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/src/lib/api";
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
  /** ms between WS open and first inbound binary frame >5kB. */
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

  const clientRef = useRef<RealtimeClient | null>(null);
  const wsOpenedAtRef = useRef<number | null>(null);
  const ttfrRecordedRef = useRef(false);

  const start = useCallback(async () => {
    console.log("[voice] start() called, current phase=", phase);
    if (phase !== "idle" && phase !== "ended" && phase !== "error") return;

    setError(null);
    setMetrics(EMPTY_METRICS);
    wsOpenedAtRef.current = null;
    ttfrRecordedRef.current = false;
    setPhase("starting");

    try {
      console.log("[voice] step 1: POST /api/realtime/session...");
      const session = await api<RealtimeSessionResponse>(
        "/api/realtime/session",
        { method: "POST", body: JSON.stringify({}), getToken },
      );
      console.log("[voice] step 1 done, sessionId=", session.sessionId.slice(0, 8));
      setMetadata({
        sessionId: session.sessionId,
        wsUrl: session.wsUrl,
        model: session.model,
        maxDurationSeconds: session.maxDurationSeconds,
      });

      console.log("[voice] step 2: getToken for WS bearer...");
      const bearer = await getToken();
      if (!bearer) throw new Error("Clerk getToken returned null");
      console.log("[voice] step 2 done, bearer len=", bearer.length);

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
              wsOpenedAtRef.current !== null &&
              data.byteLength > 5_000
            ) {
              ttfrRecordedRef.current = true;
              next.timeToFirstResponseMs = now - wsOpenedAtRef.current;
            }
            return next;
          });
        },
        onText: (text) => {
          console.log("[voice] text frame:", text.slice(0, 200));
        },
        onError: (err) => {
          console.warn("[voice] ws error", err);
        },
      });
      clientRef.current = client;
      await client.open();
      wsOpenedAtRef.current = performance.now();
      console.log("[voice] step 3 done, WS open");

      console.log("[voice] step 4: configureForVoiceSession...");
      await configureForVoiceSession();
      console.log("[voice] step 4 done");

      // TODO Day 4: mic capture via expo-audio's recorder API. Skipped on
      // Day 3 because @siteed/audio-studio's useAudioRecorder() installs
      // an iOS interruption listener at mount that breaks the WebSocket.
      console.log("[voice] step 5 skipped (no audio capture in Day 3 build)");

      setPhase("live");
    } catch (e) {
      setError((e as { message?: string }).message ?? "Failed to start voice session");
      setPhase("error");
      try { clientRef.current?.close(); } catch { /* ignore */ }
      try { await releaseAudioSession(); } catch { /* ignore */ }
      clientRef.current = null;
    }
  }, [getToken, phase]);

  const stop = useCallback(async () => {
    if (phase !== "live") return;
    setPhase("stopping");
    try { clientRef.current?.close(); } catch { /* ignore */ }
    clientRef.current = null;
    try { await releaseAudioSession(); } catch { /* ignore */ }
    setPhase("ended");
  }, [phase]);

  useEffect(() => {
    return () => {
      if (clientRef.current) {
        try { clientRef.current.close(); } catch { /* ignore */ }
      }
      void releaseAudioSession().catch(() => undefined);
    };
  }, []);

  return { phase, error, metadata, metrics, start, stop };
}
