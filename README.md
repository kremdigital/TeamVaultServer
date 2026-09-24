# Team Vault — server

Серверная часть [Team Vault](https://github.com/kremdigital/TeamVaultPlugin) —
самохостящегося решения для синхронизации Obsidian-хранилищ между устройствами
с поддержкой совместной работы, истории изменений и live-режима.

- Плагин для Obsidian: <https://github.com/kremdigital/TeamVaultPlugin>
- Сервер (этот репозиторий): <https://github.com/kremdigital/TeamVaultServer>

Лицензия: **MIT**.

## Содержание

- [Что внутри](#что-внутри)
- [Быстрая установка на VPS](#быстрая-установка-на-vps)
- [Ручная установка](#ручная-установка)
- [Переменные окружения](#переменные-окружения)
- [Управление в продакшене](#управление-в-продакшене)
- [Разработка](#разработка)
- [Тесты](#тесты)
- [Документация](#документация)
- [Troubleshooting](#troubleshooting)

## Что внутри

- **Web** — Next.js 16 (App Router, RSC) на порту 3000: REST API, веб-админка
  для пользователей и SUPERADMIN, страницы регистрации/входа.
- **Socket** — отдельный Node.js-процесс на порту 3001: Socket.IO + Yjs CRDT
  для realtime-синхронизации и совместного редактирования.
- **PostgreSQL 16 + Prisma** — пользователи, проекты, файлы, операции, Yjs-state.
- **Caddy** — reverse-proxy с автоматическим Let's Encrypt; маршрутизирует
  `/socket.io/*` на порт 3001, всё остальное — на 3000.
- **PM2** — process manager под systemd для автостарта и graceful reload.
- **pino** + **pino-roll** — структурированные JSON-логи с ежедневной
  ротацией (`web.log`, `socket.log`, `audit.log`, `audit-socket.log`).

## Быстрая установка на VPS

Поддерживаются Ubuntu 22.04+ и Debian 12+.

```bash
git clone <repo-url> /tmp/team-vault
sudo bash /tmp/team-vault/scripts/install.sh
```

Скрипт **идемпотентен** — повторный запуск безопасно обновляет конфигурацию и
сохраняет уже сгенерированные секреты. Он:

1. ставит Node.js 20 LTS (NodeSource), pnpm, PostgreSQL 16 (PGDG), Caddy;
2. создаёт системного пользователя `team-vault` и директории
   `/opt/team-vault` (код), `/var/log/team-vault` (логи),
   `/var/lib/team-vault` (хранилище файлов);
3. интерактивно спрашивает домен, email/пароль супер-админа, SMTP, флаг
   открытой регистрации;
4. генерирует `.env` с криптостойкими `JWT_SECRET` через `openssl rand`;
5. применяет миграции Prisma и запускает seed (создаёт супер-админа);
6. собирает приложение (`next build` + `tsup` для socket-процесса);
7. запускает обе службы под PM2 + systemd (`pm2 startup`);
8. подставляет домен в `Caddyfile` и перезагружает Caddy;
9. ставит **fail2ban-jail** `caddy-nextjs-action` — отсекает сканеры, долбящие
   Server Actions Next.js (шаблоны — `config/fail2ban/`);
10. заводит `/var/backups/team-vault` и **таймер очистки бэкапов**
    `team-vault-prune-backups.timer` (шаблоны — `config/systemd/`).

После установки откройте `https://<ваш-домен>` — Caddy автоматически выпустит
сертификат Let's Encrypt.

### Защита от сканеров и хранение бэкапов

**fail2ban.** Jail `caddy-nextjs-action` читает JSON-лог Caddy и банит адреса,
которые шлют заголовок `Next-Action` с мусорным идентификатором (`x`, `1`,
`test`). Настоящий id — hex-хеш из 40+ символов, поэтому живые клиенты под
правило не попадают, в том числе со страниц от прошлого деплоя. Бан на 1 час
после 5 попыток за 10 минут и **только по портам 80/443** — SSH этим jail'ом
заблокировать нельзя.

```bash
sudo fail2ban-client status caddy-nextjs-action
```

**Бэкапы.** Разовые бэкапы перед рискованными операциями складывайте в
`/var/backups/team-vault` — таймер ежедневно удаляет оттуда всё старше 30 суток
(и файлы, и опустевшие каталоги). Ретенция задаётся `Environment=RETENTION_DAYS`
в `/etc/systemd/system/team-vault-prune-backups.service`. Нужно хранить дольше —
держите вне этого каталога.

```bash
sudo team-vault-prune-backups --dry-run
```

### Неинтерактивная установка

```bash
sudo NON_INTERACTIVE=1 \
  DOMAIN=sync.example.com \
  ADMIN_EMAIL=admin@example.com \
  ADMIN_PASSWORD='strong-password' \
  bash scripts/install.sh
```

### Обновление

```bash
sudo bash /opt/team-vault/scripts/upgrade.sh
```

`upgrade.sh` делает `git pull --ff-only`, обновляет зависимости, применяет
миграции, пересобирает приложение и делает `pm2 reload --update-env`
(zero-downtime).

`/etc/caddy/Caddyfile` он **не трогает**. Если в обновлении изменился
`config/Caddyfile.example` (там же живут заголовки безопасности: HSTS на год без
`preload`, запрет фрейминга, `nosniff`, `Referrer-Policy`, `Permissions-Policy`),
перегенерируйте Caddyfile сами, с теми же значениями, что при установке:

```bash
cd /opt/team-vault
sudo cp -a /etc/caddy/Caddyfile /var/backups/team-vault/Caddyfile.before-$(date +%F)
DOMAIN=sync.example.com EXTRA_DOMAINS='' PORT_WEB=3000 PORT_SOCKET=3001 \
  envsubst '${DOMAIN} ${EXTRA_DOMAINS} ${PORT_WEB} ${PORT_SOCKET}' \
  < config/Caddyfile.example > /tmp/Caddyfile.new
diff -u /etc/caddy/Caddyfile /tmp/Caddyfile.new    # только ожидаемые строки
sudo caddy validate --config /tmp/Caddyfile.new --adapter caddyfile
sudo cp /tmp/Caddyfile.new /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

### Удаление

```bash
sudo bash /opt/team-vault/scripts/uninstall.sh
# Полная очистка вместе с БД и хранилищем:
sudo bash /opt/team-vault/scripts/uninstall.sh --drop-db --drop-storage --yes
```

## Ручная установка

Если установочный скрипт не подходит вашему окружению.

```bash
# 1. Системные пакеты
sudo apt-get install -y nodejs pnpm postgresql-16 caddy

# 2. БД
sudo -u postgres createuser -P team_vault      # CREATEDB
sudo -u postgres createdb -O team_vault team_vault

# 3. Код + зависимости
git clone <repo-url> /opt/team-vault
cd /opt/team-vault
pnpm install --frozen-lockfile

# 4. Окружение — заполните по таблице ниже
cp .env.example .env

# 5. Миграции + seed
pnpm exec prisma generate
pnpm exec prisma migrate deploy
pnpm db:seed

# 6. Сборка
pnpm build           # запускает next build + tsup для socket-процесса

# 7. PM2
sudo npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd

# 8. Caddy — шаблон рендерится тем же envsubst, что и в install.sh
#    (пакет gettext-base). EXTRA_DOMAINS — зеркала с ведущей запятой, например
#    ', mirror.example.com'; без зеркал — пустая строка.
DOMAIN=sync.example.com EXTRA_DOMAINS='' PORT_WEB=3000 PORT_SOCKET=3001 \
  envsubst '${DOMAIN} ${EXTRA_DOMAINS} ${PORT_WEB} ${PORT_SOCKET}' \
  < config/Caddyfile.example | sudo tee /etc/caddy/Caddyfile > /dev/null
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

## Переменные окружения

Полный список — в [`.env.example`](./.env.example).

| Переменная           | Назначение                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | Строка подключения к PostgreSQL                                                           |
| `JWT_SECRET`         | Секрет для access-токенов (`openssl rand -base64 64`)                                     |
| `JWT_REFRESH_SECRET` | Отдельный секрет для refresh-токенов                                                      |
| `JWT_ACCESS_TTL`     | TTL access-токена (по умолчанию `15m`)                                                    |
| `JWT_REFRESH_TTL`    | TTL refresh-токена (по умолчанию `30d`)                                                   |
| `PORT_WEB`           | Порт Next.js (`3000`)                                                                     |
| `PORT_SOCKET`        | Порт Socket.IO (`3001`)                                                                   |
| `PUBLIC_URL`         | Внешний URL — используется в письмах и CORS                                               |
| `STORAGE_PATH`       | Путь к хранилищу файлов на диске                                                          |
| `OPEN_REGISTRATION`  | `true` — открытая регистрация; `false` — только по приглашениям                           |
| `SMTP_*`             | `HOST/PORT/USER/PASSWORD/FROM`. Без `SMTP_HOST` письма пишутся в `${LOG_DIR}/emails.log`. |
| `LOG_LEVEL`          | `debug` / `info` / `warn` / `error`                                                       |
| `LOG_DIR`            | Куда писать `web.log` / `socket.log` / `audit*.log`                                       |
| `ADMIN_EMAIL`        | Email супер-админа (создаётся при первом seed)                                            |
| `ADMIN_PASSWORD`     | Пароль супер-админа                                                                       |
| `MAX_FILE_SIZE`      | Лимит размера файла в байтах (пусто — без лимита)                                         |
| `TEAM_VAULT_PROCESS` | Выставляется PM2-ом: `web` или `socket` — управляет именами лог-файлов                    |

## Управление в продакшене

```bash
# Состояние
sudo -u team-vault pm2 status

# PM2 stdout/stderr (start-up + crashes)
sudo -u team-vault pm2 logs team-vault-web
sudo -u team-vault pm2 logs team-vault-socket

# Структурированные JSON-логи (pino)
tail -f /var/log/team-vault/web.log
tail -f /var/log/team-vault/socket.log
tail -f /var/log/team-vault/audit.log

# Перезагрузка без даунтайма (с применением новых ENV)
sudo -u team-vault pm2 reload ecosystem.config.cjs --update-env

# Caddy
sudo systemctl reload caddy
sudo journalctl -u caddy -f
```

## Разработка

```bash
git clone <repo-url> server
cd server

# 1. Зависимости
pnpm install

# 2. Локальный PostgreSQL (один раз)
createdb team_vault_dev
createdb team_vault_test

# 3. .env (для разработки достаточно скопировать пример)
cp .env.example .env

# 4. Миграции + seed
pnpm db:migrate
pnpm db:seed

# 5. Дев-сервер (web + socket в одном терминале)
pnpm dev
```

`pnpm dev` использует `concurrently` и поднимает оба процесса с цветными
префиксами `[web]` и `[socket]`.

### Скрипты

| Скрипт                               | Описание                                          |
| ------------------------------------ | ------------------------------------------------- |
| `pnpm dev`                           | Web + socket с hot-reload                         |
| `pnpm dev:web` / `pnpm dev:socket`   | По отдельности                                    |
| `pnpm build`                         | `next build` + tsup-сборка socket-процесса        |
| `pnpm start` / `pnpm stop`           | PM2 ecosystem                                     |
| `pnpm lint` / `pnpm lint:fix`        | ESLint                                            |
| `pnpm typecheck`                     | `tsc --noEmit`                                    |
| `pnpm format` / `pnpm format:check`  | Prettier                                          |
| `pnpm test` / `pnpm test:watch`      | Vitest unit                                       |
| `pnpm test:integration`              | Vitest integration (требует БД `team_vault_test`) |
| `pnpm test:all`                      | unit + integration                                |
| `pnpm test:e2e` / `pnpm test:e2e:ui` | Playwright e2e                                    |
| `pnpm db:migrate`                    | Создать новую миграцию (dev)                      |
| `pnpm db:migrate:deploy`             | Применить миграции (prod)                         |
| `pnpm db:seed`                       | Запуск `prisma/seed.ts`                           |
| `pnpm db:studio`                     | Prisma Studio                                     |
| `pnpm db:reset`                      | Полный сброс схемы (только для dev!)              |

## Тесты

- **Unit (Vitest)** — модули `lib/`, FS-helpers, Yjs-сходимость, Vector-clock.
  Не требуют сети/БД.
- **Integration (Vitest + реальный PostgreSQL)** — Prisma-схема, операции
  файлов, CRDT-persistence, Socket.IO end-to-end через `socket.io-client`.
  Требуется БД `team_vault_test` (создайте её один раз через `createdb`).
- **E2E (Playwright)** — поднимает `pnpm dev` (изолированно через
  `webServer.env.DATABASE_URL=…team_vault_test`) и тестирует flow через
  HTTP API и UI.

```bash
pnpm test:all                  # unit + integration
pnpm test:e2e                  # e2e через Playwright
```

## Документация

- [`docs/architecture.md`](./docs/architecture.md) — архитектура процессов,
  схема БД, поток данных.
- [`docs/api.md`](./docs/api.md) — REST API и Socket.IO события с примерами.
- [`docs/sync-protocol.md`](./docs/sync-protocol.md) — протокол синхронизации
  для разработчиков плагина.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — как отправлять PR.
- [`CHANGELOG.md`](./CHANGELOG.md) — история релизов.

## Troubleshooting

### Caddy не получает сертификат

Проверьте, что:

- DNS-запись `A` (или `AAAA`) указывает на ваш VPS;
- порты `80` и `443` открыты на firewall (`sudo ufw allow 80,443/tcp`);
- логи: `sudo journalctl -u caddy -n 200 | grep -i acme`.

Caddy кэширует сертификаты в `/var/lib/caddy/.local/share/caddy/certificates/`.

### PostgreSQL: connection refused

```bash
sudo systemctl status postgresql            # запущен ли
sudo -u postgres psql -c '\du'              # есть ли роль team_vault
cat /etc/postgresql/16/main/pg_hba.conf     # разрешён ли md5/scram
```

### SMTP не отправляет письма

Без `SMTP_HOST` сервер пишет письма в `${LOG_DIR}/emails.log` — это режим
разработки. Для продакшена выставьте полный набор `SMTP_*`.

### Сокет не подключается из плагина

1. Проверьте, что `wss://<домен>/socket.io/` отдаёт 101 Switching Protocols.
2. CORS: `PUBLIC_URL` в `.env` должен совпадать с реальным `https://<домен>`.
3. API-ключ: плагин должен передавать его в `socket.handshake.auth.apiKey`
   (формат `osync_<64hex>`).

### Логи

| Файл                                    | Что внутри                              |
| --------------------------------------- | --------------------------------------- |
| `${LOG_DIR}/web.log`                    | Next.js + REST API (JSON, pino)         |
| `${LOG_DIR}/socket.log`                 | Socket.IO события                       |
| `${LOG_DIR}/audit.log`                  | Аудит-события (SUPERADMIN actions, ...) |
| `${LOG_DIR}/audit-socket.log`           | Аудит из socket-процесса                |
| `${LOG_DIR}/pm2-web.{out,error}.log`    | stdout/stderr Next.js                   |
| `${LOG_DIR}/pm2-socket.{out,error}.log` | stdout/stderr socket-процесса           |
| `/var/log/caddy/access.log`             | Все HTTP-запросы (JSON)                 |

Все pino-файлы ротируются ежедневно или при 100 MB; хранится 14 последних.

## Лицензия

MIT — см. [LICENSE](./LICENSE).
