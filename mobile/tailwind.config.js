/** @type {import('tailwindcss').Config} */
module.exports = {
  // NativeWind v4 needs every file that contains className strings listed here.
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        // Minimal palette to start. We extend as the design system grows.
        brand: {
          DEFAULT: "#0EA5E9", // sky-500, used for primary actions
          ink: "#0F172A", // slate-900, used for body text on light bg
          muted: "#64748B", // slate-500
        },
      },
    },
  },
  plugins: [],
};
