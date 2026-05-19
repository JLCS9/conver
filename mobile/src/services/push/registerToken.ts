// Push token registration.
//
// Two distinct things happen here:
//   1. Ask Expo for the device-bound push token (an "ExponentPushToken[…]"
//      string we can later send via the Expo Push API).
//   2. POST it to our backend so the cron job knows where to deliver the
//      daily reminder.
//
// The iOS Simulator does not deliver real APNs notifications. Expo's
// getExpoPushTokenAsync will throw with a clear message on simulator. We
// surface that as `simulator: true` so the UI can move on without showing
// a hard error — the user is unblocked, and TestFlight will pick this up
// on a real device.

import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import Constants from "expo-constants";
import { api } from "@/src/lib/api";

export type RegisterResult =
  | { ok: true; token: string }
  | { ok: true; simulator: true } // we deliberately skipped registration
  | { ok: false; error: string };

interface GetTokenOptions {
  /** Expo project id, required by SDK 51+ when calling getExpoPushTokenAsync. */
  projectId?: string;
}

function resolveProjectId(): string | undefined {
  // EAS build sets this; managed workflow without EAS reads from app.config.
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants.easConfig as { projectId?: string } | undefined)?.projectId
  );
}

export async function getDevicePushToken(
  options: GetTokenOptions = {},
): Promise<RegisterResult> {
  try {
    const projectId = options.projectId ?? resolveProjectId();
    const tokenResponse = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    return { ok: true, token: tokenResponse.data };
  } catch (e) {
    const msg = (e as { message?: string }).message ?? "unknown_error";
    // Simulator error messages contain "simulator" or "Must use physical device".
    if (/simulator|physical device/i.test(msg)) {
      return { ok: true, simulator: true };
    }
    return { ok: false, error: msg };
  }
}

/**
 * Registers the Expo push token with our backend. No-op if we're on the
 * simulator — backend never sees a fake token from us.
 */
export async function registerPushToken(
  getToken: () => Promise<string | null>,
): Promise<RegisterResult> {
  const result = await getDevicePushToken();
  if (!result.ok || "simulator" in result) return result;

  try {
    await api("/api/push/register", {
      method: "POST",
      getToken,
      body: JSON.stringify({
        expoPushToken: result.token,
        // deviceId stays undefined in v1 — backend treats it as optional.
        // We'll add expo-application + a stable installation id later if we
        // need to distinguish multiple devices per user (re-install case).
        platform: Platform.OS === "ios" ? "ios" : "android",
      }),
    });
    return result;
  } catch (e) {
    return {
      ok: false,
      error: (e as { message?: string }).message ?? "register_failed",
    };
  }
}
