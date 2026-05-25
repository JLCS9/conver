// useVoiceSession — orchestrates a voice round-trip from the mobile client.
//
// Day-4 status: WS path works end-to-end (Day-3 milestone). Mic capture
// re-introduced via expo-audio's useAudioStream — BUT mounted in a child
// component (`MicCapture`) that only renders when phase === "live". This
// isolation pattern prevents the Day-2 bug where a top-level audio hook
// installed an iOS recording-interruption listener at mount that killed
// NSURLSessionWebSocketTask before the WS handshake completed.
//
// The hook exposes a `sendChunk(base64)` callback that the MicCapture
// child uses to push PCM frames through the RealtimeClient WS without
// having to know about the client directly.

import { useAuth } from "@clerk/clerk-expo";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/src/lib/api";
import {
  configureForVoiceSession,
  releaseAudioSession,
} from "@/src/services/voice/audioSession";
import {
  type GeminiServerMessage,
  RealtimeClient,
} from "@/src/services/voice/realtimeClient";

type Phase = "idle" | "starting" | "live" | "stopping" | "ended" | "error";

/** Running transcripts for the current session. Each string is a flat
 * accumulation of all delta fragments Gemini has sent so far; we don't
 * try to demarcate turns yet (UX call for Week 4 polish pass). */
export interface Transcripts {
  user: string;
  model: string;
}

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
  /** ms between first audio chunk SENT and first inbound binary >5kB. */
  timeToFirstResponseMs: number | null;
}

export interface UseVoiceSessionResult {
  phase: Phase;
  error: string | null;
  metadata: SessionMetadata | null;
  metrics: Metrics;
  transcripts: Transcripts;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Push a base64-encoded PCM chunk to the upstream. No-op if WS not open. */
  sendChunk: (base64: string, byteLength: number) => void;
}

const EMPTY_METRICS: Metrics = {
  bytesSent: 0,
  chunksSent: 0,
  bytesReceived: 0,
  chunksReceived: 0,
  timeToFirstResponseMs: null,
};

const EMPTY_TRANSCRIPTS: Transcripts = { user: "", model: "" };

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
  const [transcripts, setTranscripts] = useState<Transcripts>(EMPTY_TRANSCRIPTS);

  const clientRef = useRef<RealtimeClient | null>(null);
  const firstSentAtRef = useRef<number | null>(null);
  const ttfrRecordedRef = useRef(false);
  /** Counts inlineData parts we receive — once we have one >5 KB it's
   * almost certainly model audio and we can record TTFA. Lets us drop
   * the previous byte-count heuristic, which mis-fired on noisy sims. */
  const modelAudioBytesRef = useRef(0);

  const sendChunk = useCallback((base64: string, byteLength: number) => {
    const client = clientRef.current;
    if (!client) return;
    client.sendAudioChunk(base64);
    if (firstSentAtRef.current === null) {
      firstSentAtRef.current = performance.now();
    }
    setMetrics((m) => ({
      ...m,
      chunksSent: m.chunksSent + 1,
      bytesSent: m.bytesSent + byteLength,
    }));
  }, []);

  const start = useCallback(async () => {
    console.log("[voice] start() called, current phase=", phase);
    if (phase !== "idle" && phase !== "ended" && phase !== "error") return;

    setError(null);
    setMetrics(EMPTY_METRICS);
    setTranscripts(EMPTY_TRANSCRIPTS);
    firstSentAtRef.current = null;
    ttfrRecordedRef.current = false;
    modelAudioBytesRef.current = 0;
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
          // Raw-byte metrics only — semantic dispatch happens via
          // onServerMessage below. Both fire for the same frame.
          setMetrics((m) => ({
            ...m,
            chunksReceived: m.chunksReceived + 1,
            bytesReceived: m.bytesReceived + data.byteLength,
          }));
        },
        onServerMessage: (msg) => {
          // Setup ACK — server is ready. Just log.
          if (msg.setupComplete) {
            console.log("[voice] setupComplete from upstream");
            return;
          }
          const sc = msg.serverContent;
          if (!sc) return;

          if (sc.inputTranscription?.text) {
            const delta = sc.inputTranscription.text;
            setTranscripts((t) => ({ ...t, user: t.user + delta }));
          }
          if (sc.outputTranscription?.text) {
            const delta = sc.outputTranscription.text;
            setTranscripts((t) => ({ ...t, model: t.model + delta }));
          }

          // Audio playback path: each modelTurn.parts[*].inlineData is a
          // PCM 24 kHz int16 mono chunk (base64). Day-4 just measures it;
          // Day-5 will pipe into expo-audio AudioPlayer.
          const parts = sc.modelTurn?.parts;
          if (parts && parts.length > 0) {
            const now = performance.now();
            let audioBytesThisMsg = 0;
            for (const p of parts) {
              if (p.inlineData?.data) {
                // base64 length × 3/4 is the decoded byte estimate.
                audioBytesThisMsg += Math.floor(p.inlineData.data.length * 0.75);
              }
            }
            if (audioBytesThisMsg > 0) {
              modelAudioBytesRef.current += audioBytesThisMsg;
              if (
                !ttfrRecordedRef.current &&
                firstSentAtRef.current !== null
              ) {
                ttfrRecordedRef.current = true;
                const ttfa = now - firstSentAtRef.current;
                console.log(
                  `[voice] TTFA: ${ttfa.toFixed(0)} ms (first model audio chunk, ${audioBytesThisMsg}B)`,
                );
                setMetrics((m) => ({ ...m, timeToFirstResponseMs: ttfa }));
              }
            }
          }

          if (sc.turnComplete) {
            console.log(
              `[voice] turnComplete (model audio total this turn: ${modelAudioBytesRef.current}B)`,
            );
            modelAudioBytesRef.current = 0;
          }
          if (sc.interrupted) {
            console.log("[voice] interrupted (user started speaking)");
          }
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
      console.log("[voice] step 3 done, WS open");

      console.log("[voice] step 4: configureForVoiceSession...");
      await configureForVoiceSession();
      console.log("[voice] step 4 done");

      // Step 5 (mic capture) lives in the <MicCapture> child component;
      // it mounts when phase === "live" so its useAudioStream hook runs
      // AFTER the WS is open. See (app)/session.tsx.
      console.log("[voice] step 5 delegated to MicCapture (mounts on live)");

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

  return { phase, error, metadata, metrics, transcripts, start, stop, sendChunk };
}
