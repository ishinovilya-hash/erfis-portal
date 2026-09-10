#!/usr/bin/env bash
# Показать текущий публичный адрес портала (quick tunnel).
journalctl -u erfis-cloudflared -n 200 --no-pager 2>/dev/null \
  | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1
