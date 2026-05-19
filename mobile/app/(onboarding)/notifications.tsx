// Placeholder — wired up in Task #8 with real permission flow + push
// token registration. The CTA forward path is correct so we can navigate
// the full skeleton today.

import { Pressable, SafeAreaView, Text, View } from "react-native";
import { useRouter } from "expo-router";

export default function NotificationsStub() {
  const router = useRouter();
  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 px-6 py-12 justify-center gap-6">
        <Text className="text-3xl font-bold text-brand-ink">
          Notificaciones
        </Text>
        <Text className="text-base text-brand-muted">
          (Pantalla por implementar — permiso de push y registro de token.)
        </Text>
        <Pressable
          onPress={() => router.push("/(onboarding)/role")}
          className="bg-brand rounded-2xl py-4 items-center active:opacity-80"
        >
          <Text className="text-white text-lg font-semibold">Siguiente</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
