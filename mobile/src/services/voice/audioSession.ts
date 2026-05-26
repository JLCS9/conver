// iOS audio session configuration for the voice feature.
//
// What we need from iOS at runtime:
//   - PlayAndRecord category (mic + speaker simultaneously).
//   - VoiceChat / VideoChat mode (enables native AEC, treats session as
//     MEDIA not as a voice call → system volume slider stays in Media
//     mode, not Ringer mode).
//   - overrideOutputAudioPort(.speaker) (force speaker output, not the
//     earpiece, in PlayAndRecord category).
//
// Day 5-F arc: expo-audio's `setAudioModeAsync` configures the category
// implicitly (allowsRecording: true → playAndRecord) but does NOT expose
// the iOS *mode* parameter. With mode left at .default, iOS classifies
// the session as a voice call → the volume slider locks to Ringer/Call
// volume → app appears silent if the user keeps Ringer low (which most
// people do). Tried interruptionMode 'doNotMix' → 'duckOthers' →
// 'mixWithOthers' in sequence; none of those alter the iOS mode. We
// confirmed (Day 5-F testing) that the volume slider stops showing
// either Media or Ringer overlay during a session — strong signal that
// the session is in a weird iOS state.
//
// Fix: layer `react-native-incall-manager` on TOP of expo-audio.
// InCallManager calls AVAudioSession.setMode(.voiceChat) and
// overrideOutputAudioPort(.speaker) directly — that's exactly the two
// knobs expo-audio doesn't expose. expo-audio's setAudioModeAsync still
// runs, but only to flip its internal allowsRecording flag so the
// recording hooks know they can capture. InCallManager's session
// settings win on iOS for category/mode/options.

import { setAudioModeAsync } from "expo-audio";
import InCallManager from "react-native-incall-manager";

// Day 5-I: critical bug — calling InCallManager.start() inside this
// function (which runs immediately after the WS handshake) was causing
// the WS to close with code 1005 right after `open`. Logs:
//   [voice] step 3 done, WS open
//   [voice] step 4: configureForVoiceSession...
//   [ws] closed code=1005 reason=""
//
// Root cause is the same iOS audio-interruption-listener footgun
// documented in MicCapture.tsx for Day-2/3: activating AVAudioSession
// after a WS is open fires a route-change notification that React
// Native's NSURLSessionWebSocketTask treats as a fatal interruption
// and aborts the connection.
//
// Fix: split the audio session setup into two phases.
//   - `prepareAudioSessionForVoiceSession()` runs at handshake time;
//     it ONLY touches expo-audio's setAudioModeAsync (which sets the
//     iOS category lazily via expo-audio's queue and does NOT activate
//     the session immediately). Safe to call before MicCapture mounts.
//   - `activateInCallSpeakerphone()` is called by MicCapture AFTER it
//     has mounted (i.e. AFTER the WS is fully live and chunks are
//     already flowing). At that point an audio-route notification
//     can't kill a fresh WS — the WS is already established and
//     React Native treats subsequent route changes as benign.

export async function prepareAudioSessionForVoiceSession(): Promise<void> {
  // Soft setup: tells expo-audio's hooks that recording is allowed and
  // that the session should play in silent mode. Maps to AVAudioSession
  // category playAndRecord but does NOT call setActive(true) immediately
  // — expo-audio defers activation until the first hook (player or
  // recorder) actually needs it. That deferral is what keeps the WS safe.
  await setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
    interruptionMode: "duckOthers",
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
    allowsBackgroundRecording: false,
  });
}

export function activateInCallSpeakerphone(): void {
  // Hard setup: this DOES activate AVAudioSession synchronously and
  // forces the output to the speaker (overriding the default earpiece
  // route that playAndRecord category uses on iOS). Triggers the
  // route-change notification mentioned above — only safe to call
  // AFTER the WS is fully established and being used.
  InCallManager.start({ media: "audio" });
  InCallManager.setForceSpeakerphoneOn(true);
  InCallManager.setSpeakerphoneOn(true);
}

export async function releaseAudioSession(): Promise<void> {
  // Release in reverse order — expo-audio first (so its hooks see
  // allowsRecording: false on next cycle), then InCallManager (which
  // deactivates the AVAudioSession entirely so other apps regain
  // exclusive Media volume control).
  await setAudioModeAsync({
    allowsRecording: false,
    playsInSilentMode: false,
    interruptionMode: "mixWithOthers",
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
  });
  InCallManager.stop();
}

/**
 * @deprecated Use `prepareAudioSessionForVoiceSession()` at handshake
 * time and `activateInCallSpeakerphone()` from inside MicCapture's
 * mount effect. This combined helper is kept only because external
 * call sites (useVoiceSession) still import it during the transition.
 */
export async function configureForVoiceSession(): Promise<void> {
  await prepareAudioSessionForVoiceSession();
}
