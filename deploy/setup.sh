#!/usr/bin/env bash
# One-command setup of the LEGO price tracker on a fresh Ubuntu server (22.04 / 24.04, x86 or ARM).
#
#   git clone <your repo> lego-tracker && cd lego-tracker
#   CF_TUNNEL_TOKEN=<token> PINCODES="122003 140603" bash deploy/setup.sh
#
# Safe to run again: every step checks what is already done. Run as a normal user with sudo
# (the default "ubuntu" user on AWS EC2), not as root.
#
# Optional settings (environment variables):
#   CF_TUNNEL_TOKEN  Cloudflare Tunnel token. If set, cloudflared is installed as a service and the
#                    site goes live on the hostname configured for that tunnel (see
#                    deploy/cloudflared.yml for the settings). If unset, the script prints how to get one.
#   PINCODES         Pincodes to start tracking, space separated (e.g. "122003 560001").
#   SITE_HOST        Hostname to serve over HTTPS with Caddy, no Cloudflare needed (e.g. 13-232-1-2.sslip.io
#                    or your own domain pointing at this server). Needs inbound 80 and 443 open.
#   SWAP_GB          Swap file size to create if the server has none (default 4).
#   NODE_MAJOR       Node.js major version (default 24).

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_MAJOR="${NODE_MAJOR:-24}"
SWAP_GB="${SWAP_GB:-4}"
cd "$APP_DIR"

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
ok() { printf '    \033[32m%s\033[0m\n' "$*"; }
warn() { printf '    \033[31m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- checks
if [[ "$(id -u)" -eq 0 ]]; then
  echo "Run this as a normal user with sudo (e.g. ubuntu), not as root." >&2
  exit 1
fi
if ! grep -qi ubuntu /etc/os-release 2>/dev/null; then
  echo "This script is written for Ubuntu. Found: $(. /etc/os-release && echo "$PRETTY_NAME")" >&2
  exit 1
fi
. /etc/os-release
CODENAME="${VERSION_CODENAME:-noble}"
ARCH="$(dpkg --print-architecture)"
say "Setting up in $APP_DIR on $PRETTY_NAME ($ARCH)"
# Passwordless sudo (the EC2 default) needs no prompt; "sudo -v" alone asks for a password even then.
sudo -n true 2>/dev/null || sudo -v

# ---------------------------------------------------------------- system packages
say "System packages"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
# build-essential + python3: fallback compile for better-sqlite3 / sharp if no prebuilt binary fits.
# unzip: pincode coordinate import. sqlite3: handy for inspecting data.
sudo apt-get install -y -qq ca-certificates curl gnupg git build-essential python3 unzip sqlite3 logrotate >/dev/null
ok "done"

# ---------------------------------------------------------------- swap
# A refresh runs every store's browser at once; swap keeps a memory spike from killing it.
if [[ -z "$(swapon --show --noheadings)" ]]; then
  say "Creating ${SWAP_GB} GB swap file"
  sudo fallocate -l "${SWAP_GB}G" /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  ok "swap on"
fi

# ---------------------------------------------------------------- Node.js
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]]; then
  say "Installing Node.js $NODE_MAJOR"
  sudo mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq nodejs >/dev/null
fi
ok "node $(node -v), npm $(npm -v)"

# ---------------------------------------------------------------- app dependencies
say "Installing app dependencies (exact versions from the lockfiles)"
npm ci --no-audit --no-fund
npm ci --prefix web --no-audit --no-fund
ok "done"

say "Installing the browser and the system libraries it needs"
# x64: real Google Chrome, which BigBasket and Zepto accept (Playwright's headless shell gets blocked).
# ARM has no Google Chrome build, so it uses Playwright's Chromium. See src/browser.ts.
if [[ "$ARCH" == "amd64" ]]; then
  npx playwright install --with-deps chrome
else
  npx playwright install --with-deps chromium
fi
ok "done"

# ---------------------------------------------------------------- configuration
if [[ ! -f .env ]]; then
  say "Creating .env from .env.example"
  cp .env.example .env
  ok "edit $APP_DIR/.env to change settings"
fi
mkdir -p data logs

# ---------------------------------------------------------------- data
say "Catalogue and pincode data"
SETS="$(sqlite3 data/lego.db 'SELECT COUNT(*) FROM sets' 2>/dev/null || echo 0)"
if [[ "${SETS:-0}" -lt 1000 ]]; then
  npx tsx src/cli.ts catalog
else
  ok "LEGO catalogue already imported ($SETS sets)"
fi
GEO="$(sqlite3 data/lego.db 'SELECT COUNT(*) FROM geo_pincodes' 2>/dev/null || echo 0)"
if [[ "${GEO:-0}" -lt 10000 ]]; then
  npx tsx src/cli.ts geo
else
  ok "pincode coordinates already imported ($GEO pincodes)"
fi
if [[ -n "${PINCODES:-}" ]]; then
  # shellcheck disable=SC2086  # word splitting is intended: one argument per pincode
  npx tsx src/cli.ts pincode add $PINCODES
fi

# ---------------------------------------------------------------- build and start
say "Building"
npm run build
ok "done"

say "Starting with PM2"
PM2="$APP_DIR/node_modules/.bin/pm2"
"$PM2" startOrRestart ecosystem.config.cjs --update-env
"$PM2" save
# Start everything again after a reboot.
if ! systemctl list-unit-files 2>/dev/null | grep -q "^pm2-$USER.service"; then
  sudo env PATH="$PATH" "$PM2" startup systemd -u "$USER" --hp "$HOME" >/dev/null
fi
sudo systemctl enable "pm2-$USER" >/dev/null 2>&1 || true
ok "running, and enabled on boot (systemd unit pm2-$USER)"

# Logs rotate daily, keeping a week, so they can not fill the disk.
sudo tee /etc/logrotate.d/lego-tracker >/dev/null <<EOF
$APP_DIR/logs/*.log {
  daily
  rotate 7
  compress
  missingok
  notifempty
  copytruncate
}
EOF

# ---------------------------------------------------------------- Cloudflare Tunnel
say "Publishing the site"
if [[ -n "${CF_TUNNEL_TOKEN:-}" ]] && ! command -v cloudflared >/dev/null; then
  sudo mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq cloudflared >/dev/null
fi

if [[ -n "${SITE_HOST:-}" ]]; then
  # No Cloudflare account needed: Caddy takes ports 80/443, gets a free Let's Encrypt certificate for
  # SITE_HOST by itself, and forwards to the website on 127.0.0.1:3000. It stamps the visitor's real IP
  # into CF-Connecting-IP (replacing anything the visitor sent) so the API's per-visitor rate limits work.
  # The security group must allow inbound 80 and 443.
  if ! command -v caddy >/dev/null; then
    sudo apt-get install -y -qq caddy >/dev/null
  fi
  sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$SITE_HOST {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000 {
    header_up CF-Connecting-IP {remote_host}
  }
}
EOF
  sudo systemctl enable caddy >/dev/null 2>&1 || true
  sudo systemctl restart caddy
  ok "Caddy serving https://$SITE_HOST (certificate is issued on the first visit, can take a minute)"
  grep -q '^TRUST_CLOUDFLARE=1' .env || { echo 'TRUST_CLOUDFLARE=1' >> .env; "$PM2" restart lego-api --update-env >/dev/null; }
elif [[ -n "${CF_TUNNEL_TOKEN:-}" ]]; then
  ok "$(cloudflared --version | head -1)"
  if systemctl is-active --quiet cloudflared; then
    ok "tunnel service already running"
  else
    sudo cloudflared service install "$CF_TUNNEL_TOKEN"
    ok "tunnel service installed and started"
  fi
  grep -q '^TRUST_CLOUDFLARE=1' .env || { echo 'TRUST_CLOUDFLARE=1' >> .env; "$PM2" restart lego-api --update-env >/dev/null; }
else
  warn "Neither SITE_HOST nor CF_TUNNEL_TOKEN given, so the site is only reachable on this server (127.0.0.1:3000)."
  warn "To publish it with no account: allow inbound 80 and 443 in the security group, then run:"
  warn "  SITE_HOST=<server-ip-with-dashes>.sslip.io bash deploy/setup.sh     (or your own domain)"
  warn "Or with Cloudflare Tunnel:  CF_TUNNEL_TOKEN=<token> bash deploy/setup.sh"
fi

# ---------------------------------------------------------------- health check
say "Health check"
sleep 6
api="$(curl -fsS -m 10 http://127.0.0.1:4100/health 2>/dev/null || true)"
web="$(curl -fsS -m 20 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ 2>/dev/null || true)"
[[ "$api" == *'"ok":true'* ]] && ok "API ok" || warn "API not answering: check  $PM2 logs lego-api"
[[ "$web" == "200" ]] && ok "website ok" || warn "website not answering (got '$web'): check  $PM2 logs lego-web"
"$PM2" status

cat <<EOF

Done.
  Status / logs:     npx pm2 status   |   npx pm2 logs
  Update the code:   git pull && npm ci && npm ci --prefix web && npm run live
  Check every store from this server:
                     npx tsx src/cli.ts scrape --pincode <pincode>
EOF
