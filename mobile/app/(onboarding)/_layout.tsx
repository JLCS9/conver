// Onboarding stack. The whole flow is a single forward path — no back
// button, no swipe-back. Each screen calls `router.push(next)` after the
// user picks; the last screen calls `router.replace('/(app)')` so the
// stack can't be popped back into.
//
// `headerShown: false` lets each screen render its own progress chrome.
import { Stack } from "expo-router";

export default function OnboardingLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        gestureEnabled: false, // disable iOS swipe-back
        animation: "slide_from_right",
      }}
    />
  );
}
