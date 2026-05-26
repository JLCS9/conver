// Validated environment loader. Mirrors the pattern in backend/lib but
// stays self-contained so the gateway can be deployed without coupling
// to the Next.js codebase.

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8083),

  // Gemini text completion (Day 6 hybrid stack — text-only now, no audio).
  // The Live audio path is gone; STT comes from Deepgram and TTS from
  // ElevenLabs. Gemini Flash handles the conversational reasoning between.
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  // Text completion model. Flash is plenty for short tutor-style replies
  // and ~50x cheaper than Pro. Pin to a dated revision once we want
  // reproducibility for prompt-tuning experiments.
  GEMINI_MODEL: z.string().min(1).default("gemini-2.5-flash"),

  // Deepgram (STT — replaces Gemini's built-in speech-to-text). Nova-3
  // is Deepgram's latest as of late 2026, optimised for noisy / accented
  // English and Spanish-speaker code-switching, which is exactly our use
  // case. Pricing: $0.0145/min for pay-as-you-go on Nova-3.
  DEEPGRAM_API_KEY: z.string().min(1, "DEEPGRAM_API_KEY is required"),
  DEEPGRAM_MODEL: z.string().min(1).default("nova-3"),

  // ElevenLabs (TTS — replaces Gemini's native audio output). Flash v2.5
  // is the cheapest streaming option (~$0.30/M chars, ~50ms latency to
  // first audio chunk) and the voice quality beats Gemini's Aoede for
  // conversation. Pick a voice_id in the ElevenLabs dashboard (Rachel /
  // Bella are warm defaults) and pin it here.
  ELEVENLABS_API_KEY: z.string().min(1, "ELEVENLABS_API_KEY is required"),
  ELEVENLABS_VOICE_ID: z
    .string()
    .min(1)
    // "Rachel" — ElevenLabs' default warm-female demo voice. Override in
    // .env once we pick our brand voice.
    .default("21m00Tcm4TlvDq8ikWAM"),
  ELEVENLABS_MODEL_ID: z.string().min(1).default("eleven_flash_v2_5"),

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
