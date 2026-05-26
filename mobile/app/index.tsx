// Root redirect. Two states:
//   1. Clerk session loading → render the splash (ActivityIndicator).
//   2. Signed out → redirect to /(auth)/sign-in.
//   3. Signed in → /(app). The Home screen calls /api/me on mount, which
//      upserts the user row in Supabase, so we don't need to do it here.
//
// Onboarding was made optional in Day 5-B. Role/level/goal are now captured
// conversationally (see task #45). Users who want to set preferences
// manually can still navigate to /(onboarding)/welcome from settings.

import { useAuth } from "@clerk/clerk-expo";
import { Redirect } from "expo-router";
import { ActivityIndicator, SafeAreaView } from "react-native";

export default function Index() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white">
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  return <Redirect href={isSignedIn ? "/(app)" : "/(auth)/sign-in"} />;
}
