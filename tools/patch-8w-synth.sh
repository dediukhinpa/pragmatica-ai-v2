#!/usr/bin/env bash
# Проверка патч-пакета G8w на синтетическом «бое» (локальный стенд): настоящие compose-файлы
# дерева v2 ПОСЛЕ патча G8, настоящие образы app (прежний и новый из lock этапа 8w); у app вместо
# ядра заглушка /ready, у documents заглушка «200 на всё» (образ documents в lock стенда - образ
# с bun, по умолчанию прежний образ app). Бой (pragmatika-ru) не затрагивается: compose-проект
# pragmatika-p8w, порты 127.0.0.1:21200-21249, пути стенда под $SYNTH.
#
# Скрипт стенд «из воздуха» не создаёт: нужны подготовленные каталоги и образы. Шаг prepare
# проверяет предусловия и печатает, чего нет (дерево v2 после G8, lock'и, подтверждение подписей,
# образы на хосте, свободные порты), затем поднимает documents и app «до патча».
#
# Использование:
#   bash tools/patch-8w-synth.sh [--steps список] [--help]
# Шаги (по умолчанию все по порядку):
#   prepare   проверить предусловия, собрать lock'и стенда, поднять documents и app «до патча»
#             (app на прежнем образе, без переменных Яндекса, смотрит на documents напрямую)
#   preflight patch.sh --preflight-only: код 0, ничего не изменилось
#   refuse    (1) app смотрит на documents-router (имитация «патч G8 не применён»): код 3 с
#             текстом «сначала примените патч G8»; (2) новая конфигурация compose отдаёт app
#             другое значение YANDEX_SEARCH_MIN_INTERVAL_MS: код 3; ничего не изменилось
#   apply     patch.sh: код 0, app на новом образе, обе переменные на месте, documents не
#             перезапускался и не пропадал с порта (опрос хоста), замер простоя app
#   rollback  patch.sh --rollback по успешному запуску: дерево побайтно как до патча, app на
#             прежнем образе
#   broken    во время patch.sh сразу после пересоздания app перезапускается documents (как
#             чужой сбой): проверка «documents не тронут» красная, автооткат (код 1), дерево
#             побайтно как до патча
#   cleanup   убрать стенд (контейнеры, сети проекта)
# Результаты: $OUT/steps.tsv, $OUT/summary.txt, журналы патча $OUT/<шаг>.log.
# Окружение: SYNTH (каталог стенда; дерево v2 после G8 лежит в $SYNTH/opt/pragmatika-v2/deploy:
# compose.yml, compat.env, .env, compose.project.yml, platform/), OUT (каталог результатов),
# LOCK (lock этапа 8w), LOCK_OLD (lock боя после G8, этап 8v), SIGNATURES (вывод
# verify-signatures.sh по LOCK), STUB_IMAGE (образ для заглушки documents; по умолчанию образ app из
# LOCK_OLD), RUNBOOK_FILE (необязательно).
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPORTS="${REPORTS:-$HOME/reports/business-ai-modular}"
STAGE="$REPORTS/stage-8w"
SYNTH="${SYNTH:-$STAGE/tmp/synth}"
OUT="${OUT:-$STAGE/synth}"
LOCK="${LOCK:-$STAGE/images.lock}"
LOCK_OLD="${LOCK_OLD:-$REPORTS/stage-8v/images.lock}"
SIGNATURES="${SIGNATURES:-$STAGE/signatures.txt}"
PROJECT="pragmatika-p8w"
LIVE="$SYNTH/opt/pragmatika-v2"
DEPLOY="$LIVE/deploy"
APP="$PROJECT-app-1"
DOCS="$PROJECT-documents-1"
STANDIN="$ROOT/deploy/patch-8w/standin/patch-8w-stand.compose.yml"
STAND_LOCK_OLD="$OUT/stand-old.lock"
STAND_LOCK_NEW="$OUT/stand-new.lock"
STAND_SIGNATURES="$OUT/stand-signatures.txt"
STEPS_DEFAULT="prepare preflight refuse apply rollback broken cleanup"
STEPS="$STEPS_DEFAULT"
# Диапазон портов стенда на 127.0.0.1 и два порта, которые занимает прогон.
PORT_FIRST=21200
PORT_LAST=21249
PORT_APP=21200
PORT_DOCS=21201
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
DOCS_URL_OK="http://documents:8310"
DOCS_URL_ROUTER="http://documents-router:8310"
BROKEN_INTERVAL="250"
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
mkdir -p "$OUT"
STEPS_FILE="$OUT/steps.tsv"
log() { echo "[patch-8w-synth] $(date -u +%T) $*"; }
result() { # result <проверка> <ok|FAIL> <пояснение>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$STEPS_FILE"
  log "$1: $2 - $3"
  [[ "$2" == ok ]] || FAILS=$((FAILS + 1))
}

# compose стенда «как на бою после G8»: файлы дерева + надстройка стенда (заглушки).
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
container_image() { docker inspect -f '{{.Config.Image}}' "$1" 2>/dev/null || echo отсутствует; }
container_started() { docker inspect -f '{{.State.StartedAt}}' "$1" 2>/dev/null || echo ?; }
# Одна переменная окружения контейнера (остальное окружение не читается и не печатается).
env_of() { # env_of <контейнер> <ИМЯ>
  { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null || true; } \
    | sed -n "s/^$2=//p" | head -1
}
# Код ответа GET с хоста на 127.0.0.1:<порт><путь> (000 - нет ответа): без curl, через /dev/tcp.
http_code() { # http_code <порт> <путь>
  local line
  line="$(timeout "$HTTP_TIMEOUT_S" bash -c '
    exec 3<>"/dev/tcp/127.0.0.1/$0"
    printf "GET %s HTTP/1.0\r\nHost: stand\r\n\r\n" "$1" >&3
    head -n 1 <&3' "$1" "$2" 2>/dev/null || true)"
  if [[ "$line" =~ ^HTTP/[0-9.]+\ ([0-9]{3}) ]]; then echo "${BASH_REMATCH[1]}"; else echo 000; fi
}
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
lock_ref() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2-; }

# Подготовка lock'ов стенда: образ documents заменён на образ-заглушку (в нём есть bun); прочее как
# в lock'ах этапов. Подтверждение подписей пересчитано под новый lock (образ заглушки подписан
# вместе с app: он взят из lock этапа 8v).
derive_stand_locks() {
  local stub="${STUB_IMAGE:-$(lock_ref "$LOCK_OLD" BAI_IMAGE_APP)}"
  sed "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=$stub|" "$LOCK_OLD" >"$STAND_LOCK_OLD"
  sed "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=$stub|" "$LOCK" >"$STAND_LOCK_NEW"
  python3 -I - "$SIGNATURES" "$STAND_LOCK_NEW" "$stub" >"$STAND_SIGNATURES" <<'PY'
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
  STUB_REF="$stub"
}

patch_run() { # patch_run <шаг> [аргументы patch.sh]: код в RC, журнал $OUT/<шаг>.log
  local step="$1"
  shift
  RC=0
  env CUTOVER_PROJECT="$PROJECT" CUTOVER_NEW_DIR="$LIVE" CUTOVER_ENV_FILE="$DEPLOY/.env" \
    CUTOVER_EXTRA_COMPOSE="$STANDIN" CUTOVER_SERVICES="documents app" \
    CUTOVER_HOME="$OUT/home" CUTOVER_BACKUP_ROOT="$OUT/backups" CUTOVER_OUT_DIR="$OUT" \
    CUTOVER_COSIGN=/nonexistent-cosign PATCH8W_SOAK_POLL_S="$SOAK_POLL_S" \
    CUTOVER_EXPECT_BOTS="$EXPECT_BOTS" PATCH8W_MIN_DISK_MIB="$MIN_DISK_MIB" \
    CUTOVER_READY_WAIT_S="$READY_WAIT_S" CUTOVER_HEALTH_WAIT_S="$HEALTH_WAIT_S" \
    bash "$PKG/patch.sh" --soak-seconds "$SOAK_S" "$@" >"$OUT/$step.log" 2>&1 || RC=$?
}

# Контекст отдельных шагов (--steps без prepare): lock'и стенда и время старта documents до патча.
save_context() { printf '%s\n' "$DOCS_STARTED_BEFORE" >"$OUT/docs-started-before.txt"; }
restore_context() {
  [[ -n "$STUB_REF" ]] || derive_stand_locks
  if [[ -z "$DOCS_STARTED_BEFORE" && -f "$OUT/docs-started-before.txt" ]]; then
    DOCS_STARTED_BEFORE="$(cat "$OUT/docs-started-before.txt")"
  fi
}

wait_app_ready() { # wait_app_ready: ждёт 200 на /ready app с хоста (порт заглушки)
  local waited=0
  while ((waited < READY_WAIT_S)); do
    [[ "$(http_code "$PORT_APP" /ready)" == 200 ]] && return 0
    sleep 1
    waited=$((waited + 1))
  done
  return 1
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
    log "Подготовьте дерево v2 ПОСЛЕ патча G8 в $DEPLOY (compose.yml, compat.env, .env," \
      "platform/, compose.project.yml из коммита патча G8) и lock'и этапов 8v и 8w."
    return 1
  fi
  command -v docker >/dev/null || { result "prepare: docker" FAIL "нет docker"; return 1; }
  if grep -q "$YANDEX_CONCURRENCY_KEY" "$DEPLOY/compose.project.yml" \
    "$DEPLOY/platform/compose.base.yml"; then
    result "prepare: дерево стенда до патча" FAIL "в файлах стенда уже есть $YANDEX_CONCURRENCY_KEY"
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
  local ref
  for ref in "$(lock_ref "$LOCK_OLD" BAI_IMAGE_APP)" "$(lock_ref "$LOCK" BAI_IMAGE_APP)" \
    "$STUB_REF"; do
    docker image inspect "$ref" >/dev/null 2>&1 \
      || { result "prepare: образ на хосте" FAIL "нет ${ref##*/} (docker load / pull)"; return 1; }
  done
  result "prepare: образы app (прежний, новый) и заглушки на хосте" ok "все три на месте"
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
  docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.Names}}\t{{.Image}}' | sort >"$OUT/containers-before.txt"
  DOCS_STARTED_BEFORE="$(container_started "$DOCS")"
  save_context
  [[ "$(env_of "$APP" DOCUMENTS_URL)" == "$DOCS_URL_OK" ]] \
    && result "prepare: app смотрит на documents напрямую" ok "$DOCS_URL_OK" \
    || result "prepare: app смотрит на documents напрямую" FAIL "$(env_of "$APP" DOCUMENTS_URL)"
  [[ -z "$(env_of "$APP" "$YANDEX_CONCURRENCY_KEY")" \
    && -z "$(env_of "$APP" "$YANDEX_INTERVAL_KEY")" ]] \
    && result "prepare: в окружении app переменных Яндекса ещё нет" ok "как на бою до патча" \
    || result "prepare: в окружении app переменных Яндекса ещё нет" FAIL "уже заданы"
  [[ "$(http_code "$PORT_APP" /ready)" == 200 && "$(http_code "$PORT_DOCS" /health)" == 200 ]] \
    && result "prepare: заглушки app и documents отвечают с хоста" ok \
      "200 на $PORT_APP, $PORT_DOCS" \
    || result "prepare: заглушки app и documents отвечают с хоста" FAIL "нет 200"
}

build_package() {
  local pkg_out="$OUT/package"
  rm -rf "${pkg_out:?}"
  bash "$HERE/build-patch-8w-package.sh" --out "$pkg_out" --lock "$STAND_LOCK_NEW" \
    --signatures "$STAND_SIGNATURES" ${RUNBOOK_FILE:+--runbook "$RUNBOOK_FILE"} \
    >"$OUT/build-package.log" 2>&1 \
    || { result "package: сборка" FAIL "см. build-package.log (файлы patch-8w должны быть в HEAD)"
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
  grep -q 'патч G8 применён: ok' "$OUT/preflight.log" \
    && result "preflight: патч G8 распознан как применённый" ok "запись в журнале" \
    || result "preflight: патч G8 распознан как применённый" FAIL "нет записи в журнале"
  unchanged_since_prepare preflight
}

step_refuse() {
  # app смотрит на documents-router: предусловие «G8 применён» не выполнено - отказ ДО замены.
  STAND_APP_DOCUMENTS_URL="$DOCS_URL_ROUTER" dcs up -d --no-deps app >>"$OUT/refuse.log" 2>&1 \
    || { result "refuse: подмена адреса documents" FAIL "compose up не удался"; return 1; }
  wait_app_ready || result "refuse: app после подмены" FAIL "/ready не 200"
  patch_run refuse --preflight-only
  [[ "$RC" == 3 ]] && result "refuse: код" ok "3 (отказ по предусловиям)" \
    || result "refuse: код" FAIL "$RC (refuse.log)"
  grep -q 'сначала примените патч G8' "$OUT/refuse.log" \
    && result "refuse: причина" ok "названа: сначала примените патч G8" \
    || result "refuse: причина" FAIL "причина не названа"
  # Вернуть app «как до патча» (адрес documents по умолчанию).
  dcs up -d --no-deps app >>"$OUT/refuse.log" 2>&1 || true
  wait_app_ready || result "refuse: возврат app" FAIL "/ready не 200"
  unchanged_since_prepare refuse
  # Новая конфигурация compose отдаёт app другое значение интервала: отказ до замены.
  STAND_APP_EXTRA_ENV="$YANDEX_INTERVAL_KEY=$BROKEN_INTERVAL" patch_run refuse-config \
    --preflight-only
  [[ "$RC" == 3 ]] && result "refuse: неверное значение в конфигурации, код" ok "3" \
    || result "refuse: неверное значение в конфигурации, код" FAIL "$RC (refuse-config.log)"
  grep -q "$YANDEX_INTERVAL_KEY" "$OUT/refuse-config.log" \
    && result "refuse: причина названа (имя переменной)" ok "$YANDEX_INTERVAL_KEY" \
    || result "refuse: причина названа (имя переменной)" FAIL "не названа"
  unchanged_since_prepare refuse-config
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
  [[ "$(env_of "$APP" "$YANDEX_CONCURRENCY_KEY")" == 1 ]] \
    && result "apply: $YANDEX_CONCURRENCY_KEY=1 в окружении app" ok "1" \
    || result "apply: $YANDEX_CONCURRENCY_KEY=1 в окружении app" FAIL "иное"
  [[ "$(env_of "$APP" "$YANDEX_INTERVAL_KEY")" == 1000 ]] \
    && result "apply: $YANDEX_INTERVAL_KEY=1000 в окружении app" ok "1000" \
    || result "apply: $YANDEX_INTERVAL_KEY=1000 в окружении app" FAIL "иное"
  [[ "$(env_of "$APP" DOCUMENTS_URL)" == "$DOCS_URL_OK" ]] \
    && result "apply: app по-прежнему на documents" ok "$DOCS_URL_OK" \
    || result "apply: app по-прежнему на documents" FAIL "$(env_of "$APP" DOCUMENTS_URL)"
  [[ "$(container_started "$DOCS")" == "$DOCS_STARTED_BEFORE" ]] \
    && result "apply: documents не перезапускался" ok "StartedAt прежний" \
    || result "apply: documents не перезапускался" FAIL "StartedAt изменился"
  [[ "$(container_image "$DOCS")" == "$STUB_REF" ]] \
    && result "apply: образ documents прежний" ok "${STUB_REF##*/}" \
    || result "apply: образ documents прежний" FAIL "$(container_image "$DOCS")"
  local docs_bad app_bad first last
  docs_bad="$(awk '$2 == "docs" && $3 != 200' "$OUT/poll.txt" | wc -l)"
  [[ "$docs_bad" == 0 ]] \
    && result "apply: documents отвечал с хоста всё время" ok \
      "проб $(grep -c ' docs ' "$OUT/poll.txt")" \
    || result "apply: documents отвечал с хоста всё время" FAIL "не 200: $docs_bad проб"
  app_bad="$(awk '$2 == "app" && $3 != 200' "$OUT/poll.txt" | wc -l)"
  first="$(awk '$2 == "app" && $3 != 200 { print $1; exit }' "$OUT/poll.txt")"
  last="$(awk '$2 == "app" && $3 != 200 { t = $1 } END { print t }' "$OUT/poll.txt")"
  if [[ -n "$first" ]]; then
    result "apply: простой app (заглушка)" ok \
      "не отвечал $app_bad проб, около $((last - first + POLL_INTERVAL_MS)) мс"
  else
    result "apply: простой app (заглушка)" ok "опрос простоя не заметил (пересоздание быстрее)"
  fi
  local backup
  backup="$(find "$OUT/backups" -maxdepth 1 -name 'pragmatika-patch8w-*' 2>/dev/null | head -1)"
  [[ -n "$backup" ]] \
    && result "apply: бэкап файлов дерева" ok "$(basename "$backup")" \
    || result "apply: бэкап файлов дерева" FAIL "нет каталога бэкапа"
  RUN_APPLIED="$(readlink -f "$OUT/home/patch-8w-latest")"
}

step_rollback() {
  [[ -n "${RUN_APPLIED:-}" ]] || RUN_APPLIED="$(readlink -f "$OUT/home/patch-8w-latest")"
  patch_run rollback --rollback --run-dir "$RUN_APPLIED"
  [[ "$RC" == 0 ]] && result "rollback: код" ok "0 (rollback.log)" \
    || result "rollback: код" FAIL "$RC (rollback.log)"
  unchanged_since_prepare rollback
  [[ -z "$(env_of "$APP" "$YANDEX_CONCURRENCY_KEY")" ]] \
    && result "rollback: переменных Яндекса в окружении app больше нет" ok "как до патча" \
    || result "rollback: переменных Яндекса в окружении app больше нет" FAIL "остались"
  [[ "$(container_started "$DOCS")" == "$DOCS_STARTED_BEFORE" ]] \
    && result "rollback: documents не перезапускался" ok "StartedAt прежний" \
    || result "rollback: documents не перезапускался" FAIL "StartedAt изменился"
}

step_broken() {
  # Сразу после пересоздания app (его образ стал новым) перезапускается documents: патч не
  # трогает documents, поэтому проверка «documents не тронут» краснеет -> автооткат.
  local new_ref watcher
  new_ref="$(lock_ref "$STAND_LOCK_NEW" BAI_IMAGE_APP)"
  (
    watch_started=$SECONDS
    while [[ "$(container_image "$APP")" != "$new_ref" ]] \
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
  grep -q 'автоматический откат' "$OUT/broken.log" \
    && result "broken: автооткат запущен" ok "запись в журнале" \
    || result "broken: автооткат запущен" FAIL "нет записи"
  grep -q 'ОТКАТ ПАТЧА ВЫПОЛНЕН' "$OUT/broken.log" \
    && result "broken: откат выполнен и проверен" ok "проверки отката прошли" \
    || result "broken: откат выполнен и проверен" FAIL "нет записи об успешном откате"
  unchanged_since_prepare broken
  [[ "$(container_image "$APP")" == "$(lock_ref "$STAND_LOCK_OLD" BAI_IMAGE_APP)" ]] \
    && result "broken: app снова на прежнем образе" ok "как до патча" \
    || result "broken: app снова на прежнем образе" FAIL "$(container_image "$APP")"
  # documents перезапущен самим сценарием: новое время старта принимается за исходное.
  DOCS_STARTED_BEFORE="$(container_started "$DOCS")"
  save_context
}

step_cleanup() {
  dcs down -v --remove-orphans >/dev/null 2>&1 || true
  [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" ]] \
    && result "cleanup: контейнеры стенда убраны" ok "проект $PROJECT пуст" \
    || result "cleanup: контейнеры стенда убраны" FAIL "остались контейнеры"
}

: >"$STEPS_FILE"
PKG="$OUT/package"
STUB_REF=""
DOCS_STARTED_BEFORE=""
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
