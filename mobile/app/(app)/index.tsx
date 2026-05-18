import { useAuth, useUser } from "@clerk/clerk-expo";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
} from "react-native";
import { api } from "@/src/lib/api";

type MeResponse = {
  user: {
    id: string;
    clerk_user_id: string;
    email: string;
    role: string;
    level: string;
    created_at: string;
  };
};

export default function Home() {
  const { signOut, getToken } = useAuth();
  const { user } = useUser();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<MeResponse>("/api/me", { getToken });
        if (!cancelled) setMe(data);
      } catch (e: unknown) {
        if (!cancelled) {
          setErr(
            (e as { message?: string }).message ??
              "No se pudo cargar el perfil",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  if (loading) {
    return (
      <SafeAreaView style={s.center}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  const displayName =
    user?.firstName ||
    user?.emailAddresses[0]?.emailAddress.split("@")[0] ||
    "usuario";

  return (
    <SafeAreaView style={s.screen}>
      <ScrollView contentContainerStyle={s.content}>
        <Text style={s.greeting}>Hola, {displayName} 👋</Text>
        <Text style={s.body}>
          Si ves esto, el loop funciona: Expo → Clerk → backend → Supabase.
        </Text>

        {err ? <Text style={s.err}>{err}</Text> : null}

        {me ? (
          <>
            <Text style={s.label}>Tu fila en Supabase:</Text>
            <Text style={s.code}>{JSON.stringify(me.user, null, 2)}</Text>
          </>
        ) : null}

        <Pressable style={s.button} onPress={() => signOut()}>
          <Text style={s.buttonText}>Cerrar sesión</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#fff" },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#fff",
  },
  content: { padding: 24, gap: 16 },
  greeting: { fontSize: 28, fontWeight: "600" },
  body: { fontSize: 16, color: "#555" },
  label: { fontSize: 14, fontWeight: "600", marginTop: 12 },
  code: {
    fontFamily: "Menlo",
    fontSize: 12,
    color: "#333",
    backgroundColor: "#f5f5f5",
    padding: 12,
    borderRadius: 8,
  },
  err: { color: "#b91c1c", fontSize: 14 },
  button: {
    backgroundColor: "#111",
    padding: 14,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 24,
  },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
