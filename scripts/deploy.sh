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
echo "==> Recent voice-gateway logs:"
docker compose logs --tail 20 voice-gateway || true

echo
echo "==> Done."
echo "    Backend (HTTP)   local check:  curl -i http://127.0.0.1:8082/api/health"
echo "    Backend (HTTP)   public check: curl -i https://api.converflow.tech/api/health"
echo "    Gateway (HTTP)   local check:  curl -i http://127.0.0.1:8083/health"
echo "    Gateway (WSS)    public check: wscat -c wss://api.converflow.tech/voice"
echo "    (Public checks require the host nginx vhost + SSL — see"
echo "     scripts/nginx-api.converflow.tech.conf for the one-time install.)"
echo "    (After updating the vhost on the VPS, reload nginx:"
echo "       sudo cp /opt/converflow/scripts/nginx-api.converflow.tech.conf \\"
echo "              /etc/nginx/sites-available/api.converflow.tech &&"
echo "       sudo nginx -t && sudo systemctl reload nginx )"
