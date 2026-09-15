# License Server

Сервер лицензий для нескольких веб-приложений (продуктов): выдача ключей,
валидация лицензий, привязка к домену и **раздача подписанных релизов**
клиентским установкам. Один сервер обслуживает все продукты из справочника
`products.json`. Разворачивается на **вашем** сервере (не у клиента).
Хранилище — JSON-файл `license-database.json`.

Клиентский установщик продукта активирует лицензию на этом сервере и скачивает
отсюда подписанный артефакт релиза; кнопка «Обновить» в админке клиента так же
берёт обновления отсюда.

## Содержание

- [Быстрый старт](#быстрый-старт)
- [Справочник продуктов](#справочник-продуктов)
- [Подключение нового продукта](#подключение-нового-продукта)
- [Веб-админка](#веб-админка)
- [Развёртывание на VPS (systemd)](#развёртывание-на-vps-systemd)
- [Публикация релизов](#публикация-релизов)
- [API](#api)
- [Безопасность и резервные копии](#безопасность-и-резервные-копии)

## Быстрый старт

```bash
npm install
cp .env.example .env      # заполните секреты
npm start                 # сервер на http://localhost:3001
curl http://localhost:3001/api/health
```

## Справочник продуктов

Продукты описываются в [products.json](./products.json) (путь можно переопределить
переменной `PRODUCTS_FILE`). Файл читается при старте; после правки —
`systemctl restart license-server`. Ошибка в справочнике не даёт серверу запуститься.

| Поле | Обязательно | По умолчанию | Значение |
|------|:-:|------|----------|
| `id` | ✅ | — | идентификатор: `a-z`, `0-9`, `-`. Его передаёт клиентская программа; менять после выдачи ключей нельзя |
| `name` | ✅ | — | название для админки |
| `features` | | `{}` | набор функций, отдаётся клиенту в `validate` и `status` |
| `keyPrefix` | | `ID-` из `id` | префикс ключа: `market` → `MARKET-1A2B-3C4D-5E6F-7A8B`. Короткий задаётся вручную: `"MK-"` |
| `maxDomains` | | `1` | сколько доменов можно привязать |
| `durationDays` | | `null` | срок в днях от первой активации; `null` — бессрочно |
| `canChangeDomain` | | `true` | разрешена ли отвязка домена |
| `licenseType` | | `professional` | тип лицензии |

Префиксы должны быть уникальны: если два продукта получают одинаковый префикс
(заданный или построенный из `id`), сервер не стартует и называет оба продукта.

Параметры продукта **копируются в лицензию при её создании**. Правка
справочника действует только на новые ключи — уже выданные лицензии не меняются.

## Подключение нового продукта

1. Добавьте запись в `products.json` — минимально:
   ```json
   { "id": "market", "name": "Market", "keyPrefix": "MK-", "features": { "catalog": true } }
   ```
   и перезапустите сервис (`systemctl restart license-server`).
2. Создайте каталог `releases/market/` (установщик при повторном запуске делает это сам).
3. Сгенерируйте на машине сборки **отдельную** пару ключей подписи. Публичный
   ключ вшейте в установщик и апдейтер продукта.
4. В клиентской программе передавайте `productId: "market"` в `activate`,
   `validate` и эндпоинтах релизов.
5. Публикуйте релизы в `releases/market/`.

После рестарта продукт появится в админке — ключи генерируются с выбором продукта.

## Веб-админка

Веб-интерфейс управления лицензиями доступен по адресу **`/admin`**
(например, `http://localhost:3001/admin`). Вход по логину и паролю из `.env`
(`ADMIN_USERNAME`, `ADMIN_PASSWORD`).

Возможности:

- генерация ключа с выбором продукта (функции, лимиты и срок — из справочника);
- список всех лицензий с колонкой «Продукт», фильтром по продукту и поиском по
  ключу, e-mail и домену; статистика считается по выбранному продукту;
- статусы (активна / приостановлена / отозвана) и их смена прямо из таблицы;
- просмотр привязанных доменов и числа проверок.

Интерфейс — статичная страница (`public/admin/index.html`), без сборки и
дополнительных зависимостей. После входа выдаётся admin-токен (JWT, 12 ч),
который хранится в браузере. В продакшене закрывайте `/admin` через HTTPS.

## Развёртывание на VPS (systemd)

Требования: Node.js >= 18, Ubuntu 22.04+/24.04, 512 МБ RAM. Сервис systemd
называется `license-server`.

**Проще всего — автоустановщик на домен** (ставит Node/nginx/certbot, systemd-сервис
и reverse-proxy c HTTPS одной командой):

```bash
sudo bash install-license-server.sh
```

Подробности — [DEPLOY.md](./DEPLOY.md). Ниже — ручная установка по шагам.

```bash
# 1. Пользователь и каталоги (подпапка релизов на каждый продукт)
sudo useradd --system --create-home --shell /usr/sbin/nologin license
sudo mkdir -p /opt/license-server/releases/{exchangekit,blackbit}

# 2. Файлы сервера (из этого репозитория, без node_modules)
sudo rsync -a --exclude node_modules ./ /opt/license-server/
cd /opt/license-server
sudo -u license npm ci --omit=dev

# 3. Конфигурация
sudo -u license cp .env.example .env
sudo -u license nano .env        # LICENSE_JWT_SECRET, ADMIN_PASSWORD, RELEASES_DIR

# 4. systemd-сервис
sudo cp license-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now license-server

# 5. Проверка
curl http://127.0.0.1:3001/api/health
```

Генерация секретов: `openssl rand -base64 32` (JWT), `openssl rand -base64 24` (пароль).

### Nginx + HTTPS (рекомендуется)

Поставьте сервер за nginx с TLS (Let's Encrypt):

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

Логи сервиса: `journalctl -u license-server -f`.

## Публикация релизов

Артефакты собирает и подписывает скрипт сборки каждого продукта на машине
сборки. Сервер только раздаёт их.

### Каталоги

У каждого продукта своя подпапка в `RELEASES_DIR` со своим манифестом:

```
releases/
├── exchangekit/
│   ├── releases.json
│   └── exchangekit-1.0.0.tar.gz
└── blackbit/
    ├── releases.json
    └── blackbit-1.0.0.tar.gz
```

Формат `releases.json`:
`{ "stable": { "version", "file", "sha256", "signature", "size", "publishedAt" }, ... }`.

Манифест читается на каждый запрос — рестарт не нужен. Клиент получает релизы
только своего продукта: ключ BlackBit не даст скачать сборку ExchangeKit.

### Ключи подписи — отдельная пара на продукт

Ключи подписи хранятся **только на машине сборки**, на сервере их нет. У каждого
продукта своя пара: утечка ключа одного продукта не позволит подписать сборку другого.

```
release-keys/exchangekit/   # приватный + публичный ключ ExchangeKit
release-keys/blackbit/      # приватный + публичный ключ BlackBit
```

Приватный ключ не коммитить и не передавать. Публичный ключ продукта вшивается
в установщик и апдейтер **этого** продукта.

```bash
# собрать релиз и залить в подпапку продукта
RELEASE_SSH_TARGET=license@HOST:/opt/license-server/releases/exchangekit \
  INSTALL/release.sh 1.0.0 stable
```

## API

| Метод | Путь | Назначение |
|-------|------|------------|
| GET  | `/api/health` | статус, список продуктов, число лицензий |
| POST | `/api/admin/login` | вход в веб-админку (`username`, `password`) → admin-токен |
| GET  | `/api/admin/products` | справочник продуктов |
| GET  | `/api/admin/licenses` | список лицензий, необязательный `?productId=` |
| POST | `/api/admin/licenses` | создать лицензию: `{ "productId": "market" }` |
| PATCH | `/api/admin/licenses/:id/status` | сменить статус: `active`/`suspended`/`revoked` |
| POST | `/api/license/activate` | активация + привязка домена, выдаёт JWT |
| POST | `/api/license/validate` | проверка лицензии и домена |
| POST | `/api/license/heartbeat` | продление «живости» (Bearer-токен) |
| GET  | `/api/license/status` | статус лицензии (Bearer + `X-License-Key`) |
| POST | `/api/license/unbind-domain` | отвязать домен (Bearer-токен) |
| GET  | `/api/release/latest` | метаданные релиза: `licenseKey`, `domain`, `productId`, `channel` |
| GET  | `/api/release/download/:version` | скачать подписанный архив (гейт по лицензии) |

Admin-эндпоинты принимают admin-токен или заголовок `X-Admin-Password`.

### Продукт в запросах

`productId` **обязателен**:

- `activate`, `validate`, `POST /api/admin/licenses` — поле `productId` в JSON-теле;
- `release/latest`, `release/download` — query-параметр `productId`;
- `heartbeat`, `status`, `unbind-domain` — продукт берётся из JWT-токена,
  выданного при активации. Токен действует только для той лицензии, на которую
  выдан: запрос с другим `licenseKey` отклоняется.

| Ситуация | Ответ |
|----------|-------|
| `productId` не передан | `400 PRODUCT_REQUIRED` |
| `productId` нет в справочнике | `400 UNKNOWN_PRODUCT` |
| ключ принадлежит другому продукту (или токен выдан другому продукту) | `403 PRODUCT_MISMATCH` |
| токен выдан на другой ключ (`heartbeat`, `status`, `unbind-domain`) | `403 TOKEN_LICENSE_MISMATCH` |

Эндпоинты релизов проверяют лицензию так же, как `validate`: продукт совпадает,
лицензия активна, не истекла, домен привязан. Иначе — 403/404.

Привязка доменов идёт по ID лицензии, поэтому на одном домене могут быть
лицензии разных продуктов.

**Создать лицензию:**
```bash
curl -X POST https://license.yourdomain.com/api/admin/licenses \
  -H "Content-Type: application/json" \
  -H "X-Admin-Password: <ADMIN_PASSWORD>" \
  -d '{"productId":"market"}'
```
Почта и домен **не** указываются при создании: они привязываются к лицензии
при активации, когда клиент вводит их во время установки на своём сервере.
Сохраните `licenseKey` из ответа — его получает клиент после оплаты.

**Активация (клиент):**
```bash
curl -X POST https://license.yourdomain.com/api/license/activate \
  -H "Content-Type: application/json" \
  -d '{"productId":"market","licenseKey":"MK-...","customerEmail":"client@example.com","domain":"shop.example.com","termsAgreed":true}'
```

**Метаданные последнего релиза:**
```bash
curl "https://license.yourdomain.com/api/release/latest?productId=market&licenseKey=MK-...&domain=shop.example.com&channel=stable"
```

## Безопасность и резервные копии

- Смените `LICENSE_JWT_SECRET` и `ADMIN_PASSWORD` в `.env`; держите за HTTPS.
- `.env` и приватные ключи подписи (`release-keys/`) не коммитить.
- Бэкап БД: `cp license-database.json backups/license-$(date +%F).json` (по cron).
- Журналы валидаций и скачиваний пишутся в `license-database.json`
  (`validationLogs`, `downloadLogs`, с полем `productId`).
- Если `license-database.json` не читается (повреждён), сервер не запустится.
  Так он не затрёт файл пустой базой.

### Просмотр БД
```bash
jq '.licenses | length' license-database.json
jq '[.licenses[] | .productId] | group_by(.) | map({(.[0]): length}) | add' license-database.json
jq '.licenses[] | select(.productId=="market" and .status=="active")' license-database.json
```

---

Проприетарное ПО. Версия сервера: 3.0.0.
