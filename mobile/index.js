// Native entry point. The iOS/Android binaries request `/index.bundle`
// from Metro at runtime, so we need an `index.js` file at the project
// root regardless of what `package.json -> main` points to.
//
// All this file does is re-export expo-router's entry, which sets up
// the file-based router under `app/`. The native binary doesn't see
// `expo-router/entry` directly because RN's AppRegistry bootstrap is
// keyed on the filesystem path "/index.bundle".
import "expo-router/entry";
