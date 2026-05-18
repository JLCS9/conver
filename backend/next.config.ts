import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  // Standalone output makes the Docker image small: only the minimal
  // server.js + node_modules needed at runtime are emitted.
  output: "standalone",
  // Pin the workspace root to this directory. Without this, Next.js walks
  // up looking for a package.json and may treat an ancestor dir as the
  // workspace root, which causes the standalone build to emit server.js
  // under nested path segments (e.g. .next/standalone/conver/backend/).
  outputFileTracingRoot: path.resolve(__dirname),
  reactStrictMode: true,
  poweredByHeader: false,
};

export default config;
