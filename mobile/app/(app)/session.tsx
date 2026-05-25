// Voice session screen — Day 2 spike UI.
//
// Minimal on purpose: one big toggle button, status pill, and a metrics
// readout for debugging (chunks/bytes sent and received + TTFA). NativeWind
// styling, no fancy animations yet — the orb + transcript come in Day 4.
//
// What the user sees:
//   - Initial: "Empezar sesión" button + small "Voice spike — Day 2" header.
//   - While live: button turns "Terminar sesión", status shows "live", and
//     the metrics tick in real time. First inbound binary > 5 KB stamps
//     `timeToFirstResponseMs` — that's our TTFA proxy.
//   - On stop/error: shows final metrics and any error message.

import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, SafeAreaView, Text, View } from "react-native";
import { useVoiceSession } from "@/src/hooks/useVoiceSession";

export default function SessionScreen() {
  const router = useRouter();
  const { phase, error, metadata, metrics, start, stop } = useVoiceSession();

  const isLive = phase === "live";
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
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 px-6 pt-8 pb-10 justify-between">
        {/* Top: header + status */}
        <View className="gap-3">
          <View className="flex-row items-center justify-between">
            <Text className="text-xs font-semibold text-brand-muted uppercase tracking-wider">
              Voice spike · Día 2
            </Text>
            <Pressable onPress={() => router.back()}>
              <Text className="text-sm text-brand-muted">Cerrar</Text>
            </Pressable>
          </View>
          <Text className="text-3xl font-bold text-brand-ink leading-tight">
            Hablemos en inglés
          </Text>
          <View className="flex-row items-center gap-2">
            <View
              className={`w-2 h-2 rounded-full ${
                isLive
                  ? "bg-emerald-500"
                  : phase === "error"
                  ? "bg-red-500"
                  : isBusy
                  ? "bg-amber-500"
                  : "bg-gray-300"
              }`}
            />
            <Text className="text-sm text-brand-muted">phase: {phase}</Text>
          </View>
          {metadata ? (
            <Text className="text-xs text-brand-muted leading-5">
              session {metadata.sessionId.slice(0, 8)}…  ·  model {metadata.model}  ·  cap {metadata.maxDurationSeconds}s
            </Text>
          ) : null}
        </View>

        {/* Middle: metrics */}
        <View className="gap-3">
          <Metric label="Chunks sent (mic → Gemini)" value={String(metrics.chunksSent)} />
          <Metric
            label="Bytes sent"
            value={metrics.bytesSent === 0 ? "0" : `${(metrics.bytesSent / 1024).toFixed(1)} KB`}
          />
          <Metric label="Chunks received (Gemini → us)" value={String(metrics.chunksReceived)} />
          <Metric
            label="Bytes received"
            value={metrics.bytesReceived === 0 ? "0" : `${(metrics.bytesReceived / 1024).toFixed(1)} KB`}
          />
          <Metric
            label="TTFA (first audio sent → first response)"
            value={
              metrics.timeToFirstResponseMs === null
                ? "—"
                : `${metrics.timeToFirstResponseMs.toFixed(0)} ms`
            }
            highlight={metrics.timeToFirstResponseMs !== null}
          />
          {error ? (
            <Text className="text-sm text-red-600 leading-5 mt-2">{error}</Text>
          ) : null}
          <Text className="text-xs text-brand-muted leading-5 mt-2">
            Día 2 spike: no se reproduce el audio del modelo (los frames son protobuf,
            la decodificación va a la gateway en Día 3). Aquí solo se mide latencia
            y se valida la cadena.
          </Text>
        </View>

        {/* Bottom: the action button */}
        <Pressable
          onPress={isLive ? stop : start}
          disabled={isBusy || !canTrigger}
          className={`rounded-2xl py-5 items-center active:opacity-80 disabled:opacity-60 ${
            isLive ? "bg-red-600" : "bg-brand"
          }`}
        >
          {isBusy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text className="text-white text-lg font-semibold">{buttonLabel}</Text>
          )}
        </Pressable>
      </View>
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
    <View className="flex-row items-center justify-between border-b border-gray-100 py-2">
      <Text className="text-sm text-brand-muted">{label}</Text>
      <Text
        className={`text-base font-semibold ${
          highlight ? "text-emerald-600" : "text-brand-ink"
        }`}
      >
        {value}
      </Text>
    </View>
  );
}
