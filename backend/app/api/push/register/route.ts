// POST /api/push/register
// Requires a valid Clerk session.
// Registers (or refreshes) an Expo push token for the authenticated user.
// Idempotent on (user_id, expo_push_token) — the unique index in the
// push_tokens table handles duplicates.
//
// Body validated by `pushRegisterBodySchema` in lib/schemas.ts.
//
// In the iOS Simulator there is no real APNs delivery, so the mobile
// client only calls this endpoint when getExpoPushTokenAsync succeeded
// on a physical device. Backend trusts what arrives.

import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { parseJsonBody, pushRegisterBodySchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = await parseJsonBody(request, pushRegisterBodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const supabase = supabaseAdmin();

  // Look up the internal user id (push_tokens.user_id references public.users).
  const { data: user, error: userErr } = await supabase
    .from("users")
    .select("id")
    .eq("clerk_user_id", userId)
    .single();

  if (userErr || !user) {
    console.error("[/api/push/register] user lookup failed", userErr);
    return Response.json({ error: "user_not_found" }, { status: 404 });
  }

  const { data, error } = await supabase
    .from("push_tokens")
    .upsert(
      {
        user_id: user.id,
        expo_push_token: body.expoPushToken,
        device_id: body.deviceId ?? null,
        platform: body.platform,
        last_used_at: new Date().toISOString(),
        revoked_at: null,
      },
      { onConflict: "user_id,expo_push_token", ignoreDuplicates: false },
    )
    .select(
      "id, user_id, expo_push_token, platform, device_id, created_at, last_used_at",
    )
    .single();

  if (error) {
    console.error("[/api/push/register] upsert failed", {
      message: error.message,
      code: error.code,
      hint: error.hint,
      details: error.details,
    });
    return Response.json(
      {
        error: "db_error",
        message: error.message,
        code: error.code,
        hint: error.hint,
        details: error.details,
      },
      { status: 500 },
    );
  }

  return Response.json({ pushToken: data });
}
