import "../global.css";
import { ClerkProvider } from "@clerk/clerk-expo";
import { Slot } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { tokenCache } from "@/src/lib/tokenCache";

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

if (!publishableKey) {
  throw new Error(
    "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is missing. Copy mobile/.env.example to mobile/.env.local.",
  );
}

export default function RootLayout() {
  // SafeAreaProvider exposes useSafeAreaInsets() to descendants so
  // screens like (app)/session.tsx can pad past the iPhone home
  // indicator. Mounted once at the top so every screen benefits.
  return (
    <SafeAreaProvider>
      <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
        <Slot />
      </ClerkProvider>
    </SafeAreaProvider>
  );
}
