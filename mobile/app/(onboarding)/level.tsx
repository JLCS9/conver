// Placeholder — filled in Task #9. Real version: 4 quick self-assessment
// questions mapping to beginner/intermediate/advanced.

import { Pressable, SafeAreaView, Text, View } from "react-native";
import { useRouter } from "expo-router";

export default function LevelStub() {
  const router = useRouter();
  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 px-6 py-12 justify-center gap-6">
        <Text className="text-3xl font-bold text-brand-ink">Tu nivel de inglés</Text>
        <Text className="text-base text-brand-muted">(Pantalla por implementar — 4-pregunta self-assessment.)</Text>
        <Pressable
          onPress={() => router.push("/(onboarding)/goal")}
          className="bg-brand rounded-2xl py-4 items-center active:opacity-80"
        >
          <Text className="text-white text-lg font-semibold">Siguiente</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
