// Sentry runtime instrumentation hook.
// Next.js 15 calls this once at boot per runtime (node + edge). We only
// init when the DSN is present so a misconfigured dev env doesn't spam
// errors at our own Sentry quota.
//
// DSN comes from SENTRY_DSN (server-side). The mobile app has its own
// EXPO_PUBLIC_SENTRY_DSN that we'll wire up in Week 3 Day 1.

import * as Sentry from "@sentry/nextjs";

export async function register() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[sentry] SENTRY_DSN not set — error reporting disabled");
    }
    return;
  }

  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.init({
      dsn,
      tracesSampleRate: 0.1,
      environment: process.env.NODE_ENV ?? "development",
      // Conservative defaults — we tune sampling once we have real traffic.
      sendDefaultPii: false,
      release: process.env.SENTRY_RELEASE,
    });
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      dsn,
      tracesSampleRate: 0.1,
      environment: process.env.NODE_ENV ?? "development",
      sendDefaultPii: false,
      release: process.env.SENTRY_RELEASE,
    });
  }
}

// Per Next.js docs: also forward server-side request errors to Sentry.
export const onRequestError = Sentry.captureRequestError;
