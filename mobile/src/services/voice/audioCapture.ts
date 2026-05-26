// Microphone capture wrapper around expo-audio's useAudioStream.
//
// expo-audio (SDK 56+) exposes a real streaming PCM API via its `AudioStream`
// class + `useAudioStream` hook — `int16` encoding + onBuffer(ArrayBuffer)
// callback. That's exactly the shape Deepgram STT wants for input.
//
// We deliberately do NOT call useAudioStream from useVoiceSession's top-level
// hook. Activating the iOS AVAudioSession (which useAudioStream does on mount)
// fires a route-change notification that RN's NSURLSessionWebSocketTask
// treats as a fatal interruption. To stay safe, we render the consumer
// (`MicCapture` component) ONLY after the WS is already open AND after a
// short delay (see session.tsx) — so any native side effect of useAudioStream
// is observed by the gateway after the connection is established and warmed.
//
// This file centralises the encoding constants + the base64 helper.

/** PCM input format the gateway forwards verbatim to Deepgram Nova-3:
 *  16-bit signed little-endian, mono, 16 kHz. Matches Deepgram's default
 *  `linear16 / 16000Hz / 1ch` listen config and is what Gemini Live
 *  expected too — kept the name "STT" because it's now provider-agnostic. */
export const STT_PCM_16K_MONO_OPTIONS = {
  sampleRate: 16_000,
  channels: 1,
  encoding: "int16" as const,
};

/**
 * Converts an ArrayBuffer to a base64 string without depending on Buffer
 * or btoa being on the runtime global (Hermes ships btoa in recent RN,
 * but we keep this self-contained for portability).
 *
 * Chunks the conversion to avoid call-stack overflow on large buffers —
 * String.fromCharCode.apply with too many args throws "Maximum call stack
 * size exceeded".
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000; // 32 KB at a time
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunkSize)),
    );
  }
  // global.btoa exists in Hermes / RN 0.85.
  return btoa(binary);
}
