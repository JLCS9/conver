// Structured logger. pino is fast and JSON-by-default — the docker logs
// stream stays grep-friendly. In production we leave it raw; in dev we
// could swap in pino-pretty, but that's a devDep we don't need yet.

import pino from "pino";
import { loadEnv } from "./env.js";

const env = loadEnv();

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "voice-gateway" },
  timestamp: pino.stdTimeFunctions.isoTime,
});
