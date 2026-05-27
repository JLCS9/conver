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
  base64ToBytes,
  buildWavFile,
  isLikelyMeaningfulEnglish,
  writeTurnWavToCache,
} from "@/src/services/voice/audioPlayback";
import {
  configureForVoiceSession,
  releaseAudioSession,
} from "@/src/services/voice/audioSession";
import { RealtimeClient } from "@/src/services/voice/realtimeClient";

type Phase = "idle" | "starting" | "live" | "stopping" | "ended" | "error";

/** State machine for the post-session analyser call (vocab + grammar
 *  + context extraction). Used by the UI to show an "analizando…"
 *  modal while the user waits for the data to land in Profile. */
export type AnalyzeState = "idle" | "analyzing" | "done" | "failed";

export interface AnalyzeResult {
  turnsAnalyzed: number;
  vocabularyAdded: number;
  correctionsAdded: number;
}

/** One side of a turn in the conversation transcript. Built up
 *  incrementally from server delta events; `complete` flips when the
 *  turn is fully formed (we've moved to the other speaker, or
 *  turnComplete fired for the model). The UI renders these as chat
 *  bubbles. */
export interface Message {
  id: string;
  role: "user" | "model";
  text: string;
  complete: boolean;
  /** Wall-clock when the first delta for this message arrived. Used
   *  for ordering + display. */
  createdAt: number;
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
  /** Ordered list of turns in the current session. Render as a chat. */
  messages: Message[];
  /** URI of the most recently-assembled turn WAV file. Each new value
   *  is meant to be fed to AudioPlayback for playback. Null until the
   *  first turn is complete with audio. */
  playbackUri: string | null;
  /** Post-session analyser progress — drives the "Analizando…" modal. */
  analyzeState: AnalyzeState;
  analyzeResult: AnalyzeResult | null;
  /** Dismisses the analyser modal (resets analyzeState back to "idle"). */
  dismissAnalyze: () => void;
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

/** Tiny id generator — Date.now is unique enough for chat ordering
 *  within a session (we don't render across sessions). */
let messageIdCounter = 0;
const nextMessageId = () => `msg-${Date.now()}-${++messageIdCounter}`;

interface RealtimeSessionResponse {
  sessionId: string;
  wsUrl: string;
  model: string;
  maxDurationSeconds: number;
}

export function useVoiceSession(): UseVoiceSessionResult {
  const { getToken } = useAuth();
  const [phase, setPhase] = useState<Phase>("idle");
  const [analyzeState, setAnalyzeState] = useState<AnalyzeState>("idle");
  const [analyzeResult, setAnalyzeResult] = useState<AnalyzeResult | null>(null);

  // Debug: trace every phase transition. If the session "blocks", knowing
  // which state we slipped into (and from what) is the difference between
  // a 5-minute fix and 5 days of guessing.
  useEffect(() => {
    console.log(`[voice] phase → ${phase}`);
  }, [phase]);
  const [error, setError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<SessionMetadata | null>(null);
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS);
  const [messages, setMessages] = useState<Message[]>([]);
  const [playbackUri, setPlaybackUri] = useState<string | null>(null);

  const clientRef = useRef<RealtimeClient | null>(null);
  const firstSentAtRef = useRef<number | null>(null);
  const ttfrRecordedRef = useRef(false);
  /** Counts inlineData parts we receive — once we have one >5 KB it's
   * almost certainly model audio and we can record TTFA. Lets us drop
   * the previous byte-count heuristic, which mis-fired on noisy sims. */
  const modelAudioBytesRef = useRef(0);
  /** Per-turn PCM accumulator. We push each inlineData chunk's decoded
   *  bytes here and flush to a WAV file on `turnComplete`. Cleared on
   *  `interrupted` (user spoke before model finished) and on session
   *  start/stop. */
  const turnAudioChunksRef = useRef<Uint8Array[]>([]);
  /** Monotonic per-session counter so each WAV file has a unique label
   *  (helps debugging in the cache dir). */
  const turnCounterRef = useRef(0);

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
    setMessages([]);
    setPlaybackUri(null);
    firstSentAtRef.current = null;
    ttfrRecordedRef.current = false;
    modelAudioBytesRef.current = 0;
    turnAudioChunksRef.current = [];
    turnCounterRef.current = 0;
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

      // Day 5-I+: prepare audio session BEFORE opening the WS, not after.
      // setAudioModeAsync({ allowsRecording: true, ... }) switches iOS
      // to PlayAndRecord category, which fires an audio route-change
      // notification. If a WS exists when that fires, NSURLSessionWebSocketTask
      // aborts it with code 1005. So we activate the session FIRST — the
      // route change fires when no WS exists, then the WS opens into a
      // stable audio environment and survives.
      console.log("[voice] step 2.5: prepareAudio (before WS)...");
      await configureForVoiceSession();
      console.log("[voice] step 2.5 done");

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

          // User transcript delta — append to the open user message,
          // or start a new one if the last message is from the coach.
          // Day 8-A: track turns as discrete Message objects so the UI
          // can render a script-style chat instead of two giant text
          // blobs. Heuristic for "turn boundary": when a user delta
          // arrives while the last message is from the model (or
          // there is no message), open a fresh user message.
          if (sc.inputTranscription?.text) {
            const delta = sc.inputTranscription.text;
            const kept = isLikelyMeaningfulEnglish(delta);
            console.log(
              `[transcript] user${kept ? "" : " (filtered)"}: ${JSON.stringify(delta)}`,
            );
            if (kept) {
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.role === "user" && !last.complete) {
                  // Append delta to the open user message.
                  return [
                    ...prev.slice(0, -1),
                    { ...last, text: last.text + delta },
                  ];
                }
                // Start a new user message. Close any open model message.
                const closed = prev.map((m) =>
                  m.complete ? m : { ...m, complete: true },
                );
                return [
                  ...closed,
                  {
                    id: nextMessageId(),
                    role: "user",
                    text: delta,
                    complete: false,
                    createdAt: Date.now(),
                  },
                ];
              });
            }
          }

          // Model transcript delta — append to the open model message
          // or start a new one. Receiving a model delta implicitly
          // closes the previous user message (the coach is replying).
          if (sc.outputTranscription?.text) {
            const delta = sc.outputTranscription.text;
            console.log(`[transcript] model: ${JSON.stringify(delta)}`);
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === "model" && !last.complete) {
                return [
                  ...prev.slice(0, -1),
                  { ...last, text: last.text + delta },
                ];
              }
              const closed = prev.map((m) =>
                m.complete ? m : { ...m, complete: true },
              );
              return [
                ...closed,
                {
                  id: nextMessageId(),
                  role: "model",
                  text: delta,
                  complete: false,
                  createdAt: Date.now(),
                },
              ];
            });
          }

          // Audio response path: each modelTurn.parts[*].inlineData is a
          // PCM 24 kHz int16 mono chunk (base64). We accumulate per turn
          // and flush to a WAV file on turnComplete (see below).
          const parts = sc.modelTurn?.parts;
          if (parts && parts.length > 0) {
            const now = performance.now();
            let audioBytesThisMsg = 0;
            for (const p of parts) {
              if (p.inlineData?.data) {
                const bytes = base64ToBytes(p.inlineData.data);
                turnAudioChunksRef.current.push(bytes);
                audioBytesThisMsg += bytes.byteLength;
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
            // Mark the open model message as complete so the chat
            // bubble can render without the "still typing" affordance.
            setMessages((prev) =>
              prev.map((m) => (m.complete ? m : { ...m, complete: true })),
            );

            const chunks = turnAudioChunksRef.current;
            const totalBytes = modelAudioBytesRef.current;
            console.log(
              `[voice] turnComplete (model audio total this turn: ${totalBytes}B, ${chunks.length} chunks)`,
            );
            if (chunks.length > 0 && totalBytes > 0) {
              try {
                const wav = buildWavFile(chunks);
                turnCounterRef.current += 1;
                const uri = writeTurnWavToCache(
                  wav,
                  String(turnCounterRef.current),
                );
                console.log(
                  `[voice] wrote turn ${turnCounterRef.current} → ${uri.split("/").pop()} (${wav.byteLength}B WAV)`,
                );
                setPlaybackUri(uri);
              } catch (err) {
                console.warn("[voice] WAV write failed", err);
              }
            }
            // Reset per-turn state regardless.
            turnAudioChunksRef.current = [];
            modelAudioBytesRef.current = 0;
          }
          if (sc.interrupted) {
            console.log(
              `[voice] interrupted (user started speaking) — dropping ${turnAudioChunksRef.current.length} pending audio chunks`,
            );
            turnAudioChunksRef.current = [];
            modelAudioBytesRef.current = 0;
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

      // Step 4 (mic capture) lives in the <MicCapture> child component;
      // it mounts when phase === "live" so its useAudioStream hook runs
      // AFTER the WS is open. The audio session was already prepared
      // in step 2.5 above, so MicCapture's mount won't trigger a new
      // route-change notification that could kill the WS.
      console.log("[voice] step 4 delegated to MicCapture (mounts on live)");

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
    console.log("[voice] stop() called");
    setPhase("stopping");
    try { clientRef.current?.close(); } catch { /* ignore */ }
    clientRef.current = null;
    try { await releaseAudioSession(); } catch { /* ignore */ }
    setPhase("ended");

    // Day 7-C / Day 9-H: kick off the post-session analyser. We still
    // run it as a background promise (so the UI thread is never
    // blocked) but we now expose `analyzeState` so the screen can show
    // a "Analizando…" modal with a "Ver progreso" button on success.
    const sessionIdForAnalysis = metadata?.sessionId;
    if (sessionIdForAnalysis) {
      setAnalyzeResult(null);
      setAnalyzeState("analyzing");
      void (async () => {
        try {
          const res = await api<AnalyzeResult & { ok: boolean }>(
            `/api/sessions/${sessionIdForAnalysis}/analyze`,
            { method: "POST", getToken, timeoutMs: 30_000 },
          );
          console.log("[voice] post-session analysis ok", res);
          setAnalyzeResult({
            turnsAnalyzed: res.turnsAnalyzed,
            vocabularyAdded: res.vocabularyAdded,
            correctionsAdded: res.correctionsAdded,
          });
          setAnalyzeState("done");
        } catch (err) {
          console.warn("[voice] post-session analysis failed (non-fatal)", err);
          setAnalyzeState("failed");
        }
      })();
    }
  }, [phase, metadata?.sessionId, getToken]);

  const dismissAnalyze = useCallback(() => {
    setAnalyzeState("idle");
    setAnalyzeResult(null);
  }, []);

  useEffect(() => {
    return () => {
      if (clientRef.current) {
        try { clientRef.current.close(); } catch { /* ignore */ }
      }
      void releaseAudioSession().catch(() => undefined);
    };
  }, []);

  return {
    phase,
    error,
    metadata,
    metrics,
    messages,
    playbackUri,
    analyzeState,
    analyzeResult,
    dismissAnalyze,
    start,
    stop,
    sendChunk,
  };
}
