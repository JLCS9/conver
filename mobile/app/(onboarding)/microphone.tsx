// Placeholder — filled in Task #10. Real version: pre-prompt + iOS mic
// permission dialog + final POST to /api/onboarding before replacing the
// route stack with /(app).

import { Pressable, SafeAreaView, Text, View } from "react-native";
import { useRouter } from "expo-router";

export default function MicrophoneStub() {
  const router = useRouter();
  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 px-6 py-12 justify-center gap-6">
        <Text className="text-3xl font-bold text-brand-ink">Permiso de micrófono</Text>
        <Text className="text-base text-brand-muted">(Pantalla por implementar — pre-prompt + permiso + POST final.)</Text>
        <Pressable
          onPress={() => router.replace("/(app)")}
          className="bg-brand rounded-2xl py-4 items-center active:opacity-80"
        >
          <Text className="text-white text-lg font-semibold">Terminar onboarding</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
