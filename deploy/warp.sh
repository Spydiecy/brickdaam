#!/usr/bin/env bash
# Free fix for stores that block datacenter IPs (Flipkart redirects product pages from AWS).
# Sets up a local SOCKS5 proxy on 127.0.0.1:1080 that exits through Cloudflare WARP (free, no card),
# and points FLIPKART_PROXY at it. Only the browser contexts that ask for it use the proxy; the
# rest of the server (SSH, the website, the other stores) is not touched.
#
#   bash deploy/warp.sh
#
# Safe to run again. x86_64 and ARM Linux, Ubuntu or Amazon Linux.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$HOME/warp"
case "$(uname -m)" in
  x86_64) A=amd64 ;;
  aarch64 | arm64) A=arm64 ;;
  *) echo "unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac
mkdir -p "$DIR"
cd "$DIR"

if [[ ! -x wgcf ]]; then
  url="$(curl -fsSL https://api.github.com/repos/ViRb3/wgcf/releases/latest | grep -o "https://[^\"]*linux_$A" | head -1)"
  curl -fsSL -o wgcf "$url" && chmod +x wgcf
fi
if [[ ! -x wireproxy ]]; then
  url="$(curl -fsSL https://api.github.com/repos/windtf/wireproxy/releases/latest | grep -o "https://[^\"]*linux_$A.tar.gz" | head -1)"
  curl -fsSL -o wp.tgz "$url" && tar xzf wp.tgz wireproxy && chmod +x wireproxy && rm -f wp.tgz
fi
if [[ ! -f wgcf-profile.conf ]]; then
  ./wgcf register --accept-tos
  ./wgcf generate
fi
cat > wireproxy.conf <<EOF
WGConfig = $DIR/wgcf-profile.conf

[Socks5]
BindAddress = 127.0.0.1:1080
EOF

sudo tee /etc/systemd/system/warp-proxy.service >/dev/null <<EOF
[Unit]
Description=Local SOCKS5 proxy through Cloudflare WARP
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
ExecStart=$DIR/wireproxy -c $DIR/wireproxy.conf
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable warp-proxy >/dev/null 2>&1
sudo systemctl restart warp-proxy
sleep 3

echo "exit point:"
curl -s -m 15 --socks5-hostname 127.0.0.1:1080 https://www.cloudflare.com/cdn-cgi/trace | grep -E "^(loc|colo|warp)=" || {
  echo "the WARP proxy did not answer; check: sudo journalctl -u warp-proxy -n 20" >&2
  exit 1
}

cd "$APP_DIR"
touch .env
grep -q '^FLIPKART_PROXY=' .env || echo 'FLIPKART_PROXY=socks5://127.0.0.1:1080' >> .env
echo "FLIPKART_PROXY set in .env. Restart the worker to use it:  npx pm2 restart lego-worker --update-env"
