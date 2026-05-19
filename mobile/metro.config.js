// Metro config wired with NativeWind v4. The CSS file is processed at
// bundle time so Tailwind utilities reach the runtime as style objects.
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);

module.exports = withNativeWind(config, { input: "./global.css" });
