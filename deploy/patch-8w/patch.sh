#!/usr/bin/env bash
# Патч G8w: ядро платформы 1.1.3 -> 1.1.5 (образ app) и две переменные окружения app для
# ограничителя частоты поиска Яндекса (КРАСНАЯ ЗОНА: запускает только владелец на боевом хосте).
# Ставится СТРОГО ПОСЛЕ патча G8 (deploy/patch): обход /docx/* уже снят, documents проектный.
#
# Использование:
#   bash patch.sh [--preflight-only] [--signatures-verified ФАЙЛ] [--images-tar ФАЙЛ]
#                 [--config ФАЙЛ] [--out-dir КАТАЛОГ] [--soak-seconds N] [--expected-bots N]
#   bash patch.sh --rollback [--run-dir КАТАЛОГ]   откат применённого патча вручную
#   bash patch.sh --help
#
# Что делает (бой = compose-проект `pragmatika`, дерево /opt/pragmatika-v2/deploy; БД, миграции,
# documents, alloy, nginx, тома и секреты патч НЕ трогает):
#   0. Предусловия, бой не меняется: целостность пакета (MANIFEST.sha256), подписи ВСЕХ образов
#      lock (cosign на хосте либо --signatures-verified: вывод verify-signatures.sh; по умолчанию
#      signatures.txt рядом с пакетом; молча пропускать нельзя), патч G8 применён (нет
#      контейнеров обхода documents-router и documents-legacy, образ запущенного documents равен
#      образу documents пакетного lock, app смотрит на documents напрямую), lock пакета
#      отличается от боевого ТОЛЬКО ключами BAI_VERSION, BAI_IMAGE_APP, BAI_IMAGE_APP_BASE,
#      миграций в пакете нет, из файлов дерева заменяются только compose.project.yml,
#      platform/compose.base.yml, platform/PLATFORM-VERSION (и images.lock), бой здоров (/ready
#      200, ботов не меньше ожидаемого), свободны диск и память, образ app на хосте (docker load
#      или pull по digest), compose новых файлов собирается и отдаёт app обе переменные, прежний
#      (откатный) образ app на хосте есть. Любое нарушение - код 3, бой не тронут. С
#      --preflight-only на этом всё.
#   1. Бэкап файлов дерева (весь каталог deploy, права сохраняются, .env 600) и снимок
#      контейнеров и образов: ~/backups/pragmatika-patch8w-<время>.
#   2. Замена файлов из пакета и `up -d --no-deps app` (только app; без down и без
#      --remove-orphans; простой app около 30 с).
#   3. Проверки: образ app = lock, /ready 200 и ботов не меньше ожидаемого, в окружении app
#      YANDEX_SEARCH_MAX_CONCURRENCY=1 и YANDEX_SEARCH_MIN_INTERVAL_MS=1000 (читаются только эти
#      два ключа, остальное окружение и секреты не печатаются), documents не изменился и не
#      перезапускался (образ и StartedAt те же), маршруты стека не 404/405 (tools/check-routes.sh),
#      выдержка (по умолчанию 2 минуты: app не перезапускается, /ready 200).
#   Любой сбой после начала изменений -> автоматический откат: файлы дерева возвращаются из
#   бэкапа, `up -d --no-deps app` на прежний образ, проверяется /ready.
# Результат: ~/patch8w-<время>.tgz (журнал, проверки; без секретов и данных) - вернуть
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
  PKG_DEPLOY="${PATCH8W_PKG_DEPLOY:-$PKG/deploy}"
  LOCK_SRC="${PATCH8W_LOCK:-$PKG/deploy/images.lock}"
fi
# shellcheck source=../cutover/lib.sh
source "$LIB"
COSIGN_PUB="${PATCH8W_COSIGN_PUB:-$PKG/cosign.pub}"
[[ -f "$COSIGN_PUB" ]] || COSIGN_PUB="$PKG/deploy/cosign.pub"

# Файлы дерева, которые патч вправе заменить (пути относительно deploy/); чужой файл в пакете -
# отказ. ДОЛЖНО совпадать с DEPLOY_FILES в tools/build-patch-8w-package.sh.
PATCH_FILE_ALLOW=(compose.project.yml platform/compose.base.yml platform/PLATFORM-VERSION)
# Ключи lock, которые патч вправе менять: образ app, его платформенная основа и версия lock.
# Любой другой (documents, alloy, postgres, mask...) - отказ: патч не про них.
PATCH_LOCK_KEYS="BAI_VERSION BAI_IMAGE_APP BAI_IMAGE_APP_BASE"
LOCK_KEY_APP="BAI_IMAGE_APP"
LOCK_KEY_DOCUMENTS="BAI_IMAGE_DOCUMENTS"
# Контейнеры временного обхода /docx/* (hotfix-docx): после патча G8 их быть не должно.
BYPASS_SERVICES=(documents-router documents-legacy)
DOCUMENTS_SERVICE="documents"
G8_HINT="сначала примените патч G8 (проектный documents, обход /docx/* снят)"
# Адрес documents в окружении app: хост сервиса documents, не documents-router.
DOCUMENTS_URL_KEY="DOCUMENTS_URL"
DOCUMENTS_URL_RE='^https?://documents(:[0-9]+)?(/.*)?$'
# Переменные app, которые патч обязан выставить (имя и значение), и больше ничего не читается.
YANDEX_CONCURRENCY_KEY="YANDEX_SEARCH_MAX_CONCURRENCY"
YANDEX_CONCURRENCY_WANT="1"
YANDEX_INTERVAL_KEY="YANDEX_SEARCH_MIN_INTERVAL_MS"
YANDEX_INTERVAL_WANT="1000"
DEFAULT_SOAK_S=120
SOAK_POLL_S=${PATCH8W_SOAK_POLL_S:-15}
DEPLOYED_MARK=".cutover-deployed"
BACKUP_PREFIX="pragmatika-patch8w"
ARCHIVE_PREFIX="patch8w"
RUN_PREFIX="patch-8w"
# Права .env в бэкапе должны совпасть с боевыми (600).
ENV_FILE_NAME=".env"
# Запасы: свободный диск под образ app (МиБ) и доступная память (МиБ).
PATCH_MIN_DISK_MIB="${PATCH8W_MIN_DISK_MIB:-3072}"
PATCH_MIN_AVAILABLE_MIB="${PATCH8W_MIN_AVAILABLE_MIB:-1024}"
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
PATCH_FILES=()
# Состояние боя до замены (для проверок «documents не тронут» и отката).
DOCS_NAME=""
DOCS_IMAGE_BEFORE=""
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

# Архив результатов ~/patch8w-<время>.tgz; значение секрета в нём - архив удаляется.
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

# lock_ref <ключ>: ссылка образа из lock пакета (пусто, если ключа нет).
lock_ref() { lock_value "$LOCK_SRC" "$1" || true; }

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
  [[ ! -e "$PKG/db" && ! -e "$HERE/stack/db" && ! -e "$PKG_DEPLOY/db" ]] \
    || refuse "в патче есть каталог db: патч не должен менять БД и миграции"
  [[ -d "$PKG_DEPLOY" ]] || refuse "в пакете нет каталога deploy ($PKG_DEPLOY)"
  [[ -f "$ROUTES_MANIFEST" && -f "$ROUTES_TOOLS_DIR/check-routes.sh" \
    && -f "$ROUTES_TOOLS_DIR/route-flags.tsv" ]] \
    || refuse "в пакете нет инструментов проверки (tools/, routes.tsv)"
  check "состав пакета" ok "lock, инструменты проверки на месте, миграций нет"
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

# Патч G8 применён: обхода нет, documents на образе пакетного lock, app смотрит на documents.
check_g8_applied() {
  phase "патч G8 применён"
  local svc want_ref live_ref got want url
  for svc in "${BYPASS_SERVICES[@]}"; do
    [[ -z "$(service_containers "$svc")" ]] \
      || refuse "в проекте есть контейнер обхода $svc: $G8_HINT"
  done
  DOCS_NAME="$(service_containers "$DOCUMENTS_SERVICE" | head -1)"
  [[ -n "$DOCS_NAME" ]] || refuse "в проекте нет контейнера documents: $G8_HINT"
  want_ref="$(lock_ref "$LOCK_KEY_DOCUMENTS")"
  live_ref="$(lock_value "$LIVE_DEPLOY/images.lock" "$LOCK_KEY_DOCUMENTS" || true)"
  [[ "$live_ref" == "$want_ref" ]] \
    || refuse "образ documents в lock боя (${live_ref##*/}) не равен пакетному" \
      "(${want_ref##*/}): $G8_HINT"
  got="$(container_image_id "$DOCS_NAME")"
  want="$(ref_image_id "$want_ref")"
  [[ -n "$got" && "$got" == "$want" ]] \
    || refuse "запущенный $DOCS_NAME не на образе ${want_ref##*/}: $G8_HINT"
  url="$(container_env_value "$CUTOVER_APP_CONTAINER" "$DOCUMENTS_URL_KEY")"
  [[ -n "$url" ]] || refuse "в окружении $CUTOVER_APP_CONTAINER нет $DOCUMENTS_URL_KEY"
  [[ "$url" =~ $DOCUMENTS_URL_RE ]] \
    || refuse "app смотрит на $url, а не на сервис documents: $G8_HINT"
  check "патч G8 применён" ok "обхода нет, documents на ${want_ref##*/}, app -> $url"
}

# lock боя отличается от пакетного только ключами патча; файлы пакета только из списка.
check_changes() {
  phase "состав изменений"
  local live_lock="$LIVE_DEPLOY/images.lock" key old new changed=""
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
  # Файлы пакета: только из списка; различающиеся - в список замены.
  PATCH_FILES=()
  local rel
  while IFS= read -r rel; do
    [[ " ${PATCH_FILE_ALLOW[*]} " == *" $rel "* ]] \
      || refuse "в пакете файл $rel вне списка замены (${PATCH_FILE_ALLOW[*]})"
    [[ -f "$LIVE_DEPLOY/$rel" ]] && cmp -s "$PKG_DEPLOY/$rel" "$LIVE_DEPLOY/$rel" && continue
    PATCH_FILES+=("$rel")
  done < <(cd "$PKG_DEPLOY" && find . -type f ! -name 'images.lock' | sed 's|^\./||' | sort)
  printf '%s\n' ${PATCH_FILES[@]+"${PATCH_FILES[@]}"} >"$RES/file-changes.txt"
  if [[ -z "$changed" && ${#PATCH_FILES[@]} -eq 0 ]]; then
    refuse "нечего применять: lock и файлы дерева уже совпадают с пакетом (патч применён?)"
  fi
  check "состав изменений" ok "lock:${changed:- нет}; файлов: ${#PATCH_FILES[@]}" \
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

# Образ app из lock пакета - локально по digest.
ensure_images() {
  phase "образ app"
  local ref
  if [[ -n "$IMAGES_TAR" ]]; then
    [[ -f "$IMAGES_TAR" ]] || refuse "нет архива образов $IMAGES_TAR"
    log "загружаю образы из $IMAGES_TAR"
    docker load -i "$IMAGES_TAR" >>"$LOG_FILE" 2>&1 || refuse "docker load не удался"
  fi
  ref="$(lock_ref "$LOCK_KEY_APP")"
  [[ "$ref" == *@sha256:* ]] || refuse "образ app '$ref' без digest"
  if ! docker image inspect "$ref" >/dev/null 2>&1; then
    log "образ ${ref##*/} не найден локально, docker pull"
    docker pull "$ref" >>"$LOG_FILE" 2>&1 \
      || refuse "образ ${ref##*/} не найден: docker login или --images-tar"
  fi
  check "образ app" ok "${ref##*/} на хосте"
}

# Прежний образ app (откатный) на хосте: без него автооткат невозможен.
check_rollback_image() {
  phase "откатный образ app"
  local ref
  ref="$(lock_value "$LIVE_DEPLOY/images.lock" "$LOCK_KEY_APP" || true)"
  [[ -n "$ref" ]] || refuse "в lock боя нет $LOCK_KEY_APP"
  docker image inspect "$ref" >/dev/null 2>&1 \
    || refuse "прежнего образа app ${ref##*/} нет на хосте: откат был бы невозможен"
  check "откатный образ app" ok "${ref##*/} на хосте"
}

# Дерево примерки: копия боевого deploy + файлы пакета, секреты ссылками на боевые файлы.
# Проверяется, что compose собирает конфигурацию и отдаёт app обе переменные Яндекса.
stage_tree() {
  phase "примерка новых файлов (бой не меняется)"
  STAGE_DIR="$WORK/stage"
  local deploy="$STAGE_DIR/deploy" rel secret
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
  CUTOVER_NEW_DIR="$STAGE_DIR"
  dc_new --profile tools config --quiet >>"$LOG_FILE" 2>&1 \
    || { CUTOVER_NEW_DIR="$LIVE_NEW_DIR"; refuse "docker compose config не принял новые файлы"; }
  check "конфигурация compose" ok "новые файлы и lock собираются"
  local got
  got="$(staged_app_vars)"
  CUTOVER_NEW_DIR="$LIVE_NEW_DIR"
  [[ "$got" == "$(wanted_vars)" ]] \
    || refuse "в новой конфигурации compose у app нет нужных значений" \
      "($YANDEX_CONCURRENCY_KEY, $YANDEX_INTERVAL_KEY), получено: $(echo "$got" | tr '\n' ' ')"
  check "переменные app в конфигурации" ok "$(wanted_vars | tr '\n' ' ')"
}

# wanted_vars: ожидаемые строки ИМЯ=ЗНАЧЕНИЕ (порядок как в staged_app_vars).
wanted_vars() {
  printf '%s=%s\n%s=%s\n' "$YANDEX_CONCURRENCY_KEY" "$YANDEX_CONCURRENCY_WANT" \
    "$YANDEX_INTERVAL_KEY" "$YANDEX_INTERVAL_WANT"
}

# staged_app_vars: из `compose config` печатает ТОЛЬКО две переменные app (остальное окружение, в
# том числе подставленные секреты, не читается дальше этого фильтра).
staged_app_vars() {
  { dc_new --profile tools config --format json 2>/dev/null || true; } | python3 -I -c '
import json, sys
names = sys.argv[1:]
try:
    env = json.load(sys.stdin)["services"]["app"].get("environment", {})
except (ValueError, KeyError, TypeError):
    sys.exit(0)
for name in names:
    if name in env:
        print(name + "=" + ("" if env[name] is None else str(env[name])))
' "$YANDEX_CONCURRENCY_KEY" "$YANDEX_INTERVAL_KEY"
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
  DOCS_IMAGE_BEFORE="$(container_image_id "$DOCS_NAME")"
  DOCS_STARTED_BEFORE="$(container_started "$DOCS_NAME")"
  [[ -n "$DOCS_IMAGE_BEFORE" && -n "$DOCS_STARTED_BEFORE" ]] \
    || refuse "не удалось снять состояние $DOCS_NAME до патча"
  state_set BACKUP_DIR "$BACKUP_DIR"
  state_set LIVE_DEPLOY "$LIVE_DEPLOY"
  state_set DOCUMENTS_NAME "$DOCS_NAME"
  state_set DOCUMENTS_STARTED_BEFORE "$DOCS_STARTED_BEFORE"
  check "бэкап" ok "$BACKUP_DIR (deploy, список контейнеров и образов)"
}

# Замена файлов: временный файл рядом и mv, чтобы compose не увидел наполовину записанный.
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

# Пересоздание ТОЛЬКО app, без зависимостей и без удаления сирот.
recreate_app() {
  phase "пересоздание app"
  log "up -d --no-deps app"
  dc_new up -d --no-deps app >>"$LOG_FILE" 2>&1 \
    || die "$EXIT_FAILED" "compose up app не удался"
  wait_healthy "$CUTOVER_APP_CONTAINER" "$HEALTH_WAIT_S" \
    || die "$EXIT_FAILED" "$CUTOVER_APP_CONTAINER не стал healthy за ${HEALTH_WAIT_S} с"
  check "сервис app" ok "пересоздан, $CUTOVER_APP_CONTAINER работает"
}

# ---------------------------------------------------------------------------------------------
# 3. Проверки после замены
# ---------------------------------------------------------------------------------------------
# Образ запущенного app равен образу из lock.
verify_image() {
  local ref want got
  ref="$(lock_ref "$LOCK_KEY_APP")"
  got="$(container_image_id "$CUTOVER_APP_CONTAINER")"
  want="$(ref_image_id "$ref")"
  printf '%s\t%s\t%s\n' "$CUTOVER_APP_CONTAINER" "$ref" \
    "$([[ "$got" == "$want" ]] && echo совпал || echo ОТЛИЧАЕТСЯ)" >"$RES/images-running.tsv"
  [[ -n "$got" && "$got" == "$want" ]] \
    || die "$EXIT_FAILED" "образ запущенного app не равен lock (${ref##*/})"
  check "образ app = images.lock" ok "digest app совпал с lock (${ref##*/})"
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

# В окружении app обе переменные с нужными значениями (читаются только эти два ключа).
verify_app_env() {
  local key want got bad=0 report=""
  for key in "$YANDEX_CONCURRENCY_KEY" "$YANDEX_INTERVAL_KEY"; do
    want="$YANDEX_CONCURRENCY_WANT"
    [[ "$key" != "$YANDEX_INTERVAL_KEY" ]] || want="$YANDEX_INTERVAL_WANT"
    got="$(container_env_value "$CUTOVER_APP_CONTAINER" "$key")"
    report+=" $key=${got:-<нет>}"
    [[ "$got" == "$want" ]] || bad=$((bad + 1))
  done
  if ((bad > 0)); then
    want="$(wanted_vars | tr '\n' ' ')"
    die "$EXIT_FAILED" "в окружении app неверные значения (ожидается $want):$report"
  fi
  check "окружение app" ok "$report"
}

# documents не изменился: тот же образ и тот же StartedAt (контейнер не перезапускался).
verify_documents_untouched() {
  local image started name
  name="$(service_containers "$DOCUMENTS_SERVICE" | head -1)"
  [[ "$name" == "$DOCS_NAME" ]] || die "$EXIT_FAILED" "контейнер documents сменился: $DOCS_NAME"
  image="$(container_image_id "$name")"
  started="$(container_started "$name")"
  [[ "$image" == "$DOCS_IMAGE_BEFORE" ]] \
    || die "$EXIT_FAILED" "образ $name изменился во время патча"
  [[ "$started" == "$DOCS_STARTED_BEFORE" ]] \
    || die "$EXIT_FAILED" "$name перезапускался: StartedAt $DOCS_STARTED_BEFORE -> $started"
  check "documents не тронут" ok "образ и StartedAt прежние"
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

# Выдержка: app не перезапускается (StartedAt и RestartCount те же), /ready 200.
soak() {
  local started_before restarts_before now_started now_restarts started=$SECONDS left body
  started_before="$(container_started "$CUTOVER_APP_CONTAINER")"
  restarts_before="$(container_restarts "$CUTOVER_APP_CONTAINER")"
  log "выдержка ${SOAK_S} с (проверка каждые ${SOAK_POLL_S} с)"
  while ((SECONDS - started < SOAK_S)); do
    left=$((SOAK_S - (SECONDS - started)))
    sleep "$((SOAK_POLL_S < left ? SOAK_POLL_S : left))"
    now_started="$(container_started "$CUTOVER_APP_CONTAINER")"
    now_restarts="$(container_restarts "$CUTOVER_APP_CONTAINER")"
    [[ "$now_started" == "$started_before" && "$now_restarts" == "$restarts_before" ]] \
      || die "$EXIT_FAILED" "во время выдержки app перезапускался:" \
        "перезапусков $restarts_before -> $now_restarts"
    body="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
    [[ "$body" == 200* ]] || die "$EXIT_FAILED" "во время выдержки /ready не 200: ${body:0:120}"
  done
  check "выдержка ${SOAK_S} с" ok "app не перезапускался, /ready 200"
}

verify_patch() {
  phase "проверки после замены"
  verify_image
  verify_ready
  verify_app_env
  verify_documents_untouched
  report_other_containers
  verify_routes
  soak
  verify_documents_untouched
}

# ---------------------------------------------------------------------------------------------
# Откат
# ---------------------------------------------------------------------------------------------
# rollback_patch <каталог запуска патча>: файлы дерева из бэкапа, up -d --no-deps app на прежний
# образ, проверки. 0 - бой как до патча и проверен; иначе 1.
ROLLBACK_FAILED=0
rb_check() { # rb_check <имя> <ok|fail> <описание>
  check "откат: $1" "$2" "$3"
  [[ "$2" != fail ]] || ROLLBACK_FAILED=$((ROLLBACK_FAILED + 1))
}
rollback_patch() {
  local run="$1" backup live rel body bots name want got started docs_name docs_started
  local saved_state="$STATE_FILE" replaced=()
  STATE_FILE="$run/state.env"
  backup="$(state_get BACKUP_DIR)"
  live="$(state_get LIVE_DEPLOY)"
  docs_name="$(state_get DOCUMENTS_NAME)"
  docs_started="$(state_get DOCUMENTS_STARTED_BEFORE)"
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
    && rb_check "файлы дерева" ok "images.lock и заменённые файлы возвращены из бэкапа" \
    || rb_check "файлы дерева" fail "файлов не совпало с бэкапом: $bad"
  # 2. Только app, на прежний образ: без down, без --remove-orphans.
  CUTOVER_NEW_DIR="$(dirname "$live")"
  dc_new up -d --no-deps app >>"$LOG_FILE" 2>&1 \
    && rb_check "поднят app" ok "up -d --no-deps app" \
    || rb_check "поднят app" fail "compose up не удался"
  # 3. Проверки: /ready, образы контейнеров как до патча, documents не тронут.
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
  if [[ -n "$docs_name" ]]; then
    started="$(container_started "$docs_name")"
    # Только предупреждение: откат app не может «развернуть» чужой перезапуск documents.
    [[ "$started" == "$docs_started" ]] \
      && check "откат: documents" ok "не перезапускался" \
      || check "откат: documents" warn "StartedAt изменился: $docs_started -> $started"
  fi
  ((ROLLBACK_FAILED == 0)) || return 1
  log "ОТКАТ ПАТЧА ВЫПОЛНЕН: файлы дерева из бэкапа, app на прежнем образе, проверки прошли"
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
  check_g8_applied
  check_changes
  check_battle_health
  check_resources
  ensure_images
  stage_tree
  check_rollback_image
  if ((PREFLIGHT_ONLY)); then
    check "режим" ok "--preflight-only: бой не менялся"
    state_set RESULT "PREFLIGHT_OK"
    return 0
  fi
  make_backup
  apply_files
  recreate_app
  verify_patch
  state_set RESULT OK
}
main
