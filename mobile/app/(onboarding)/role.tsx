// Placeholder — filled in Task #9. Real version offers only "Desarrollador / Tech"
// in v1; other roles disabled with "coming soon".

import { Pressable, SafeAreaView, Text, View } from "react-native";
import { useRouter } from "expo-router";

export default function RoleStub() {
  const router = useRouter();
  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 px-6 py-12 justify-center gap-6">
        <Text className="text-3xl font-bold text-brand-ink">¿Cuál es tu rol?</Text>
        <Text className="text-base text-brand-muted">(Pantalla por implementar — solo Tech en v1.)</Text>
        <Pressable
          onPress={() => router.push("/(onboarding)/level")}
          className="bg-brand rounded-2xl py-4 items-center active:opacity-80"
        >
          <Text className="text-white text-lg font-semibold">Siguiente</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
