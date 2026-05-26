// Helpers for assembling the gateway's per-turn PCM audio into a WAV
// that expo-audio's AudioPlayer can play.
//
// Wire format (preserved from the original Gemini Live integration):
// the gateway sends `serverContent.modelTurn.parts[].inlineData.data` as
// base64-encoded raw PCM 24 kHz int16 LE mono. Multiple inlineData parts
// arrive within a single turn; we accumulate them into one buffer per
// turn, wrap with a minimal WAV header, write to the cache directory,
// and hand the file URI back so AudioPlayback can `.replace()` + `.play()`.
//
// Why per-turn instead of streaming: expo-audio's AudioPlayer takes a
// finite source (URI or local require). True streaming would need a
// custom Expo module or react-native-audio-api's AudioBufferSourceNode.
// Per-turn buffering adds latency = turn length, fine for tutoring
// (turns ≈ 1-3 sentences ≈ 3-6s). Polish target if we want true
// real-time streaming.

import { File, Paths } from "expo-file-system";

/** PCM format the gateway streams (ElevenLabs output_format=pcm_24000). */
const PCM_SAMPLE_RATE = 24_000;
const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;
const WAV_HEADER_BYTES = 44;

/** Decode base64 → Uint8Array without depending on Buffer (Hermes ships
 *  global `atob` since RN 0.72, no polyfill needed). */
export function base64ToBytes(b64: string): Uint8Array {
  const binStr = atob(b64);
  const len = binStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }
  return bytes;
}

/** Wraps raw PCM int16 LE mono 24 kHz bytes in a minimal WAV container.
 * The header layout follows the standard PCM-WAV spec:
 *   00..03  "RIFF"
 *   04..07  total file size - 8 (little-endian uint32)
 *   08..11  "WAVE"
 *   12..15  "fmt "
 *   16..19  fmt chunk size = 16
 *   20..21  format = 1 (PCM)
 *   22..23  num channels
 *   24..27  sample rate
 *   28..31  byte rate
 *   32..33  block align
 *   34..35  bits per sample
 *   36..39  "data"
 *   40..43  data size
 *   44..    PCM samples
 */
export function buildWavFile(pcmChunks: Uint8Array[]): Uint8Array {
  let totalPcmBytes = 0;
  for (const c of pcmChunks) totalPcmBytes += c.byteLength;

  const fileSize = WAV_HEADER_BYTES + totalPcmBytes;
  const wav = new Uint8Array(fileSize);
  const view = new DataView(wav.buffer);

  // Helper: write 4 ASCII chars (single-byte each).
  const writeAscii = (offset: number, ascii: string) => {
    for (let i = 0; i < ascii.length; i++) {
      view.setUint8(offset + i, ascii.charCodeAt(i));
    }
  };

  const byteRate = (PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_BITS_PER_SAMPLE) / 8;
  const blockAlign = (PCM_CHANNELS * PCM_BITS_PER_SAMPLE) / 8;

  writeAscii(0, "RIFF");
  view.setUint32(4, fileSize - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, PCM_CHANNELS, true);
  view.setUint32(24, PCM_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, PCM_BITS_PER_SAMPLE, true);
  writeAscii(36, "data");
  view.setUint32(40, totalPcmBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (const chunk of pcmChunks) {
    wav.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return wav;
}

/** Writes a WAV byte buffer to the cache dir under a per-turn unique name
 *  and returns its file:// URI for expo-audio's AudioPlayer.
 *  The file persists until the OS purges the cache (we don't manually
 *  delete — session lifetimes are short, cache is ephemeral, and reuse
 *  is unlikely). */
export function writeTurnWavToCache(wav: Uint8Array, label: string): string {
  const file = new File(Paths.cache, `turn-${label}-${Date.now()}.wav`);
  // `overwrite: true` so a fast turn doesn't collide if Date.now() ms-tick
  // happens to repeat in dev. Cheap insurance.
  file.create({ overwrite: true });
  file.write(wav);
  return file.uri;
}

/** True if a transcript delta is plausibly intended English text.
 *
 *  Defence-in-depth guard against STT junk. With Deepgram (Day 6) most
 *  STT hallucinations are now Latin-script gibberish (which still gets
 *  passed through) rather than the Khmer/Thai/Arabic fragments Gemini
 *  Live used to leak. The `<noise>` marker filter and non-Latin guards
 *  below are now mostly inert — kept as cheap insurance against
 *  pathological upstream outputs without slowing down the happy path. */
export function isLikelyMeaningfulEnglish(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return false;

  // Drop pure `<noise>` markers (Gemini's signal for "I heard sound but
  // can't transcribe it"). They're useful in logs, noisy on screen.
  if (/^[\s.<>noise]+$/.test(trimmed)) return false;

  // Reject anything containing a codepoint from the non-Latin scripts
  // we've actually seen leak through (Hebrew, Arabic, Devanagari,
  // Bengali, Gurmukhi, Tamil, Telugu, Malayalam, Sinhala, Thai, Lao,
  // Burmese, CJK ideographs, hiragana/katakana, hangul).
  if (
    /[֐-׿؀-ۿ܀-߿ऀ-ॿঀ-৿਀-੿଀-୿஀-௿ఀ-౿ഀ-ൿ඀-෿฀-๿຀-໿က-႟぀-ヿ一-鿿가-힯]/.test(
      trimmed,
    )
  ) {
    return false;
  }

  return true;
}
