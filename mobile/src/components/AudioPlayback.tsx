// AudioPlayback — child component that owns the expo-audio AudioPlayer
// instance and plays Gemini's per-turn WAV files as they arrive.
//
// Lifecycle, mirroring MicCapture:
//   - Renders only when parent says phase === "live", so the native player
//     is mounted strictly after the WS handshake completed (defensive
//     hygiene; we haven't seen useAudioPlayer cause the same NSURLSession
//     conflict useAudioRecorder did, but the isolation pattern is cheap).
//   - Receives `uri` prop — the latest WAV file URI from useVoiceSession.
//     Each new uri triggers a `.replace()` and we wait for the load to
//     complete before calling `.play()`.
//   - On unmount, useReleasingSharedObject inside useAudioPlayer cleans
//     up the native player automatically.
//
// Day 5-D bug fix: the previous version called `player.replace(...)`
// immediately followed by `player.play()`. `replace()` is fire-and-forget
// (returns void) — the WAV file is loaded asynchronously by the native
// layer. Calling `play()` before the load completes silently no-ops →
// the user heard no agent audio even though logs showed "playing turn
// audio". Fix: subscribe to `playbackStatusUpdate`, wait for the first
// status with `isLoaded: true`, then call `play()`. One-shot per URI.

import { useAudioPlayer } from "expo-audio";
import { memo, useEffect, useRef } from "react";
import InCallManager from "react-native-incall-manager";

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

    const label = uri.split("/").pop() ?? uri;

    // Subscribe FIRST, then replace — otherwise we might miss the
    // load-completed event if native is faster than React's effect chain.
    const sub = player.addListener("playbackStatusUpdate", (status) => {
      if (status.isLoaded) {
        try {
          player.play();
          console.log(`[playback] loaded → playing: ${label}`);
        } catch (err) {
          console.warn("[playback] play() threw after load", err);
        }
        sub.remove(); // one-shot per URI
      }
    });

    // Safety timeout: if `isLoaded` never fires within 1s (file missing,
    // codec issue, race condition), try playing anyway. Worse case it
    // silently no-ops again; we don't make things worse.
    const fallback = setTimeout(() => {
      sub.remove();
      try {
        player.play();
        console.warn(
          `[playback] no loaded event after 1s, playing anyway: ${label}`,
        );
      } catch (err) {
        console.warn("[playback] fallback play() threw", err);
      }
    }, 1000);

    // Clear fallback if loaded event fires first.
    const subClear = player.addListener("playbackStatusUpdate", (status) => {
      if (status.isLoaded) {
        clearTimeout(fallback);
        subClear.remove();
      }
    });

    try {
      // Day 5-F: re-enforce speakerphone before EACH playback. Empirically
      // observed (user testing) that audio played fine on the first turn
      // but went silent on subsequent turns — strong signal that something
      // (expo-audio's player init, an iOS route-change notification, or
      // a session interruption from the recording side) is resetting the
      // output port. Calling setForceSpeakerphoneOn on every turn is cheap
      // and idempotent; if the route is already speaker it's a no-op.
      InCallManager.setForceSpeakerphoneOn(true);
      InCallManager.setSpeakerphoneOn(true);

      player.replace({ uri });
      // Defensive: ensure the player isn't muted/at zero volume. expo-audio
      // defaults to volume=1.0 but we set it explicitly so a future global
      // mute (e.g. duck-others interruption) can't silently survive into
      // this turn.
      player.volume = 1.0;
      console.log(`[playback] replace queued: ${label}`);
    } catch (err) {
      console.warn("[playback] replace failed", err);
      sub.remove();
      subClear.remove();
      clearTimeout(fallback);
    }

    return () => {
      // Effect cleanup on URI change / unmount: drop stale subs + timer.
      sub.remove();
      subClear.remove();
      clearTimeout(fallback);
    };
  }, [uri, player]);

  return null;
}

// React.memo prevents parent re-renders (from metric ticks) from
// triggering needless useEffect re-runs. Without it, every chunksSent
// update would re-enter the effect.
export const AudioPlayback = memo(AudioPlaybackInner);
