# Быстрое развёртывание лицензионного сервера (systemd)

Разворачивается на **вашем** сервере. Полная документация — [README.md](./README.md).

## Автоматическая установка на домен (рекомендуется)

Один скрипт ставит Node.js, nginx, certbot, создаёт пользователя `license`,
копирует сервер в `/opt/license-server`, генерирует `.env` с секретами, поднимает
systemd-сервис и nginx reverse-proxy на ваш домен с HTTPS.

```bash
# на VPS, из корня репозитория (где лежит папка LICENSE)
sudo bash LICENSE/install-license-server.sh
```

Скрипт спросит домен, логин/пароль администратора (пароль можно сгенерировать),
порт и e-mail для Let's Encrypt. Всё можно задать заранее через переменные
окружения:

```bash
sudo DOMAIN=license.example.com ENABLE_SSL=y LE_EMAIL=you@example.com \
  bash LICENSE/install-license-server.sh
```

После установки веб-админка доступна на `https://<домен>/admin`. Повторный запуск
безопасен — `.env` и `license-database.json` не перезаписываются.

## Ручная установка за несколько минут

```bash
# 1. Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Пользователь и каталоги
sudo useradd --system --create-home --shell /usr/sbin/nologin license
sudo mkdir -p /opt/license-server/releases

# 3. Файлы сервера (с локальной машины, без node_modules)
sudo rsync -a --exclude node_modules LICENSE/ /opt/license-server/
cd /opt/license-server
sudo -u license npm ci --omit=dev

# 4. Конфигурация
sudo -u license cp .env.example .env
sudo -u license nano .env     # секреты + RELEASES_DIR
#   LICENSE_JWT_SECRET   → openssl rand -base64 32
#   ADMIN_PASSWORD       → openssl rand -base64 24
#   RELEASES_DIR=/opt/license-server/releases

# 5. systemd-сервис
sudo cp exchangekit-license.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now exchangekit-license

# 6. Проверка
curl http://127.0.0.1:3001/api/health
```

Дальше — поставьте за nginx с HTTPS и откройте `Nginx Full` в UFW (см. README).

## Создание первой лицензии

```bash
curl -X POST http://127.0.0.1:3001/api/admin/licenses \
  -H "Content-Type: application/json" \
  -H "X-Admin-Password: <ADMIN_PASSWORD>"
```

Генерируется только ключ — почта и домен не указываются. Клиент привязывает их
сам при установке (вводит e-mail и домен). Сохраните `licenseKey` из ответа —
его получает клиент после оплаты.

## Публикация релиза

```bash
# один раз: ключи подписи (публичный — в install.sh/update.sh)
INSTALL/release.sh keygen

# собрать и залить релиз
RELEASE_SSH_TARGET=license@HOST:/opt/license-server/releases \
  INSTALL/release.sh 1.0.0 stable
```

## Полезные команды

```bash
journalctl -u exchangekit-license -f          # логи
systemctl restart exchangekit-license          # рестарт
systemctl status exchangekit-license           # статус
```

## Проблемы?

1. **Порт занят** — измените `LICENSE_SERVER_PORT` в `.env`.
2. **Нет доступа** — `sudo ufw status`, проверьте проксирование nginx.
3. **Ошибки** — `journalctl -u exchangekit-license -n 50`.
4. **Релиз не отдаётся** — проверьте `RELEASES_DIR` и наличие `releases.json`.
