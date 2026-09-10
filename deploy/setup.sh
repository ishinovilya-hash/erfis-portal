#!/usr/bin/env bash
# Установка ЭРФИС Портала на чистый Ubuntu 22.04/24.04.
# Запуск (в VNC-консоли VK Cloud, под root):
#   curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/deploy/setup.sh | sudo bash
# Повторный запуск обновляет код и перезапускает сервис.
set -euo pipefail

REPO="${ERFIS_REPO:-__REPO_URL__}"
BRANCH="${ERFIS_BRANCH:-main}"
APP_DIR=/opt/erfis-portal
DATA_DIR=/var/lib/erfis-portal
SVC_USER=erfis

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Запустите под root (sudo bash)"; exit 1; }

say "Системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates >/dev/null

say "Node.js 22"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node --version

say "Пользователь $SVC_USER"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
usermod -aG systemd-journal "$SVC_USER" || true
mkdir -p "$DATA_DIR"

say "Код портала"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all -q
  git -C "$APP_DIR" reset --hard "origin/$BRANCH" -q
else
  git clone -q -b "$BRANCH" "$REPO" "$APP_DIR"
fi
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR" "$DATA_DIR"

say "Конфигурация"
if [ ! -f "$DATA_DIR/env" ]; then
  DK="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"
  cat > "$DATA_DIR/env" <<EOF
PORT=8080
ERFIS_DATA_DIR=$DATA_DIR
DEPLOY_KEY=$DK
EOF
  chown "$SVC_USER:$SVC_USER" "$DATA_DIR/env"
  chmod 600 "$DATA_DIR/env"
fi

say "cloudflared"
if ! command -v cloudflared >/dev/null 2>&1; then
  ARCH="$(dpkg --print-architecture)"
  curl -fsSL -o /usr/local/bin/cloudflared \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}"
  chmod +x /usr/local/bin/cloudflared
fi
cloudflared --version || true

say "systemd-сервисы"
install -m 644 "$APP_DIR/deploy/erfis-portal.service" /etc/systemd/system/erfis-portal.service
install -m 644 "$APP_DIR/deploy/cloudflared.service" /etc/systemd/system/erfis-cloudflared.service
systemctl daemon-reload
systemctl enable --now erfis-portal.service
systemctl restart erfis-portal.service
systemctl enable --now erfis-cloudflared.service
systemctl restart erfis-cloudflared.service

say "Ожидание туннеля"
URL=""
for i in $(seq 1 30); do
  sleep 2
  URL="$(journalctl -u erfis-cloudflared -n 100 --no-pager 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
  [ -n "$URL" ] && break
done
[ -n "$URL" ] && { echo "$URL" > "$DATA_DIR/tunnel-url"; chown "$SVC_USER:$SVC_USER" "$DATA_DIR/tunnel-url"; }

DK="$(grep '^DEPLOY_KEY=' "$DATA_DIR/env" | cut -d= -f2)"
cat <<EOF

============================================================
  ЭРФИС Портал установлен.

  Публичный адрес:   ${URL:-"(не определился — см. deploy/url.sh)"}
  DEPLOY_KEY:         $DK

  Статус:   systemctl status erfis-portal erfis-cloudflared
  Логи:     journalctl -u erfis-portal -f
============================================================
EOF
