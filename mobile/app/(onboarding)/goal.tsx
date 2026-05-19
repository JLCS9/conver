// Placeholder — filled in Task #9. Real version: job / interviews /
// confidence / other selector, single-choice.

import { Pressable, SafeAreaView, Text, View } from "react-native";
import { useRouter } from "expo-router";

export default function GoalStub() {
  const router = useRouter();
  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 px-6 py-12 justify-center gap-6">
        <Text className="text-3xl font-bold text-brand-ink">¿Tu objetivo?</Text>
        <Text className="text-base text-brand-muted">(Pantalla por implementar — job / interviews / confidence / other.)</Text>
        <Pressable
          onPress={() => router.push("/(onboarding)/time")}
          className="bg-brand rounded-2xl py-4 items-center active:opacity-80"
        >
          <Text className="text-white text-lg font-semibold">Siguiente</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
