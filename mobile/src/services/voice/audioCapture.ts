// Microphone capture wrapper around expo-audio's useAudioStream.
//
// expo-audio (SDK 56+) exposes a real streaming PCM API via its `AudioStream`
// class + `useAudioStream` hook — `int16` encoding + onBuffer(ArrayBuffer)
// callback. That's exactly the shape Gemini Live wants for input.
//
// We deliberately do NOT call useAudioStream from useVoiceSession's top-level
// hook. The Day-3 investigation showed that @siteed/audio-studio's
// useAudioRecorder() installed an iOS recording-interruption listener at
// mount time that broke NSURLSessionWebSocketTask. To stay safe, we render
// the consumer (`MicCapture` component) ONLY after the WS is already open
// — so any native side effect of useAudioStream is observed by the gateway
// after the connection is established, not before.
//
// This file just centralizes the encoding constants + the base64 helper
// since `Buffer` isn't on the global in RN 0.85's Hermes (was earlier).

/** Gemini Live's expected input format: PCM 16-bit mono 16 kHz LE. */
export const GEMINI_STREAM_OPTIONS = {
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
