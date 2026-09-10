#!/usr/bin/env bash
# Собирает демо-версию портала: реальный фронтенд + мок API на localStorage.
# demo/index.html   — самостоятельная страница (можно открыть локально)
# demo/artifact.html — то же без внешней обёртки, для публикации как Artifact
set -euo pipefail
cd "$(dirname "$0")/.."

python3 - <<'PY'
logo = open('server/public/logo.js').read()
seed = open('server/data/seed.json').read()
price = open('server/data/price-seed.json').read()
mock = open('demo/mock.js').read()
html = open('server/public/index.html').read()

html = html.replace('<script src="/logo.js"></script>', f'<script>{logo}</script>')
html = html.replace('<script src="/qrcode.js"></script>',
                    '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>')
marker = '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>'
html = html.replace(marker, marker + f'\n<script>window.__SEED = {seed};\nwindow.__PRICE = {price};</script>\n<script>{mock}</script>\n', 1)
html = html.replace('<title>Реестр объектов ЭРФИС</title>', '<title>Портал ЭРФИС — демо</title>')
open('demo/index.html', 'w').write(html)

a = html
a = a.replace('<!doctype html>\n<html lang="ru">\n<head>\n', '', 1)
a = a.replace('<meta charset="utf-8" />\n', '', 1)
a = a.replace('<meta name="viewport" content="width=device-width, initial-scale=1" />\n', '', 1)
a = a.replace('</head>\n<body>\n', '', 1)
a = a.replace('\n</body>\n</html>\n', '\n', 1)
open('demo/artifact.html', 'w').write(a)
print('built demo/index.html and demo/artifact.html')
PY
