// iOS audio session configuration for the voice feature.
//
// The combo we want under the hood is `PlayAndRecord` + `voiceChat` mode:
//   - Lets the mic and speaker coexist (needed for our duplex pipe).
//   - Enables iOS's native acoustic echo cancellation (AEC) so the model's
//     output doesn't bleed back into the mic, which would create a feedback
//     loop and confuse VAD.
//   - Routes audio to the speaker by default rather than the earpiece.
//   - Permits Bluetooth devices (AirPods, headphones) so the user has flexibility.
//
// expo-audio (SDK 56+) exposes a simplified cross-platform AudioMode that
// configures the iOS AVAudioSession internally. The category/mode/options
// switch to PlayAndRecord+VoiceChat happens implicitly when allowsRecording
// is true and shouldRouteThroughEarpiece is false. @siteed/audio-studio
// shares the same AVAudioSession, so configuring once applies to both
// recording and playback.

import { setAudioModeAsync } from "expo-audio";

export async function configureForVoiceSession(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
    // 'doNotMix' = exclusive audio focus. If the user has music playing,
    // our session takes over.
    interruptionMode: "doNotMix",
    shouldPlayInBackground: false, // would require background-audio entitlement
    shouldRouteThroughEarpiece: false, // route to speaker
    allowsBackgroundRecording: false,
  });
}

export async function releaseAudioSession(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: false,
    playsInSilentMode: false,
    interruptionMode: "mixWithOthers",
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
  });
}
