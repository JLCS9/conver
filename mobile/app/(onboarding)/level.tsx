// Level self-assessment. Four yes/somewhat/no statements; the count of
// "yes" answers maps to a level bucket. This is intentionally crude —
// the goal is "good-enough to choose a starting prompt difficulty",
// not psychometric accuracy. We refine with adaptive prompts later.
//
// Mapping:
//   0-1 yes → beginner
//   2 yes   → intermediate
//   3-4 yes → advanced

import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, SafeAreaView, ScrollView, Text, View } from "react-native";
import { useOnboardingStore, type Level } from "@/src/stores/onboardingStore";

type Answer = "yes" | "somewhat" | "no";

const QUESTIONS = [
  "Puedo mantener una conversación de trabajo en inglés sin esfuerzo.",
  "Entiendo películas o podcasts en inglés sin subtítulos.",
  "Puedo escribir un email profesional sin revisar gramática.",
  "Cometo pocos errores graves cuando hablo en inglés.",
] as const;

const ANSWERS: Array<{ value: Answer; label: string }> = [
  { value: "yes", label: "Sí" },
  { value: "somewhat", label: "Más o menos" },
  { value: "no", label: "No" },
];

function deriveLevel(answers: Array<Answer | null>): Level | null {
  if (answers.some((a) => a === null)) return null;
  const yesCount = answers.filter((a) => a === "yes").length;
  if (yesCount <= 1) return "beginner";
  if (yesCount === 2) return "intermediate";
  return "advanced";
}

const LEVEL_LABEL: Record<Level, string> = {
  beginner: "Principiante",
  intermediate: "Intermedio",
  advanced: "Avanzado",
};

export default function LevelScreen() {
  const router = useRouter();
  const setLevel = useOnboardingStore((s) => s.setLevel);
  const [answers, setAnswers] = useState<Array<Answer | null>>(() =>
    QUESTIONS.map(() => null),
  );

  const level = useMemo(() => deriveLevel(answers), [answers]);

  const setAnswer = (idx: number, value: Answer) => {
    setAnswers((prev) => prev.map((a, i) => (i === idx ? value : a)));
  };

  const advance = () => {
    if (!level) return;
    setLevel(level);
    router.push("/(onboarding)/goal");
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 24 }}
      >
        <View className="gap-6">
          <View className="gap-2">
            <Text className="text-3xl font-bold text-brand-ink leading-tight">
              Tu nivel de inglés
            </Text>
            <Text className="text-base text-brand-muted leading-6">
              4 preguntas rápidas — esto sólo orienta los primeros prompts.
            </Text>
          </View>

          {QUESTIONS.map((q, idx) => (
            <View key={idx} className="gap-3">
              <Text className="text-base text-brand-ink font-medium leading-6">
                {idx + 1}. {q}
              </Text>
              <View className="flex-row gap-2">
                {ANSWERS.map((a) => {
                  const selected = answers[idx] === a.value;
                  return (
                    <Pressable
                      key={a.value}
                      onPress={() => setAnswer(idx, a.value)}
                      className={`flex-1 rounded-xl py-3 border-2 items-center ${
                        selected
                          ? "border-brand bg-brand/5"
                          : "border-gray-200 bg-white active:bg-gray-50"
                      }`}
                    >
                      <Text
                        className={`text-sm font-medium ${
                          selected ? "text-brand" : "text-brand-ink"
                        }`}
                      >
                        {a.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}

          {level ? (
            <View className="rounded-2xl bg-brand/5 border border-brand/20 px-5 py-4 mt-2">
              <Text className="text-sm text-brand-muted">Te clasificamos como</Text>
              <Text className="text-xl font-semibold text-brand-ink">
                {LEVEL_LABEL[level]}
              </Text>
            </View>
          ) : null}

          <Pressable
            onPress={advance}
            disabled={!level}
            className={`rounded-2xl py-4 items-center mt-2 ${
              level ? "bg-brand active:opacity-80" : "bg-gray-300"
            }`}
          >
            <Text className="text-white text-lg font-semibold">Continuar</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
