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
  const { phase, error, metadata, metrics, transcripts, playbackUri, start, stop, sendChunk } = useVoiceSession();

  const isLive = phase === "live";

  // Day 5-I++: delay mounting the audio components by 600ms after the WS
  // goes live. Reason: instantiating useAudioStream / useAudioPlayer
  // synchronously fires an iOS audio session activation that React
  // Native's WebSocket layer treats as a fatal interruption — WS closes
  // with code 1005 before the gateway has time to send setupComplete.
  //
  // 600ms is empirically chosen: the gateway typically sends setupComplete
  // in 50-200ms after `[ws] open`. Waiting 600ms gives a comfortable margin
  // for the WS to receive that frame and warm up before any audio session
  // activity fires. Once the WS has roundtripped at least one frame it
  // survives subsequent route changes (iOS treats it as an established
  // connection rather than a brand-new one to abort defensively).
  const [audioReady, setAudioReady] = useState(false);
  useEffect(() => {
    if (!isLive) {
      setAudioReady(false);
      return;
    }
    const t = setTimeout(() => setAudioReady(true), 600);
    return () => clearTimeout(t);
  }, [isLive]);
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
            session {metadata.sessionId.slice(0, 8)}…  ·  model {metadata.model}  ·  cap {metadata.maxDurationSeconds}s
          </Text>
        ) : null}

        <View style={styles.metricsBox}>
          <Metric label="Chunks sent (mic → Gemini)" value={String(metrics.chunksSent)} />
          <Metric
            label="Bytes sent"
            value={metrics.bytesSent === 0 ? "0" : `${(metrics.bytesSent / 1024).toFixed(1)} KB`}
          />
          <Metric label="Chunks received" value={String(metrics.chunksReceived)} />
          <Metric
            label="Bytes received"
            value={metrics.bytesReceived === 0 ? "0" : `${(metrics.bytesReceived / 1024).toFixed(1)} KB`}
          />
          <Metric
            label="TTFA (ws open → first audio chunk)"
            value={
              metrics.timeToFirstResponseMs === null
                ? "—"
                : `${metrics.timeToFirstResponseMs.toFixed(0)} ms`
            }
            highlight={metrics.timeToFirstResponseMs !== null}
          />
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.transcriptsBox}>
          <Text style={styles.transcriptLabel}>Tú</Text>
          <Text style={styles.transcriptUser}>
            {transcripts.user.trim() ||
              (isLive
                ? metrics.chunksSent > 30
                  ? "(audio sin reconocer — el simulador no tiene mic real)"
                  : "Escuchando…"
                : "—")}
          </Text>
          <Text style={[styles.transcriptLabel, { marginTop: 12 }]}>Coach</Text>
          <Text style={styles.transcriptModel}>
            {transcripts.model.trim() || (isLive ? "Esperando turno…" : "—")}
          </Text>
        </View>

        <Text style={styles.note}>
          Habla en inglés y el coach te responderá. Si no aparece tu
          transcripción, espera unos segundos; Gemini necesita oír una
          frase completa antes de transcribir.
        </Text>

        <Pressable
          onPress={isLive ? stop : start}
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
          <MicCapture onChunk={sendChunk} />
          <AudioPlayback uri={playbackUri} />
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
  transcriptUser: {
    fontSize: 14,
    color: "#0f172a",
    marginTop: 4,
    lineHeight: 20,
  },
  transcriptModel: {
    fontSize: 14,
    color: "#0ea5e9",
    marginTop: 4,
    lineHeight: 20,
  },
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
