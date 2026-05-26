// MicCapture — child component that mounts the expo-audio stream hook
// ONLY when the parent has a live WS session.
//
// Why isolated in a child: the Day-2 / Day-3 investigation showed that a
// top-level audio hook (specifically @siteed/audio-studio's
// useAudioRecorder) installed an iOS recording-interruption listener at
// mount that broke NSURLSessionWebSocketTask. Rendering this component
// conditionally after `phase === "live"` ensures the audio hook runs
// strictly AFTER the WS handshake has completed. Whether the same iOS
// interaction exists for expo-audio's useAudioStream we'll learn from
// the next test — even if it does, the WS is already open by then so
// the listener can't sabotage the handshake.

import {
  requestRecordingPermissionsAsync,
  useAudioStream,
} from "expo-audio";
import { memo, useEffect, useMemo, useRef } from "react";
import {
  GEMINI_STREAM_OPTIONS,
  arrayBufferToBase64,
} from "@/src/services/voice/audioCapture";
import { activateInCallSpeakerphone } from "@/src/services/voice/audioSession";

interface MicCaptureProps {
  /** Called for each PCM chunk produced by the mic. Already base64-encoded. */
  onChunk: (base64: string, byteLength: number) => void;
}

function MicCaptureInner({ onChunk }: MicCaptureProps) {
  // Store the callback in a ref so the onBuffer closure stays stable —
  // expo-audio's hook re-reads options object on every render otherwise,
  // and we don't want to thrash native bindings. Assignment lives inside
  // useEffect so React Concurrent's potential double-render doesn't
  // capture a stale closure (was a flagged audit item).
  const onChunkRef = useRef(onChunk);
  useEffect(() => {
    onChunkRef.current = onChunk;
  }, [onChunk]);

  // Counter for log-throttling — chunks arrive every ~10-50 ms, we don't
  // want to spam Metro with thousands of log lines.
  const chunkLogCounterRef = useRef(0);

  // Stable options reference so useAudioStream doesn't re-create the
  // native stream on every parent re-render. Without this, every
  // setMetrics tick from the parent would tear down and restart the mic.
  const streamOptions = useMemo(
    () => ({
      ...GEMINI_STREAM_OPTIONS,
      onBuffer: (buffer: { data: ArrayBuffer; sampleRate: number; channels: number; timestamp: number }) => {
        const base64 = arrayBufferToBase64(buffer.data);
        onChunkRef.current(base64, buffer.data.byteLength);
        chunkLogCounterRef.current += 1;
        const n = chunkLogCounterRef.current;
        // Log first chunk loudly (confirms pipe alive end-to-end), then
        // every 50th (~5s at 100ms intervals) so we see the stream is
        // alive without flooding Metro.
        if (n === 1 || n % 50 === 0) {
          console.log(`[mic] chunk #${n} (${buffer.data.byteLength} bytes)`);
        }
      },
    }),
    [],
  );

  const { stream } = useAudioStream(streamOptions);

  useEffect(() => {
    let cancelled = false;
    let started = false;

    (async () => {
      console.log("[mic] requesting permission...");
      try {
        const perm = await requestRecordingPermissionsAsync();
        if (cancelled) return;
        console.log("[mic] permission:", perm.status, "canAskAgain:", perm.canAskAgain);
        if (perm.status !== "granted") {
          console.warn("[mic] permission denied, capture won't start");
          return;
        }
        // Day 5-I: activate InCallManager HERE, not in
        // configureForVoiceSession. Doing it earlier (during the WS
        // handshake) was firing an iOS audio-route-change notification
        // that NSURLSessionWebSocketTask interpreted as a fatal
        // interruption → WS closed with code 1005 before any audio
        // could flow. By the time MicCapture mounts, phase === "live"
        // which means the WS has already exchanged setup messages and
        // can survive a route change.
        console.log("[mic] activating InCallManager speakerphone...");
        activateInCallSpeakerphone();
        console.log("[mic] starting capture...");
        await stream.start();
        if (cancelled) {
          try { stream.stop(); } catch { /* */ }
          return;
        }
        started = true;
        console.log(
          `[mic] capture started: ${stream.sampleRate} Hz, ${stream.channels} ch`,
        );
      } catch (err) {
        if (!cancelled) console.warn("[mic] init failed", err);
      }
    })();

    return () => {
      cancelled = true;
      if (started) {
        try {
          stream.stop();
          console.log("[mic] capture stopped");
        } catch (err) {
          // Benign: `useReleasingSharedObject` (used internally by
          // useAudioStream) releases the native SharedObject during its
          // own cleanup, which can race with ours. When the native is
          // already gone we get NativeSharedObjectNotFoundException —
          // the stream IS stopped (the swift deinit() calls stop()), so
          // we just downgrade the noise level.
          const msg = (err as { message?: string }).message ?? String(err);
          if (msg.includes("NativeSharedObjectNotFoundException")) {
            console.log("[mic] capture stopped (native object already released)");
          } else {
            console.warn("[mic] stop failed", err);
          }
        }
      }
    };
  }, [stream]);

  return null;
}

// React.memo so parent re-renders (e.g., metric updates every ~50 ms during
// recording) don't ripple into this component and tear down the native
// stream. onChunk MUST be stable (use useCallback in the parent).
export const MicCapture = memo(MicCaptureInner);
