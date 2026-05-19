// Voice-gateway entry point.
//
// Day 1 scope: spin up an HTTP listener with a /health endpoint and a
// WebSocket upgrade path at /voice that echoes incoming messages. No
// auth, no upstream Google connection yet — those land in Commit 5.
// The gateway has to exist as a service before we can wire docker-compose
// (Commit 3) and the backend handshake endpoint (Commit 4) to it.

import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { loadEnv } from "./env.js";
import { logger } from "./logger.js";

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

// Use noServer so we can do per-path WS routing and add auth in a later
// commit without rewiring the listener.
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

  if (url.pathname !== "/voice") {
    // Cleanly reject anything we don't recognize so we don't leak
    // sockets to nginx that can't be closed cleanly.
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws, request) => {
  const remote = request.socket.remoteAddress ?? "unknown";
  logger.info({ remote }, "ws connection opened");

  // Echo for Day 1. Replaced in Commit 5 with Clerk auth + Google upstream.
  ws.on("message", (data, isBinary) => {
    ws.send(data, { binary: isBinary });
  });

  ws.on("close", (code, reason) => {
    logger.info({ remote, code, reason: reason.toString() }, "ws connection closed");
  });

  ws.on("error", (err) => {
    logger.error({ err, remote }, "ws connection errored");
  });
});

httpServer.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, model: env.GEMINI_MODEL },
    "voice-gateway listening (Day 1 scaffold: /voice echoes, no upstream yet)",
  );
});

function gracefulShutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  wss.close(() => {
    httpServer.close(() => process.exit(0));
  });
  // Hard exit after 10s if something is stuck.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
