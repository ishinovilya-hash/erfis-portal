#!/usr/bin/env bash
# Установка ЭРФИС Портала на чистый Ubuntu 22.04/24.04.
# В VNC-консоли VK Cloud, под root:
#   curl -fsSL https://raw.githubusercontent.com/ishinovilya-hash/erfis-portal/main/deploy/setup.sh | sudo bash
# Данные клиентов в репозиторий не входят — загружаются отдельно через POST /api/admin/import.
# Повторный запуск обновляет код и перезапускает сервис.
set -euo pipefail

REPO="${ERFIS_REPO:-https://github.com/ishinovilya-hash/erfis-portal.git}"
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
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all -q
  git -C "$APP_DIR" reset --hard "origin/$BRANCH" -q
  git -C "$APP_DIR" clean -fd -q -e server/data
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

say "systemd-сервисы"
apt-get install -y -qq openssh-client >/dev/null || true
install -d -m 700 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR/.ssh"
systemctl disable --now erfis-cloudflared 2>/dev/null || true
rm -f /etc/systemd/system/erfis-cloudflared.service

install -m 644 "$APP_DIR/deploy/erfis-portal.service" /etc/systemd/system/erfis-portal.service
cat > /etc/systemd/system/erfis-tunnel.service <<EOF
[Unit]
Description=ЭРФИС Портал — туннель (localhost.run)
After=network-online.target erfis-portal.service
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
Environment=HOME=$DATA_DIR
ExecStartPre=/bin/sleep 3
ExecStart=/usr/bin/ssh -tt -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R 80:localhost:8080 nokey@localhost.run
ExecStartPost=/bin/bash -c 'for i in \$(seq 1 40); do sleep 2; u=\$(journalctl -u erfis-tunnel -n 60 --no-pager 2>/dev/null | grep -oE "https://[a-z0-9]+\\\\.lhr\\\\.life" | tail -1); if [ -n "\$u" ]; then echo "\$u" > $DATA_DIR/tunnel-url; break; fi; done'
Restart=always
RestartSec=8
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now erfis-portal.service
systemctl restart erfis-portal.service
systemctl enable --now erfis-tunnel.service
systemctl restart erfis-tunnel.service

say "Ожидание туннеля"
URL=""
for i in $(seq 1 45); do
  sleep 2
  URL="$(journalctl -u erfis-tunnel -n 80 --no-pager 2>/dev/null | grep -oE 'https://[a-z0-9]+\.lhr\.life' | tail -1 || true)"
  [ -n "$URL" ] && break
done
[ -n "$URL" ] && { echo "$URL" > "$DATA_DIR/tunnel-url"; chown "$SVC_USER:$SVC_USER" "$DATA_DIR/tunnel-url"; }

DK="$(grep '^DEPLOY_KEY=' "$DATA_DIR/env" | cut -d= -f2)"
cat <<EOF

============================================================
  ЭРФИС Портал установлен.

  Публичный адрес:   ${URL:-"(не определился — sudo journalctl -u erfis-tunnel -n 40)"}
  DEPLOY_KEY:         $DK

  Адрес когда-нибудь понадобится обновить:  sudo cat $DATA_DIR/tunnel-url
  Статус:   systemctl status erfis-portal erfis-tunnel
============================================================
EOF
