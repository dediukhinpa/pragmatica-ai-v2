#!/usr/bin/env bash
# Патч G8z: ОДИН образ проекта app 1.1.6-pragmatika.3 и файл compose.project.yml (КРАСНАЯ ЗОНА:
# запускает только владелец на боевом хосте). Платформа остаётся 1.1.6, documents НЕ меняется и
# остаётся на 1.1.6-pragmatika.2. Новое в app: «ещё 10» поставщиков без повторов и пополнение
# базы поставщиков; обе функции за флагами SHORTLIST_PAGING_ENABLED и SUPPLIER_DISCOVERY_ENABLED
# (в compose.project.yml по умолчанию false). Сам патч флаги НЕ включает: включение - отдельный
# необязательный шаг runbook (enable-flags.sh). Ставится СТРОГО ПОСЛЕ патча G8y: lock боя
# 1.1.6-pragmatika.2, платформа 1.1.6, app и documents работают на образах из lock боя.
#
# Использование:
#   bash patch.sh [--preflight-only] [--signatures-verified ФАЙЛ] [--images-tar ФАЙЛ]
#                 [--config ФАЙЛ] [--out-dir КАТАЛОГ] [--soak-seconds N] [--expected-bots N]
#   bash patch.sh --rollback [--run-dir КАТАЛОГ]   откат применённого патча вручную
#   bash patch.sh --help
#
# Что делает (бой = compose-проект `pragmatika`, дерево /opt/pragmatika-v2/deploy; из файлов дерева
# заменяются ТОЛЬКО images.lock и compose.project.yml; остальные файлы compose, БД, миграции,
# alloy, nginx, mask, pseudonymizer, документы, тома и секреты патч НЕ трогает):
#   0. Предусловия, бой не меняется: целостность пакета (MANIFEST.sha256), подписи ВСЕХ образов
#      lock (cosign на хосте либо --signatures-verified: вывод verify-signatures.sh; по умолчанию
#      signatures.txt рядом с пакетом; молча пропускать нельзя), в пакете из файлов deploy/ ровно
#      compose.project.yml (любой другой файл и миграции - отказ), патч ещё не применён (lock боя
#      не равен lock пакета и версия не 1.1.6-pragmatika.3, иначе отказ: повторный запуск ничего
#      не меняет), патч G8y применён (BAI_VERSION lock боя 1.1.6-pragmatika.2, платформа боя
#      1.1.6, запущенные app и documents работают на образах из lock боя, в окружении documents
#      четыре флага G8x, в окружении app переменные поиска G8w; иначе отказ с подсказкой «сначала
#      примените патч G8y»), lock пакета (BAI_VERSION 1.1.6-pragmatika.3) отличается от боевого
#      ТОЛЬКО ключами BAI_VERSION и BAI_IMAGE_APP (образ documents в lock прежний), бой здоров
#      (/ready 200, ботов не меньше ожидаемого), свободны диск и память, образ app на хосте
#      (docker load или pull по digest), прежний (откатный) образ app на хосте есть. Примерка:
#      compose с новыми файлами и боевым .env собирается, у app обе новые переменные
#      (SHORTLIST_PAGING_ENABLED, SUPPLIER_DISCOVERY_ENABLED) имеют значение false, а вся прочая
#      конфигурация (app без образа и этих двух переменных, documents и остальные сервисы целиком)
#      совпадает со снимком боя до патча. Любое нарушение - код 3, бой не тронут. С
#      --preflight-only на этом всё.
#   1. Бэкап файлов дерева (весь каталог deploy, права сохраняются, .env 600) и снимок
#      контейнеров и образов: ~/backups/pragmatika-patch8z-<время>.
#   2. Замена compose.project.yml и images.lock, затем `up -d --no-deps app` (без down, без
#      --remove-orphans, без --force-recreate; documents не пересоздаётся; простой app около
#      30 с).
#   3. Проверки: образ app = lock (по digest); /ready app 200 и ботов не меньше ожидаемого; в
#      окружении app обе новые переменные на месте (значение false: патч флаги не включает) и
#      переменные поиска G8w не потерялись; documents не перезапускался, на образе из lock, четыре
#      флага G8x на месте, проба POST /docx/amend отвечает как образ G8y (в журнал идут только
#      статус и код ошибки); маршруты стека не 404/405 (tools/check-routes.sh); выдержка (по
#      умолчанию 2 минуты: documents и app не перезапускаются).
#   Любой сбой после начала изменений -> автоматический откат: compose.project.yml и images.lock
#   возвращаются из бэкапа, `up -d --no-deps app` на образ G8y, проверяется /ready.
# Результат: ~/patch8z-<время>.tgz (журнал, проверки; без секретов и данных) - вернуть
# разработчику.
#
# Коды выхода: 0 - патч применён и проверен; 1 - сбой, откат выполнен (бой как до патча); 2 -
# неверный вызов; 3 - отказ по предусловиям, бой не тронут; 4 - сбой, откат тоже не удался
# (ручное вмешательство: OWNER-RUNBOOK.md, журнал).
set -euo pipefail
umask 077

# ---------------------------------------------------------------------------------------------
# Константы
# ---------------------------------------------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HERE/lib.sh" ]]; then
  PKG="$HERE" # пакет: всё рядом
  LIB="$HERE/lib.sh"
  ROUTES_TOOLS_DIR="$HERE/tools"
  ROUTES_MANIFEST="$HERE/routes.tsv"
  PKG_DEPLOY="$HERE/deploy"
  LOCK_SRC="$HERE/images.lock"
else
  PKG="$(cd "$HERE/../.." && pwd)" # дерево проекта (стенды и тесты)
  LIB="$HERE/../cutover/lib.sh"
  ROUTES_TOOLS_DIR="$PKG/tools"
  ROUTES_MANIFEST="$PKG/deploy/cutover/routes.tsv"
  PKG_DEPLOY="${PATCH8Z_PKG_DEPLOY:-$PKG/deploy}" # каталог deploy пакета: файлы дерева патча
  LOCK_SRC="${PATCH8Z_LOCK:-$PKG/deploy/images.lock}"
fi
# shellcheck source=../cutover/lib.sh
source "$LIB"
COSIGN_PUB="${PATCH8Z_COSIGN_PUB:-$PKG/cosign.pub}"
[[ -f "$COSIGN_PUB" ]] || COSIGN_PUB="$PKG/deploy/cosign.pub"

# Файлы дерева, которые патч вправе заменить (пути относительно deploy/), кроме images.lock (он
# лежит в корне пакета). Чужой файл в пакете (в том числе deploy/images.lock) - отказ.
# ДОЛЖНО совпадать с DEPLOY_FILES в tools/build-patch-8z-package.sh.
PATCH_FILE_ALLOW=(compose.project.yml)
COMPOSE_PROJECT_FILE="compose.project.yml"
# Ключи lock, которые патч вправе менять: образ app и версия lock. Любой другой (documents и его
# основа, основа app BAI_IMAGE_APP_BASE, alloy, postgres, mask...) - отказ.
PATCH_LOCK_KEYS="BAI_VERSION BAI_IMAGE_APP"
LOCK_KEY_APP="BAI_IMAGE_APP"
LOCK_KEY_DOCUMENTS="BAI_IMAGE_DOCUMENTS"
LOCK_KEY_VERSION="BAI_VERSION"
DOCUMENTS_SERVICE="documents"
APP_SERVICE="app"
# Версия lock: боевая до патча (её ставит G8y) и целевая в пакете. Платформа не меняется.
LOCK_VERSION_FROM="1.1.6-pragmatika.2"
LOCK_VERSION_TO="1.1.6-pragmatika.3"
PLATFORM_VERSION_FILE="platform/PLATFORM-VERSION"
PLATFORM_VERSION_KEY="PLATFORM_PACKAGES_VERSION"
PLATFORM_NOW="1.1.6"
G8Y_HINT="сначала примените патч G8y (платформа ${PLATFORM_NOW}, lock ${LOCK_VERSION_FROM})"
# Новые переменные app от этого патча (в compose.project.yml по умолчанию false). Патч их не
# включает: значение false проверяется до и после замены. Включение - enable-flags.sh.
NEW_APP_FLAGS=(SHORTLIST_PAGING_ENABLED SUPPLIER_DISCOVERY_ENABLED)
FLAG_OFF_VALUE="false"
# Значение из окружения запуска сильнее .env и compose: сброс, чтобы флаги нельзя было включить в
# обход runbook (переменная, экспортированная в оболочке владельца).
unset "${NEW_APP_FLAGS[@]}"
# Переменные app от патча G8w: признак, что G8w применён (значения не меняются, при замене app
# не должны потеряться).
G8W_APP_KEYS=(YANDEX_SEARCH_MAX_CONCURRENCY YANDEX_SEARCH_MIN_INTERVAL_MS)
# Флаги documents от патча G8x (ИМЯ=значение): documents патчем не трогается, флаги остаются.
# Больше никакие переменные documents не читаются.
DOCS_FLAGS=(DOCUMENTS_EDIT_PPTX=true DOCUMENTS_EDIT_PDF=true DOCUMENTS_PPT_CONVERT=true
  DOCUMENTS_EDIT_PDF_FALLBACK_FONT=false)
# Адрес documents в окружении app (по нему идут и пробы), если ключ в окружении не найден.
DOCUMENTS_URL_KEY="DOCUMENTS_URL"
DOCUMENTS_URL_DEFAULT="http://documents:8310"
# Пробы documents: из одноразового контейнера в сети app (адрес берётся из PATCH_DOCS_URL).
# /health: 200.
DOCS_HEALTH_JS="try {
  const base = process.env.PATCH_DOCS_URL ?? '$DOCUMENTS_URL_DEFAULT';
  const r = await fetch(base + '/health');
  console.log(r.status + ' ' + (await r.text()));
  process.exit(r.ok ? 0 : 1);
} catch (e) { console.log('documents недоступен: ' + e.message); process.exit(1); }"
# Проба POST /docx/amend с параметрами G8y (party и number_edit с неверными значениями) и пустым
# файлом: ничего не правится. documents у G8z прежний (образ G8y): он отвечает 422 с
# detail.error=bad_request; проба подтверждает, что documents жив и остался на образе G8y.
# Ожидаемые статус и код ошибки сверяются с настоящим образом на стенде и при расхождении
# переопределяются окружением (PATCH8Z_AMEND_PROBE_STATUS,
# PATCH8Z_AMEND_PROBE_ERROR). В журнал идут ТОЛЬКО статус и код ошибки, тело ответа не печатается:
# код ошибки выводится лишь если он похож на идентификатор.
AMEND_ROUTE_PATH="/docx/amend"
AMEND_PROBE_BODY='{"file_name":"probe.docx","content_base64":"","party":"zz",'
AMEND_PROBE_BODY+='"number_edit":{"mode":"zz","text":"1"}}'
AMEND_PROBE_STATUS="${PATCH8Z_AMEND_PROBE_STATUS:-422}"
AMEND_PROBE_ERROR="${PATCH8Z_AMEND_PROBE_ERROR:-bad_request}"
AMEND_ERROR_MAX_LEN=64
AMEND_ERROR_RE="^[a-z][a-z0-9_]{0,$((AMEND_ERROR_MAX_LEN - 1))}\$"
AMEND_ROUTE_JS="try {
  const base = process.env.PATCH_DOCS_URL ?? '$DOCUMENTS_URL_DEFAULT';
  const r = await fetch(base + '$AMEND_ROUTE_PATH', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: process.env.PATCH_AMEND_BODY });
  let code = '-';
  try {
    const detail = (await r.json())?.detail;
    const raw = typeof detail === 'object' && detail !== null ? detail.error : undefined;
    if (typeof raw === 'string' && /$AMEND_ERROR_RE/.test(raw)) code = raw;
  } catch (e) { code = '-'; }
  console.log(r.status + ' ' + code);
} catch (e) { console.log('documents недоступен: ' + e.message); process.exit(1); }"
DEFAULT_SOAK_S=120
SOAK_POLL_S=${PATCH8Z_SOAK_POLL_S:-15}
DEPLOYED_MARK=".cutover-deployed"
BACKUP_PREFIX="pragmatika-patch8z"
ARCHIVE_PREFIX="patch8z"
RUN_PREFIX="patch-8z"
# Права .env в бэкапе должны совпасть с боевыми (600).
ENV_FILE_NAME=".env"
# Запасы: свободный диск под новый образ app (МиБ), доступная память (МиБ).
PATCH_MIN_DISK_MIB="${PATCH8Z_MIN_DISK_MIB:-4096}"
PATCH_MIN_AVAILABLE_MIB="${PATCH8Z_MIN_AVAILABLE_MIB:-1024}"
# Состояние для отката (state.env запуска): PATCH_STARTED, BACKUP_DIR, LIVE_DEPLOY, FILE_REPLACED.
ROLLBACK_MODE=0
RUN_DIR_ARG=""

# ---------------------------------------------------------------------------------------------
# Аргументы и настройка
# ---------------------------------------------------------------------------------------------
SIGNATURES_FILE=""
IMAGES_TAR=""
CONFIG_FILE=""
SOAK_S="$DEFAULT_SOAK_S"
PREFLIGHT_ONLY=0
EXPECT_BOTS_ARG=""
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
while (($#)); do
  case "$1" in
    --signatures-verified) SIGNATURES_FILE="${2:?--signatures-verified ФАЙЛ}"; shift ;;
    --images-tar) IMAGES_TAR="${2:?--images-tar ФАЙЛ}"; shift ;;
    --config) CONFIG_FILE="${2:?--config ФАЙЛ}"; shift ;;
    --out-dir) CUTOVER_OUT_DIR="${2:?--out-dir КАТАЛОГ}"; shift ;;
    --soak-seconds) SOAK_S="${2:?--soak-seconds N}"; shift ;;
    --expected-bots) EXPECT_BOTS_ARG="${2:?--expected-bots N}"; shift ;;
    --preflight-only) PREFLIGHT_ONLY=1 ;;
    --rollback) ROLLBACK_MODE=1 ;;
    --run-dir) RUN_DIR_ARG="${2:?--run-dir КАТАЛОГ}"; shift ;;
    --help | -h) usage; exit "$EXIT_OK" ;;
    *) echo "неизвестный аргумент: $1" >&2; usage >&2; exit "$EXIT_USAGE" ;;
  esac
  shift
done
[[ "$SOAK_S" =~ ^[0-9]+$ ]] || { echo "--soak-seconds: нужно число" >&2; exit "$EXIT_USAGE"; }
[[ -z "$EXPECT_BOTS_ARG" || "$EXPECT_BOTS_ARG" =~ ^[0-9]+$ ]] \
  || { echo "--expected-bots: нужно число" >&2; exit "$EXIT_USAGE"; }
if ((PREFLIGHT_ONLY && ROLLBACK_MODE)); then
  echo "--preflight-only и --rollback несовместимы" >&2
  exit "$EXIT_USAGE"
fi
[[ -n "$SIGNATURES_FILE" || ! -f "$HERE/signatures.txt" ]] || SIGNATURES_FILE="$HERE/signatures.txt"

[[ -z "$CONFIG_FILE" ]] || cut_load_config "$CONFIG_FILE" || exit "$EXIT_USAGE"
if ((ROLLBACK_MODE)); then
  # Откат вручную: настройка берётся из каталога запуска патча (patch.conf), если он есть.
  CUTOVER_HOME="${CUTOVER_HOME:-$HOME/.pragmatika-cutover}"
  RUN_DIR_ARG="${RUN_DIR_ARG:-$CUTOVER_HOME/$RUN_PREFIX-latest}"
  [[ -d "$RUN_DIR_ARG" ]] || { echo "нет каталога запуска: $RUN_DIR_ARG" >&2; exit "$EXIT_USAGE"; }
  [[ ! -f "$RUN_DIR_ARG/patch.conf" ]] || cut_load_config "$RUN_DIR_ARG/patch.conf"
fi
[[ -z "$EXPECT_BOTS_ARG" ]] || CUTOVER_EXPECT_BOTS="$EXPECT_BOTS_ARG"
cut_defaults

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$CUTOVER_HOME"
if ((ROLLBACK_MODE)); then
  RUN_DIR_ORIG="$(cd "$RUN_DIR_ARG" && pwd)"
  cut_init_run "$CUTOVER_HOME/$RUN_PREFIX-rollback-$RUN_ID"
else
  cut_init_run "$CUTOVER_HOME/$RUN_PREFIX-$RUN_ID"
  ln -sfn "$RUN_DIR" "$CUTOVER_HOME/$RUN_PREFIX-latest"
fi
ARCHIVE_PATH=""
ROLLED_BACK=0
LIVE_NEW_DIR="$CUTOVER_NEW_DIR"
LIVE_DEPLOY="$LIVE_NEW_DIR/deploy"
# Контейнер documents (имя берётся при проверке предусловий) и его StartedAt сразу после
# пересоздания (пересоздание app не должно его перезапускать).
DOCS_NAME=""
DOCS_STARTED_BEFORE=""

die() { # die <код> <сообщение...>: слова сообщения склеиваются пробелом
  local code="$1"
  shift
  log "ОШИБКА: $*"
  state_set RESULT "FAILED: $*"
  exit "$code"
}

# refuse <сообщение>: отказ по предусловиям, бой не тронут. После начала изменений - сбой
# хода (код 1): on_exit выполнит откат.
refuse() {
  check "предусловия" fail "$*"
  if [[ "$(state_get PATCH_STARTED)" == 1 ]]; then die "$EXIT_FAILED" "$*"; fi
  die "$EXIT_REFUSED" "отказ: $*"
}

# Настройка запуска для --rollback (без секретов: пути и числа).
save_config() {
  local name
  : >"$RUN_DIR/patch.conf"
  for name in $(compgen -v CUTOVER_); do
    [[ "$name" =~ ^CUTOVER_(ALERTS_URL|SECRETS_DIR)?$ ]] && continue
    printf '%s=%s\n' "$name" "${!name}" >>"$RUN_DIR/patch.conf"
  done
}

# ---------------------------------------------------------------------------------------------
# Итог и уборка (всегда, при любом выходе)
# ---------------------------------------------------------------------------------------------
# Значения секретов боя в список маскирования журнала: только значения, имена не нужны.
collect_secret_values() {
  local secrets_dir file
  secrets_dir="${CUTOVER_SECRETS_DIR:-$(env_value "$CUTOVER_ENV_FILE" SECRETS_DIR)}"
  secrets_dir="${secrets_dir:-/etc/pragmatika/secrets}"
  for file in "$CUTOVER_ENV_FILE" "$LIVE_DEPLOY/.env" "$secrets_dir/secrets.env" \
    "$LIVE_DEPLOY/$MASK_TOKEN_FILE_NAME"; do
    [[ -f "$file" ]] || continue
    python3 -I - "$file" "$MIN_SECRET_LEN" >>"$SECRETS_LIST" <<'PY'
import re, sys
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    if "=" not in line or line.lstrip().startswith("#"):
        continue
    name, raw = line.split("=", 1)
    if not re.search(r"(KEY|TOKEN|PASSWORD|SECRET)", name):
        continue
    raw = raw.strip()
    if raw[:1] in "'\"" and raw[-1:] == raw[:1]:
        raw = raw[1:-1]
    if len(raw) >= int(sys.argv[2]):
        print(raw)
PY
  done
}

# Архив результатов ~/patch8z-<время>.tgz; значение секрета в нём - архив удаляется.
finish_results() {
  local files
  cp "$STATE_FILE" "$RES/state.env" 2>/dev/null || true
  ARCHIVE_PATH="$CUTOVER_OUT_DIR/$ARCHIVE_PREFIX-$RUN_ID.tgz"
  tar -C "$RUN_DIR" -czf "$ARCHIVE_PATH" results 2>/dev/null || { ARCHIVE_PATH=""; return 0; }
  if [[ -s "$SECRETS_LIST" ]] && files="$(mktemp -d "$WORK/leak.XXXXXX")"; then
    tar -C "$files" -xzf "$ARCHIVE_PATH"
    if grep -rIqF -f <(awk 'length($0) >= '"$MIN_SECRET_LEN" "$SECRETS_LIST") "$files"; then
      rm -f "$ARCHIVE_PATH"
      ARCHIVE_PATH=""
      echo "ОШИБКА: в архиве результатов найдено значение секрета, архив удалён" >&2
    fi
  fi
}

on_exit() {
  local rc=$?
  trap - EXIT INT TERM
  set +e
  if ((rc != EXIT_OK && rc != EXIT_REFUSED && rc != EXIT_USAGE && ROLLBACK_MODE == 0)); then
    if [[ "$(state_get PATCH_STARTED)" == 1 && "$ROLLED_BACK" != 1 ]]; then
      log "СБОЙ: запускаю автоматический откат патча"
      ROLLED_BACK=1
      if rollback_patch "$RUN_DIR"; then
        rc="$EXIT_FAILED"
      else
        rc="$EXIT_STUCK"
        log "ОТКАТ НЕ УДАЛСЯ: нужно ручное вмешательство (OWNER-RUNBOOK.md, журнал)"
      fi
    fi
  fi
  finish_results
  if [[ "$rc" == "$EXIT_OK" ]]; then
    log "ГОТОВО. Архив результатов: ${ARCHIVE_PATH:-не создан}"
  else
    log "ЗАВЕРШЕНО С КОДОМ $rc. Архив результатов: ${ARCHIVE_PATH:-не создан}"
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------------------------------------
# Вспомогательное
# ---------------------------------------------------------------------------------------------
dir_free_mib() { df -Pm "$1" 2>/dev/null | awk 'NR == 2 { print $4 }'; }
mem_available_mib() { awk '/^MemAvailable:/ { print int($2 / '"$KIB_PER_MIB"') }' /proc/meminfo; }

# service_containers <сервис>: имена контейнеров сервиса compose-проекта (включая остановленные).
service_containers() {
  docker ps -a --filter "label=com.docker.compose.project=$CUTOVER_PROJECT" \
    --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | sort
}

# lock_ref <ключ>: ссылка образа (или версия) из lock пакета (пусто, если ключа нет).
lock_ref() { lock_value "$LOCK_SRC" "$1" || true; }
# live_lock_ref <ключ>: значение из lock боя (пусто, если ключа нет).
live_lock_ref() { lock_value "$LIVE_DEPLOY/images.lock" "$1" || true; }

# container_env_value <контейнер> <ИМЯ>: значение ОДНОЙ переменной окружения контейнера. Остальное
# окружение (секреты) не читается дальше sed и нигде не печатается.
container_env_value() {
  { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null || true; } \
    | sed -n "s/^$2=//p" | head -1
}

# container_started <контейнер>: время старта контейнера (State.StartedAt), пусто при ошибке.
container_started() { docker inspect -f '{{.State.StartedAt}}' "$1" 2>/dev/null || true; }
# container_restarts <контейнер>: счётчик перезапусков политики restart.
container_restarts() { docker inspect -f '{{.RestartCount}}' "$1" 2>/dev/null || echo "?"; }
# container_image_id <контейнер>: id образа, на котором запущен контейнер.
container_image_id() { docker inspect -f '{{.Image}}' "$1" 2>/dev/null || true; }
# ref_image_id <ссылка>: id образа по ссылке на хосте; «?», если образа нет.
ref_image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || echo "?"; }

# docs_probe <JS>: одноразовый контейнер в сети app (образ с bun берётся у самого app); печатает
# вывод пробы. Адрес documents - из окружения app, иначе умолчание платформы; тело пробы amend
# передаётся переменной окружения PATCH_AMEND_BODY.
docs_probe() {
  local image url
  image="$(container_image_id "$CUTOVER_APP_CONTAINER")"
  [[ -n "$image" ]] || { echo "нет контейнера $CUTOVER_APP_CONTAINER"; return 1; }
  url="$(container_env_value "$CUTOVER_APP_CONTAINER" "$DOCUMENTS_URL_KEY")"
  docker run --rm --network "container:$CUTOVER_APP_CONTAINER" --memory "$ONESHOT_MEM" \
    -e "PATCH_DOCS_URL=${url:-$DOCUMENTS_URL_DEFAULT}" -e "PATCH_AMEND_BODY=$AMEND_PROBE_BODY" \
    --entrypoint bun "$image" -e "$1" 2>&1
}

# docs_flags_check <контейнер>: сверяет четыре флага G8x в окружении контейнера documents (читаются
# только эти ключи). FLAGS_REPORT - «ИМЯ=значение ...», FLAGS_BAD - названия не совпавших.
FLAGS_REPORT=""
FLAGS_BAD=""
docs_flags_check() {
  local item key got
  FLAGS_REPORT=""
  FLAGS_BAD=""
  for item in "${DOCS_FLAGS[@]}"; do
    key="${item%%=*}"
    got="$(container_env_value "$1" "$key")"
    FLAGS_REPORT+=" $key=${got:-<нет>}"
    [[ "${got,,}" == "${item#*=}" ]] || FLAGS_BAD+=" $key"
  done
  FLAGS_REPORT="${FLAGS_REPORT# }"
  FLAGS_BAD="${FLAGS_BAD# }"
}

# ---------------------------------------------------------------------------------------------
# 0. Предусловия (бой не меняется)
# ---------------------------------------------------------------------------------------------
check_sources() {
  phase "целостность пакета и источников"
  command -v docker >/dev/null || refuse "нет docker"
  if [[ -f "$HERE/MANIFEST.sha256" ]]; then
    (cd "$HERE" && sha256sum -c --quiet MANIFEST.sha256) >>"$LOG_FILE" 2>&1 \
      || refuse "MANIFEST.sha256 не сходится: пакет повреждён или изменён"
    check "целостность пакета" ok "MANIFEST.sha256 сходится"
  else
    check "целостность пакета" warn "MANIFEST.sha256 нет (запуск из дерева проекта)"
  fi
  [[ -f "$LOCK_SRC" ]] || refuse "нет images.lock пакета ($LOCK_SRC)"
  cut_lock_format "$LOCK_SRC" || refuse "images.lock не в формате платформы (только digest)"
  cut_lock_has_mask "$LOCK_SRC" || refuse "в images.lock нет $LOCK_MASK_KEY"
  [[ -n "$(lock_ref "$LOCK_KEY_APP")" && -n "$(lock_ref "$LOCK_KEY_DOCUMENTS")" ]] \
    || refuse "в images.lock пакета нет $LOCK_KEY_APP или $LOCK_KEY_DOCUMENTS"
  [[ "$(lock_ref "$LOCK_KEY_VERSION")" == "$LOCK_VERSION_TO" ]] \
    || refuse "BAI_VERSION lock пакета '$(lock_ref "$LOCK_KEY_VERSION")'," \
      "ожидается $LOCK_VERSION_TO"
  [[ ! -e "$PKG/db" && ! -e "$HERE/stack/db" && ! -e "${PKG_DEPLOY:-/nonexistent}/db" ]] \
    || refuse "в патче есть каталог db: патч не должен менять БД и миграции"
  # Файлы дерева у G8z: только compose.project.yml (и images.lock из корня пакета). Любой другой
  # файл deploy/ в пакете (в том числе deploy/images.lock) - отказ; compose.project.yml обязан быть.
  local rel
  if [[ -d "$PKG_DEPLOY" ]]; then
    while IFS= read -r rel; do
      [[ " ${PATCH_FILE_ALLOW[*]} " == *" $rel "* ]] \
        || refuse "в пакете файл deploy/$rel: патч G8z заменяет только $COMPOSE_PROJECT_FILE" \
          "и images.lock"
    done < <(cd "$PKG_DEPLOY" && find . -mindepth 1 ! -type d | sed 's|^\./||' | sort)
  fi
  [[ -f "$PKG_DEPLOY/$COMPOSE_PROJECT_FILE" ]] \
    || refuse "в пакете нет deploy/$COMPOSE_PROJECT_FILE (две новые переменные app)"
  [[ -f "$ROUTES_MANIFEST" && -f "$ROUTES_TOOLS_DIR/check-routes.sh" \
    && -f "$ROUTES_TOOLS_DIR/route-flags.tsv" ]] \
    || refuse "в пакете нет инструментов проверки (tools/, routes.tsv)"
  check "состав пакета" ok "lock ${LOCK_VERSION_TO}, инструменты проверки на месте," \
    "из файлов deploy только $COMPOSE_PROJECT_FILE"
}

# Подпись ВСЕХ образов lock. Молча пропускать нельзя.
check_signatures() {
  phase "подписи образов"
  local key ref msg failed=0
  if command -v "$CUTOVER_COSIGN" >/dev/null 2>&1 && [[ -f "$COSIGN_PUB" ]]; then
    while read -r key ref; do
      if "$CUTOVER_COSIGN" verify --key "$COSIGN_PUB" --insecure-ignore-tlog=true "$ref" \
        >>"$LOG_FILE" 2>&1; then
        log "подпись $key: OK"
      else
        log "подпись $key: НЕ ПРОШЛА"
        failed=$((failed + 1))
      fi
    done < <(lock_images "$LOCK_SRC")
    ((failed == 0)) || refuse "cosign verify не прошёл у $failed образов"
    check "подписи образов" ok "cosign verify на хосте: все образы lock"
    return 0
  fi
  [[ -n "$SIGNATURES_FILE" ]] \
    || refuse "нет cosign или cosign.pub и нет signatures.txt (--signatures-verified ФАЙЛ):" \
      "проверку подписей пропускать нельзя"
  [[ -f "$SIGNATURES_FILE" ]] || refuse "нет файла $SIGNATURES_FILE"
  if msg="$(cut_check_signatures_file "$SIGNATURES_FILE" "$LOCK_SRC" "$COSIGN_PUB")"; then
    check "подписи образов" ok "по подтверждению verify-signatures.sh: $msg"
  else
    refuse "подтверждение подписей не принято: $msg"
  fi
}

# Дерево боя на месте и создано выкаткой пакета (cutover.sh).
check_tree_present() {
  phase "боевое дерево"
  [[ -f "$LIVE_DEPLOY/compose.yml" && -f "$LIVE_DEPLOY/images.lock" \
    && -f "$LIVE_DEPLOY/$ENV_FILE_NAME" ]] \
    || refuse "в $LIVE_DEPLOY нет compose.yml, images.lock или .env: это не дерево v2"
  [[ -f "$LIVE_DEPLOY/$DEPLOYED_MARK" ]] \
    || refuse "в $LIVE_DEPLOY нет $DEPLOYED_MARK: дерево создано не cutover.sh"
  check "боевое дерево" ok "$LIVE_DEPLOY создано выкаткой пакета"
}

# platform_version <файл>: значение PLATFORM_PACKAGES_VERSION (пусто, если файла или строки нет).
platform_version() {
  [[ -f "$1" ]] || return 0
  sed -n "s/^$PLATFORM_VERSION_KEY=//p" "$1" | head -1
}

# Патч G8z ещё не применён: lock боя не равен lock пакета и не имеет целевой версии. Повторный
# запуск того же патча - отказ без изменений.
check_not_applied() {
  phase "патч G8z ещё не применён"
  local live_ver
  live_ver="$(live_lock_ref "$LOCK_KEY_VERSION")"
  if cmp -s "$LIVE_DEPLOY/images.lock" "$LOCK_SRC" || [[ "$live_ver" == "$LOCK_VERSION_TO" ]]; then
    refuse "патч G8z уже применён (lock боя ${live_ver:-?}, версия пакета $LOCK_VERSION_TO):" \
      "повторный запуск ничего не меняет"
  fi
  check "патч G8z ещё не применён" ok "lock боя ${live_ver:-?} отличается от пакета"
}

# Патч G8y применён: lock боя 1.1.6-pragmatika.2, платформа боя 1.1.6, app и documents работают на
# образах из lock боя, у documents четыре флага G8x, у app переменные поиска G8w.
check_g8y_applied() {
  phase "патч G8y применён"
  local ver live_ver key live_ref got want missing=""
  live_ver="$(live_lock_ref "$LOCK_KEY_VERSION")"
  [[ "$live_ver" == "$LOCK_VERSION_FROM" ]] \
    || refuse "BAI_VERSION lock боя '${live_ver:-?}', ожидается $LOCK_VERSION_FROM: $G8Y_HINT"
  ver="$(platform_version "$LIVE_DEPLOY/$PLATFORM_VERSION_FILE")"
  [[ "$ver" == "$PLATFORM_NOW" ]] \
    || refuse "платформа боя '${ver:-?}', ожидается $PLATFORM_NOW: $G8Y_HINT"
  [[ -n "$(docker ps -q --filter "name=^${CUTOVER_APP_CONTAINER}\$")" ]] \
    || refuse "контейнер $CUTOVER_APP_CONTAINER не запущен"
  live_ref="$(live_lock_ref "$LOCK_KEY_APP")"
  got="$(container_image_id "$CUTOVER_APP_CONTAINER")"
  want="$(ref_image_id "$live_ref")"
  [[ -n "$got" && "$got" == "$want" ]] \
    || refuse "запущенный $CUTOVER_APP_CONTAINER не на образе из lock боя" \
      "(${live_ref##*/}): $G8Y_HINT"
  for key in "${G8W_APP_KEYS[@]}"; do
    [[ -n "$(container_env_value "$CUTOVER_APP_CONTAINER" "$key")" ]] || missing+=" $key"
  done
  [[ -z "$missing" ]] || refuse "в окружении $CUTOVER_APP_CONTAINER нет:$missing: $G8Y_HINT"
  DOCS_NAME="$(service_containers "$DOCUMENTS_SERVICE" | head -1)"
  [[ -n "$DOCS_NAME" ]] || refuse "в проекте нет контейнера documents"
  live_ref="$(live_lock_ref "$LOCK_KEY_DOCUMENTS")"
  got="$(container_image_id "$DOCS_NAME")"
  want="$(ref_image_id "$live_ref")"
  [[ -n "$got" && "$got" == "$want" ]] \
    || refuse "запущенный $DOCS_NAME не на образе из lock боя (${live_ref##*/}): $G8Y_HINT"
  docs_flags_check "$DOCS_NAME"
  [[ -z "$FLAGS_BAD" ]] \
    || refuse "в окружении $DOCS_NAME нет флагов G8x или они иные ($FLAGS_REPORT): $G8Y_HINT"
  check "патч G8y применён" ok "lock $live_ver, платформа $ver, образы как в lock," \
    "флаги documents и переменные поиска app на месте"
}

# lock боя отличается от пакетного только ключами патча (версия и образ app); файлы пакета только
# из списка.
check_changes() {
  phase "состав изменений"
  local live_lock="$LIVE_DEPLOY/images.lock" key old new changed="" rel
  while IFS='=' read -r key new; do
    [[ "$key" =~ ^BAI_ ]] || continue
    old="$(lock_value "$live_lock" "$key" || true)"
    [[ "$old" == "$new" ]] || changed+=" $key"
  done <"$LOCK_SRC"
  while IFS='=' read -r key old; do
    [[ "$key" =~ ^BAI_ ]] || continue
    [[ -n "$(lock_value "$LOCK_SRC" "$key")" ]] || changed+=" $key(удалён)"
  done <"$live_lock"
  for key in $changed; do
    [[ " $PATCH_LOCK_KEYS " == *" ${key%%(*} "* ]] \
      || refuse "lock пакета меняет $key: патч вправе менять только: $PATCH_LOCK_KEYS"
  done
  printf '%s\n' ${changed:-} >"$RES/lock-changes.txt"
  [[ -n "$changed" ]] \
    || refuse "нечего применять: lock боя уже совпадает с пакетом (патч применён?)"
  [[ " $changed " == *" $LOCK_KEY_APP "* ]] \
    || refuse "lock пакета не меняет образ app ($LOCK_KEY_APP): патчу нечего катить"
  # Файлы пакета: только из списка; отличающиеся от боевых - в список замены.
  PATCH_FILES=()
  while IFS= read -r rel; do
    [[ " ${PATCH_FILE_ALLOW[*]} " == *" $rel "* ]] \
      || refuse "в пакете файл $rel вне списка замены (${PATCH_FILE_ALLOW[*]})"
    [[ -f "$LIVE_DEPLOY/$rel" ]] && cmp -s "$PKG_DEPLOY/$rel" "$LIVE_DEPLOY/$rel" && continue
    PATCH_FILES+=("$rel")
  done < <(cd "$PKG_DEPLOY" && find . -type f | sed 's|^\./||' | sort)
  printf '%s\n' ${PATCH_FILES[@]+"${PATCH_FILES[@]}"} >"$RES/file-changes.txt"
  check "состав изменений" ok "lock:$changed; файлов дерева кроме lock: ${#PATCH_FILES[@]}" \
    "(${PATCH_FILES[*]:-})"
}

check_battle_health() {
  phase "бой здоров до начала"
  local body bots
  [[ -n "$(docker ps -q --filter "name=^${CUTOVER_APP_CONTAINER}\$")" ]] \
    || refuse "контейнер $CUTOVER_APP_CONTAINER не запущен"
  body="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
  [[ "$body" == 200* ]] || refuse "/ready боя не 200: ${body:0:120}"
  bots="$(ready_bots "$body")"
  ((bots >= CUTOVER_EXPECT_BOTS)) \
    || refuse "ботов $bots, ожидается не меньше $CUTOVER_EXPECT_BOTS (--expected-bots)"
  check "бой здоров" ok "/ready 200, ботов $bots"
}

check_resources() {
  phase "ресурсы"
  local docker_root free avail
  docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  free="$(dir_free_mib "$docker_root")"
  avail="$(mem_available_mib)"
  ((free >= PATCH_MIN_DISK_MIB)) \
    || refuse "мало места в $docker_root: свободно ${free} МиБ, нужно ${PATCH_MIN_DISK_MIB}"
  ((avail >= PATCH_MIN_AVAILABLE_MIB)) \
    || refuse "мало памяти: доступно ${avail} МиБ, нужно ${PATCH_MIN_AVAILABLE_MIB}"
  check "ресурсы" ok "диск ${free} МиБ, память ${avail} МиБ"
}

# Образ app из lock пакета - локально по digest (documents не меняется и уже запущен).
ensure_images() {
  phase "образ app"
  local ref key="$LOCK_KEY_APP"
  if [[ -n "$IMAGES_TAR" ]]; then
    [[ -f "$IMAGES_TAR" ]] || refuse "нет архива образов $IMAGES_TAR"
    log "загружаю образы из $IMAGES_TAR"
    docker load -i "$IMAGES_TAR" >>"$LOG_FILE" 2>&1 || refuse "docker load не удался"
  fi
  ref="$(lock_ref "$key")"
  [[ "$ref" == *@sha256:* ]] || refuse "образ $key '$ref' без digest"
  if ! docker image inspect "$ref" >/dev/null 2>&1; then
    log "образ ${ref##*/} не найден локально, docker pull"
    docker pull "$ref" >>"$LOG_FILE" 2>&1 \
      || refuse "образ ${ref##*/} не найден: docker login или --images-tar"
  fi
  check "образ ${key#BAI_IMAGE_}" ok "${ref##*/} на хосте"
}

# Прежний образ app (откатный, G8y) на хосте: без него автооткат невозможен.
check_rollback_images() {
  phase "откатный образ app"
  local ref key="$LOCK_KEY_APP"
  ref="$(live_lock_ref "$key")"
  [[ -n "$ref" ]] || refuse "в lock боя нет $key"
  docker image inspect "$ref" >/dev/null 2>&1 \
    || refuse "прежнего образа ${key#BAI_IMAGE_} ${ref##*/} нет на хосте: откат был бы невозможен"
  check "откатный образ ${key#BAI_IMAGE_}" ok "${ref##*/} на хосте"
}

# compose_json <корень дерева>: `compose config` дерева одним JSON в stdout (секреты подставлены:
# выводить нельзя, только сравнивать). Пусто - конфигурация не собралась.
compose_json() {
  (
    CUTOVER_NEW_DIR="$1"
    dc_new --profile tools config --format json 2>/dev/null
  ) || true
}

# config_delta <JSON боя до патча> <JSON после патча> <deploy боя> <deploy примерки> <значение
# «выключено»> <ИМЯ...>: сравнение конфигураций. Допустимое различие только образ app и две новые
# переменные app (у них должно быть значение «выключено»). Пути примерки в её JSON заменяются на
# боевые: compose раскрывает относительные пути томов от каталога файла. Печатает строки
# «ФЛАГ <причина>» и «РАЗЛИЧИЕ <путь>» (только названия ключей, значения не печатаются);
# пусто - всё сходится. Код 2 - у конфигурации нет ожидаемой структуры.
config_delta() {
  python3 -I -c '
import json, sys

def paths(left: object, right: object, prefix: str) -> list[str]:
    """Пути (только ключи), по которым два значения различаются."""
    if isinstance(left, dict) and isinstance(right, dict):
        found = []
        for key in sorted(set(left) | set(right)):
            where = prefix + "." + str(key) if prefix else str(key)
            if key not in left or key not in right:
                found.append(where)
            else:
                found += paths(left[key], right[key], where)
        return found
    return [] if left == right else [prefix]

try:
    live = json.load(open(sys.argv[1], encoding="utf-8"))
    new = json.loads(open(sys.argv[2], encoding="utf-8").read().replace(sys.argv[4], sys.argv[3]))
    off, names = sys.argv[5], sys.argv[6:]
    app_live, app_new = live["services"]["app"], new["services"]["app"]
    env_live = app_live.get("environment") or {}
    env_new = app_new.get("environment") or {}
except (ValueError, KeyError, TypeError, AttributeError, OSError):
    sys.exit(2)
for name in names:
    if name not in env_new:
        print("ФЛАГ нет-переменной " + name)
    elif str(env_new[name]).strip().lower() != off:
        print("ФЛАГ значение-не-" + off + " " + name)
    env_new.pop(name, None)
    env_live.pop(name, None)
app_live.pop("image", None)
app_new.pop("image", None)
for where in paths(live, new, ""):
    print("РАЗЛИЧИЕ " + where)
' "$@"
}

# Дерево примерки: копия боевого deploy + файлы пакета и lock, секреты ссылками на боевые файлы.
# Сравнивается `compose config` боя (снимок ДО патча) и примерки: обе новые переменные app false,
# а вся остальная конфигурация (app без образа и этих переменных, documents и прочие сервисы,
# сети, тома) совпадает.
stage_tree() {
  phase "примерка новых файлов (бой не меняется)"
  STAGE_DIR="$WORK/stage"
  local deploy="$STAGE_DIR/deploy" rel secret live_cfg new_cfg delta rc=0 line bad=""
  mkdir -p "$deploy"
  (cd "$LIVE_DEPLOY" && tar -c --exclude='./.env' --exclude='./secrets.env' \
    --exclude="./$MASK_TOKEN_FILE_NAME" .) | tar -x -C "$deploy"
  for secret in "$ENV_FILE_NAME" secrets.env "$MASK_TOKEN_FILE_NAME"; do
    [[ ! -e "$LIVE_DEPLOY/$secret" ]] || ln -sfn "$LIVE_DEPLOY/$secret" "$deploy/$secret"
  done
  for rel in ${PATCH_FILES[@]+"${PATCH_FILES[@]}"}; do
    mkdir -p "$(dirname "$deploy/$rel")"
    cp -p "$PKG_DEPLOY/$rel" "$deploy/$rel"
  done
  cp "$LOCK_SRC" "$deploy/images.lock"
  live_cfg="$(compose_json "$LIVE_NEW_DIR")"
  [[ -n "$live_cfg" ]] || refuse "docker compose config боевого дерева не собрался: снимка нет"
  CUTOVER_NEW_DIR="$STAGE_DIR"
  dc_new --profile tools config --quiet >>"$LOG_FILE" 2>&1 \
    || { CUTOVER_NEW_DIR="$LIVE_NEW_DIR"; refuse "docker compose config не принял новые файлы"; }
  CUTOVER_NEW_DIR="$LIVE_NEW_DIR"
  check "конфигурация compose" ok "новые файлы и lock собираются"
  new_cfg="$(compose_json "$STAGE_DIR")"
  [[ -n "$new_cfg" ]] || refuse "docker compose config новых файлов не отдал JSON"
  delta="$(config_delta <(printf '%s' "$live_cfg") <(printf '%s' "$new_cfg") \
    "$LIVE_DEPLOY" "$deploy" "$FLAG_OFF_VALUE" "${NEW_APP_FLAGS[@]}")" || rc=$?
  ((rc == 0)) || refuse "в конфигурации compose нет сервиса app (структура не разобрана)"
  while IFS= read -r line; do
    [[ -z "$line" ]] || bad+="; $line"
  done <<<"$delta"
  [[ -z "$bad" ]] || refuse "новая конфигурация compose не сходится со снимком боя до патча" \
    "(допустимо: образ app и две новые переменные app = $FLAG_OFF_VALUE; патч флаги не включает:" \
    "значение из .env боя уберите, включение - enable-flags.sh): ${bad#; }"
  check "флаги app в конфигурации" ok "${NEW_APP_FLAGS[*]} = $FLAG_OFF_VALUE при пустом окружении"
  check "прочая конфигурация" ok "совпадает со снимком боя до патча (образ app и две переменные)"
}

# ---------------------------------------------------------------------------------------------
# 1-2. Бэкап и замена
# ---------------------------------------------------------------------------------------------
make_backup() {
  phase "бэкап файлов дерева"
  BACKUP_DIR="${CUTOVER_BACKUP_ROOT}/${BACKUP_PREFIX}-${RUN_ID}"
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  cp -a "$LIVE_DEPLOY" "$BACKUP_DIR/deploy" || refuse "не удалось скопировать $LIVE_DEPLOY"
  [[ "$(stat -c %a "$LIVE_DEPLOY/$ENV_FILE_NAME")" \
    == "$(stat -c %a "$BACKUP_DIR/deploy/$ENV_FILE_NAME")" ]] \
    || refuse "права .env в бэкапе не совпали с боевыми"
  {
    echo "# контейнеры проекта до патча: имя<TAB>образ (Config.Image)<TAB>id образа<TAB>StartedAt"
    local name
    while IFS= read -r name; do
      printf '%s\t%s\t%s\t%s\n' "$name" "$(docker inspect -f '{{.Config.Image}}' "$name")" \
        "$(docker inspect -f '{{.Image}}' "$name")" "$(container_started "$name")"
    done < <(project_containers)
  } >"$BACKUP_DIR/containers-before.tsv"
  state_set BACKUP_DIR "$BACKUP_DIR"
  state_set LIVE_DEPLOY "$LIVE_DEPLOY"
  state_set DOCUMENTS_NAME "$DOCS_NAME"
  # documents патчем не пересоздаётся: его StartedAt до замены - эталон для проверок после.
  DOCS_STARTED_BEFORE="$(container_started "$DOCS_NAME")"
  check "бэкап" ok "$BACKUP_DIR (deploy, список контейнеров и образов)"
}

# Замена файлов: временный файл рядом и mv, чтобы compose не увидел наполовину записанный.
# Сначала compose.project.yml, затем images.lock; оба пути пишутся в state для отката.
apply_files() {
  phase "замена файлов дерева"
  local rel tmp
  state_set PATCH_STARTED 1
  for rel in ${PATCH_FILES[@]+"${PATCH_FILES[@]}"}; do
    tmp="$LIVE_DEPLOY/$rel.patch-new"
    mkdir -p "$(dirname "$LIVE_DEPLOY/$rel")"
    cp -p "$PKG_DEPLOY/$rel" "$tmp"
    mv -f "$tmp" "$LIVE_DEPLOY/$rel"
    state_set FILE_REPLACED "$rel"
  done
  cp "$LOCK_SRC" "$LIVE_DEPLOY/images.lock.patch-new"
  chmod 644 "$LIVE_DEPLOY/images.lock.patch-new"
  mv -f "$LIVE_DEPLOY/images.lock.patch-new" "$LIVE_DEPLOY/images.lock"
  state_set FILE_REPLACED images.lock
  check "замена файлов" ok "заменено файлов: $((${#PATCH_FILES[@]} + 1)) (включая images.lock)"
}

# Пересоздание ТОЛЬКО app, без зависимостей и без удаления сирот (documents не трогается).
recreate_app() {
  phase "пересоздание app"
  log "up -d --no-deps app"
  dc_new up -d --no-deps "$APP_SERVICE" >>"$LOG_FILE" 2>&1 \
    || die "$EXIT_FAILED" "compose up app не удался"
  wait_healthy "$CUTOVER_APP_CONTAINER" "$HEALTH_WAIT_S" \
    || die "$EXIT_FAILED" "$CUTOVER_APP_CONTAINER не стал healthy за ${HEALTH_WAIT_S} с"
  check "сервис app" ok "пересоздан, $CUTOVER_APP_CONTAINER работает"
}

# ---------------------------------------------------------------------------------------------
# 3. Проверки после замены
# ---------------------------------------------------------------------------------------------
# verify_image <контейнер> <ключ lock>: образ запущенного контейнера равен образу из lock пакета.
verify_image() {
  local name="$1" key="$2" ref want got
  ref="$(lock_ref "$key")"
  got="$(container_image_id "$name")"
  want="$(ref_image_id "$ref")"
  printf '%s\t%s\t%s\n' "$name" "$ref" \
    "$([[ "$got" == "$want" ]] && echo совпал || echo ОТЛИЧАЕТСЯ)" >>"$RES/images-running.tsv"
  [[ -n "$got" && "$got" == "$want" ]] \
    || die "$EXIT_FAILED" "образ запущенного $name не равен lock (${ref##*/})"
  check "образ ${key#BAI_IMAGE_} = images.lock" ok "digest $name совпал с lock (${ref##*/})"
}

# В окружении documents четыре флага G8x не потерялись (читаются только эти ключи).
verify_documents_env() {
  docs_flags_check "$DOCS_NAME"
  [[ -z "$FLAGS_BAD" ]] \
    || die "$EXIT_FAILED" "в окружении documents потеряны флаги G8x (${DOCS_FLAGS[*]}):" \
      "$FLAGS_REPORT"
  check "окружение documents" ok "$FLAGS_REPORT"
}

# Проба POST /docx/amend с параметрами G8y: ответ ровно тот, что даёт образ documents G8y
# (AMEND_PROBE_STATUS и AMEND_PROBE_ERROR). Образ старше G8y эти поля игнорирует и отвечает иначе.
# В журнал и вывод идут только статус и код ошибки (detail.error), тело ответа не печатается.
verify_amend_probe() {
  local out line code="" err=""
  out="$(docs_probe "$AMEND_ROUTE_JS" || true)"
  line="$(grep -v '^[[:space:]]*$' <<<"$out" | tail -n 1 || true)"
  read -r code err _ <<<"$line" || true
  [[ "$code" =~ ^[0-9]{3}$ ]] \
    || die "$EXIT_FAILED" "проба $AMEND_ROUTE_PATH не отвечает: ${line:0:120}"
  [[ "$code" == "$AMEND_PROBE_STATUS" && "$err" == "$AMEND_PROBE_ERROR" ]] \
    || die "$EXIT_FAILED" "проба $AMEND_ROUTE_PATH: ответ $code ${err:--}, ожидается" \
      "$AMEND_PROBE_STATUS $AMEND_PROBE_ERROR (documents не на образе G8y?)"
  check "проба $AMEND_ROUTE_PATH" ok "documents ответил $code $err (остался на образе G8y)"
}

verify_ready() {
  local body bots="0" started=$SECONDS
  ready_wait "$CUTOVER_APP_CONTAINER" "$READY_WAIT_S" \
    || die "$EXIT_FAILED" "/ready не 200 за ${READY_WAIT_S} с: ${READY_BODY:0:160}"
  while ((SECONDS - started < READY_WAIT_S)); do
    body="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
    bots="$(ready_bots "$body")"
    ((bots >= CUTOVER_EXPECT_BOTS)) && break
    sleep "$POLL_S"
  done
  ((bots >= CUTOVER_EXPECT_BOTS)) \
    || die "$EXIT_FAILED" "ботов $bots, ожидается не меньше $CUTOVER_EXPECT_BOTS"
  check "/ready и боты" ok "200, ботов $bots"
}

# В окружении app после пересоздания: переменные поиска G8w на месте (только наличие), обе новые
# переменные есть и равны false (патч флаги не включает; значения только этих двух ключей).
verify_app_env() {
  local key missing="" got bad=""
  for key in "${G8W_APP_KEYS[@]}"; do
    [[ -n "$(container_env_value "$CUTOVER_APP_CONTAINER" "$key")" ]] || missing+=" $key"
  done
  [[ -z "$missing" ]] || die "$EXIT_FAILED" "в окружении app пропали переменные G8w:$missing"
  for key in "${NEW_APP_FLAGS[@]}"; do
    got="$(container_env_value "$CUTOVER_APP_CONTAINER" "$key")"
    [[ -n "$got" ]] || die "$EXIT_FAILED" "в окружении app нет новой переменной $key"
    [[ "${got,,}" == "$FLAG_OFF_VALUE" ]] || bad+=" $key=$got"
  done
  [[ -z "$bad" ]] \
    || die "$EXIT_FAILED" "патч флаги не включает, а в окружении app:$bad" \
      "(ожидается $FLAG_OFF_VALUE)"
  check "окружение app" ok "переменные поиска G8w на месте; ${NEW_APP_FLAGS[*]} = $FLAG_OFF_VALUE"
}

# documents патчем не трогается: StartedAt тот же, что до замены (снимок в make_backup).
verify_documents_stable() {
  local started
  started="$(container_started "$DOCS_NAME")"
  [[ -n "$DOCS_STARTED_BEFORE" && "$started" == "$DOCS_STARTED_BEFORE" ]] \
    || die "$EXIT_FAILED" "$DOCS_NAME перезапускался при замене (патч его не трогает):" \
      "StartedAt $DOCS_STARTED_BEFORE -> $started"
  check "documents стабилен" ok "при замене app не перезапускался"
}

# Остальные контейнеры (кроме app и documents) патч не трогает: перезапуск - только предупреждение.
report_other_containers() {
  local name want started changed=""
  while IFS=$'\t' read -r name _ _ want; do
    [[ "$name" == \#* || -z "$name" ]] && continue
    [[ "$name" == "$CUTOVER_APP_CONTAINER" || "$name" == "$DOCS_NAME" ]] && continue
    started="$(container_started "$name")"
    [[ "$started" == "$want" ]] || changed+=" $name"
  done <"$BACKUP_DIR/containers-before.tsv"
  if [[ -z "$changed" ]]; then
    check "прочие контейнеры" ok "не перезапускались"
  else
    check "прочие контейнеры" warn "изменился StartedAt:$changed (патч их не трогал)"
  fi
}

verify_routes() {
  local out="$RES/routes-stack.txt" rc=0 summary
  cut_check_routes_stack "$out" || rc=$?
  cat "$out" >>"$LOG_FILE"
  summary="$(tail -1 "$out" | cut -c1-200)"
  ((rc == 0)) || die "$EXIT_FAILED" "проверка маршрутов стека не прошла (routes-stack.txt)"
  check "маршруты стека" ok "$summary"
}

# Выдержка: documents и app не перезапускаются (StartedAt и RestartCount те же), /ready 200 и
# /health documents 200.
soak() {
  local c started=$SECONDS left body now_started now_restarts
  local -A started_before=() restarts_before=()
  for c in "$DOCS_NAME" "$CUTOVER_APP_CONTAINER"; do
    started_before[$c]="$(container_started "$c")"
    restarts_before[$c]="$(container_restarts "$c")"
  done
  log "выдержка ${SOAK_S} с (проверка каждые ${SOAK_POLL_S} с)"
  while ((SECONDS - started < SOAK_S)); do
    left=$((SOAK_S - (SECONDS - started)))
    sleep "$((SOAK_POLL_S < left ? SOAK_POLL_S : left))"
    for c in "$DOCS_NAME" "$CUTOVER_APP_CONTAINER"; do
      now_started="$(container_started "$c")"
      now_restarts="$(container_restarts "$c")"
      [[ "$now_started" == "${started_before[$c]}" \
        && "$now_restarts" == "${restarts_before[$c]}" ]] \
        || die "$EXIT_FAILED" "во время выдержки $c перезапускался:" \
          "перезапусков ${restarts_before[$c]} -> $now_restarts"
    done
    body="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
    [[ "$body" == 200* ]] || die "$EXIT_FAILED" "во время выдержки /ready не 200: ${body:0:120}"
    body="$(docs_probe "$DOCS_HEALTH_JS" || true)"
    [[ "$body" == 200* ]] \
      || die "$EXIT_FAILED" "во время выдержки /health documents не 200: ${body:0:120}"
  done
  check "выдержка ${SOAK_S} с" ok "documents и app не перезапускались, /ready и /health 200"
}

verify_app() {
  phase "проверки после замены"
  : >"$RES/images-running.tsv"
  verify_image "$CUTOVER_APP_CONTAINER" "$LOCK_KEY_APP"
  verify_ready
  verify_app_env
  verify_image "$DOCS_NAME" "$LOCK_KEY_DOCUMENTS"
  verify_documents_env
  verify_documents_stable
  report_other_containers
  verify_routes
  verify_amend_probe
  soak
}

# ---------------------------------------------------------------------------------------------
# Откат
# ---------------------------------------------------------------------------------------------
# rollback_patch <каталог запуска патча>: compose.project.yml и images.lock из бэкапа, up -d
# --no-deps app на образ G8y (documents не трогается), проверки. 0 - бой как до патча и проверен;
# иначе 1.
ROLLBACK_FAILED=0
rb_check() { # rb_check <имя> <ok|fail> <описание>
  check "откат: $1" "$2" "$3"
  [[ "$2" != fail ]] || ROLLBACK_FAILED=$((ROLLBACK_FAILED + 1))
}
rollback_patch() {
  local run="$1" backup live rel body bots name want got
  local saved_state="$STATE_FILE" replaced=()
  STATE_FILE="$run/state.env"
  backup="$(state_get BACKUP_DIR)"
  live="$(state_get LIVE_DEPLOY)"
  STATE_FILE="$saved_state"
  phase "откат патча"
  if [[ -z "$backup" || ! -d "$backup/deploy" || -z "$live" ]]; then
    log "нет бэкапа в $run/state.env: откат невозможен"
    return 1
  fi
  # 1. Файлы дерева из бэкапа: все, что патч заменил (список в state), и lock.
  mapfile -t replaced < <(grep -E '^FILE_REPLACED=' "$run/state.env" | cut -d= -f2- | sort -u)
  for rel in ${replaced[@]+"${replaced[@]}"}; do
    [[ -n "$rel" && -e "$backup/deploy/$rel" ]] || continue
    cp -a "$backup/deploy/$rel" "$live/$rel.rb-new" && mv -f "$live/$rel.rb-new" "$live/$rel"
  done
  local bad=0
  for rel in images.lock ${replaced[@]+"${replaced[@]}"}; do
    [[ -n "$rel" && -e "$backup/deploy/$rel" ]] || continue
    cmp -s "$backup/deploy/$rel" "$live/$rel" || bad=$((bad + 1))
  done
  ((bad == 0)) \
    && rb_check "файлы дерева" ok "compose.project.yml и images.lock возвращены из бэкапа" \
    || rb_check "файлы дерева" fail "файлов не совпало с бэкапом: $bad"
  # 2. Только app, на образ G8y: без down, без --remove-orphans, documents не трогается.
  CUTOVER_NEW_DIR="$(dirname "$live")"
  dc_new up -d --no-deps "$APP_SERVICE" >>"$LOG_FILE" 2>&1 \
    && rb_check "поднят app" ok "up -d --no-deps app" \
    || rb_check "поднят app" fail "compose up не удался"
  # 3. Проверки: /ready и образы контейнеров как до патча.
  if ready_wait "$CUTOVER_APP_CONTAINER" "$READY_WAIT_S"; then
    body="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
    bots="$(ready_bots "$body")"
    ((bots >= CUTOVER_EXPECT_BOTS)) \
      && rb_check "/ready" ok "200, ботов $bots" \
      || rb_check "/ready" fail "ботов $bots, ожидается не меньше $CUTOVER_EXPECT_BOTS"
  else
    rb_check "/ready" fail "не 200 за ${READY_WAIT_S} с: ${READY_BODY:0:120}"
  fi
  while IFS=$'\t' read -r name want _ _; do
    [[ "$name" == \#* || -z "$name" ]] && continue
    got="$(docker inspect -f '{{.Config.Image}}' "$name" 2>/dev/null || echo отсутствует)"
    [[ "$got" == "$want" ]] \
      && rb_check "образ $name" ok "как до патча" \
      || rb_check "образ $name" fail "сейчас $got, до патча $want"
  done <"$backup/containers-before.tsv"
  ((ROLLBACK_FAILED == 0)) || return 1
  log "ОТКАТ ПАТЧА ВЫПОЛНЕН: файлы дерева из бэкапа, app на образе G8y, documents не тронут," \
    "проверки прошли"
  state_set ROLLBACK_RESULT OK
}

# ---------------------------------------------------------------------------------------------
main() {
  if ((ROLLBACK_MODE)); then
    log "patch.sh --rollback: откат по каталогу запуска $RUN_DIR_ORIG"
    rollback_patch "$RUN_DIR_ORIG" || exit "$EXIT_STUCK"
    return 0
  fi
  save_config
  log "patch.sh $RUN_ID: проект $CUTOVER_PROJECT, дерево $LIVE_NEW_DIR, каталог запуска $RUN_DIR"
  collect_secret_values
  check_sources
  check_signatures
  check_tree_present
  check_not_applied
  check_g8y_applied
  check_changes
  check_battle_health
  check_resources
  ensure_images
  stage_tree
  check_rollback_images
  if ((PREFLIGHT_ONLY)); then
    check "режим" ok "--preflight-only: бой не менялся"
    state_set RESULT "PREFLIGHT_OK"
    return 0
  fi
  make_backup
  apply_files
  recreate_app
  verify_app
  state_set RESULT OK
}
main
