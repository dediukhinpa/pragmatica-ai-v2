#!/usr/bin/env bash
# Проверка патч-пакета G8z на синтетическом «бое» (локальный стенд): настоящие compose-файлы
# дерева v2 ПОСЛЕ патча G8y (платформа 1.1.6, lock 1.1.6-pragmatika.2, compose.project.yml без двух
# новых переменных app), настоящие образы app (прежний из lock этапа 8y2 и новый из lock этапа
# 8z); у app и у documents вместо сервисов заглушки на bun, которые отвечают на /health, /ready и
# POST /docx/amend (образ заглушки documents в lock стенда - образ с bun: по умолчанию прежний
# образ app; он ОДИН И ТОТ ЖЕ до и после патча, потому что G8z documents не меняет). Заглушка
# documents отвечает на /docx/amend по логике пробы patch.sh (422 bad_request на неверные party и
# number_edit.mode) и держит четыре флага G8x (они приходят из compose.project.yml дерева). Бой
# (pragmatika-ru) не затрагивается: compose-проект pragmatika-p8z, порты 127.0.0.1 в диапазоне
# P8Z_PORT_BASE..+49 (по умолчанию 21400-21449), пути стенда под $SYNTH, контейнеры стенда с
# меткой bai.stage=8z.
#
# Тяжёлый прогон (docker, образы): запускать под общей блокировкой heavy.lock; скрипт сам
# перезапускается под `flock` (P8Z_NO_LOCK=1 - не брать блокировку, например если её уже держит
# вызывающий) и перед прогоном пишет замер `free -m` и `df -h /` в $OUT/resources-before.txt и в
# вывод.
#
# Скрипт стенд «из воздуха» не создаёт: нужны образы и lock'и. Шаг prepare проверяет
# предусловия и печатает, чего нет (lock'и, подтверждение подписей, образы на хосте, свободные
# порты); если в $SYNTH нет дерева v2, оно собирается из HEAD репозитория: compose.yml, compat.env,
# platform/compose.base.yml, platform/PLATFORM-VERSION, compose.project.yml БЕЗ двух новых
# переменных G8z (состояние «G8y применён») и синтетический .env из .env.example; затем
# поднимает documents и app «до патча».
#
# Использование:
#   bash tools/patch-8z-synth.sh [--steps список] [--help]
# Шаги (по умолчанию все по порядку):
#   prepare   проверить предусловия, собрать lock'и стенда и дерево, поднять documents и app «до
#             патча» (образы G8y, у documents четыре флага G8x, у app переменные поиска G8w, у app
#             НЕТ новых переменных G8z)
#   preflight patch.sh --preflight-only: код 0, ничего не изменилось
#   refuse    lock боя версии 1.1.6-pragmatika.1 (имитация «патч G8y не применён»): код 3 с
#             текстом «сначала примените патч G8y»; ничего не изменилось. Отказа по флагу в .env
#             нет: явный false в .env - выключатель (сценарий offswitch)
#   apply     patch.sh: код 0; app на новом образе, documents НЕ перезапускался (тот же образ и
#             StartedAt, опрос с хоста не заметил простоя documents), images.lock и
#             compose.project.yml боя равны пакету, остальные файлы дерева (в том числе .env)
#             побайтно прежние, у app обе новые переменные = true (в .env стенда их нет, значение
#             по умолчанию compose), четыре флага G8x и переменные поиска на месте, проба POST
#             /docx/amend отвечает 422 bad_request, простой app (опрос хоста)
#   enable    выключатель enable-flags.sh из пакета: --paging false и --discovery false: код 0, у
#             app обе переменные false, пересоздан только app; затем enable-flags.sh --rollback:
#             .env побайтно прежний, у app снова обе true (в бэкапе ключей нет - default)
#   rollback  patch.sh --rollback по успешному запуску: дерево побайтно как до патча, app на
#             прежнем образе, documents не тронут
#   offswitch в .env боя явно SHORTLIST_PAGING_ENABLED=false и SUPPLIER_DISCOVERY_ENABLED=false:
#             patch.sh без отказа (код 0), .env не изменён, у app обе переменные остаются false,
#             в журнале «выключен выключателем»; затем patch.sh --rollback и возврат .env
#   broken    во время выдержки patch.sh перезапускается documents (как чужой сбой): проверка
#             выдержки красная, автооткат (код 1), дерево побайтно как до патча
#   cleanup   убрать стенд (контейнеры, сети проекта)
# Результаты: $OUT/steps.tsv, $OUT/summary.txt, журналы патча $OUT/<шаг>.log.
# Окружение: SYNTH (каталог стенда; дерево v2 после G8y лежит в $SYNTH/opt/pragmatika-v2/deploy),
# OUT (каталог результатов), LOCK (lock этапа 8z), LOCK_OLD (lock боя после G8y, этап 8y2),
# SIGNATURES (вывод verify-signatures.sh по LOCK), STUB_IMAGE (образ с bun для заглушки documents;
# по умолчанию образ app из LOCK_OLD), RUNBOOK_FILE (необязательно), P8Z_PORT_BASE (первый порт
# диапазона стенда из 50 портов; по умолчанию 21400), PATCH8Z_AMEND_PROBE_STATUS и
# PATCH8Z_AMEND_PROBE_ERROR (ожидаемые статус и код ошибки пробы /docx/amend, если настоящий
# образ отвечает иначе; передаются patch.sh), HEAVY_LOCK (файл блокировки).
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPORTS="${REPORTS:-$HOME/reports/business-ai-modular}"
STAGE="${STAGE_DIR:-$REPORTS/stage-8z}"
SYNTH="${SYNTH:-$STAGE/tmp/synth}"
OUT="${OUT:-$STAGE/synth}"
LOCK="${LOCK:-$STAGE/images.lock}"
LOCK_OLD="${LOCK_OLD:-$REPORTS/stage-8y2/images.lock}"
SIGNATURES="${SIGNATURES:-$STAGE/signatures.txt}"
HEAVY_LOCK="${HEAVY_LOCK:-$REPORTS/heavy.lock}"
LOCK_WAIT_S=7200
PROJECT="pragmatika-p8z"
STAGE_LABEL="bai.stage=8z"
LIVE="$SYNTH/opt/pragmatika-v2"
DEPLOY="$LIVE/deploy"
APP="$PROJECT-app-1"
DOCS="$PROJECT-documents-1"
STANDIN="$ROOT/deploy/patch-8z/standin/patch-8z-stand.compose.yml"
STAND_LOCK_OLD="$OUT/stand-old.lock"
STAND_LOCK_NEW="$OUT/stand-new.lock"
STAND_SIGNATURES="$OUT/stand-signatures.txt"
STEPS_DEFAULT="prepare preflight refuse apply enable rollback offswitch broken cleanup"
STEPS="$STEPS_DEFAULT"
# Диапазон портов стенда на 127.0.0.1 (база из P8Z_PORT_BASE) и два порта, которые занимает прогон.
PORT_COUNT=50
PORT_FIRST="${P8Z_PORT_BASE:-21400}"
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
# Новые переменные app от G8z: по умолчанию включены (true), false в .env - выключатель; карточки
# нужны для работы пополнения базы (без них только предупреждение).
FLAG_PAGING="SHORTLIST_PAGING_ENABLED"
FLAG_DISCOVERY="SUPPLIER_DISCOVERY_ENABLED"
FLAG_OFF="false"
FLAG_ON="true"
# Четыре флага G8x documents: documents патчем не трогается, флаги остаются.
DOCS_FLAGS=(DOCUMENTS_EDIT_PPTX=true DOCUMENTS_EDIT_PDF=true DOCUMENTS_PPT_CONVERT=true
  DOCUMENTS_EDIT_PDF_FALLBACK_FONT=false)
PLATFORM_NOW="1.1.6"
LOCK_VERSION_FROM="1.1.6-pragmatika.2"
LOCK_VERSION_G8X="1.1.6-pragmatika.1"
# Проба /docx/amend (как в patch.sh): путь, тело, ожидаемые статус и код ошибки.
AMEND_ROUTE="/docx/amend"
AMEND_BODY='{"file_name":"probe.docx","content_base64":"","party":"zz",'
AMEND_BODY+='"number_edit":{"mode":"zz","text":"1"}}'
AMEND_STATUS="${PATCH8Z_AMEND_PROBE_STATUS:-422}"
AMEND_ERROR="${PATCH8Z_AMEND_PROBE_ERROR:-bad_request}"
FAILS=0
POLL_FLAG="$OUT/poll.flag"
NEEDED_FILES=(compose.yml compat.env .env compose.project.yml platform/compose.base.yml
  platform/PLATFORM-VERSION)
# Файлы дерева, которые собираются из HEAD, если дерева стенда нет (путь в HEAD относительно
# deploy/).
TREE_FROM_HEAD=(compose.yml compat.env compose.project.yml platform/compose.base.yml
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
[[ "$PORT_FIRST" =~ ^[0-9]+$ ]] || { echo "P8Z_PORT_BASE: нужно число" >&2; exit 2; }
mkdir -p "$OUT"

# Тяжёлый прогон под общей блокировкой и с замером ресурсов до начала.
if [[ "${P8Z_NO_LOCK:-0}" != 1 && "${P8Z_LOCKED:-0}" != 1 ]]; then
  command -v flock >/dev/null || { echo "нет flock (P8Z_NO_LOCK=1 - без блокировки)" >&2; exit 2; }
  echo "[patch-8z-synth] жду блокировку $HEAVY_LOCK (до ${LOCK_WAIT_S} с)"
  P8Z_LOCKED=1 exec flock -w "$LOCK_WAIT_S" "$HEAVY_LOCK" bash "${BASH_SOURCE[0]}" \
    --steps "$STEPS"
fi
{ echo "# free -m"; free -m; echo "# df -h /"; df -h /; } | tee "$OUT/resources-before.txt"

STEPS_FILE="$OUT/steps.tsv"
log() { echo "[patch-8z-synth] $(date -u +%T) $*"; }
result() { # result <проверка> <ok|FAIL> <пояснение>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$STEPS_FILE"
  log "$1: $2 - $3"
  [[ "$2" == ok ]] || FAILS=$((FAILS + 1))
}

export STAND_APP_PORT="$PORT_APP"
export STAND_DOCS_PORT="$PORT_DOCS"

# compose стенда «как на бою после G8y»: файлы дерева + надстройка стенда (заглушки).
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
# Хэши файлов дерева, КРОМЕ images.lock и compose.project.yml (патч G8z другие файлы менять не
# вправе).
tree_hash_no_patched() { (cd "$DEPLOY" && find . -type f ! -name 'images.lock' \
  ! -name 'compose.project.yml' ! -name '*.patch-new' ! -name '*.rb-new' | sort \
  | xargs -d '\n' sha256sum); }
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

# Подготовка lock'ов стенда: образ documents заменён на образ-заглушку (в нём есть bun) - ОДИН И
# ТОТ ЖЕ в lock боя и в lock пакета (G8z documents не меняет); прочее как в lock'ах этапов.
# Подтверждение подписей пересчитано под новый lock (образ заглушки подписан вместе с app: он
# взят из lock этапа 8y2).
derive_stand_locks() {
  STUB_IMAGE_REF="${STUB_IMAGE:-$(lock_ref "$LOCK_OLD" BAI_IMAGE_APP)}"
  sed "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=$STUB_IMAGE_REF|" "$LOCK_OLD" \
    >"$STAND_LOCK_OLD"
  sed "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=$STUB_IMAGE_REF|" "$LOCK" >"$STAND_LOCK_NEW"
  python3 -I - "$SIGNATURES" "$STAND_LOCK_NEW" "$STUB_IMAGE_REF" >"$STAND_SIGNATURES" <<'PY'
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

# fill_required_env: обязательные переменные compose (${ИМЯ:?...}) без значения в синтетическом
# .env получают синтетическое значение (стенд их не использует, но `compose config` без них не
# соберётся); образы BAI_* берутся из lock.
fill_required_env() {
  local name
  while IFS= read -r name; do
    [[ "$name" != BAI_* ]] || continue
    ! grep -qE "^$name=." "$DEPLOY/.env" || continue
    sed -i "/^$name=/d" "$DEPLOY/.env"
    printf '%s=synthetic-%s\n' "$name" "${name,,}" >>"$DEPLOY/.env"
  done < <(cat "$DEPLOY/compose.project.yml" "$DEPLOY/platform/compose.base.yml" \
    | grep -oE '\$\{[A-Z0-9_]+:\?' | sed -E 's/^\$\{//; s/:\?$//' | sort -u)
}

# Дерево стенда «после G8y» из HEAD репозитория (если его нет): файлы compose, compose.project.yml
# без двух новых переменных G8z и синтетический .env из .env.example (секретов нет).
make_tree() {
  local rel var
  mkdir -p "$DEPLOY/platform"
  for rel in "${TREE_FROM_HEAD[@]}"; do
    git -C "$ROOT" show "HEAD:deploy/$rel" >"$DEPLOY/$rel" \
      || { result "prepare: дерево стенда из HEAD" FAIL "в HEAD нет deploy/$rel"; return 1; }
  done
  for var in "$FLAG_PAGING" "$FLAG_DISCOVERY"; do
    sed -i "/^[[:space:]]*$var:/d" "$DEPLOY/compose.project.yml"
  done
  git -C "$ROOT" show "HEAD:deploy/.env.example" >"$DEPLOY/.env" \
    || { result "prepare: дерево стенда из HEAD" FAIL "в HEAD нет deploy/.env.example"; return 1; }
  chmod 600 "$DEPLOY/.env"
  fill_required_env
  result "prepare: дерево стенда собрано из HEAD" ok "состояние «G8y применён», .env синтетический"
}

patch_run() { # patch_run <шаг> [аргументы patch.sh]: код в RC, журнал $OUT/<шаг>.log
  local step="$1"
  shift
  RC=0
  env CUTOVER_PROJECT="$PROJECT" CUTOVER_NEW_DIR="$LIVE" CUTOVER_ENV_FILE="$DEPLOY/.env" \
    CUTOVER_EXTRA_COMPOSE="$STANDIN" CUTOVER_EXTRA_ENV="${STAND_EXTRA_ENV:-}" \
    CUTOVER_SERVICES="documents app" \
    CUTOVER_HOME="$OUT/home" CUTOVER_BACKUP_ROOT="$OUT/backups" CUTOVER_OUT_DIR="$OUT" \
    CUTOVER_COSIGN=/nonexistent-cosign PATCH8Z_SOAK_POLL_S="$SOAK_POLL_S" \
    CUTOVER_EXPECT_BOTS="$EXPECT_BOTS" PATCH8Z_MIN_DISK_MIB="$MIN_DISK_MIB" \
    PATCH8Z_AMEND_PROBE_STATUS="$AMEND_STATUS" PATCH8Z_AMEND_PROBE_ERROR="$AMEND_ERROR" \
    CUTOVER_READY_WAIT_S="$READY_WAIT_S" CUTOVER_HEALTH_WAIT_S="$HEALTH_WAIT_S" \
    bash "$PKG/patch.sh" --soak-seconds "$SOAK_S" "$@" >"$OUT/$step.log" 2>&1 || RC=$?
}

# flags_run <шаг> [аргументы enable-flags.sh]: код в RC, журнал $OUT/<шаг>.log.
flags_run() {
  local step="$1"
  shift
  RC=0
  env CUTOVER_PROJECT="$PROJECT" CUTOVER_NEW_DIR="$LIVE" CUTOVER_ENV_FILE="$DEPLOY/.env" \
    CUTOVER_EXTRA_COMPOSE="$STANDIN" CUTOVER_SERVICES="documents app" \
    CUTOVER_HOME="$OUT/home" CUTOVER_BACKUP_ROOT="$OUT/backups" CUTOVER_OUT_DIR="$OUT" \
    FLAGS8Z_SOAK_POLL_S="$SOAK_POLL_S" CUTOVER_EXPECT_BOTS="$EXPECT_BOTS" \
    CUTOVER_READY_WAIT_S="$READY_WAIT_S" CUTOVER_HEALTH_WAIT_S="$HEALTH_WAIT_S" \
    bash "$PKG/enable-flags.sh" --soak-seconds "$SOAK_S" "$@" >"$OUT/$step.log" 2>&1 || RC=$?
}

# Контекст отдельных шагов (--steps без prepare): lock'и стенда и пакет.
restore_context() {
  [[ -n "$STUB_IMAGE_REF" ]] || derive_stand_locks
  [[ -f "$PKG/patch.sh" ]] || build_package
}

# ---------------------------------------------------------------------------------------------
step_prepare() {
  log "стенд: предусловия"
  local missing=() f port
  for f in "$LOCK" "$LOCK_OLD" "$SIGNATURES" "$STANDIN"; do
    [[ -f "$f" ]] || missing+=("$f")
  done
  if ((${#missing[@]} > 0)); then
    result "prepare: подготовленные файлы" FAIL "нет: ${missing[*]}"
    log "Нужны lock'и этапов 8y2 и 8z, подтверждение подписей по lock этапа 8z и надстройка стенда."
    return 1
  fi
  command -v docker >/dev/null || { result "prepare: docker" FAIL "нет docker"; return 1; }
  [[ -f "$DEPLOY/compose.yml" ]] || make_tree || return 1
  for f in "${NEEDED_FILES[@]}"; do
    [[ -f "$DEPLOY/$f" ]] || missing+=("$DEPLOY/$f")
  done
  if ((${#missing[@]} > 0)); then
    result "prepare: дерево стенда" FAIL "нет: ${missing[*]}"
    return 1
  fi
  local flag
  for flag in "${DOCS_FLAGS[@]%%=*}" "$YANDEX_CONCURRENCY_KEY"; do
    if ! grep -q "$flag" "$DEPLOY/compose.project.yml"; then
      result "prepare: дерево стенда после G8y" FAIL "в compose.project.yml нет $flag"
      return 1
    fi
  done
  if grep -qE "$FLAG_PAGING|$FLAG_DISCOVERY" "$DEPLOY/compose.project.yml"; then
    result "prepare: дерево стенда до G8z" FAIL \
      "в compose.project.yml уже есть новые переменные: дерево не «после G8y»"
    return 1
  fi
  if ! grep -qx "PLATFORM_PACKAGES_VERSION=$PLATFORM_NOW" "$DEPLOY/platform/PLATFORM-VERSION"; then
    result "prepare: платформа стенда" FAIL "в PLATFORM-VERSION не $PLATFORM_NOW"
    return 1
  fi
  if ! grep -qx "BAI_VERSION=$LOCK_VERSION_FROM" "$LOCK_OLD"; then
    result "prepare: lock боя G8y" FAIL "в $LOCK_OLD не BAI_VERSION=$LOCK_VERSION_FROM"
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
    "$STUB_IMAGE_REF"; do
    docker image inspect "$ref" >/dev/null 2>&1 \
      || { result "prepare: образ на хосте" FAIL "нет ${ref##*/} (docker load / pull)"; return 1; }
  done
  result "prepare: образы app и заглушки documents на хосте" ok "прежний и новый app, заглушка"
  # Синтетический .env стенда - как на бою до G8z: новых флагов в нём нет (значение по умолчанию
  # compose); строки из прежней заготовки убираются (сценарий offswitch задаёт их явно).
  sed -i -E "/^($FLAG_PAGING|$FLAG_DISCOVERY)=/d" "$DEPLOY/.env"
  result "prepare: в .env стенда нет новых флагов (как на бою до G8z)" ok \
    "значения по умолчанию compose"
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
  tree_hash_no_patched >"$OUT/tree-before-no-patched.sha"
  cp -p "$DEPLOY/.env" "$OUT/env.keep"
  docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.Names}}\t{{.Image}}' | sort >"$OUT/containers-before.txt"
  DOCS_STARTED_BEFORE="$(container_started "$DOCS")"
  echo "$DOCS_STARTED_BEFORE" >"$OUT/docs-started.before"
  [[ -n "$(env_of "$APP" "$YANDEX_CONCURRENCY_KEY")" \
    && -n "$(env_of "$APP" "$YANDEX_INTERVAL_KEY")" ]] \
    && result "prepare: у app переменные поиска G8w" ok "как на бою после G8w" \
    || result "prepare: у app переменные поиска G8w" FAIL "нет"
  [[ -z "$(env_of "$APP" "$FLAG_PAGING")" && -z "$(env_of "$APP" "$FLAG_DISCOVERY")" ]] \
    && result "prepare: у app нет новых переменных G8z (состояние G8y)" ok "обе отсутствуют" \
    || result "prepare: у app нет новых переменных G8z (состояние G8y)" FAIL "уже есть"
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
  bash "$HERE/build-patch-8z-package.sh" --out "$pkg_out" --lock "$STAND_LOCK_NEW" \
    --prev-lock "$STAND_LOCK_OLD" --signatures "$STAND_SIGNATURES" \
    ${RUNBOOK_FILE:+--runbook "$RUNBOOK_FILE"} >"$OUT/build-package.log" 2>&1 \
    || { result "package: сборка" FAIL "см. build-package.log (файлы patch-8z должны быть в HEAD)"
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

# documents не перезапускался с момента prepare: StartedAt прежний.
docs_untouched() { # docs_untouched <метка>
  [[ "$(container_started "$DOCS")" == "$(cat "$OUT/docs-started.before")" ]] \
    && result "$1: documents не перезапускался" ok "StartedAt как до патча" \
    || result "$1: documents не перезапускался" FAIL "StartedAt изменился"
}

step_preflight() {
  build_package || return 1
  patch_run preflight --preflight-only
  [[ "$RC" == 0 ]] && result "preflight: код" ok "0 (PREFLIGHT_OK)" \
    || result "preflight: код" FAIL "$RC (preflight.log)"
  grep -q 'патч G8y применён: ok' "$OUT/preflight.log" \
    && result "preflight: патч G8y распознан как применённый" ok "запись в журнале" \
    || result "preflight: патч G8y распознан как применённый" FAIL "нет записи в журнале"
  grep -q 'флаги app в конфигурации: ok' "$OUT/preflight.log" \
    && grep -q "$FLAG_PAGING включён" "$OUT/preflight.log" \
    && grep -q "$FLAG_DISCOVERY включён" "$OUT/preflight.log" \
    && result "preflight: обе новые переменные app = true в новой конфигурации" ok \
      "запись в журнале" \
    || result "preflight: обе новые переменные app = true в новой конфигурации" FAIL \
      "нет записи в журнале"
  grep -q 'карточки поставщиков (до патча)' "$OUT/preflight.log" \
    && result "preflight: проверка карточек поставщиков (предупреждение, не отказ)" ok \
      "запись в журнале" \
    || result "preflight: проверка карточек поставщиков (предупреждение, не отказ)" FAIL \
      "нет записи в журнале"
  grep -q 'прочая конфигурация: ok' "$OUT/preflight.log" \
    && result "preflight: прочая конфигурация сходится со снимком боя" ok "запись в журнале" \
    || result "preflight: прочая конфигурация сходится со снимком боя" FAIL "нет записи"
  unchanged_since_prepare preflight
  docs_untouched preflight
}

step_refuse() {
  # 1. Lock боя версии G8x (.1): предусловие «G8y применён» не выполнено - отказ ДО замены.
  local keep="$OUT/images.lock.keep"
  cp -p "$DEPLOY/images.lock" "$keep"
  sed -i "s|^BAI_VERSION=.*|BAI_VERSION=$LOCK_VERSION_G8X|" "$DEPLOY/images.lock"
  patch_run refuse --preflight-only
  cp -p "$keep" "$DEPLOY/images.lock"
  [[ "$RC" == 3 ]] && result "refuse: код (G8y не применён)" ok "3 (отказ по предусловиям)" \
    || result "refuse: код (G8y не применён)" FAIL "$RC (refuse.log)"
  grep -q 'сначала примените патч G8y' "$OUT/refuse.log" \
    && result "refuse: причина" ok "названа: сначала примените патч G8y" \
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
  [[ "$(container_image "$DOCS")" == "$STUB_IMAGE_REF" ]] \
    && result "apply: documents на прежнем образе" ok "${STUB_IMAGE_REF##*/}" \
    || result "apply: documents на прежнем образе" FAIL "$(container_image "$DOCS")"
  docs_untouched apply
  [[ -z "$(awk '$2 == "docs" && $3 != 200' "$OUT/poll.txt")" ]] \
    && result "apply: опрос с хоста не заметил простоя documents" ok "все пробы 200" \
    || result "apply: опрос с хоста не заметил простоя documents" FAIL "были не 200"
  cmp -s "$DEPLOY/images.lock" "$STAND_LOCK_NEW" \
    && result "apply: images.lock боя равен lock пакета" ok "версия $(lock_ref "$STAND_LOCK_NEW" \
      BAI_VERSION)" \
    || result "apply: images.lock боя равен lock пакета" FAIL "различаются"
  cmp -s "$DEPLOY/compose.project.yml" "$PKG/deploy/compose.project.yml" \
    && result "apply: compose.project.yml боя равен файлу пакета" ok "две новые переменные app" \
    || result "apply: compose.project.yml боя равен файлу пакета" FAIL "различаются"
  diff <(tree_hash_no_patched) "$OUT/tree-before-no-patched.sha" >/dev/null \
    && result "apply: остальные файлы дерева прежние" ok \
      "побайтно (кроме lock и compose.project.yml)" \
    || result "apply: остальные файлы дерева прежние" FAIL "изменились"
  local name got bad=""
  for name in "$FLAG_PAGING" "$FLAG_DISCOVERY"; do
    got="$(env_of "$APP" "$name")"
    [[ "$got" == "$FLAG_ON" ]] || bad+=" $name=${got:-<нет>}"
  done
  [[ -z "$bad" ]] \
    && result "apply: у app обе новые переменные = true (по умолчанию compose)" ok \
      "$FLAG_PAGING, $FLAG_DISCOVERY" \
    || result "apply: у app обе новые переменные = true (по умолчанию compose)" FAIL "$bad"
  grep -q 'карточки поставщиков (после замены)' "$OUT/apply.log" \
    && result "apply: проверка карточек поставщиков выполнена (warn не отказ)" ok \
      "запись в журнале" \
    || result "apply: проверка карточек поставщиков выполнена (warn не отказ)" FAIL \
      "нет записи в журнале"
  check_docs_flags apply "после патча"
  [[ -n "$(env_of "$APP" "$YANDEX_CONCURRENCY_KEY")" \
    && -n "$(env_of "$APP" "$YANDEX_INTERVAL_KEY")" ]] \
    && result "apply: переменные Яндекса у app сохранились" ok "обе на месте" \
    || result "apply: переменные Яндекса у app сохранились" FAIL "пропали"
  [[ "$(amend_from_host)" == "$AMEND_STATUS $AMEND_ERROR" ]] \
    && result "apply: POST $AMEND_ROUTE отвечает с хоста как образ G8y" ok \
      "$AMEND_STATUS $AMEND_ERROR" \
    || result "apply: POST $AMEND_ROUTE отвечает с хоста как образ G8y" FAIL \
      "иной ответ: $(amend_from_host)"
  grep -q 'проба /docx/amend: ok' "$OUT/apply.log" \
    && result "apply: проба /docx/amend прошла в patch.sh" ok "запись в журнале" \
    || result "apply: проба /docx/amend прошла в patch.sh" FAIL "нет записи в журнале"
  [[ "$(grep -c 'up -d --no-deps' "$OUT/apply.log" || true)" -ge 1 ]] \
    && ! grep -q 'up -d --no-deps documents' "$OUT/apply.log" \
    && result "apply: в журнале нет up documents" ok "пересоздан только app" \
    || result "apply: в журнале нет up documents" FAIL "есть запись про documents"
  downtime app app
  [[ "$(tail -2 "$OUT/poll.txt" | awk '$3 == 200' | wc -l)" == 2 ]] \
    && result "apply: в конце опроса documents и app отвечают" ok "200 и 200" \
    || result "apply: в конце опроса documents и app отвечают" FAIL "нет 200"
  local backup
  backup="$(find "$OUT/backups" -maxdepth 1 -name 'pragmatika-patch8z-*' 2>/dev/null | head -1)"
  [[ -n "$backup" ]] \
    && result "apply: бэкап файлов дерева" ok "$(basename "$backup")" \
    || result "apply: бэкап файлов дерева" FAIL "нет каталога бэкапа"
  RUN_APPLIED="$(readlink -f "$OUT/home/patch-8z-latest")"
}

# Необязательный шаг runbook: выключатель флагов и откат .env (после apply, до rollback патча).
step_enable() {
  local name got bad=""
  cp -p "$DEPLOY/.env" "$OUT/env.before-enable"
  flags_run enable_dry --paging "$FLAG_OFF" --discovery "$FLAG_OFF" --dry-run
  [[ "$RC" == 0 ]] && cmp -s "$DEPLOY/.env" "$OUT/env.before-enable" \
    && result "enable: --dry-run" ok "код 0, .env не тронут" \
    || result "enable: --dry-run" FAIL "$RC (enable_dry.log)"
  flags_run enable --paging "$FLAG_OFF" --discovery "$FLAG_OFF"
  [[ "$RC" == 0 ]] && result "enable: код" ok "0 (enable.log)" \
    || result "enable: код" FAIL "$RC (enable.log)"
  for name in "$FLAG_PAGING" "$FLAG_DISCOVERY"; do
    got="$(env_of "$APP" "$name")"
    [[ "$got" == "$FLAG_OFF" ]] || bad+=" $name=${got:-<нет>}"
  done
  [[ -z "$bad" ]] \
    && result "enable: у app обе переменные = false (выключены)" ok \
      "$FLAG_PAGING, $FLAG_DISCOVERY" \
    || result "enable: у app обе переменные = false (выключены)" FAIL "$bad"
  docs_untouched enable
  [[ "$(http_code "$PORT_APP" /ready)" == 200 ]] \
    && result "enable: app отвечает с хоста" ok "200" \
    || result "enable: app отвечает с хоста" FAIL "нет 200"
  ! grep -q 'up -d --no-deps documents' "$OUT/enable.log" \
    && result "enable: пересоздан только app" ok "в журнале нет up documents" \
    || result "enable: пересоздан только app" FAIL "есть запись про documents"
  flags_run enable_rollback --rollback
  [[ "$RC" == 0 ]] && cmp -s "$DEPLOY/.env" "$OUT/env.before-enable" \
    && result "enable: --rollback возвращает .env побайтно" ok "код 0" \
    || result "enable: --rollback возвращает .env побайтно" FAIL "$RC (enable_rollback.log)"
  bad=""
  for name in "$FLAG_PAGING" "$FLAG_DISCOVERY"; do
    got="$(env_of "$APP" "$name")"
    [[ "$got" == "$FLAG_ON" ]] || bad+=" $name=${got:-<нет>}"
  done
  [[ -z "$bad" ]] \
    && result "enable: после отката у app обе переменные = true" ok "как до выключения" \
    || result "enable: после отката у app обе переменные = true" FAIL "$bad"
  docs_untouched "enable (после отката)"
  # Синтетический .env возвращается к состоянию prepare.
  cp -p "$OUT/env.keep" "$DEPLOY/.env"
}

step_rollback() {
  [[ -n "${RUN_APPLIED:-}" ]] || RUN_APPLIED="$(readlink -f "$OUT/home/patch-8z-latest")"
  patch_run rollback --rollback --run-dir "$RUN_APPLIED"
  [[ "$RC" == 0 ]] && result "rollback: код" ok "0 (rollback.log)" \
    || result "rollback: код" FAIL "$RC (rollback.log)"
  unchanged_since_prepare rollback
  docs_untouched rollback
  check_docs_flags rollback "после отката"
  [[ -z "$(env_of "$APP" "$FLAG_PAGING")" && -z "$(env_of "$APP" "$FLAG_DISCOVERY")" ]] \
    && result "rollback: у app снова нет новых переменных (compose G8y)" ok "обе отсутствуют" \
    || result "rollback: у app снова нет новых переменных (compose G8y)" FAIL "остались"
  [[ "$(http_code "$PORT_APP" /ready)" == 200 && "$(http_code "$PORT_DOCS" /health)" == 200 ]] \
    && result "rollback: documents и app отвечают с хоста" ok "200 и 200" \
    || result "rollback: documents и app отвечают с хоста" FAIL "нет 200"
}

# Явный выключатель в .env боя: патч не отказывает, .env не меняет, функции остаются выключенными.
step_offswitch() {
  local name got bad=""
  printf '%s=%s\n%s=%s\n' "$FLAG_PAGING" "$FLAG_OFF" "$FLAG_DISCOVERY" "$FLAG_OFF" \
    >>"$DEPLOY/.env"
  cp -p "$DEPLOY/.env" "$OUT/env.offswitch"
  patch_run offswitch
  [[ "$RC" == 0 ]] && result "offswitch: код (патч не отказывает при явном false)" ok \
    "0 (offswitch.log)" \
    || result "offswitch: код (патч не отказывает при явном false)" FAIL "$RC (offswitch.log)"
  [[ "$(container_image "$APP")" == "$(lock_ref "$STAND_LOCK_NEW" BAI_IMAGE_APP)" ]] \
    && result "offswitch: app на новом образе" ok "как при обычном патче" \
    || result "offswitch: app на новом образе" FAIL "$(container_image "$APP")"
  cmp -s "$DEPLOY/.env" "$OUT/env.offswitch" \
    && result "offswitch: .env боя патч не менял" ok "побайтно прежний" \
    || result "offswitch: .env боя патч не менял" FAIL "различается"
  for name in "$FLAG_PAGING" "$FLAG_DISCOVERY"; do
    got="$(env_of "$APP" "$name")"
    [[ "$got" == "$FLAG_OFF" ]] || bad+=" $name=${got:-<нет>}"
  done
  [[ -z "$bad" ]] \
    && result "offswitch: у app обе переменные остаются false" ok "$FLAG_PAGING, $FLAG_DISCOVERY" \
    || result "offswitch: у app обе переменные остаются false" FAIL "$bad"
  grep -q "$FLAG_PAGING выключен выключателем" "$OUT/offswitch.log" \
    && grep -q "$FLAG_DISCOVERY выключен выключателем" "$OUT/offswitch.log" \
    && result "offswitch: журнал называет функции выключенными выключателем" ok "запись в журнале" \
    || result "offswitch: журнал называет функции выключенными выключателем" FAIL "нет записи"
  docs_untouched offswitch
  patch_run offswitch_rollback --rollback --run-dir \
    "$(readlink -f "$OUT/home/patch-8z-latest")"
  cp -p "$OUT/env.keep" "$DEPLOY/.env"
  [[ "$RC" == 0 ]] && result "offswitch: откат патча, код" ok "0 (offswitch_rollback.log)" \
    || result "offswitch: откат патча, код" FAIL "$RC (offswitch_rollback.log)"
  unchanged_since_prepare offswitch
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
    && "$(container_image "$DOCS")" == "$STUB_IMAGE_REF" ]] \
    && result "broken: app снова на образе G8y, documents на прежнем" ok "как до патча" \
    || result "broken: app снова на образе G8y, documents на прежнем" FAIL \
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
STUB_IMAGE_REF=""
DOCS_STARTED_BEFORE=""
run_step() { # run_step <шаг>: контекст и вызов шага
  case "$1" in
    prepare) step_prepare ;;
    preflight) restore_context; step_preflight ;;
    refuse) restore_context; step_refuse ;;
    apply) restore_context; step_apply ;;
    enable) restore_context; step_enable ;;
    rollback) restore_context; step_rollback ;;
    offswitch) restore_context; step_offswitch ;;
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
