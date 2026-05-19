// Zustand store driving the multi-screen onboarding wizard.
//
// Why Zustand instead of useState lifted to a layout: the wizard has seven
// screens with sibling routes, and Expo Router unmounts components between
// transitions. A store keeps the partially-collected answers alive across
// those transitions without prop drilling or a custom context. The shape
// mirrors the columns we'll push to `public.users` at the end of the flow.
//
// Permission booleans (`hasPushPermission`, `hasMicPermission`) and the push
// token are tracked here only for navigation logic (e.g. skipping a screen if
// the user already granted permission earlier). The actual permission state
// of the OS is queried fresh when needed; the store value is a hint, not the
// source of truth.

import { create } from "zustand";

export type Role = "tech";
export type Level = "beginner" | "intermediate" | "advanced";
export type Goal = "job" | "interviews" | "confidence" | "other";

export interface OnboardingState {
  role: Role | null;
  level: Level | null;
  goal: Goal | null;
  /** Local time of day in "HH:MM" 24h format, e.g. "08:30". */
  dailySessionTime: string | null;
  /** IANA timezone, captured at finalize time from Intl. */
  timezone: string | null;
  hasPushPermission: boolean | null;
  expoPushToken: string | null;
  hasMicPermission: boolean | null;
  isSubmitting: boolean;

  setRole: (role: Role) => void;
  setLevel: (level: Level) => void;
  setGoal: (goal: Goal) => void;
  setDailySessionTime: (time: string) => void;
  setTimezone: (tz: string) => void;
  setPushPermission: (granted: boolean, token?: string) => void;
  setMicPermission: (granted: boolean) => void;
  setSubmitting: (submitting: boolean) => void;
  reset: () => void;
}

const initialState = {
  role: null,
  level: null,
  goal: null,
  dailySessionTime: null,
  timezone: null,
  hasPushPermission: null,
  expoPushToken: null,
  hasMicPermission: null,
  isSubmitting: false,
} as const;

export const useOnboardingStore = create<OnboardingState>((set) => ({
  ...initialState,

  setRole: (role) => set({ role }),
  setLevel: (level) => set({ level }),
  setGoal: (goal) => set({ goal }),
  setDailySessionTime: (dailySessionTime) => set({ dailySessionTime }),
  setTimezone: (timezone) => set({ timezone }),
  setPushPermission: (granted, token) =>
    set({
      hasPushPermission: granted,
      expoPushToken: token ?? null,
    }),
  setMicPermission: (granted) => set({ hasMicPermission: granted }),
  setSubmitting: (isSubmitting) => set({ isSubmitting }),
  reset: () => set({ ...initialState }),
}));
