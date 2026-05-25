// AudioPlayback — child component that owns the expo-audio AudioPlayer
// instance and plays Gemini's per-turn WAV files as they arrive.
//
// Lifecycle, mirroring MicCapture:
//   - Renders only when parent says phase === "live", so the native player
//     is mounted strictly after the WS handshake completed (defensive
//     hygiene; we haven't seen useAudioPlayer cause the same NSURLSession
//     conflict useAudioRecorder did, but the isolation pattern is cheap).
//   - Receives `uri` prop — the latest WAV file URI from useVoiceSession.
//     Each new uri triggers a `.replace()` + `.play()` so playback starts
//     as soon as a turn is assembled.
//   - On unmount, useReleasingSharedObject inside useAudioPlayer cleans
//     up the native player automatically.

import { useAudioPlayer } from "expo-audio";
import { memo, useEffect, useRef } from "react";

interface AudioPlaybackProps {
  /** file:// URI of the most recently-assembled turn WAV, or null while
   *  no audio is queued. Each non-null change triggers playback. */
  uri: string | null;
}

function AudioPlaybackInner({ uri }: AudioPlaybackProps) {
  // Stable player: created once at mount with no source. We feed it
  // sources via `.replace()` so we keep the same native instance across
  // many turns instead of churning native players (which would cost
  // ~50-100 ms per swap on iOS for engine setup).
  const player = useAudioPlayer(null);
  const lastPlayedUriRef = useRef<string | null>(null);

  useEffect(() => {
    if (!uri || uri === lastPlayedUriRef.current) return;
    lastPlayedUriRef.current = uri;
    try {
      player.replace({ uri });
      player.play();
      console.log(`[playback] playing turn audio: ${uri.split("/").pop()}`);
    } catch (err) {
      console.warn("[playback] replace/play failed", err);
    }
  }, [uri, player]);

  return null;
}

// React.memo prevents parent re-renders (from metric ticks) from
// triggering needless useEffect re-runs. Without it, every chunksSent
// update would re-enter the effect.
export const AudioPlayback = memo(AudioPlaybackInner);
