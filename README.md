# ЭРФИС Портал — реестр объектов

Внутренний портал для сотрудников ЭРФИС: реестры товарных знаков и патентов,
контроль сроков продления, напоминания, журнал изменений, корзина.
Дальше — раздел CRM, договоры, документы.

## Технологии

- **Backend:** Node.js 22, без сторонних зависимостей (встроенные `node:sqlite`, `node:http`, `node:crypto`).
- **База:** SQLite (`/var/lib/erfis-portal/erfis.db`), режим WAL.
- **Frontend:** один статический файл `server/public/index.html` (ES-модули, без сборки).
- **Доступ снаружи:** Cloudflare Tunnel (в v1 — quick tunnel `*.trycloudflare.com`).
- **Хостинг:** VM в VK Cloud, systemd-сервисы `erfis-portal` и `erfis-cloudflared`.

## Установка на сервер

В VNC-консоли VM (под root):

```bash
curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/deploy/setup.sh | sudo bash
```

Скрипт ставит Node, cloudflared, разворачивает код в `/opt/erfis-portal`,
поднимает сервисы и печатает публичный адрес + `DEPLOY_KEY`.
Повторный запуск = обновление кода и перезапуск.

## Первичный импорт данных из Excel

`seed.json` (выгрузка из «РЕЕСТР ОБЪЕКТОВ ЭРФИС.xlsx») в репозиторий не входит.
Загрузка — с рабочей машины по HTTPS через туннель:

```bash
curl -X POST "$PORTAL_URL/api/admin/import" \
  -H "x-deploy-key: $DEPLOY_KEY" \
  -H "content-type: application/json" \
  --data-binary @seed.json
```

## Обновление

```bash
# на сервере
curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/deploy/setup.sh | sudo bash
# или удалённо, если знаем DEPLOY_KEY:
curl -X POST "$PORTAL_URL/api/admin/pull" -H "x-deploy-key: $DEPLOY_KEY"
```

## Учётные записи

При первом запуске создаются 4 сотрудника с временными паролями
(печатаются в лог и в `/var/lib/erfis-portal/initial-passwords.txt`).
При первом входе портал просит задать постоянный пароль.

| Сотрудник | E-mail |
|---|---|
| Илья Ишинов | ishinov@erfis.ru |
| Екатерина Коновалова | konovalova@erfis.ru |
| Сергей Милюков | milykov@erfis.ru |
| Дмитрий Петров | petrov@erfis.ru |

## Локальный запуск

```bash
cd server
INSECURE_COOKIES=1 PORT=8099 node server.js
# http://localhost:8099
```

## Планы (v2)

- Постоянный домен `portal.erfis.ru` + именованный Cloudflare-туннель вместо quick tunnel.
- Вход через корпоративный VK WorkSpace (OAuth).
- E-mail-уведомления ответственному о сроках продления.
- Ссылки на PDF свидетельств/патентов (облако).
- Ежедневная выгрузка `.xlsx` как резервная копия.
