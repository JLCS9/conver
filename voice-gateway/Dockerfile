# Multi-stage Dockerfile for the voice-gateway.
# Stage 1 installs all deps and compiles TS → JS.
# Stage 2 copies the compiled output + prod deps into a slim runtime image.
# Runs as non-root for defence in depth (same pattern as the Next.js backend).

# ----- Stage 1: build -----
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Prune devDependencies so we only carry runtime deps forward.
RUN npm prune --omit=dev


# ----- Stage 2: runtime -----
FROM node:22-alpine AS runtime

# Tiny utilities for the healthcheck (alpine doesn't ship wget by default
# but it does ship busybox wget — keeping the spec explicit).
RUN apk add --no-cache wget && \
    addgroup -S app && adduser -S app -G app

WORKDIR /app

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./package.json

USER app

ENV NODE_ENV=production
ENV PORT=8083

EXPOSE 8083

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:8083/health || exit 1

CMD ["node", "dist/server.js"]
