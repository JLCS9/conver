// Placeholder — filled in Task #10. Real version uses
// @react-native-community/datetimepicker (native iOS UIDatePicker).

import { Pressable, SafeAreaView, Text, View } from "react-native";
import { useRouter } from "expo-router";

export default function TimeStub() {
  const router = useRouter();
  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 px-6 py-12 justify-center gap-6">
        <Text className="text-3xl font-bold text-brand-ink">
          ¿A qué hora practicas?
        </Text>
        <Text className="text-base text-brand-muted">(Pantalla por implementar — DateTimePicker nativo.)</Text>
        <Pressable
          onPress={() => router.push("/(onboarding)/microphone")}
          className="bg-brand rounded-2xl py-4 items-center active:opacity-80"
        >
          <Text className="text-white text-lg font-semibold">Siguiente</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
