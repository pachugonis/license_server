#!/usr/bin/env bash

#############################################################################
# ExchangeKit License Server — установка на домен (VPS)
# Версия: 1.0.0
# Цель:   Ubuntu 22.04 / 24.04 LTS
#
# Что разворачивается:
#   - Node.js 20 LTS, nginx, certbot, ufw
#   - Лицензионный сервер (server.mjs) как systemd-сервис exchangekit-license
#   - nginx reverse-proxy домен → 127.0.0.1:PORT (веб-админка /admin + /api)
#   - HTTPS через Let's Encrypt (опционально)
#
# Запуск (из корня репозитория, где лежит папка LICENSE):
#   sudo bash LICENSE/install-license-server.sh
# или из самой папки:
#   sudo bash install-license-server.sh
#
# Скрипт копирует исходники сервера из своей папки в /opt/license-server.
# Повторный запуск безопасен: .env и license-database.json не перезаписываются.
#############################################################################

set -euo pipefail

# ---------------------------------------------------------------------------
# Константы
# ---------------------------------------------------------------------------
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="/opt/license-server"
RELEASES_DIR="${APP_DIR}/releases"
SERVICE_USER="license"
SERVICE_NAME="exchangekit-license"
NODE_MAJOR=20

INSTALL_LOG="${SOURCE_DIR}/install-license-server.log"

# Цвета
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

# ---------------------------------------------------------------------------
# Хелперы
# ---------------------------------------------------------------------------
log()   { echo -e "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "${INSTALL_LOG}"; }
info()  { echo -e "${CYAN}➜${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
phase() { echo -e "\n${BLUE}━━━ $* ━━━${NC}"; }
die()   { echo -e "${RED}✗ ОШИБКА:${NC} $*" >&2; log "ERROR: $*"; exit 1; }

require_root() {
  [[ $EUID -eq 0 ]] || die "Запускайте от root: sudo bash install-license-server.sh"
}

gen_secret() { openssl rand -base64 32; }
gen_pass()   { openssl rand -base64 24 | tr -d '/+=' | cut -c1-24; }

# ---------------------------------------------------------------------------
# Конфигурация (интерактивный ввод; можно задать переменными окружения)
# ---------------------------------------------------------------------------
DOMAIN="${DOMAIN:-}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
LICENSE_SERVER_PORT="${LICENSE_SERVER_PORT:-3001}"
LICENSE_JWT_SECRET="${LICENSE_JWT_SECRET:-}"
LE_EMAIL="${LE_EMAIL:-}"
ENABLE_SSL="${ENABLE_SSL:-}"

collect_config() {
  phase "Шаг 1/8 — Конфигурация"

  [[ -f "${SOURCE_DIR}/server.mjs" ]] || die "server.mjs не найден рядом со скриптом (${SOURCE_DIR})."

  if [[ -z "$DOMAIN" ]]; then
    read -rp "Домен лицензионного сервера (например license.example.com): " DOMAIN
  fi
  [[ -n "$DOMAIN" ]] || die "Домен обязателен."

  read -rp "Логин администратора веб-админки [${ADMIN_USERNAME}]: " _u
  [[ -n "${_u:-}" ]] && ADMIN_USERNAME="$_u"

  if [[ -z "$ADMIN_PASSWORD" ]]; then
    read -rp "Пароль администратора (Enter — сгенерировать): " ADMIN_PASSWORD
    [[ -n "$ADMIN_PASSWORD" ]] || { ADMIN_PASSWORD="$(gen_pass)"; info "Сгенерирован пароль администратора."; }
  fi

  read -rp "Порт сервера (внутренний) [${LICENSE_SERVER_PORT}]: " _p
  [[ -n "${_p:-}" ]] && LICENSE_SERVER_PORT="$_p"

  [[ -n "$LICENSE_JWT_SECRET" ]] || LICENSE_JWT_SECRET="$(gen_secret)"

  if [[ -z "$ENABLE_SSL" ]]; then
    read -rp "Включить HTTPS (Let's Encrypt)? [Y/n]: " _ssl
    case "${_ssl:-y}" in n*|N*) ENABLE_SSL="n";; *) ENABLE_SSL="y";; esac
  fi
  if [[ "$ENABLE_SSL" == y* && -z "$LE_EMAIL" ]]; then
    read -rp "E-mail для Let's Encrypt: " LE_EMAIL
    [[ "$LE_EMAIL" == *@*.* ]] || die "Некорректный e-mail для сертификата."
  fi

  ok "Домен: ${DOMAIN}, порт: ${LICENSE_SERVER_PORT}, HTTPS: ${ENABLE_SSL}"
}

# ---------------------------------------------------------------------------
# Системные пакеты и Node.js
# ---------------------------------------------------------------------------
install_packages() {
  phase "Шаг 2/8 — Системные пакеты"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg tar rsync ufw openssl nginx >/dev/null
  ok "Базовые пакеты установлены"

  if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt "$NODE_MAJOR" ]]; then
    info "Устанавливаю Node.js ${NODE_MAJOR} LTS…"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
  fi
  ok "Node.js $(node -v)"
}

# ---------------------------------------------------------------------------
# Пользователь, каталоги, исходники
# ---------------------------------------------------------------------------
deploy_files() {
  phase "Шаг 3/8 — Пользователь и файлы"

  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
    ok "Создан системный пользователь ${SERVICE_USER}"
  fi

  mkdir -p "$RELEASES_DIR"

  # Копируем исходники сервера, не трогая секреты и БД на повторном запуске.
  rsync -a --delete \
    --exclude node_modules \
    --exclude .env \
    --exclude license-database.json \
    --exclude install-license-server.log \
    --exclude releases \
    "${SOURCE_DIR}/" "${APP_DIR}/"
  ok "Файлы сервера скопированы в ${APP_DIR}"

  chown -R "${SERVICE_USER}:${SERVICE_USER}" "$APP_DIR"
}

install_deps() {
  phase "Шаг 4/8 — npm-зависимости"
  if [[ -f "${APP_DIR}/package-lock.json" ]]; then
    sudo -u "$SERVICE_USER" sh -c "cd '$APP_DIR' && npm ci --omit=dev" >/dev/null 2>&1 \
      || die "npm ci завершился с ошибкой (см. вывод npm)."
  else
    sudo -u "$SERVICE_USER" sh -c "cd '$APP_DIR' && npm install --omit=dev" >/dev/null 2>&1 \
      || die "npm install завершился с ошибкой."
  fi
  ok "Зависимости установлены"
}

# ---------------------------------------------------------------------------
# Конфигурация .env
# ---------------------------------------------------------------------------
write_env() {
  phase "Шаг 5/8 — Конфигурация (.env)"
  local env_file="${APP_DIR}/.env"

  if [[ -f "$env_file" ]]; then
    warn ".env уже существует — оставляю без изменений."
    # Подхватим действующий порт/учётки для финального резюме.
    LICENSE_SERVER_PORT="$(sed -n 's/^LICENSE_SERVER_PORT=//p' "$env_file" | head -n1 || echo "$LICENSE_SERVER_PORT")"
    ADMIN_USERNAME="$(sed -n 's/^ADMIN_USERNAME=//p' "$env_file" | head -n1 || echo "$ADMIN_USERNAME")"
    ADMIN_PASSWORD="$(sed -n 's/^ADMIN_PASSWORD=//p' "$env_file" | head -n1 || echo "$ADMIN_PASSWORD")"
    return 0
  fi

  cat > "$env_file" <<EOF
# Конфигурация лицензионного сервера ExchangeKit (создано установщиком)
LICENSE_SERVER_PORT=${LICENSE_SERVER_PORT}
LICENSE_JWT_SECRET=${LICENSE_JWT_SECRET}
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
RELEASES_DIR=${RELEASES_DIR}
EOF
  chown "${SERVICE_USER}:${SERVICE_USER}" "$env_file"
  chmod 600 "$env_file"
  ok "Создан ${env_file} (chmod 600)"
}

# ---------------------------------------------------------------------------
# systemd-сервис
# ---------------------------------------------------------------------------
setup_service() {
  phase "Шаг 6/8 — systemd-сервис"
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=ExchangeKit License Server
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.mjs
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
  systemctl restart "$SERVICE_NAME"

  # Подождём поднятия сервиса.
  local i
  for i in $(seq 1 10); do
    if curl -fsS "http://127.0.0.1:${LICENSE_SERVER_PORT}/api/health" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  curl -fsS "http://127.0.0.1:${LICENSE_SERVER_PORT}/api/health" >/dev/null 2>&1 \
    || die "Сервис не отвечает на /api/health. Логи: journalctl -u ${SERVICE_NAME} -n 50"
  ok "Сервис ${SERVICE_NAME} запущен (порт ${LICENSE_SERVER_PORT})"
}

# ---------------------------------------------------------------------------
# nginx + SSL + firewall
# ---------------------------------------------------------------------------
setup_nginx() {
  phase "Шаг 7/8 — nginx и брандмауэр"
  cat > "/etc/nginx/sites-available/${SERVICE_NAME}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    # Архивы релизов могут быть крупными — снимаем буферизацию и поднимаем таймауты
    client_max_body_size 5m;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    location = / {
        return 302 /admin/;
    }

    location / {
        proxy_pass http://127.0.0.1:${LICENSE_SERVER_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
EOF

  ln -sf "/etc/nginx/sites-available/${SERVICE_NAME}" "/etc/nginx/sites-enabled/${SERVICE_NAME}"
  rm -f /etc/nginx/sites-enabled/default
  nginx -t >/dev/null 2>&1 || die "Ошибка в конфигурации nginx (nginx -t)"
  systemctl enable nginx >/dev/null 2>&1
  systemctl restart nginx
  ok "nginx настроен (домен ${DOMAIN} → 127.0.0.1:${LICENSE_SERVER_PORT})"

  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 'Nginx Full' >/dev/null 2>&1 || true
  yes | ufw enable >/dev/null 2>&1 || true
  ok "UFW: разрешены SSH, HTTP, HTTPS"

  if [[ "$ENABLE_SSL" == y* ]]; then
    info "Получаю сертификат Let's Encrypt для ${DOMAIN}…"
    apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
    if certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${LE_EMAIL}" --redirect; then
      ok "HTTPS включён для ${DOMAIN}"
    else
      ENABLE_SSL="n"
      warn "Не удалось получить сертификат. Сервер работает по HTTP."
      warn "Повторить позже: certbot --nginx -d ${DOMAIN}"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Финал
# ---------------------------------------------------------------------------
summary() {
  phase "Шаг 8/8 — Готово"
  local scheme="http"; [[ "$ENABLE_SSL" == y* ]] && scheme="https"

  echo
  echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  Лицензионный сервер развёрнут${NC}"
  echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
  echo
  echo -e "  Веб-админка:  ${CYAN}${scheme}://${DOMAIN}/admin${NC}"
  echo -e "  Логин:        ${ADMIN_USERNAME}"
  echo -e "  Пароль:       ${ADMIN_PASSWORD}"
  echo -e "  API:          ${scheme}://${DOMAIN}/api/health"
  echo
  echo -e "  Создать лицензию из консоли:"
  echo -e "    ${CYAN}curl -X POST ${scheme}://${DOMAIN}/api/admin/licenses \\${NC}"
  echo -e "    ${CYAN}  -H 'X-Admin-Password: ${ADMIN_PASSWORD}'${NC}"
  echo
  echo -e "  Управление: ${CYAN}systemctl status ${SERVICE_NAME}${NC} · ${CYAN}journalctl -u ${SERVICE_NAME} -f${NC}"
  echo -e "  Каталог релизов: ${RELEASES_DIR}"
  [[ "$ENABLE_SSL" == y* ]] || echo -e "  ${YELLOW}HTTPS не включён. Рекомендуется: certbot --nginx -d ${DOMAIN}${NC}"
  echo
  warn "Сохраните пароль администратора — он также записан в ${APP_DIR}/.env"
}

# ---------------------------------------------------------------------------
main() {
  require_root
  : > "$INSTALL_LOG"
  log "Старт установки лицензионного сервера"
  collect_config
  install_packages
  deploy_files
  install_deps
  write_env
  setup_service
  setup_nginx
  summary
}

main "$@"
