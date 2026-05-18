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
  plugins: ["expo-router", "expo-secure-store"],
  experiments: {
    typedRoutes: true,
  },
};

export default config;
