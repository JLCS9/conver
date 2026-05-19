// Goal selection. Used to bias prompt selection (e.g. interviews → more
// "tell me about a time you solved X" style scenarios) and to phrase the
// end-of-session feedback. Single choice, immediate advance.

import { useRouter } from "expo-router";
import { Pressable, SafeAreaView, Text, View } from "react-native";
import { useOnboardingStore, type Goal } from "@/src/stores/onboardingStore";

const GOALS: Array<{ value: Goal; label: string; description: string; emoji: string }> = [
  {
    value: "job",
    label: "Conseguir un mejor empleo",
    description: "Necesito inglés sólido para optar a más oportunidades.",
    emoji: "🚀",
  },
  {
    value: "interviews",
    label: "Dominar entrevistas técnicas",
    description: "Quiero hablar con fluidez en entrevistas en inglés.",
    emoji: "🎯",
  },
  {
    value: "confidence",
    label: "Ganar confianza al hablar",
    description: "Sé inglés, pero me bloqueo cuando tengo que hablar.",
    emoji: "💬",
  },
  {
    value: "other",
    label: "Otro motivo",
    description: "Simplemente quiero practicar a diario.",
    emoji: "✨",
  },
];

export default function GoalScreen() {
  const router = useRouter();
  const setGoal = useOnboardingStore((s) => s.setGoal);
  const current = useOnboardingStore((s) => s.goal);

  const pick = (goal: Goal) => {
    setGoal(goal);
    router.push("/(onboarding)/time");
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 px-6 pt-12 pb-8">
        <View className="gap-6 flex-1">
          <View className="gap-2">
            <Text className="text-3xl font-bold text-brand-ink leading-tight">
              ¿Tu objetivo principal?
            </Text>
            <Text className="text-base text-brand-muted leading-6">
              Elige el más cercano — lo usamos para ajustar los prompts.
            </Text>
          </View>

          <View className="gap-3">
            {GOALS.map((g) => {
              const selected = current === g.value;
              return (
                <Pressable
                  key={g.value}
                  onPress={() => pick(g.value)}
                  className={`rounded-2xl px-5 py-4 border-2 flex-row items-center gap-4 ${
                    selected
                      ? "border-brand bg-brand/5"
                      : "border-gray-200 bg-white active:bg-gray-50"
                  }`}
                >
                  <Text className="text-2xl">{g.emoji}</Text>
                  <View className="flex-1 gap-1">
                    <Text className="text-base font-semibold text-brand-ink">
                      {g.label}
                    </Text>
                    <Text className="text-sm text-brand-muted leading-5">
                      {g.description}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}
