#!/usr/bin/env bash
# Проверка пакета переключения на синтетическом «бое» (Fornex): cutover -> rollback -> cutover.
# Бой (pragmatika-ru) не затрагивается. Нужен поднятый синтетический бой этапа (`synth-up.sh`:
# проект pragmatika-s8, postgres + pseudonymizer прежней сборки) и собранный пакет.
#
# Использование:
#   bash tools/cutover-synth.sh [--steps список] [--no-build] [--help]
#   Шаги (по умолчанию все по порядку): prepare preflight forced rollback1 cutover2 restore
#   cutover3. Каждый шаг после выполнения проверяет: /ready, данные синтетической БД на месте,
#   схему и учёт миграций.
#
# audit_log и jobs в сравнение чисел строк не входят: штатный backup.sh сам пишет в них записи
# о бэкапе, их рост - нормальная работа боя, а не потеря данных.
# Окружение: SYNTH (каталог синтетического боя), OUT (каталог результатов проверки),
# DOCKER_CONFIG (временный вход в реестр, нужен cosign и pull образов).
# Ход фиксируется в $OUT/steps.tsv (шаг, результат, пояснение) и $OUT/summary.txt.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPORTS="${REPORTS:-$HOME/reports/business-ai-modular}"
SYNTH="${SYNTH:-$REPORTS/stage-8/tmp/synth8}"
OUT="${OUT:-$REPORTS/stage-8/tmp/cutover-test}"
LOCK_SRC="${LOCK_SRC:-$REPORTS/stage-7/package/images.lock}"
SCHEMA_SRC="${SCHEMA_SRC:-$REPORTS/stage-7/package/schema-expected.sql}"
PUB_SRC="${PUB_SRC:-$REPORTS/stage-7/package/cosign.pub}"
SIGNATURES="${SIGNATURES:-$REPORTS/stage-8/tmp/signatures.txt}"
PROJECT="pragmatika-s8"
EXPECT_PSEUDO=""
PG="$PROJECT-postgres-1"
PSEUDO="$PROJECT-pseudonymizer-1"
APP="$PROJECT-app-1"
PG_USER="pragmatika"
PG_DB="pragmatika"
SOAK_S=15
STANDIN_DIR="$HERE/../deploy/cutover/standin"
EXPECT_BOTS_OLD=4
STEPS_DEFAULT="prepare preflight forced rollback1 cutover2 restore cutover3"
STEPS="$STEPS_DEFAULT"
NO_BUILD=0

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
while (($#)); do
  case "$1" in
    --steps) STEPS="${2:?--steps список}"; shift ;;
    --no-build) NO_BUILD=1 ;;
    --help | -h) usage; exit 0 ;;
    *) echo "неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
  shift
done

# Окружение штатного backup.sh синтетики (на бою его задают systemd-юнит и системный PATH).
export PATH="$SYNTH/bin:$PATH" PRAGMATIKA_ENV="$SYNTH/code/deploy/.env"
export SECRETS_DIR="$SYNTH/etc/secrets" COMPOSE_PROJECT_NAME="$PROJECT"
export BACKUP_LOCAL_DIR="$SYNTH/backups"

mkdir -p "$OUT"
PKG="$OUT/package"
CONF="$OUT/cutover-test.conf"
STEPS_FILE="$OUT/steps.tsv"
FAILS=0
log() { printf '%s %s\n' "$(date -u +%T)" "$*"; }
result() { # result <шаг> <ok|FAIL> <пояснение>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$STEPS_FILE"
  log "[$2] $1: $3"
  [[ "$2" == ok ]] || FAILS=$((FAILS + 1))
}
psql_pg() { docker exec "$PG" psql -U "$PG_USER" -d "$PG_DB" -Atq "$@"; }

# --- снимок состояния ----------------------------------------------------------------------------
COUNT_SQL="SELECT table_name || '=' || (xpath('/row/c/text()', query_to_xml(format(
 'select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
 FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
 AND table_name NOT IN ('schema_migrations', 'audit_log', 'jobs') ORDER BY table_name"
PSEUDO_PY='import json, os, sqlite3, sys, urllib.request
base = "http://127.0.0.1:8300"
hdr = {"Authorization": "Bearer " + os.environ["PSEUDONYMIZER_API_TOKEN"],
       "Content-Type": "application/json"}
def post(path, body):
    req = urllib.request.Request(base + path, json.dumps(body).encode(), hdr, method="POST")
    return json.load(urllib.request.urlopen(req, timeout=60))
thread, text = sys.argv[1], sys.argv[2]
masked = post("/pseudonymize", {"thread_id": thread, "text": text})
restored = post("/restore", {"thread_id": thread, "text": masked["text"]})
print("masked=%s restored=%s" % (masked["text"] != text, restored["text"] == text))'
PSEUDO_COUNT_PY='import sqlite3
c = sqlite3.connect("file:/data/pseudonymizer.sqlite3?mode=ro", uri=True)
print(c.execute("select count(*) from replacements").fetchone()[0])'

snapshot() { # snapshot <имя>: числа строк, схема, учёт миграций, контейнеры
  local d="$OUT/snap-$1"
  mkdir -p "$d"
  psql_pg -c "$COUNT_SQL" >"$d/counts.txt"
  docker exec "$PG" pg_dump -U "$PG_USER" -d "$PG_DB" --schema-only --no-owner --no-privileges \
    | grep -v '^\\\(un\)\?restrict ' | sha256sum | cut -d' ' -f1 >"$d/schema.sha256"
  psql_pg -c "SELECT version FROM schema_migrations ORDER BY version" >"$d/migrations.txt"
  docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.Names}}' | sort >"$d/containers.txt"
  docker exec "$PSEUDO" python3 -c "$PSEUDO_COUNT_PY" >"$d/pseudo-count.txt" 2>/dev/null \
    || echo "?" >"$d/pseudo-count.txt"
}

ready_ok() { # ready_ok <контейнер app>: 200 на /ready из одноразового контейнера
  local image body
  image="$(docker inspect -f '{{.Image}}' "$1")"
  body="$(docker run --rm --network "container:$1" --entrypoint bun "$image" -e \
    "const r = await fetch('http://127.0.0.1:8088/ready'); console.log(r.status)" 2>&1 || true)"
  [[ "$body" == 200 ]]
}

# --- общие шаги проверки -------------------------------------------------------------------------
compare_base() { # compare_base <метка> <допускать рост проекта 0|1>
  snapshot "$1"
  local b="$OUT/snap-base" s="$OUT/snap-$1" diff_counts diff_mig
  diff_counts="$(diff "$b/counts.txt" "$s/counts.txt" || true)"
  if [[ -z "$diff_counts" ]]; then
    result "$1: числа строк БД" ok "совпали с исходными: $(wc -l <"$b/counts.txt") таблиц"
  else
    result "$1: числа строк БД" FAIL "расхождение: $(tr '\n' ' ' <<<"$diff_counts" | cut -c1-200)"
  fi
  local want="${EXPECT_PSEUDO:-$(cat "$b/pseudo-count.txt")}"
  if [[ "$want" == "$(cat "$s/pseudo-count.txt")" ]]; then
    result "$1: хранилище псевдонимизатора" ok "записей $(cat "$s/pseudo-count.txt")"
  else
    result "$1: хранилище псевдонимизатора" FAIL \
      "ожидалось $want, стало $(cat "$s/pseudo-count.txt")"
  fi
  if [[ "$2" == 1 ]]; then
    diff_mig="$(diff "$b/migrations.txt" "$s/migrations.txt" || true)"
    [[ -z "$diff_mig" ]] \
      && result "$1: schema_migrations" ok "как до переключения ($(wc -l <"$s/migrations.txt") записей)" \
      || result "$1: schema_migrations" FAIL "$(wc -l <"$s/migrations.txt") записей, не как до"
    [[ "$(cat "$b/schema.sha256")" == "$(cat "$s/schema.sha256")" ]] \
      && result "$1: схема БД" ok "pg_dump --schema-only побайтно как до переключения" \
      || result "$1: схема БД" FAIL "схема отличается от исходной"
    [[ "$(cat "$b/containers.txt")" == "$(cat "$s/containers.txt")" ]] \
      && result "$1: контейнеры" ok "$(tr '\n' ' ' <"$s/containers.txt")" \
      || result "$1: контейнеры" FAIL "набор отличается: $(tr '\n' ' ' <"$s/containers.txt")"
  fi
}

run_cutover() { # run_cutover <метка> <ожидаемый код> [аргументы]
  local label="$1" want="$2" rc=0
  shift 2
  log "== cutover.sh ($label): ожидается код $want"
  bash "$PKG/cutover.sh" --config "$CONF" "$@" >"$OUT/cutover-$label.log" 2>&1 || rc=$?
  if [[ "$rc" == "$want" ]]; then
    result "$label: код cutover.sh" ok "$rc"
  else
    result "$label: код cutover.sh" FAIL "получен $rc, ожидался $want (cutover-$label.log)"
  fi
}

pseudo_probe() { # pseudo_probe <метка> <тред> <текст>
  local out
  out="$(docker exec "$PSEUDO" python3 -c "$PSEUDO_PY" "$2" "$3" 2>&1 | tail -1)"
  if [[ "$out" == "masked=True restored=True" ]]; then
    result "$1: псевдонимизатор" ok "маскирование и восстановление на выдуманном тексте ($2)"
  else
    result "$1: псевдонимизатор" FAIL "${out:0:120}"
  fi
}

RESTORE_PY='import json, os, sys, urllib.request
hdr = {"Authorization": "Bearer " + os.environ["PSEUDONYMIZER_API_TOKEN"],
       "Content-Type": "application/json"}
body = {"thread_id": sys.argv[1], "text": sys.argv[2]}
req = urllib.request.Request("http://127.0.0.1:8300/restore", json.dumps(body).encode(), hdr,
                             method="POST")
text = json.load(urllib.request.urlopen(req, timeout=60))["text"]
print("restored=%s" % (bool(text) and text != sys.argv[2]))'

old_thread_probe() { # old_thread_probe <метка>: токен старого треда раскрывается
  local out
  out="$(docker exec "$PSEUDO" python3 -c "$RESTORE_PY" "synth-thread-0" "[CONTACT_1]" 2>&1 | tail -1)"
  [[ "$out" == "restored=True" ]] \
    && result "$1: токен старого треда" ok "раскрывается" \
    || result "$1: токен старого треда" FAIL "${out:0:120}"
}

# --- шаги ----------------------------------------------------------------------------------------
step_prepare() {
  : >"$STEPS_FILE"
  docker ps --format '{{.Names}}' | grep -qx "$PG" || { echo "синтетический бой не поднят"; exit 1; }
  if ((NO_BUILD == 0)); then
    rm -rf "${PKG:?}"
    bash "$HERE/build-cutover-package.sh" --out "$PKG" --lock "$LOCK_SRC" \
      --schema-expected "$SCHEMA_SRC" --cosign-pub "$PUB_SRC" >"$OUT/build.log" 2>&1
  fi
  (cd "$PKG" && sha256sum -c --quiet MANIFEST.sha256)
  result "prepare: пакет" ok "собран из HEAD $(git -C "$ROOT" rev-parse --short HEAD), манифест сходится"
  local env_file="$SYNTH/code/deploy/.env"
  # Тома боя принадлежат uid app (на бою их создал прежний app); в синтетике app прежний - заглушка,
  # поэтому владельца выставляем так же, как на бою, иначе проверка записи в тома честно откажет.
  local app_image app_uid vol pg_image
  app_image="$(grep -E '^BAI_IMAGE_APP=' "$LOCK_SRC" | cut -d= -f2-)"
  app_uid="$(docker run --rm --entrypoint id "$app_image" -u)"
  pg_image="$(docker inspect -f '{{.Config.Image}}' "$PG")"
  for vol in intake-data file-spool documents-exchange; do
    docker run --rm --user 0 --entrypoint chown -v "${PROJECT}_${vol}:/v" "$pg_image" \
      -R "$app_uid:$app_uid" /v
  done
  # Боевой вид .env: пути правил доступа, шаблонов и local (как у владельца), в синтетике свои.
  mkdir -p "$SYNTH/data/templates" "$SYNTH/data/local" "$SYNTH/data/documents"
  sed -i '/^ACCESS_POLICY_FILE=/d;/^TEMPLATES_HOST_DIR=/d;/^LOCAL_HOST_DIR=/d' "$env_file"
  {
    echo "ACCESS_POLICY_FILE=/etc/pragmatika/access/access-policy.json"
    echo "TEMPLATES_HOST_DIR=$SYNTH/data/templates"
    echo "LOCAL_HOST_DIR=$SYNTH/data/local"
  } >>"$env_file"
  grep -E '^(ACCESS_POLICY_HOST_DIR|DOCUMENTS_HOST_DIR|MAIL_HOST_DIR|ACCESS_POLICY_FILE|TEMPLATES_HOST_DIR|LOCAL_HOST_DIR)=' \
    "$env_file" >"$OUT/expected-host-dirs.txt"
  # Заглушка прежнего app в бое: без неё нет ни /ready до переключения, ни возврата на прежний стек.
  cat >"$OUT/v2-test.env" <<EOF
LITELLM_API_KEY=stub
GATEWAY_HOST=gateway.invalid
GATEWAY_TLS_NAME=gateway.invalid
WEB_SEARCH_PROVIDER=disabled
WEB_FETCH_ENABLED=false
IMAGE_TEXT_OCR_IN_DOCUMENTS=true
OWNER_THREAD_ID=synth-owner
BAI_LOG_TAG=$PROJECT
EOF
  cat >"$CONF" <<EOF
CUTOVER_PROJECT=$PROJECT
CUTOVER_OLD_DIR=$SYNTH/code
CUTOVER_ENV_FILE=$env_file
CUTOVER_SECRETS_DIR=$SYNTH/etc/secrets
CUTOVER_NEW_DIR=$OUT/opt-v2
CUTOVER_HOME=$OUT/home
CUTOVER_BACKUP_ROOT=$OUT/backups
CUTOVER_OUT_DIR=$OUT/results
CUTOVER_OLD_EXTRA_COMPOSE=$STANDIN_DIR/old-app.compose.yml
CUTOVER_EXTRA_COMPOSE=$STANDIN_DIR/v2-test.compose.yml
CUTOVER_EXTRA_ENV=$OUT/v2-test.env
CUTOVER_EXPECTED_HOST_DIRS=$OUT/expected-host-dirs.txt
CUTOVER_SERVICES=postgres pseudonymizer model-stub app
CUTOVER_EXPECT_BOTS=0
CUTOVER_MIN_DISK_MIB=1024
CUTOVER_MIN_AVAILABLE_MIB=1024
CUTOVER_SOAK_POLL_S=5
CUTOVER_HEALTH_WAIT_S=180
CUTOVER_READY_WAIT_S=90
EOF
  mkdir -p "$OUT/results" "$OUT/backups"
  export STANDIN_DIR STANDIN_BOTS="$EXPECT_BOTS_OLD"
  # Поднять заглушку прежнего app рядом с боем синтетики (прежний compose + надстройка).
  (cd "$SYNTH/code/deploy" && docker compose -p "$PROJECT" --env-file .env \
    --env-file "$SYNTH/etc/secrets/secrets.env" -f docker-compose.yml \
    -f "$STANDIN_DIR/old-app.compose.yml" up -d --no-build --no-deps \
    postgres pseudonymizer app) >"$OUT/old-app-up.log" 2>&1 \
    || { tail -5 "$OUT/old-app-up.log"; exit 1; }
  sleep 6
  ready_ok "$APP" && result "prepare: заглушка прежнего app" ok "/ready 200" \
    || result "prepare: заглушка прежнего app" FAIL "/ready не 200"
  snapshot base
  result "prepare: исходный снимок" ok "$(wc -l <"$OUT/snap-base/counts.txt") таблиц, хранилище $(cat \
    "$OUT/snap-base/pseudo-count.txt"), схема $(cut -c1-12 "$OUT/snap-base/schema.sha256")"
}

cut_args=(--signatures-verified "$SIGNATURES" --soak-seconds "$SOAK_S")

step_preflight() {
  run_cutover preflight 0 "${cut_args[@]}" --preflight-only
  compare_base preflight 1
  ready_ok "$APP" && result "preflight: /ready прежнего стека" ok "200" \
    || result "preflight: /ready прежнего стека" FAIL "не 200"
}

step_forced() {
  # Ожидаем 4 бота, у v2 без каналов их 0: проверка в конце хода падает -> автооткат.
  run_cutover forced 1 "${cut_args[@]}" --expected-bots 4
  grep -q 'автоматический откат' "$OUT/cutover-forced.log" \
    && result "forced: автооткат запущен" ok "в журнале есть запись" \
    || result "forced: автооткат запущен" FAIL "нет записи об откате"
  compare_base forced 1
  ready_ok "$APP" && result "forced: /ready после автоотката" ok "200 (прежняя заглушка)" \
    || result "forced: /ready после автоотката" FAIL "не 200"
}

step_cutover1() {
  run_cutover cutover1 0 "${cut_args[@]}"
  ready_ok "$APP" && result "cutover1: /ready v2" ok "200" || result "cutover1: /ready v2" FAIL "не 200"
  compare_base cutover1 0
  old_thread_probe cutover1
  pseudo_probe cutover1 "synth-v2-thread" "Контакт: Ромашков Иван Петрович, +7 (900) 555-01-02"
  snapshot after-probe
  EXPECT_PSEUDO="$(cat "$OUT/snap-after-probe/pseudo-count.txt")"
  docker exec "$PG" psql -U "$PG_USER" -d "$PG_DB" -Atc \
    "SELECT count(*) FROM information_schema.columns WHERE table_name='knowledge_chunks' AND column_name='scope'" \
    | grep -qx 1 && result "cutover1: схема v2" ok "knowledge_chunks.scope есть" \
    || result "cutover1: схема v2" FAIL "knowledge_chunks.scope нет"
}

step_rollback1() {
  local rc=0
  step_cutover1
  bash "$PKG/rollback.sh" >"$OUT/rollback1.log" 2>&1 || rc=$?
  [[ "$rc" == 0 ]] && result "rollback1: код rollback.sh" ok 0 \
    || result "rollback1: код rollback.sh" FAIL "$rc (rollback1.log)"
  compare_base rollback1 1
  ready_ok "$APP" && result "rollback1: /ready прежнего стека" ok "200" \
    || result "rollback1: /ready прежнего стека" FAIL "не 200"
  # Прежний псевдонимизатор читает записи, созданные под v2 (откат не ломает хранилище).
  old_thread_probe rollback1
  pseudo_probe rollback1 "synth-v2-thread" "Контакт: Ромашков Иван Петрович, +7 (900) 555-01-02"
  psql_pg -c "SELECT count(*) FROM information_schema.columns WHERE table_name='knowledge_chunks' AND column_name='supplier_id'" \
    | grep -qx 1 && result "rollback1: схема прежняя" ok "supplier_id на месте" \
    || result "rollback1: схема прежняя" FAIL "supplier_id нет"
}

step_cutover2() {
  run_cutover cutover2 0 "${cut_args[@]}"
  ready_ok "$APP" && result "cutover2: /ready v2" ok "200" || result "cutover2: /ready v2" FAIL "не 200"
  compare_base cutover2 0
}

step_restore() {
  local rc=0
  bash "$PKG/rollback.sh" --restore-db --i-understand-data-loss >"$OUT/restore.log" 2>&1 || rc=$?
  [[ "$rc" == 0 ]] && result "restore: код rollback.sh --restore-db" ok 0 \
    || result "restore: код rollback.sh --restore-db" FAIL "$rc (restore.log)"
  compare_base restore 1
  psql_pg -d postgres -c "SELECT count(*) FROM pg_database WHERE datname LIKE '${PG_DB}_after_v2_%'" \
    | grep -qx 1 && result "restore: БД после v2 сохранена" ok "переименована, не удалена" \
    || result "restore: БД после v2 сохранена" FAIL "базы *_after_v2_* нет"
  ready_ok "$APP" && result "restore: /ready прежнего стека" ok "200" \
    || result "restore: /ready прежнего стека" FAIL "не 200"
}

step_cutover3() {
  run_cutover cutover3 0 "${cut_args[@]}"
  ready_ok "$APP" && result "cutover3: /ready v2" ok "200" || result "cutover3: /ready v2" FAIL "не 200"
  compare_base cutover3 0
}

for s in $STEPS; do
  log "######## шаг $s"
  case "$s" in
    prepare) step_prepare ;;
    preflight) step_preflight ;;
    forced) step_forced ;;
    rollback1) step_rollback1 ;;
    cutover2) step_cutover2 ;;
    restore) step_restore ;;
    cutover3) step_cutover3 ;;
    *) echo "неизвестный шаг $s" >&2; exit 2 ;;
  esac
done
{ echo "проверок: $(wc -l <"$STEPS_FILE"), провалено: $FAILS"; cat "$STEPS_FILE"; } >"$OUT/summary.txt"
log "итог: проверок $(wc -l <"$STEPS_FILE"), провалено $FAILS (summary.txt)"
[[ "$FAILS" -eq 0 ]]
