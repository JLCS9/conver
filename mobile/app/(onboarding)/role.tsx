// Role selection. v1 launches with the Tech vertical only — other roles
// are visible but disabled with a "Próximamente" tag so users see the
// product roadmap without being able to pick something we can't serve yet.
// The schema check constraint on public.users.role enforces this server-side.

import { useRouter } from "expo-router";
import { Pressable, SafeAreaView, Text, View } from "react-native";
import { useOnboardingStore, type Role } from "@/src/stores/onboardingStore";

const ROLES: Array<{ value: Role | "soon"; label: string; emoji: string }> = [
  { value: "tech", label: "Desarrollador / Tech", emoji: "💻" },
  { value: "soon", label: "Ventas / Comercial", emoji: "💼" },
  { value: "soon", label: "Hostelería / Atención", emoji: "🍽️" },
  { value: "soon", label: "Otra profesión", emoji: "✨" },
];

export default function RoleScreen() {
  const router = useRouter();
  const setRole = useOnboardingStore((s) => s.setRole);
  const current = useOnboardingStore((s) => s.role);

  const pick = (role: Role) => {
    setRole(role);
    router.push("/(onboarding)/level");
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 px-6 pt-12 pb-8 justify-between">
        <View className="gap-6">
          <Text className="text-3xl font-bold text-brand-ink leading-tight">
            ¿Cuál es tu rol?
          </Text>
          <Text className="text-base text-brand-muted leading-7">
            Adaptamos los prompts diarios al vocabulario y situaciones de tu
            día a día.
          </Text>

          <View className="gap-3 mt-2">
            {ROLES.map((r, idx) => {
              const disabled = r.value === "soon";
              const selected = !disabled && current === r.value;
              return (
                <Pressable
                  key={idx}
                  onPress={disabled ? undefined : () => pick(r.value as Role)}
                  disabled={disabled}
                  className={`flex-row items-center gap-4 rounded-2xl px-5 py-4 border-2 ${
                    selected
                      ? "border-brand bg-brand/5"
                      : disabled
                      ? "border-gray-200 bg-gray-50"
                      : "border-gray-200 bg-white active:bg-gray-50"
                  }`}
                >
                  <Text className="text-2xl">{r.emoji}</Text>
                  <Text
                    className={`flex-1 text-base font-medium ${
                      disabled ? "text-brand-muted" : "text-brand-ink"
                    }`}
                  >
                    {r.label}
                  </Text>
                  {disabled ? (
                    <Text className="text-xs font-semibold text-brand-muted bg-gray-100 px-2 py-1 rounded-full">
                      Próximamente
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}
