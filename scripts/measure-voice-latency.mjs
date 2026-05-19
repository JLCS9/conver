#!/usr/bin/env node
/**
 * Voice gateway latency spike — run from a laptop on the user's real network
 * (Madrid/Barcelona/wherever) to measure two end-to-end metrics:
 *
 *   1. Connection RTT: HTTP /api/realtime/session POST + WSS upgrade + first
 *      message from Google's setup_complete proxied through us.
 *   2. Text-to-first-audio latency: send a tiny client_content text turn,
 *      measure time-to-first server_content audio chunk.
 *
 * (We use text rather than audio for the prompt because spinning up a real
 * 16kHz PCM capture from a script is overkill for a latency baseline. The
 * full audio path will be measured from the mobile app in Day 2.)
 *
 * Usage:
 *   node scripts/measure-voice-latency.mjs \
 *     --jwt "<copy from a real signed-in mobile app's getToken()>" \
 *     --api https://api.converflow.tech
 *
 * Optional flags:
 *   --runs N   Number of repetitions (default 3). Reports min/median/max.
 *   --quiet    Suppress per-message logging.
 *
 * Requires Node ≥22 for native fetch + WebSocket.
 */

const args = parseArgs(process.argv.slice(2));
if (!args.jwt) {
  console.error("Missing --jwt. Get one from a signed-in mobile app via getToken().");
  process.exit(1);
}
const API = (args.api ?? "https://api.converflow.tech").replace(/\/$/, "");
const RUNS = Number(args.runs ?? 3);

async function once(runIdx) {
  const tStart = performance.now();

  // 1) Handshake — POST /api/realtime/session.
  const sessRes = await fetch(`${API}/api/realtime/session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!sessRes.ok) {
    const body = await sessRes.text();
    throw new Error(`/api/realtime/session ${sessRes.status}: ${body.slice(0, 200)}`);
  }
  const session = await sessRes.json();
  const tAfterHandshake = performance.now();

  if (!args.quiet) {
    console.log(`  [run ${runIdx}] handshake ${ms(tStart, tAfterHandshake)} → sessionId=${session.sessionId.slice(0, 8)}…`);
  }

  // 2) Open WS to the gateway with Bearer subprotocol.
  const ws = new WebSocket(session.wsUrl, [`Bearer.${args.jwt}`]);
  let tFirstUpstream = null;
  let tFirstAudio = null;

  return new Promise((resolve, reject) => {
    const finish = (result) => {
      try { ws.close(); } catch { /* ignore */ }
      resolve(result);
    };

    const timeout = setTimeout(() => {
      reject(new Error(`run ${runIdx}: timeout after 30s`));
      try { ws.close(); } catch { /* ignore */ }
    }, 30_000);

    ws.addEventListener("open", () => {
      if (!args.quiet) {
        console.log(`  [run ${runIdx}] ws open ${ms(tAfterHandshake, performance.now())}`);
      }

      // Send a text prompt so the model has something to respond to.
      // The shape comes from Google Live API: realtime_input with text isn't
      // valid (it expects audio); for text we use client_content.
      const prompt = {
        client_content: {
          turns: [
            {
              role: "user",
              parts: [{ text: "Say one short English sentence to start a conversation." }],
            },
          ],
          turn_complete: true,
        },
      };
      ws.send(JSON.stringify(prompt));
    });

    ws.addEventListener("message", (ev) => {
      const now = performance.now();
      if (tFirstUpstream === null) {
        tFirstUpstream = now;
        if (!args.quiet) {
          console.log(`  [run ${runIdx}] first upstream message ${ms(tAfterHandshake, now)}`);
        }
      }
      // Heuristic: a server_content message with inline_data audio is our
      // first audio chunk. We accept both JSON text and Buffer payloads —
      // Google's Live API typically sends JSON text frames.
      let parsed = null;
      try {
        const raw = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
        parsed = JSON.parse(raw);
      } catch {
        /* binary or non-JSON — ignore for this heuristic */
      }
      if (parsed?.serverContent || parsed?.server_content) {
        const sc = parsed.serverContent ?? parsed.server_content;
        const hasAudio = JSON.stringify(sc).includes("audio/pcm");
        if (hasAudio && tFirstAudio === null) {
          tFirstAudio = now;
          clearTimeout(timeout);
          finish({
            runIdx,
            handshakeMs: tAfterHandshake - tStart,
            firstUpstreamMs: tFirstUpstream - tAfterHandshake,
            timeToFirstAudioMs: now - tAfterHandshake,
          });
        }
      }
    });

    ws.addEventListener("error", (ev) => {
      clearTimeout(timeout);
      reject(new Error(`run ${runIdx}: ws error: ${ev.message ?? "unknown"}`));
    });

    ws.addEventListener("close", () => {
      if (tFirstAudio === null) {
        clearTimeout(timeout);
        reject(new Error(`run ${runIdx}: ws closed before first audio chunk arrived`));
      }
    });
  });
}

(async () => {
  console.log(`Voice latency spike — API ${API}, runs ${RUNS}`);
  const results = [];
  for (let i = 1; i <= RUNS; i++) {
    try {
      const r = await once(i);
      results.push(r);
    } catch (err) {
      console.error(`  ${err.message}`);
    }
    // Brief pause so we don't trigger any per-user rate limits.
    if (i < RUNS) await new Promise((r) => setTimeout(r, 1500));
  }

  if (results.length === 0) {
    console.error("No successful runs.");
    process.exit(1);
  }

  console.log("\nResults:");
  const tofa = results.map((r) => r.timeToFirstAudioMs).sort((a, b) => a - b);
  const handshake = results.map((r) => r.handshakeMs).sort((a, b) => a - b);
  console.log(`  Handshake POST + first ws msg`);
  console.log(`    min ${fmt(handshake[0])} | median ${fmt(handshake[Math.floor(handshake.length / 2)])} | max ${fmt(handshake[handshake.length - 1])}`);
  console.log(`  Text-prompt → first audio chunk (TTFA proxy)`);
  console.log(`    min ${fmt(tofa[0])} | median ${fmt(tofa[Math.floor(tofa.length / 2)])} | max ${fmt(tofa[tofa.length - 1])}`);
  console.log(`\nTarget per brief: <800ms TTFA. Current median: ${fmt(tofa[Math.floor(tofa.length / 2)])}.`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// ---------- helpers ----------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function ms(t0, t1) {
  return `${(t1 - t0).toFixed(0)}ms`;
}
function fmt(v) {
  return `${v.toFixed(0)}ms`;
}
