#!/usr/bin/env bash
# Доказательство обратных миграций db/app/rollback/021_down.sql и 026_down.sql вместе
# (этап 8u, пакет переключения G7 v3: откат боя на старые контейнеры, платформа 1.1.2).
#
#   bash tools/prove-rollback.sh                  фазы db, targeted, probe, full
#   bash tools/prove-rollback.sh db               только проверка схемы и учёта
#   bash tools/prove-rollback.sh targeted         целевые тесты очереди jobs старого кода
#   bash tools/prove-rollback.sh probe            проба старого кода на серии часов дня (jobs)
#   bash tools/prove-rollback.sh full             полный core-tests-pg старого кода (green)
#   bash tools/prove-rollback.sh e2e              полный e2e старого кода на green (~17 минут)
#   bash tools/prove-rollback.sh e2e-recheck      повтор упавших файлов e2e (E2E_RECHECK_FILES)
# Фазы targeted/probe/full/e2e берут схемы и данные из дампов фазы db (db идёт сама, если их нет).
#
# Что доказывает.
#   db: «синтетический бой» - 42 миграции прежнего репозитория (FREEZE_SRC) прежним раннером,
#       вымышленные данные (seed-db.sql этапа 7), pg_dump/pg_restore в новую базу. Затем раннер
#       v2 платформы 1.1.2 (--plan: ровно app/026 и platform/021 pending, остальное applied-by-
#       legacy), накатка v2, 021_down.sql и 026_down.sql (в таком порядке): схема, данные и
#       schema_migrations равны состоянию ДО v2; повтор - без изменений; обратный порядок даёт
#       то же; после одной 021_down раннер видит 021 pending и применяет её заново; цикл вперёд-
#       назад-вперёд даёт ту же схему. Прежний раннер на базе после v2 ничего не применяет.
#       Серии часов дня (jobs.daily_at), посеянные на базу после v2, 021_down снимает, прочие
#       задачи очереди не трогает.
#   targeted/probe/full/e2e: прежний код на трёх схемах: control (до v2), red-021 (после v2 и
#       ТОЛЬКО 026_down: столбцы 021 на месте), green (после v2 и обеих обратных миграций).
#       Тесты прежнего кода сами строят схему из db/migrations, поэтому в копии
#       tests/adapters/postgres/support.ts (оригинал не трогаем) схема теста берётся клоном
#       шаблонной базы (CREATE DATABASE ... TEMPLATE) из дампа проверяемого состояния; тесты с
#       частичной схемой (stopBefore) идут по-прежнему. probe: адаптер очереди прежнего кода
#       (PostgresScheduler) на базах с данными: на red-021 серия часов дня выполняется один раз
#       как разовая и закрывается, на green серии нет, остальное как на control.
#
# Postgres: pgvector/pgvector:0.8.6-pg16 на 127.0.0.1:21700 (контейнер bai8u-rb-pg, метка
# bai.stage=8u, данные в tmpfs). Порты e2e - те же 21700-21709 (стенд перед e2e гасится).
# Работает под flock heavy.lock. Итоги: $WORK/RESULT.md.
# Код выхода: 0 - всё сошлось, 1 - расхождение, 2 - ошибка окружения, 3 - нет ресурсов.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BAI_HOME="${BAI_HOME:-$HOME/reports/business-ai-modular}"
WORK="${WORK:-$BAI_HOME/stage-8u/tmp/subA/down-proof}"
LOCK_FILE="$BAI_HOME/heavy.lock"

# --- Константы -----------------------------------------------------------------------------
PG_IMAGE="pgvector/pgvector:0.8.6-pg16"
CONTAINER="bai8u-rb-pg"
STAGE_LABEL="bai.stage=8u"
PORT=21700
PG_MEMORY="1g"
PG_TMPFS_SIZE="768m"
PG_READY_TRIES=60
RUNNER_TIMEOUT_SEC=300
TARGETED_TIMEOUT_SEC=540
FULL_TIMEOUT_SEC=2400
E2E_TIMEOUT_SEC=1200
MIN_DISK_GIB=8
MIN_RAM_MIB=3072
MIB_PER_GIB=1024
RESOURCE_RETRIES=3
RESOURCE_WAIT_SEC="${RESOURCE_WAIT_SEC:-600}"
# Ожидаемые числа плана раннера v2 на базе прежнего раннера: порядок задаёт stream-order.tsv
# (app/026 раньше platform/021). Число applied-by-legacy сверяется и с числом файлов потоков.
EXPECTED_LEGACY_APPLIED=45
EXPECTED_PENDING="app/026_knowledge_scope_compat platform/021_jobs_daily_schedule"
EXPECTED_PENDING_COUNT=2
PLATFORM_021="platform/021_jobs_daily_schedule"
EXPECTED_OLD_MIGRATIONS=42

SRC_REPO="${SRC_REPO:-$HOME/pragmatika-purchasing}"
SRC_COMMIT="${SRC_COMMIT:-5ea7f2d308beb476fb8b6fe05e095587c9ee4f40}"
OLD_WORKTREE="${OLD_WORKTREE:-$HOME/wt-pragmatika-baseline-2}"
SEED_SQL="${SEED_SQL:-$BAI_HOME/stage-7/synth/seed/seed-db.sql}"
BASELINE_TSV="${BASELINE_TSV:-$BAI_HOME/stage-7/baseline-src/tests.tsv}"
APP_DIR="$ROOT/db/app"
DOWN_026="$APP_DIR/rollback/026_down.sql"
DOWN_021="$APP_DIR/rollback/021_down.sql"
V2_RUNNER="$ROOT/deploy/platform/db/migrate.sh"
PLATFORM_DB_DIR="$ROOT/deploy/platform/db/platform"
SCHEMA_PY="$ROOT/tools/check_migrations_schema.py"
LEGACY_MAP="$APP_DIR/legacy-map.tsv"

# Три схемы для прежнего кода: имя -> снимок схемы (сырой дамп) и шаблонная база.
SCHEMAS=(control red green)

declare -a SUMMARY=()
FAILS=0
CONTAINER_UP=0

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
die() { echo "ОШИБКА: $*" >&2; exit 2; }
# Вердикты и строки таблицы хранятся по фазам (файлы в $WORK): RESULT.md собирает все фазы, а
# повторный запуск одной фазы обновляет только её строки.
CUR_PHASE=""
VERDICT_FILE=""
verdict() { # verdict <OK|FAIL> <текст>
  SUMMARY+=("$1  $2")
  [[ -z "$VERDICT_FILE" ]] || echo "$1  $2" >>"$VERDICT_FILE"
  [[ "$1" == "OK" ]] || FAILS=$((FAILS + 1))
  log "$1: $2"
}

# note <текст>: наблюдение без оценки OK/FAIL (в RESULT.md строкой INFO, расхождением не считается).
note() {
  SUMMARY+=("INFO $1")
  [[ -z "$VERDICT_FILE" ]] || echo "INFO $1" >>"$VERDICT_FILE"
  log "INFO: $1"
}

cleanup() {
  local rc=$?
  stop_postgres
  exit "$rc"
}
trap cleanup EXIT

# Контейнер гасится по точному имени вместе с анонимными томами.
stop_postgres() {
  if [[ "$CONTAINER_UP" -eq 1 ]]; then
    docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
    CONTAINER_UP=0
    log "контейнер $CONTAINER погашен и удалён"
  fi
}

# --- Ресурсы и блокировка ------------------------------------------------------------------
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

wait_foreign_e2e() {
  local attempt
  for ((attempt = 1; attempt <= RESOURCE_RETRIES * 10; attempt++)); do
    # Свой e2e этого скрипта идёт под нашим же flock и сюда не доходит.
    pgrep -af 'e2e/run.sh' >/dev/null 2>&1 || return 0
    log "идёт чужой e2e, жду 60 с"
    sleep 60
  done
  die "чужой e2e не закончился"
}

mkdir -p "$WORK"
if [[ -z "${PROVE_ROLLBACK_LOCKED:-}" ]]; then
  wait_foreign_e2e
  wait_resources
  export PROVE_ROLLBACK_LOCKED=1
  exec flock "$LOCK_FILE" bash "${BASH_SOURCE[0]}" "$@"
fi

exec > >(tee -a "$WORK/prove.log") 2>&1

RESULTS_TSV="$WORK/results.tsv"
touch "$RESULTS_TSV"
PHASES=("$@")
[[ "${#PHASES[@]}" -gt 0 ]] || PHASES=(db targeted probe full)
# begin_phase <имя>: вердикты и строки таблицы этой фазы начинаются заново.
begin_phase() {
  CUR_PHASE="$1"
  VERDICT_FILE="$WORK/verdicts-$1.txt"
  : >"$VERDICT_FILE"
  if [[ -f "$RESULTS_TSV" ]]; then
    awk -F'\t' -v phase="$1" '$1 != phase' "$RESULTS_TSV" >"$RESULTS_TSV.new"
    mv "$RESULTS_TSV.new" "$RESULTS_TSV"
  fi
}
want() { local p; for p in "${PHASES[@]}"; do [[ "$p" == "$1" ]] && return 0; done; return 1; }

# --- Вспомогательное -----------------------------------------------------------------------
db_url() { echo "postgres://postgres@127.0.0.1:$PORT/$1"; }
psql_db() { local db="$1"; shift; psql --no-psqlrc -q -X "$(db_url "$db")" "$@"; }
sql_val() { psql_db "$1" -v ON_ERROR_STOP=1 -At -c "$2"; }
make_db() { docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -qc "CREATE DATABASE $1"; }
drop_db() {
  docker exec "$CONTAINER" psql -U postgres -qc "DROP DATABASE IF EXISTS $1 WITH (FORCE)" \
    >/dev/null
}

RUNNER_RC=0
# run_runner <раннер> <база> <файл вывода> [аргументы]: код выхода в RUNNER_RC.
run_runner() {
  local runner="$1" db="$2" out="$3"
  shift 3
  RUNNER_RC=0
  DATABASE_URL="$(db_url "$db")" APP_MIGRATIONS_DIR="$APP_DIR" APP_LEGACY_MAP="$LEGACY_MAP" \
    timeout "$RUNNER_TIMEOUT_SEC" bash "$runner" "$@" >"$out" 2>&1 || RUNNER_RC=$?
}

APPLIED_RE='s/^Готово\. Применено новых миграций: \([0-9][0-9]*\)$/\1/p'
applied_count() { sed -n "$APPLIED_RE" "$1" | tail -n 1; }

start_postgres() {
  command -v docker >/dev/null || die "нет docker"
  command -v psql >/dev/null || die "нет psql"
  if ss -ltn 2>/dev/null | grep -q "127.0.0.1:$PORT "; then die "порт $PORT занят"; fi
  docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" --label "$STAGE_LABEL" --memory "$PG_MEMORY" \
    -p "127.0.0.1:$PORT:5432" \
    --tmpfs "/var/lib/postgresql/data:rw,size=$PG_TMPFS_SIZE" \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    "$PG_IMAGE" -c fsync=off -c synchronous_commit=off -c max_connections=100 \
    -c shared_buffers=128MB >/dev/null
  CONTAINER_UP=1
  local i
  for ((i = 1; i <= PG_READY_TRIES; i++)); do
    if psql --no-psqlrc -qAt "$(db_url postgres)" -c 'select 1' >/dev/null 2>&1; then
      log "Postgres готов на 127.0.0.1:$PORT ($PG_IMAGE)"
      return 0
    fi
    sleep 1
  done
  docker logs --tail 20 "$CONTAINER" >&2 || true
  die "Postgres не поднялся"
}

# --- Снимки состояния ----------------------------------------------------------------------
SNAP="$WORK/snap"

# dump_schema <база> <файл>: нормализованный дамп схемы; рядом <файл>.raw - сырой.
dump_schema() {
  docker exec "$CONTAINER" pg_dump --schema-only --no-owner --no-privileges -U postgres "$1" \
    >"$2.raw"
  python3 -I "$SCHEMA_PY" normalize "$2.raw" "$2"
}

# Отпечаток строки таблицы: у jobs без столбцов 021 (иначе после v2 текст строки шире, чем до
# v2, хотя данные те же); у остальных - весь текст строки.
row_expr() { # row_expr <таблица>
  if [[ "$1" == "jobs" ]]; then
    echo "(to_jsonb(x) - 'daily_at' - 'time_zone')::text"
  else
    echo "x::text"
  fi
}

# snapshot <база> <метка>: схема, версии учёта, строки учёта, отпечаток данных каждой таблицы.
snapshot() {
  local db="$1" tag="$2" table expr
  dump_schema "$db" "$SNAP/$tag.schema.sql"
  sql_val "$db" "SELECT version FROM schema_migrations ORDER BY version COLLATE \"C\"" \
    >"$SNAP/$tag.versions.txt"
  sql_val "$db" "SELECT version || '|' || applied_at FROM schema_migrations
                 WHERE version NOT LIKE '%/%' ORDER BY version COLLATE \"C\"" \
    >"$SNAP/$tag.ledger-old.txt"
  : >"$SNAP/$tag.data.txt"
  while IFS= read -r table; do
    [[ "$table" == "schema_migrations" ]] && continue
    expr="$(row_expr "$table")"
    echo "$table|$(sql_val "$db" "SELECT count(*) || '|' || md5(coalesce(string_agg($expr, E'\n'
      ORDER BY $expr), '')) FROM public.\"$table\" x")" >>"$SNAP/$tag.data.txt"
  done < <(sql_val "$db" "SELECT tablename FROM pg_tables WHERE schemaname = 'public'
                          ORDER BY tablename COLLATE \"C\"")
  local col
  col="$(sql_val "$db" "SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'knowledge_chunks'
      AND column_name IN ('supplier_id', 'scope')")"
  # Данные базы знаний явно: столбец привязки под любым из двух имён, плюс fts и эмбеддинг.
  sql_val "$db" "SELECT count(*) || '|' || md5(string_agg(concat_ws('|', id, document_id,
      chunk_index, content, source, $col, embedding::text, fts::text, created_at), E'\n'
      ORDER BY id)) FROM knowledge_chunks" >"$SNAP/$tag.knowledge.txt"
  # Столбцы jobs по порядку: 021 добавляет два в конец, откат должен вернуть прежний список.
  sql_val "$db" "SELECT column_name || ':' || data_type || ':' || is_nullable
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs'
    ORDER BY ordinal_position" >"$SNAP/$tag.jobs-columns.txt"
  log "снимок $tag: столбец привязки=$col, knowledge_chunks=$(cat "$SNAP/$tag.knowledge.txt")," \
    "столбцов jobs=$(wc -l <"$SNAP/$tag.jobs-columns.txt")"
}

# same_snapshot <метка A> <метка B> <что: schema|versions|ledger-old|data|knowledge|jobs-columns>
same_snapshot() {
  local a="$1" b="$2" what="$3" ext
  case "$what" in
    schema) ext="schema.sql" ;;
    *) ext="$what.txt" ;;
  esac
  if [[ "$what" == "schema" ]]; then
    python3 -I "$SCHEMA_PY" compare "$SNAP/$a.schema.sql" "$SNAP/$b.schema.sql" \
      --diff-out "$SNAP/diff-$a-vs-$b.txt" >"$SNAP/compare-$a-vs-$b.txt" \
      && cmp -s "$SNAP/$a.schema.sql" "$SNAP/$b.schema.sql"
  else
    cmp -s "$SNAP/$a.$ext" "$SNAP/$b.$ext"
  fi
}

snapshot_path() { # snapshot_path <метка> <что>
  if [[ "$2" == "schema" ]]; then echo "$SNAP/$1.schema.sql"; else echo "$SNAP/$1.$2.txt"; fi
}

check_same() { # check_same <A> <B> <что> <описание>
  if same_snapshot "$1" "$2" "$3"; then
    verdict OK "$4"
  else
    verdict FAIL "$4 (см. $SNAP: $1 против $2, $3)"
    diff "$(snapshot_path "$1" "$3")" "$(snapshot_path "$2" "$3")" | head -n 20 || true
  fi
}

PLAN_RE='s/^План: applied \([0-9]*\), applied-by-legacy \([0-9]*\), pending \([0-9]*\)$/\1 \2 \3/p'
plan_counts() { # plan_counts <файл плана> -> "applied legacy pending"
  sed -n "$PLAN_RE" "$1"
}

# check_plan <база> <метка> <ожидаемые pending через пробел> [ожидаемое applied-by-legacy]:
# список pending точный и в порядке плана; число applied-by-legacy - если задано.
check_plan() {
  local db="$1" tag="$2" want_pending="$3" want_legacy="${4:-}" out counts pending n_pending
  out="$SNAP/plan-${tag// /_}.txt"
  run_runner "$V2_RUNNER" "$db" "$out" --plan
  counts="$(plan_counts "$out")"
  pending="$(awk '$1 == "pending" {print $2}' "$out" | tr '\n' ' ' | sed 's/ $//')"
  n_pending="$(wc -w <<<"$want_pending")"
  if [[ "$RUNNER_RC" -eq 0 && "$pending" == "$want_pending" ]] && ! grep -q '^no-file' "$out" \
    && [[ "${counts##* }" == "$n_pending" ]] \
    && { [[ -z "$want_legacy" ]] || [[ "$(awk '{print $2}' <<<"$counts")" == "$want_legacy" ]]; }
  then
    verdict OK "--plan ($tag): '$counts' (applied legacy pending), pending ровно: $pending"
  else
    cat "$out"
    verdict FAIL "--plan ($tag): ожидалось pending '$want_pending' (legacy ${want_legacy:-любое}), \
получено '$counts' и '$pending'"
  fi
}

# --- Фаза db -------------------------------------------------------------------------------
prepare_old_sources() {
  git -C "$SRC_REPO" cat-file -e "$SRC_COMMIT^{commit}" || die "нет $SRC_COMMIT в $SRC_REPO"
  [[ -f "$SEED_SQL" ]] || die "нет синтетического сида: $SEED_SQL"
  [[ -f "$DOWN_026" ]] || die "нет $DOWN_026"
  [[ -f "$DOWN_021" ]] || die "нет $DOWN_021"
  rm -rf "${WORK:?}/old-src"
  mkdir -p "$WORK/old-src" "$SNAP"
  git -C "$SRC_REPO" archive "$SRC_COMMIT" db | tar -x -C "$WORK/old-src"
  OLD_RUNNER="$WORK/old-src/db/migrate.sh"
  local n_old
  n_old="$(find "$WORK/old-src/db/migrations" -name '*.sql' | wc -l)"
  log "старый раннер и миграции из $SRC_COMMIT: $n_old файлов"
}

# run_down <база> <файл down> <файл вывода> [stdin]: psql --single-transaction как в rollback.sh.
run_down() {
  local db="$1" file="$2" out="$3" via="${4:-file}"
  RUNNER_RC=0
  if [[ "$via" == "stdin" ]]; then
    # Через stdin, как в rollback.sh пакета переключения (psql -f -).
    psql_db "$db" --single-transaction -v ON_ERROR_STOP=1 -f - <"$file" >"$out" 2>&1 \
      || RUNNER_RC=$?
  else
    psql_db "$db" --single-transaction -v ON_ERROR_STOP=1 -f "$file" >"$out" 2>&1 \
      || RUNNER_RC=$?
  fi
}

# down_both <база> <метка> [stdin]: 021_down, затем 026_down; false, если любая упала.
down_both() {
  local db="$1" tag="$2" via="${3:-file}"
  run_down "$db" "$DOWN_021" "$SNAP/$tag.down021.out" "$via"
  if [[ "$RUNNER_RC" -ne 0 ]]; then
    cat "$SNAP/$tag.down021.out"
    verdict FAIL "021_down.sql ($tag) завершился с кодом $RUNNER_RC"
    return 1
  fi
  run_down "$db" "$DOWN_026" "$SNAP/$tag.down026.out" "$via"
  if [[ "$RUNNER_RC" -ne 0 ]]; then
    cat "$SNAP/$tag.down026.out"
    verdict FAIL "026_down.sql ($tag) завершился с кодом $RUNNER_RC"
    return 1
  fi
}

copy_db() { # copy_db <шаблон> <новая>: копия базы (соединений с шаблоном быть не должно)
  drop_db "$2"
  docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -qc \
    "CREATE DATABASE $2 TEMPLATE $1"
}

# Вымышленные задачи очереди для проб: обычные (разовая, по интервалу) и серии часов дня.
seed_ordinary_jobs() {
  psql_db "$1" -v ON_ERROR_STOP=1 -c "
    INSERT INTO jobs (id, name, payload, due_at, repeat_every_ms, idempotency_key, status, attempts)
    VALUES
      ('rb021-interval', 'rb021.interval', '{}', '2026-11-01T09:00:00Z', 3600000,
       'rb021-key-interval', 'pending', 0),
      ('rb021-once', 'rb021.once', '{}', '2026-11-01T09:30:00Z', NULL,
       'rb021-key-once', 'pending', 0)"
}
SERIES_COUNT=3
seed_series_jobs() {
  psql_db "$1" -v ON_ERROR_STOP=1 -c "
    INSERT INTO jobs (id, name, payload, due_at, repeat_every_ms, idempotency_key, status,
                      attempts, locked_at, locked_by, daily_at, time_zone)
    VALUES
      ('rb021-daily-1', 'rb021.daily', '{}', '2026-11-01T06:00:00Z', NULL,
       'rb021-key-daily-1', 'pending', 0, NULL, NULL, '09:00,18:00', 'Europe/Moscow'),
      ('rb021-daily-2', 'rb021.daily', '{}', '2026-11-01T06:10:00Z', NULL,
       'rb021-key-daily-2', 'pending', 0, NULL, NULL, '10:00', 'Asia/Yekaterinburg'),
      ('rb021-daily-3', 'rb021.daily', '{}', '2026-11-01T06:20:00Z', NULL,
       'rb021-key-daily-3', 'running', 1, '2026-11-01T06:20:00Z', 'rb021', '12:00', 'UTC')"
}
# jobs_fp <база> <условие>: число и md5 строк jobs (без столбцов 021).
jobs_fp() {
  sql_val "$1" "SELECT count(*) || '|' || md5(coalesce(string_agg(
      (to_jsonb(x) - 'daily_at' - 'time_zone')::text, E'\n'
      ORDER BY (to_jsonb(x) - 'daily_at' - 'time_zone')::text), '')) FROM jobs x WHERE $2"
}

phase_db() {
  begin_phase db
  log "=== Фаза db: схема, данные и учёт ==="
  prepare_old_sources
  start_postgres

  # 1. Синтетический бой: прежний раннер + сид, затем «восстановление боя» через dump/restore.
  make_db rb_legacy
  run_runner "$OLD_RUNNER" rb_legacy "$WORK/legacy.apply.out"
  if [[ "$RUNNER_RC" -ne 0 \
    || "$(applied_count "$WORK/legacy.apply.out")" != "$EXPECTED_OLD_MIGRATIONS" ]]; then
    tail -n 15 "$WORK/legacy.apply.out"
    verdict FAIL "прежний раннер не применил $EXPECTED_OLD_MIGRATIONS миграций"
    return 0
  fi
  psql_db rb_legacy -v ON_ERROR_STOP=1 -f "$SEED_SQL" >"$WORK/seed.out" 2>&1 \
    || { tail -n 15 "$WORK/seed.out"; verdict FAIL "сид не загрузился"; return 0; }
  snapshot rb_legacy legacy
  docker exec "$CONTAINER" pg_dump -Fc --no-owner -U postgres rb_legacy >"$WORK/battle.dump"
  make_db rb_battle
  docker exec -i "$CONTAINER" pg_restore --no-owner -U postgres -d rb_battle \
    <"$WORK/battle.dump" >"$WORK/restore.out" 2>&1 \
    || { tail -n 15 "$WORK/restore.out"; verdict FAIL "pg_restore не удался"; return 0; }
  snapshot rb_battle before
  cp "$SNAP/before.schema.sql.raw" "$WORK/schema-control.sql"
  check_same legacy before schema "восстановленный бой: схема = схеме после прежнего раннера"
  check_same legacy before data "восстановленный бой: данные всех таблиц те же"
  check_same legacy before versions "восстановленный бой: schema_migrations те же"
  sql_val rb_battle "SELECT count(*) FROM schema_migrations" >"$SNAP/before.count.txt"
  if [[ "$(cat "$SNAP/before.count.txt")" == "$EXPECTED_OLD_MIGRATIONS" ]] \
    && ! grep -q '/' "$SNAP/before.versions.txt"; then
    verdict OK "до v2 в учёте ровно $EXPECTED_OLD_MIGRATIONS прежних записей без префиксов"
  else
    verdict FAIL "до v2 учёт не из $EXPECTED_OLD_MIGRATIONS прежних записей"
  fi
  copy_db rb_battle rb_before_keep

  # 2. Раннер v2 (платформа 1.1.2): --plan, накатка, повторная накатка.
  check_plan rb_battle "до v2" "$EXPECTED_PENDING" "$EXPECTED_LEGACY_APPLIED"
  local n_files
  n_files=$(($(find "$PLATFORM_DB_DIR" -maxdepth 1 -name '*.sql' | wc -l) \
    + $(find "$APP_DIR" -maxdepth 1 -name '*.sql' | wc -l)))
  if [[ "$((n_files - EXPECTED_PENDING_COUNT))" -eq "$EXPECTED_LEGACY_APPLIED" ]]; then
    verdict OK "applied-by-legacy $EXPECTED_LEGACY_APPLIED = версий потоков $n_files (platform + \
app) минус pending $EXPECTED_PENDING_COUNT"
  else
    verdict FAIL "applied-by-legacy $EXPECTED_LEGACY_APPLIED не сходится с числом версий потоков \
$n_files"
  fi
  apply_v2 rb_battle v2 "$EXPECTED_PENDING_COUNT"
  cp "$SNAP/v2.schema.sql.raw" "$WORK/schema-v2.sql"
  if grep -q 'knowledge_chunks_scope_idx' "$SNAP/v2.schema.sql" \
    && grep -q 'daily_at' "$SNAP/v2.schema.sql" \
    && ! same_snapshot before v2 schema; then
    verdict OK "после v2 схема изменилась (knowledge_chunks.scope, jobs.daily_at), стенд \
различает состояния"
  else
    verdict FAIL "после v2 схема не изменилась: проверка не имеет смысла"
  fi
  # Учёт: какие записи раннер v2 дописал (по факту), в т.ч. для 021 и 026.
  comm -13 "$SNAP/before.versions.txt" "$SNAP/v2.versions.txt" >"$SNAP/v2.added-versions.txt"
  if grep -qx "$PLATFORM_021" "$SNAP/v2.added-versions.txt" \
    && grep -qx 'app/026_knowledge_scope_compat' "$SNAP/v2.added-versions.txt" \
    && ! grep -qx '021_jobs_daily_schedule' "$SNAP/v2.versions.txt" \
    && [[ "$(grep -c / "$SNAP/v2.added-versions.txt")" \
          == "$(wc -l <"$SNAP/v2.added-versions.txt")" ]]; then
    verdict OK "учёт после v2: раннер дописал $(wc -l <"$SNAP/v2.added-versions.txt") записей \
только с префиксом потока, среди них $PLATFORM_021 и app/026_knowledge_scope_compat"
  else
    verdict FAIL "учёт после v2: записи 021/026 не те, что ждёт откат (см. v2.added-versions.txt)"
  fi
  # Прежний раннер на базе после v2 (записи platform/..., app/... рядом со старыми).
  copy_db rb_battle rb_v2_copy
  run_runner "$OLD_RUNNER" rb_v2_copy "$SNAP/old-runner-after-v2.out"
  if [[ "$RUNNER_RC" -eq 0 && "$(applied_count "$SNAP/old-runner-after-v2.out")" == "0" \
    && "$(grep -c '^Уже применена: ' "$SNAP/old-runner-after-v2.out")" \
       == "$EXPECTED_OLD_MIGRATIONS" ]]; then
    verdict OK "прежний раннер на базе после v2: rc=0, применено 0, 'Уже применена' \
x$EXPECTED_OLD_MIGRATIONS (префиксы не мешают)"
  else
    cat "$SNAP/old-runner-after-v2.out"
    verdict FAIL "прежний раннер на базе после v2 повёл себя иначе"
  fi
  drop_db rb_v2_copy
  copy_db rb_battle rb_v2_keep

  # 3. red-021: после v2 только 026_down (столбцы 021 на месте, учёт без записей с префиксом).
  copy_db rb_v2_keep rb_red
  run_down rb_red "$DOWN_026" "$SNAP/red.down026.out"
  if [[ "$RUNNER_RC" -ne 0 ]]; then
    cat "$SNAP/red.down026.out"
    verdict FAIL "026_down.sql на red-021 завершился с кодом $RUNNER_RC"
    return 0
  fi
  snapshot rb_red red
  cp "$SNAP/red.schema.sql.raw" "$WORK/schema-red.sql"
  if grep -q 'daily_at' "$SNAP/red.schema.sql" \
    && grep -q 'knowledge_chunks_supplier_idx' "$SNAP/red.schema.sql" \
    && ! grep -q 'knowledge_chunks_scope_idx' "$SNAP/red.schema.sql"; then
    verdict OK "red-021: после v2 и одной 026_down столбцы 021 на месте, supplier_id возвращён"
  else
    verdict FAIL "red-021 собран неверно (нужны jobs.daily_at и knowledge_chunks.supplier_id)"
  fi

  # 4. 021_down отдельно (026 ещё не откачена): jobs как до v2, запись 021 исчезла.
  run_down rb_battle "$DOWN_021" "$SNAP/mid.down021.out"
  if [[ "$RUNNER_RC" -ne 0 ]]; then
    cat "$SNAP/mid.down021.out"
    verdict FAIL "021_down.sql завершился с кодом $RUNNER_RC"
    return 0
  fi
  verdict OK "021_down.sql выполнен (psql --single-transaction -v ON_ERROR_STOP=1)"
  snapshot rb_battle mid
  check_same before mid jobs-columns "после одной 021_down столбцы jobs те же, что до v2"
  if ! grep -q 'daily_at\|time_zone\|jobs_daily_schedule_check' "$SNAP/mid.schema.sql" \
    && grep -q 'knowledge_chunks_scope_idx' "$SNAP/mid.schema.sql"; then
    verdict OK "после одной 021_down: столбцов и CHECK 021 нет, knowledge_chunks.scope на месте"
  else
    verdict FAIL "после одной 021_down схема не такая, как ожидалось"
  fi
  if [[ "$(comm -23 "$SNAP/v2.versions.txt" "$SNAP/mid.versions.txt")" == "$PLATFORM_021" \
    && -z "$(comm -13 "$SNAP/v2.versions.txt" "$SNAP/mid.versions.txt")" ]]; then
    verdict OK "после одной 021_down из учёта исчезла ровно запись $PLATFORM_021"
  else
    verdict FAIL "после одной 021_down учёт изменился не только на запись $PLATFORM_021"
  fi
  check_plan rb_battle "после одной 021_down (026 на месте)" "$PLATFORM_021"
  copy_db rb_battle rb_mid_copy
  apply_v2 rb_mid_copy mid2 1
  check_same v2 mid2 schema "021_down без 026_down не ломает раннер: повторная 021 даёт схему v2"
  check_same v2 mid2 versions "021_down без 026_down: после повторной 021 учёт как после v2"
  drop_db rb_mid_copy

  # 5. 026_down следом: схема, данные и учёт как до v2.
  run_down rb_battle "$DOWN_026" "$SNAP/down.down026.out"
  if [[ "$RUNNER_RC" -ne 0 ]]; then
    cat "$SNAP/down.down026.out"
    verdict FAIL "026_down.sql завершился с кодом $RUNNER_RC"
    return 0
  fi
  verdict OK "026_down.sql выполнен следом за 021_down.sql"
  snapshot rb_battle down
  cp "$SNAP/down.schema.sql.raw" "$WORK/schema-green.sql"
  check_same before down schema "после down схема ИДЕНТИЧНА схеме до v2 (дамп, дифф пуст)"
  check_same before down jobs-columns "после down столбцы jobs идентичны до v2"
  check_same before down data "после down данные всех таблиц те же (число строк и md5)"
  check_same before down knowledge "после down knowledge_chunks те же (включая fts и эмбеддинги)"
  check_same before down versions "после down множество version в учёте совпало побайтно"
  check_same before down ledger-old "после down прежние записи учёта (версия и время) не тронуты"

  # 6. Повтор обеих: без ошибок и без изменений.
  if down_both rb_battle down2 stdin; then
    snapshot rb_battle down2
    if same_snapshot down down2 schema && same_snapshot down down2 versions \
      && same_snapshot down down2 data && same_snapshot down down2 ledger-old; then
      verdict OK "повторный запуск 021_down.sql и 026_down.sql: rc=0, схема, учёт и данные без \
изменений"
    else
      verdict FAIL "повторный запуск обеих down изменил состояние"
    fi
  fi

  # 7. Вперёд снова: pending те же два, затем схема и учёт = первой накатке.
  check_plan rb_battle "после down" "$EXPECTED_PENDING" "$EXPECTED_LEGACY_APPLIED"
  apply_v2 rb_battle v2b "$EXPECTED_PENDING_COUNT"
  check_same v2 v2b schema "цикл вперёд-назад-вперёд: схема второй накатки = первой"
  check_same v2 v2b versions "цикл вперёд-назад-вперёд: учёт второй накатки = первой"
  check_same v2 v2b knowledge "цикл вперёд-назад-вперёд: knowledge_chunks без потерь"
  check_same before v2b data "цикл вперёд-назад-вперёд: данные всех таблиц те же, что до v2"

  # 8. Обратный порядок (026_down, затем 021_down) даёт то же состояние.
  copy_db rb_v2_keep rb_rev
  run_down rb_rev "$DOWN_026" "$SNAP/rev.down026.out"
  run_down rb_rev "$DOWN_021" "$SNAP/rev.down021.out"
  if [[ "$RUNNER_RC" -eq 0 ]]; then
    snapshot rb_rev rev
    check_same before rev schema "обратный порядок (026_down, затем 021_down): схема как до v2"
    check_same before rev data "обратный порядок: данные как до v2"
    check_same before rev versions "обратный порядок: учёт как до v2"
  else
    cat "$SNAP/rev.down021.out"
    verdict FAIL "обратный порядок: 021_down после 026_down завершился с кодом $RUNNER_RC"
  fi
  drop_db rb_rev

  # 9. MIGRATE_LEGACY_NAMES=1 (аварийный флаг): записи без префикса, после обеих down - как до v2?
  legacy_names_check

  # 10. Серии часов дня на базе после v2.
  series_check
  probe_states
}

# apply_v2 <база> <метка> <ожидаемо применено в первом запуске>: накатка раннером v2 дважды
# (второй раз - 0), снимок.
apply_v2() {
  local db="$1" tag="$2" want="$3" n1 n2
  run_runner "$V2_RUNNER" "$db" "$SNAP/$tag.apply1.out"
  n1="$(applied_count "$SNAP/$tag.apply1.out")"
  if [[ "$RUNNER_RC" -ne 0 ]]; then
    tail -n 15 "$SNAP/$tag.apply1.out"
    verdict FAIL "раннер v2 ($tag): rc=$RUNNER_RC"
    return 0
  fi
  run_runner "$V2_RUNNER" "$db" "$SNAP/$tag.apply2.out"
  n2="$(applied_count "$SNAP/$tag.apply2.out")"
  if [[ "${n1:-x}" == "$want" && "${n2:-x}" == "0" && "$RUNNER_RC" -eq 0 ]]; then
    verdict OK "раннер v2 ($tag): применил ${n1}, повтор - 0"
  else
    verdict FAIL "раннер v2 ($tag): применено ${n1:-?} и ${n2:-?}, ожидалось $want и 0"
  fi
  snapshot "$db" "$tag"
}

# Режим прежних имён: раннер пишет в учёт `021_jobs_daily_schedule` и `026_...` без префикса.
legacy_names_check() {
  copy_db rb_before_keep rb_ln
  MIGRATE_LEGACY_NAMES=1 run_runner "$V2_RUNNER" rb_ln "$SNAP/ln.apply.out"
  if [[ "$RUNNER_RC" -ne 0 \
    || "$(applied_count "$SNAP/ln.apply.out")" != "$EXPECTED_PENDING_COUNT" ]]; then
    tail -n 8 "$SNAP/ln.apply.out"
    verdict FAIL "режим MIGRATE_LEGACY_NAMES=1: накатка не удалась (rc=$RUNNER_RC)"
    drop_db rb_ln
    return 0
  fi
  snapshot rb_ln ln
  if grep -qx '021_jobs_daily_schedule' "$SNAP/ln.versions.txt"; then
    verdict OK "режим MIGRATE_LEGACY_NAMES=1: запись 021 пишется как 021_jobs_daily_schedule \
(без префикса)"
  else
    verdict FAIL "режим MIGRATE_LEGACY_NAMES=1: записи 021_jobs_daily_schedule нет в учёте"
  fi
  run_down rb_ln "$DOWN_021" "$SNAP/ln.down021.out"
  local rc021="$RUNNER_RC"
  snapshot rb_ln ln021
  if [[ "$rc021" -eq 0 ]] && ! grep -qx '021_jobs_daily_schedule' "$SNAP/ln021.versions.txt" \
    && same_snapshot before ln021 jobs-columns; then
    verdict OK "режим MIGRATE_LEGACY_NAMES=1: 021_down снимает запись 021_jobs_daily_schedule и \
столбцы"
  else
    verdict FAIL "режим MIGRATE_LEGACY_NAMES=1: 021_down не вернул учёт/столбцы jobs"
  fi
  run_down rb_ln "$DOWN_026" "$SNAP/ln.down026.out"
  snapshot rb_ln ln026
  # 026_down чистит только записи с префиксом: так ли ведёт себя учёт в режиме прежних имён?
  if same_snapshot before ln026 versions && same_snapshot before ln026 schema; then
    verdict OK "режим MIGRATE_LEGACY_NAMES=1: после обеих down учёт и схема как до v2"
  else
    note "режим MIGRATE_LEGACY_NAMES=1: после обеих down учёт НЕ как до v2 (026_down не снимает \
запись без префикса): лишние записи: $(comm -13 "$SNAP/before.versions.txt" \
"$SNAP/ln026.versions.txt" | tr '\n' ' ')"
  fi
  drop_db rb_ln
}

# Серии часов дня: 021_down их снимает, остальные задачи и таблицы не трогает.
series_check() {
  copy_db rb_v2_keep rb_series
  seed_ordinary_jobs rb_series
  seed_series_jobs rb_series
  local ordinary_before series_before
  ordinary_before="$(jobs_fp rb_series 'daily_at IS NULL')"
  series_before="$(sql_val rb_series "SELECT count(*) FROM jobs WHERE daily_at IS NOT NULL")"
  snapshot rb_series series-before
  copy_db rb_series rb_probe_red_src
  if [[ "$series_before" == "$SERIES_COUNT" ]]; then
    verdict OK "на базе после v2 посеяно серий часов дня: $series_before (pending, running)"
  else
    verdict FAIL "посеяно серий $series_before, ожидалось $SERIES_COUNT"
  fi
  run_down rb_series "$DOWN_021" "$SNAP/series.down021.out"
  if [[ "$RUNNER_RC" -ne 0 ]]; then
    cat "$SNAP/series.down021.out"
    verdict FAIL "021_down.sql на базе с сериями завершился с кодом $RUNNER_RC"
    return 0
  fi
  if grep -q "снято серий часов дня (jobs.daily_at): $SERIES_COUNT" "$SNAP/series.down021.out"; then
    verdict OK "021_down сообщил: снято серий часов дня $SERIES_COUNT"
  else
    cat "$SNAP/series.down021.out"
    verdict FAIL "021_down не сообщил число снятых серий ($SERIES_COUNT)"
  fi
  run_down rb_series "$DOWN_026" "$SNAP/series.down026.out"
  if [[ "$(jobs_fp rb_series 'true')" == "$ordinary_before" ]]; then
    verdict OK "после down в jobs нет серий, остальные задачи (разовая, интервальная, сид) \
без изменений: $ordinary_before"
  else
    verdict FAIL "после down jobs не равна «до down без серий»: $(jobs_fp rb_series 'true') \
против $ordinary_before"
  fi
  snapshot rb_series series-after
  # Все таблицы, кроме jobs, равны состоянию до v2 + две вымышленные задачи не затрагивают их.
  if diff <(grep -v '^jobs|' "$SNAP/before.data.txt") \
          <(grep -v '^jobs|' "$SNAP/series-after.data.txt") >/dev/null \
    && same_snapshot before series-after schema && same_snapshot before series-after versions
  then
    verdict OK "с сериями: схема, учёт и данные остальных таблиц после down как до v2"
  else
    verdict FAIL "с сериями: после down схема/учёт/данные отличаются от состояния до v2"
  fi
}

# Пробы на уровне SQL: что видит прежний код в каждом состоянии. Для каждой пробы - код и первая
# строка ошибки; сравниваются control и green (должны совпасть), red-021 отличается очередью.
PROBE_QUERY_TEXT="Тестовый фрагмент условия поставки"
PROBE_NOW="2100-01-01T00:00:00Z"
PROBE_OWNER="rb-probe"
PROBE_VISIBILITY_MS=600000
probe_sql() { # probe_sql <номер> -> SQL
  local emb="(SELECT embedding FROM knowledge_chunks WHERE chunk_index = 0 ORDER BY id LIMIT 1)"
  case "$1" in
    1) echo "SELECT document_id, chunk_index, left(snippet, 30), round(score::numeric, 9)
             FROM hybrid_search('$PROBE_QUERY_TEXT', $emb, 10)" ;;
    2) echo "SELECT document_id, chunk_index, round(score::numeric, 9)
             FROM hybrid_search('$PROBE_QUERY_TEXT', $emb, 10, NULL, 'synth-sup-003')" ;;
    3) echo "SELECT document_id FROM hybrid_search('$PROBE_QUERY_TEXT', NULL, 10,
             filter_supplier => 'synth-sup-003')" ;;
    4) echo "SELECT document_id, chunk_index, round(score::numeric, 9)
             FROM hybrid_search_suppliers('$PROBE_QUERY_TEXT', $emb, 10)" ;;
    5) echo "SELECT knowledge_fts_query('болт M8x40 и 3х2,5 кабель')::text,
             (SELECT provolatile FROM pg_proc WHERE proname = 'knowledge_fts_query')" ;;
    6) echo "SELECT document_id, supplier_id FROM knowledge_chunks ORDER BY id LIMIT 3" ;;
    7) echo "BEGIN; INSERT INTO knowledge_chunks (document_id, chunk_index, content, source,
             supplier_id) VALUES ('probe-doc', 0, 'проба записи', 'probe', 'synth-sup-001');
             ROLLBACK" ;;
    8) echo "SELECT count(*) FROM hybrid_search_messages('synth-thread-001', 'Тестовое сообщение',
             NULL, 10)" ;;
    # Запись задачи по интервалу, как PostgresScheduler.add (столбцы прежней схемы).
    9) echo "BEGIN; INSERT INTO jobs (id, name, payload, due_at, repeat_every_ms, idempotency_key)
             VALUES ('probe-job', 'probe', '{}', '$PROBE_NOW'::timestamptz, 60000, 'probe-key');
             ROLLBACK" ;;
    # Срез очереди прежнего кода (QUEUE_STATS_SQL): счётчики по статусам.
    10) echo "SELECT count(*) FILTER (WHERE status = 'pending')::int,
              count(*) FILTER (WHERE status = 'running')::int,
              count(*) FILTER (WHERE status = 'done')::int,
              count(*) FILTER (WHERE status = 'failed')::int FROM jobs" ;;
  esac
}
PROBE_COUNT=10

# Прежний claimDue + finish (SQL из core/src/adapters/postgres/scheduler.ts) в откатываемой
# транзакции: итоговые статусы задач. Серия часов дня (repeat_every_ms пуст) закроется как
# разовая.
CLAIM_PROBE_SQL="
BEGIN;
WITH due AS (
  SELECT id FROM jobs
  WHERE (status = 'pending' AND due_at <= '$PROBE_NOW'::timestamptz
         AND (next_attempt_at IS NULL OR next_attempt_at <= '$PROBE_NOW'::timestamptz))
     OR (status = 'running'
         AND locked_at <= '$PROBE_NOW'::timestamptz
             - interval '1 millisecond' * $PROBE_VISIBILITY_MS::bigint)
  ORDER BY due_at, id LIMIT 1000 FOR UPDATE SKIP LOCKED
)
UPDATE jobs j SET status = 'running', attempts = j.attempts + 1,
  locked_at = '$PROBE_NOW'::timestamptz, locked_by = '$PROBE_OWNER'
FROM due WHERE j.id = due.id;
UPDATE jobs SET
  status = CASE WHEN repeat_every_ms IS NULL THEN 'done' ELSE 'pending' END,
  finished_at = CASE WHEN repeat_every_ms IS NULL THEN '$PROBE_NOW'::timestamptz END,
  due_at = CASE WHEN repeat_every_ms IS NULL THEN due_at ELSE due_at + interval '1 millisecond'
    * (repeat_every_ms * (greatest(floor(extract(epoch FROM ('$PROBE_NOW'::timestamptz - due_at))
    * 1000 / repeat_every_ms), -1) + 1)) END,
  attempts = CASE WHEN repeat_every_ms IS NULL THEN attempts ELSE 0 END,
  next_attempt_at = NULL, last_error = NULL, locked_at = NULL, locked_by = NULL
WHERE id IN (SELECT id FROM jobs WHERE status = 'running' AND locked_by = '$PROBE_OWNER');
SELECT id || '|' || name || '|' || status || '|' || (finished_at IS NOT NULL)
FROM jobs ORDER BY id;
ROLLBACK;"

# run_probes <база> <файл вывода>
run_probes() {
  local db="$1" out="$2" n rc msg
  : >"$out"
  for ((n = 1; n <= PROBE_COUNT; n++)); do
    rc=0
    msg="$(psql_db "$db" -v ON_ERROR_STOP=1 -At -c "$(probe_sql "$n")" 2>&1)" || rc=$?
    if [[ "$rc" -eq 0 ]]; then
      echo "проба $n: OK, md5=$(printf '%s' "$msg" | md5sum | cut -c1-12)," \
        "строк=$(printf '%s\n' "$msg" | wc -l)" >>"$out"
    else
      echo "проба $n: ОШИБКА: $(printf '%s' "$msg" | head -n 1)" >>"$out"
    fi
  done
  # Проба очереди: полный вывод (итоговые статусы задач после прежних claim и finish).
  rc=0
  msg="$(printf '%s\n' "$CLAIM_PROBE_SQL" | psql_db "$db" -v ON_ERROR_STOP=1 -At -f - 2>&1 \
    | grep -E '^(rb021|synth|ОШИБКА|ERROR)' )" || rc=$?
  { echo "claim-проба очереди (id|name|status|закрыта):"; printf '%s\n' "$msg"; } >>"$out"
}

probe_states() {
  # Состояния: до v2 (+обычные задачи), после v2 и 026_down (red-021, серии посеяны),
  # после обеих down (green; это rb_series из series_check, серии были посеяны ДО down).
  copy_db rb_before_keep rb_probe_control
  seed_ordinary_jobs rb_probe_control
  copy_db rb_probe_red_src rb_probe_red
  psql_db rb_probe_red --single-transaction -v ON_ERROR_STOP=1 -f "$DOWN_026" >/dev/null 2>&1 \
    || verdict FAIL "026_down на копии red-021 для проб не выполнилась"
  run_probes rb_probe_control "$SNAP/probes-control.txt"
  run_probes rb_probe_red "$SNAP/probes-red.txt"
  run_probes rb_series "$SNAP/probes-green.txt"
  local s
  for s in control red green; do
    local db="rb_probe_$s"
    [[ "$s" == "green" ]] && db="rb_series"
    docker exec "$CONTAINER" pg_dump -Fc --no-owner -U postgres "$db" >"$WORK/probe-$s.dump"
  done
  if cmp -s "$SNAP/probes-control.txt" "$SNAP/probes-green.txt"; then
    verdict OK "SQL-пробы прежнего кода: green идентичны control (знания, запись и срез очереди, \
claim/finish)"
  else
    diff "$SNAP/probes-control.txt" "$SNAP/probes-green.txt" || true
    verdict FAIL "SQL-пробы: green отличается от control"
  fi
  # red-021: знания в порядке (026_down), но серия часов дня закрыта как разовая.
  if grep -q '^rb021-daily-1|rb021.daily|done|true$' "$SNAP/probes-red.txt" \
    && ! grep -q 'rb021-daily' "$SNAP/probes-control.txt" \
    && ! grep -q 'rb021-daily' "$SNAP/probes-green.txt"; then
    verdict OK "SQL-проба очереди: на red-021 прежний claim/finish закрывает серию часов дня как \
разовую (status=done), на control и green серий нет"
  else
    verdict FAIL "SQL-проба очереди: red-021 не показал закрытия серии часов дня"
  fi
  if ! grep -q 'ОШИБКА' "$SNAP/probes-red.txt"; then
    note "SQL-пробы красной схемы red-021: ни одна из $PROBE_COUNT проб не упала с ошибкой \
(миграция 021 аддитивна: прежний код работает; вред - только закрытие серий)"
  fi
  log "пробы control:"; sed 's/^/    /' "$SNAP/probes-control.txt"
  log "пробы red:"; sed 's/^/    /' "$SNAP/probes-red.txt"
  log "пробы green:"; sed 's/^/    /' "$SNAP/probes-green.txt"
}

# --- Старый код: копия с шаблонными базами --------------------------------------------------
CODE_DIR="$WORK/old-code"

# Копия дерева старого кода (git-объекты, ~27 МБ) + подмена support.ts; node_modules - ссылка на
# worktree (только чтение). Оригинальный worktree не меняется.
prepare_old_code() {
  rm -rf "${CODE_DIR:?}"
  mkdir -p "$CODE_DIR"
  git -C "$SRC_REPO" archive "$SRC_COMMIT" | tar -x -C "$CODE_DIR"
  local nm
  # Виртуальные окружения сервисов нужны только e2e (ссылки на worktree, только чтение).
  for nm in services/pseudonymizer services/documents services/embeddings services/indexer \
    gateway/pii-guard; do
    [[ -e "$OLD_WORKTREE/$nm/.venv" ]] && ln -s "$OLD_WORKTREE/$nm/.venv" "$CODE_DIR/$nm/.venv"
  done
  for nm in core vendor/labops-pii/ts eval; do
    [[ -d "$OLD_WORKTREE/$nm/node_modules" ]] || die "нет $OLD_WORKTREE/$nm/node_modules"
    ln -s "$OLD_WORKTREE/$nm/node_modules" "$CODE_DIR/$nm/node_modules"
  done
  python3 -I - "$CODE_DIR/core/tests/adapters/postgres/support.ts" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")


def swap(old: str, new: str) -> None:
    """Заменяет ровно одно вхождение, иначе останавливается."""
    global text
    if text.count(old) != 1:
        raise SystemExit(f"support.ts: якорь не найден ровно один раз: {old[:60]!r}")
    text = text.replace(old, new)


swap(
    "const PUBLIC_SCHEMA = 'public';\n",
    "const PUBLIC_SCHEMA = 'public';\n"
    "/** Шаблонная база со схемой проверяемого состояния (стенд rollback 026). */\n"
    "const TEMPLATE_DB = process.env['TEST_SCHEMA_TEMPLATE'];\n"
    "\n"
    "function withDatabase(url: string, database: string): string {\n"
    "  const parsed = new URL(url);\n"
    "  parsed.pathname = `/${database}`;\n"
    "  return parsed.toString();\n"
    "}\n"
    "\n"
    "function dropSql(name: string): string {\n"
    "  return name.startsWith('db_')\n"
    "    ? `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`\n"
    "    : `DROP SCHEMA ${name} CASCADE`;\n"
    "}\n",
)
swap(
    "  const schema = `t_${randomUUID().replaceAll('-', '').slice(0, SCHEMA_ID_LENGTH)}`;\n"
    "  const client = createPgClient({\n"
    "    url,\n"
    "    searchPath: `${schema},${PUBLIC_SCHEMA}`,\n",
    "  const fromTemplate = TEMPLATE_DB !== undefined && options.stopBefore === undefined;\n"
    "  const schema = `${fromTemplate ? 'db_' : ''}t_${randomUUID().replaceAll('-', '')"
    ".slice(0, SCHEMA_ID_LENGTH)}`;\n"
    "  const client = createPgClient({\n"
    "    url: fromTemplate ? withDatabase(url, schema) : url,\n"
    "    searchPath: fromTemplate ? undefined : `${schema},${PUBLIC_SCHEMA}`,\n",
)
swap(
    "  const ready = (async () => {\n"
    "    await (await admin(url)).query(`CREATE SCHEMA ${schema}`);\n",
    "  const ready = (async () => {\n"
    "    if (fromTemplate) {\n"
    "      await (await admin(url)).query(`CREATE DATABASE ${schema} TEMPLATE ${TEMPLATE_DB}`);\n"
    "      return;\n"
    "    }\n"
    "    await (await admin(url)).query(`CREATE SCHEMA ${schema}`);\n",
)
swap(
    "await (await adminPromise).query(`DROP SCHEMA ${entry.schema} CASCADE`);",
    "await (await adminPromise).query(dropSql(entry.schema));",
)
swap(
    "await (await adminPromise).query(`DROP SCHEMA ${schema} CASCADE`);",
    "await (await adminPromise).query(dropSql(schema));",
)
path.write_text(text, encoding="utf-8")
PY
  log "копия старого кода готова: $CODE_DIR (support.ts подменён: схема теста = клон шаблона)"
}

# make_template <схема>: база tmpl_<схема> из сырого дампа состояния.
make_template() {
  local name="$1" raw="$WORK/schema-$1.sql"
  [[ -f "$raw" ]] || die "нет $raw: сначала фаза db"
  drop_db "tmpl_$name"
  make_db "tmpl_$name"
  grep -vE '^\\(un)?restrict ' "$raw" | docker exec -i "$CONTAINER" psql -U postgres -q \
    -v ON_ERROR_STOP=1 -d "tmpl_$name" >"$WORK/tmpl-$name.load.out" 2>&1 \
    || { tail -n 15 "$WORK/tmpl-$name.load.out"; die "шаблон tmpl_$name не загрузился"; }
  log "шаблон tmpl_$name загружен из $raw"
}

RUNTIME_READY=0
ensure_runtime() {
  [[ "$RUNTIME_READY" -eq 0 ]] || return 0
  if [[ "$CONTAINER_UP" -eq 0 ]]; then
    prepare_old_sources
    start_postgres
  fi
  local s
  for s in "${SCHEMAS[@]}"; do make_template "$s"; done
  prepare_old_code
  RUNTIME_READY=1
}

# bun_run <схема> <метка> <таймаут> <файлы...>: прогон bun test в копии; результат в results.tsv.
BUN_PASS=0 BUN_FAIL=0 BUN_SKIP=0 BUN_RC=0
declare -A COUNTS=()
bun_run() {
  local schema="$1" label="$2" timeout_s="$3"
  shift 3
  local out="$WORK/bun-$label-$schema.log"
  BUN_RC=0
  # Схема orig: прогон «как в эталоне» - без шаблона, схему тест строит из db/migrations сам.
  local -a tmpl_env=()
  [[ "$schema" == "orig" ]] || tmpl_env=(TEST_SCHEMA_TEMPLATE="tmpl_$schema")
  ( cd "$CODE_DIR/core" \
    && env TEST_DATABASE_URL="$(db_url postgres)" "${tmpl_env[@]}" \
       timeout "$timeout_s" bun test "$@" ) >"$out" 2>&1 || BUN_RC=$?
  BUN_PASS="$(sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' "$out" | tail -n 1)"
  BUN_FAIL="$(sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' "$out" | tail -n 1)"
  BUN_SKIP="$(sed -n 's/^ *\([0-9][0-9]*\) skip$/\1/p' "$out" | tail -n 1)"
  BUN_PASS="${BUN_PASS:-0}" BUN_FAIL="${BUN_FAIL:-0}" BUN_SKIP="${BUN_SKIP:-0}"
  COUNTS["$label/$schema"]="$BUN_PASS $BUN_FAIL $BUN_SKIP"
  grep -E '^\(fail\)' "$out" | sed 's/ \[[0-9.]*m\?s\]$//' | sort -u \
    >"$WORK/fails-$label-$schema.txt" || true
  log "$label/$schema: pass=$BUN_PASS fail=$BUN_FAIL skip=$BUN_SKIP rc=$BUN_RC (журнал $out)"
}

record() { # record <схема> <набор> <метка прогона> <вывод>
  local pass fail skip
  read -r pass fail skip <<<"${COUNTS["$3/$1"]}"
  local name="$1"
  [[ "$name" != "red" ]] || name="red-021"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$CUR_PHASE" "$name" "$2" "$pass" "$fail" "$skip" \
    "$4" >>"$RESULTS_TSV"
}

# Файлы Postgres-тестов, затрагивающие очередь jobs (адаптер PostgresScheduler и таблица jobs).
targeted_files() {
  (cd "$CODE_DIR/core" \
    && grep -rlE 'describePostgres|createIsolatedClient|TEST_DATABASE_URL' tests \
       | xargs grep -lE 'PostgresScheduler|scheduleRecurring|claimDue|queueStats|(FROM|INTO) jobs' \
       | grep -v 'tests/adapters/postgres/support.ts' \
       | grep -v 'rollback-021-probe.test.ts' | sort)
}

# unknown_failures <файл упавших>: сколько упавших тестов НЕ названо в примечании core-tests-pg
# эталона (stage-7 tests.tsv); имена печатаются в stderr. Имя - часть строки после последнего ' > '.
unknown_failures() {
  python3 -I - "$1" "$BASELINE_TSV" <<'PY'
import sys
from pathlib import Path

fails = Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
note = ""
for line in Path(sys.argv[2]).read_text(encoding="utf-8").splitlines():
    cols = line.split("\t")
    if cols and cols[0] == "core-tests-pg":
        note = cols[-1]
unknown = []
for line in fails:
    name = line.removeprefix("(fail) ").rsplit(" > ", 1)[-1].strip()
    if name not in note:
        unknown.append(line)
for line in unknown:
    print(line, file=sys.stderr)
print(len(unknown))
PY
}

phase_targeted() {
  begin_phase targeted
  log "=== Фаза targeted: целевые тесты очереди jobs на трёх схемах ==="
  ensure_runtime
  local -a files
  mapfile -t files < <(targeted_files)
  printf '%s\n' "${files[@]}" >"$WORK/targeted-files.txt"
  local label="целевые jobs (${#files[@]} файлов)"
  log "целевых файлов: ${#files[@]} (список: $WORK/targeted-files.txt)"
  local s unknown
  for s in "${SCHEMAS[@]}"; do
    bun_run "$s" targeted "$TARGETED_TIMEOUT_SEC" "${files[@]}"
  done
  # control и green: зелёные, кроме падений, которые есть и в эталоне stage-7 (не от схемы).
  for s in control green; do
    unknown="$(unknown_failures "$WORK/fails-targeted-$s.txt" 2>"$WORK/unknown-targeted-$s.txt")"
    if [[ "$unknown" == "0" ]]; then
      verdict OK "целевые тесты очереди на схеме $s: все падения (если есть) - известные падения \
эталона"
    else
      verdict FAIL "целевые тесты очереди на схеме $s: $unknown падений вне списка эталона \
($WORK/unknown-targeted-$s.txt)"
    fi
  done
  local green_only
  green_only="$(comm -13 "$WORK/fails-targeted-control.txt" "$WORK/fails-targeted-green.txt")"
  if [[ -z "$green_only" ]]; then
    verdict OK "целевые тесты очереди: на green нет падений, которых нет на control"
  else
    verdict FAIL "целевые тесты очереди: на green есть падения, которых нет на control"
  fi
  # red-021: миграция 021 аддитивна; падения сверх control - только если они есть по факту.
  comm -13 "$WORK/fails-targeted-control.txt" "$WORK/fails-targeted-red.txt" \
    >"$WORK/fails-targeted-red-only.txt" || true
  local n_ctl n_red n_grn
  n_ctl="$(wc -l <"$WORK/fails-targeted-control.txt")"
  n_red="$(wc -l <"$WORK/fails-targeted-red-only.txt")"
  n_grn="$(wc -l <"$WORK/fails-targeted-green.txt")"
  if [[ "$n_red" -eq 0 ]]; then
    note "целевые тесты очереди на red-021 (серии не посеяны): падений сверх control нет - \
миграция 021 аддитивна, прежний код без серий часов дня работает; красной остаётся проба с серией"
    record control "$label" targeted "зелёные, кроме известных падений эталона ($n_ctl)"
    record red "$label" targeted "как control (+0 падений): 021 аддитивна без серий часов дня"
  else
    note "целевые тесты очереди на red-021: $n_red падений сверх control (см. \
$WORK/fails-targeted-red-only.txt)"
    record control "$label" targeted "зелёные, кроме известных падений эталона ($n_ctl)"
    record red "$label" targeted "+$n_red падений сверх control"
  fi
  record green "$label" targeted "как control: только известные падения эталона ($n_grn)"
}

# --- Проба адаптера очереди прежнего кода на данных ----------------------------------------
# Тест кладётся в копию старого кода (не в worktree): PostgresScheduler прежнего кода берёт
# все наступившие задачи (claimDue) и закрывает их (complete), как делает его воркер.
PROBE_TEST_REL="tests/adapters/postgres/rollback-021-probe.test.ts"
write_probe_test() {
  cat >"$CODE_DIR/core/$PROBE_TEST_REL" <<'TS'
import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { PostgresScheduler, createPgClient } from '../../../src/adapters';

const URL = process.env['PROBE_DATABASE_URL'];
const OUT = process.env['PROBE_OUT'];
const NOW = new Date('2100-01-01T00:00:00Z');
const OWNER = 'rb-probe';
const CLAIM_LIMIT = 1000;
const SERIES_PREFIX = 'rb021-daily';

test('прежний PostgresScheduler: серия часов дня не должна закрыться как разовая', async () => {
  if (URL === undefined || OUT === undefined) throw new Error('нет PROBE_DATABASE_URL/PROBE_OUT');
  const db = createPgClient({ url: URL, maxConnections: 1 });
  try {
    const scheduler = new PostgresScheduler(db);
    const claimed = await scheduler.claimDue(NOW, { limit: CLAIM_LIMIT, owner: OWNER });
    for (const task of claimed) await scheduler.complete(task.id, OWNER, NOW);
    const rows = await db.query(
      `SELECT id, name, status, attempts::int AS attempts, repeat_every_ms IS NOT NULL AS repeating,
         finished_at IS NOT NULL AS closed, to_char(due_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS due FROM jobs ORDER BY id`,
    );
    const stats = await scheduler.queueStats(NOW);
    writeFileSync(
      OUT,
      `${rows.map((r) => JSON.stringify(r)).join('\n')}\n${JSON.stringify(stats.byStatus)}\n`,
    );
    const series = rows.filter((r) => String(r['id']).startsWith(SERIES_PREFIX));
    const closedSeries = series.filter((r) => r['status'] === 'done' && r['closed'] === true);
    // Серия часов дня, закрытая прежним кодом как разовая, - потеря расписания.
    expect(closedSeries.map((r) => r['id'])).toEqual([]);
    // Интервальная задача осталась в очереди, разовая закрыта: очередь работает штатно.
    expect(rows.find((r) => r['id'] === 'rb021-interval')).toMatchObject({
      status: 'pending',
      repeating: true,
    });
    expect(rows.find((r) => r['id'] === 'rb021-once')).toMatchObject({
      status: 'done',
      closed: true,
    });
  } finally {
    await db.close();
  }
});
TS
}

# probe_run <схема>: восстановить базу с данными из дампа и прогнать пробу; код выхода bun.
probe_run() {
  local s="$1" db="probe_$1" out="$WORK/probe-bun-$1.log"
  [[ -f "$WORK/probe-$s.dump" ]] || die "нет $WORK/probe-$s.dump: сначала фаза db"
  drop_db "$db"
  make_db "$db"
  docker exec -i "$CONTAINER" pg_restore --no-owner -U postgres -d "$db" \
    <"$WORK/probe-$s.dump" >"$WORK/probe-restore-$s.out" 2>&1 \
    || { tail -n 15 "$WORK/probe-restore-$s.out"; die "дамп пробы $s не восстановился"; }
  BUN_RC=0
  ( cd "$CODE_DIR/core" \
    && env PROBE_DATABASE_URL="$(db_url "$db")" PROBE_OUT="$WORK/probe-bun-$s.state" \
       timeout "$TARGETED_TIMEOUT_SEC" bun test "$PROBE_TEST_REL" ) >"$out" 2>&1 || BUN_RC=$?
  BUN_PASS="$(sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' "$out" | tail -n 1)"
  BUN_FAIL="$(sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' "$out" | tail -n 1)"
  BUN_PASS="${BUN_PASS:-0}" BUN_FAIL="${BUN_FAIL:-0}"
  COUNTS["probe/$s"]="$BUN_PASS $BUN_FAIL 0"
  log "probe/$s: pass=$BUN_PASS fail=$BUN_FAIL rc=$BUN_RC (журнал $out)"
}

phase_probe() {
  begin_phase probe
  log "=== Фаза probe: PostgresScheduler прежнего кода на сериях часов дня ==="
  [[ -f "$WORK/probe-green.dump" ]] || { log "дампов проб нет: иду фазой db"; phase_db; }
  ensure_runtime
  write_probe_test
  local s rc_control rc_red rc_green
  for s in "${SCHEMAS[@]}"; do
    probe_run "$s"
    case "$s" in
      control) rc_control="$BUN_RC" ;;
      red) rc_red="$BUN_RC" ;;
      green) rc_green="$BUN_RC" ;;
    esac
  done
  if [[ "$rc_control" -eq 0 ]] && ! grep -q 'rb021-daily' \
    "$WORK/probe-bun-control.state"; then
    verdict OK "проба control: зелёная, серий часов дня нет, интервальная в очереди, \
разовая закрыта"
  else
    verdict FAIL "проба control не зелёная (rc=$rc_control, см. $WORK/probe-bun-control.log)"
  fi
  if [[ "$rc_red" -ne 0 ]] \
    && grep -q '"id":"rb021-daily-1".*"status":"done".*"closed":true' \
         "$WORK/probe-bun-red.state"; then
    verdict OK "проба red-021: КРАСНАЯ - прежний PostgresScheduler выполнил серии часов дня один \
раз как разовые и закрыл (status=done): $(grep -c '"id":"rb021-daily.*"status":"done"' \
"$WORK/probe-bun-red.state") из $SERIES_COUNT"
  else
    verdict FAIL "проба red-021 не покраснела (rc=$rc_red, см. $WORK/probe-bun-red.log)"
  fi
  # green: серий нет, остальное идентично control (в состоянии нет строк серий).
  if [[ "$rc_green" -eq 0 ]] && cmp -s "$WORK/probe-bun-control.state" \
    "$WORK/probe-bun-green.state"; then
    verdict OK "проба green: зелёная, состояние очереди после claim/complete побайтно как на \
control (серий часов дня нет)"
  else
    verdict FAIL "проба green отличается от control или красная (rc=$rc_green)"
  fi
  record control "проба очереди (серия часов дня)" probe "зелёная: серий нет"
  record red "проба очереди (серия часов дня)" probe "КРАСНАЯ: серии закрыты как разовые"
  record green "проба очереди (серия часов дня)" probe "зелёная: серий нет, как control"
}

# test_files_of <файл упавших>: файлы тестов (относительно core), где объявлены эти тесты.
test_files_of() {
  python3 -I - "$1" "$CODE_DIR/core" <<'PY'
import sys
from pathlib import Path

names = []
for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    name = line.removeprefix("(fail) ").rsplit(" > ", 1)[-1].strip()
    # Имя может быть обрезано выводом bun: ищем по началу.
    names.append(name[:24])
root = Path(sys.argv[2])
found = set()
for path in sorted((root / "tests").rglob("*.test.ts")):
    text = path.read_text(encoding="utf-8")
    if any(name and name in text for name in names):
        found.add(str(path.relative_to(root)))
print("\n".join(sorted(found)))
PY
}

phase_full() {
  begin_phase full
  log "=== Фаза full: полный core-tests-pg старого кода на схеме green ==="
  ensure_runtime
  bun_run green full "$FULL_TIMEOUT_SEC"
  local base unknown note=""
  base="$(awk -F'\t' '$1 == "core-tests-pg" {print "pass="$3" fail="$4" skip="$5}' "$BASELINE_TSV")"
  unknown="$(unknown_failures "$WORK/fails-full-green.txt" 2>"$WORK/unknown-full-green.txt")"
  if [[ "$unknown" != "0" ]]; then
    # Эталон называет не все падения (в примечании не больше 8 имён): имена вне него
    # перепроверяются «как в эталоне» (без шаблона схемы); падает и там - не от схемы.
    local -a files
    mapfile -t files < <(test_files_of "$WORK/unknown-full-green.txt")
    log "падений вне примечания эталона: $unknown; перепроверка без шаблона: ${files[*]}"
    bun_run orig full-orig "$TARGETED_TIMEOUT_SEC" "${files[@]}"
    unknown="$(comm -23 <(sort "$WORK/unknown-full-green.txt") \
      <(sort "$WORK/fails-full-orig-orig.txt") | wc -l)"
    note="; $unknown не воспроизводятся без шаблона"
  fi
  record green "core-tests-pg (полный)" full "эталон stage-7: $base$note"
  local gp gf gs
  read -r gp gf gs <<<"${COUNTS[full/green]}"
  if [[ "$unknown" == "0" ]]; then
    verdict OK "core-tests-pg на green: pass=$gp fail=$gf skip=$gs (эталон: $base); каждое \
падение известно эталону или воспроизводится без шаблона схемы"
  else
    verdict FAIL "core-tests-pg на green: падений, не объяснённых эталоном: $unknown \
(см. $WORK/unknown-full-green.txt)"
  fi
}

# --- e2e -----------------------------------------------------------------------------------
# Порты e2e внутри 21700-21709 (тесты берут PSEUDO+1 и VISION+1, +2). Порт Postgres стенда
# (21700) отдаётся e2e: перед e2e контейнер стенда гасится (stop_postgres в e2e_prepare).
E2E_PG_PORT=21700
E2E_VISION_PORT=21701
E2E_PSEUDO_PORT=21704
E2E_DOCS_PORT=21706
E2E_EMBED_PORT=21707
E2E_GUARD_PORT=21708
E2E_LLM_PORT=21709
# Короткий каталог данных e2e: путь unix-сокета песочницы (sandbox.sock) не длиннее 108 знаков.
E2E_TMP_BASE_DIR="${E2E_TMP_BASE_DIR:-$BAI_HOME/stage-8u/tmp/subA/e2e}"

# Ведомость учёта состояния для e2e: версии из снимка (по схеме control/red/green).
ledger_tag() { case "$1" in control) echo before ;; red) echo red ;; green) echo down ;; esac; }

# e2e_install_migrate <схема>: db/migrate.sh копии. control - настоящий прежний раннер (как в
# e2e/run.sh на FREEZE_SRC); red/green - загрузка схемы состояния из дампа и записей учёта, потому
# что e2e/run.sh сам строит базу только штатными миграциями прежнего репозитория.
e2e_install_migrate() {
  local schema="$1" dir="$CODE_DIR/db"
  cp "$WORK/old-src/db/migrate.sh" "$dir/migrate.sh"
  [[ "$schema" != "control" ]] || return 0
  local raw="$WORK/schema-$schema.sql" tag
  tag="$(ledger_tag "$schema")"
  grep -vE '^\\(un)?restrict ' "$raw" >"$WORK/e2e-schema-$schema.sql"
  {
    echo "INSERT INTO schema_migrations (version) VALUES"
    sed "s/.*/('&')/" "$SNAP/$tag.versions.txt" | paste -sd, -
    echo ";"
  } >"$WORK/e2e-ledger-$schema.sql"
  cat >"$dir/migrate.sh" <<SH
#!/usr/bin/env bash
# Подмена на стенде rollback 021/026: при первом запуске в пустой базе грузит схему состояния
# «$schema» из дампа и записи учёта, затем (и при повторных запусках, как делает q8) отдаёт
# управление настоящему прежнему раннеру: на этом состоянии он ничего не применяет.
set -euo pipefail
empty="\$(psql --no-psqlrc -qAt "\$DATABASE_URL" \\
  -c "SELECT to_regclass('schema_migrations') IS NULL")"
if [[ "\$empty" == "t" ]]; then
  psql --no-psqlrc -q -v ON_ERROR_STOP=1 "\$DATABASE_URL" -f "$WORK/e2e-schema-$schema.sql"
  psql --no-psqlrc -q -v ON_ERROR_STOP=1 "\$DATABASE_URL" -f "$WORK/e2e-ledger-$schema.sql"
fi
exec bash "$WORK/old-src/db/migrate.sh"
SH
}

# e2e_run <схема> <метка> <таймаут> [файлы тестов e2e]: прогон e2e/run.sh в копии кода.
e2e_run() {
  local schema="$1" label="$2" timeout_s="$3"
  shift 3
  local out="$WORK/e2e-$label-$schema.log" tmp_base="$E2E_TMP_BASE_DIR"
  rm -rf "${tmp_base:?}"
  mkdir -p "$tmp_base"
  e2e_install_migrate "$schema"
  BUN_RC=0
  ( cd "$CODE_DIR" && E2E_KEEP=1 E2E_TMP_BASE="$tmp_base" E2E_PG_PORT="$E2E_PG_PORT" \
      E2E_PSEUDO_PORT="$E2E_PSEUDO_PORT" E2E_DOCS_PORT="$E2E_DOCS_PORT" \
      E2E_EMBED_PORT="$E2E_EMBED_PORT" E2E_GUARD_PORT="$E2E_GUARD_PORT" \
      E2E_LLM_PORT="$E2E_LLM_PORT" E2E_VISION_PORT="$E2E_VISION_PORT" \
      timeout "$timeout_s" bash e2e/run.sh "$@" ) >"$out" 2>&1 || BUN_RC=$?
  BUN_PASS="$(sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' "$out" | tail -n 1)"
  BUN_FAIL="$(sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' "$out" | tail -n 1)"
  BUN_SKIP="$(sed -n 's/^ *\([0-9][0-9]*\) skip$/\1/p' "$out" | tail -n 1)"
  BUN_PASS="${BUN_PASS:-0}" BUN_FAIL="${BUN_FAIL:-0}" BUN_SKIP="${BUN_SKIP:-0}"
  COUNTS["$label/$schema"]="$BUN_PASS $BUN_FAIL $BUN_SKIP"
  grep -E '^\(fail\)' "$out" | sed 's/ \[[0-9.]*m\?s\]$//' | sort -u \
    >"$WORK/fails-$label-$schema.txt" || true
  # Журнал индексатора (ошибки записи в knowledge_chunks) - до удаления рабочего каталога e2e.
  find "$tmp_base" -path '*/logs/indexer.log' -exec cp {} "$WORK/e2e-$label-$schema.indexer.log" \;
  rm -rf "${tmp_base:?}"
  log "e2e $label/$schema: pass=$BUN_PASS fail=$BUN_FAIL skip=$BUN_SKIP rc=$BUN_RC (журнал $out)"
}

e2e_prepare() {
  resources_ok \
    || die "для e2e мало ресурсов (RAM >= $MIN_RAM_MIB МиБ, диск >= $MIN_DISK_GIB ГиБ)"
  [[ -f "$WORK/old-src/db/migrate.sh" && -f "$SNAP/down.versions.txt" ]] \
    || die "нет снимков: сначала фаза db"
  # Порт 21700 нужен e2e: контейнер стенда (схемы уже сняты в дампы) гасится.
  stop_postgres
  [[ -d "$CODE_DIR/e2e" ]] || prepare_old_code
}

# e2e: полный набор на зелёной схеме; эталон stage-7 (239 pass, 0 fail, 5 skip).
phase_e2e() {
  begin_phase e2e
  log "=== Фаза e2e: полный e2e старого кода на схеме green ==="
  e2e_prepare
  e2e_run green e2e "$E2E_TIMEOUT_SEC"
  local base
  base="$(awk -F'\t' '$1 == "e2e" {print "pass="$3" fail="$4" skip="$5}' "$BASELINE_TSV")"
  record green "e2e полный" e2e "эталон stage-7: $base; rc=$BUN_RC"
  if [[ "$BUN_FAIL" -eq 0 && "$BUN_RC" -eq 0 ]]; then
    verdict OK "e2e на green: pass=$BUN_PASS fail=0 skip=$BUN_SKIP (эталон: $base)"
  else
    verdict FAIL "e2e на green: fail=$BUN_FAIL rc=$BUN_RC (эталон: $base)"
  fi
}

# e2e-recheck: перепроверка файлов e2e, упавших в полном прогоне (E2E_RECHECK_FILES), на green
# дважды и на control (настоящий прежний раннер) один раз: падение не от схемы, если на control
# оно воспроизводится или на green пропадает при повторе (флак по времени).
phase_e2e_recheck() {
  begin_phase e2e-recheck
  log "=== Фаза e2e-recheck: перепроверка упавших файлов e2e ==="
  e2e_prepare
  local files="${E2E_RECHECK_FILES:-tests/r-bitrix24-restart.test.ts}" run
  local green_ok=0 control_fail=0
  local -a list
  read -r -a list <<<"$files"
  for run in 1 2; do
    e2e_run green "e2e-recheck$run" "$E2E_TIMEOUT_SEC" "${list[@]}"
    record green "e2e перепроверка #$run ($files)" "e2e-recheck$run" "rc=$BUN_RC"
    if [[ "$BUN_FAIL" -eq 0 && "$BUN_RC" -eq 0 && "$BUN_PASS" -gt 0 ]]; then
      green_ok=$((green_ok + 1))
      note "e2e перепроверка #$run на green ($files): зелёная (pass=$BUN_PASS)"
    else
      note "e2e перепроверка #$run на green ($files): fail=$BUN_FAIL rc=$BUN_RC"
    fi
  done
  e2e_run control e2e-recheck-c "$E2E_TIMEOUT_SEC" "${list[@]}"
  record control "e2e перепроверка ($files)" e2e-recheck-c "rc=$BUN_RC"
  [[ "$BUN_FAIL" -eq 0 && "$BUN_RC" -eq 0 ]] || control_fail=1
  note "e2e перепроверка на control ($files): fail=$BUN_FAIL rc=$BUN_RC"
  # Падение не от отката: на green файл проходит хотя бы раз, либо оно же есть на control.
  if [[ "$green_ok" -ge 1 || "$control_fail" -eq 1 ]]; then
    verdict OK "e2e: падение из полного прогона - флак по времени, не от схемы (green зелёный \
$green_ok из 2, на control падение воспроизводится: $control_fail)"
  else
    verdict FAIL "e2e: падение из полного прогона воспроизводится на green и не воспроизводится \
на control"
  fi
}

# --- Итог ----------------------------------------------------------------------------------
write_result() {
  local out="$WORK/RESULT.md" phase
  {
    echo "# Доказательство отката 021_down.sql и 026_down.sql"
    echo
    echo "Обновлено: $(date -u +%Y-%m-%dT%H:%M:%SZ)," \
      "коммит v2: $(git -C "$ROOT" rev-parse --short HEAD)."
    for phase in db targeted probe full e2e e2e-recheck; do
      [[ -s "$WORK/verdicts-$phase.txt" ]] || continue
      echo
      echo "## Проверки: фаза $phase"
      echo
      sed 's/^/- /' "$WORK/verdicts-$phase.txt"
    done
    if [[ -s "$RESULTS_TSV" ]]; then
      echo
      echo "## Прежний код на трёх схемах"
      echo "(control - до v2, red-021 - после v2 и ТОЛЬКО 026_down, green - после обеих down)"
      echo
      echo "| схема | набор | pass | fail | skip | вывод |"
      echo "|---|---|---|---|---|---|"
      for phase in targeted probe full e2e e2e-recheck; do
        awk -F'\t' -v phase="$phase" '$1 == phase {
          printf "| %s | %s | %s | %s | %s | %s |\n", $2, $3, $4, $5, $6, $7 }' "$RESULTS_TSV"
      done
    fi
  } >"$out"
  log "итог записан: $out"
}

main() {
  want db && phase_db
  want targeted && phase_targeted
  want probe && phase_probe
  want full && phase_full
  want e2e && phase_e2e
  want e2e-recheck && phase_e2e_recheck
  write_result
  echo
  echo "=== Итог ==="
  printf '%s\n' "${SUMMARY[@]}"
  [[ "$FAILS" -eq 0 ]] || { echo "РАСХОЖДЕНИЙ: $FAILS"; exit 1; }
  echo "ВСЁ СОШЛОСЬ"
}

main
