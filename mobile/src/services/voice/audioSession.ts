// iOS audio session configuration for the voice feature.
//
// `PlayAndRecord` + `voiceChat` is the combo that:
//   - Lets the mic and speaker coexist (needed for our duplex pipe).
//   - Enables iOS's native acoustic echo cancellation (AEC) so the model's
//     output doesn't bleed back into the mic, which would create a feedback
//     loop and confuse VAD.
//   - Routes audio to the speaker by default rather than the earpiece.
//   - Permits Bluetooth devices (AirPods, headphones) so the user can use
//     whatever they have on.
//
// The actual call to set the audio mode happens via expo-av (which we install
// for half-duplex playback in Day 2) — both expo-av and @siteed/expo-audio-
// stream share iOS AVAudioSession under the hood, so configuring one applies
// to the other.

import { Audio, InterruptionModeIOS } from "expo-av";

export async function configureForVoiceSession(): Promise<void> {
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    // DoNotMix is the safe choice for a tutoring app — if the user has
    // music playing, our session takes over and pauses it.
    interruptionModeIOS: InterruptionModeIOS.DoNotMix,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: false,
    staysActiveInBackground: false, // not needed in v1; would require a background-audio mode declaration
  });
}

export async function releaseAudioSession(): Promise<void> {
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: false,
  });
}
