#!/usr/bin/env node
/**
 * Direct Gemini Live API probe — bypasses our voice-gateway entirely.
 *
 * Useful when the proxied spike times out and we need to figure out whether
 * the issue is (a) our gateway/auth/proxy code, or (b) the message shape we
 * send to Google has drifted since the docs we wrote against.
 *
 * Reads GEMINI_API_KEY from process.env so you don't paste it into shell
 * history. Usage:
 *
 *   GEMINI_API_KEY=AIza... node scripts/probe-gemini-direct.mjs
 *
 * Output: every WS message we send and receive, raw. Greppable.
 */

import WebSocket from "ws";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("Missing GEMINI_API_KEY env var.");
  process.exit(1);
}

const model = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";
const wsUrl =
  process.env.GEMINI_LIVE_WS_URL ??
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent";

const fullUrl = `${wsUrl}?key=${encodeURIComponent(apiKey)}`;
console.log(`Connecting to ${wsUrl} (model=${model})...`);

const ws = new WebSocket(fullUrl);
const startedAt = Date.now();
const ms = () => `${(Date.now() - startedAt).toString().padStart(5, " ")}ms`;

let timer = setTimeout(() => {
  console.error(`\n[${ms()}] TIMEOUT after 25s with no audio response — closing.`);
  try { ws.close(); } catch { /* */ }
  process.exit(1);
}, 25_000);

ws.on("open", () => {
  console.log(`[${ms()}] OPEN — sending setup`);

  const setupMessage = {
    setup: {
      model: `models/${model}`,
      generation_config: {
        response_modalities: ["AUDIO"],
      },
      system_instruction: {
        parts: [
          { text: "You are a friendly English tutor. Speak one short English sentence to start a conversation." },
        ],
      },
    },
  };
  ws.send(JSON.stringify(setupMessage));

  // Give the server ~300ms to ack setup, then send a text turn.
  setTimeout(() => {
    console.log(`[${ms()}] sending client_content text turn`);
    ws.send(
      JSON.stringify({
        client_content: {
          turns: [{ role: "user", parts: [{ text: "Say hello in English." }] }],
          turn_complete: true,
        },
      }),
    );
  }, 300);
});

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    console.log(`[${ms()}] BINARY  ← ${data.length} bytes`);
    return;
  }
  const raw = data.toString("utf8");
  const truncated = raw.length > 400 ? raw.slice(0, 400) + `… (+${raw.length - 400} bytes)` : raw;
  console.log(`[${ms()}] TEXT    ← ${truncated}`);

  // Look for the first audio chunk to know the model is talking.
  if (/audio\/pcm|"audio"|inline_?[Dd]ata/.test(raw)) {
    console.log(`[${ms()}] ✅ first audio-looking chunk detected — protocol is alive`);
    clearTimeout(timer);
    setTimeout(() => {
      try { ws.close(); } catch { /* */ }
      process.exit(0);
    }, 500);
  }
});

ws.on("close", (code, reason) => {
  console.log(`[${ms()}] CLOSE — code=${code} reason="${reason?.toString() ?? ""}"`);
  clearTimeout(timer);
});

ws.on("error", (err) => {
  console.error(`[${ms()}] ERROR — ${err.message ?? err}`);
  clearTimeout(timer);
  process.exit(1);
});
