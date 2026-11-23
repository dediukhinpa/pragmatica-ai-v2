#!/usr/bin/env bash
# Проверка патч-пакета G9r на синтетическом «бое» (локальный стенд): настоящие compose-файлы
# дерева v2 ПОСЛЕ патча G9q3 (платформа 1.1.6, lock 1.1.6-pragmatika.7; копия платформы 1.1.6 -
# из коммита P9R_PLATFORM_REV, остальные файлы дерева - из HEAD репозитория), настоящие образы
# app (прежний из lock этапа 9u и новый из lock этапа 9r); у app и у documents вместо сервисов
# заглушки на bun, которые отвечают на /health, /ready, POST /docx/pages и POST /parse. Образ
# заглушки documents в lock стенда - образ с bun: до патча образ app из lock боя (G9q3), после
# патча образ app из lock G9r (образ documents у G9r МЕНЯЕТСЯ, поэтому заглушки две). Заглушка
# documents на POST /parse с locations=true отдаёт места PDF, если DOCUMENTS_EDIT_PDF_TEXT не
# выключен в её окружении, и не отдаёт, если выключен; /docx/pages отвечает по логике пробы
# patch.sh (422 bad_request на некорректный base64). Бой (pragmatika-ru) не затрагивается:
# compose-проект pragmatika-p9r, порты 127.0.0.1 в диапазоне P9R_PORT_BASE..+49 (по умолчанию
# 21300-21349), пути стенда под $SYNTH, контейнеры стенда с меткой bai.stage=9r.
#
# Тяжёлый прогон (docker, образы): запускать под общей блокировкой heavy.lock; скрипт сам
# перезапускается под `flock` (P9R_NO_LOCK=1 - не брать блокировку, например если её уже держит
# вызывающий) и перед прогоном пишет замер `free -m` и `df -h /` в $OUT/resources-before.txt и в
# вывод. НА ЭТОМ ЭТАПЕ СКРИПТ ТОЛЬКО НАПИСАН: стенд не запускался.
#
# Скрипт стенд «из воздуха» не создаёт: нужны образы и lock'и. Шаг prepare проверяет
# предусловия и печатает, чего нет (lock'и, подтверждение подписей, образы на хосте, свободные
# порты); если в $SYNTH нет дерева v2, оно собирается: compose.yml, compat.env,
# compose.project.yml из HEAD, platform/compose.base.yml и platform/PLATFORM-VERSION версии 1.1.6
# из коммита P9R_PLATFORM_REV (состояние «G9q3 применён») и синтетический .env из .env.example;
# затем поднимает documents и app «до патча».
#
# Использование:
#   bash tools/patch-9r-synth.sh [--steps список] [--help]
# Шаги (по умолчанию все по порядку):
#   prepare   проверить предусловия, собрать lock'и стенда и дерево, поднять documents и app «до
#             патча» (образы G9q3, платформа 1.1.6: у documents четыре флага G8x и нет
#             DOCUMENTS_EDIT_PDF_TEXT, у app переменные G9q, G9p, G8z и поиска G8w и нет
#             B24_CALL_RECORDING_*)
#   preflight patch.sh --preflight-only: код 0, ничего не изменилось
#   refuse    lock боя версии 1.1.6-pragmatika.6 (имитация «патч G9q3 не применён»): код 3 с
#             текстом «сначала примените патч G9q3»; ничего не изменилось
#   apply     patch.sh: код 0; documents и app на новых образах (сначала documents), images.lock и
#             копия платформы боя равны пакету, compose.project.yml равен пакету, остальные
#             файлы дерева (в том числе .env) побайтно прежние, у documents четыре флага G8x и
#             DOCUMENTS_EDIT_PDF_TEXT пусто (включено), у app обе новые переменные B24 равны
#             умолчаниям платформы, проба POST /docx/pages отвечает 422 bad_request, POST /parse
#             с locations=true отдаёт места PDF (с хоста: 200 pdf 1 1), простой documents и app
#             (опрос хоста)
#   enable    выключатель enable-flags.sh из пакета: --pdf-text false и --text-blocks false: код
#             0, у documents DOCUMENTS_EDIT_PDF_TEXT=false (проба /parse с хоста без locations),
#             у app PRICE_EDIT_TEXT_BLOCKS_ENABLED=false; затем enable-flags.sh --rollback: .env
#             побайтно прежний, у documents пусто, у app true
#   rollback  patch.sh --rollback по успешному запуску: дерево побайтно как до патча, documents и
#             app на образах G9q3
#   offswitch в .env боя явно DOCUMENTS_EDIT_PDF_TEXT=false: patch.sh без отказа (код 0), .env не
#             изменён, у documents значение false, проба /parse с хоста без locations, в журнале
#             «выключен выключателем»; затем patch.sh --rollback и возврат .env
#   broken    во время выдержки patch.sh перезапускается documents (как чужой сбой): проверка
#             выдержки красная, автооткат (код 1), дерево побайтно как до патча
#   cleanup   убрать стенд (контейнеры, сети проекта)
# Результаты: $OUT/steps.tsv, $OUT/summary.txt, журналы патча $OUT/<шаг>.log.
# Окружение: SYNTH (каталог стенда; дерево v2 после G9q3 лежит в $SYNTH/opt/pragmatika-v2/deploy),
# OUT (каталог результатов), LOCK (lock этапа 9r), LOCK_OLD (lock боя после G9q3, этап 9u),
# SIGNATURES (вывод verify-signatures.sh по LOCK), STUB_IMAGE_OLD и STUB_IMAGE_NEW (образы с bun
# для заглушки documents до и после патча; по умолчанию образы app из LOCK_OLD и LOCK),
# P9R_PLATFORM_REV (коммит с копией платформы 1.1.6; по умолчанию 6a99a74), RUNBOOK_FILE
# (необязательно), P9R_PORT_BASE (первый порт диапазона стенда из 50 портов; по умолчанию 21300),
# PATCH9R_PAGES_PROBE_STATUS и PATCH9R_PAGES_PROBE_ERROR (ожидаемые статус и код ошибки пробы
# /docx/pages), PATCH9R_PARSE_PROBE_ON и PATCH9R_PARSE_PROBE_OFF (ожидаемые ответы пробы /parse;
# передаются patch.sh), HEAVY_LOCK (файл блокировки).
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPORTS="${REPORTS:-$HOME/reports/business-ai-modular}"
STAGE="${STAGE_DIR:-$REPORTS/stage-9r}"
SYNTH="${SYNTH:-$STAGE/tmp/synth}"
OUT="${OUT:-$STAGE/synth}"
LOCK="${LOCK:-$STAGE/images.lock}"
LOCK_OLD="${LOCK_OLD:-$REPORTS/stage-9u/images.lock}"
SIGNATURES="${SIGNATURES:-$STAGE/signatures.txt}"
HEAVY_LOCK="${HEAVY_LOCK:-$REPORTS/heavy.lock}"
PLATFORM_REV="${P9R_PLATFORM_REV:-6a99a74}"
LOCK_WAIT_S=7200
PROJECT="pragmatika-p9r"
STAGE_LABEL="bai.stage=9r"
LIVE="$SYNTH/opt/pragmatika-v2"
DEPLOY="$LIVE/deploy"
APP="$PROJECT-app-1"
DOCS="$PROJECT-documents-1"
STANDIN="$ROOT/deploy/patch-9r/standin/patch-9r-stand.compose.yml"
STAND_LOCK_OLD="$OUT/stand-old.lock"
STAND_LOCK_NEW="$OUT/stand-new.lock"
STAND_SIGNATURES="$OUT/stand-signatures.txt"
STEPS_DEFAULT="prepare preflight refuse apply enable rollback offswitch broken cleanup"
STEPS="$STEPS_DEFAULT"
# Диапазон портов стенда на 127.0.0.1 (база из P9R_PORT_BASE) и два порта, которые занимает прогон.
PORT_COUNT=50
PORT_FIRST="${P9R_PORT_BASE:-21300}"
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
# Флаги G9r: DOCUMENTS_EDIT_PDF_TEXT (documents; пусто или true - включено, false - выключено) и
# PRICE_EDIT_TEXT_BLOCKS_ENABLED (app, от G9q).
FLAG_PDF_TEXT="DOCUMENTS_EDIT_PDF_TEXT"
FLAG_TEXT_BLOCKS="PRICE_EDIT_TEXT_BLOCKS_ENABLED"
FLAG_OFF="false"
FLAG_ON="true"
# Новые переменные app от платформы 1.1.10 и их умолчания платформы.
B24_VARS=(B24_CALL_RECORDING_MAX_BYTES=104857600 B24_CALL_RECORDING_TIMEOUT_MS=600000)
# Переменные app от G9q2, G9q, G9p и G8z (уже на бою): остаются на месте.
OLD_APP_FLAGS=(EMPTY_REPLY_GUARD_ENABLED PRICE_EDIT_DB_WRITE_ENABLED
  PRICE_EDIT_TEXT_BLOCKS_ENABLED PRICE_EDIT_FIRST_ENABLED DOCX_PAGES_ENABLED
  SHORTLIST_PAGING_ENABLED SUPPLIER_DISCOVERY_ENABLED)
# Четыре флага G8x documents: остаются на месте после патча.
DOCS_FLAGS=(DOCUMENTS_EDIT_PPTX=true DOCUMENTS_EDIT_PDF=true DOCUMENTS_PPT_CONVERT=true
  DOCUMENTS_EDIT_PDF_FALLBACK_FONT=false)
PLATFORM_NOW="1.1.6"
LOCK_VERSION_FROM="1.1.6-pragmatika.7"
LOCK_VERSION_NOT_G9Q3="1.1.6-pragmatika.6"
# Проба /docx/pages (как в patch.sh): путь, тело, ожидаемые статус и код ошибки.
PAGES_ROUTE="/docx/pages"
PAGES_BODY='{"file_name":"probe.docx","content_base64":"%%%"}'
PAGES_STATUS="${PATCH9R_PAGES_PROBE_STATUS:-422}"
PAGES_ERROR="${PATCH9R_PAGES_PROBE_ERROR:-bad_request}"
# Проба /parse с хоста: «статус формат страниц мест» при включённой правке PDF вне таблиц и без
# locations при выключенной (как в patch.sh).
PARSE_ROUTE="/parse"
PARSE_ON="${PATCH9R_PARSE_PROBE_ON:-200 pdf 1 1}"
PARSE_OFF="${PATCH9R_PARSE_PROBE_OFF:-200 - - -}"
PARSE_BOUNDARY="stand9rboundary"
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
[[ "$PORT_FIRST" =~ ^[0-9]+$ ]] || { echo "P9R_PORT_BASE: нужно число" >&2; exit 2; }
mkdir -p "$OUT"

# Тяжёлый прогон под общей блокировкой и с замером ресурсов до начала.
if [[ "${P9R_NO_LOCK:-0}" != 1 && "${P9R_LOCKED:-0}" != 1 ]]; then
  command -v flock >/dev/null || { echo "нет flock (P9R_NO_LOCK=1 - без блокировки)" >&2; exit 2; }
  echo "[patch-9r-synth] жду блокировку $HEAVY_LOCK (до ${LOCK_WAIT_S} с)"
  P9R_LOCKED=1 exec flock -w "$LOCK_WAIT_S" "$HEAVY_LOCK" bash "${BASH_SOURCE[0]}" \
    --steps "$STEPS"
fi
{ echo "# free -m"; free -m; echo "# df -h /"; df -h /; } | tee "$OUT/resources-before.txt"

STEPS_FILE="$OUT/steps.tsv"
log() { echo "[patch-9r-synth] $(date -u +%T) $*"; }
result() { # result <проверка> <ok|FAIL> <пояснение>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$STEPS_FILE"
  log "$1: $2 - $3"
  [[ "$2" == ok ]] || FAILS=$((FAILS + 1))
}

export STAND_APP_PORT="$PORT_APP"
export STAND_DOCS_PORT="$PORT_DOCS"

# compose стенда «как на бою после G9q3»: файлы дерева + надстройка стенда (заглушки).
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
# Хэши файлов дерева, КРОМЕ images.lock, compose.project.yml и копии платформы (патч G9r другие
# файлы менять не вправе).
tree_hash_no_patched() { (cd "$DEPLOY" && find . -type f ! -name 'images.lock' \
  ! -name 'compose.project.yml' ! -path './platform/compose.base.yml' \
  ! -path './platform/PLATFORM-VERSION' ! -name '*.patch-new' ! -name '*.rb-new' | sort \
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
http_reply() { # http_reply <порт> <путь> [метод] [тело] [тип содержимого]
  local raw body="${4-}" ctype="${5:-application/json}"
  [[ -n "$body" ]] || body='{}'
  raw="$(timeout "$HTTP_TIMEOUT_S" bash -c '
    exec 3<>"/dev/tcp/127.0.0.1/$0"
    if [[ "$2" == POST ]]; then
      printf "POST %s HTTP/1.0\r\nHost: stand\r\nContent-Type: %s\r\n" "$1" "$4" >&3
      printf "Content-Length: %s\r\n\r\n%s" "${#3}" "$3" >&3
    else
      printf "GET %s HTTP/1.0\r\nHost: stand\r\n\r\n" "$1" >&3
    fi
    cat <&3' "$1" "$2" "${3:-GET}" "$body" "$ctype" 2>/dev/null || true)"
  raw="${raw//$'\r'/}"
  if [[ "$raw" =~ ^HTTP/[0-9.]+\ ([0-9]{3}) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    sed -n '/^$/,$p' <<<"$raw" | tail -n +2
  else
    echo 000
  fi
}
http_code() { http_reply "$@" | head -n 1; }
# Проба pages с хоста: «статус код_ошибки» (только detail.error, остальное тело не печатается).
pages_from_host() {
  local reply code err
  reply="$(http_reply "$PORT_DOCS" "$PAGES_ROUTE" POST "$PAGES_BODY")"
  code="$(head -n 1 <<<"$reply")"
  err="$(tail -n +2 <<<"$reply" | grep -oE '"error" *: *"[a-z_]{1,64}"' | head -1 \
    | sed -E 's/.*"([a-z_]+)"$/\1/' || true)"
  echo "$code ${err:--}"
}
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
lock_ref() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2-; }

# Подготовка lock'ов стенда: образ documents заменён на образ-заглушку (в нём есть bun): в lock
# боя (G9q3) - образ app из LOCK_OLD, в lock пакета (G9r) - образ app из LOCK (образ documents у
# G9r меняется, поэтому заглушки две). Подтверждение подписей пересчитано под новый lock (образ
# заглушки подписан вместе с app: он взят из lock этапа).
derive_stand_locks() {
  STUB_OLD_REF="${STUB_IMAGE_OLD:-$(lock_ref "$LOCK_OLD" BAI_IMAGE_APP)}"
  STUB_NEW_REF="${STUB_IMAGE_NEW:-$(lock_ref "$LOCK" BAI_IMAGE_APP)}"
  sed "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=$STUB_OLD_REF|" "$LOCK_OLD" \
    >"$STAND_LOCK_OLD"
  sed "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=$STUB_NEW_REF|" "$LOCK" >"$STAND_LOCK_NEW"
  python3 -I - "$SIGNATURES" "$STAND_LOCK_NEW" "$STUB_NEW_REF" >"$STAND_SIGNATURES" <<'PY'
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

# Дерево стенда «после G9q3» (если его нет): compose.yml, compat.env и compose.project.yml из
# HEAD, копия платформы 1.1.6 из коммита PLATFORM_REV и синтетический .env из .env.example
# (секретов нет).
make_tree() {
  local rel
  mkdir -p "$DEPLOY/platform"
  for rel in compose.yml compat.env compose.project.yml; do
    git -C "$ROOT" show "HEAD:deploy/$rel" >"$DEPLOY/$rel" \
      || { result "prepare: дерево стенда из HEAD" FAIL "в HEAD нет deploy/$rel"; return 1; }
  done
  for rel in platform/compose.base.yml platform/PLATFORM-VERSION; do
    git -C "$ROOT" show "$PLATFORM_REV:deploy/$rel" >"$DEPLOY/$rel" \
      || { result "prepare: платформа 1.1.6" FAIL "в $PLATFORM_REV нет deploy/$rel"; return 1; }
  done
  git -C "$ROOT" show "HEAD:deploy/.env.example" >"$DEPLOY/.env" \
    || { result "prepare: дерево стенда из HEAD" FAIL "в HEAD нет deploy/.env.example"; return 1; }
  chmod 600 "$DEPLOY/.env"
  fill_required_env
  result "prepare: дерево стенда собрано" ok "состояние «G9q3 применён», .env синтетический"
}

patch_run() { # patch_run <шаг> [аргументы patch.sh]: код в RC, журнал $OUT/<шаг>.log
  local step="$1"
  shift
  RC=0
  env CUTOVER_PROJECT="$PROJECT" CUTOVER_NEW_DIR="$LIVE" CUTOVER_ENV_FILE="$DEPLOY/.env" \
    CUTOVER_EXTRA_COMPOSE="$STANDIN" CUTOVER_EXTRA_ENV="${STAND_EXTRA_ENV:-}" \
    CUTOVER_SERVICES="documents app" \
    CUTOVER_HOME="$OUT/home" CUTOVER_BACKUP_ROOT="$OUT/backups" CUTOVER_OUT_DIR="$OUT" \
    CUTOVER_COSIGN=/nonexistent-cosign PATCH9R_SOAK_POLL_S="$SOAK_POLL_S" \
    CUTOVER_EXPECT_BOTS="$EXPECT_BOTS" PATCH9R_MIN_DISK_MIB="$MIN_DISK_MIB" \
    PATCH9R_PAGES_PROBE_STATUS="$PAGES_STATUS" PATCH9R_PAGES_PROBE_ERROR="$PAGES_ERROR" \
    PATCH9R_PARSE_PROBE_ON="$PARSE_ON" PATCH9R_PARSE_PROBE_OFF="$PARSE_OFF" \
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
    FLAGS9R_SOAK_POLL_S="$SOAK_POLL_S" CUTOVER_EXPECT_BOTS="$EXPECT_BOTS" \
    CUTOVER_READY_WAIT_S="$READY_WAIT_S" CUTOVER_HEALTH_WAIT_S="$HEALTH_WAIT_S" \
    bash "$PKG/enable-flags.sh" --soak-seconds "$SOAK_S" "$@" >"$OUT/$step.log" 2>&1 || RC=$?
}

# Контекст отдельных шагов (--steps без prepare): lock'и стенда и пакет.
restore_context() {
  [[ -n "$STUB_OLD_REF" ]] || derive_stand_locks
  [[ -f "$PKG/patch.sh" ]] || build_package
}

# parse_from_host: проба POST /parse с locations=true с хоста; «статус формат страниц мест»
# («-» вместо отсутствующих значений). Тело ответа не печатается, только эти поля.
parse_from_host() {
  local body reply code fields
  body="--$PARSE_BOUNDARY"$'\r\n''Content-Disposition: form-data; name="locations"'$'\r\n\r\n'
  body+="true"$'\r\n'"--$PARSE_BOUNDARY"$'\r\n'
  body+='Content-Disposition: form-data; name="file"; filename="probe.pdf"'$'\r\n'
  body+="Content-Type: application/pdf"$'\r\n\r\n'"%PDF-1.4"$'\r\n'"--$PARSE_BOUNDARY--"$'\r\n'
  reply="$(http_reply "$PORT_DOCS" "$PARSE_ROUTE" POST "$body" \
    "multipart/form-data; boundary=$PARSE_BOUNDARY")"
  code="$(head -n 1 <<<"$reply")"
  fields="$(tail -n +2 <<<"$reply" | python3 -I -c '
import json, sys
try:
    loc = json.loads(sys.stdin.read()).get("locations")
except ValueError:
    loc = None
if isinstance(loc, dict):
    spots = loc.get("spots")
    print(loc.get("format", "-"), loc.get("pages", "-"),
          len(spots) if isinstance(spots, list) else "-")
else:
    print("- - -")
' 2>/dev/null || echo "- - -")"
  echo "$code $fields"
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
    log "Нужны lock'и этапов 9u и 9r, подтверждение подписей по lock этапа 9r и надстройка стенда."
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
  for flag in "${DOCS_FLAGS[@]%%=*}" "$YANDEX_CONCURRENCY_KEY" "$FLAG_TEXT_BLOCKS"; do
    if ! grep -q "$flag" "$DEPLOY/compose.project.yml"; then
      result "prepare: дерево стенда после G9q3" FAIL "в compose.project.yml нет $flag"
      return 1
    fi
  done
  if grep -q "$FLAG_PDF_TEXT" "$DEPLOY/platform/compose.base.yml"; then
    result "prepare: платформа стенда до G9r" FAIL \
      "в compose.base.yml стенда уже есть $FLAG_PDF_TEXT: копия не версии $PLATFORM_NOW"
    return 1
  fi
  if ! grep -qx "PLATFORM_PACKAGES_VERSION=$PLATFORM_NOW" "$DEPLOY/platform/PLATFORM-VERSION"; then
    result "prepare: платформа стенда" FAIL "в PLATFORM-VERSION не $PLATFORM_NOW"
    return 1
  fi
  if ! grep -qx "BAI_VERSION=$LOCK_VERSION_FROM" "$LOCK_OLD"; then
    result "prepare: lock боя G9q3" FAIL "в $LOCK_OLD не BAI_VERSION=$LOCK_VERSION_FROM"
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
    "$STUB_OLD_REF" "$STUB_NEW_REF"; do
    docker image inspect "$ref" >/dev/null 2>&1 \
      || { result "prepare: образ на хосте" FAIL "нет ${ref##*/} (docker load / pull)"; return 1; }
  done
  result "prepare: образы app и заглушек documents на хосте" ok "прежние и новые"
  # Синтетический .env стенда - как на бою после G9q3: ключей патча в нём нет (значения по
  # умолчанию compose); сценарий offswitch задаёт их явно.
  sed -i -E "/^($FLAG_PDF_TEXT|B24_CALL_RECORDING_[A-Z_]+)=/d" "$DEPLOY/.env"
  result "prepare: в .env стенда нет ключей G9r (как на бою после G9q3)" ok \
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
  record_started
  docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.Names}}\t{{.Image}}' | sort >"$OUT/containers-before.txt"
  [[ -n "$(env_of "$APP" "$YANDEX_CONCURRENCY_KEY")" \
    && -n "$(env_of "$APP" "$YANDEX_INTERVAL_KEY")" ]] \
    && result "prepare: у app переменные поиска G8w" ok "как на бою после G8w" \
    || result "prepare: у app переменные поиска G8w" FAIL "нет"
  check_old_flags prepare "до патча"
  check_b24 prepare absent
  check_docs_flags prepare "до патча"
  [[ -z "$(env_of "$DOCS" "$FLAG_PDF_TEXT")" ]] \
    && result "prepare: у documents нет значения $FLAG_PDF_TEXT (платформа 1.1.6)" ok "пусто" \
    || result "prepare: у documents нет значения $FLAG_PDF_TEXT (платформа 1.1.6)" FAIL "есть"
  [[ "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" | wc -l)" == 2 \
    && "$(http_code "$PORT_APP" /ready)" == 200 && "$(http_code "$PORT_DOCS" /health)" == 200 ]] \
    && result "prepare: заглушки app и documents отвечают с хоста" ok \
      "200 на $PORT_APP, $PORT_DOCS" \
    || result "prepare: заглушки app и documents отвечают с хоста" FAIL "нет 200"
  [[ "$(pages_from_host)" == "$PAGES_STATUS $PAGES_ERROR" ]] \
    && result "prepare: заглушка documents отвечает на POST $PAGES_ROUTE" ok \
      "$PAGES_STATUS $PAGES_ERROR" \
    || result "prepare: заглушка documents отвечает на POST $PAGES_ROUTE" FAIL \
      "иной ответ: $(pages_from_host)"
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

# check_old_flags <шаг> <когда>: переменные G9q2, G9q, G9p и G8z есть в окружении app (наличие).
check_old_flags() {
  local name missing=""
  for name in "${OLD_APP_FLAGS[@]}"; do
    [[ -n "$(env_of "$APP" "$name")" ]] || missing+=" $name"
  done
  [[ -z "$missing" ]] \
    && result "$1: у app переменные G9q2, G9q, G9p и G8z ($2)" ok "${OLD_APP_FLAGS[*]}" \
    || result "$1: у app переменные G9q2, G9q, G9p и G8z ($2)" FAIL "нет:$missing"
}

# check_b24 <шаг> <present|absent>: две новые переменные app от платформы 1.1.10 - есть и равны
# умолчаниям платформы (present) или отсутствуют (absent, платформа 1.1.6).
check_b24() {
  local item key got bad=""
  for item in "${B24_VARS[@]}"; do
    key="${item%%=*}"
    got="$(env_of "$APP" "$key")"
    if [[ "$2" == present ]]; then
      [[ "$got" == "${item#*=}" ]] || bad+=" $key=${got:-<нет>}"
    else
      [[ -z "$got" ]] || bad+=" $key=$got"
    fi
  done
  [[ -z "$bad" ]] \
    && result "$1: у app B24_CALL_RECORDING_* ($2)" ok "${B24_VARS[*]}" \
    || result "$1: у app B24_CALL_RECORDING_* ($2)" FAIL "$bad"
}

build_package() {
  local pkg_out="$OUT/package"
  rm -rf "${pkg_out:?}"
  bash "$HERE/build-patch-9r-package.sh" --out "$pkg_out" --lock "$STAND_LOCK_NEW" \
    --prev-lock "$STAND_LOCK_OLD" --signatures "$STAND_SIGNATURES" \
    ${RUNBOOK_FILE:+--runbook "$RUNBOOK_FILE"} >"$OUT/build-package.log" 2>&1 \
    || { result "package: сборка" FAIL "см. build-package.log (файлы patch-9r и платформа 1.1.10 \
должны быть в HEAD)"; return 1; }
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

# service_started <контейнер>: время старта; started_untouched <метка>: documents и app не
# перезапускались с момента prepare (StartedAt прежний).
record_started() {
  container_started "$DOCS" >"$OUT/docs-started.before"
  container_started "$APP" >"$OUT/app-started.before"
}
started_untouched() { # started_untouched <метка>
  [[ "$(container_started "$DOCS")" == "$(cat "$OUT/docs-started.before")" \
    && "$(container_started "$APP")" == "$(cat "$OUT/app-started.before")" ]] \
    && result "$1: documents и app не перезапускались" ok "StartedAt как до патча" \
    || result "$1: documents и app не перезапускались" FAIL "StartedAt изменился"
}

step_preflight() {
  build_package || return 1
  patch_run preflight --preflight-only
  [[ "$RC" == 0 ]] && result "preflight: код" ok "0 (PREFLIGHT_OK)" \
    || result "preflight: код" FAIL "$RC (preflight.log)"
  grep -q 'патч G9q3 применён: ok' "$OUT/preflight.log" \
    && result "preflight: патч G9q3 распознан как применённый" ok "запись в журнале" \
    || result "preflight: патч G9q3 распознан как применённый" FAIL "нет записи в журнале"
  grep -q 'правка PDF вне таблиц: ok' "$OUT/preflight.log" \
    && grep -q 'новые переменные app: ok' "$OUT/preflight.log" \
    && result "preflight: новые переменные платформы в новой конфигурации" ok "запись в журнале" \
    || result "preflight: новые переменные платформы в новой конфигурации" FAIL \
      "нет записи в журнале"
  grep -q 'прочая конфигурация: ok' "$OUT/preflight.log" \
    && result "preflight: прочая конфигурация сходится со снимком боя" ok "запись в журнале" \
    || result "preflight: прочая конфигурация сходится со снимком боя" FAIL "нет записи"
  unchanged_since_prepare preflight
  started_untouched preflight
}

step_refuse() {
  # Lock боя версии .6 (стоит только G9q2): предусловие «G9q3 применён» не выполнено - отказ ДО
  # замены.
  local keep="$OUT/images.lock.keep"
  cp -p "$DEPLOY/images.lock" "$keep"
  sed -i "s|^BAI_VERSION=.*|BAI_VERSION=$LOCK_VERSION_NOT_G9Q3|" "$DEPLOY/images.lock"
  patch_run refuse --preflight-only
  cp -p "$keep" "$DEPLOY/images.lock"
  [[ "$RC" == 3 ]] && result "refuse: код (G9q3 не применён)" ok "3 (отказ по предусловиям)" \
    || result "refuse: код (G9q3 не применён)" FAIL "$RC (refuse.log)"
  grep -q 'сначала примените патч G9q3' "$OUT/refuse.log" \
    && result "refuse: причина" ok "названа: сначала примените патч G9q3" \
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
  [[ "$(container_image "$DOCS")" == "$STUB_NEW_REF" ]] \
    && result "apply: documents на новом образе" ok "${STUB_NEW_REF##*/}" \
    || result "apply: documents на новом образе" FAIL "$(container_image "$DOCS")"
  [[ "$(container_started "$DOCS")" != "$(cat "$OUT/docs-started.before")" \
    && "$(container_started "$APP")" != "$(cat "$OUT/app-started.before")" ]] \
    && result "apply: documents и app пересозданы" ok "StartedAt изменился у обоих" \
    || result "apply: documents и app пересозданы" FAIL "StartedAt прежний"
  cmp -s "$DEPLOY/images.lock" "$STAND_LOCK_NEW" \
    && result "apply: images.lock боя равен lock пакета" ok "версия $(lock_ref "$STAND_LOCK_NEW" \
      BAI_VERSION)" \
    || result "apply: images.lock боя равен lock пакета" FAIL "различаются"
  cmp -s "$DEPLOY/platform/compose.base.yml" "$PKG/deploy/platform/compose.base.yml" \
    && cmp -s "$DEPLOY/platform/PLATFORM-VERSION" "$PKG/deploy/platform/PLATFORM-VERSION" \
    && result "apply: копия платформы боя равна пакетной (1.1.10)" ok "два файла" \
    || result "apply: копия платформы боя равна пакетной (1.1.10)" FAIL "различаются"
  cmp -s "$DEPLOY/compose.project.yml" "$PKG/deploy/compose.project.yml" \
    && result "apply: compose.project.yml боя равен файлу пакета" ok "как в пакете" \
    || result "apply: compose.project.yml боя равен файлу пакета" FAIL "различаются"
  diff <(tree_hash_no_patched) "$OUT/tree-before-no-patched.sha" >/dev/null \
    && result "apply: остальные файлы дерева прежние" ok \
      "побайтно (кроме lock, compose.project.yml и копии платформы)" \
    || result "apply: остальные файлы дерева прежние" FAIL "изменились"
  check_b24 apply present
  check_docs_flags apply "после патча"
  check_old_flags apply "после патча"
  local pdf_label="apply: у documents $FLAG_PDF_TEXT пусто (включено по умолчанию)"
  [[ -z "$(env_of "$DOCS" "$FLAG_PDF_TEXT")" ]] \
    && result "$pdf_label" ok "в .env ключа нет" \
    || result "$pdf_label" FAIL "значение: $(env_of "$DOCS" "$FLAG_PDF_TEXT")"
  [[ -n "$(env_of "$APP" "$YANDEX_CONCURRENCY_KEY")" \
    && -n "$(env_of "$APP" "$YANDEX_INTERVAL_KEY")" ]] \
    && result "apply: переменные Яндекса у app сохранились" ok "обе на месте" \
    || result "apply: переменные Яндекса у app сохранились" FAIL "пропали"
  [[ "$(pages_from_host)" == "$PAGES_STATUS $PAGES_ERROR" ]] \
    && result "apply: POST $PAGES_ROUTE отвечает с хоста" ok "$PAGES_STATUS $PAGES_ERROR" \
    || result "apply: POST $PAGES_ROUTE отвечает с хоста" FAIL "иной ответ: $(pages_from_host)"
  [[ "$(parse_from_host)" == "$PARSE_ON" ]] \
    && result "apply: POST $PARSE_ROUTE с locations=true отдаёт места PDF" ok "$PARSE_ON" \
    || result "apply: POST $PARSE_ROUTE с locations=true отдаёт места PDF" FAIL \
      "иной ответ: $(parse_from_host)"
  grep -q 'проба /docx/pages: ok' "$OUT/apply.log" \
    && grep -q 'проба /parse: ok' "$OUT/apply.log" \
    && result "apply: пробы /docx/pages и /parse прошли в patch.sh" ok "записи в журнале" \
    || result "apply: пробы /docx/pages и /parse прошли в patch.sh" FAIL "нет записей в журнале"
  local line_docs line_app
  line_docs="$(grep -n 'up -d --no-deps documents' "$OUT/apply.log" | head -1 | cut -d: -f1)"
  line_app="$(grep -n 'up -d --no-deps app' "$OUT/apply.log" | head -1 | cut -d: -f1)"
  [[ -n "$line_docs" && -n "$line_app" && "$line_docs" -lt "$line_app" ]] \
    && result "apply: сначала пересоздан documents, затем app" ok "порядок в журнале" \
    || result "apply: сначала пересоздан documents, затем app" FAIL "порядок иной или нет записей"
  downtime docs documents
  downtime app app
  [[ "$(tail -2 "$OUT/poll.txt" | awk '$3 == 200' | wc -l)" == 2 ]] \
    && result "apply: в конце опроса documents и app отвечают" ok "200 и 200" \
    || result "apply: в конце опроса documents и app отвечают" FAIL "нет 200"
  local backup
  backup="$(find "$OUT/backups" -maxdepth 1 -name 'pragmatika-patch9r-*' 2>/dev/null | head -1)"
  [[ -n "$backup" ]] \
    && result "apply: бэкап файлов дерева" ok "$(basename "$backup")" \
    || result "apply: бэкап файлов дерева" FAIL "нет каталога бэкапа"
  RUN_APPLIED="$(readlink -f "$OUT/home/patch-9r-latest")"
}

# Необязательный шаг runbook: выключатель флагов и откат .env (после apply, до rollback патча).
step_enable() {
  local got
  cp -p "$DEPLOY/.env" "$OUT/env.before-enable"
  flags_run enable_dry --pdf-text "$FLAG_OFF" --text-blocks "$FLAG_OFF" --dry-run
  [[ "$RC" == 0 ]] && cmp -s "$DEPLOY/.env" "$OUT/env.before-enable" \
    && result "enable: --dry-run" ok "код 0, .env не тронут" \
    || result "enable: --dry-run" FAIL "$RC (enable_dry.log)"
  flags_run enable --pdf-text "$FLAG_OFF" --text-blocks "$FLAG_OFF"
  [[ "$RC" == 0 ]] && result "enable: код" ok "0 (enable.log)" \
    || result "enable: код" FAIL "$RC (enable.log)"
  [[ "$(env_of "$DOCS" "$FLAG_PDF_TEXT")" == "$FLAG_OFF" \
    && "$(env_of "$APP" "$FLAG_TEXT_BLOCKS")" == "$FLAG_OFF" ]] \
    && result "enable: у documents и app флаги = false (выключены)" ok \
      "$FLAG_PDF_TEXT, $FLAG_TEXT_BLOCKS" \
    || result "enable: у documents и app флаги = false (выключены)" FAIL \
      "documents $(env_of "$DOCS" "$FLAG_PDF_TEXT"), app $(env_of "$APP" "$FLAG_TEXT_BLOCKS")"
  got="$(parse_from_host)"
  [[ "$got" == "$PARSE_OFF" ]] \
    && result "enable: /parse с хоста без locations (правка PDF вне таблиц выключена)" ok "$got" \
    || result "enable: /parse с хоста без locations (правка PDF вне таблиц выключена)" FAIL "$got"
  [[ "$(http_code "$PORT_APP" /ready)" == 200 && "$(http_code "$PORT_DOCS" /health)" == 200 ]] \
    && result "enable: documents и app отвечают с хоста" ok "200 и 200" \
    || result "enable: documents и app отвечают с хоста" FAIL "нет 200"
  flags_run enable_rollback --rollback
  [[ "$RC" == 0 ]] && cmp -s "$DEPLOY/.env" "$OUT/env.before-enable" \
    && result "enable: --rollback возвращает .env побайтно" ok "код 0" \
    || result "enable: --rollback возвращает .env побайтно" FAIL "$RC (enable_rollback.log)"
  [[ -z "$(env_of "$DOCS" "$FLAG_PDF_TEXT")" \
    && "$(env_of "$APP" "$FLAG_TEXT_BLOCKS")" == "$FLAG_ON" ]] \
    && result "enable: после отката у documents пусто, у app true" ok "как до выключения" \
    || result "enable: после отката у documents пусто, у app true" FAIL "иные значения"
  got="$(parse_from_host)"
  [[ "$got" == "$PARSE_ON" ]] \
    && result "enable: после отката /parse снова отдаёт места PDF" ok "$got" \
    || result "enable: после отката /parse снова отдаёт места PDF" FAIL "$got"
  # Синтетический .env возвращается к состоянию prepare.
  cp -p "$OUT/env.keep" "$DEPLOY/.env"
}

step_rollback() {
  [[ -n "${RUN_APPLIED:-}" ]] || RUN_APPLIED="$(readlink -f "$OUT/home/patch-9r-latest")"
  patch_run rollback --rollback --run-dir "$RUN_APPLIED"
  [[ "$RC" == 0 ]] && result "rollback: код" ok "0 (rollback.log)" \
    || result "rollback: код" FAIL "$RC (rollback.log)"
  unchanged_since_prepare rollback
  check_docs_flags rollback "после отката"
  check_old_flags rollback "после отката"
  check_b24 rollback absent
  [[ -z "$(env_of "$DOCS" "$FLAG_PDF_TEXT")" ]] \
    && result "rollback: у documents снова нет значения $FLAG_PDF_TEXT (платформа 1.1.6)" ok \
      "пусто" \
    || result "rollback: у documents снова нет значения $FLAG_PDF_TEXT (платформа 1.1.6)" FAIL \
      "есть"
  [[ "$(http_code "$PORT_APP" /ready)" == 200 && "$(http_code "$PORT_DOCS" /health)" == 200 ]] \
    && result "rollback: documents и app отвечают с хоста" ok "200 и 200" \
    || result "rollback: documents и app отвечают с хоста" FAIL "нет 200"
}

# Явный выключатель в .env боя: патч не отказывает, .env не меняет, правка PDF вне таблиц
# остаётся выключенной (функция выключена, это не отказ).
step_offswitch() {
  printf '%s=%s\n' "$FLAG_PDF_TEXT" "$FLAG_OFF" >>"$DEPLOY/.env"
  cp -p "$DEPLOY/.env" "$OUT/env.offswitch"
  patch_run offswitch
  [[ "$RC" == 0 ]] && result "offswitch: код (патч не отказывает при явном false)" ok \
    "0 (offswitch.log)" \
    || result "offswitch: код (патч не отказывает при явном false)" FAIL "$RC (offswitch.log)"
  [[ "$(container_image "$APP")" == "$(lock_ref "$STAND_LOCK_NEW" BAI_IMAGE_APP)" \
    && "$(container_image "$DOCS")" == "$STUB_NEW_REF" ]] \
    && result "offswitch: documents и app на новых образах" ok "как при обычном патче" \
    || result "offswitch: documents и app на новых образах" FAIL \
      "app $(container_image "$APP"), documents $(container_image "$DOCS")"
  cmp -s "$DEPLOY/.env" "$OUT/env.offswitch" \
    && result "offswitch: .env боя патч не менял" ok "побайтно прежний" \
    || result "offswitch: .env боя патч не менял" FAIL "различается"
  [[ "$(env_of "$DOCS" "$FLAG_PDF_TEXT")" == "$FLAG_OFF" ]] \
    && result "offswitch: у documents $FLAG_PDF_TEXT остаётся false" ok "значение из .env" \
    || result "offswitch: у documents $FLAG_PDF_TEXT остаётся false" FAIL \
      "$(env_of "$DOCS" "$FLAG_PDF_TEXT")"
  [[ "$(parse_from_host)" == "$PARSE_OFF" ]] \
    && result "offswitch: /parse с хоста без locations" ok "$PARSE_OFF" \
    || result "offswitch: /parse с хоста без locations" FAIL "$(parse_from_host)"
  grep -q "$FLAG_PDF_TEXT выключен выключателем" "$OUT/offswitch.log" \
    && result "offswitch: журнал называет функцию выключенной выключателем" ok "запись в журнале" \
    || result "offswitch: журнал называет функцию выключенной выключателем" FAIL "нет записи"
  patch_run offswitch_rollback --rollback --run-dir \
    "$(readlink -f "$OUT/home/patch-9r-latest")"
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
    && "$(container_image "$DOCS")" == "$STUB_OLD_REF" ]] \
    && result "broken: documents и app снова на образах G9q3" ok "как до патча" \
    || result "broken: documents и app снова на образах G9q3" FAIL \
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
STUB_OLD_REF=""
STUB_NEW_REF=""
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
