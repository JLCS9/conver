// POST /api/push/register
// Requires a valid Clerk session.
// Registers (or refreshes) an Expo push token for the authenticated user.
// Idempotent on (user_id, expo_push_token) — the unique index in the
// push_tokens table handles duplicates.
//
// Body:
//   {
//     expoPushToken: string,            // ExponentPushToken[...]
//     deviceId?: string,                // installation id from expo-application
//     platform: 'ios' | 'android'
//   }
//
// In the iOS Simulator there is no real APNs delivery, so `getExpoPushTokenAsync`
// either throws or returns a placeholder. The mobile client decides whether
// to call this endpoint; the backend just trusts what arrives.

import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

interface PushRegisterBody {
  expoPushToken: string;
  deviceId?: string;
  platform: "ios" | "android";
}

function badRequest(reason: string) {
  return Response.json({ error: "bad_request", reason }, { status: 400 });
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("invalid_json");
  }

  if (!body || typeof body !== "object") return badRequest("body_must_be_object");
  const b = body as Partial<PushRegisterBody>;

  if (typeof b.expoPushToken !== "string" || b.expoPushToken.length === 0 || b.expoPushToken.length > 256) {
    return badRequest("invalid_expo_push_token");
  }
  if (b.platform !== "ios" && b.platform !== "android") {
    return badRequest("invalid_platform");
  }
  if (b.deviceId !== undefined && (typeof b.deviceId !== "string" || b.deviceId.length > 128)) {
    return badRequest("invalid_device_id");
  }

  const supabase = supabaseAdmin();

  // Look up the internal user id (push_tokens.user_id references public.users).
  const { data: user, error: userErr } = await supabase
    .from("users")
    .select("id")
    .eq("clerk_user_id", userId)
    .single();

  if (userErr || !user) {
    console.error("[/api/push/register] user lookup failed", userErr);
    return Response.json(
      { error: "user_not_found" },
      { status: 404 },
    );
  }

  const { data, error } = await supabase
    .from("push_tokens")
    .upsert(
      {
        user_id: user.id,
        expo_push_token: b.expoPushToken,
        device_id: b.deviceId ?? null,
        platform: b.platform,
        last_used_at: new Date().toISOString(),
        revoked_at: null,
      },
      { onConflict: "user_id,expo_push_token", ignoreDuplicates: false },
    )
    .select("id, user_id, expo_push_token, platform, device_id, created_at, last_used_at")
    .single();

  if (error) {
    console.error("[/api/push/register] upsert failed", error);
    return Response.json(
      { error: "db_error", details: error.message },
      { status: 500 },
    );
  }

  return Response.json({ pushToken: data });
}
