// Per-session orchestrator for one mobile voice session.
//
// Pipeline (hybrid stack since Day 6):
//
//   client mobile ──audio chunks──▶ Deepgram (STT, streaming)
//                                       │  final transcript on utterance_end
//                                       ▼
//                                   Gemini 2.5 Flash (text completion, streaming)
//                                       │  text deltas
//                                       ▼
//                                   ElevenLabs Flash v2.5 (TTS, streaming)
//                                       │  PCM 24 kHz audio frames
//   client mobile ◀──audio bytes────────┘
//
// Wire format with the mobile (preserved from the original Gemini Live
// integration — keeps the mobile client agnostic to which providers
// power the pipeline):
//
//   Inbound (mobile → gateway), text WS frames:
//     { realtime_input: { media_chunks: [{ mime_type: 'audio/pcm;rate=16000',
//                                           data: '<base64 PCM 16k mono>' }] } }
//
//   Outbound (gateway → mobile), BINARY WS frames carrying JSON:
//     { setupComplete: {} }                                       ack on session open
//     { serverContent: { inputTranscription: { text } } }         user STT (partial / final)
//     { serverContent: { outputTranscription: { text } } }        coach text (delta)
//     { serverContent: { modelTurn: { parts: [{ inlineData: { data } }] } } }  coach audio chunk
//     { serverContent: { turnComplete: true } }                   end of model turn
//     { serverContent: { interrupted: true } }                    LLM/TTS error mid-turn
//
// Echo cancellation (speaker → mic loop) lives on the mobile side
// (Day 6-L+): AudioPlayback's onPlaybackStart/End events flip a
// `coachIsSpeaking` flag that pauses MicCapture's chunk forwarding
// at the source. The gateway just relays whatever audio it receives.

import { WebSocket } from "ws";
import type { Logger } from "pino";
import { openDeepgramStt, type DeepgramSttClient } from "./deepgram.js";
import { openElevenLabsTts } from "./elevenlabs.js";
import {
  buildSystemPrompt,
  streamLLMResponse,
  type ChatMessage,
  type SystemPromptInputs,
} from "./llm.js";
import { insertTranscriptTurn } from "./supabase.js";

/** Log only the first chunk and every 50 thereafter — a status line
 *  every ~5s at 100ms chunks, enough to see flow direction during a
 *  debug window without spamming long sessions. */
function shouldLogAudioChunk(n: number): boolean {
  return n === 1 || n % 50 === 0;
}

const SESSION_START_TOKEN = "__SESSION_START__";

/** How many previous turns to keep in the LLM context. Each turn re-bills
 *  the whole history; dropping the oldest beyond this cap keeps token
 *  spend flat across long sessions. 10 turns ≈ 20 messages ≈ 1–2 KB. */
const HISTORY_TURN_CAP = 10;

export interface ConversationOptions {
  /** Supabase session row id — used to attach persisted transcripts
   *  to the right session for later analysis. */
  sessionId: string;
  /** Internal user id (NOT clerk id) — fk into users table for
   *  transcript inserts. */
  userId: string;
  /** Personalisation inputs assembled from the user's memory at
   *  session start. Empty for brand-new users; richer over time as the
   *  post-session analyser populates the user's profile. */
  promptInputs: SystemPromptInputs;
}

export class Conversation {
  private readonly clientWs: WebSocket;
  private readonly log: Logger;
  private readonly sessionId: string;
  private readonly userId: string;
  private readonly systemPrompt: string;

  private deepgram: DeepgramSttClient | null = null;
  private history: ChatMessage[] = [];

  /** Monotonically increasing turn index for the conversation. Used as
   *  the ordering key when we persist turns to Supabase so we can
   *  reconstruct the conversation in order later. */
  private turnIndex = 0;

  /** Accumulator for Deepgram finals between utterance_end events. */
  private bufferedUserText = "";

  /** Last transcript text we emitted to the client. Deepgram repeats
   *  the same surface text across partial→final and between consecutive
   *  finals; we forward only when the text actually changes. */
  private lastEmittedTranscript = "";

  /** Counters for visibility into how much audio is flowing each way. */
  private chunksFromClient = 0;
  private chunksToClient = 0;

  private closed = false;

  constructor(clientWs: WebSocket, log: Logger, opts: ConversationOptions) {
    this.clientWs = clientWs;
    this.log = log;
    this.sessionId = opts.sessionId;
    this.userId = opts.userId;
    this.systemPrompt = buildSystemPrompt(opts.promptInputs);
  }

  /** Open STT, ack setupComplete, kick off the warm greeting turn. */
  async start(): Promise<void> {
    this.deepgram = openDeepgramStt(
      {
        onPartial: (text) => {
          if (!text) return; // SpeechStarted carries empty text — ignore
          if (text === this.lastEmittedTranscript) return;
          this.lastEmittedTranscript = text;
          this.sendJson({
            serverContent: { inputTranscription: { text } },
          });
        },
        onFinal: (text) => {
          if (text !== this.lastEmittedTranscript) {
            this.lastEmittedTranscript = text;
            this.sendJson({
              serverContent: { inputTranscription: { text } },
            });
          }
          // Concatenate finals; Deepgram emits multiple as it stabilises
          // sub-utterances ("Hi" → "Hi how are you"). The full buffer is
          // consumed once utterance_end fires.
          this.bufferedUserText += (this.bufferedUserText ? " " : "") + text;
        },
        onUtteranceEnd: () => this.handleUtteranceEnd(),
        onError: (err) => {
          this.log.error({ err }, "deepgram error → ending session");
          this.fatal(err);
        },
      },
      this.log.child({ component: "deepgram" }),
    );

    this.sendJson({ setupComplete: {} });

    // Warm greeting so the user doesn't face dead air on session start.
    await this.runLLMTurn(SESSION_START_TOKEN);
  }

  /** Pipe a single inbound WS frame from the mobile client into the STT. */
  handleClientMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (this.closed) return;
    if (isBinary) {
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.deepgram?.close();
  }

  // ─── internals ────────────────────────────────────────────────────────

  /** Wire-encode a server message as a binary frame. Mobile's RealtimeClient
   *  dispatches server messages only from BINARY frames (legacy Gemini Live
   *  wire format); text frames are logged and dropped. */
  private sendJson(obj: object): void {
    if (this.closed || this.clientWs.readyState !== WebSocket.OPEN) return;
    try {
      const payload = Buffer.from(JSON.stringify(obj), "utf-8");
      this.clientWs.send(payload, { binary: true });
    } catch (err) {
      this.log.warn({ err }, "send to client failed (likely closing)");
    }
  }

  /** Fatal error handler: tell the client the session is dead and close. */
  private fatal(err: Error): void {
    this.sendJson({ serverContent: { interrupted: true } });
    this.log.error({ err }, "session fatal");
    this.close();
    try {
      this.clientWs.close(1011, "internal_error");
    } catch {
      /* ignore */
    }
  }

  /** Deepgram detected end of utterance. Drain the buffered transcript
   *  and kick off a model turn. */
  private handleUtteranceEnd(): void {
    const userText = this.bufferedUserText.trim();
    this.bufferedUserText = "";
    this.lastEmittedTranscript = "";
    if (!userText) return;

    // Persist the user turn before running the model — fire-and-forget
    // so we don't block the LLM call on a Supabase round-trip.
    this.turnIndex += 1;
    void insertTranscriptTurn({
      sessionId: this.sessionId,
      userId: this.userId,
      turnIndex: this.turnIndex,
      role: "user",
      text: userText,
    });

    void this.runLLMTurn(userText);
  }

  /** Run one model turn: history + user text → Gemini text stream →
   *  ElevenLabs TTS stream → audio frames to the client. */
  private async runLLMTurn(userText: string): Promise<void> {
    if (this.closed) return;

    const turnLog = this.log.child({ turn: this.history.length + 1 });

    // Push user message to history early so it's recorded even if the
    // turn errors halfway. Session-start is a sentinel, not a real turn.
    if (userText && userText !== SESSION_START_TOKEN) {
      this.history.push({ role: "user", text: userText });
    }

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
          this.sendJson({
            serverContent: {
              modelTurn: {
                parts: [{ inlineData: { data: pcm.toString("base64") } }],
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

    // For SESSION_START we feed a synthetic prompt; for real turns the
    // user message is the latest history entry already pushed above.
    const userMessage =
      userText === SESSION_START_TOKEN
        ? "(Begin the conversation. Open with one warm greeting and an easy open-ended question.)"
        : userText;

    let fullReply = "";
    try {
      for await (const delta of streamLLMResponse({
        history: this.history.slice(0, -1), // exclude the user msg we just pushed
        userMessage,
        systemInstruction: this.systemPrompt,
        log: turnLog.child({ component: "gemini" }),
      })) {
        if (this.closed) break;
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
      return;
    }

    // LLM is done. Flush TTS so it drains and fires isFinal → onComplete.
    tts.flush();

    const trimmedReply = fullReply.trim();
    if (trimmedReply) {
      this.history.push({ role: "model", text: trimmedReply });

      // Persist the model turn. Session-start greetings increment
      // turnIndex here (handleUtteranceEnd didn't run for them).
      if (userText === SESSION_START_TOKEN) this.turnIndex += 1;
      void insertTranscriptTurn({
        sessionId: this.sessionId,
        userId: this.userId,
        turnIndex: this.turnIndex,
        role: "model",
        text: trimmedReply,
      });
    }
    // Bound history so token spend stays flat across long sessions.
    if (this.history.length > HISTORY_TURN_CAP * 2) {
      this.history.splice(0, this.history.length - HISTORY_TURN_CAP * 2);
    }
  }
}
