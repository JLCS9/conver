// Validated environment loader. Mirrors the pattern in backend/lib but
// stays self-contained so the gateway can be deployed without coupling
// to the Next.js codebase.

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8083),

  // Gemini upstream
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  // Live API model ID. As of May 2026, gemini-3.5-flash does NOT support
  // bidiGenerateContent — only the gemini-2.5-flash-native-audio family
  // and gemini-3.1-flash-live-preview do. The "latest" alias rolls forward
  // automatically when Google releases a newer native-audio variant; pin
  // to a dated preview (e.g. gemini-2.5-flash-native-audio-preview-12-2025)
  // for production once we have load.
  GEMINI_MODEL: z.string().min(1).default("gemini-2.5-flash-native-audio-latest"),
  // v1beta is the production WS endpoint. v1alpha exposes the same models
  // but ships pre-release surface (e.g. lyria-realtime-exp). Use v1beta.
  GEMINI_LIVE_WS_URL: z
    .string()
    .url()
    .default(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
    ),

  // Clerk (server SDK uses the same secret as the Next.js backend)
  CLERK_SECRET_KEY: z.string().min(1, "CLERK_SECRET_KEY is required"),

  // Supabase (service role — bypasses RLS for session lookups)
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Logging
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Log issues with full context and exit — env errors are fatal at boot.
    console.error("[voice-gateway] invalid environment:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}
