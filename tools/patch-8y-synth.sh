#!/usr/bin/env bash
# Проверка патч-пакета G8y на синтетическом «бое» (локальный стенд): настоящие compose-файлы
# дерева v2 ПОСЛЕ патча G8x (платформа 1.1.6, lock 1.1.6-pragmatika.1), настоящие образы app
# (прежний из lock этапа 8x и новый из lock этапа 8y); у app и у documents вместо сервисов
# заглушки на bun, которые отвечают на /health, /ready и POST /docx/amend (образы заглушек
# documents в lock стенда - образы с bun: по умолчанию прежний и новый образы app, чтобы
# пересоздание documents было видно). Заглушка documents отвечает на /docx/amend по логике пробы
# patch.sh (422 bad_request на неверные party и number_edit.mode) и держит четыре флага G8x (они
# приходят из compose.project.yml дерева). Бой (pragmatika-ru) не затрагивается: compose-проект
# pragmatika-p8y, порты 127.0.0.1 в диапазоне P8Y_PORT_BASE..+49 (по умолчанию 21350-21399), пути
# стенда под $SYNTH, контейнеры стенда с меткой bai.stage=8y2.
#
# Скрипт стенд «из воздуха» не создаёт: нужны подготовленные каталоги и образы. Шаг prepare
# проверяет предусловия и печатает, чего нет (дерево v2 после G8x, lock'и, подтверждение подписей,
# образы на хосте, свободные порты), затем поднимает documents и app «до патча».
#
# Использование:
#   bash tools/patch-8y-synth.sh [--steps список] [--help]
# Шаги (по умолчанию все по порядку):
#   prepare   проверить предусловия, собрать lock'и стенда, поднять documents и app «до патча»
#             (образы G8x, у documents четыре флага G8x, у app переменные поиска G8w)
#   preflight patch.sh --preflight-only: код 0, ничего не изменилось
#   refuse    платформа боя 1.1.5 (имитация «патч G8x не применён»): код 3 с текстом «сначала
#             примените патч G8x»; ничего не изменилось
#   apply     patch.sh: код 0, documents и app на новых образах, четыре флага G8x в окружении
#             documents на месте, переменные поиска у app на месте, проба POST /docx/amend с новыми
#             параметрами отвечает с хоста (422 bad_request), замер простоя documents и app
#             (опрос хоста)
#   rollback  patch.sh --rollback по успешному запуску: дерево побайтно как до патча, documents и
#             app на прежних образах
#   broken    во время выдержки patch.sh перезапускается documents (как чужой сбой): проверка
#             выдержки красная, автооткат (код 1), дерево побайтно как до патча
#   cleanup   убрать стенд (контейнеры, сети проекта)
# Результаты: $OUT/steps.tsv, $OUT/summary.txt, журналы патча $OUT/<шаг>.log.
# Окружение: SYNTH (каталог стенда; дерево v2 после G8x лежит в $SYNTH/opt/pragmatika-v2/deploy:
# compose.yml, compat.env, .env, compose.project.yml, platform/), OUT (каталог результатов),
# LOCK (lock этапа 8y), LOCK_OLD (lock боя после G8x, этап 8x), SIGNATURES (вывод
# verify-signatures.sh по LOCK), STUB_IMAGE_OLD и STUB_IMAGE_NEW (образы с bun для заглушек
# documents до и после патча; по умолчанию образы app из LOCK_OLD и LOCK), RUNBOOK_FILE
# (необязательно), P8Y_PORT_BASE (первый порт диапазона стенда из 50 портов; по умолчанию 21350),
# PATCH8Y_AMEND_PROBE_STATUS и PATCH8Y_AMEND_PROBE_ERROR (ожидаемые статус и код ошибки пробы
# /docx/amend, если настоящий образ отвечает иначе; передаются patch.sh).
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPORTS="${REPORTS:-$HOME/reports/business-ai-modular}"
STAGE="${STAGE_DIR:-$REPORTS/stage-8y2}"
SYNTH="${SYNTH:-$STAGE/tmp/synth}"
OUT="${OUT:-$STAGE/synth}"
LOCK="${LOCK:-$STAGE/images.lock}"
LOCK_OLD="${LOCK_OLD:-$REPORTS/stage-8x/images.lock}"
SIGNATURES="${SIGNATURES:-$STAGE/signatures.txt}"
PROJECT="pragmatika-p8y"
STAGE_LABEL="bai.stage=8y2"
LIVE="$SYNTH/opt/pragmatika-v2"
DEPLOY="$LIVE/deploy"
APP="$PROJECT-app-1"
DOCS="$PROJECT-documents-1"
STANDIN="$ROOT/deploy/patch-8y/standin/patch-8y-stand.compose.yml"
STAND_LOCK_OLD="$OUT/stand-old.lock"
STAND_LOCK_NEW="$OUT/stand-new.lock"
STAND_SIGNATURES="$OUT/stand-signatures.txt"
STEPS_DEFAULT="prepare preflight refuse apply rollback broken cleanup"
STEPS="$STEPS_DEFAULT"
# Диапазон портов стенда на 127.0.0.1 (база из P8Y_PORT_BASE) и два порта, которые занимает прогон.
PORT_COUNT=50
PORT_FIRST="${P8Y_PORT_BASE:-21350}"
PORT_LAST=$((PORT_FIRST + PORT_COUNT - 1))
PORT_APP="$PORT_FIRST"
PORT_DOCS=$((PORT_FIRST + 1))
SOAK_S=20
SOAK_POLL_S=5
READY_WAIT_S=120
HEALTH_WAIT_S=180
MIN_DISK_MIB=2048
EXPECT_BOTS=4
SETTLE_S=15
POLL_INTERVAL_S=0.2
POLL_INTERVAL_MS=200
HTTP_TIMEOUT_S=3
WATCH_TIMEOUT_S=300
YANDEX_CONCURRENCY_KEY="YANDEX_SEARCH_MAX_CONCURRENCY"
YANDEX_INTERVAL_KEY="YANDEX_SEARCH_MIN_INTERVAL_MS"
# Четыре флага G8x documents: признак «G8x применён», при патче не должны потеряться.
DOCS_FLAGS=(DOCUMENTS_EDIT_PPTX=true DOCUMENTS_EDIT_PDF=true DOCUMENTS_PPT_CONVERT=true
  DOCUMENTS_EDIT_PDF_FALLBACK_FONT=false)
PLATFORM_NOW="1.1.6"
PLATFORM_OLD="1.1.5"
LOCK_VERSION_FROM="1.1.6-pragmatika.1"
# Проба /docx/amend (как в patch.sh): путь, тело, ожидаемые статус и код ошибки.
AMEND_ROUTE="/docx/amend"
AMEND_BODY='{"file_name":"probe.docx","content_base64":"","party":"zz",'
AMEND_BODY+='"number_edit":{"mode":"zz","text":"1"}}'
AMEND_STATUS="${PATCH8Y_AMEND_PROBE_STATUS:-422}"
AMEND_ERROR="${PATCH8Y_AMEND_PROBE_ERROR:-bad_request}"
FAILS=0
POLL_FLAG="$OUT/poll.flag"
NEEDED_FILES=(compose.yml compat.env .env compose.project.yml platform/compose.base.yml
  platform/PLATFORM-VERSION)

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
while (($#)); do
  case "$1" in
    --steps) STEPS="${2:?--steps список}"; shift ;;
    --help | -h) usage; exit 0 ;;
    *) echo "неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$PORT_FIRST" =~ ^[0-9]+$ ]] || { echo "P8Y_PORT_BASE: нужно число" >&2; exit 2; }
mkdir -p "$OUT"
STEPS_FILE="$OUT/steps.tsv"
log() { echo "[patch-8y-synth] $(date -u +%T) $*"; }
result() { # result <проверка> <ok|FAIL> <пояснение>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$STEPS_FILE"
  log "$1: $2 - $3"
  [[ "$2" == ok ]] || FAILS=$((FAILS + 1))
}

export STAND_APP_PORT="$PORT_APP"
export STAND_DOCS_PORT="$PORT_DOCS"

# compose стенда «как на бою после G8x»: файлы дерева + надстройка стенда (заглушки).
dcs() {
  local envs=(--env-file "$DEPLOY/images.lock" --env-file "$DEPLOY/.env") f
  for f in secrets.env secrets.mask.env; do
    [[ ! -f "$DEPLOY/$f" ]] || envs+=(--env-file "$DEPLOY/$f")
  done
  docker compose -p "$PROJECT" "${envs[@]}" -f "$DEPLOY/compose.yml" -f "$STANDIN" "$@"
}

# Хэши и права файлов дерева (без временных): для сравнения «до» и «после» побайтно.
tree_hash() { (cd "$DEPLOY" && find . -type f ! -name '*.patch-new' ! -name '*.rb-new' \
  | sort | xargs -d '\n' sha256sum && find . -type f ! -name '*.patch-new' ! -name '*.rb-new' \
  -printf '%m %p\n' | sort); }
# Хэши файлов дерева, КРОМЕ images.lock (патч G8y другие файлы менять не вправе).
tree_hash_no_lock() { (cd "$DEPLOY" && find . -type f ! -name 'images.lock' \
  ! -name '*.patch-new' ! -name '*.rb-new' | sort | xargs -d '\n' sha256sum); }
container_image() { docker inspect -f '{{.Config.Image}}' "$1" 2>/dev/null || echo отсутствует; }
container_started() { docker inspect -f '{{.State.StartedAt}}' "$1" 2>/dev/null || echo ?; }
# Одна переменная окружения контейнера (остальное окружение не читается и не печатается).
env_of() { # env_of <контейнер> <ИМЯ>
  { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null || true; } \
    | sed -n "s/^$2=//p" | head -1
}
# Ответ с хоста на 127.0.0.1:<порт><путь> без curl, через /dev/tcp: «код [тело]»; 000 - нет ответа.
# Метод GET или POST (POST с телом из четвёртого аргумента, по умолчанию {}).
http_reply() { # http_reply <порт> <путь> [метод] [тело]
  local raw body="${4-}"
  [[ -n "$body" ]] || body='{}'
  raw="$(timeout "$HTTP_TIMEOUT_S" bash -c '
    exec 3<>"/dev/tcp/127.0.0.1/$0"
    if [[ "$2" == POST ]]; then
      printf "POST %s HTTP/1.0\r\nHost: stand\r\nContent-Type: application/json\r\n" "$1" >&3
      printf "Content-Length: %s\r\n\r\n%s" "${#3}" "$3" >&3
    else
      printf "GET %s HTTP/1.0\r\nHost: stand\r\n\r\n" "$1" >&3
    fi
    cat <&3' "$1" "$2" "${3:-GET}" "$body" 2>/dev/null || true)"
  raw="${raw//$'\r'/}"
  if [[ "$raw" =~ ^HTTP/[0-9.]+\ ([0-9]{3}) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    sed -n '/^$/,$p' <<<"$raw" | tail -n +2
  else
    echo 000
  fi
}
http_code() { http_reply "$@" | head -n 1; }
# Проба amend с хоста: «статус код_ошибки» (только detail.error, остальное тело не печатается).
amend_from_host() {
  local reply code err
  reply="$(http_reply "$PORT_DOCS" "$AMEND_ROUTE" POST "$AMEND_BODY")"
  code="$(head -n 1 <<<"$reply")"
  err="$(tail -n +2 <<<"$reply" | grep -oE '"error" *: *"[a-z_]{1,64}"' | head -1 \
    | sed -E 's/.*"([a-z_]+)"$/\1/' || true)"
  echo "$code ${err:--}"
}
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
lock_ref() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2-; }

# Подготовка lock'ов стенда: образ documents заменён на образы-заглушки (в них есть bun): прежний
# в lock боя, новый в lock пакета; прочее как в lock'ах этапов. Подтверждение подписей пересчитано
# под новый lock (образы заглушек подписаны вместе с app: они взяты из lock'ов этапов 8x и 8y).
derive_stand_locks() {
  STUB_OLD="${STUB_IMAGE_OLD:-$(lock_ref "$LOCK_OLD" BAI_IMAGE_APP)}"
  STUB_NEW="${STUB_IMAGE_NEW:-$(lock_ref "$LOCK" BAI_IMAGE_APP)}"
  sed "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=$STUB_OLD|" "$LOCK_OLD" >"$STAND_LOCK_OLD"
  sed "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=$STUB_NEW|" "$LOCK" >"$STAND_LOCK_NEW"
  python3 -I - "$SIGNATURES" "$STAND_LOCK_NEW" "$STUB_NEW" >"$STAND_SIGNATURES" <<'PY'
import hashlib, sys
sig, lock, stub = sys.argv[1:4]
digest = hashlib.sha256(open(lock, "rb").read()).hexdigest()
for line in open(sig, encoding="utf-8").read().splitlines():
    if line.startswith("lock_sha256="):
        line = f"lock_sha256={digest}"
    elif line.startswith("image\tBAI_IMAGE_DOCUMENTS\t"):
        line = f"image\tBAI_IMAGE_DOCUMENTS\t{stub}\tOK"
    print(line)
PY
}

patch_run() { # patch_run <шаг> [аргументы patch.sh]: код в RC, журнал $OUT/<шаг>.log
  local step="$1"
  shift
  RC=0
  env CUTOVER_PROJECT="$PROJECT" CUTOVER_NEW_DIR="$LIVE" CUTOVER_ENV_FILE="$DEPLOY/.env" \
    CUTOVER_EXTRA_COMPOSE="$STANDIN" CUTOVER_EXTRA_ENV="${STAND_EXTRA_ENV:-}" \
    CUTOVER_SERVICES="documents app" \
    CUTOVER_HOME="$OUT/home" CUTOVER_BACKUP_ROOT="$OUT/backups" CUTOVER_OUT_DIR="$OUT" \
    CUTOVER_COSIGN=/nonexistent-cosign PATCH8Y_SOAK_POLL_S="$SOAK_POLL_S" \
    CUTOVER_EXPECT_BOTS="$EXPECT_BOTS" PATCH8Y_MIN_DISK_MIB="$MIN_DISK_MIB" \
    PATCH8Y_AMEND_PROBE_STATUS="$AMEND_STATUS" PATCH8Y_AMEND_PROBE_ERROR="$AMEND_ERROR" \
    CUTOVER_READY_WAIT_S="$READY_WAIT_S" CUTOVER_HEALTH_WAIT_S="$HEALTH_WAIT_S" \
    bash "$PKG/patch.sh" --soak-seconds "$SOAK_S" "$@" >"$OUT/$step.log" 2>&1 || RC=$?
}

# Контекст отдельных шагов (--steps без prepare): lock'и стенда и пакет.
restore_context() {
  [[ -n "$STUB_OLD" ]] || derive_stand_locks
  [[ -f "$PKG/patch.sh" ]] || build_package
}

# ---------------------------------------------------------------------------------------------
step_prepare() {
  log "стенд: предусловия"
  local missing=() f port
  for f in "${NEEDED_FILES[@]}"; do
    [[ -f "$DEPLOY/$f" ]] || missing+=("$DEPLOY/$f")
  done
  for f in "$LOCK" "$LOCK_OLD" "$SIGNATURES" "$STANDIN"; do
    [[ -f "$f" ]] || missing+=("$f")
  done
  if ((${#missing[@]} > 0)); then
    result "prepare: подготовленные каталоги и файлы" FAIL "нет: ${missing[*]}"
    log "Подготовьте дерево v2 ПОСЛЕ патча G8x в $DEPLOY (compose.yml, compat.env, .env," \
      "platform/ версии $PLATFORM_NOW, compose.project.yml из коммита патча G8x) и lock'и" \
      "этапов 8x и 8y."
    return 1
  fi
  command -v docker >/dev/null || { result "prepare: docker" FAIL "нет docker"; return 1; }
  local flag
  for flag in "${DOCS_FLAGS[@]%%=*}"; do
    if ! grep -q "$flag" "$DEPLOY/compose.project.yml"; then
      result "prepare: дерево стенда после G8x" FAIL "в compose.project.yml нет $flag"
      return 1
    fi
  done
  if ! grep -q "$YANDEX_CONCURRENCY_KEY" "$DEPLOY/compose.project.yml"; then
    result "prepare: дерево стенда после G8w" FAIL \
      "в compose.project.yml нет $YANDEX_CONCURRENCY_KEY"
    return 1
  fi
  if ! grep -qx "PLATFORM_PACKAGES_VERSION=$PLATFORM_NOW" "$DEPLOY/platform/PLATFORM-VERSION"; then
    result "prepare: платформа стенда" FAIL "в PLATFORM-VERSION не $PLATFORM_NOW"
    return 1
  fi
  if ! grep -qx "BAI_VERSION=$LOCK_VERSION_FROM" "$LOCK_OLD"; then
    result "prepare: lock боя G8x" FAIL "в $LOCK_OLD не BAI_VERSION=$LOCK_VERSION_FROM"
    return 1
  fi
  for ((port = PORT_FIRST; port <= PORT_LAST; port++)); do
    if port_busy "$port"; then
      result "prepare: порты стенда $PORT_FIRST-$PORT_LAST свободны" FAIL "занят порт $port"
      return 1
    fi
  done
  result "prepare: предусловия" ok "дерево, lock'и, подписи, порты $PORT_FIRST-$PORT_LAST"
  derive_stand_locks
  if [[ "$STUB_OLD" == "$STUB_NEW" ]]; then
    result "prepare: образы заглушек documents различаются" FAIL "прежний и новый совпали"
    return 1
  fi
  local ref
  for ref in "$(lock_ref "$LOCK_OLD" BAI_IMAGE_APP)" "$(lock_ref "$LOCK" BAI_IMAGE_APP)" \
    "$STUB_OLD" "$STUB_NEW"; do
    docker image inspect "$ref" >/dev/null 2>&1 \
      || { result "prepare: образ на хосте" FAIL "нет ${ref##*/} (docker load / pull)"; return 1; }
  done
  result "prepare: образы app и заглушек documents на хосте" ok "прежние и новые на месте"
  dcs down -v --remove-orphans >/dev/null 2>&1 || true
  cp "$STAND_LOCK_OLD" "$DEPLOY/images.lock"
  date -u +%FT%TZ >"$DEPLOY/.cutover-deployed"
  local svc
  for svc in documents app; do
    dcs up -d --no-deps "$svc" >>"$OUT/prepare.log" 2>&1 \
      || { result "prepare: up $svc" FAIL "compose up не удался (prepare.log)"; return 1; }
  done
  sleep "$SETTLE_S"
  tree_hash >"$OUT/tree-before.sha"
  tree_hash_no_lock >"$OUT/tree-before-no-lock.sha"
  docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.Names}}\t{{.Image}}' | sort >"$OUT/containers-before.txt"
  [[ -n "$(env_of "$APP" "$YANDEX_CONCURRENCY_KEY")" \
    && -n "$(env_of "$APP" "$YANDEX_INTERVAL_KEY")" ]] \
    && result "prepare: у app переменные поиска G8w" ok "как на бою после G8w" \
    || result "prepare: у app переменные поиска G8w" FAIL "нет"
  check_docs_flags prepare "до патча"
  [[ "$(http_code "$PORT_APP" /ready)" == 200 && "$(http_code "$PORT_DOCS" /health)" == 200 ]] \
    && result "prepare: заглушки app и documents отвечают с хоста" ok \
      "200 на $PORT_APP, $PORT_DOCS" \
    || result "prepare: заглушки app и documents отвечают с хоста" FAIL "нет 200"
  [[ "$(amend_from_host)" == "$AMEND_STATUS $AMEND_ERROR" ]] \
    && result "prepare: заглушка documents отвечает на POST $AMEND_ROUTE" ok \
      "$AMEND_STATUS $AMEND_ERROR" \
    || result "prepare: заглушка documents отвечает на POST $AMEND_ROUTE" FAIL \
      "иной ответ: $(amend_from_host)"
  [[ "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=$STAGE_LABEL" | wc -l)" == 2 ]] \
    && result "prepare: контейнеры стенда с меткой $STAGE_LABEL" ok "documents и app" \
    || result "prepare: контейнеры стенда с меткой $STAGE_LABEL" FAIL "метки нет"
}

# check_docs_flags <шаг> <когда>: четыре флага G8x в окружении documents стенда.
check_docs_flags() {
  local item key got bad=""
  for item in "${DOCS_FLAGS[@]}"; do
    key="${item%%=*}"
    got="$(env_of "$DOCS" "$key")"
    [[ "$got" == "${item#*=}" ]] || bad+=" $key=${got:-<нет>}"
  done
  [[ -z "$bad" ]] \
    && result "$1: четыре флага G8x в окружении documents ($2)" ok "${DOCS_FLAGS[*]}" \
    || result "$1: четыре флага G8x в окружении documents ($2)" FAIL "$bad"
}

build_package() {
  local pkg_out="$OUT/package"
  rm -rf "${pkg_out:?}"
  bash "$HERE/build-patch-8y-package.sh" --out "$pkg_out" --lock "$STAND_LOCK_NEW" \
    --signatures "$STAND_SIGNATURES" ${RUNBOOK_FILE:+--runbook "$RUNBOOK_FILE"} \
    >"$OUT/build-package.log" 2>&1 \
    || { result "package: сборка" FAIL "см. build-package.log (файлы patch-8y должны быть в HEAD)"
      return 1; }
  PKG="$pkg_out"
  result "package: сборка" ok "$(find "$pkg_out" -type f | wc -l) файлов"
}

unchanged_since_prepare() { # unchanged_since_prepare <метка>
  local label="$1"
  if diff <(tree_hash) "$OUT/tree-before.sha" >/dev/null; then
    result "$label: файлы дерева прежние" ok "побайтно как до патча"
  else
    result "$label: файлы дерева прежние" FAIL "дерево изменилось"
  fi
  if diff <(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.Names}}\t{{.Image}}' | sort) "$OUT/containers-before.txt" >/dev/null; then
    result "$label: контейнеры и образы прежние" ok "набор и образы как до патча"
  else
    result "$label: контейнеры и образы прежние" FAIL "набор или образы изменились"
  fi
}

step_preflight() {
  build_package || return 1
  patch_run preflight --preflight-only
  [[ "$RC" == 0 ]] && result "preflight: код" ok "0 (PREFLIGHT_OK)" \
    || result "preflight: код" FAIL "$RC (preflight.log)"
  grep -q 'патч G8x применён: ok' "$OUT/preflight.log" \
    && result "preflight: патч G8x распознан как применённый" ok "запись в журнале" \
    || result "preflight: патч G8x распознан как применённый" FAIL "нет записи в журнале"
  grep -q 'флаги documents в конфигурации: ok' "$OUT/preflight.log" \
    && result "preflight: флаги documents в новой конфигурации" ok "запись в журнале" \
    || result "preflight: флаги documents в новой конфигурации" FAIL "нет записи в журнале"
  unchanged_since_prepare preflight
}

step_refuse() {
  # Платформа боя 1.1.5: предусловие «G8x применён» не выполнено - отказ ДО замены.
  local keep="$OUT/platform-version.keep"
  cp -p "$DEPLOY/platform/PLATFORM-VERSION" "$keep"
  echo "PLATFORM_PACKAGES_VERSION=$PLATFORM_OLD" >"$DEPLOY/platform/PLATFORM-VERSION"
  patch_run refuse --preflight-only
  cp -p "$keep" "$DEPLOY/platform/PLATFORM-VERSION"
  [[ "$RC" == 3 ]] && result "refuse: код (G8x не применён)" ok "3 (отказ по предусловиям)" \
    || result "refuse: код (G8x не применён)" FAIL "$RC (refuse.log)"
  grep -q 'сначала примените патч G8x' "$OUT/refuse.log" \
    && result "refuse: причина" ok "названа: сначала примените патч G8x" \
    || result "refuse: причина" FAIL "причина не названа"
  unchanged_since_prepare refuse
}

# Опрос заглушек с хоста, пока существует флаг: «мс-время имя код» в $OUT/poll.txt.
poll_stand() {
  local now
  while [[ -e "$POLL_FLAG" ]]; do
    now="$(date +%s%3N)"
    printf '%s docs %s\n' "$now" "$(http_code "$PORT_DOCS" /health)" >>"$OUT/poll.txt"
    printf '%s app %s\n' "$now" "$(http_code "$PORT_APP" /ready)" >>"$OUT/poll.txt"
    sleep "$POLL_INTERVAL_S"
  done
}

# downtime <имя в poll.txt> <метка>: число проб не 200 и оценка простоя (мс).
downtime() {
  local who="$1" label="$2" bad first last
  bad="$(awk -v w="$who" '$2 == w && $3 != 200' "$OUT/poll.txt" | wc -l)"
  first="$(awk -v w="$who" '$2 == w && $3 != 200 { print $1; exit }' "$OUT/poll.txt")"
  last="$(awk -v w="$who" '$2 == w && $3 != 200 { t = $1 } END { print t }' "$OUT/poll.txt")"
  if [[ -n "$first" ]]; then
    result "apply: простой $label (заглушка)" ok \
      "не отвечал $bad проб, около $((last - first + POLL_INTERVAL_MS)) мс"
  else
    result "apply: простой $label (заглушка)" ok "опрос простоя не заметил (пересоздание быстрее)"
  fi
}

step_apply() {
  local poll_pid
  : >"$OUT/poll.txt"
  : >"$POLL_FLAG"
  poll_stand &
  poll_pid=$!
  patch_run apply
  rm -f "$POLL_FLAG"
  wait "$poll_pid" 2>/dev/null || true
  [[ "$RC" == 0 ]] && result "apply: код" ok "0 (apply.log)" \
    || result "apply: код" FAIL "$RC (apply.log)"
  local ref
  ref="$(lock_ref "$STAND_LOCK_NEW" BAI_IMAGE_APP)"
  [[ "$(container_image "$APP")" == "$ref" ]] \
    && result "apply: app на новом образе" ok "${ref##*/}" \
    || result "apply: app на новом образе" FAIL "$(container_image "$APP")"
  [[ "$(container_image "$DOCS")" == "$STUB_NEW" ]] \
    && result "apply: documents на новом образе" ok "${STUB_NEW##*/}" \
    || result "apply: documents на новом образе" FAIL "$(container_image "$DOCS")"
  cmp -s "$DEPLOY/images.lock" "$STAND_LOCK_NEW" \
    && result "apply: images.lock боя равен lock пакета" ok "версия $(lock_ref "$STAND_LOCK_NEW" \
      BAI_VERSION)" \
    || result "apply: images.lock боя равен lock пакета" FAIL "различаются"
  diff <(tree_hash_no_lock) "$OUT/tree-before-no-lock.sha" >/dev/null \
    && result "apply: все файлы дерева, кроме images.lock, прежние" ok "побайтно" \
    || result "apply: все файлы дерева, кроме images.lock, прежние" FAIL "изменились"
  check_docs_flags apply "после патча"
  [[ -n "$(env_of "$APP" "$YANDEX_CONCURRENCY_KEY")" \
    && -n "$(env_of "$APP" "$YANDEX_INTERVAL_KEY")" ]] \
    && result "apply: переменные Яндекса у app сохранились" ok "обе на месте" \
    || result "apply: переменные Яндекса у app сохранились" FAIL "пропали"
  [[ "$(amend_from_host)" == "$AMEND_STATUS $AMEND_ERROR" ]] \
    && result "apply: POST $AMEND_ROUTE с новыми параметрами отвечает с хоста" ok \
      "$AMEND_STATUS $AMEND_ERROR" \
    || result "apply: POST $AMEND_ROUTE с новыми параметрами отвечает с хоста" FAIL \
      "иной ответ: $(amend_from_host)"
  grep -q 'проба /docx/amend: ok' "$OUT/apply.log" \
    && result "apply: проба /docx/amend прошла в patch.sh" ok "запись в журнале" \
    || result "apply: проба /docx/amend прошла в patch.sh" FAIL "нет записи в журнале"
  [[ "$(container_started "$DOCS")" < "$(container_started "$APP")" ]] \
    && result "apply: documents пересоздан раньше app" ok "StartedAt documents раньше" \
    || result "apply: documents пересоздан раньше app" FAIL "порядок иной"
  downtime docs documents
  downtime app app
  [[ "$(tail -2 "$OUT/poll.txt" | awk '$3 == 200' | wc -l)" == 2 ]] \
    && result "apply: в конце опроса documents и app отвечают" ok "200 и 200" \
    || result "apply: в конце опроса documents и app отвечают" FAIL "нет 200"
  local backup
  backup="$(find "$OUT/backups" -maxdepth 1 -name 'pragmatika-patch8y-*' 2>/dev/null | head -1)"
  [[ -n "$backup" ]] \
    && result "apply: бэкап файлов дерева" ok "$(basename "$backup")" \
    || result "apply: бэкап файлов дерева" FAIL "нет каталога бэкапа"
  RUN_APPLIED="$(readlink -f "$OUT/home/patch-8y-latest")"
}

step_rollback() {
  [[ -n "${RUN_APPLIED:-}" ]] || RUN_APPLIED="$(readlink -f "$OUT/home/patch-8y-latest")"
  patch_run rollback --rollback --run-dir "$RUN_APPLIED"
  [[ "$RC" == 0 ]] && result "rollback: код" ok "0 (rollback.log)" \
    || result "rollback: код" FAIL "$RC (rollback.log)"
  unchanged_since_prepare rollback
  check_docs_flags rollback "после отката"
  [[ "$(http_code "$PORT_APP" /ready)" == 200 && "$(http_code "$PORT_DOCS" /health)" == 200 ]] \
    && result "rollback: documents и app отвечают с хоста" ok "200 и 200" \
    || result "rollback: documents и app отвечают с хоста" FAIL "нет 200"
}

step_broken() {
  # Во время выдержки (в журнале патча появилась строка «выдержка») перезапускается documents:
  # проверка выдержки краснеет -> автооткат.
  local watcher
  : >"$OUT/broken.log"
  (
    watch_started=$SECONDS
    while ! grep -q 'выдержка' "$OUT/broken.log" 2>/dev/null \
      && ((SECONDS - watch_started < WATCH_TIMEOUT_S)); do
      sleep "$POLL_INTERVAL_S"
    done
    docker restart "$DOCS" >>"$OUT/broken-watcher.log" 2>&1 || true
  ) &
  watcher=$!
  patch_run broken
  wait "$watcher" 2>/dev/null || true
  [[ "$RC" == 1 ]] && result "broken: код" ok "1 (сбой, откат выполнен)" \
    || result "broken: код" FAIL "$RC (broken.log)"
  grep -q 'во время выдержки' "$OUT/broken.log" \
    && result "broken: причина - перезапуск во время выдержки" ok "запись в журнале" \
    || result "broken: причина - перезапуск во время выдержки" FAIL "нет записи"
  grep -q 'автоматический откат' "$OUT/broken.log" \
    && result "broken: автооткат запущен" ok "запись в журнале" \
    || result "broken: автооткат запущен" FAIL "нет записи"
  grep -q 'ОТКАТ ПАТЧА ВЫПОЛНЕН' "$OUT/broken.log" \
    && result "broken: откат выполнен и проверен" ok "проверки отката прошли" \
    || result "broken: откат выполнен и проверен" FAIL "нет записи об успешном откате"
  unchanged_since_prepare broken
  [[ "$(container_image "$APP")" == "$(lock_ref "$STAND_LOCK_OLD" BAI_IMAGE_APP)" \
    && "$(container_image "$DOCS")" == "$STUB_OLD" ]] \
    && result "broken: documents и app снова на образах G8x" ok "как до патча" \
    || result "broken: documents и app снова на образах G8x" FAIL \
      "app $(container_image "$APP"), documents $(container_image "$DOCS")"
}

step_cleanup() {
  dcs down -v --remove-orphans >/dev/null 2>&1 || true
  [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" ]] \
    && result "cleanup: контейнеры стенда убраны" ok "проект $PROJECT пуст" \
    || result "cleanup: контейнеры стенда убраны" FAIL "остались контейнеры"
}

: >"$STEPS_FILE"
PKG="$OUT/package"
STUB_OLD=""
STUB_NEW=""
run_step() { # run_step <шаг>: контекст и вызов шага
  case "$1" in
    prepare) step_prepare ;;
    preflight) restore_context; step_preflight ;;
    refuse) restore_context; step_refuse ;;
    apply) restore_context; step_apply ;;
    rollback) restore_context; step_rollback ;;
    broken) restore_context; step_broken ;;
    cleanup) step_cleanup ;;
    *) echo "неизвестный шаг $1" >&2; exit 2 ;;
  esac
}
for s in $STEPS; do
  log "=== шаг $s"
  # Шаг прерван (не выполнено предусловие): итог всё равно пишется, остальные шаги пропускаются.
  if ! run_step "$s"; then
    log "шаг $s прерван"
    ((FAILS > 0)) || FAILS=1
    break
  fi
done
TOTAL="$(wc -l <"$STEPS_FILE")"
{ echo "проверок: $TOTAL, провалено: $FAILS"; cat "$STEPS_FILE"; } >"$OUT/summary.txt"
log "итог: проверок $TOTAL, провалено $FAILS (summary.txt)"
[[ "$FAILS" -eq 0 ]]
