#!/usr/bin/env bash
# Проверка миграций Прагматики v2 на временном PostgreSQL (три сценария).
#
#   bash tools/check-migrations.sh            все три сценария
#   bash tools/check-migrations.sh 1 3        только перечисленные
#
# Сценарии (раннер платформы берётся из git-объектов PLATFORM_REPO@PLATFORM_REF):
#   1. пустая база + раннер платформы (platform + app): схема равна эталону
#      stage-0/baseline/migrations/schema-from-migrations.sql с точностью до объектов из
#      db/allowed-schema-diff.txt (точное совпадение набора различий, лишнее - тоже ошибка);
#   2. база, поднятая прежним раннером Прагматики на SRC_COMMIT (42 миграции): новый раннер
#      с картой показывает pending только у новых миграций проекта; после применения
#      схема равна схеме сценария 1;
#   3. схема с боя (schema.sql без данных + schema_migrations.txt, 40 миграций): pending -
#      только версии, которых на бою нет (app 041/042 и новые миграции проекта); после
#      применения схема равна схеме сценария 1.
#
# Postgres - контейнер pgvector/pgvector:0.8.6-pg16 на 127.0.0.1:20600-20649, данные в tmpfs
# (диск хоста почти полон). Скрипт сам поднимает и гасит контейнер, работает под flock
# heavy.lock, пишет протокол в $WORK/check.log. Код выхода: 0 - всё сошлось, 1 - расхождение,
# 2 - ошибка окружения, 3 - не хватает ресурсов хоста.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BAI_HOME="${BAI_HOME:-$HOME/reports/business-ai-modular}"
WORK="${WORK:-$BAI_HOME/stage-6/tmp/migr}"
LOCK_FILE="$BAI_HOME/heavy.lock"

# --- Константы -----------------------------------------------------------------------------
PG_IMAGE="pgvector/pgvector:0.8.6-pg16"
CONTAINER="bai6-migr-pg"
PORT_FIRST=20600
PORT_LAST=20649
STAGE_LABEL="bai.stage=6"
PG_READY_TRIES=60
RUNNER_TIMEOUT_SEC=300
# Пороги ресурсов хоста (общие правила этапов) и ожидание при нехватке.
MIN_DISK_GIB=8
MIN_RAM_MIB=3072
MIB_PER_GIB=1024
RESOURCE_RETRIES=3
RESOURCE_WAIT_SEC="${RESOURCE_WAIT_SEC:-600}"
E2E_WAIT_SEC=60
E2E_WAIT_TRIES=30

PLATFORM_REPO="${PLATFORM_REPO:-$HOME/wt-bai-modular}"
PLATFORM_REF="${PLATFORM_REF:-v1.0.0}"
SRC_REPO="${SRC_REPO:-$HOME/pragmatika-purchasing}"
SRC_COMMIT="${SRC_COMMIT:-5ea7f2d308beb476fb8b6fe05e095587c9ee4f40}"
BASELINE_SCHEMA="${BASELINE_SCHEMA:-$BAI_HOME/stage-0/baseline/migrations/schema-from-migrations.sql}"
PROD_DIR="${PROD_DIR:-$BAI_HOME/stage-0/prod/extracted/baseline-prod-20261108T012904Z}"
ALLOWED_FILE="${ALLOWED_FILE:-$ROOT/db/allowed-schema-diff.txt}"
NEW_APP_FILE="$ROOT/tools/check_migrations_new_app.txt"
SCHEMA_PY="$ROOT/tools/check_migrations_schema.py"
APP_DIR="$ROOT/db/app"

FAILS=0
declare -a SUMMARY=()
PORT=""
CONTAINER_UP=0

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
die() { echo "ОШИБКА: $*" >&2; exit 2; }
verdict() { # verdict <OK|FAIL> <текст>
  SUMMARY+=("$1  $2")
  [[ "$1" == "OK" ]] || FAILS=$((FAILS + 1))
  log "$1: $2"
}

cleanup() {
  local rc=$?
  if [[ "$CONTAINER_UP" -eq 1 ]]; then
    docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
    log "контейнер $CONTAINER погашен"
  fi
  if [[ -n "$PORT" ]] && ss -ltn 2>/dev/null | grep -q "127.0.0.1:$PORT "; then
    echo "ПРЕДУПРЕЖДЕНИЕ: порт $PORT всё ещё слушается" >&2
  fi
  exit "$rc"
}
trap cleanup EXIT

# --- Ожидание ресурсов (до блокировки, чтобы не держать общий heavy.lock впустую) ----------
resources_ok() {
  local avail_mib disk_mib
  avail_mib="$(free -m | awk '/^Mem:/{print $7}')"
  disk_mib="$(df -BM --output=avail / | tail -n 1 | tr -dc '0-9')"
  log "ресурсы: RAM available ${avail_mib} МиБ, диск / свободно ${disk_mib} МиБ"
  [[ "$avail_mib" -ge "$MIN_RAM_MIB" && "$disk_mib" -ge $((MIN_DISK_GIB * MIB_PER_GIB)) ]]
}

wait_resources() {
  local attempt
  for ((attempt = 1; attempt <= RESOURCE_RETRIES; attempt++)); do
    if resources_ok; then
      return 0
    fi
    log "ресурсов мало (попытка $attempt из $RESOURCE_RETRIES), жду ${RESOURCE_WAIT_SEC} с"
    sleep "$RESOURCE_WAIT_SEC"
  done
  if resources_ok; then
    return 0
  fi
  echo "не выполнено: нет ресурсов (порог: диск ${MIN_DISK_GIB} ГиБ, RAM ${MIN_RAM_MIB} МиБ)" >&2
  exit 3
}

wait_e2e() {
  local attempt
  for ((attempt = 1; attempt <= E2E_WAIT_TRIES; attempt++)); do
    pgrep -af 'e2e/run.sh' >/dev/null 2>&1 || return 0
    log "идёт чужой e2e, жду ${E2E_WAIT_SEC} с"
    sleep "$E2E_WAIT_SEC"
  done
  die "чужой e2e не закончился"
}

# --- Блокировка и перезапуск под flock -----------------------------------------------------
mkdir -p "$WORK"
if [[ -z "${CHECK_MIGRATIONS_LOCKED:-}" ]]; then
  wait_e2e
  wait_resources
  export CHECK_MIGRATIONS_LOCKED=1
  exec flock "$LOCK_FILE" bash "${BASH_SOURCE[0]}" "$@"
fi

LOG="$WORK/check.log"
exec > >(tee "$LOG") 2>&1

# --- Входные данные из git-объектов --------------------------------------------------------
prepare_inputs() {
  command -v docker >/dev/null || die "нет docker"
  command -v psql >/dev/null || die "нет psql (нужен клиент для раннеров)"
  [[ -f "$BASELINE_SCHEMA" ]] || die "нет эталона схемы: $BASELINE_SCHEMA"
  [[ -f "$ALLOWED_FILE" ]] || die "нет файла допустимых различий: $ALLOWED_FILE"
  git -C "$PLATFORM_REPO" cat-file -e "$PLATFORM_REF^{commit}" || die "нет $PLATFORM_REF в платформе"
  git -C "$SRC_REPO" cat-file -e "$SRC_COMMIT^{commit}" || die "нет $SRC_COMMIT в старом репозитории"
  rm -rf "${WORK:?}/platform-db" "${WORK:?}/src-db"
  mkdir -p "$WORK/platform-db" "$WORK/src-db"
  git -C "$PLATFORM_REPO" archive "$PLATFORM_REF" db | tar -x -C "$WORK/platform-db"
  git -C "$SRC_REPO" archive "$SRC_COMMIT" db/migrate.sh db/migrations | tar -x -C "$WORK/src-db"
  PLATFORM_RUNNER="$WORK/platform-db/db/migrate.sh"
  OLD_RUNNER="$WORK/src-db/db/migrate.sh"
  N_PLATFORM="$(find "$WORK/platform-db/db/platform" -maxdepth 1 -name '*.sql' | wc -l)"
  N_APP="$(find "$APP_DIR" -maxdepth 1 -name '*.sql' | wc -l)"
  N_OLD="$(find "$WORK/src-db/db/migrations" -maxdepth 1 -name '*.sql' | wc -l)"
  log "вход: платформа $PLATFORM_REF ($N_PLATFORM файлов), app $N_APP, прежний репозиторий $N_OLD"
}

# --- Контейнер -----------------------------------------------------------------------------
pick_port() {
  local p
  for ((p = PORT_FIRST; p <= PORT_LAST; p++)); do
    if ! ss -ltn 2>/dev/null | grep -q ":$p "; then
      PORT="$p"
      return 0
    fi
  done
  die "нет свободного порта $PORT_FIRST-$PORT_LAST"
}

start_postgres() {
  pick_port
  docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" --label "$STAGE_LABEL" --memory 768m \
    -p "127.0.0.1:$PORT:5432" \
    --tmpfs /var/lib/postgresql/data:rw,size=512m \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    "$PG_IMAGE" -c fsync=off -c synchronous_commit=off -c max_connections=20 \
    -c shared_buffers=64MB >/dev/null
  CONTAINER_UP=1
  local i
  for ((i = 1; i <= PG_READY_TRIES; i++)); do
    if psql --no-psqlrc -qAt "postgres://postgres@127.0.0.1:$PORT/postgres" -c 'select 1' \
      >/dev/null 2>&1; then
      log "Postgres готов на 127.0.0.1:$PORT ($PG_IMAGE)"
      return 0
    fi
    sleep 1
  done
  docker logs --tail 20 "$CONTAINER" >&2 || true
  die "Postgres не поднялся"
}

db_url() { echo "postgres://postgres@127.0.0.1:$PORT/$1"; }

make_db() {
  docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -qc "CREATE DATABASE $1"
}

# dump_db <база> <файл>: нормализованный pg_dump --schema-only.
dump_db() {
  docker exec "$CONTAINER" pg_dump --schema-only --no-owner --no-privileges -U postgres "$1" \
    >"$2.raw"
  python3 -I "$SCHEMA_PY" normalize "$2.raw" "$2"
}

show_stats() { # show_stats <метка> <файл>
  log "схема $1: $(python3 -I "$SCHEMA_PY" stats "$2" | tr '\n' ' ')"
}

# run_runner <раннер> <база> <файл вывода> [аргументы]: код выхода раннера в RUNNER_RC.
RUNNER_RC=0
run_runner() {
  local runner="$1" db="$2" out="$3"
  shift 3
  RUNNER_RC=0
  DATABASE_URL="$(db_url "$db")" APP_MIGRATIONS_DIR="$APP_DIR" \
    timeout "$RUNNER_TIMEOUT_SEC" bash "$runner" "$@" >"$out" 2>&1 || RUNNER_RC=$?
}

applied_count() { sed -n 's/^Готово\. Применено новых миграций: \([0-9][0-9]*\)$/\1/p' "$1" | tail -n 1; }

# apply_twice <раннер> <база> <префикс файлов> <ожидаемо в первый прогон>
apply_twice() {
  local runner="$1" db="$2" prefix="$3" expected="$4" n1 n2
  run_runner "$runner" "$db" "$prefix.apply1.out"
  n1="$(applied_count "$prefix.apply1.out")"
  [[ "$RUNNER_RC" -eq 0 ]] || { tail -n 15 "$prefix.apply1.out"; verdict FAIL "$db: раннер завершился с кодом $RUNNER_RC"; return 1; }
  run_runner "$runner" "$db" "$prefix.apply2.out"
  n2="$(applied_count "$prefix.apply2.out")"
  log "$db: первый прогон применил ${n1:-?} (ожидалось $expected), второй ${n2:-?} (ожидалось 0)"
  if [[ "${n1:-x}" != "$expected" || "${n2:-x}" != "0" || "$RUNNER_RC" -ne 0 ]]; then
    verdict FAIL "$db: число применённых миграций не совпало"
    return 1
  fi
  return 0
}

# Версии потока: platform/<имя> и app/<имя> из каталогов.
all_new_versions() {
  find "$WORK/platform-db/db/platform" -maxdepth 1 -name '*.sql' -printf 'platform/%f\n'
  find "$APP_DIR" -maxdepth 1 -name '*.sql' -printf 'app/%f\n'
}

# pending_from_plan <файл plan>: версии со статусом pending, по одной в строке.
pending_from_plan() { awk '$1 == "pending" {print $2}' "$1" | sort; }

# expected_pending <файл со списком записанных версий>: версии, не закрытые ни собой, ни
# прежней версией по картам (платформенная и проектная).
expected_pending() {
  local recorded="$1" map
  declare -A rec=() covered=()
  local v old new
  while IFS= read -r v; do [[ -n "$v" ]] && rec["$v"]=1; done <"$recorded"
  for map in "$WORK/platform-db/db/platform/legacy-map.tsv" "$APP_DIR/legacy-map.tsv"; do
    while IFS=$'\t' read -r old new; do
      [[ -z "$old" || "$old" == \#* ]] && continue
      [[ -n "${rec[$old]:-}" ]] && covered["$new"]=1
    done <"$map"
  done
  while IFS= read -r v; do
    v="${v%.sql}"
    [[ -n "${rec[$v]:-}" || -n "${covered[$v]:-}" ]] || echo "$v"
  done < <(all_new_versions) | sort
}

plan_summary() { grep '^План:' "$1" || true; }

# --- Сценарий 1 ----------------------------------------------------------------------------
scenario_1() {
  log "=== Сценарий 1: пустая база, раннер платформы (platform + app) ==="
  make_db s1_fresh
  apply_twice "$PLATFORM_RUNNER" s1_fresh "$WORK/s1" "$((N_PLATFORM + N_APP))" || return 0
  dump_db s1_fresh "$WORK/schema-fresh.sql"
  show_stats "fresh" "$WORK/schema-fresh.sql"
  show_stats "эталон" "$BASELINE_SCHEMA"
  if python3 -I "$SCHEMA_PY" compare "$BASELINE_SCHEMA" "$WORK/schema-fresh.sql" \
    --allowed "$ALLOWED_FILE" --diff-out "$WORK/diff-baseline-vs-fresh.txt" \
    >"$WORK/s1.compare.txt"; then
    verdict OK "(1) схема пустой базы = эталон с точностью до db/allowed-schema-diff.txt ($(wc -l <"$WORK/s1.compare.txt") строк сравнения)"
  else
    cat "$WORK/s1.compare.txt"
    verdict FAIL "(1) набор расхождений с эталоном не совпал с db/allowed-schema-diff.txt (см. $WORK/diff-baseline-vs-fresh.txt)"
  fi
}

# --- Сценарий 2 ----------------------------------------------------------------------------
scenario_2() {
  log "=== Сценарий 2: прежний раннер на $SRC_COMMIT + новый раннер с картой ==="
  [[ -f "$WORK/schema-fresh.sql" ]] || { verdict FAIL "(2) нет схемы сценария 1"; return 0; }
  make_db s2_legacy
  run_runner "$OLD_RUNNER" s2_legacy "$WORK/s2.old.out"
  if [[ "$RUNNER_RC" -ne 0 || "$(applied_count "$WORK/s2.old.out")" != "$N_OLD" ]]; then
    tail -n 15 "$WORK/s2.old.out"
    verdict FAIL "(2) прежний раннер не применил $N_OLD миграций"
    return 0
  fi
  dump_db s2_legacy "$WORK/schema-legacy-before.sql"
  show_stats "legacy до" "$WORK/schema-legacy-before.sql"
  if python3 -I "$SCHEMA_PY" compare "$BASELINE_SCHEMA" "$WORK/schema-legacy-before.sql" \
    >"$WORK/s2.base.txt"; then
    verdict OK "(2a) схема прежнего раннера на $N_OLD миграциях = эталон (стенд сопоставим с эталоном)"
  else
    cat "$WORK/s2.base.txt"
    verdict FAIL "(2a) схема прежнего раннера расходится с эталоном"
  fi
  docker exec "$CONTAINER" psql -U postgres -d s2_legacy -qAt \
    -c "SELECT version FROM schema_migrations ORDER BY version" >"$WORK/s2.recorded.txt"
  run_runner "$PLATFORM_RUNNER" s2_legacy "$WORK/s2.plan.txt" --plan
  log "--plan: $(plan_summary "$WORK/s2.plan.txt")"
  grep -E '^(pending|no-file)' "$WORK/s2.plan.txt" || true
  pending_from_plan "$WORK/s2.plan.txt" >"$WORK/s2.pending.actual.txt"
  grep -v '^#' "$NEW_APP_FILE" | grep -v '^$' | sort >"$WORK/s2.pending.expected.txt"
  if [[ "$RUNNER_RC" -eq 0 ]] && diff "$WORK/s2.pending.expected.txt" "$WORK/s2.pending.actual.txt" >/dev/null \
    && ! grep -q '^no-file' "$WORK/s2.plan.txt"; then
    verdict OK "(2b) --plan: pending только новые миграции проекта ($(tr '\n' ' ' <"$WORK/s2.pending.actual.txt"))"
  else
    diff "$WORK/s2.pending.expected.txt" "$WORK/s2.pending.actual.txt" || true
    verdict FAIL "(2b) --plan: pending не совпал с ожидаемым"
  fi
  local n_expected
  n_expected="$(wc -l <"$WORK/s2.pending.actual.txt")"
  apply_twice "$PLATFORM_RUNNER" s2_legacy "$WORK/s2" "$n_expected" || return 0
  dump_db s2_legacy "$WORK/schema-legacy-after.sql"
  show_stats "legacy после" "$WORK/schema-legacy-after.sql"
  if python3 -I "$SCHEMA_PY" compare "$WORK/schema-fresh.sql" "$WORK/schema-legacy-after.sql" \
    --diff-out "$WORK/diff-fresh-vs-legacy.txt" >"$WORK/s2.after.txt"; then
    verdict OK "(2c) после применения схема = схема сценария 1"
  else
    cat "$WORK/s2.after.txt"
    verdict FAIL "(2c) схема после применения расходится со сценарием 1 (см. $WORK/diff-fresh-vs-legacy.txt)"
  fi
}

# --- Сценарий 3 ----------------------------------------------------------------------------
scenario_3() {
  log "=== Сценарий 3: схема с боя (40 миграций) + новый раннер ==="
  [[ -f "$WORK/schema-fresh.sql" ]] || { verdict FAIL "(3) нет схемы сценария 1"; return 0; }
  [[ -f "$PROD_DIR/schema.sql" && -f "$PROD_DIR/schema_migrations.txt" ]] \
    || { verdict FAIL "(3) нет $PROD_DIR/schema.sql или schema_migrations.txt"; return 0; }
  make_db s3_prod
  # Токены \restrict psql 16.15 понимает, но из дампа их убираем: они случайны.
  grep -vE '^\\(un)?restrict ' "$PROD_DIR/schema.sql" >"$WORK/s3.prod-schema.sql"
  psql --no-psqlrc -q -v ON_ERROR_STOP=1 "$(db_url s3_prod)" -f "$WORK/s3.prod-schema.sql" \
    >"$WORK/s3.load.out" 2>&1 || { tail -n 15 "$WORK/s3.load.out"; verdict FAIL "(3) schema.sql не загрузилась"; return 0; }
  psql --no-psqlrc -q -v ON_ERROR_STOP=1 "$(db_url s3_prod)" \
    -c "\\copy schema_migrations (version, applied_at) FROM '$PROD_DIR/schema_migrations.txt' WITH (DELIMITER '|')" \
    >>"$WORK/s3.load.out" 2>&1 || { tail -n 15 "$WORK/s3.load.out"; verdict FAIL "(3) schema_migrations не загрузилась"; return 0; }
  cut -d'|' -f1 "$PROD_DIR/schema_migrations.txt" >"$WORK/s3.recorded.txt"
  log "бой: записей в schema_migrations $(wc -l <"$WORK/s3.recorded.txt")"
  dump_db s3_prod "$WORK/schema-prod-before.sql"
  show_stats "бой до" "$WORK/schema-prod-before.sql"
  run_runner "$PLATFORM_RUNNER" s3_prod "$WORK/s3.plan.txt" --plan
  log "--plan: $(plan_summary "$WORK/s3.plan.txt")"
  grep -E '^(pending|no-file)' "$WORK/s3.plan.txt" || true
  pending_from_plan "$WORK/s3.plan.txt" >"$WORK/s3.pending.actual.txt"
  expected_pending "$WORK/s3.recorded.txt" >"$WORK/s3.pending.expected.txt"
  if [[ "$RUNNER_RC" -eq 0 ]] && diff "$WORK/s3.pending.expected.txt" "$WORK/s3.pending.actual.txt" >/dev/null \
    && ! grep -q '^no-file' "$WORK/s3.plan.txt" \
    && grep -qx 'app/024_own_legal_entities' "$WORK/s3.pending.actual.txt" \
    && grep -qx 'app/025_suppliers_no_draft' "$WORK/s3.pending.actual.txt"; then
    verdict OK "(3a) --plan: pending = $(tr '\n' ' ' <"$WORK/s3.pending.actual.txt")"
  else
    diff "$WORK/s3.pending.expected.txt" "$WORK/s3.pending.actual.txt" || true
    verdict FAIL "(3a) --plan: pending не совпал с ожидаемым (старые 041/042 на бою отсутствуют)"
  fi
  local n_expected
  n_expected="$(wc -l <"$WORK/s3.pending.actual.txt")"
  apply_twice "$PLATFORM_RUNNER" s3_prod "$WORK/s3" "$n_expected" || return 0
  dump_db s3_prod "$WORK/schema-prod-after.sql"
  show_stats "бой после" "$WORK/schema-prod-after.sql"
  if python3 -I "$SCHEMA_PY" compare "$WORK/schema-fresh.sql" "$WORK/schema-prod-after.sql" \
    --diff-out "$WORK/diff-fresh-vs-prod.txt" >"$WORK/s3.after.txt"; then
    verdict OK "(3b) после применения схема = схема сценария 1"
  else
    cat "$WORK/s3.after.txt"
    verdict FAIL "(3b) схема после применения расходится со сценарием 1 (см. $WORK/diff-fresh-vs-prod.txt)"
  fi
}

# --- Основной ход --------------------------------------------------------------------------
main() {
  local -a wanted=("$@")
  [[ "${#wanted[@]}" -gt 0 ]] || wanted=(1 2 3)
  log "check-migrations: сценарии ${wanted[*]}; протокол $LOG"
  resources_ok || die "ресурсы просели, пока ждали блокировку"
  prepare_inputs
  start_postgres
  local s
  # Сценарии 2 и 3 сравнивают с результатом сценария 1, поэтому он идёт первым всегда.
  scenario_1
  for s in "${wanted[@]}"; do
    case "$s" in
      1) ;;
      2) scenario_2 ;;
      3) scenario_3 ;;
      *) die "неизвестный сценарий: $s (допустимо 1, 2, 3)" ;;
    esac
  done
  echo
  echo "=== Итог ==="
  printf '%s\n' "${SUMMARY[@]}"
  [[ "$FAILS" -eq 0 ]] || { echo "РАСХОЖДЕНИЙ: $FAILS"; exit 1; }
  echo "ВСЁ СОШЛОСЬ"
}

main "$@"
