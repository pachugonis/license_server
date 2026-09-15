# License Server

Сервер лицензий для нескольких веб-приложений (продуктов): выдача ключей,
валидация лицензий, привязка к домену и **раздача подписанных релизов**
клиентским установкам. Один сервер обслуживает все продукты; продукты
подключаются в веб-админке. Разворачивается на **вашем** сервере (не у клиента).
Хранилище — JSON-файл `license-database.json`.

Клиентский установщик продукта активирует лицензию на этом сервере и скачивает
отсюда подписанный артефакт релиза; кнопка «Обновить» в админке клиента так же
берёт обновления отсюда.

## Содержание

- [Быстрый старт](#быстрый-старт)
- [Модель лицензии](#модель-лицензии)
- [Веб-админка](#веб-админка)
- [Подключение нового продукта](#подключение-нового-продукта)
- [Развёртывание на VPS (systemd)](#развёртывание-на-vps-systemd)
- [Публикация релизов](#публикация-релизов)
- [API](#api)
- [Безопасность и резервные копии](#безопасность-и-резервные-копии)

## Быстрый старт

```bash
npm install
cp .env.example .env      # заполните секреты
npm start                 # сервер на http://localhost:3001
open http://localhost:3001/admin
```

## Модель лицензии

Одна для всех продуктов: **пожизненная, на 1 домен**. Домен можно сменить через
отвязку (`/api/license/unbind-domain`). Почта и домен привязываются к ключу при
первой активации (вводятся клиентом при установке); повторная активация требует
тот же e-mail.

## Веб-админка

Доступна по адресу **`/admin`** (например, `http://localhost:3001/admin`). Вход по
логину и паролю из `.env` (`ADMIN_USERNAME`, `ADMIN_PASSWORD`).

**Вкладка «Лицензии»**

- генерация ключа с выбором продукта;
- список лицензий с колонкой «Продукт», фильтром по продукту и поиском по
  ключу, e-mail и домену; статистика считается по выбранному продукту;
- статусы (активна / приостановлена / отозвана) и их смена прямо из таблицы.

**Вкладка «Продукты»**

- подключение нового продукта, изменение названия и набора функций;
- удаление продукта, пока по нему не выпущено ни одного ключа.

Интерфейс — статичная страница (`public/admin/index.html`), без сборки и
дополнительных зависимостей. После входа выдаётся admin-токен (JWT, 12 ч),
который хранится в браузере. В продакшене закрывайте `/admin` через HTTPS.

## Подключение нового продукта

В админке: **Продукты → + Подключить продукт**.

| Поле | Значение |
|------|----------|
| Название | отображается в админке, например `Market` |
| Идентификатор (`productId`) | латиница, цифры, дефис, до 32 символов, например `market`. Подставляется из названия |
| Префикс ключа | необязателен: по умолчанию строится из идентификатора (`market` → `MARKET-`). Короткий задаётся вручную: `MK` → ключи `MK-1A2B-3C4D-5E6F-7A8B` |
| Функции | через запятую: `api, telegram, analytics`. Клиент получает их в `validate` и `status` как `{ "api": true, ... }` |

Префиксы уникальны: занятый префикс админка не даст сохранить.

**Идентификатор и префикс после подключения не меняются.** Идентификатор хранится
в лицензиях и токенах клиентов и задаёт каталог релизов. Название и функции можно
менять в любой момент; новый набор функций сразу действует для всех ключей продукта.

При подключении сервер создаёт каталог релизов `releases/<productId>/`. Дальше:

1. Сгенерируйте на машине сборки **отдельную** пару ключей подписи для продукта.
   Публичный ключ вшейте в установщик и апдейтер продукта.
2. В клиентской программе передавайте `productId` в `activate`, `validate` и
   эндпоинтах релизов.
3. Публикуйте релизы в `releases/<productId>/`.

Продукты хранятся в `license-database.json` (раздел `products`) и попадают в
тот же бэкап, что и лицензии.

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
# 1. Пользователь и каталоги
sudo useradd --system --create-home --shell /usr/sbin/nologin license
sudo mkdir -p /opt/license-server/releases

# 2. Файлы сервера (из этого репозитория, без node_modules)
sudo rsync -a --exclude node_modules ./ /opt/license-server/
cd /opt/license-server
sudo -u license npm ci --omit=dev

# 3. Конфигурация
sudo -u license cp .env.example .env
sudo -u license nano .env        # LICENSE_JWT_SECRET, ADMIN_PASSWORD, RELEASES_DIR
sudo chown -R license:license /opt/license-server

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
├── market/
│   ├── releases.json
│   └── market-1.0.0.tar.gz
└── <productId>/
    ├── releases.json
    └── ...
```

Формат `releases.json`:
`{ "stable": { "version", "file", "sha256", "signature", "size", "publishedAt" }, ... }`.

Манифест читается на каждый запрос — рестарт не нужен. Клиент получает релизы
только своего продукта: ключ одного продукта не даст скачать сборку другого.

### Ключи подписи — отдельная пара на продукт

Ключи подписи хранятся **только на машине сборки**, на сервере их нет. У каждого
продукта своя пара: утечка ключа одного продукта не позволит подписать сборку другого.

```
release-keys/<productId>/   # приватный + публичный ключ продукта
```

Приватный ключ не коммитить и не передавать. Публичный ключ продукта вшивается
в установщик и апдейтер **этого** продукта.

```bash
# собрать релиз и залить в подпапку продукта
RELEASE_SSH_TARGET=license@HOST:/opt/license-server/releases/<productId> \
  ./release.sh 1.0.0 stable
```

## API

| Метод | Путь | Назначение |
|-------|------|------------|
| GET  | `/api/health` | статус, список продуктов, число лицензий |
| POST | `/api/admin/login` | вход в веб-админку (`username`, `password`) → admin-токен |
| GET  | `/api/admin/products` | список продуктов |
| POST | `/api/admin/products` | подключить продукт: `{ "id", "name", "keyPrefix"?, "features"? }` |
| PATCH | `/api/admin/products/:id` | изменить `name` и/или `features` |
| DELETE | `/api/admin/products/:id` | удалить продукт без лицензий |
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

`features` при подключении и изменении продукта — массив имён (`["api", "kyc"]`)
или строка через запятую. Ошибки: `400 INVALID_PRODUCT`, `409 PRODUCT_EXISTS`,
`409 PREFIX_IN_USE`, `409 PRODUCT_IN_USE` (удаление продукта с лицензиями).

### Продукт в клиентских запросах

`productId` **обязателен**:

- `activate`, `validate` — поле `productId` в JSON-теле;
- `release/latest`, `release/download` — query-параметр `productId`;
- `heartbeat`, `status`, `unbind-domain` — продукт берётся из JWT-токена,
  выданного при активации. Токен действует только для той лицензии, на которую
  выдан: запрос с другим `licenseKey` отклоняется.

| Ситуация | Ответ |
|----------|-------|
| `productId` не передан | `400 PRODUCT_REQUIRED` |
| `productId` не подключён | `400 UNKNOWN_PRODUCT` |
| ключ принадлежит другому продукту (или токен выдан другому продукту) | `403 PRODUCT_MISMATCH` |
| токен выдан на другой ключ (`heartbeat`, `status`, `unbind-domain`) | `403 TOKEN_LICENSE_MISMATCH` |

Эндпоинты релизов проверяют лицензию так же, как `validate`: продукт совпадает,
лицензия активна, домен привязан. Иначе — 403/404.

Привязка доменов идёт по ID лицензии, поэтому на одном домене могут быть
лицензии разных продуктов.

**Подключить продукт:**
```bash
curl -X POST https://license.yourdomain.com/api/admin/products \
  -H "Content-Type: application/json" \
  -H "X-Admin-Password: <ADMIN_PASSWORD>" \
  -d '{"id":"market","name":"Market","keyPrefix":"MK","features":["catalog","payments"]}'
```

**Создать лицензию:**
```bash
curl -X POST https://license.yourdomain.com/api/admin/licenses \
  -H "Content-Type: application/json" \
  -H "X-Admin-Password: <ADMIN_PASSWORD>" \
  -d '{"productId":"market"}'
```
Почта и домен **не** указываются при создании. Сохраните `licenseKey` из
ответа — его получает клиент после оплаты.

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
- Бэкап БД (продукты и лицензии): `cp license-database.json backups/license-$(date +%F).json` (по cron).
- Журналы валидаций и скачиваний пишутся в `license-database.json`
  (`validationLogs`, `downloadLogs`, с полем `productId`).
- Если `license-database.json` не читается (повреждён), сервер не запустится.
  Так он не затрёт файл пустой базой.

### Просмотр БД
```bash
jq '.products[] | {id, name, keyPrefix}' license-database.json
jq '[.licenses[] | .productId] | group_by(.) | map({(.[0]): length}) | add' license-database.json
jq '.licenses[] | select(.productId=="market" and .status=="active")' license-database.json
```

---

Проприетарное ПО. Версия сервера: 3.0.0.
