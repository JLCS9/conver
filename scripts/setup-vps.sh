#!/usr/bin/env bash
#
# Converflow VPS setup script.
#
# Run as root on a fresh-ish Debian 13 VPS. Safe to re-run (idempotent).
#
# Usage on the VPS:
#   curl -fsSL https://raw.githubusercontent.com/JLCS9/conver/main/scripts/setup-vps.sh -o setup-vps.sh
#   chmod +x setup-vps.sh
#   ./setup-vps.sh
#
# What this script DOES:
#   1. Updates apt package index.
#   2. Installs Docker engine + compose plugin (skips if already present).
#   3. Installs Caddy v2 from the official Cloudsmith repo (skips if present).
#   4. Installs and enables fail2ban.
#   5. Installs ufw but DOES NOT enable it (you do that manually after adding
#      rules for your other projects on this VPS).
#   6. Creates user 'deploy' with bash shell and docker group membership.
#   7. Creates /opt/converflow/ owned by deploy for the backend stack.
#
# What this script does NOT do (intentionally — destructive, manual review needed):
#   - Touch /etc/ssh/sshd_config (instructions printed at the end).
#   - Enable ufw (rules first, then you enable).
#   - Write your SSH public keys (instructions at the end).
#   - Configure Caddy with a Caddyfile (deployed later via docker compose).
#
set -euo pipefail

RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[1;33m'
BLU='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLU}[info]${NC} $*"; }
ok()    { echo -e "${GRN}[ ok ]${NC} $*"; }
warn()  { echo -e "${YLW}[warn]${NC} $*"; }
err()   { echo -e "${RED}[err ]${NC} $*" >&2; }

confirm() {
  local prompt="${1:-Continue?}"
  read -r -p "$(echo -e "${YLW}? ${prompt}${NC} [y/N] ")" reply
  [[ "$reply" =~ ^[yY](es)?$ ]]
}

# --- Preconditions -------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root."
  exit 1
fi

if ! grep -qi 'debian' /etc/os-release; then
  warn "This script is designed for Debian. Detected:"
  cat /etc/os-release
  if ! confirm "Continue anyway?"; then
    exit 1
  fi
fi

info "Starting Converflow VPS setup."
info "User: $(whoami) | Host: $(hostname) | OS: $(. /etc/os-release && echo "$PRETTY_NAME")"
echo

# --- 1. apt update -------------------------------------------------------------
info "Updating apt package index..."
DEBIAN_FRONTEND=noninteractive apt-get update -qq
ok "apt updated."
echo

# --- 2. Docker -----------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  ok "Docker already installed: $(docker --version)"
else
  info "Installing Docker via official convenience script..."
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm /tmp/get-docker.sh
  ok "Docker installed: $(docker --version)"
fi

if docker compose version >/dev/null 2>&1; then
  ok "Docker compose plugin already installed: $(docker compose version | head -1)"
else
  info "Installing docker compose plugin..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin
  ok "Compose plugin installed."
fi
echo

# --- 3. Caddy v2 ---------------------------------------------------------------
if command -v caddy >/dev/null 2>&1; then
  ok "Caddy already installed: $(caddy version)"
else
  info "Installing Caddy v2 from official Cloudsmith repo..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
  # We will run Caddy inside docker-compose later, so stop the host service
  # to avoid port 80/443 conflicts. Keep the binary installed for ad-hoc use.
  systemctl disable --now caddy >/dev/null 2>&1 || true
  ok "Caddy installed: $(caddy version)"
  info "Host caddy.service disabled — we run Caddy in docker-compose later."
fi
echo

# --- 4. fail2ban ---------------------------------------------------------------
if dpkg -l fail2ban 2>/dev/null | grep -q '^ii'; then
  ok "fail2ban already installed."
else
  info "Installing fail2ban..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban
  systemctl enable --now fail2ban
  ok "fail2ban installed and enabled."
fi
echo

# --- 5. ufw (install, do NOT enable) ------------------------------------------
if dpkg -l ufw 2>/dev/null | grep -q '^ii'; then
  ok "ufw already installed."
else
  info "Installing ufw (not enabling automatically)..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y ufw
  ok "ufw installed."
fi
ufw_status=$(ufw status 2>/dev/null | head -1 || echo "unknown")
info "Current ufw status: ${ufw_status}"
warn "Not enabling ufw automatically — review rules for your OTHER projects first."
echo

# --- 6. deploy user ------------------------------------------------------------
if id -u deploy >/dev/null 2>&1; then
  ok "User 'deploy' already exists."
else
  info "Creating user 'deploy' with bash shell..."
  useradd -m -s /bin/bash deploy
  ok "User 'deploy' created."
fi

if id -nG deploy | tr ' ' '\n' | grep -qx 'docker'; then
  ok "User 'deploy' is in docker group."
else
  usermod -aG docker deploy
  ok "Added 'deploy' to docker group."
fi

deploy_home="/home/deploy"
ssh_dir="${deploy_home}/.ssh"
if [[ ! -d "$ssh_dir" ]]; then
  install -d -m 700 -o deploy -g deploy "$ssh_dir"
  ok "Created ${ssh_dir}."
fi
authorized_keys="${ssh_dir}/authorized_keys"
if [[ ! -f "$authorized_keys" ]]; then
  install -m 600 -o deploy -g deploy /dev/null "$authorized_keys"
  ok "Created empty ${authorized_keys}."
fi
echo

# --- 7. app directory ----------------------------------------------------------
app_dir="/opt/converflow"
if [[ ! -d "$app_dir" ]]; then
  install -d -m 755 -o deploy -g deploy "$app_dir"
  ok "Created ${app_dir} owned by deploy."
else
  ok "${app_dir} already exists."
fi
echo

# --- Summary + manual next steps ----------------------------------------------
echo
echo "==================================================================="
ok "Setup complete."
echo "==================================================================="
echo
warn "MANUAL steps still required:"
echo
echo "  1. Add your laptop public SSH key to /home/deploy/.ssh/authorized_keys."
echo "     From your Mac, run:"
echo "       cat ~/.ssh/id_ed25519.pub   # or id_rsa.pub if you use RSA"
echo "     Then on this VPS append the output:"
echo "       echo 'ssh-ed25519 AAAA... your@laptop' >> /home/deploy/.ssh/authorized_keys"
echo
echo "  2. From your Mac, test you can SSH as deploy:"
echo "       ssh deploy@187.77.166.246"
echo "     This MUST succeed before you do step 3, otherwise you'll lock yourself out."
echo
echo "  3. ONLY AFTER step 2 works, harden SSH on the VPS:"
echo "       sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config"
echo "       sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config"
echo "       systemctl reload ssh"
echo
echo "  4. Generate a CI deploy key (DIFFERENT from your laptop key) on your Mac:"
echo "       ssh-keygen -t ed25519 -f ~/converflow-ci -C 'github-actions-converflow' -N ''"
echo "       # Add the PUBLIC key to the VPS:"
echo "       ssh deploy@187.77.166.246 'cat >> ~/.ssh/authorized_keys' < ~/converflow-ci.pub"
echo "       # Add the PRIVATE key contents to GitHub Secrets as DEPLOY_SSH_KEY:"
echo "       cat ~/converflow-ci"
echo
echo "  5. Configure ufw rules (add ports your OTHER projects need too), then enable:"
echo "       ufw allow 22/tcp comment 'ssh'"
echo "       ufw allow 80/tcp comment 'http'"
echo "       ufw allow 443/tcp comment 'https'"
echo "       # ufw allow XXXX/tcp comment 'other-project'"
echo "       ufw enable"
echo
echo "  6. Add DNS A record: api.converflow.ai -> 187.77.166.246 (TTL 300)."
echo
echo "==================================================================="
