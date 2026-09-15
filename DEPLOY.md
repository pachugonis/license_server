# Быстрое развёртывание лицензионного сервера (systemd)

Разворачивается на **вашем** сервере; один сервер обслуживает все продукты,
которые подключаются в веб-админке. Полная документация — [README.md](./README.md).

## Автоматическая установка на домен (рекомендуется)

Один скрипт ставит Node.js, nginx, certbot, создаёт пользователя `license`,
копирует сервер в `/opt/license-server`, генерирует `.env` с секретами, поднимает
systemd-сервис `license-server` и nginx reverse-proxy на ваш домен с HTTPS.

```bash
# на VPS, из каталога с файлами этого репозитория
sudo bash install-license-server.sh
```

Скрипт спросит домен, логин/пароль администратора (пароль можно сгенерировать),
порт и e-mail для Let's Encrypt. Всё можно задать заранее через переменные
окружения:

```bash
sudo DOMAIN=license.example.com ENABLE_SSL=y LE_EMAIL=you@example.com \
  bash install-license-server.sh
```

После установки веб-админка доступна на `https://<домен>/admin`. Повторный запуск
безопасен — `.env` и `license-database.json` (продукты и лицензии) не перезаписываются.

## Ручная установка за несколько минут

```bash
# 1. Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Пользователь и каталоги
sudo useradd --system --create-home --shell /usr/sbin/nologin license
sudo mkdir -p /opt/license-server/releases

# 3. Файлы сервера (из этого репозитория, без node_modules)
sudo rsync -a --exclude node_modules ./ /opt/license-server/
cd /opt/license-server
sudo -u license npm ci --omit=dev

# 4. Конфигурация
sudo -u license cp .env.example .env
sudo -u license nano .env     # секреты + RELEASES_DIR
#   LICENSE_JWT_SECRET   → openssl rand -base64 32
#   ADMIN_PASSWORD       → openssl rand -base64 24
#   RELEASES_DIR=/opt/license-server/releases
sudo chown -R license:license /opt/license-server

# 5. systemd-сервис
sudo cp license-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now license-server

# 6. Проверка
curl http://127.0.0.1:3001/api/health
```

Дальше — поставьте за nginx с HTTPS и откройте `Nginx Full` в UFW (см. README).

## Первый продукт и первая лицензия

В админке: **Продукты → + Подключить продукт**, затем **+ Сгенерировать ключ**.
Лицензия на любой продукт — пожизненная, на 1 домен.

То же из консоли:

```bash
curl -X POST http://127.0.0.1:3001/api/admin/products \
  -H "Content-Type: application/json" \
  -H "X-Admin-Password: <ADMIN_PASSWORD>" \
  -d '{"id":"market","name":"Market","keyPrefix":"MK","features":["catalog"]}'

curl -X POST http://127.0.0.1:3001/api/admin/licenses \
  -H "Content-Type: application/json" \
  -H "X-Admin-Password: <ADMIN_PASSWORD>" \
  -d '{"productId":"market"}'
```

Почта и домен не указываются — клиент привязывает их сам при установке.
Сохраните `licenseKey` из ответа — его получает клиент после оплаты.

## Публикация релиза

У каждого продукта своя пара ключей подписи (только на машине сборки) и своя
подпапка релизов на сервере — сервер создаёт её при подключении продукта.

```bash
RELEASE_SSH_TARGET=license@HOST:/opt/license-server/releases/<productId> \
  ./release.sh 1.0.0 stable
```

## Полезные команды

```bash
journalctl -u license-server -f          # логи
systemctl restart license-server         # рестарт
systemctl status license-server          # статус
```

## Проблемы?

1. **Сервис не стартует** — `journalctl -u license-server -n 50`. Частая причина —
   повреждённый `license-database.json`.
2. **Порт занят** — смените `LICENSE_SERVER_PORT` в `.env`.
3. **Нет доступа** — `sudo ufw status`, проверьте проксирование nginx.
4. **Релиз не отдаётся** — проверьте `releases/<productId>/releases.json` и что
   клиент передаёт верный `productId`.
5. **`PRODUCT_REQUIRED` / `PRODUCT_MISMATCH`** — клиент не передал `productId`
   или ключ выпущен для другого продукта.
