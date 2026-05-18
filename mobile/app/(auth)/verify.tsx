import { useSignUp } from "@clerk/clerk-expo";
import { router } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";

export default function VerifyScreen() {
  const { signUp, setActive, isLoaded } = useSignUp();
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onVerify() {
    if (!isLoaded) return;
    setSubmitting(true);
    setErr(null);
    try {
      const attempt = await signUp.attemptEmailAddressVerification({ code });
      if (attempt.status === "complete") {
        await setActive({ session: attempt.createdSessionId });
        router.replace("/(app)");
      } else {
        setErr(`Verificación incompleta: ${attempt.status}`);
      }
    } catch (e: unknown) {
      const msg =
        (e as { errors?: { message?: string }[]; message?: string }).errors?.[0]
          ?.message ??
        (e as { message?: string }).message ??
        "Error desconocido";
      setErr(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={s.screen}>
      <Text style={s.h1}>Verifica tu email</Text>
      <Text style={s.body}>
        Te hemos enviado un código por email. Pégalo aquí:
      </Text>
      <TextInput
        style={s.input}
        placeholder="123456"
        value={code}
        onChangeText={setCode}
        autoCapitalize="none"
        keyboardType="number-pad"
        editable={!submitting}
        maxLength={10}
      />
      <Pressable
        style={[s.button, submitting && s.buttonDisabled]}
        onPress={onVerify}
        disabled={submitting}
      >
        {submitting ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={s.buttonText}>Verificar</Text>
        )}
      </Pressable>
      {err ? <Text style={s.err}>{err}</Text> : null}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: {
    flex: 1,
    padding: 24,
    gap: 12,
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  h1: { fontSize: 28, fontWeight: "600" },
  body: { color: "#555", marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 10,
    padding: 14,
    fontSize: 24,
    letterSpacing: 4,
    textAlign: "center",
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
});
