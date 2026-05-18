import { useSignIn } from "@clerk/clerk-expo";
import { Link, router } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

export default function SignInScreen() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit() {
    if (!isLoaded) return;
    setSubmitting(true);
    setErr(null);
    try {
      const attempt = await signIn.create({
        identifier: email,
        password,
      });
      if (attempt.status === "complete") {
        await setActive({ session: attempt.createdSessionId });
        router.replace("/(app)");
      } else {
        setErr(`Sign-in incompleto: ${attempt.status}`);
      }
    } catch (e: unknown) {
      setErr(extractErr(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={s.screen}>
      <Text style={s.h1}>Iniciar sesión</Text>
      <TextInput
        style={s.input}
        placeholder="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        editable={!submitting}
      />
      <TextInput
        style={s.input}
        placeholder="Contraseña"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        editable={!submitting}
      />
      <Pressable
        style={[s.button, submitting && s.buttonDisabled]}
        onPress={onSubmit}
        disabled={submitting}
      >
        {submitting ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={s.buttonText}>Entrar</Text>
        )}
      </Pressable>
      {err ? <Text style={s.err}>{err}</Text> : null}
      <View style={s.footer}>
        <Text style={s.footerText}>¿No tienes cuenta?</Text>
        <Link href="/(auth)/sign-up" replace style={s.link}>
          Crear cuenta
        </Link>
      </View>
    </SafeAreaView>
  );
}

function extractErr(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const anyE = e as { errors?: { message?: string }[]; message?: string };
    return anyE.errors?.[0]?.message ?? anyE.message ?? "Error desconocido";
  }
  return "Error desconocido";
}

const s = StyleSheet.create({
  screen: {
    flex: 1,
    padding: 24,
    gap: 12,
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  h1: { fontSize: 32, fontWeight: "600", marginBottom: 12 },
  input: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 10,
    padding: 14,
    fontSize: 16,
  },
  button: {
    backgroundColor: "#111",
    padding: 14,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  err: { color: "#b91c1c", marginTop: 8 },
  footer: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
    marginTop: 16,
  },
  footerText: { color: "#555" },
  link: { color: "#0366d6", fontWeight: "600" },
});
