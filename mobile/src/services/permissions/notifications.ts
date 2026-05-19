// Notification permission flow.
//
// We never call Notifications.requestPermissionsAsync at app launch — Apple
// rejects apps that prompt on cold start, and the opt-in rate is much
// better when the request is preceded by an in-app educational screen.
// The (onboarding)/notifications screen calls into this module after the
// user taps "Permitir" in our own pre-prompt.

import * as Notifications from "expo-notifications";
import { Linking } from "react-native";

export type PermissionResult =
  | { status: "granted" }
  | { status: "denied"; canAskAgain: boolean }
  | { status: "blocked" }; // permanently denied, only Settings can unblock

/**
 * Requests the OS notification permission and normalizes the response.
 * Idempotent — if already granted, returns granted without re-prompting.
 */
export async function requestNotificationPermission(): Promise<PermissionResult> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === "granted") return { status: "granted" };

  // canAskAgain becomes false on iOS once the user denies — the only path
  // back is the Settings app. We surface "blocked" so the UI can deep-link.
  if (existing.status === "denied" && !existing.canAskAgain) {
    return { status: "blocked" };
  }

  const result = await Notifications.requestPermissionsAsync({
    ios: {
      allowAlert: true,
      allowBadge: true,
      allowSound: true,
      allowAnnouncements: false,
    },
  });

  if (result.status === "granted") return { status: "granted" };
  if (!result.canAskAgain) return { status: "blocked" };
  return { status: "denied", canAskAgain: result.canAskAgain ?? true };
}

/** Opens the iOS Settings page for our app so the user can flip permissions. */
export function openAppSettings(): Promise<void> {
  return Linking.openSettings();
}
