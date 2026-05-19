// First screen the user sees after sign-up. Sets expectations: short
// daily voice sessions, ~60s to finish the setup. No data collected here
// — just an intro and a "Empezar" CTA that pushes to notifications.tsx
// (push permission is asked first because it's the habit-engine).

import { Pressable, SafeAreaView, Text, View } from "react-native";
import { useRouter } from "expo-router";

export default function Welcome() {
  const router = useRouter();

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 px-6 pt-12 pb-8 justify-between">
        <View className="gap-6">
          <Text className="text-4xl font-bold text-brand-ink leading-tight">
            Bienvenido a Converflow
          </Text>
          <Text className="text-lg text-brand-muted leading-7">
            5-10 minutos al día hablando inglés con un tutor de IA. Construye el
            hábito, gana confianza, mejora tu inglés profesional.
          </Text>
          <View className="gap-3 mt-4">
            <Row label="Sesiones cortas de voz cada día" />
            <Row label="Feedback concreto al final de cada sesión" />
            <Row label="Una racha que te ayuda a no fallar un día" />
          </View>
        </View>

        <View className="gap-3">
          <Text className="text-sm text-brand-muted text-center">
            Vamos a configurar tu cuenta en menos de un minuto.
          </Text>
          <Pressable
            onPress={() => router.push("/(onboarding)/notifications")}
            className="bg-brand rounded-2xl py-4 items-center active:opacity-80"
          >
            <Text className="text-white text-lg font-semibold">Empezar</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

function Row({ label }: { label: string }) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="w-2 h-2 rounded-full bg-brand" />
      <Text className="text-base text-brand-ink flex-1">{label}</Text>
    </View>
  );
}
