import * as SecureStore from "expo-secure-store";

// Clerk's TokenCache adapter backed by iOS Keychain / Android Keystore.
// Without this, the Clerk session is lost on every app restart.
export const tokenCache = {
  async getToken(key: string) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async saveToken(key: string, value: string) {
    try {
      return await SecureStore.setItemAsync(key, value);
    } catch (e) {
      console.error("Failed to save Clerk token to secure store", e);
    }
  },
};
