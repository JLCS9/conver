// Voice session screen.
//
// What the user sees: a clean chat thread (their messages on the right
// in brand blue, the coach's on the left in grey), a calm status pill
// above the bottom CTA telling them whose turn it is, and a single big
// button to start / stop. Auto-scrolls to the newest bubble.
//
// What the code carefully preserves (do NOT regress in a polish pass):
//
//   • `audioReady` 600 ms delay between WS-live and mounting the audio
//     components. Without it iOS's audio session activation kills the
//     WebSocket with code 1005 before setupComplete arrives. See Day 5-I.
//
//   • `coachIsSpeaking` state driven by AudioPlayback's start/end
//     callbacks. Pauses MicCapture at the source to kill the speaker→
//     mic echo loop. See Day 6-L.
//
//   • `micEpoch` counter + `key={`mic-${micEpoch}`}` on MicCapture.
//     iOS silently severs the native input after AVAudioPlayer takes
//     the audio session for TTS; the only fix that works is fully
//     recreating the AudioStream object via remount. See Day 6-Y.
//
//   • `stopWithConfirm` — cheek-tap insurance. Users hold the phone
//     against their face mid-conversation despite speakerphone, and
//     accidental Pressable hits ended sessions before. See Day 6-U.
//
// Inline StyleSheet only (NativeWind 4 + SDK 56 still has the
// text-styles-not-applying glitch we parked for a bigger UI overhaul).

import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { AudioPlayback } from "@/src/components/AudioPlayback";
import { MicCapture } from "@/src/components/MicCapture";
import { useVoiceSession } from "@/src/hooks/useVoiceSession";

export default function SessionScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    phase,
    error,
    messages,
    playbackUri,
    analyzeState,
    analyzeResult,
    dismissAnalyze,
    start,
    stop,
    sendChunk,
  } = useVoiceSession();

  const stopWithConfirm = () => {
    Alert.alert(
      "¿Terminar sesión?",
      "Vas a cerrar la conversación con el coach.",
      [
        { text: "Cancelar", style: "cancel" },
        { text: "Terminar", style: "destructive", onPress: () => stop() },
      ],
    );
  };

  // Single tap handler so we can log + guard against double-starts.
  const handleStartPress = () => {
    console.log("[session] CTA press →", { phase });
    if (phase === "live") {
      stopWithConfirm();
      return;
    }
    if (phase === "starting" || phase === "stopping") {
      console.log("[session] busy — ignoring tap");
      return;
    }
    void start();
  };

  const isLive = phase === "live";
  const isBusy = phase === "starting" || phase === "stopping";

  // 600ms guard before mounting audio hooks — see header comment.
  const [audioReady, setAudioReady] = useState(false);
  useEffect(() => {
    if (!isLive) {
      setAudioReady(false);
      return;
    }
    const t = setTimeout(() => setAudioReady(true), 600);
    return () => clearTimeout(t);
  }, [isLive]);

  // Coach-speaks gating + mic remount counter — see header comment.
  const [coachIsSpeaking, setCoachIsSpeaking] = useState(false);
  const [micEpoch, setMicEpoch] = useState(0);
  const handlePlaybackEnd = () => {
    setCoachIsSpeaking(false);
    setMicEpoch((e) => e + 1);
  };

  // Auto-scroll to the latest bubble whenever the messages array grows
  // or the last bubble's text updates (LLM streaming case).
  const scrollRef = useRef<ScrollView>(null);
  const messageSig = messages.length + ":" + (messages[messages.length - 1]?.text.length ?? 0);
  useEffect(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, [messageSig]);

  // Pulsing dot animation for "coach is speaking" indicator.
  const pulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    if (!coachIsSpeaking) {
      pulse.setValue(0.4);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.4,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [coachIsSpeaking, pulse]);

  // Make sure the bottom CTA always clears the iPhone home indicator
  // (typically ~34 px on notched devices, 0 on older phones). A small
  // floor (18 px) is enough on devices without an indicator.
  const bottomPad = Math.max(insets.bottom, Platform.OS === "ios" ? 24 : 18);

  return (
    <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <Pressable
          onPress={() => (isLive ? stopWithConfirm() : router.back())}
          hitSlop={10}
          style={styles.topBarBtn}
        >
          <Ionicons name="chevron-back" size={24} color="#0f172a" />
        </Pressable>
        <Text style={styles.topBarTitle}>Hablemos en inglés</Text>
        <View style={styles.topBarBtn} />
      </View>

      {/* Chat thread */}
      <ScrollView
        ref={scrollRef}
        style={styles.chatScroll}
        contentContainerStyle={styles.chatContent}
        showsVerticalScrollIndicator={false}
      >
        {messages.length === 0 ? (
          <EmptyState isLive={isLive} />
        ) : (
          messages.map((m) => (
            <View
              key={m.id}
              style={[
                styles.bubble,
                m.role === "user" ? styles.bubbleUser : styles.bubbleCoach,
              ]}
            >
              <Text
                style={[
                  styles.bubbleText,
                  m.role === "user" ? styles.bubbleTextUser : styles.bubbleTextCoach,
                ]}
              >
                {m.text.trim() || (m.role === "model" ? "…" : "")}
              </Text>
            </View>
          ))
        )}
      </ScrollView>

      {/* Bottom dock. paddingBottom honours the iPhone home indicator
          so the CTA never gets clipped. The status pill is rendered
          ONLY in transient states (starting / live / stopping / error)
          — in idle/ended the only visible thing is the big CTA so the
          user never confuses a non-interactive label with the button. */}
      <View style={[styles.bottomDock, { paddingBottom: bottomPad }]}>
        {error ? (
          <View style={styles.errorPill}>
            <Ionicons name="alert-circle" size={16} color="#dc2626" />
            <Text style={styles.errorText} numberOfLines={2}>{error}</Text>
          </View>
        ) : isLive || phase === "starting" || phase === "stopping" ? (
          <StatusPill
            phase={phase}
            coachIsSpeaking={coachIsSpeaking}
            pulse={pulse}
          />
        ) : null}

        <Pressable
          onPress={handleStartPress}
          disabled={isBusy}
          style={({ pressed }) => [
            styles.cta,
            isLive ? styles.ctaStop : styles.ctaStart,
            isBusy && styles.ctaDisabled,
            pressed && !isBusy && { opacity: 0.9, transform: [{ scale: 0.98 }] },
          ]}
          accessibilityRole="button"
          accessibilityLabel={
            isLive ? "Finalizar conversación" : "Empezar conversación con el coach"
          }
        >
          {isBusy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons
                name={isLive ? "stop-circle" : "mic"}
                size={26}
                color="#fff"
              />
              <Text style={styles.ctaText}>
                {isLive
                  ? "Finalizar conversación"
                  : phase === "ended"
                  ? "Empezar otra conversación"
                  : "Empezar conversación"}
              </Text>
            </>
          )}
        </Pressable>
      </View>

      {/* Post-session analysis modal — spinner while extracting vocab /
          grammar / context, then a success card with the count of
          things added and a "Ver progreso" button that lands the user
          on Profile. Non-dismissible during analyzing so the user
          doesn't navigate away mid-write. */}
      <AnalyzeModal
        state={analyzeState}
        result={analyzeResult}
        onClose={dismissAnalyze}
        onSeeProgress={() => {
          dismissAnalyze();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          router.replace("/(app)/profile" as any);
        }}
      />

      {/* Audio components mount only while live and after the WS-stable
          window — see file header. */}
      {isLive && audioReady ? (
        <>
          <MicCapture
            key={`mic-${micEpoch}`}
            onChunk={sendChunk}
            paused={coachIsSpeaking}
          />
          <AudioPlayback
            uri={playbackUri}
            onPlaybackStart={() => setCoachIsSpeaking(true)}
            onPlaybackEnd={handlePlaybackEnd}
          />
        </>
      ) : null}
    </SafeAreaView>
  );
}

// ───────────── Sub-components ─────────────

function EmptyState({ isLive }: { isLive: boolean }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIconWrap}>
        <Ionicons
          name="chatbubbles-outline"
          size={42}
          color="#94a3b8"
        />
      </View>
      <Text style={styles.emptyTitle}>
        {isLive
          ? "Saluda al coach cuando quieras"
          : "Listo para practicar"}
      </Text>
      <Text style={styles.emptyHint}>
        {isLive
          ? "El coach te escuchará y responderá. Habla en inglés con normalidad — está acostumbrado a acentos."
          : "Toca el botón azul de abajo para empezar. Tu primera frase puede tardar un par de segundos."}
      </Text>
    </View>
  );
}

function AnalyzeModal({
  state,
  result,
  onClose,
  onSeeProgress,
}: {
  state: ReturnType<typeof useVoiceSession>["analyzeState"];
  result: ReturnType<typeof useVoiceSession>["analyzeResult"];
  onClose: () => void;
  onSeeProgress: () => void;
}) {
  // Track how long analysis has been running so the spinner shows a
  // live counter (turns can take 5–15 s; a static "Analizando…" feels
  // frozen).
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (state !== "analyzing") {
      setElapsedMs(0);
      return;
    }
    const t0 = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - t0), 100);
    return () => clearInterval(id);
  }, [state]);

  const visible = state === "analyzing" || state === "done" || state === "failed";
  const dismissable = state !== "analyzing";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (dismissable) onClose();
      }}
    >
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          {state === "analyzing" ? (
            <>
              <ActivityIndicator size="large" color="#0EA5E9" />
              <Text style={styles.modalTitle}>Analizando tu conversación</Text>
              <Text style={styles.modalBody}>
                Estoy extrayendo palabras nuevas, correcciones gramaticales
                y temas para guardarlos en tu perfil…
              </Text>
              <Text style={styles.modalElapsed}>
                {(elapsedMs / 1000).toFixed(1)} s
              </Text>
            </>
          ) : state === "done" ? (
            <>
              <View style={styles.modalIconCircle}>
                <Ionicons name="checkmark" size={36} color="#fff" />
              </View>
              <Text style={styles.modalTitle}>¡Listo!</Text>
              <Text style={styles.modalBody}>
                He añadido{" "}
                <Text style={styles.modalEmph}>
                  {result?.vocabularyAdded ?? 0} palabra
                  {(result?.vocabularyAdded ?? 0) === 1 ? "" : "s"}
                </Text>{" "}
                a tu vocabulario y{" "}
                <Text style={styles.modalEmph}>
                  {result?.correctionsAdded ?? 0} corrección
                  {(result?.correctionsAdded ?? 0) === 1 ? "" : "es"}
                </Text>{" "}
                a tu lista de errores.
              </Text>
              <Pressable
                onPress={onSeeProgress}
                style={({ pressed }) => [
                  styles.modalPrimary,
                  pressed && { opacity: 0.9 },
                ]}
              >
                <Ionicons name="stats-chart" size={18} color="#fff" />
                <Text style={styles.modalPrimaryText}>Ver mi progreso</Text>
              </Pressable>
              <Pressable
                onPress={onClose}
                style={styles.modalSecondary}
                hitSlop={10}
              >
                <Text style={styles.modalSecondaryText}>Cerrar</Text>
              </Pressable>
            </>
          ) : (
            // state === "failed"
            <>
              <View style={[styles.modalIconCircle, { backgroundColor: "#dc2626" }]}>
                <Ionicons name="alert" size={36} color="#fff" />
              </View>
              <Text style={styles.modalTitle}>No pudimos analizar</Text>
              <Text style={styles.modalBody}>
                Tu conversación está guardada, pero el análisis automático
                falló. La próxima sesión lo intentaremos de nuevo.
              </Text>
              <Pressable
                onPress={onClose}
                style={({ pressed }) => [
                  styles.modalPrimary,
                  { backgroundColor: "#64748b" },
                  pressed && { opacity: 0.9 },
                ]}
              >
                <Text style={styles.modalPrimaryText}>Cerrar</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

function StatusPill({
  phase,
  coachIsSpeaking,
  pulse,
}: {
  phase: ReturnType<typeof useVoiceSession>["phase"];
  coachIsSpeaking: boolean;
  pulse: Animated.Value;
}) {
  let label = "Pulsa Empezar cuando quieras";
  let icon: React.ComponentProps<typeof Ionicons>["name"] = "ellipse-outline";
  let color = "#64748b";
  let bg = "#f1f5f9";

  if (phase === "starting") {
    label = "Conectando con el coach…";
    icon = "sync";
    color = "#0369a1";
    bg = "#e0f2fe";
  } else if (phase === "stopping") {
    label = "Cerrando…";
    icon = "sync";
    color = "#64748b";
    bg = "#f1f5f9";
  } else if (phase === "live" && coachIsSpeaking) {
    label = "El coach está hablando";
    icon = "volume-high";
    color = "#0369a1";
    bg = "#e0f2fe";
  } else if (phase === "live") {
    label = "Te escucho — habla";
    icon = "mic";
    color = "#047857";
    bg = "#dcfce7";
  } else if (phase === "ended") {
    label = "Conversación terminada";
    icon = "checkmark-circle";
    color = "#64748b";
    bg = "#f1f5f9";
  } else if (phase === "error") {
    label = "Algo no fue bien";
    icon = "alert-circle";
    color = "#b91c1c";
    bg = "#fef2f2";
  }

  return (
    <View style={[styles.statusPill, { backgroundColor: bg }]}>
      {coachIsSpeaking ? (
        <Animated.View style={{ opacity: pulse }}>
          <Ionicons name={icon} size={16} color={color} />
        </Animated.View>
      ) : (
        <Ionicons name={icon} size={16} color={color} />
      )}
      <Text style={[styles.statusText, { color }]}>{label}</Text>
    </View>
  );
}

// ───────────── Styles ─────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },

  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e2e8f0",
  },
  topBarBtn: { width: 40, height: 32, alignItems: "center", justifyContent: "center" },
  topBarTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 15,
    fontWeight: "700",
    color: "#0f172a",
  },

  chatScroll: { flex: 1, backgroundColor: "#f8fafc" },
  chatContent: { padding: 16, paddingBottom: 12, gap: 8 },

  empty: { alignItems: "center", paddingVertical: 48, paddingHorizontal: 24, gap: 10 },
  emptyIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  emptyTitle: { fontSize: 17, fontWeight: "700", color: "#0f172a", marginTop: 4 },
  emptyHint: {
    fontSize: 13,
    color: "#64748b",
    textAlign: "center",
    lineHeight: 19,
    maxWidth: 280,
  },

  bubble: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 18,
    maxWidth: "85%",
  },
  bubbleUser: {
    backgroundColor: "#0EA5E9",
    alignSelf: "flex-end",
    borderBottomRightRadius: 4,
  },
  bubbleCoach: {
    backgroundColor: "#fff",
    alignSelf: "flex-start",
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  bubbleText: { fontSize: 15, lineHeight: 21 },
  bubbleTextUser: { color: "#fff" },
  bubbleTextCoach: { color: "#0f172a" },

  bottomDock: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 18,
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e2e8f0",
    backgroundColor: "#fff",
  },
  statusPill: {
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
  statusText: { fontSize: 13, fontWeight: "600" },
  errorPill: {
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: "#fef2f2",
    borderWidth: 1,
    borderColor: "#fecaca",
  },
  errorText: { flex: 1, fontSize: 13, color: "#b91c1c" },

  cta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingVertical: 22,
    borderRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.32,
    shadowRadius: 14,
    elevation: 8,
  },
  // Bright "go" green — Tailwind emerald-500. Reads as inviting + safe.
  ctaStart: { backgroundColor: "#10B981", shadowColor: "#10B981" },
  // Strong "stop" red — Tailwind red-600. Unambiguous "this ends the call".
  ctaStop: { backgroundColor: "#dc2626", shadowColor: "#dc2626" },
  ctaDisabled: { opacity: 0.7 },
  ctaText: { color: "#fff", fontSize: 18, fontWeight: "800", letterSpacing: 0.2 },

  // ───────── Analyze modal ─────────
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 24,
    alignItems: "center",
    gap: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 12,
  },
  modalIconCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "#10B981",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  modalTitle: {
    fontSize: 19,
    fontWeight: "800",
    color: "#0f172a",
    textAlign: "center",
    marginTop: 6,
  },
  modalBody: {
    fontSize: 14,
    color: "#475569",
    textAlign: "center",
    lineHeight: 21,
    marginTop: 2,
  },
  modalEmph: { fontWeight: "700", color: "#0f172a" },
  modalElapsed: {
    fontSize: 12,
    color: "#94a3b8",
    fontVariant: ["tabular-nums"],
    marginTop: 4,
  },
  modalPrimary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#0EA5E9",
    paddingVertical: 14,
    paddingHorizontal: 22,
    borderRadius: 12,
    marginTop: 14,
    minWidth: 220,
  },
  modalPrimaryText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  modalSecondary: { paddingVertical: 8, paddingHorizontal: 12, marginTop: 4 },
  modalSecondaryText: {
    fontSize: 13,
    color: "#94a3b8",
    textDecorationLine: "underline",
  },
});
