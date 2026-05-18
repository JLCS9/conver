// Default Expo Metro config. We export it as-is for now; NativeWind and
// other transformers will plug in here when we add them in a later commit.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

module.exports = config;
