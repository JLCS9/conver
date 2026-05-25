import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Converflow",
  slug: "converflow",
  scheme: "converflow",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  ios: {
    bundleIdentifier: "ai.converflow.app",
    supportsTablet: false,
    infoPlist: {
      // Required for App Store; we ask for the mic at session time, not on launch.
      NSMicrophoneUsageDescription:
        "Converflow uses the microphone to let you practice spoken English with an AI tutor.",
    },
  },
  android: {
    package: "ai.converflow.app",
    permissions: ["android.permission.RECORD_AUDIO"],
    adaptiveIcon: { backgroundColor: "#ffffff" },
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    // expo-notifications plugin: adds aps-environment entitlement on iOS so
    // the binary can register for APNs in TestFlight/prod. The iOS Simulator
    // doesn't deliver real APNs, so dev push testing happens on TestFlight.
    "expo-notifications",
    // @siteed/audio-studio config plugin (renamed from expo-audio-stream).
    // Autolinks the native module + wires NSMicrophoneUsageDescription / bg
    // audio if we set it. We already declared NSMicrophoneUsageDescription
    // in infoPlist above; the plugin won't overwrite it.
    "@siteed/audio-studio",
    // expo-audio plugin: needed for setAudioModeAsync + Player on SDK 56+.
    "expo-audio",
  ],
  experiments: {
    typedRoutes: true,
  },
};

export default config;
