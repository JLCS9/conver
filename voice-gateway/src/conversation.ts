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
            // Dedupe: Deepgram fires many partials per utterance as the
            // STT refines its guess ("Hi", "Hi.", "Hi. Hi.", ...). The
            // same text often repeats verbatim between partial + final.
            // Emit only when the surface text changes.
            if (text !== this.lastEmittedTranscript) {
              this.lastEmittedTranscript = text;
              this.sendJson({
                serverContent: { inputTranscription: { text } },
              });
            }
          }
          // Day 6-O: empty onPartial used to call handleBargeIn().
          // No longer needed — client-side mic gating (Day 6-L) means
          // the user can't physically speak during a coach turn (the
          // mic is muted at the source on the device). When Deepgram
          // fires SpeechStarted it's always a LEGITIMATE new user
          // turn, not an interruption. Firing a barge-in here would
          // spuriously send `interrupted: true` to the client after
          // every coach turn → mobile thinks the model was cut off
          // and gets into a weird "blocked" UI state.
        },
        onFinal: (text) => {
          if (text !== this.lastEmittedTranscript) {
            this.lastEmittedTranscript = text;
            this.sendJson({
              serverContent: { inputTranscription: { text } },
            });
          }
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

    // Day 6-L: Removed the server-side half-duplex gate. Estimating
    // when the client finishes playing TTS from server-side bytes +
    // timers was unreliable (off by hundreds of ms either way: too
    // tight → coach voice leaks into user transcript; too loose →
    // user's voice is silently dropped for seconds). Gating now lives
    // on the mobile (AudioPlayback fires onPlaybackStart/onPlaybackEnd
    // events, MicCapture drops onChunk calls while paused). The
    // gateway just forwards every chunk it receives to Deepgram.

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

  /**
   * Send a server message to the mobile client. Encodes JSON-as-binary
   * to match what Gemini Live used to emit, because the mobile's
   * `RealtimeClient` only dispatches `tryDispatchServerMessage` from
   * BINARY frames (`onBinary`). Text frames go to `onText` which only
   * logs — no transcript / audio / metrics handling fires. Sending as
   * Buffer keeps the wire-compatible behaviour the mobile expects.
   */
  private sendJson(obj: object): void {
    if (this.closed || this.clientWs.readyState !== WebSocket.OPEN) return;
    try {
      const payload = Buffer.from(JSON.stringify(obj), "utf-8");
      this.clientWs.send(payload, { binary: true });
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
   * Barge-in: user started speaking while the model was actually
   * producing audio (not just starting up). Cancel the in-flight LLM
   * stream + close TTS, tell the client to drop queued playback.
   *
   * Gating on `modelHasStartedSpeaking` matters: Deepgram fires
   * SpeechStarted on every utterance, including the user's very first
   * one in the session. Without this gate, the first user utterance
   * would cancel the warm-up greeting before any audio had been sent
   * to the client — which is exactly what the Day 6 test showed
   * (interrupted frame immediately after setupComplete, no greeting
   * audio ever played).
   */
  private handleBargeIn(): void {
    if (!this.modelHasStartedSpeaking) return;
    if (!this.inflightAbort && !this.inflightTts) return;
    this.log.info("barge-in detected (model was speaking)");
    try {
      this.inflightAbort?.abort();
    } catch {
      /* ignore */
    }
    this.inflightTts?.close();
    this.inflightAbort = null;
    this.inflightTts = null;
    this.modelHasStartedSpeaking = false;
    this.sendJson({ serverContent: { interrupted: true } });
  }

  /** Flips true on the first model audio chunk of a turn, back to false
   *  on turnComplete or barge-in. The barge-in gate uses this so we
   *  don't cancel a turn before the user can even hear it. */
  private modelHasStartedSpeaking = false;

  /**
   * Deepgram fired utterance_end — the user has finished talking. The
   * last `onFinal` text is in our history (we'll snapshot it as the user
   * turn). Trigger an LLM + TTS round.
   */
  private handleUtteranceEnd(): void {
    const userText = this.bufferedUserText.trim();
    this.bufferedUserText = "";
    // Reset the dedupe guard so the next utterance's "Hi" doesn't get
    // suppressed because the previous one ended with "Hi" too.
    this.lastEmittedTranscript = "";
    if (!userText) return;
    void this.runLLMTurn(userText);
  }

  /** Accumulator for Deepgram finals between utterance_end events. */
  private bufferedUserText = "";

  /** Last transcript text we emitted to the client (dedupe guard).
   *  Deepgram repeats the same surface text across partial → final and
   *  even across consecutive finals; we only emit when it changes. */
  private lastEmittedTranscript = "";

  /** How many previous turns to keep in the LLM context. Older history
   *  is dropped to bound per-call token cost (each turn re-bills history).
   *  10 turns ≈ 20 messages ≈ 1-2 KB of context, plenty for casual chat. */
  private readonly HISTORY_TURN_CAP = 10;

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

    // Belt-and-braces safety: regardless of what happens (LLM stall,
    // TTS hang, lost callback, network drop) the mic must come back
    // online within 30 seconds. Without this, a single missed
    // onComplete leaves the user permanently muted while the UI shows
    // the session as healthy — exactly the "app aparece bien pero no
    // procesa" symptom we hit. The setTimeouts in the success path
    // fire well before 30s, so this only kicks in on real anomalies.
    const safetyTimer = setTimeout(() => {
      if (this.modelHasStartedSpeaking) {
        turnLog.warn(
          "30s safety timeout — force-releasing mic gate",
        );
        this.modelHasStartedSpeaking = false;
      }
    }, 30_000);

    // Push the user message into history NOW so it's there even if the
    // turn aborts. Empty-string user text (session start) is skipped.
    if (userText && userText !== "__SESSION_START__") {
      this.history.push({ role: "user", text: userText });
    }

    // Track audio bytes + first-chunk timestamp so we can estimate
    // when the client will finish playing (the mic-ducking gate needs
    // to stay engaged until then, not just until the gateway is done
    // sending). PCM 24 kHz mono int16 = 48000 bytes/second.
    let audioBytesThisTurn = 0;
    let firstAudioAtMs = 0;
    const PCM_24K_MONO_BYTES_PER_SEC = 48000;

    // Open the TTS WS as soon as we know we're about to speak. The
    // ~50ms handshake overlaps with the first LLM token.
    const tts = openElevenLabsTts(
      {
        onAudio: (pcm) => {
          // Flip the barge-in gate the first time audio actually flows
          // to the client. Until this point, an interrupting user
          // utterance shouldn't cancel anything — the greeting hasn't
          // even been heard yet.
          this.modelHasStartedSpeaking = true;
          if (firstAudioAtMs === 0) firstAudioAtMs = Date.now();
          audioBytesThisTurn += pcm.byteLength;

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

          // Delay the mic re-engage until the client has finished
          // playing the audio we just streamed. ElevenLabs delivers
          // audio roughly in real-time, so when isFinal arrives the
          // last bytes are still in flight + buffered for playback on
          // the client. Estimate remaining playback time from total
          // bytes streamed vs wall-clock since first chunk.
          const audioDurationMs =
            (audioBytesThisTurn / PCM_24K_MONO_BYTES_PER_SEC) * 1000;
          const elapsedSinceFirstChunkMs =
            firstAudioAtMs > 0 ? Date.now() - firstAudioAtMs : 0;
          const remainingPlaybackMs = Math.max(
            0,
            audioDurationMs - elapsedSinceFirstChunkMs,
          );
          // Safety margin needs to cover:
          //   - Network jitter to client (~50-150ms)
          //   - Client-side latency from receiving WAV to calling
          //     player.play() (load, decode, isLoaded event → 200-400ms
          //     in our expo-audio setup)
          //   - The full audio duration of client-side playback (the
          //     player starts AFTER turnComplete on the client, so
          //     playback effectively shifts forward by all of the above)
          //   - Speaker tail / room reverb (~200-300ms)
          //
          // 400ms was too tight: Day 6-I logs showed coach voice
          // ('Going so far. Yes.') still being captured after the gate
          // lifted. 1500ms gives comfortable headroom at the cost of
          // a ~1s pause after the coach finishes before the user can
          // be heard. Acceptable for the demo's natural turn-taking.
          const reEngageInMs = remainingPlaybackMs + 1500;
          turnLog.info(
            { reEngageInMs, audioDurationMs },
            "scheduling mic re-engage after playback",
          );
          setTimeout(() => {
            this.modelHasStartedSpeaking = false;
          }, reEngageInMs);
        },
        onError: (err) => {
          turnLog.error({ err }, "tts error mid-turn");
          this.sendJson({ serverContent: { interrupted: true } });
          tts.close();
          // CRITICAL: reset the mic gate. Without this, a TTS error
          // leaves modelHasStartedSpeaking=true forever and the mic
          // is gated for the rest of the session — app appears alive
          // but never processes another word from the user.
          this.modelHasStartedSpeaking = false;
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
      // Defensive: ensure the mic gate is released so the user isn't
      // stuck if LLM failed mid-turn.
      this.modelHasStartedSpeaking = false;
      return;
    }

    // LLM finished cleanly. Flush TTS so it drains its buffer and fires
    // isFinal → onComplete → turnComplete to client.
    tts.flush();

    if (fullReply.trim()) {
      this.history.push({ role: "model", text: fullReply.trim() });
    }
    // Day 6-O: explicitly null inflightTts on the success path.
    // Previously it stayed pointing at the closed tts object, which
    // tricked any later code reading `this.inflightTts` into thinking
    // a turn was still in flight.
    this.inflightTts = null;
    // Bound history to keep token cost flat over long sessions. Each
    // LLM call re-bills the whole context, so unbounded growth is a
    // quadratic cost curve in token spend. Drop the oldest turns once
    // we exceed the cap — keep the most recent context which is what
    // the model needs most for coherence.
    if (this.history.length > this.HISTORY_TURN_CAP * 2) {
      const drop = this.history.length - this.HISTORY_TURN_CAP * 2;
      this.history.splice(0, drop);
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
