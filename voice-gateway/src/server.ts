// Voice-gateway entry point — Day 1 final shape.
//
// Connection flow on `/voice?sessionId=<uuid>`:
//   1. Extract Clerk JWT from Sec-WebSocket-Protocol (`Bearer.<jwt>`).
//   2. Verify the JWT via @clerk/backend — fast, JWKS cached.
//   3. Look up sessionId in public.sessions, validate it belongs to the
//      Clerk user and that it's status='active'.
//   4. Open upstream WS to Google Gemini Live, send the setup message
//      (system prompt + audio formats + transcription on).
//   5. Bidirectional pipe between client and upstream.
//   6. On close from either side: mark session completed/aborted with
//      observed duration, close the other side.

import { createServer, type IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { loadEnv } from "./env.js";
import { logger } from "./logger.js";
import { extractBearerFromSubprotocol, verifyClerkBearer } from "./clerkAuth.js";
import {
  findSessionById,
  findUserByClerkId,
  markSessionAborted,
  markSessionCompleted,
} from "./supabase.js";
import { openUpstream } from "./upstream.js";

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

    const user = await findUserByClerkId(verified.clerkUserId);
    if (!user) {
      rejectSocket(socket, 404, "User Not Found");
      return;
    }

    const session = await findSessionById(sessionId);
    if (!session || session.user_id !== user.id) {
      rejectSocket(socket, 404, "Session Not Found");
      return;
    }
    if (session.status !== "active") {
      rejectSocket(socket, 409, "Session Not Active");
      return;
    }

    wss.handleUpgrade(request, socket as never, head, (ws) => {
      // Pass session context downstream via the request object.
      (request as IncomingMessage & { sessionId?: string }).sessionId = session.id;
      (request as IncomingMessage & { userId?: string }).userId = user.id;
      wss.emit("connection", ws, request);
    });
  })().catch((err) => {
    logger.error({ err }, "upgrade handler crashed");
    rejectSocket(socket, 500, "Server Error");
  });
});

wss.on("connection", async (clientWs, request) => {
  const sessionId =
    (request as IncomingMessage & { sessionId?: string }).sessionId ?? "?";
  const startedAt = Date.now();
  const log = logger.child({ sessionId });

  log.info("client connected, opening upstream");

  let upstreamWs: WebSocket | null = null;
  let closed = false;

  const observedDurationSeconds = () => (Date.now() - startedAt) / 1000;

  const finalize = async (reason: "client_close" | "upstream_close" | "error", err?: unknown) => {
    if (closed) return;
    closed = true;

    const dur = observedDurationSeconds();
    try {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    } catch {
      /* ignore */
    }
    try {
      if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
        upstreamWs.close();
      }
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
    const upstream = await openUpstream();
    upstreamWs = upstream.ws;
  } catch (err) {
    await finalize("error", err);
    return;
  }

  // Bidirectional pipe. Raw forwarding — gateway doesn't parse audio
  // chunks today (cost tracking via byte counts lands in Commit 6 or
  // Day 3). isBinary preserved so binary frames stay binary.
  clientWs.on("message", (data, isBinary) => {
    if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.send(data, { binary: isBinary });
    }
  });

  upstreamWs.on("message", (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  clientWs.on("close", () => {
    void finalize("client_close");
  });
  upstreamWs.on("close", () => {
    void finalize("upstream_close");
  });

  clientWs.on("error", (err) => {
    void finalize("error", err);
  });
  upstreamWs.on("error", (err) => {
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
