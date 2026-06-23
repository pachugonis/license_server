# ExchangeKit License Server

Сервер лицензий ExchangeKit: валидация лицензий, привязка к домену и **раздача
подписанных релизов** клиентским установкам. Разворачивается на **вашем** сервере
(не у клиента). Хранилище — JSON-файл `license-database.json`.

Установщик клиента ([../INSTALL/install.sh](../INSTALL/install.sh)) активирует
лицензию на этом сервере и скачивает отсюда подписанный артефакт релиза; кнопка
«Обновить» в админке клиента так же берёт обновления отсюда.

## Содержание

- [Быстрый старт](#быстрый-старт)
- [Развёртывание на VPS (systemd)](#развёртывание-на-vps-systemd)
- [Публикация релизов](#публикация-релизов)
- [API](#api)
- [Типы лицензий](#типы-лицензий)
- [Безопасность и резервные копии](#безопасность-и-резервные-копии)

## Быстрый старт

```bash
npm install
cp .env.example .env      # заполните секреты
npm start                 # сервер на http://localhost:3001
curl http://localhost:3001/api/health
```

## Веб-админка

Веб-интерфейс управления лицензиями доступен по адресу **`/admin`**
(например, `http://localhost:3001/admin`). Вход по логину и паролю из `.env`
(`ADMIN_USERNAME`, `ADMIN_PASSWORD`).

Возможности:

- генерация новых ключей (Professional, бессрочно, 1 домен) одной кнопкой;
- список всех лицензий с поиском по ключу, e-mail и домену;
- статусы (активна / приостановлена / отозвана) и их смена прямо из таблицы;
- просмотр привязанных доменов и числа проверок.

Интерфейс — статичная страница (`public/admin/index.html`), без сборки и
дополнительных зависимостей. После входа выдаётся admin-токен (JWT, 12 ч),
который хранится в браузере. В продакшене закрывайте `/admin` через HTTPS.

## Развёртывание на VPS (systemd)

Требования: Node.js >= 18, Ubuntu 22.04+/24.04, 512 МБ RAM. Деплой через systemd
(pm2 больше не используется).

**Проще всего — автоустановщик на домен** (ставит Node/nginx/certbot, systemd-сервис
и reverse-proxy c HTTPS одной командой):

```bash
sudo bash LICENSE/install-license-server.sh
```

Подробности — [DEPLOY.md](./DEPLOY.md). Ниже — ручная установка по шагам.

```bash
# 1. Пользователь и каталоги
sudo useradd --system --create-home --shell /usr/sbin/nologin license
sudo mkdir -p /opt/license-server/releases

# 2. Файлы сервера (без node_modules)
sudo rsync -a --exclude node_modules LICENSE/ /opt/license-server/
cd /opt/license-server
sudo -u license npm ci --omit=dev

# 3. Конфигурация
sudo -u license cp .env.example .env
sudo -u license nano .env        # LICENSE_JWT_SECRET, ADMIN_PASSWORD, RELEASES_DIR

# 4. systemd-сервис
sudo cp exchangekit-license.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now exchangekit-license

# 5. Проверка
curl http://127.0.0.1:3001/api/health
```

Генерация секретов: `openssl rand -base64 32` (JWT), `openssl rand -base64 24` (пароль).

### Nginx + HTTPS (рекомендуется)

Поставьте сервер за nginx с TLS (Let's Encrypt), как и основное приложение:

```nginx
server {
    listen 80;
    server_name license.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/license-server /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl restart nginx
sudo certbot --nginx -d license.yourdomain.com
sudo ufw allow 'Nginx Full'
```

Логи сервиса: `journalctl -u exchangekit-license -f`.

## Публикация релизов

Артефакты собирает и подписывает [../INSTALL/release.sh](../INSTALL/release.sh)
(на машине сборки), сервер только их раздаёт из `RELEASES_DIR`.

```bash
# один раз — пара ключей подписи (приватный НЕ коммитить и НЕ передавать)
INSTALL/release.sh keygen
# публичный ключ нужно вставить в INSTALL/install.sh и INSTALL/update.sh

# собрать релиз и залить на лиц-сервер
RELEASE_SSH_TARGET=license@HOST:/opt/license-server/releases \
  INSTALL/release.sh 1.0.0 stable
```

В `RELEASES_DIR` оказываются `exchangekit-<version>.tar.gz` и `releases.json`
(манифест каналов). Сервер читает манифест на каждый запрос — рестарт не нужен.

## API

| Метод | Путь | Назначение |
|-------|------|------------|
| GET  | `/api/health` | статус, число лицензий |
| POST | `/api/admin/login` | вход в веб-админку (`username`, `password`) → admin-токен |
| GET  | `/api/admin/licenses` | список лицензий (admin-токен или `X-Admin-Password`) |
| POST | `/api/admin/licenses` | создать лицензию (admin-токен или `X-Admin-Password`) |
| PATCH | `/api/admin/licenses/:id/status` | сменить статус: `active`/`suspended`/`revoked` |
| POST | `/api/license/activate` | активация + привязка домена, выдаёт JWT |
| POST | `/api/license/validate` | проверка лицензии и домена |
| POST | `/api/license/heartbeat` | продление «живости» (Bearer-токен) |
| GET  | `/api/license/status` | статус лицензии (Bearer + `X-License-Key`) |
| POST | `/api/license/unbind-domain` | отвязать домен (только Professional) |
| GET  | `/api/release/latest` | метаданные релиза: `licenseKey`, `domain`, `channel` |
| GET  | `/api/release/download/:version` | скачать подписанный архив (гейт по лицензии) |

Эндпоинты релизов проверяют лицензию так же, как `validate`: активна, не истекла,
домен привязан. Иначе — 403/404.

**Создать лицензию:**
```bash
curl -X POST https://license.yourdomain.com/api/admin/licenses \
  -H "Content-Type: application/json" \
  -H "X-Admin-Password: <ADMIN_PASSWORD>"
```
Тело запроса не нужно — генерируется только ключ. Почта и домен **не**
указываются при создании: они привязываются к лицензии при активации, когда
клиент вводит их во время установки на своём сервере. Сохраните `licenseKey`
из ответа — его получает клиент после оплаты.

**Метаданные последнего релиза:**
```bash
curl "https://license.yourdomain.com/api/release/latest?licenseKey=LIC-...&domain=exchange.example.com&channel=stable"
```

## Лицензия

Один тип лицензии — **Professional**.

| | Professional |
|--|--------------|
| Срок | бессрочно |
| Домены | 1 (со сменой) |
| Смена домена | ✅ (`/api/license/unbind-domain`) |
| Функции | полный функционал + брендинг + приоритетная поддержка |

Почта и домен привязываются к ключу при первой активации (вводятся клиентом
при установке). Повторная активация требует тот же e-mail; домен можно сменить
через отвязку.

## Безопасность и резервные копии

- Смените `LICENSE_JWT_SECRET` и `ADMIN_PASSWORD` в `.env`; держите за HTTPS.
- `.env` и приватный ключ подписи (`release-keys/`) не коммитить.
- Бэкап БД: `cp license-database.json backups/license-$(date +%F).json` (по cron).
- Журналы валидаций и скачиваний пишутся в `license-database.json`
  (`validationLogs`, `downloadLogs`).

### Просмотр БД
```bash
jq '.licenses | length' license-database.json
jq '.licenses[] | select(.status=="active")' license-database.json
```

---

Проприетарное ПО. © ExchangeKit. Версия сервера: 2.0.0.
