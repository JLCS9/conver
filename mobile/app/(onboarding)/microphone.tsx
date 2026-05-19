// Final onboarding screen. Educational pre-prompt about the microphone
// — the real iOS permission dialog is intentionally deferred to the
// first voice session (Apple's recommended pattern: ask at the moment
// of use). Surfacing it here would only invite "Don't Allow" before the
// user has experienced any value.
//
// On tap of the CTA: POST the entire wizard state to /api/onboarding,
// then router.replace('/(app)'). On API failure, show the error inline
// and keep the user on this screen — they can retry without losing
// their answers (still in the Zustand store).

import { useAuth } from "@clerk/clerk-expo";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  Text,
  View,
} from "react-native";
import { submitOnboarding } from "@/src/services/onboarding/submit";
import { useOnboardingStore } from "@/src/stores/onboardingStore";

export default function MicrophoneScreen() {
  const router = useRouter();
  const { getToken } = useAuth();
  const reset = useOnboardingStore((s) => s.reset);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async () => {
    setError(null);
    setSubmitting(true);
    const result = await submitOnboarding(getToken);
    setSubmitting(false);

    if (!result.ok) {
      setError(result.error ?? "Algo salió mal. Inténtalo de nuevo.");
      return;
    }

    reset();
    router.replace("/(app)");
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 px-6 pt-12 pb-8 justify-between">
        <View className="gap-6">
          <Text className="text-3xl font-bold text-brand-ink leading-tight">
            Una última cosa: el micrófono
          </Text>
          <Text className="text-base text-brand-muted leading-7">
            Converflow funciona hablando. Cuando empieces tu primera sesión, te
            pediremos permiso para usar el micrófono. No grabamos nada salvo
            durante la conversación — y todo se borra después.
          </Text>
          <View className="gap-3 mt-2">
            <Bullet text="El micrófono solo se activa durante la sesión." />
            <Bullet text="El audio nunca sale del aparato cifrado." />
            <Bullet text="Te lo pediremos cuando empieces, no ahora." />
          </View>
        </View>

        <View className="gap-3">
          {error ? (
            <Text className="text-sm text-red-600 text-center">{error}</Text>
          ) : null}
          <Pressable
            onPress={finish}
            disabled={submitting}
            className="bg-brand rounded-2xl py-4 items-center active:opacity-80 disabled:opacity-60"
          >
            {submitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text className="text-white text-lg font-semibold">
                Empezar mi primer día
              </Text>
            )}
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <View className="flex-row items-start gap-3">
      <View className="w-2 h-2 rounded-full bg-brand mt-2" />
      <Text className="text-base text-brand-ink flex-1 leading-6">{text}</Text>
    </View>
  );
}
