// Per-session orchestrator. Glues the three voice services together:
//
//   client mobile  ──audio chunks──▶ Deepgram (STT)
//                                       │
//                                       │ final transcript
//                                       ▼
//                                     Gemini Flash (LLM, streaming text)
//                                       │
//                                       │ text chunks
//                                       ▼
//                                     ElevenLabs (TTS, streaming audio)
//                                       │
//                                       │ PCM audio frames
//   client mobile  ◀───audio bytes──────┘
//
// The mobile client still speaks the same wire format it used with
// Gemini Live (so no mobile changes were needed for this migration):
//
//   Inbound  (mobile → gateway):
//     - text frames as JSON `{ realtime_input: { media_chunks: [{ mime_type, data }] } }`
//       where data is base64 PCM 16 kHz mono int16 LE.
//
//   Outbound (gateway → mobile):
//     - text frame `{"setupComplete":{}}` once we're ready for audio.
//     - text frame `{"serverContent":{"inputTranscription":{"text":"..."}}}` for user transcripts.
//     - text frame `{"serverContent":{"outputTranscription":{"text":"..."}}}` for model transcripts.
//     - text frame `{"serverContent":{"modelTurn":{"parts":[{"inlineData":{"data":"<base64 PCM 24kHz>"}}]}}}` for model audio.
//     - text frame `{"serverContent":{"turnComplete":true}}` at end of model turn.
//     - text frame `{"serverContent":{"interrupted":true}}` when the model was cut off mid-reply.

import { WebSocket } from "ws";
import type { Logger } from "pino";
import { openDeepgramStt, type DeepgramSttClient } from "./deepgram.js";
import { openElevenLabsTts, type ElevenLabsTtsClient } from "./elevenlabs.js";
import { streamLLMResponse, SYSTEM_INSTRUCTION, type ChatMessage } from "./llm.js";

/** Match the iOS `chunkLogCounterRef` rhythm: log first chunk, then
 *  every 50th. Less log spam at scale, still tells us "audio is flowing". */
function shouldLogAudioChunk(n: number): boolean {
  return n === 1 || n % 50 === 0;
}

export class Conversation {
  private readonly clientWs: WebSocket;
  private readonly log: Logger;

  private deepgram: DeepgramSttClient | null = null;
  private history: ChatMessage[] = [];

  /** True while an LLM/TTS turn is mid-flight. Used to detect barge-in. */
  private inflightAbort: AbortController | null = null;
  private inflightTts: ElevenLabsTtsClient | null = null;

  /** Counters for the gateway-side metrics (mirror the iOS log style). */
  private chunksFromClient = 0;
  private chunksToClient = 0;

  private closed = false;

  constructor(clientWs: WebSocket, log: Logger) {
    this.clientWs = clientWs;
    this.log = log;
  }

  /** Open STT + send the initial setupComplete + kick off a greeting. */
  async start(): Promise<void> {
    this.deepgram = openDeepgramStt(
      {
        onPartial: (text) => {
          if (text) {
            this.sendJson({
              serverContent: { inputTranscription: { text } },
            });
          }
          // Empty `onPartial` (from SpeechStarted) is our barge-in signal.
          if (!text) this.handleBargeIn();
        },
        onFinal: (text) => {
          this.sendJson({
            serverContent: { inputTranscription: { text } },
          });
          // Buffer for the next utterance_end trigger. Deepgram fires
          // multiple `onFinal` events as it stabilises sub-utterances
          // (e.g. "Hi" then "Hi how are you"), so we concatenate with
          // a leading space.
          this.bufferedUserText += (this.bufferedUserText ? " " : "") + text;
        },
        onUtteranceEnd: () => {
          this.handleUtteranceEnd();
        },
        onError: (err) => {
          this.log.error({ err }, "deepgram error → ending session");
          this.fatal(err);
        },
      },
      this.log.child({ component: "deepgram" }),
    );

    // Tell the mobile client we're ready. Mobile uses this as the
    // signal that the WS is fully alive and starts mic capture.
    this.sendJson({ setupComplete: {} });

    // Kick off a warm greeting so the student doesn't face dead air.
    // We use a synthetic "user said nothing" turn — the system prompt
    // instructs the model to open with one warm question.
    await this.runLLMTurn("__SESSION_START__");
  }

  /** Handle one inbound WS frame from the mobile client. */
  handleClientMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (this.closed) return;
    if (isBinary) {
      // Mobile never sends binary in the current protocol — audio is
      // wrapped in JSON `realtime_input`. Log + drop.
      this.log.warn("unexpected binary frame from client; dropping");
      return;
    }
    let msg: { realtime_input?: { media_chunks?: { data: string }[] } };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.log.warn("non-JSON frame from client; dropping");
      return;
    }
    const chunks = msg.realtime_input?.media_chunks;
    if (!chunks || chunks.length === 0) return;
    for (const c of chunks) {
      const pcm = Buffer.from(c.data, "base64");
      this.chunksFromClient += 1;
      if (shouldLogAudioChunk(this.chunksFromClient)) {
        this.log.info(
          { n: this.chunksFromClient, bytes: pcm.byteLength },
          "client audio chunk",
        );
      }
      this.deepgram?.sendAudio(pcm);
    }
  }

  /** Called by server.ts when the client WS closes. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.inflightAbort?.abort();
    } catch {
      /* ignore */
    }
    this.inflightTts?.close();
    this.deepgram?.close();
  }

  // ─── internals ────────────────────────────────────────────────────────

  private sendJson(obj: object): void {
    if (this.closed || this.clientWs.readyState !== WebSocket.OPEN) return;
    try {
      this.clientWs.send(JSON.stringify(obj));
    } catch (err) {
      this.log.warn({ err }, "send to client failed (likely closing)");
    }
  }

  private fatal(err: Error): void {
    this.sendJson({
      serverContent: { interrupted: true },
    });
    this.log.error({ err }, "session fatal");
    this.close();
    try {
      this.clientWs.close(1011, "internal_error");
    } catch {
      /* ignore */
    }
  }

  /**
   * Barge-in: user started speaking while the model was still producing
   * audio. Cancel the LLM stream + close the in-flight TTS, then tell
   * the client to drop any queued playback.
   */
  private handleBargeIn(): void {
    if (!this.inflightAbort && !this.inflightTts) return;
    this.log.info("barge-in detected");
    try {
      this.inflightAbort?.abort();
    } catch {
      /* ignore */
    }
    this.inflightTts?.close();
    this.inflightAbort = null;
    this.inflightTts = null;
    this.sendJson({ serverContent: { interrupted: true } });
  }

  /**
   * Deepgram fired utterance_end — the user has finished talking. The
   * last `onFinal` text is in our history (we'll snapshot it as the user
   * turn). Trigger an LLM + TTS round.
   */
  private handleUtteranceEnd(): void {
    // Pull the latest user transcript from the history. Deepgram already
    // pushed it via onFinal → we sent it to client too, but we kept no
    // local copy. Use the last `inputTranscription` we forwarded.
    // Simpler: buffer the final transcripts as they arrive.
    const userText = this.bufferedUserText.trim();
    this.bufferedUserText = "";
    if (!userText) return;
    void this.runLLMTurn(userText);
  }

  /** Accumulator for Deepgram finals between utterance_end events. */
  private bufferedUserText = "";

  /**
   * Run one LLM turn. Streams Gemini's text → ElevenLabs WS → audio
   * frames → client. Maintains conversation history.
   *
   * Special token "__SESSION_START__" means "open the conversation" —
   * we treat it as the assistant's first turn with no prior user input.
   */
  private async runLLMTurn(userText: string): Promise<void> {
    if (this.closed) return;

    const abort = new AbortController();
    this.inflightAbort = abort;
    const turnLog = this.log.child({ turn: this.history.length + 1 });

    // Push the user message into history NOW so it's there even if the
    // turn aborts. Empty-string user text (session start) is skipped.
    if (userText && userText !== "__SESSION_START__") {
      this.history.push({ role: "user", text: userText });
    }

    // Open the TTS WS as soon as we know we're about to speak. The
    // ~50ms handshake overlaps with the first LLM token.
    const tts = openElevenLabsTts(
      {
        onAudio: (pcm) => {
          this.chunksToClient += 1;
          if (shouldLogAudioChunk(this.chunksToClient)) {
            turnLog.info(
              { n: this.chunksToClient, bytes: pcm.byteLength },
              "model audio chunk",
            );
          }
          // Forward as Gemini-style modelTurn → mobile decodes it
          // without any client-side change.
          this.sendJson({
            serverContent: {
              modelTurn: {
                parts: [
                  {
                    inlineData: { data: pcm.toString("base64") },
                  },
                ],
              },
            },
          });
        },
        onComplete: () => {
          turnLog.info("tts complete → turnComplete to client");
          this.sendJson({ serverContent: { turnComplete: true } });
          tts.close();
        },
        onError: (err) => {
          turnLog.error({ err }, "tts error mid-turn");
          this.sendJson({ serverContent: { interrupted: true } });
          tts.close();
        },
      },
      turnLog.child({ component: "elevenlabs" }),
    );
    this.inflightTts = tts;

    // Stream LLM. Each text delta:
    //   1. Append to TTS WS so audio synthesis stays one step behind.
    //   2. Emit as outputTranscription so the mobile UI can show live text.
    //   3. Accumulate into a final string we'll push into history.
    let fullReply = "";
    const userMessage =
      userText === "__SESSION_START__"
        ? "(Begin the conversation. Open with one warm greeting and an easy open-ended question.)"
        : userText;

    try {
      for await (const delta of streamLLMResponse({
        history: this.history.slice(0, -1), // exclude the just-pushed user
        userMessage,
        systemInstruction: SYSTEM_INSTRUCTION,
        signal: abort.signal,
        log: turnLog.child({ component: "gemini" }),
      })) {
        if (this.closed || abort.signal.aborted) break;
        fullReply += delta;
        tts.appendText(delta);
        this.sendJson({
          serverContent: { outputTranscription: { text: delta } },
        });
      }
    } catch (err) {
      turnLog.error({ err }, "llm stream failed");
      this.sendJson({ serverContent: { interrupted: true } });
      tts.close();
      this.inflightAbort = null;
      this.inflightTts = null;
      return;
    }

    // LLM finished cleanly. Flush TTS so it drains its buffer and fires
    // isFinal → onComplete → turnComplete to client.
    tts.flush();

    if (fullReply.trim()) {
      this.history.push({ role: "model", text: fullReply.trim() });
    }
    this.inflightAbort = null;
    // inflightTts is closed by onComplete handler above.

    // Wire the Deepgram final transcripts into the buffered text. We
    // do it here (instead of in the Deepgram callback) because the
    // callback may fire many times per utterance — buffering by turn
    // boundary is cleaner. NOTE: this needs the onFinal callback to
    // push into bufferedUserText. Actually we already buffer in the
    // method body — left as a note for the next refactor.
  }
}
