// AudioPlayback — owns the expo-audio AudioPlayer instance and plays
// per-turn Gemini WAV files as they arrive.
//
// Day 6-L: now also fires `onPlaybackStart` / `onPlaybackEnd` props
// so the parent can gate the mic during coach speech. The parent
// (session.tsx) flips a `coachIsSpeaking` flag and MicCapture drops
// chunks while that flag is true → kills the speaker → mic echo loop
// without the server having to estimate timing.

import { useAudioPlayer } from "expo-audio";
import { memo, useEffect, useRef } from "react";
import InCallManager from "react-native-incall-manager";

interface AudioPlaybackProps {
  /** file:// URI of the most recently-assembled turn WAV, or null while
   *  no audio is queued. Each non-null change triggers playback. */
  uri: string | null;
  /** Fired the moment AudioPlayer signals isLoaded + we call play().
   *  Parent flips `coachIsSpeaking` here. */
  onPlaybackStart?: () => void;
  /** Fired when AudioPlayer signals the playback transitioned from
   *  playing → not-playing (i.e. it finished or was stopped). Parent
   *  flips `coachIsSpeaking` back so the mic resumes feeding Deepgram. */
  onPlaybackEnd?: () => void;
}

function AudioPlaybackInner({
  uri,
  onPlaybackStart,
  onPlaybackEnd,
}: AudioPlaybackProps) {
  // Stable player: created once at mount with no source. We feed it
  // sources via `.replace()` so we keep the same native instance across
  // many turns instead of churning native players (which would cost
  // ~50-100 ms per swap on iOS for engine setup).
  //
  // updateInterval: 100ms so playback status events fire often enough
  // to detect playback end within ~100ms (default 500ms feels laggy
  // for the mic re-engage hand-off).
  const player = useAudioPlayer(null, { updateInterval: 100 });
  const lastPlayedUriRef = useRef<string | null>(null);
  const wasPlayingRef = useRef(false);

  // Stable callbacks: the parent passes new arrow functions each render
  // (`() => setCoachIsSpeaking(true)`). Ref keeps the latest closure
  // accessible from the long-lived playbackStatusUpdate listener.
  const onStartRef = useRef(onPlaybackStart);
  const onEndRef = useRef(onPlaybackEnd);
  useEffect(() => {
    onStartRef.current = onPlaybackStart;
    onEndRef.current = onPlaybackEnd;
  }, [onPlaybackStart, onPlaybackEnd]);

  // Persistent listener for the lifetime of the player.
  //
  // Day 6-M: use expo-audio's explicit `didJustFinish` flag for the
  // end signal. Tracking `playing: true → false` transitions misses
  // edges (the SDK doesn't always emit a status with playing=false on
  // turn end, especially if a new replace() is queued immediately).
  // didJustFinish is the SDK's "audio ended this tick" boolean and is
  // the canonical signal.
  //
  // Safety net: if didJustFinish somehow doesn't fire for a turn
  // (rare, but possible on app backgrounding or audio interruption),
  // a setTimeout scheduled when the turn STARTS guarantees the end
  // event fires anyway after (duration + 1s). The user can't get
  // stuck with the mic paused forever.
  const safetyEndTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const sub = player.addListener("playbackStatusUpdate", (status) => {
      if (!status.isLoaded) return;

      // Detect playback START (transition false → true).
      if (status.playing && !wasPlayingRef.current) {
        wasPlayingRef.current = true;
        console.log(
          `[playback] started (duration=${status.duration.toFixed(2)}s)`,
        );
        onStartRef.current?.();

        // Schedule a safety end-fire in case didJustFinish gets lost.
        if (safetyEndTimerRef.current) {
          clearTimeout(safetyEndTimerRef.current);
        }
        const safetyMs = Math.max(1000, status.duration * 1000 + 1000);
        safetyEndTimerRef.current = setTimeout(() => {
          if (wasPlayingRef.current) {
            console.warn(
              "[playback] safety timer fired — forcing onPlaybackEnd",
            );
            wasPlayingRef.current = false;
            onEndRef.current?.();
          }
        }, safetyMs);
      }

      // Detect playback END via didJustFinish (the SDK's canonical
      // "this tick is the moment the audio finished" signal).
      if (status.didJustFinish && wasPlayingRef.current) {
        wasPlayingRef.current = false;
        if (safetyEndTimerRef.current) {
          clearTimeout(safetyEndTimerRef.current);
          safetyEndTimerRef.current = null;
        }
        console.log("[playback] ended (didJustFinish)");
        onEndRef.current?.();
      }
    });
    return () => {
      sub.remove();
      if (safetyEndTimerRef.current) {
        clearTimeout(safetyEndTimerRef.current);
      }
    };
  }, [player]);

  // Per-URI effect: queue + play each new turn's WAV.
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
      // Re-enforce speakerphone before EACH playback. Empirically
      // observed (Day 5-F testing) that audio played fine on the first
      // turn but went silent on subsequent turns — strong signal that
      // something (expo-audio's player init, an iOS route-change
      // notification, or a session interruption from the recording side)
      // is resetting the output port. Calling setForceSpeakerphoneOn on
      // every turn is cheap and idempotent.
      InCallManager.setForceSpeakerphoneOn(true);
      InCallManager.setSpeakerphoneOn(true);

      player.replace({ uri });
      // Defensive: ensure the player isn't muted/at zero volume.
      player.volume = 1.0;
      console.log(`[playback] replace queued: ${label}`);
    } catch (err) {
      console.warn("[playback] replace failed", err);
      sub.remove();
      subClear.remove();
      clearTimeout(fallback);
    }

    return () => {
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
