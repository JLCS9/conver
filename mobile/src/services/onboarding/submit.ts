// Submits the wizard answers to the backend. Called by the last
// onboarding screen (microphone). Reads from the Zustand store at the
// moment of submission — no need to thread state through the screen.

import { api } from "@/src/lib/api";
import {
  type OnboardingState,
  useOnboardingStore,
} from "@/src/stores/onboardingStore";

interface SubmitResult {
  ok: boolean;
  error?: string;
}

function resolveTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "Europe/Madrid";
  } catch {
    return "Europe/Madrid";
  }
}

export async function submitOnboarding(
  getToken: () => Promise<string | null>,
): Promise<SubmitResult> {
  const state: OnboardingState = useOnboardingStore.getState();

  // Sanity check: role/level/goal/dailySessionTime must all be set by now.
  // We don't render a continue button without them, but a programming error
  // upstream would silently 400 here without this guard.
  if (!state.role || !state.level || !state.goal || !state.dailySessionTime) {
    return { ok: false, error: "missing_onboarding_field" };
  }

  const timezone = state.timezone ?? resolveTimezone();

  state.setSubmitting(true);
  try {
    await api("/api/onboarding", {
      method: "POST",
      getToken,
      body: JSON.stringify({
        role: state.role,
        level: state.level,
        goal: state.goal,
        dailySessionTime: state.dailySessionTime,
        timezone,
      }),
    });
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: (e as { message?: string }).message ?? "submit_failed",
    };
  } finally {
    state.setSubmitting(false);
  }
}
