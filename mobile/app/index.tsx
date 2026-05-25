// Root redirect. Three states:
//   1. Clerk session loading → render the splash (ActivityIndicator).
//   2. Signed out → redirect to /(auth)/sign-in.
//   3. Signed in → hit GET /api/me to learn whether onboarding is done:
//        onboarding_completed_at IS NULL → /(onboarding)/welcome
//        onboarding_completed_at IS NOT NULL → /(app)
//
// If /api/me fails (network down, backend hiccup), we fail open to /(app)
// — Home will retry the call and show its own error UI. Failing closed
// to the auth screen would be worse: a user with a valid Clerk session
// would be unable to enter the app while the backend is degraded.

import { useAuth } from "@clerk/clerk-expo";
import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, SafeAreaView } from "react-native";
import { api } from "@/src/lib/api";

type MeResponse = {
  user: {
    onboarding_completed_at: string | null;
  };
};

type Destination =
  | "/(auth)/sign-in"
  | "/(onboarding)/welcome"
  | "/(app)";

export default function Index() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [destination, setDestination] = useState<Destination | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setDestination("/(auth)/sign-in");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const { user } = await api<MeResponse>("/api/me", { getToken });
        if (cancelled) return;
        setDestination(
          user.onboarding_completed_at
            ? "/(app)"
            : "/(onboarding)/welcome",
        );
      } catch (e) {
        // Fail open: home will retry /api/me and surface the error.
        console.warn("[root] /api/me failed during gating", e);
        if (!cancelled) setDestination("/(app)");
      }
    })();

    return () => {
      cancelled = true;
    };
    // getToken is intentionally NOT in deps: Clerk re-creates the function
    // reference on every render, which would re-run this effect after every
    // setState (we saw 843 /api/me calls in <2 minutes before this fix).
    // The captured getToken closure still mints fresh JWTs internally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, isSignedIn]);

  if (!destination) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white">
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  return <Redirect href={destination} />;
}
