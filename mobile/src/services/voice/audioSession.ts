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

export async function configureForVoiceSession(): Promise<void> {
  // 1. InCallManager FIRST — it owns AVAudioSession at the OS level.
  //    `media: "audio"` puts iOS in playAndRecord + voiceChat mode +
  //    activates the session. Equivalent to AVAudioSession's
  //    setCategory(.playAndRecord, mode: .voiceChat, ...) + setActive(true).
  InCallManager.start({ media: "audio" });
  // 2. Force speaker output. Without this, PlayAndRecord defaults to
  //    earpiece (very quiet) on iOS. Both setForce and setSpeakerphoneOn
  //    are called because empirically one without the other doesn't
  //    always stick — InCallManager's docs recommend the pair.
  InCallManager.setForceSpeakerphoneOn(true);
  InCallManager.setSpeakerphoneOn(true);

  // 3. expo-audio session settings — for its recording/playback hooks
  //    to know that recording is allowed and playback should bypass
  //    silent mode. These don't override InCallManager's mode setting.
  await setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
    interruptionMode: "duckOthers",
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
    allowsBackgroundRecording: false,
  });
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
