// Daily session time picker. The single most important onboarding answer
// after push permission, because the daily reminder fires at this exact
// time. Default to 08:00 — a defensible morning slot that matches the
// "first thing in the morning" habit pattern.
//
// Date is captured as a local Date and serialized to "HH:MM" on advance.
// The timezone string (IANA) is also stashed so the backend can compute
// the next-fire timestamp without ambiguity around DST/travel.

import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Platform, Pressable, SafeAreaView, Text, View } from "react-native";
import { useOnboardingStore } from "@/src/stores/onboardingStore";

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatHHMM(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultTime(): Date {
  const d = new Date();
  d.setHours(8, 0, 0, 0);
  return d;
}

function resolveTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "Europe/Madrid";
  } catch {
    return "Europe/Madrid";
  }
}

export default function TimeScreen() {
  const router = useRouter();
  const setDailySessionTime = useOnboardingStore((s) => s.setDailySessionTime);
  const setTimezone = useOnboardingStore((s) => s.setTimezone);
  const [date, setDate] = useState<Date>(defaultTime);

  const onChange = (event: DateTimePickerEvent, selected?: Date) => {
    if (selected) setDate(selected);
  };

  const advance = () => {
    setDailySessionTime(formatHHMM(date));
    setTimezone(resolveTimezone());
    router.push("/(onboarding)/microphone");
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 px-6 pt-12 pb-8 justify-between">
        <View className="gap-6">
          <View className="gap-2">
            <Text className="text-3xl font-bold text-brand-ink leading-tight">
              ¿A qué hora practicas?
            </Text>
            <Text className="text-base text-brand-muted leading-6">
              Te enviaremos un recordatorio a esta hora cada día. Puedes
              cambiarla luego desde Ajustes.
            </Text>
          </View>

          <View className="items-center mt-2">
            <DateTimePicker
              value={date}
              mode="time"
              display={Platform.OS === "ios" ? "spinner" : "default"}
              onChange={onChange}
              minuteInterval={5}
            />
          </View>

          <View className="rounded-2xl bg-brand/5 border border-brand/20 px-5 py-4 mt-2">
            <Text className="text-sm text-brand-muted">Hora elegida</Text>
            <Text className="text-2xl font-semibold text-brand-ink">
              {formatHHMM(date)}
            </Text>
          </View>
        </View>

        <Pressable
          onPress={advance}
          className="bg-brand rounded-2xl py-4 items-center active:opacity-80"
        >
          <Text className="text-white text-lg font-semibold">Continuar</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
