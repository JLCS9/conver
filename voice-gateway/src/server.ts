// Voice-gateway entry point — Day 6 hybrid stack shape.
//
// Connection flow on `/voice?sessionId=<uuid>`:
//   1. Extract Clerk JWT from `?token=` (legacy: Sec-WebSocket-Protocol).
//   2. Verify the JWT via @clerk/backend — fast, JWKS cached.
//   3. Look up sessionId in public.sessions, validate it belongs to the
//      Clerk user and that it's status='active'.
//   4. Spin up a Conversation (Deepgram STT → Gemini Flash text →
//      ElevenLabs TTS pipeline). Conversation owns its own state and
//      lifecycle.
//   5. Pipe inbound WS frames into Conversation.handleClientMessage.
//   6. On close from either side: mark session completed/aborted with
//      observed duration, close the Conversation.

import { createServer, type IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { loadEnv } from "./env.js";
import { logger } from "./logger.js";
import { extractBearerFromSubprotocol, verifyClerkBearer } from "./clerkAuth.js";
import {
  findSessionById,
  findUserByClerkId,
  findUserWithMemory,
  markSessionAborted,
  markSessionCompleted,
} from "./supabase.js";
import { Conversation } from "./conversation.js";
import type { SystemPromptInputs } from "./llm.js";

const env = loadEnv();

const httpServer = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "voice-gateway",
        version: "0.1.0",
        timestamp: new Date().toISOString(),
      }),
    );
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

// No subprotocol negotiation — auth travels as a `?token=` query param
// instead. React Native's iOS WebSocket has a long history of buggy
// subprotocol handling over WSS; query-param auth sidesteps it entirely
// and is easier to debug from nginx access logs.
const wss = new WebSocketServer({ noServer: true });

function rejectSocket(socket: NodeJS.WritableStream, status: number, reason: string) {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`,
  );
  // socket is a Duplex; destroy ends both sides.
  (socket as unknown as { destroy: () => void }).destroy();
}

httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname !== "/voice") {
    rejectSocket(socket, 404, "Not Found");
    return;
  }

  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    rejectSocket(socket, 400, "Bad Request");
    return;
  }

  // Auth: ?token=<clerk_jwt> in the WS URL. See realtimeClient.ts in
  // the mobile app for the why behind query-param instead of subprotocol.
  // Fallback to the legacy Bearer.<jwt> subprotocol so older clients
  // keep working during a rolling app update.
  const bearer =
    url.searchParams.get("token") ??
    extractBearerFromSubprotocol(
      request.headers["sec-websocket-protocol"],
    );
  if (!bearer) {
    rejectSocket(socket, 401, "Unauthorized");
    return;
  }

  // Heavy lifting is async — keep socket alive until auth + lookup return.
  void (async () => {
    const verified = await verifyClerkBearer(bearer);
    if (!verified) {
      rejectSocket(socket, 401, "Unauthorized");
      return;
    }

    // Day 7-B: fetch user + memory in one batched call. Doing it in
    // the upgrade handler (before the WS handshake completes) trades
    // ~50ms of handshake latency for a single round-trip that
    // populates the system prompt. The mobile's audioReady delay
    // (600ms after WS open) already absorbs any extra latency here.
    const memory = await findUserWithMemory(verified.clerkUserId, {
      vocabLimit: 30,
      correctionsLimit: 10,
    });
    if (!memory) {
      rejectSocket(socket, 404, "User Not Found");
      return;
    }
    const user = memory.user;

    const session = await findSessionById(sessionId);
    if (!session || session.user_id !== user.id) {
      rejectSocket(socket, 404, "Session Not Found");
      return;
    }
    if (session.status !== "active") {
      rejectSocket(socket, 409, "Session Not Active");
      return;
    }

    // Translate Supabase memory into the SystemPromptInputs shape that
    // buildSystemPrompt understands. Doing the shaping HERE (not in
    // the LLM module) keeps llm.ts pure of Supabase types.
    const promptInputs: SystemPromptInputs = {
      profession: user.user_context.profession,
      interests: user.user_context.interests,
      speakingLevel: user.user_context.speaking_level,
      lastTopics: user.user_context.last_topics,
      focusGrammar: user.user_context.focus_areas,
      // Words the user uses most → encourage variety beyond these.
      overusedWords: memory.topVocabulary.slice(0, 10).map((v) => v.word),
    };

    wss.handleUpgrade(request, socket as never, head, (ws) => {
      // Pass session context + system prompt inputs downstream.
      const reqWithCtx = request as IncomingMessage & {
        sessionId?: string;
        userId?: string;
        promptInputs?: SystemPromptInputs;
      };
      reqWithCtx.sessionId = session.id;
      reqWithCtx.userId = user.id;
      reqWithCtx.promptInputs = promptInputs;
      wss.emit("connection", ws, request);
    });
  })().catch((err) => {
    logger.error({ err }, "upgrade handler crashed");
    rejectSocket(socket, 500, "Server Error");
  });
});

wss.on("connection", async (clientWs, request) => {
  const reqCtx = request as IncomingMessage & {
    sessionId?: string;
    userId?: string;
    promptInputs?: SystemPromptInputs;
  };
  const sessionId = reqCtx.sessionId ?? "?";
  const userId = reqCtx.userId ?? "?";
  const promptInputs = reqCtx.promptInputs ?? {};
  const startedAt = Date.now();
  const log = logger.child({ sessionId });

  log.info(
    {
      hasProfession: !!promptInputs.profession,
      interestsCount: promptInputs.interests?.length ?? 0,
      overusedWordsCount: promptInputs.overusedWords?.length ?? 0,
      focusGrammarCount: promptInputs.focusGrammar?.length ?? 0,
    },
    "client connected, starting Conversation pipeline",
  );

  let closed = false;
  const conversation = new Conversation(clientWs, log, {
    sessionId,
    userId,
    promptInputs,
  });

  const observedDurationSeconds = () => (Date.now() - startedAt) / 1000;

  const finalize = async (reason: "client_close" | "error", err?: unknown) => {
    if (closed) return;
    closed = true;

    const dur = observedDurationSeconds();
    conversation.close();
    try {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    } catch {
      /* ignore */
    }

    if (reason === "error") {
      log.error({ err, durationSeconds: dur }, "session aborted by error");
      await markSessionAborted(
        sessionId,
        dur,
        err instanceof Error ? err.message : String(err),
      ).catch((e) => log.error({ e }, "markSessionAborted failed"));
    } else {
      log.info({ reason, durationSeconds: dur }, "session completed");
      await markSessionCompleted(sessionId, dur).catch((e) =>
        log.error({ e }, "markSessionCompleted failed"),
      );
    }
  };

  try {
    await conversation.start();
  } catch (err) {
    await finalize("error", err);
    return;
  }

  // Forward inbound WS frames into the Conversation. The Conversation
  // owns all the side effects (STT routing, LLM, TTS) from this point.
  clientWs.on("message", (data, isBinary) => {
    conversation.handleClientMessage(data, isBinary);
  });

  clientWs.on("close", (code, reason) => {
    // Client close with code 1000 = clean ("user tapped Stop"); anything
    // else = abnormal (network drop, app crashed). Map to the right
    // analytics outcome so dashboards don't lie.
    if (code === 1000) {
      void finalize("client_close");
    } else {
      void finalize(
        "error",
        new Error(`client closed abnormally: code=${code} reason=${reason?.toString() ?? ""}`),
      );
    }
  });
  clientWs.on("error", (err) => {
    void finalize("error", err);
  });
});

httpServer.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, model: env.GEMINI_MODEL },
    "voice-gateway listening — auth + upstream proxy active",
  );
});

function gracefulShutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  wss.close(() => {
    httpServer.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
