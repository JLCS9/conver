// Microphone capture wrapper around @siteed/expo-audio-stream.
//
// Emits PCM 16-bit mono 16 kHz chunks via callback at the configured
// interval (50 ms default → 800 samples per chunk → 1600 bytes of PCM →
// ~2.1 KB base64). That matches Gemini Live's expected input format.
//
// The actual recording lifecycle is owned by the caller via the hook
// returned from `useAudioRecorder` in the package. This file just centralizes
// the recording config + start/stop helpers so the screen/hook doesn't
// import the package directly.

import type {
  AudioDataEvent,
  RecordingConfig,
} from "@siteed/expo-audio-stream";

/**
 * Recording config tuned for Gemini Live input: PCM 16-bit, mono, 16 kHz,
 * 50 ms chunk interval, no waveform analysis (we don't render a viz in v1).
 *
 * iOS audio session is configured separately via `audioSession.ts` so the
 * settings apply across the whole module (both recording and playback).
 */
export const GEMINI_RECORDING_CONFIG: RecordingConfig = {
  sampleRate: 16000,
  channels: 1,
  encoding: "pcm_16bit",
  interval: 50,
  keepAwake: true,
  showNotification: false,
  enableProcessing: false,
  ios: {
    audioSession: {
      category: "PlayAndRecord",
      mode: "VoiceChat", // enables hardware AEC — essential for duplex
      categoryOptions: [
        "DefaultToSpeaker",
        "AllowBluetooth",
        "AllowBluetoothA2DP",
      ],
    },
  },
};

/**
 * Coerces the chunk payload from @siteed/expo-audio-stream into the base64
 * string Gemini expects. On native iOS the event ships PCM as a base64
 * string already; on web it's a Float32Array we'd have to convert. We only
 * support native in v1, so this guards the type without doing extra work.
 */
export function chunkToBase64(event: AudioDataEvent): string | null {
  if (typeof event.data === "string") return event.data;
  // Web/Float32Array path — not used in v1 mobile flow.
  return null;
}
