// AudioPlayback — plays Gemini's per-turn WAV files and signals the
// parent when the coach starts/stops speaking so the mic can be
// muted to prevent echo.
//
// Day 6-N strategy (after Day 6-L/M event-tracking fragility):
//
//   forget event tracking. Use a plain setTimeout sized to the audio
//   duration. The pattern per turn is:
//
//     player.replace(uri)
//     wait for `isLoaded` (gives us status.duration)
//     player.play() + fire onPlaybackStart()
//     schedule setTimeout(duration_ms + 200) → fire onPlaybackEnd()
//
//   No reliance on `playing` transitions or `didJustFinish` (both of
//   which the SDK doesn't always emit cleanly between rapid replaces).
//   The +200ms buffer covers the gap between play() call and audio
//   actually starting on the speaker.
//
//   Safety net: if `isLoaded` itself doesn't fire within 1s (codec
//   error / missing file), we fall back to firing both START and END
//   together so the parent doesn't get stuck with the mic paused.

import { useAudioPlayer } from "expo-audio";
import { memo, useEffect, useRef } from "react";
import InCallManager from "react-native-incall-manager";

interface AudioPlaybackProps {
  /** file:// URI of the most recently-assembled turn WAV, or null while
   *  no audio is queued. Each non-null change triggers playback. */
  uri: string | null;
  /** Fired the moment we call player.play() on a new URI. */
  onPlaybackStart?: () => void;
  /** Fired (duration + 200ms) after onPlaybackStart, i.e. the exact
   *  moment playback should be finishing on the speaker. */
  onPlaybackEnd?: () => void;
}

function AudioPlaybackInner({
  uri,
  onPlaybackStart,
  onPlaybackEnd,
}: AudioPlaybackProps) {
  const player = useAudioPlayer(null);
  const lastPlayedUriRef = useRef<string | null>(null);

  // Stable callback refs so the per-URI effect can read the latest
  // closure without re-running on every parent render.
  const onStartRef = useRef(onPlaybackStart);
  const onEndRef = useRef(onPlaybackEnd);
  useEffect(() => {
    onStartRef.current = onPlaybackStart;
    onEndRef.current = onPlaybackEnd;
  }, [onPlaybackStart, onPlaybackEnd]);

  useEffect(() => {
    if (!uri || uri === lastPlayedUriRef.current) return;
    lastPlayedUriRef.current = uri;

    const label = uri.split("/").pop() ?? uri;
    let endTimer: NodeJS.Timeout | null = null;
    let alreadyStarted = false;
    let alreadyEnded = false;

    const fireStart = () => {
      if (alreadyStarted) return;
      alreadyStarted = true;
      console.log(`[playback] start (${label})`);
      onStartRef.current?.();
    };
    const fireEnd = () => {
      if (alreadyEnded) return;
      alreadyEnded = true;
      console.log(`[playback] end (${label})`);
      onEndRef.current?.();
    };

    // Safety net for when isLoaded never fires (codec error, missing
    // file, etc.). Cleared as soon as the happy path runs.
    let loadTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      sub.remove();
      loadTimeout = null;
      try {
        player.play();
      } catch {
        /* ignore */
      }
      console.warn(`[playback] no isLoaded after 1s for ${label}`);
      fireStart();
      // Without a duration estimate, wait 5s before re-engaging mic.
      endTimer = setTimeout(fireEnd, 5000);
    }, 1000);

    // Listen for the load event to get the actual duration, then play
    // and schedule the end fire.
    const sub = player.addListener("playbackStatusUpdate", (status) => {
      if (!status.isLoaded) return;
      // Cancel the safety timer — we got isLoaded in time.
      if (loadTimeout) {
        clearTimeout(loadTimeout);
        loadTimeout = null;
      }
      try {
        // Re-enforce speakerphone before each playback (Day 5-F).
        InCallManager.setForceSpeakerphoneOn(true);
        InCallManager.setSpeakerphoneOn(true);
        player.volume = 1.0;

        player.play();
        fireStart();

        const durationMs = Math.max(500, status.duration * 1000);
        // +200ms covers the gap between play() returning and the speaker
        // actually emitting the first sample. Empirical, generous.
        endTimer = setTimeout(fireEnd, durationMs + 200);
        console.log(
          `[playback] loaded → playing ${label} (${(durationMs / 1000).toFixed(2)}s)`,
        );
      } catch (err) {
        console.warn("[playback] play() threw", err);
        // If play() throws, still release the gate so the mic isn't stuck.
        fireStart();
        fireEnd();
      }
      sub.remove(); // one-shot
    });

    try {
      player.replace({ uri });
      console.log(`[playback] replace queued: ${label}`);
    } catch (err) {
      console.warn("[playback] replace failed", err);
      clearTimeout(loadTimeout);
      fireStart();
      fireEnd();
    }

    return () => {
      sub.remove();
      clearTimeout(loadTimeout);
      if (endTimer) clearTimeout(endTimer);
      // If we're cleaning up before end fires (component unmount or
      // URI change), still release the gate so the next turn isn't
      // stuck waiting.
      if (alreadyStarted && !alreadyEnded) {
        fireEnd();
      }
    };
  }, [uri, player]);

  return null;
}

// React.memo prevents parent re-renders (from metric ticks) from
// triggering needless useEffect re-runs. Without it, every chunksSent
// update would re-enter the effect.
export const AudioPlayback = memo(AudioPlaybackInner);
