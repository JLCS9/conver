#!/usr/bin/env bash
#
# Converflow deploy script.
# Run on the VPS in /opt/converflow as root (or any user in the docker group).
#
#   cd /opt/converflow && ./scripts/deploy.sh
#
# What it does:
#   1. Pulls latest main from GitHub (fast-forward only — refuses on diverged history).
#   2. Rebuilds the backend image and recreates the containers.
#   3. Prints service status and the last 20 lines of backend logs.
#
# Safe to re-run.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "==> Pulling latest from main..."
git fetch origin main
git pull --ff-only origin main

echo
echo "==> Verifying backend/.env.local exists..."
if [[ ! -f "${ROOT}/backend/.env.local" ]]; then
  echo "  [!] backend/.env.local is missing."
  echo "      Copy backend/.env.example to backend/.env.local and fill values."
  echo "      For the /api/health milestone, all values may be left blank."
  exit 1
fi

echo
echo "==> Building and recreating containers..."
docker compose up -d --build --remove-orphans

echo
echo "==> Status:"
docker compose ps

echo
echo "==> Recent backend logs:"
docker compose logs --tail 20 backend || true

echo
echo "==> Recent caddy logs:"
docker compose logs --tail 10 caddy || true

echo
echo "==> Done. Test from your laptop:"
echo "      curl -i https://api.converflow.tech/api/health"
