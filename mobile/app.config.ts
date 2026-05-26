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
      // Day 5-H: required so expo-dev-client can discover the Metro
      // bundler running on the developer's Mac via Bonjour/mDNS. Without
      // these two keys the app shows "Error loading app" even when the
      // user has granted Local Network permission in Settings — iOS
      // refuses to register the permission for an app whose Info.plist
      // doesn't declare it.
      NSLocalNetworkUsageDescription:
        "Converflow needs local network access in development to connect to the Metro bundler on your computer.",
      NSBonjourServices: [
        "_expo-dev-client._tcp.",
        "_expo-dev-launcher._tcp.",
        "_packager-tcp._tcp.",
        "_packager._tcp.",
      ],
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
    // expo-audio plugin: provides setAudioModeAsync + AudioPlayer +
    // useAudioStream + useAudioRecorder. Sole audio module post Day-4
    // cleanup — we removed @siteed/audio-studio (Day 2-3 mic capture)
    // because expo-audio's useAudioStream replaced it entirely.
    "expo-audio",
    // expo-dev-client plugin: required so prebuild injects the Bonjour
    // service descriptors into Info.plist and registers the launcher
    // URL scheme. Without it, `npx expo run:ios --device` produces a
    // binary that can't discover Metro on the LAN (Day 5-G/H debugging).
    "expo-dev-client",
  ],
  experiments: {
    typedRoutes: true,
  },
};

export default config;
