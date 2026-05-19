// Shared zod schemas for backend request validation.
// These live in lib/ rather than inside each route so the same shape can
// be reused (e.g. by a future webhook validator that shadows /api/onboarding)
// and so we get one place to evolve the request contracts.

import { z } from "zod";

// HH:MM 24h time-of-day, hours 00-23, minutes 00-59.
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

/** POST /api/onboarding body. */
export const onboardingBodySchema = z.object({
  role: z.literal("tech").optional(),
  level: z.enum(["beginner", "intermediate", "advanced"]),
  goal: z.enum(["job", "interviews", "confidence", "other"]),
  dailySessionTime: z
    .string()
    .regex(TIME_REGEX, "expected HH:MM 24h, e.g. 08:30"),
  timezone: z.string().min(1).max(64),
});

export type OnboardingBody = z.infer<typeof onboardingBodySchema>;

/** POST /api/push/register body. */
export const pushRegisterBodySchema = z.object({
  expoPushToken: z.string().min(1).max(256),
  deviceId: z.string().max(128).optional(),
  platform: z.enum(["ios", "android"]),
});

export type PushRegisterBody = z.infer<typeof pushRegisterBodySchema>;

/**
 * Parses an untyped request body against a zod schema. On failure returns
 * a Response that the route can hand back directly.
 */
export async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      response: Response.json(
        { error: "bad_request", reason: "invalid_json" },
        { status: 400 },
      ),
    };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      response: Response.json(
        {
          error: "bad_request",
          reason: "validation_failed",
          issues: result.error.issues.map((i) => ({
            path: i.path.join("."),
            code: i.code,
            message: i.message,
          })),
        },
        { status: 400 },
      ),
    };
  }

  return { ok: true, data: result.data };
}
