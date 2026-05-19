// Push permission screen. First "real" decision in the onboarding flow
// because the daily push is the habit-engine of the product — losing it
// kills retention.
//
// Flow:
//   1. Educational pre-prompt explains *why* we want to send pushes.
//   2. User taps "Activar" → we call the iOS dialog.
//   3. On granted: register the Expo push token with the backend, stash
//      the token in the wizard store, advance to role selection.
//   4. On denied (canAskAgain): show "Más tarde" path — user can still
//      finish onboarding, we mark hasPushPermission=false in the store.
//   5. On blocked (canAskAgain=false): deep-link to Settings; user can
//      flip the switch and return.
//
// On the iOS Simulator getExpoPushTokenAsync throws because APNs is
// disabled there. registerPushToken handles that gracefully and treats
// the simulator case as a no-op success — the user is unblocked.

import { useAuth } from "@clerk/clerk-expo";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, Text, View } from "react-native";
import {
  openAppSettings,
  requestNotificationPermission,
} from "@/src/services/permissions/notifications";
import { registerPushToken } from "@/src/services/push/registerToken";
import { useOnboardingStore } from "@/src/stores/onboardingStore";

export default function NotificationsScreen() {
  const router = useRouter();
  const { getToken } = useAuth();
  const setPushPermission = useOnboardingStore((s) => s.setPushPermission);
  const [status, setStatus] = useState<"idle" | "asking" | "blocked" | "denied">(
    "idle",
  );

  const enable = async () => {
    setStatus("asking");
    const permission = await requestNotificationPermission();

    if (permission.status === "granted") {
      // Try to register the push token but don't block onboarding if it
      // fails — the user gave permission, that's what matters for the flow.
      const registration = await registerPushToken(getToken);
      const token =
        registration.ok && "token" in registration ? registration.token : null;
      setPushPermission(true, token ?? undefined);
      router.push("/(onboarding)/role");
      return;
    }

    if (permission.status === "blocked") {
      setStatus("blocked");
      return;
    }

    setPushPermission(false);
    setStatus("denied");
  };

  const skip = () => {
    setPushPermission(false);
    router.push("/(onboarding)/role");
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 px-6 pt-12 pb-8 justify-between">
        <View className="gap-6">
          <Text className="text-3xl font-bold text-brand-ink leading-tight">
            Un push diario te mantiene en la racha
          </Text>
          <Text className="text-base text-brand-muted leading-7">
            Te enviaremos una sola notificación al día, a la hora que tú
            elijas, para recordarte tu sesión de inglés. Sin spam, sin
            interrupciones inesperadas.
          </Text>
          <View className="gap-3 mt-2">
            <Bullet text="Una notificación al día, no más." />
            <Bullet text="Solo a tu hora elegida." />
            <Bullet text="Puedes cambiarla o desactivarla cuando quieras." />
          </View>
        </View>

        <View className="gap-3">
          {status === "blocked" ? (
            <>
              <Text className="text-sm text-red-600 text-center">
                Notificaciones bloqueadas. Actívalas en Ajustes para no perder
                tu racha.
              </Text>
              <Pressable
                onPress={openAppSettings}
                className="bg-brand rounded-2xl py-4 items-center active:opacity-80"
              >
                <Text className="text-white text-lg font-semibold">
                  Abrir Ajustes
                </Text>
              </Pressable>
              <Pressable onPress={skip} className="py-3 items-center">
                <Text className="text-brand-muted text-base">
                  Continuar sin notificaciones
                </Text>
              </Pressable>
            </>
          ) : (
            <>
              <Pressable
                onPress={enable}
                disabled={status === "asking"}
                className="bg-brand rounded-2xl py-4 items-center active:opacity-80 disabled:opacity-60"
              >
                {status === "asking" ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text className="text-white text-lg font-semibold">
                    Activar notificaciones
                  </Text>
                )}
              </Pressable>
              <Pressable onPress={skip} className="py-3 items-center">
                <Text className="text-brand-muted text-base">Más tarde</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <View className="flex-row items-start gap-3">
      <View className="w-2 h-2 rounded-full bg-brand mt-2" />
      <Text className="text-base text-brand-ink flex-1 leading-6">{text}</Text>
    </View>
  );
}
