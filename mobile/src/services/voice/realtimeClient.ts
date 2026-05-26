// WebSocket client that talks to our voice-gateway (NOT directly to any
// upstream provider — the gateway orchestrates Deepgram + Gemini text +
// ElevenLabs since Day 6).
//
// Protocol:
//   - Open `wss://api.converflow.tech/voice?sessionId=<uuid>` with the
//     Clerk JWT carried as `?token=<jwt>` (subprotocol header has shipped
//     buggy on RN/iOS — see comment below).
//   - Gateway authenticates, sets up Deepgram STT + ElevenLabs TTS, and
//     starts a Gemini-Flash-driven greeting. We don't have to send any
//     setup ourselves — the gateway owns the system prompt + model config.
//   - We send mic audio as JSON text frames: `{ realtime_input: {
//       media_chunks: [{ mime_type: 'audio/pcm;rate=16000',
//                         data: '<base64 PCM16 16kHz mono>' }] }}`.
//   - We receive the gateway's server messages as WebSocket BINARY frames
//     carrying UTF-8 JSON (the encoding was inherited from the original
//     Gemini Live integration and kept for backwards compatibility).
//     Decode bytes → JSON → typed ServerMessage events.
//
// State machine:
//   idle → connecting → open → closing → closed
//   any transition can hop to errored.

export type RealtimeStatus =
  | "idle"
  | "connecting"
  | "open"
  | "closing"
  | "closed"
  | "errored";

/**
 * Gateway server-message shape — preserved from the original Gemini Live
 * Bidi spec so mobile stayed unchanged when we swapped the upstream stack.
 * Field names match `https://ai.google.dev/api/live`; the gateway emits
 * the same shape from any provider.
 */
export interface GeminiInlineData {
  /** e.g. "audio/pcm;rate=24000" for model audio output. */
  mimeType?: string;
  /** Base64-encoded payload. For audio, raw PCM int16 LE samples. */
  data?: string;
}

export interface GeminiPart {
  text?: string;
  inlineData?: GeminiInlineData;
}

export interface GeminiTranscription {
  /** Incremental text fragment (delta), not the full transcript. */
  text?: string;
  finished?: boolean;
}

export interface GeminiServerContent {
  modelTurn?: { parts?: GeminiPart[]; role?: string };
  /** Live transcription of the user's microphone input. */
  inputTranscription?: GeminiTranscription;
  /** Live transcription of the model's audio output. */
  outputTranscription?: GeminiTranscription;
  /** Model has finished its current turn. */
  turnComplete?: boolean;
  /** Server-side VAD detected the user starting to speak — cancel any
   * pending playback to honor barge-in. */
  interrupted?: boolean;
  generationComplete?: boolean;
}

export interface GeminiServerMessage {
  setupComplete?: Record<string, unknown>;
  serverContent?: GeminiServerContent;
  usageMetadata?: Record<string, unknown>;
  toolCall?: Record<string, unknown>;
}

export interface RealtimeClientOptions {
  wsUrl: string;
  bearer: string;
  onStatus?: (status: RealtimeStatus) => void;
  /** Raw binary frame (after Blob→ArrayBuffer normalization). Used for
   * byte-count metrics. Fires for every binary frame, including those
   * we also dispatch via `onServerMessage`. */
  onBinary?: (data: ArrayBuffer) => void;
  /** Parsed Gemini server message. Only fires when the binary frame is
   * valid JSON. If JSON parse fails, falls through to `onBinary` only. */
  onServerMessage?: (msg: GeminiServerMessage) => void;
  /** True text frames (rare — Google uses binary opcode for JSON). */
  onText?: (text: string) => void;
  onError?: (err: unknown) => void;
}

/** Dumps first ~200B of a binary frame as ASCII + hex so we can identify
 * the payload format (JSON encoded as bytes vs protobuf vs raw PCM). */
function debugDumpBinary(label: string, data: ArrayBuffer): void {
  const bytes = new Uint8Array(data);
  const previewLen = Math.min(200, bytes.length);
  let asAscii = "";
  for (let i = 0; i < previewLen; i++) {
    const b = bytes[i];
    asAscii += b >= 32 && b < 127 ? String.fromCharCode(b) : ".";
  }
  let asHex = "";
  for (let i = 0; i < Math.min(64, previewLen); i++) {
    asHex += bytes[i].toString(16).padStart(2, "0") + " ";
  }
  console.log(`[ws] ${label} ${data.byteLength}B`);
  console.log(`[ws]   ascii: ${asAscii}`);
  console.log(`[ws]   hex(64): ${asHex}`);
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private status: RealtimeStatus = "idle";
  private readonly opts: RealtimeClientOptions;
  private binaryFrameCounter = 0;

  constructor(opts: RealtimeClientOptions) {
    this.opts = opts;
  }

  private setStatus(s: RealtimeStatus) {
    this.status = s;
    this.opts.onStatus?.(s);
  }

  /** Decode a binary frame as UTF-8 JSON and dispatch the typed event.
   * Returns true if parsing succeeded so the caller can decide whether to
   * also surface the raw bytes (e.g. for byte-count metrics). We always
   * surface raw bytes — JSON parse is best-effort. */
  private tryDispatchServerMessage(data: ArrayBuffer): void {
    if (!this.opts.onServerMessage) return;
    let text: string;
    try {
      // TextDecoder is available in Hermes (RN 0.72+). expo-router and
      // Clerk both rely on it, so we don't need a polyfill.
      text = new TextDecoder("utf-8").decode(data);
    } catch (err) {
      console.warn("[ws] TextDecoder failed on binary frame", err);
      return;
    }
    let msg: GeminiServerMessage;
    try {
      msg = JSON.parse(text) as GeminiServerMessage;
    } catch {
      // Not JSON — could be a future protobuf frame or partial. Silently
      // skip (raw bytes still flow through onBinary for metrics).
      return;
    }
    try {
      this.opts.onServerMessage(msg);
    } catch (err) {
      // Caller threw — surface but don't kill the WS pipe.
      console.warn("[ws] onServerMessage handler threw", err);
    }
  }

  open(timeoutMs = 12_000): Promise<void> {
    if (this.status !== "idle") {
      return Promise.reject(new Error(`RealtimeClient already in status=${this.status}`));
    }
    return new Promise((resolve, reject) => {
      this.setStatus("connecting");
      // Pass the JWT via `?token=` query param instead of the
      // Sec-WebSocket-Protocol subprotocol. React Native's iOS
      // implementation (NSURLSessionWebSocketTask) has shipped buggy
      // subprotocol negotiation across multiple iOS versions and closes
      // wss connections with code 0 before the handshake completes.
      // Query-param auth works on every WS client and is debuggable in
      // nginx access logs. The token is short-lived (~60s Clerk JWT)
      // and carried over TLS, so the log-exposure tradeoff is acceptable
      // for the MVP. We can revisit with a dedicated WS auth scheme
      // (e.g. signed short-lived gateway tokens) post-launch.
      const sep = this.opts.wsUrl.includes("?") ? "&" : "?";
      const authedUrl = `${this.opts.wsUrl}${sep}token=${encodeURIComponent(this.opts.bearer)}`;
      console.log(`[ws] connecting to ${this.opts.wsUrl} (auth via ?token=)`);
      const ws = new WebSocket(authedUrl);
      this.ws = ws;

      // Timeout so a stuck handshake doesn't leave the UI frozen.
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.warn(`[ws] open timeout after ${timeoutMs}ms — closing`);
        try { ws.close(); } catch { /* ignore */ }
        this.setStatus("errored");
        reject(new Error(`WS open timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        console.log("[ws] open");
        this.setStatus("open");
        resolve();
      };
      ws.onerror = (event) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const msg = (event as { message?: string }).message ?? "unknown";
        console.warn(`[ws] error before open: ${msg}`);
        this.opts.onError?.(msg);
        this.setStatus("errored");
        reject(new Error(`WS error: ${msg}`));
      };
      ws.onclose = (event) => {
        const code = event?.code;
        const reason = event?.reason ?? "";
        console.log(`[ws] closed code=${code} reason="${reason}"`);
        this.setStatus("closed");
        if (!settled) {
          // Closed before open succeeded — surface it as a rejection.
          settled = true;
          clearTimeout(timer);
          reject(new Error(`WS closed before open (code ${code}): ${reason}`));
          return;
        }
        if (code && code !== 1000) {
          this.opts.onError?.(new Error(`WS closed with code ${code}: ${reason}`));
        }
      };
      ws.onmessage = (event) => {
        const data = event.data;
        if (typeof data === "string") {
          // First text frame is usually `{"setupComplete":{}}` — log it
          // verbatim so we can confirm the handshake actually completed.
          this.opts.onText?.(data);
        } else if (data instanceof ArrayBuffer) {
          this.binaryFrameCounter += 1;
          // Dump only the first frame per session — enough to confirm
          // the wire format (JSON-as-binary from the gateway) is still
          // what we expect after a redeploy. Anything more pollutes
          // Metro logs with hex dumps once audio starts flowing.
          if (this.binaryFrameCounter === 1) {
            debugDumpBinary(`bin frame #1`, data);
          }
          this.opts.onBinary?.(data);
          this.tryDispatchServerMessage(data);
        } else if (
          typeof Blob !== "undefined" &&
          data instanceof Blob
        ) {
          // React Native sometimes hands binary frames as Blob. Convert.
          data
            .arrayBuffer()
            .then((buf) => {
              this.binaryFrameCounter += 1;
              if (this.binaryFrameCounter === 1) {
                debugDumpBinary(`bin frame #1 (blob)`, buf);
              }
              this.opts.onBinary?.(buf);
              this.tryDispatchServerMessage(buf);
            })
            .catch((err) => {
              // Don't let a Blob decode failure crash the WS as an
              // unhandled promise rejection (would surface as a yellowbox
              // in dev). Surface to the caller via onError so the UI
              // can decide whether to retry.
              console.warn("[ws] Blob → ArrayBuffer failed", err);
              this.opts.onError?.(err);
            });
        } else {
          // Fallback: try generic Buffer-like
          try {
            const buf = (data as { buffer?: ArrayBuffer }).buffer;
            if (buf) this.opts.onBinary?.(buf);
          } catch {
            /* ignore */
          }
        }
      };
    });
  }

  /**
   * Send a PCM 16 kHz mono chunk to Gemini. Caller provides the chunk as a
   * base64-encoded string (the same format @siteed/expo-audio-stream emits).
   *
   * `mime_type` MUST include the `;rate=16000` parameter. Without it
   * Gemini Live v1beta defaults to 24 kHz (its native model rate), which
   * means our 16 kHz samples get reinterpreted 1.5× too fast at upstream
   * STT → audio sounds pitch-shifted/garbled → STT transcribes English
   * speech as random non-English fragments (Arabic, Dutch, Thai...).
   * That's the root cause of the "user transcripts in random languages"
   * symptom observed Day 5-C. Fix: always include the rate hint.
   */
  sendAudioChunk(base64Pcm: string): void {
    if (!this.ws || this.status !== "open") return;
    const message = {
      realtime_input: {
        media_chunks: [
          { mime_type: "audio/pcm;rate=16000", data: base64Pcm },
        ],
      },
    };
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    if (!this.ws) return;
    this.setStatus("closing");
    try {
      this.ws.close(1000, "client_done");
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }
}
