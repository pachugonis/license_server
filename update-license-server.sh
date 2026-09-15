#!/usr/bin/env bash

#############################################################################
# License Server — обновление уже установленного сервера.
#
# Только код: подтягивает репозиторий, копирует исходники в /opt/license-server,
# ставит зависимости (если изменился package-lock.json) и перезапускает сервис.
# nginx, SSL, UFW, .env и systemd-юнит не трогает.
#
# Запуск (из папки репозитория на VPS):
#   sudo bash update-license-server.sh
#
# Без git pull (файлы уже обновлены вручную):
#   sudo NO_PULL=1 bash update-license-server.sh
#############################################################################

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="/opt/license-server"
SERVICE_USER="license"
SERVICE_NAME="license-server"
BACKUP_DIR="/var/backups/license-server"
BACKUPS_KEEP=10

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info() { echo -e "${CYAN}➜${NC} $*"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
die()  { echo -e "${RED}✗ ОШИБКА:${NC} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Запускайте от root: sudo bash update-license-server.sh"
[[ -f "${SOURCE_DIR}/server.mjs" ]] || die "server.mjs не найден рядом со скриптом (${SOURCE_DIR})."
[[ -f "${APP_DIR}/server.mjs" ]] || die "Сервер не установлен в ${APP_DIR}. Сначала: sudo bash install-license-server.sh"

# 1. Свежий код. git запускаем от владельца репозитория: у root нет его
#    SSH-ключей, а на чужой каталог git ругается «dubious ownership».
if [[ -z "${NO_PULL:-}" && -d "${SOURCE_DIR}/.git" ]]; then
  repo_owner="$(stat -c %U "$SOURCE_DIR")"
  info "git pull (от пользователя ${repo_owner})…"
  sudo -u "$repo_owner" git -C "$SOURCE_DIR" pull --ff-only || die "git pull не удался."
  ok "Код обновлён: $(sudo -u "$repo_owner" git -C "$SOURCE_DIR" log --format='%h %s' -1)"
fi

# 2. Резервная копия базы перед обновлением.
if [[ -f "${APP_DIR}/license-database.json" ]]; then
  mkdir -p "$BACKUP_DIR"
  backup="${BACKUP_DIR}/license-database-$(date +%Y%m%d-%H%M%S).json"
  cp -p "${APP_DIR}/license-database.json" "$backup"
  ls -1t "${BACKUP_DIR}"/license-database-*.json | tail -n +$((BACKUPS_KEEP + 1)) | xargs -r rm -f
  ok "Копия базы: ${backup}"
fi

# 3. Исходники — те же исключения, что и в установщике: секреты, база и релизы остаются.
lock_before="$(sha256sum "${APP_DIR}/package-lock.json" 2>/dev/null | cut -d' ' -f1 || true)"
rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude .env \
  --exclude license-database.json \
  --exclude install-license-server.log \
  --exclude releases \
  "${SOURCE_DIR}/" "${APP_DIR}/"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "$APP_DIR"
ok "Файлы скопированы в ${APP_DIR}"

# 4. Зависимости — только если они изменились.
lock_after="$(sha256sum "${APP_DIR}/package-lock.json" 2>/dev/null | cut -d' ' -f1 || true)"
if [[ "$lock_before" != "$lock_after" || ! -d "${APP_DIR}/node_modules" ]]; then
  info "Зависимости изменились — npm ci…"
  sudo -u "$SERVICE_USER" sh -c "cd '$APP_DIR' && npm ci --omit=dev" >/dev/null 2>&1 \
    || die "npm ci завершился с ошибкой."
  ok "Зависимости установлены"
else
  ok "Зависимости без изменений"
fi

# 5. Перезапуск и проверка.
port="$(sed -n 's/^LICENSE_SERVER_PORT=//p' "${APP_DIR}/.env" 2>/dev/null | head -n1)"
port="${port:-3001}"
systemctl restart "$SERVICE_NAME"
for _ in $(seq 1 10); do
  curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1 \
  || die "Сервис не отвечает на /api/health. Логи: journalctl -u ${SERVICE_NAME} -n 50"
ok "Сервис ${SERVICE_NAME} перезапущен (порт ${port})"
