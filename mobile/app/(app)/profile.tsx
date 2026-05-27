// Mi perfil — what the coach has learned about you across sessions.
//
// Three sections, all driven by /api/me/insights (one round trip) plus
// drill-downs to /api/me/vocabulary and /api/me/grammar-corrections.
// Pull-to-refresh re-queries everything.

import { useAuth } from "@clerk/clerk-expo";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { api } from "@/src/lib/api";

interface UserContext {
  profession?: string;
  interests?: string[];
  speaking_level?: "beginner" | "intermediate" | "advanced";
  last_topics?: string[];
  focus_areas?: string[];
}

interface InsightsResponse {
  user_context: UserContext;
  vocabulary: {
    total: number;
    by_level: { basic: number; intermediate: number; advanced: number };
  };
  grammar: {
    total_corrections: number;
    top_error_types: { error_type: string; count: number }[];
    recent: {
      original_text: string;
      corrected_text: string;
      error_type: string;
      created_at: string;
    }[];
  };
  sessions: { completed: number; total_minutes: number };
}

interface VocabularyResponse {
  vocabulary: {
    word: string;
    count: number;
    level: string | null;
    example_sentence: string | null;
    last_used_at: string;
  }[];
}

interface CorrectionsResponse {
  corrections: {
    id: string;
    original_text: string;
    corrected_text: string;
    error_type: string;
    explanation: string | null;
    created_at: string;
  }[];
}

type Tab = "summary" | "vocabulary" | "errors";

export default function ProfileScreen() {
  const router = useRouter();
  const { getToken } = useAuth();
  const [tab, setTab] = useState<Tab>("summary");

  const [insights, setInsights] = useState<InsightsResponse | null>(null);
  const [vocab, setVocab] = useState<VocabularyResponse["vocabulary"] | null>(null);
  const [corrections, setCorrections] = useState<CorrectionsResponse["corrections"] | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // getToken in a ref so `load` stays stable. Clerk recreates getToken
  // on every render — if `load` depended on it directly, the useEffect
  // below would refire on every render and hammer the backend (we hit
  // exactly this bug in Day-9-G on the Home screen).
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  // Three endpoints fired in parallel — total time is the slowest of the
  // three, not the sum. The insights endpoint already batches its own
  // four sub-queries server-side.
  const load = useCallback(async () => {
    const gt = getTokenRef.current;
    setError(null);
    try {
      const [insightsRes, vocabRes, corrRes] = await Promise.all([
        api<InsightsResponse>("/api/me/insights", { getToken: gt }),
        api<VocabularyResponse>("/api/me/vocabulary?sort=count&limit=200", { getToken: gt }),
        api<CorrectionsResponse>("/api/me/grammar-corrections?limit=100", { getToken: gt }),
      ]);
      setInsights(insightsRes);
      setVocab(vocabRes.vocabulary);
      setCorrections(corrRes.corrections);
    } catch (e: unknown) {
      setError((e as { message?: string }).message ?? "Error cargando el perfil");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []); // stable — uses getTokenRef.current

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  if (loading) {
    return (
      <SafeAreaView style={s.center}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <View style={s.headerRow}>
        <Pressable onPress={() => router.back()}>
          <Text style={s.backText}>‹ Volver</Text>
        </Pressable>
        <Text style={s.title}>Mi perfil</Text>
        <View style={{ width: 60 }} />
      </View>

      <View style={s.tabs}>
        <TabButton label="Resumen" active={tab === "summary"} onPress={() => setTab("summary")} />
        <TabButton
          label={`Vocabulario${insights ? ` (${insights.vocabulary.total})` : ""}`}
          active={tab === "vocabulary"}
          onPress={() => setTab("vocabulary")}
        />
        <TabButton
          label={`Errores${insights ? ` (${insights.grammar.total_corrections})` : ""}`}
          active={tab === "errors"}
          onPress={() => setTab("errors")}
        />
      </View>

      <ScrollView
        contentContainerStyle={s.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {error ? <Text style={s.errorText}>{error}</Text> : null}

        {tab === "summary" && insights ? (
          <SummaryTab insights={insights} />
        ) : null}

        {tab === "vocabulary" && vocab ? (
          <VocabularyTab vocab={vocab} />
        ) : null}

        {tab === "errors" && corrections ? (
          <ErrorsTab corrections={corrections} />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[s.tab, active && s.tabActive]}
    >
      <Text style={[s.tabText, active && s.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

function SummaryTab({ insights }: { insights: InsightsResponse }) {
  const ctx = insights.user_context;
  return (
    <View style={{ gap: 14 }}>
      <Card title="Lo que sé de ti">
        {ctx.profession ? <KV k="Profesión" v={ctx.profession} /> : null}
        {ctx.speaking_level ? <KV k="Nivel" v={ctx.speaking_level} /> : null}
        {ctx.interests && ctx.interests.length > 0 ? (
          <KV k="Intereses" v={ctx.interests.join(", ")} />
        ) : null}
        {ctx.last_topics && ctx.last_topics.length > 0 ? (
          <KV k="Temas recientes" v={ctx.last_topics.join(", ")} />
        ) : null}
        {!ctx.profession && !ctx.interests?.length ? (
          <Text style={s.emptyHint}>
            Sigo aprendiendo sobre ti. Tras unas conversaciones, aquí verás
            tu profesión, intereses y temas favoritos.
          </Text>
        ) : null}
      </Card>

      <Card title="Tu progreso">
        <KV k="Sesiones completadas" v={String(insights.sessions.completed)} />
        <KV k="Minutos practicados" v={String(insights.sessions.total_minutes)} />
        <KV
          k="Palabras en tu vocabulario"
          v={String(insights.vocabulary.total)}
        />
        <KV
          k="Correcciones recibidas"
          v={String(insights.grammar.total_corrections)}
        />
      </Card>

      {insights.grammar.top_error_types.length > 0 ? (
        <Card title="Patrones de error más frecuentes">
          {insights.grammar.top_error_types.map((e) => (
            <View key={e.error_type} style={s.errorTypeRow}>
              <Text style={s.errorTypeName}>{prettyErrorType(e.error_type)}</Text>
              <Text style={s.errorTypeCount}>{e.count} veces</Text>
            </View>
          ))}
        </Card>
      ) : null}

      <Card title="Vocabulario por nivel">
        <KV k="Básico" v={String(insights.vocabulary.by_level.basic)} />
        <KV k="Intermedio" v={String(insights.vocabulary.by_level.intermediate)} />
        <KV k="Avanzado" v={String(insights.vocabulary.by_level.advanced)} />
      </Card>
    </View>
  );
}

function VocabularyTab({
  vocab,
}: {
  vocab: VocabularyResponse["vocabulary"];
}) {
  if (vocab.length === 0) {
    return (
      <Text style={s.emptyHint}>
        Aún no tienes palabras registradas. Haz una sesión de voz y
        aparecerán aquí.
      </Text>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      {vocab.map((v) => (
        <View key={v.word} style={s.vocabRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.vocabWord}>{v.word}</Text>
            {v.example_sentence ? (
              <Text style={s.vocabExample} numberOfLines={2}>
                "{v.example_sentence}"
              </Text>
            ) : null}
          </View>
          <View style={s.vocabMeta}>
            {v.level ? (
              <View style={[s.levelPill, levelPillStyle(v.level)]}>
                <Text style={s.levelPillText}>{v.level.slice(0, 3)}</Text>
              </View>
            ) : null}
            <Text style={s.vocabCount}>×{v.count}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function ErrorsTab({
  corrections,
}: {
  corrections: CorrectionsResponse["corrections"];
}) {
  if (corrections.length === 0) {
    return (
      <Text style={s.emptyHint}>
        Aún no tienes correcciones registradas. Cuando el coach detecte
        un error gramatical en una sesión, aparecerá aquí.
      </Text>
    );
  }
  return (
    <View style={{ gap: 10 }}>
      {corrections.map((c) => (
        <View key={c.id} style={s.correctionCard}>
          <View style={s.correctionHeader}>
            <Text style={s.correctionType}>{prettyErrorType(c.error_type)}</Text>
            <Text style={s.correctionDate}>
              {new Date(c.created_at).toLocaleDateString("es-ES")}
            </Text>
          </View>
          <View style={s.correctionRow}>
            <Text style={s.correctionLabel}>Dijiste</Text>
            <Text style={s.correctionOriginal}>"{c.original_text}"</Text>
          </View>
          <View style={s.correctionRow}>
            <Text style={s.correctionLabel}>Mejor</Text>
            <Text style={s.correctionFixed}>"{c.corrected_text}"</Text>
          </View>
          {c.explanation ? (
            <Text style={s.correctionExplanation}>{c.explanation}</Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>{title}</Text>
      <View style={{ gap: 6 }}>{children}</View>
    </View>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <View style={s.kvRow}>
      <Text style={s.kvKey}>{k}</Text>
      <Text style={s.kvVal}>{v}</Text>
    </View>
  );
}

function prettyErrorType(t: string): string {
  // The analyser uses snake_case labels; humanise for the UI.
  return (
    {
      verb_tense: "Tiempo verbal",
      preposition: "Preposición",
      subject_verb_agreement: "Concordancia",
      article: "Artículo",
      pluralization: "Plural",
      word_order: "Orden de palabras",
      phrasal_verb: "Phrasal verb",
      other: "Otro",
    }[t] ?? t
  );
}

function levelPillStyle(level: string) {
  switch (level) {
    case "basic":
      return { backgroundColor: "#e0f2fe", borderColor: "#0ea5e9" };
    case "intermediate":
      return { backgroundColor: "#fef3c7", borderColor: "#f59e0b" };
    case "advanced":
      return { backgroundColor: "#dcfce7", borderColor: "#10b981" };
    default:
      return { backgroundColor: "#f1f5f9", borderColor: "#94a3b8" };
  }
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f8fafc" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  backText: { fontSize: 16, color: "#0ea5e9", width: 60 },
  title: { fontSize: 17, fontWeight: "700", color: "#0f172a" },

  tabs: {
    flexDirection: "row",
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 8,
  },
  tab: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 18,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  tabActive: { backgroundColor: "#0ea5e9", borderColor: "#0ea5e9" },
  tabText: { fontSize: 13, color: "#475569", fontWeight: "500" },
  tabTextActive: { color: "#fff" },

  content: { padding: 16, paddingBottom: 32 },
  errorText: { color: "#dc2626", marginBottom: 12 },

  card: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "#475569",
    marginBottom: 10,
  },

  kvRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  kvKey: { fontSize: 13, color: "#64748b", flex: 1 },
  kvVal: { fontSize: 14, color: "#0f172a", fontWeight: "500", flex: 1, textAlign: "right" },

  errorTypeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  errorTypeName: { fontSize: 14, color: "#0f172a" },
  errorTypeCount: { fontSize: 13, color: "#64748b" },

  vocabRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  vocabWord: { fontSize: 16, fontWeight: "600", color: "#0f172a" },
  vocabExample: { fontSize: 12, color: "#64748b", fontStyle: "italic", marginTop: 2 },
  vocabMeta: { flexDirection: "row", alignItems: "center", gap: 8 },
  vocabCount: { fontSize: 13, color: "#64748b", fontWeight: "600" },
  levelPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    borderWidth: 1,
  },
  levelPillText: { fontSize: 10, fontWeight: "700", color: "#0f172a", textTransform: "uppercase" },

  correctionCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    gap: 6,
  },
  correctionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  correctionType: {
    fontSize: 11,
    fontWeight: "700",
    color: "#475569",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  correctionDate: { fontSize: 12, color: "#94a3b8" },
  correctionRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  correctionLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "#94a3b8",
    width: 56,
    paddingTop: 2,
    textTransform: "uppercase",
  },
  correctionOriginal: { fontSize: 14, color: "#dc2626", flex: 1, fontStyle: "italic" },
  correctionFixed: { fontSize: 14, color: "#059669", flex: 1, fontWeight: "500" },
  correctionExplanation: {
    fontSize: 12,
    color: "#64748b",
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: "#f1f5f9",
  },

  emptyHint: {
    fontSize: 13,
    color: "#94a3b8",
    fontStyle: "italic",
    textAlign: "center",
    paddingVertical: 24,
    paddingHorizontal: 16,
  },
});
