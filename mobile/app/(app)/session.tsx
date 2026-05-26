// Voice session screen — Day-3 working state.
//
// Inline StyleSheet only (no NativeWind) because NativeWind 4.2 + SDK 56
// has a text-styles-not-applying bug we're parking for a polish pass.
// The session UI here is intentionally bare: status pill + metrics +
// big toggle button. Enough surface to validate the WS round-trip end-
// to-end. The orb / live transcript / proper styling lands in Week 4.

import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { AudioPlayback } from "@/src/components/AudioPlayback";
import { MicCapture } from "@/src/components/MicCapture";
import { useVoiceSession } from "@/src/hooks/useVoiceSession";

export default function SessionScreen() {
  const router = useRouter();
  const { phase, error, metadata, metrics, messages, playbackUri, start, stop, sendChunk } = useVoiceSession();

  // Day 6-U: confirm before stopping. Users instinctively hold the
  // iPhone close to their face for voice conversations, even with
  // speakerphone on — and a cheek brush can register as a tap on the
  // big "Terminar sesión" Pressable, killing the session mid-turn
  // (verified by [voice] stop() called appearing right after a
  // playback ends, with no real user intent). A confirm dialog
  // intercepts accidental taps without slowing intentional ones.
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

  const isLive = phase === "live";

  // Day 5-I++: delay mounting the audio components by 600ms after the WS
  // goes live. Reason: instantiating useAudioStream / useAudioPlayer
  // synchronously fires an iOS audio session activation that React
  // Native's WebSocket layer treats as a fatal interruption — WS closes
  // with code 1005 before the gateway has time to send setupComplete.
  const [audioReady, setAudioReady] = useState(false);
  useEffect(() => {
    if (!isLive) {
      setAudioReady(false);
      return;
    }
    console.log("[session] phase=live → starting 600ms audio mount delay");
    const t = setTimeout(() => {
      console.log("[session] audio mount delay elapsed, mounting MicCapture + AudioPlayback");
      setAudioReady(true);
    }, 600);
    return () => clearTimeout(t);
  }, [isLive]);

  // Day 6-L: client-side half-duplex gate. AudioPlayback fires the
  // callbacks below when the coach's TTS actually starts and ends
  // playing (real expo-audio events, not server-side timer estimation).
  // While `coachIsSpeaking` is true, MicCapture drops chunks at the
  // source — kills the speaker → mic echo loop without losing any of
  // the user's words once playback ends (the unmute is event-driven,
  // no extra padding seconds).
  const [coachIsSpeaking, setCoachIsSpeaking] = useState(false);

  // Day 6-Y: force-remount MicCapture after each coach turn ends.
  // Day 6-X gateway logs proved iOS silently severs the input source
  // when AVAudioPlayer takes the audio session, and stream.start()
  // afterwards is a no-op even though isStreaming returns true. The
  // only reliable way we've found to bring the native AudioStream back
  // online is to fully recreate the useAudioStream hook — which happens
  // when MicCapture unmounts + remounts. Bumping `micEpoch` as the key
  // does exactly that without disturbing the WS / AudioPlayback.
  const [micEpoch, setMicEpoch] = useState(0);
  const handlePlaybackEnd = () => {
    setCoachIsSpeaking(false);
    setMicEpoch((e) => e + 1);
  };
  const isBusy = phase === "starting" || phase === "stopping";
  const canTrigger = phase === "idle" || phase === "ended" || phase === "error" || isLive;

  const buttonLabel = isLive
    ? "Terminar sesión"
    : phase === "starting"
    ? "Conectando…"
    : phase === "stopping"
    ? "Cerrando…"
    : phase === "ended"
    ? "Empezar otra vez"
    : "Empezar sesión";

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <Text style={styles.eyebrow}>Voice spike · Día 3</Text>
          <Pressable onPress={() => router.back()}>
            <Text style={styles.closeText}>Cerrar</Text>
          </Pressable>
        </View>
        <Text style={styles.title}>Hablemos en inglés</Text>

        <View style={styles.statusRow}>
          <View
            style={[
              styles.dot,
              {
                backgroundColor: isLive
                  ? "#10b981"
                  : phase === "error"
                  ? "#ef4444"
                  : isBusy
                  ? "#f59e0b"
                  : "#d1d5db",
              },
            ]}
          />
          <Text style={styles.statusText}>phase: {phase}</Text>
        </View>

        {metadata ? (
          <Text style={styles.meta}>
            session {metadata.sessionId.slice(0, 8)}…
            {metrics.timeToFirstResponseMs !== null
              ? `  ·  primera respuesta ${metrics.timeToFirstResponseMs.toFixed(0)} ms`
              : ""}
          </Text>
        ) : null}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.transcriptsBox}>
          <Text style={styles.transcriptLabel}>Conversación</Text>
          {messages.length === 0 ? (
            <Text style={styles.emptyChat}>
              {isLive
                ? "Escucha al coach y responde cuando termine…"
                : "Pulsa Empezar para iniciar una conversación con tu coach."}
            </Text>
          ) : (
            messages.map((m) => (
              <View
                key={m.id}
                style={[
                  styles.bubble,
                  m.role === "user" ? styles.bubbleUser : styles.bubbleCoach,
                ]}
              >
                <Text style={styles.bubbleAuthor}>
                  {m.role === "user" ? "Tú" : "Coach"}
                  {!m.complete ? " · escribiendo…" : ""}
                </Text>
                <Text
                  style={[
                    styles.bubbleText,
                    m.role === "user" ? styles.bubbleTextUser : styles.bubbleTextCoach,
                  ]}
                >
                  {m.text.trim()}
                </Text>
              </View>
            ))
          )}
        </View>

        <Text style={styles.note}>
          Habla en inglés y el coach te responderá. Si no aparece tu
          transcripción, espera unos segundos: necesita oír una frase
          completa antes de transcribir.
        </Text>

        <Pressable
          onPress={isLive ? stopWithConfirm : start}
          disabled={isBusy || !canTrigger}
          style={[
            styles.button,
            isLive ? styles.buttonStop : styles.buttonStart,
            (isBusy || !canTrigger) && styles.buttonDisabled,
          ]}
        >
          {isBusy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>{buttonLabel}</Text>
          )}
        </Pressable>
      </ScrollView>

      {/* Mic capture + audio playback mount ONLY while live — keeps the
          native audio hooks out of the React tree until the WS handshake
          has already succeeded. AudioPlayback uses the latest playbackUri
          state from useVoiceSession; each new URI triggers playback. */}
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

function Metric({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <View style={styles.metricRow}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, highlight && styles.metricValueHi]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 24, gap: 16 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  eyebrow: { fontSize: 11, fontWeight: "600", letterSpacing: 1, color: "#64748b", textTransform: "uppercase" },
  closeText: { fontSize: 14, color: "#64748b" },
  title: { fontSize: 28, fontWeight: "700", color: "#0f172a" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 13, color: "#64748b" },
  meta: { fontSize: 11, color: "#64748b", lineHeight: 16 },
  metricsBox: { marginTop: 8, gap: 0 },
  metricRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomColor: "#f1f5f9",
    borderBottomWidth: 1,
  },
  metricLabel: { fontSize: 13, color: "#64748b", flex: 1 },
  metricValue: { fontSize: 15, fontWeight: "600", color: "#0f172a" },
  metricValueHi: { color: "#059669" },
  errorText: { fontSize: 13, color: "#dc2626", marginTop: 4 },
  transcriptsBox: {
    marginTop: 12,
    padding: 14,
    backgroundColor: "#f8fafc",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  transcriptLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    color: "#64748b",
    textTransform: "uppercase",
  },
  emptyChat: {
    fontSize: 13,
    color: "#94a3b8",
    fontStyle: "italic",
    marginTop: 8,
  },
  // Day 8-A: chat bubble styles — user (you) on the right in brand blue,
  // coach on the left in neutral. Mirrors common chat UI conventions.
  bubble: {
    marginTop: 8,
    padding: 10,
    borderRadius: 12,
    maxWidth: "85%",
  },
  bubbleUser: {
    backgroundColor: "#0ea5e9",
    alignSelf: "flex-end",
    borderTopRightRadius: 2,
  },
  bubbleCoach: {
    backgroundColor: "#e2e8f0",
    alignSelf: "flex-start",
    borderTopLeftRadius: 2,
  },
  bubbleAuthor: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginBottom: 2,
    opacity: 0.85,
  },
  bubbleText: { fontSize: 15, lineHeight: 22 },
  bubbleTextUser: { color: "#ffffff" },
  bubbleTextCoach: { color: "#0f172a" },
  note: { fontSize: 12, color: "#64748b", lineHeight: 18, marginTop: 8 },
  button: {
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: "center",
    marginTop: 12,
  },
  buttonStart: { backgroundColor: "#0ea5e9" },
  buttonStop: { backgroundColor: "#dc2626" },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: "#fff", fontSize: 17, fontWeight: "600" },
});
