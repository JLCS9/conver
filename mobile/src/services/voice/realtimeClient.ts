// WebSocket client that talks to our voice-gateway (NOT directly to Google).
//
// Protocol:
//   - Open `wss://api.converflow.tech/voice?sessionId=<uuid>` with the
//     Clerk JWT in the `Sec-WebSocket-Protocol` header as `Bearer.<jwt>`.
//   - Gateway authenticates, opens upstream to Gemini Live, sends the
//     server-side setup. We don't have to send any setup ourselves — the
//     gateway has its own system prompt and model config.
//   - We send audio chunks as JSON: `{ realtime_input: { media_chunks: [
//       { mime_type: 'audio/pcm', data: '<base64 PCM16 16kHz mono>' } ]}}`.
//   - We receive whatever Google sends — protobuf binary frames containing
//     PCM 24 kHz audio + transcripts + turn signals. The caller is
//     responsible for decoding/playing those.
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

export interface RealtimeClientOptions {
  wsUrl: string;
  bearer: string;
  onStatus?: (status: RealtimeStatus) => void;
  onBinary?: (data: ArrayBuffer) => void;
  onText?: (text: string) => void;
  onError?: (err: unknown) => void;
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private status: RealtimeStatus = "idle";
  private readonly opts: RealtimeClientOptions;

  constructor(opts: RealtimeClientOptions) {
    this.opts = opts;
  }

  private setStatus(s: RealtimeStatus) {
    this.status = s;
    this.opts.onStatus?.(s);
  }

  open(): Promise<void> {
    if (this.status !== "idle") {
      return Promise.reject(new Error(`RealtimeClient already in status=${this.status}`));
    }
    return new Promise((resolve, reject) => {
      this.setStatus("connecting");
      // React Native WebSocket accepts subprotocols as second arg. Our
      // gateway looks for "Bearer.<jwt>" in Sec-WebSocket-Protocol.
      const ws = new WebSocket(this.opts.wsUrl, [`Bearer.${this.opts.bearer}`]);
      this.ws = ws;

      ws.onopen = () => {
        this.setStatus("open");
        resolve();
      };
      ws.onerror = (event) => {
        this.opts.onError?.((event as { message?: string }).message ?? event);
        this.setStatus("errored");
        reject(new Error(`WS error: ${(event as { message?: string }).message ?? "unknown"}`));
      };
      ws.onclose = (event) => {
        this.setStatus("closed");
        // expo/react-native WS close event has code + reason
        if (event?.code && event.code !== 1000) {
          this.opts.onError?.(new Error(`WS closed with code ${event.code}: ${event.reason ?? ""}`));
        }
      };
      ws.onmessage = (event) => {
        const data = event.data;
        if (typeof data === "string") {
          this.opts.onText?.(data);
        } else if (data instanceof ArrayBuffer) {
          this.opts.onBinary?.(data);
        } else if (
          typeof Blob !== "undefined" &&
          data instanceof Blob
        ) {
          // React Native sometimes hands binary frames as Blob. Convert.
          data.arrayBuffer().then((buf) => this.opts.onBinary?.(buf));
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
   */
  sendAudioChunk(base64Pcm: string): void {
    if (!this.ws || this.status !== "open") return;
    const message = {
      realtime_input: {
        media_chunks: [{ mime_type: "audio/pcm", data: base64Pcm }],
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
