# syntax=docker/dockerfile:1.7
#
# Converflow backend image — multi-stage build.
# Produces a minimal Node 22 Alpine runtime running Next.js standalone output.

# --- 1. deps: install production deps only -----------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN npm ci

# --- 2. builder: build Next.js (needs full deps) -----------------------------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- 3. runner: minimal production image -------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as non-root.
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy the standalone output (server.js + minimal node_modules).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# Static assets that the standalone server expects to find at .next/static.
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

# wget is provided by busybox in alpine, used by docker-compose healthcheck.
CMD ["node", "server.js"]
