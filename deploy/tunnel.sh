#!/usr/bin/env bash
# Постоянный туннель для портала (пока нет своего домена на Cloudflare).
# Ставит systemd-сервис erfis-tunnel через localhost.run (SSH reverse tunnel).
# Запуск на сервере (под root):  sudo bash /opt/erfis-portal/deploy/tunnel.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "нужен root"; exit 1; }

# отключаем неработающий quick-туннель cloudflared, если он был
systemctl disable --now erfis-cloudflared 2>/dev/null || true

install -d -m 700 -o erfis -g erfis /var/lib/erfis-portal/.ssh

cat > /etc/systemd/system/erfis-tunnel.service <<'EOF'
[Unit]
Description=ЭРФИС Портал — туннель (localhost.run)
After=network-online.target erfis-portal.service
Wants=network-online.target

[Service]
Type=simple
User=erfis
Group=erfis
ExecStartPre=/bin/sleep 3
ExecStart=/usr/bin/ssh -tt -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
  -R 80:localhost:8080 nokey@localhost.run
Restart=always
RestartSec=8
# при каждом старте вытащить свежий адрес в файл
ExecStartPost=/bin/bash -c 'for i in $(seq 1 30); do sleep 2; u=$(journalctl -u erfis-tunnel -n 40 --no-pager 2>/dev/null | grep -oE "https://[a-z0-9]+\\.lhr\\.life" | tail -1); if [ -n "$u" ]; then echo "$u" > /var/lib/erfis-portal/tunnel-url; break; fi; done'
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now erfis-tunnel
systemctl restart erfis-tunnel

echo "Ждём адрес…"
URL=""
for i in $(seq 1 40); do
  sleep 2
  URL="$(journalctl -u erfis-tunnel -n 60 --no-pager 2>/dev/null | grep -oE 'https://[a-z0-9]+\.lhr\.life' | tail -1 || true)"
  [ -n "$URL" ] && break
done
echo
echo "============================================================"
echo "  Адрес портала:  ${URL:-"(не определился — см. journalctl -u erfis-tunnel)"}"
echo "============================================================"
