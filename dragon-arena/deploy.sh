#!/usr/bin/env bash
# Dragon Arena — one-command install for a Linux server with systemd (Ubuntu, Debian, Amazon Linux ...).
#   tar -xzf dragon-arena.tar.gz && cd dragon-arena && sudo bash deploy.sh
# Options (environment variables):
#   PORT=8080            port to listen on; PORT=auto picks 80 when it is free, otherwise 8080
#   ACCESS_KEY=secret    only people whose link contains ?key=secret can connect (optional)
#   APP_DIR=/opt/dragon-arena
set -euo pipefail
PORT="${PORT:-8080}"
ACCESS_KEY="${ACCESS_KEY:-}"
APP_DIR="${APP_DIR:-/opt/dragon-arena}"
SERVICE=dragon-arena
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
NODE_MAJOR_WANTED=22
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ "$(id -u)" = 0 ] || { echo "Please run as root:  sudo bash deploy.sh"; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "This script needs systemd. Without it, just run:  PORT=$PORT node server.js"; exit 1; }

port_busy() {
  if command -v ss >/dev/null 2>&1; then ss -ltnH | awk '{print $4}' | grep -Eq "[:.]$1\$"; return; fi
  if command -v netstat >/dev/null 2>&1; then netstat -ltn | awk '{print $4}' | grep -Eq "[:.]$1\$"; return; fi
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}
if [ "$PORT" = auto ]; then
  # Port 80 is open by default on most cloud firewalls (Lightsail included), so prefer it when nothing else uses it.
  if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then systemctl stop "$SERVICE"; fi
  if port_busy 80; then PORT=8080; else PORT=80; fi
fi
case "$PORT" in ''|*[!0-9]*) echo "PORT must be a number or 'auto'"; exit 1;; esac

# ---------------------------------------------------------------- Node.js 18+
# The service runs sandboxed (it cannot see /root or /home), so it needs a system-wide Node,
# not one that lives inside a home directory (nvm, fnm ...).
node_ok() { [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]; }
find_node() { for cand in /usr/bin/node /usr/local/bin/node; do if node_ok "$cand"; then echo "$cand"; return 0; fi; done; return 1; }

install_node_tarball() {
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "unsupported CPU $(uname -m) — install Node 18+ yourself and rerun"; return 1 ;;
  esac
  if [ -n "${NODE_TARBALL:-}" ] && [ -f "$NODE_TARBALL" ]; then
    echo "==> Installing Node.js from $NODE_TARBALL"
    tar -xzf "$NODE_TARBALL" -C /usr/local --strip-components=1 --no-same-owner
    return 0
  fi
  echo "==> Downloading the official Node.js $NODE_MAJOR_WANTED build for linux-$arch from nodejs.org"
  local base="https://nodejs.org/dist/latest-v$NODE_MAJOR_WANTED.x" name
  name="$(curl -fsSL --max-time 30 "$base/SHASUMS256.txt" | awk -v a="linux-$arch.tar.gz" 'index($2, a) { print $2; exit }' || true)"
  [ -n "$name" ] || { echo "could not reach nodejs.org"; return 1; }
  curl -fsSL --max-time 300 "$base/$name" -o "/tmp/$name" || { echo "download of $name failed"; return 1; }
  ( cd /tmp && curl -fsSL --max-time 30 "$base/SHASUMS256.txt" | grep " $name\$" | sha256sum -c - >/dev/null ) || { echo "checksum mismatch for $name"; return 1; }
  tar -xzf "/tmp/$name" -C /usr/local --strip-components=1 --no-same-owner
  rm -f "/tmp/$name"
}

NODE="$(find_node || true)"
if [ -z "$NODE" ] && command -v apt-get >/dev/null 2>&1; then
  # Only worth it where apt's nodejs is new enough (Ubuntu 24.04+, Debian 12+).
  cand="$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ {print $2}' | sed 's/^[0-9]*://' | cut -d. -f1 || true)"
  if [ "${cand:-0}" -ge 18 ] 2>/dev/null; then
    echo "==> Installing Node.js from apt"
    (apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs) || true
    NODE="$(find_node || true)"
  fi
fi
if [ -z "$NODE" ]; then install_node_tarball && NODE="$(find_node || true)"; fi
[ -n "$NODE" ] || { echo "!! Could not install Node.js 18+. Install it system-wide (/usr/bin or /usr/local/bin) and rerun."; exit 1; }
echo "==> Using $NODE ($($NODE --version))"

# ---------------------------------------------------------------- files
echo "==> Installing to $APP_DIR"
id -u dragonarena >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin dragonarena
mkdir -p "$APP_DIR"
if [ "$(cd "$APP_DIR" && pwd -P)" != "$(cd "$SRC" && pwd -P)" ]; then
  for item in server.js sim.js package.json README.md lib public maps; do
    rm -rf "${APP_DIR:?}/$item"
    cp -r "$SRC/$item" "$APP_DIR/"
  done
fi
chmod -R a+rX "$APP_DIR"
mkdir -p "$APP_DIR/replays"
chown -R dragonarena:dragonarena "$APP_DIR/replays"

LOW_PORT=""
if [ "$PORT" -lt 1024 ]; then LOW_PORT=$'AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE'; fi

cat > "$UNIT_DIR/$SERVICE.service" <<UNIT
[Unit]
Description=Dragon Arena (playable UNSW Battlecode)
After=network.target

[Service]
User=dragonarena
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=ACCESS_KEY=$ACCESS_KEY
ExecStart=$NODE $APP_DIR/server.js
Restart=always
RestartSec=2
# Sandbox: the game server can write its replay folder and nothing else, and cannot see /root or /home.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$APP_DIR/replays
$LOW_PORT

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"
sleep 2
if ! systemctl is-active --quiet "$SERVICE"; then
  echo "!! The service did not start. Last log lines:"; journalctl -u "$SERVICE" --no-pager -n 25; exit 1
fi
if ! curl -fsS --max-time 5 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && ! curl -g -fsS --max-time 5 "http://[::1]:$PORT/healthz" >/dev/null 2>&1; then
  echo "!! The service is running but does not answer on port $PORT. Last log lines:"; journalctl -u "$SERVICE" --no-pager -n 25; exit 1
fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow "$PORT/tcp" >/dev/null && echo "==> ufw: opened $PORT/tcp"; fi

# ---------------------------------------------------------------- what to tell people
PORT_SUFFIX=":$PORT"; [ "$PORT" = 80 ] && PORT_SUFFIX=""
KEY_SUFFIX=""; [ -n "$ACCESS_KEY" ] && KEY_SUFFIX="?key=$ACCESS_KEY"
IP4="$(curl -4 -fsS --max-time 4 https://api.ipify.org 2>/dev/null || true)"
IP6="$(curl -6 -fsS --max-time 4 https://api64.ipify.org 2>/dev/null || true)"
case "$IP6" in *:*) ;; *) IP6="$(ip -6 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -v '^f[cd]' | head -1 || true)";; esac
echo
echo "Dragon Arena is running on port $PORT."
[ -n "$IP4" ] && echo "  Play (IPv4): http://$IP4$PORT_SUFFIX/$KEY_SUFFIX"
[ -n "$IP6" ] && echo "  Play (IPv6): http://[$IP6]$PORT_SUFFIX/$KEY_SUFFIX"
[ -z "$IP4" ] && echo "  This machine has no public IPv4 address: only people whose network has IPv6 can connect (test: https://test-ipv6.com)."
echo "  Logs:    journalctl -u $SERVICE -f"
echo "  Restart: systemctl restart $SERVICE      Stop: systemctl disable --now $SERVICE"
echo
echo "If the page does not load from outside, open TCP port $PORT in your cloud firewall"
echo "(Lightsail: instance > Networking > IPv4 / IPv6 firewall; Alibaba Cloud: security group inbound rules)."
echo "ARENA_PORT=$PORT"
