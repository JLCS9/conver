// Home — the daily dashboard.
//
// Layout philosophy: progress data anchors the top half of the screen
// so the user opens the app and immediately sees what they did this
// week. Below that, a compact "My Progress" entry (right under the
// charts it represents). Below that, the visual centre of the screen
// is a deliberately oversized round "talk now" button — the primary
// action this app exists for. Logout is a tiny grey link at the very
// bottom.
//
// Data: parallel fetch of /api/me + /api/me/activity via
// Promise.allSettled. One endpoint failing must NOT blank the screen.
// useFocusEffect refetches on screen focus so returning from a session
// updates the streak/chart without manual reload.

import { useAuth, useUser } from "@clerk/clerk-expo";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { api } from "@/src/lib/api";

type MeResponse = {
  user: { id: string; email: string };
};

// Primary stats source — same endpoint Profile uses, so the numbers on
// Home are guaranteed to match the numbers on /(app)/profile. Already
// deployed since Day 8.
type InsightsResponse = {
  vocabulary: { total: number };
  sessions: { completed: number; total_minutes: number };
  grammar: { total_corrections: number };
};

// Optional enrichment for the streak + 7-day chart. Deployed Day 9.
// If the VPS doesn't have it yet, the rest of the screen still works.
type ActivityResponse = {
  streak_days: number;
  days: { date: string; minutes: number; sessions: number }[];
};

export default function Home() {
  const { signOut, getToken } = useAuth();
  const { user } = useUser();
  const router = useRouter();

  const [me, setMe] = useState<MeResponse | null>(null);
  const [insights, setInsights] = useState<InsightsResponse | null>(null);
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [meErr, setMeErr] = useState<string | null>(null);
  const [insErr, setInsErr] = useState<string | null>(null);

  // CRITICAL: hold getToken in a ref so `load` can stay stable. Clerk
  // recreates getToken on every render — if `load` depended on it,
  // useFocusEffect would re-bind on every render, re-fire its callback,
  // and we'd hammer /api/me + /api/me/activity in a tight infinite
  // loop. (Discovered live in Day-9 polish — the loop blew up Supabase
  // and the backend started 500'ing under the request storm.)
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  const load = useCallback(async () => {
    const gt = getTokenRef.current;
    setMeErr(null);
    setInsErr(null);

    // Three endpoints in parallel:
    //   /api/me        → display name + onboarding sanity
    //   /api/me/insights → PRIMARY stats (sessions, words, corrections)
    //                       — same data Profile shows, guaranteed in sync
    //   /api/me/activity → OPTIONAL enrichment for streak + per-day chart.
    //                       404 is fine — UI degrades gracefully.
    const [meRes, insRes, actRes] = await Promise.allSettled([
      api<MeResponse>("/api/me", { getToken: gt }),
      api<InsightsResponse>("/api/me/insights", { getToken: gt }),
      api<ActivityResponse>("/api/me/activity", { getToken: gt }),
    ]);

    if (meRes.status === "fulfilled") setMe(meRes.value);
    else {
      console.warn("[home] /api/me failed", meRes.reason);
      setMeErr(extractMessage(meRes.reason));
    }

    if (insRes.status === "fulfilled") setInsights(insRes.value);
    else {
      console.warn("[home] /api/me/insights failed", insRes.reason);
      setInsErr(extractMessage(insRes.reason));
    }

    // activity is best-effort — 404 just means the endpoint isn't
    // deployed yet. Don't surface as an error to the user.
    if (actRes.status === "fulfilled") setActivity(actRes.value);
    else {
      console.log("[home] /api/me/activity unavailable (chart + streak will be empty):", extractMessage(actRes.reason));
      setActivity(null);
    }

    setLoading(false);
    setRefreshing(false);
  }, []); // stable — see ref comment above

  // Guard against double-fires from useFocusEffect re-binding. Coalesce
  // any focus events that arrive while a fetch is in flight; refire
  // once when the previous one finishes (so coming back from session
  // still updates the dashboard with the newest data).
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  const safeLoad = useCallback(async () => {
    if (inFlightRef.current) {
      queuedRef.current = true;
      return;
    }
    inFlightRef.current = true;
    try {
      await load();
    } finally {
      inFlightRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        void safeLoad();
      }
    }
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      void safeLoad();
    }, [safeLoad]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void safeLoad();
  }, [safeLoad]);

  // Memoise display name so the rest of the render is cheap.
  const displayName = useMemo(
    () =>
      user?.firstName ||
      me?.user.email?.split("@")[0] ||
      user?.emailAddresses?.[0]?.emailAddress?.split("@")[0] ||
      "amig@",
    [user?.firstName, user?.emailAddresses, me?.user.email],
  );

  // Subtle breathing animation on the CTA so it visibly invites a tap.
  const breathe = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, {
          toValue: 1.05,
          duration: 1400,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(breathe, {
          toValue: 1,
          duration: 1400,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breathe]);

  if (loading) {
    return (
      <SafeAreaView style={s.center}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <ScrollView
        contentContainerStyle={s.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
      >
        {/* Greeting */}
        <View>
          <Text style={s.greeting}>Hola, {displayName}</Text>
          <Text style={s.date}>{capitalize(formatTodayEs())}</Text>
        </View>

        {/* Stats card: streak + chart fused. Streak + per-day bars come
            from /api/me/activity (optional enrichment); falls back to
            empty state when not yet deployed. */}
        <DashboardCard
          streak={activity?.streak_days ?? 0}
          days={activity?.days ?? []}
          totalSessions={insights?.sessions.completed ?? 0}
          activityAvailable={!!activity}
        />

        {/* 3 small stat tiles — derived from /api/me/insights (same data
            as Profile, guaranteed to match). */}
        <View style={s.statsRow}>
          <StatTile
            icon="time-outline"
            value={avgSessionLabel(insights)}
            label="Sesión media"
          />
          <StatTile
            icon="book-outline"
            value={String(insights?.vocabulary.total ?? 0)}
            label="Palabras"
          />
          <StatTile
            icon="checkmark-done-outline"
            value={String(insights?.sessions.completed ?? 0)}
            label="Sesiones"
          />
        </View>

        {/* My progress — placed RIGHT BELOW the data it summarises. */}
        <Pressable
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onPress={() => router.push("/(app)/profile" as any)}
          style={({ pressed }) => [s.secondary, pressed && s.secondaryPressed]}
        >
          <View style={s.secondaryLeft}>
            <View style={s.secondaryIconWrap}>
              <Ionicons name="stats-chart" size={18} color="#0EA5E9" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.secondaryText}>My Progress</Text>
              <Text style={s.secondarySub}>Vocabulario · errores · lo que sé de ti</Text>
            </View>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#94a3b8" />
        </Pressable>

        {/* Big talk CTA — the main action of the whole app. */}
        <View style={s.ctaSection}>
          <View style={s.ctaHalo}>
            <Animated.View style={{ transform: [{ scale: breathe }] }}>
              <Pressable
                onPress={() => {
                  console.log("[home] CTA tapped → /(app)/session");
                  router.push("/(app)/session");
                }}
                style={({ pressed }) => [
                  s.ctaRound,
                  pressed && s.ctaRoundPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Empezar conversación con el coach"
              >
                <Ionicons name="mic" size={72} color="#fff" />
              </Pressable>
            </Animated.View>
          </View>
          <Text style={s.ctaLabel}>Hablar ahora</Text>
          <Text style={s.ctaHint}>Toca para empezar tu sesión de voz</Text>
        </View>

        {/* Non-blocking diagnostic if backend is down. /api/me/activity
            failing is expected when the endpoint isn't deployed yet —
            we don't surface that to the user. */}
        {insErr ? (
          <Text style={s.warn} numberOfLines={2}>
            No pudimos cargar tus estadísticas: {insErr}
          </Text>
        ) : null}
        {meErr ? (
          <Text style={s.warn} numberOfLines={2}>
            No pudimos cargar tu perfil: {meErr}
          </Text>
        ) : null}

        {/* Discreet logout */}
        <Pressable
          onPress={() => signOut()}
          style={s.logoutWrap}
          hitSlop={10}
        >
          <Text style={s.logoutText}>Cerrar sesión</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

// ───────────── Sub-components ─────────────

function DashboardCard({
  streak,
  days,
  totalSessions,
  activityAvailable,
}: {
  streak: number;
  days: ActivityResponse["days"];
  totalSessions: number;
  activityAvailable: boolean;
}) {
  const safeDays =
    days.length === 7
      ? days
      : Array.from({ length: 7 }).map(() => ({
          date: "",
          minutes: 0,
          sessions: 0,
        }));

  const totalMin = safeDays.reduce((a, d) => a + d.minutes, 0);
  const maxMinutes = Math.max(1, ...safeDays.map((d) => d.minutes));
  const BAR_AREA_HEIGHT = 60;

  return (
    <View style={s.dashCard}>
      <View style={s.dashTop}>
        <View style={s.streakBlock}>
          <Ionicons
            name={streak > 0 ? "flame" : "flame-outline"}
            size={22}
            color={streak > 0 ? "#F97316" : "#94a3b8"}
          />
          <Text style={s.streakNum}>
            {activityAvailable ? streak : "—"}
          </Text>
          <Text style={s.streakUnit}>
            {activityAvailable
              ? streak === 1
                ? "día seguido"
                : "días seguidos"
              : "racha"}
          </Text>
        </View>
        <View style={s.dashTotalBlock}>
          <Text style={s.dashTotalVal}>
            {activityAvailable ? totalMin : "—"}
          </Text>
          <Text style={s.dashTotalLabel}>min · 7 días</Text>
        </View>
      </View>

      <View style={[s.barsRow, { height: BAR_AREA_HEIGHT }]}>
        {safeDays.map((d, i) => {
          const ratio = d.minutes / maxMinutes;
          const h = d.minutes > 0 ? Math.max(6, ratio * BAR_AREA_HEIGHT) : 4;
          const active = d.minutes > 0;
          const isToday = i === safeDays.length - 1;
          return (
            <View key={d.date || `idx-${i}`} style={s.barCol}>
              <View style={s.barTrack}>
                <View
                  style={[
                    s.bar,
                    { height: h },
                    active ? s.barActive : s.barEmpty,
                    isToday && active && s.barToday,
                  ]}
                />
              </View>
            </View>
          );
        })}
      </View>
      <View style={s.labelsRow}>
        {safeDays.map((d, i) => {
          const label = d.date ? shortWeekday(d.date) : "—";
          const isToday = i === safeDays.length - 1;
          return (
            <Text key={`lbl-${i}`} style={[s.barLabel, isToday && s.barLabelToday]}>
              {label}
            </Text>
          );
        })}
      </View>

      {!activityAvailable && totalSessions > 0 ? (
        <Text style={s.dashHint}>
          La gráfica diaria aparecerá cuando se despliegue el endpoint
          de actividad. Tus totales siguen siendo correctos.
        </Text>
      ) : !activityAvailable && totalSessions === 0 ? (
        <Text style={s.dashHint}>
          Aún no tienes sesiones. Toca el botón azul de abajo para
          empezar tu primera conversación.
        </Text>
      ) : null}
    </View>
  );
}

function StatTile({
  icon,
  value,
  label,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  value: string;
  label: string;
}) {
  return (
    <View style={s.statTile}>
      <Ionicons name={icon} size={16} color="#64748b" />
      <Text style={s.statValue}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

// ───────────── helpers ─────────────

function formatTodayEs(): string {
  return new Date().toLocaleDateString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function shortWeekday(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const full = dt.toLocaleDateString("es-ES", {
    weekday: "long",
    timeZone: "UTC",
  });
  const map: Record<string, string> = {
    lunes: "L",
    martes: "M",
    miércoles: "X",
    jueves: "J",
    viernes: "V",
    sábado: "S",
    domingo: "D",
  };
  return map[full.toLowerCase()] ?? full[0].toUpperCase();
}

function capitalize(t: string): string {
  return t.length ? t[0].toUpperCase() + t.slice(1) : t;
}

// "Sesión media" tile. Computes total_minutes / completed so the value
// matches what the user sees in Profile's progress card.
function avgSessionLabel(insights: InsightsResponse | null): string {
  if (!insights) return "—";
  const { completed, total_minutes } = insights.sessions;
  if (completed === 0) return "—";
  const avg = total_minutes / completed;
  // Show one decimal only when needed (8.5' vs 9').
  const rounded = Math.round(avg * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}'` : `${rounded.toFixed(1)}'`;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "error desconocido";
}

// ───────────── Styles ─────────────

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f8fafc" },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#f8fafc",
  },
  content: { padding: 18, paddingBottom: 32, gap: 14 },

  greeting: { fontSize: 24, fontWeight: "700", color: "#0f172a" },
  date: { fontSize: 12, color: "#64748b", marginTop: 2 },

  // Dashboard card
  dashCard: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  dashTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  streakBlock: { flexDirection: "row", alignItems: "center", gap: 6 },
  streakNum: { fontSize: 24, fontWeight: "800", color: "#0f172a", lineHeight: 26 },
  streakUnit: { fontSize: 12, color: "#64748b", fontWeight: "500" },
  dashTotalBlock: { alignItems: "flex-end" },
  dashTotalVal: { fontSize: 18, fontWeight: "700", color: "#0f172a", lineHeight: 20 },
  dashTotalLabel: { fontSize: 11, color: "#94a3b8" },
  barsRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 4,
  },
  barCol: { flex: 1, alignItems: "center", justifyContent: "flex-end", height: "100%" },
  barTrack: { width: "100%", alignItems: "center", justifyContent: "flex-end", flex: 1 },
  bar: { width: "75%", borderRadius: 4 },
  barEmpty: { backgroundColor: "#e2e8f0" },
  barActive: { backgroundColor: "#7DD3FC" },
  barToday: { backgroundColor: "#0EA5E9" },
  labelsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 6,
    gap: 4,
  },
  barLabel: {
    flex: 1,
    textAlign: "center",
    fontSize: 10,
    color: "#94a3b8",
    fontWeight: "500",
  },
  barLabelToday: { color: "#0EA5E9", fontWeight: "700" },
  dashHint: {
    fontSize: 11,
    color: "#94a3b8",
    fontStyle: "italic",
    textAlign: "center",
    marginTop: 8,
  },

  // 3 stat tiles
  statsRow: { flexDirection: "row", gap: 8 },
  statTile: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    alignItems: "flex-start",
    gap: 2,
  },
  statValue: { fontSize: 18, fontWeight: "800", color: "#0f172a", lineHeight: 22 },
  statLabel: { fontSize: 10, color: "#64748b", fontWeight: "500" },

  // My Progress (secondary)
  secondary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#fff",
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  secondaryPressed: { backgroundColor: "#f0f9ff" },
  secondaryLeft: { flexDirection: "row", alignItems: "center", gap: 12, flex: 1 },
  secondaryIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#e0f2fe",
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryText: { fontSize: 15, fontWeight: "600", color: "#0f172a" },
  secondarySub: { fontSize: 11, color: "#64748b", marginTop: 2 },

  // BIG round CTA — the visual anchor of the screen
  ctaSection: { alignItems: "center", gap: 6, marginTop: 18, marginBottom: 6 },
  ctaHalo: {
    width: 220,
    height: 220,
    borderRadius: 110,
    alignItems: "center",
    justifyContent: "center",
    // Soft outer ring effect using a subtle background tint
    backgroundColor: "rgba(14, 165, 233, 0.08)",
  },
  ctaRound: {
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: "#0EA5E9",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#0EA5E9",
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.45,
    shadowRadius: 24,
    elevation: 14,
  },
  ctaRoundPressed: { transform: [{ scale: 0.94 }], opacity: 0.92 },
  ctaLabel: { fontSize: 22, fontWeight: "800", color: "#0f172a", marginTop: 14 },
  ctaHint: { fontSize: 13, color: "#64748b" },

  // Warning banner
  warn: {
    fontSize: 11,
    color: "#9a3412",
    backgroundColor: "#fff7ed",
    borderColor: "#fed7aa",
    borderWidth: 1,
    padding: 8,
    borderRadius: 8,
  },

  // Logout
  logoutWrap: { alignItems: "center", marginTop: 10, paddingVertical: 6 },
  logoutText: { fontSize: 12, color: "#94a3b8", textDecorationLine: "underline" },
});
