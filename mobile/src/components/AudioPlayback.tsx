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

  // Persistent listener for the lifetime of the player: track every
  // playing → not-playing transition. Without this we'd have to attach
  // a fresh listener per URI and risk missing the end of the last turn.
  useEffect(() => {
    const sub = player.addListener("playbackStatusUpdate", (status) => {
      if (!status.isLoaded) return;
      const isPlaying = status.playing;
      if (isPlaying && !wasPlayingRef.current) {
        wasPlayingRef.current = true;
        console.log("[playback] started");
        onStartRef.current?.();
      } else if (!isPlaying && wasPlayingRef.current) {
        wasPlayingRef.current = false;
        console.log("[playback] ended");
        onEndRef.current?.();
      }
    });
    return () => sub.remove();
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
