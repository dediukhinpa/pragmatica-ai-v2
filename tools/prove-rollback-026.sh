#!/usr/bin/env bash
# Доказательство обратной миграции db/app/rollback/026_down.sql (этап 8, пакет переключения).
#
#   bash tools/prove-rollback-026.sh                  фазы db, targeted, full
#   bash tools/prove-rollback-026.sh db               только проверка схемы и учёта
#   bash tools/prove-rollback-026.sh targeted         целевые тесты базы знаний старого кода
#   bash tools/prove-rollback-026.sh full             полный core-tests-pg старого кода (зелёная)
#   bash tools/prove-rollback-026.sh e2e-knowledge    e2e d-knowledge старого кода на трёх схемах
#   bash tools/prove-rollback-026.sh e2e              полный e2e старого кода на green (~17 минут)
# Фазы targeted/full/e2e берут схемы из дампов, снятых фазой db (db при необходимости идёт сама).
#
# Что доказывает.
#   db: «синтетический бой» - 42 миграции прежнего репозитория (FREEZE_SRC) прежним раннером,
#       вымышленные данные (seed-db.sql этапа 7), pg_dump/pg_restore в новую базу. Затем раннер
#       v2 (--plan: ровно app/026 pending + 45 applied-by-legacy), накатка v2, 026_down.sql:
#       схема, данные и schema_migrations равны состоянию ДО v2; повтор down - без изменений;
#       повторная накатка v2 даёт то же, что первая (цикл вперёд-назад-вперёд). Прежний раннер
#       на базе после v2 (с записями platform/..., app/...) ничего не применяет.
#   targeted/full/e2e: прежний код на трёх схемах: control (до v2), red (после v2 БЕЗ down),
#       green (после v2 + down). Тесты прежнего кода сами строят схему из db/migrations, поэтому
#       в копии tests/adapters/postgres/support.ts (оригинал не трогаем) схема теста берётся
#       клоном шаблонной базы (CREATE DATABASE ... TEMPLATE) из дампа проверяемого состояния;
#       тесты, которым нужна частичная схема (stopBefore), идут по-прежнему.
#
# Postgres: pgvector/pgvector:0.8.6-pg16 на 127.0.0.1:20800 (контейнер bai8-rb026-pg, метка
# bai.stage=8, данные в tmpfs). Работает под flock heavy.lock. Итоги: $WORK/RESULT.md.
# Код выхода: 0 - всё сошлось, 1 - расхождение, 2 - ошибка окружения, 3 - нет ресурсов.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BAI_HOME="${BAI_HOME:-$HOME/reports/business-ai-modular}"
WORK="${WORK:-$BAI_HOME/stage-8/tmp/down-proof}"
LOCK_FILE="$BAI_HOME/heavy.lock"

# --- Константы -----------------------------------------------------------------------------
PG_IMAGE="pgvector/pgvector:0.8.6-pg16"
CONTAINER="bai8-rb026-pg"
STAGE_LABEL="bai.stage=8"
PORT=20800
PG_MEMORY="1g"
PG_TMPFS_SIZE="768m"
PG_READY_TRIES=60
RUNNER_TIMEOUT_SEC=300
TARGETED_TIMEOUT_SEC=540
FULL_TIMEOUT_SEC=2400
E2E_TIMEOUT_SEC=1200
E2E_KNOWLEDGE_TIMEOUT_SEC=600
MIN_DISK_GIB=8
MIN_RAM_MIB=3072
MIB_PER_GIB=1024
RESOURCE_RETRIES=3
RESOURCE_WAIT_SEC="${RESOURCE_WAIT_SEC:-600}"
# Ожидаемые числа плана раннера v2 на базе прежнего раннера (см. задание этапа 8).
EXPECTED_LEGACY_APPLIED=45
EXPECTED_PENDING="app/026_knowledge_scope_compat"
EXPECTED_OLD_MIGRATIONS=42

SRC_REPO="${SRC_REPO:-$HOME/pragmatika-purchasing}"
SRC_COMMIT="${SRC_COMMIT:-5ea7f2d308beb476fb8b6fe05e095587c9ee4f40}"
OLD_WORKTREE="${OLD_WORKTREE:-$HOME/wt-pragmatika-baseline-2}"
SEED_SQL="${SEED_SQL:-$BAI_HOME/stage-7/synth/seed/seed-db.sql}"
BASELINE_TSV="${BASELINE_TSV:-$BAI_HOME/stage-7/baseline-src/tests.tsv}"
APP_DIR="$ROOT/db/app"
DOWN_SQL="$APP_DIR/rollback/026_down.sql"
V2_RUNNER="$ROOT/deploy/platform/db/migrate.sh"
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

cleanup() {
  local rc=$?
  if [[ "$CONTAINER_UP" -eq 1 ]]; then
    docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
    log "контейнер $CONTAINER погашен и удалён"
  fi
  exit "$rc"
}
trap cleanup EXIT

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
[[ "${#PHASES[@]}" -gt 0 ]] || PHASES=(db targeted full)
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

# snapshot <база> <метка>: схема, версии учёта, строки учёта, отпечаток данных каждой таблицы.
snapshot() {
  local db="$1" tag="$2" table
  dump_schema "$db" "$SNAP/$tag.schema.sql"
  sql_val "$db" "SELECT version FROM schema_migrations ORDER BY version COLLATE \"C\"" \
    >"$SNAP/$tag.versions.txt"
  sql_val "$db" "SELECT version || '|' || applied_at FROM schema_migrations
                 WHERE version NOT LIKE '%/%' ORDER BY version COLLATE \"C\"" \
    >"$SNAP/$tag.ledger-old.txt"
  : >"$SNAP/$tag.data.txt"
  while IFS= read -r table; do
    [[ "$table" == "schema_migrations" ]] && continue
    echo "$table|$(sql_val "$db" "SELECT count(*) || '|' || md5(coalesce(string_agg(x::text, E'\n'
      ORDER BY x::text), '')) FROM public.\"$table\" x")" >>"$SNAP/$tag.data.txt"
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
  log "снимок $tag: столбец привязки=$col, knowledge_chunks=$(cat "$SNAP/$tag.knowledge.txt")"
}

# same_snapshot <метка A> <метка B> <что: schema|versions|ledger-old|data|knowledge>
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

# check_plan_before <метка>: ровно app/026 pending и 45 applied-by-legacy.
check_plan_before() {
  local tag="$1" out="$SNAP/plan-${1// /_}.txt" counts pending
  run_runner "$V2_RUNNER" rb_battle "$out" --plan
  counts="$(plan_counts "$out")"
  pending="$(awk '$1 == "pending" {print $2}' "$out" | tr '\n' ' ' | sed 's/ $//')"
  if [[ "$RUNNER_RC" -eq 0 && "$counts" == "0 $EXPECTED_LEGACY_APPLIED 1" \
    && "$pending" == "$EXPECTED_PENDING" ]] && ! grep -q '^no-file' "$out"; then
    verdict OK "--plan ($tag): applied 0, applied-by-legacy $EXPECTED_LEGACY_APPLIED, \
pending 1 ($pending)"
  else
    cat "$out"
    verdict FAIL "--plan ($tag): ожидалось 0/$EXPECTED_LEGACY_APPLIED/1 и $EXPECTED_PENDING, \
получено '$counts' и '$pending'"
  fi
}

# --- Фаза db -------------------------------------------------------------------------------
prepare_old_sources() {
  git -C "$SRC_REPO" cat-file -e "$SRC_COMMIT^{commit}" || die "нет $SRC_COMMIT в $SRC_REPO"
  [[ -f "$SEED_SQL" ]] || die "нет синтетического сида: $SEED_SQL"
  [[ -f "$DOWN_SQL" ]] || die "нет $DOWN_SQL"
  rm -rf "${WORK:?}/old-src"
  mkdir -p "$WORK/old-src" "$SNAP"
  git -C "$SRC_REPO" archive "$SRC_COMMIT" db | tar -x -C "$WORK/old-src"
  OLD_RUNNER="$WORK/old-src/db/migrate.sh"
  local n_old
  n_old="$(find "$WORK/old-src/db/migrations" -name '*.sql' | wc -l)"
  log "старый раннер и миграции из $SRC_COMMIT: $n_old файлов"
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

  # 2. Раннер v2: --plan, накатка, повторная накатка.
  check_plan_before "до v2"
  apply_v2 v2
  cp "$SNAP/v2.schema.sql.raw" "$WORK/schema-red.sql"
  if grep -q 'scope' "$SNAP/v2.schema.sql" && ! same_snapshot before v2 schema; then
    verdict OK "после v2 схема изменилась (knowledge_chunks.scope), стенд различает состояния"
  else
    verdict FAIL "после v2 схема не изменилась: проверка не имеет смысла"
  fi
  # Прежний раннер на базе после v2 (записи platform/..., app/... рядом со старыми).
  drop_db rb_v2_copy
  docker exec "$CONTAINER" psql -U postgres -qc "CREATE DATABASE rb_v2_copy TEMPLATE rb_battle"
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

  # 3. Откат.
  RUNNER_RC=0
  psql_db rb_battle --single-transaction -v ON_ERROR_STOP=1 -f "$DOWN_SQL" \
    >"$SNAP/down.out" 2>&1 || RUNNER_RC=$?
  if [[ "$RUNNER_RC" -ne 0 ]]; then
    cat "$SNAP/down.out"
    verdict FAIL "026_down.sql завершился с кодом $RUNNER_RC"
    return 0
  fi
  verdict OK "026_down.sql выполнен (psql --single-transaction -v ON_ERROR_STOP=1)"
  snapshot rb_battle down
  cp "$SNAP/down.schema.sql.raw" "$WORK/schema-green.sql"
  check_same before down schema "после down схема ИДЕНТИЧНА схеме до v2 (дамп, дифф пуст)"
  check_same before down data "после down данные всех таблиц те же (число строк и md5)"
  check_same before down knowledge "после down knowledge_chunks те же (включая fts и эмбеддинги)"
  check_same before down versions "после down множество version в учёте совпало побайтно"
  check_same before down ledger-old "после down прежние записи учёта (версия и время) не тронуты"

  # 4. Повтор down: без ошибок и без изменений.
  RUNNER_RC=0
  # Повтор идёт через stdin, как в rollback.sh пакета переключения (psql -f -).
  psql_db rb_battle --single-transaction -v ON_ERROR_STOP=1 -f - <"$DOWN_SQL" \
    >"$SNAP/down2.out" 2>&1 || RUNNER_RC=$?
  snapshot rb_battle down2
  if [[ "$RUNNER_RC" -eq 0 ]] && same_snapshot down down2 schema \
    && same_snapshot down down2 versions && same_snapshot down down2 data; then
    verdict OK "повторный запуск 026_down.sql: rc=0, схема, учёт и данные без изменений"
  else
    cat "$SNAP/down2.out"
    verdict FAIL "повторный запуск 026_down.sql изменил состояние или упал (rc=$RUNNER_RC)"
  fi

  # 5. Вперёд снова: 026 pending, затем схема = первой накатке.
  check_plan_before "после down"
  apply_v2 v2b
  check_same v2 v2b schema "цикл вперёд-назад-вперёд: схема второй накатки = первой"
  check_same v2 v2b versions "цикл вперёд-назад-вперёд: учёт второй накатки = первой"
  check_same v2 v2b knowledge "цикл вперёд-назад-вперёд: knowledge_chunks без потерь"
  check_same before v2b data "цикл вперёд-назад-вперёд: данные всех таблиц те же, что до v2"

  # 6. Наблюдение: SQL-пробы на трёх состояниях (до v2 / после v2 / после down).
  probe_states
}

# apply_v2 <метка>: накатка раннером v2 дважды (второй раз - 0), снимок.
apply_v2() {
  local tag="$1" n1 n2
  run_runner "$V2_RUNNER" rb_battle "$SNAP/$tag.apply1.out"
  n1="$(applied_count "$SNAP/$tag.apply1.out")"
  if [[ "$RUNNER_RC" -ne 0 ]]; then
    tail -n 15 "$SNAP/$tag.apply1.out"
    verdict FAIL "раннер v2: rc=$RUNNER_RC"
    return 0
  fi
  run_runner "$V2_RUNNER" rb_battle "$SNAP/$tag.apply2.out"
  n2="$(applied_count "$SNAP/$tag.apply2.out")"
  if [[ "${n1:-x}" == "1" && "${n2:-x}" == "0" && "$RUNNER_RC" -eq 0 ]]; then
    verdict OK "раннер v2 ($tag): применил ${n1} (026), повтор - 0"
  else
    verdict FAIL "раннер v2 ($tag): применено ${n1:-?} и ${n2:-?}, ожидалось 1 и 0"
  fi
  snapshot rb_battle "$tag"
}

# Пробы на уровне SQL: что видит прежний код в каждом состоянии. Для каждой пробы - код и первая
# строка ошибки; сравниваются control и green (должны совпасть), red различается.
PROBE_QUERY_TEXT="Тестовый фрагмент условия поставки"
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
  esac
}
PROBE_COUNT=8

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
}

probe_states() {
  # Состояния: до v2 (rb_legacy), после v2 (копия rb_battle в состоянии v2b), после down.
  run_probes rb_legacy "$SNAP/probes-control.txt"
  run_probes rb_battle "$SNAP/probes-red.txt"
  # green: копия базы, откатанная down (rb_battle сейчас в состоянии v2b, down повторяем на копии).
  drop_db rb_green_copy
  docker exec "$CONTAINER" psql -U postgres -qc "CREATE DATABASE rb_green_copy TEMPLATE rb_battle"
  psql_db rb_green_copy --single-transaction -v ON_ERROR_STOP=1 -f "$DOWN_SQL" >/dev/null 2>&1 \
    || verdict FAIL "down на копии для проб не выполнился"
  run_probes rb_green_copy "$SNAP/probes-green.txt"
  drop_db rb_green_copy
  if cmp -s "$SNAP/probes-control.txt" "$SNAP/probes-green.txt"; then
    verdict OK "SQL-пробы прежнего кода: green идентичны control (запись, чтение, \
filter_supplier, функции)"
  else
    diff "$SNAP/probes-control.txt" "$SNAP/probes-green.txt" || true
    verdict FAIL "SQL-пробы: green отличается от control"
  fi
  if grep -q 'ОШИБКА' "$SNAP/probes-red.txt" && ! grep -q 'ОШИБКА' "$SNAP/probes-control.txt"; then
    verdict OK "SQL-пробы: без down (red) прежний код ломается, на control ошибок нет"
  else
    verdict FAIL "SQL-пробы: red не отличается от control"
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
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$CUR_PHASE" "$1" "$2" "$pass" "$fail" "$skip" \
    "$4" >>"$RESULTS_TSV"
}

# Файлы Postgres-тестов, затрагивающие базу знаний (grep по задаче этапа 8).
targeted_files() {
  (cd "$CODE_DIR/core" \
    && grep -rlE 'describePostgres|createIsolatedClient|TEST_DATABASE_URL' tests \
       | xargs grep -lE 'knowledge|hybrid_search|filter_supplier|knowledge-search' \
       | grep -v 'tests/adapters/postgres/support.ts' | sort)
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
  log "=== Фаза targeted: целевые тесты базы знаний на трёх схемах ==="
  ensure_runtime
  local -a files
  mapfile -t files < <(targeted_files)
  printf '%s\n' "${files[@]}" >"$WORK/targeted-files.txt"
  local label="целевые (${#files[@]} файлов)"
  log "целевых файлов: ${#files[@]} (список: $WORK/targeted-files.txt)"
  local s unknown
  for s in "${SCHEMAS[@]}"; do
    bun_run "$s" targeted "$TARGETED_TIMEOUT_SEC" "${files[@]}"
  done
  # control и green: зелёные, кроме падений, которые есть и в эталоне stage-7 (не от схемы).
  for s in control green; do
    unknown="$(unknown_failures "$WORK/fails-targeted-$s.txt" 2>"$WORK/unknown-targeted-$s.txt")"
    if [[ "$unknown" == "0" ]]; then
      verdict OK "целевые тесты на схеме $s: все падения (если есть) - известные падения эталона"
    else
      verdict FAIL "целевые тесты на схеме $s: $unknown падений вне списка эталона \
($WORK/unknown-targeted-$s.txt)"
    fi
  done
  # Флак эталона на одном из прогонов (hybrid_search 015 против 017) допустим; новых падений нет.
  local green_only
  green_only="$(comm -13 "$WORK/fails-targeted-control.txt" "$WORK/fails-targeted-green.txt")"
  if [[ -z "$green_only" ]]; then
    verdict OK "целевые тесты: на green нет падений, которых нет на control"
  else
    verdict FAIL "целевые тесты: на green есть падения, которых нет на control"
  fi
  # red: упавшие, которых нет на control, и причина в supplier_id.
  comm -13 "$WORK/fails-targeted-control.txt" "$WORK/fails-targeted-red.txt" \
    >"$WORK/fails-targeted-red-only.txt" || true
  grep -hE 'error: column "supplier_id"|PostgresError: column "supplier_id"' \
    "$WORK/bun-targeted-red.log" | sort | uniq -c | sort -rn >"$WORK/red-errors.txt" || true
  if [[ -s "$WORK/fails-targeted-red-only.txt" && -s "$WORK/red-errors.txt" ]]; then
    verdict OK "целевые тесты на схеме red: $(wc -l <"$WORK/fails-targeted-red-only.txt") новых \
падений, ошибка: $(head -n 1 "$WORK/red-errors.txt" | sed 's/^ *[0-9]* //')"
  else
    verdict FAIL "целевые тесты на схеме red не покраснели (падений сверх control: 0)"
  fi
  local n_ctl n_red n_grn
  n_ctl="$(wc -l <"$WORK/fails-targeted-control.txt")"
  n_red="$(wc -l <"$WORK/fails-targeted-red-only.txt")"
  n_grn="$(wc -l <"$WORK/fails-targeted-green.txt")"
  record control "$label" targeted "зелёные, кроме известных падений эталона ($n_ctl, в т.ч. флак)"
  record red "$label" targeted "КРАСНЫЕ: +$n_red падений, column supplier_id does not exist"
  record green "$label" targeted "как control: только известные падения эталона ($n_grn)"
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
# Порты e2e внутри 20800-20849 (шаг 5: тесты берут PSEUDO+1 и VISION+1, +2).
E2E_PG_PORT=20810
E2E_PSEUDO_PORT=20815
E2E_DOCS_PORT=20820
E2E_EMBED_PORT=20825
E2E_GUARD_PORT=20830
E2E_LLM_PORT=20835
E2E_VISION_PORT=20840
# Короткий каталог данных e2e: путь unix-сокета песочницы (sandbox.sock) не длиннее 108 знаков.
E2E_TMP_BASE_DIR="${E2E_TMP_BASE_DIR:-$BAI_HOME/stage-8/tmp/rb-e2e}"

# Ведомость учёта состояния для e2e: версии из снимка (по схеме control/red/green).
ledger_tag() { case "$1" in control) echo before ;; red) echo v2 ;; green) echo down ;; esac; }

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
# Подмена на стенде rollback 026: при первом запуске в пустой базе грузит схему состояния
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
  [[ -d "$CODE_DIR/e2e" ]] || prepare_old_code
}

# e2e-knowledge: сценарий d-knowledge (индексатор пишет knowledge_chunks) на трёх схемах.
phase_e2e_knowledge() {
  begin_phase e2e-knowledge
  log "=== Фаза e2e-knowledge: d-knowledge на трёх схемах ==="
  e2e_prepare
  local s
  for s in "${SCHEMAS[@]}"; do
    e2e_run "$s" e2e-d "$E2E_KNOWLEDGE_TIMEOUT_SEC" tests/d-knowledge.test.ts
    record "$s" "e2e d-knowledge" e2e-d "rc=$BUN_RC"
    case "$s" in
      red)
        if [[ "$BUN_FAIL" -gt 0 || "$BUN_RC" -ne 0 ]]; then
          verdict OK "e2e d-knowledge на red: красный (fail=$BUN_FAIL, rc=$BUN_RC)"
        else
          verdict FAIL "e2e d-knowledge на red не покраснел"
        fi ;;
      *)
        if [[ "$BUN_FAIL" -eq 0 && "$BUN_RC" -eq 0 && "$BUN_PASS" -gt 0 ]]; then
          verdict OK "e2e d-knowledge на $s: зелёный (pass=$BUN_PASS)"
        else
          verdict FAIL "e2e d-knowledge на $s не зелёный (fail=$BUN_FAIL, rc=$BUN_RC)"
        fi ;;
    esac
  done
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

# --- Итог ----------------------------------------------------------------------------------
write_result() {
  local out="$WORK/RESULT.md" phase
  {
    echo "# Доказательство отката 026_down.sql"
    echo
    echo "Обновлено: $(date -u +%Y-%m-%dT%H:%M:%SZ)," \
      "коммит v2: $(git -C "$ROOT" rev-parse --short HEAD)."
    for phase in db targeted full e2e-knowledge e2e; do
      [[ -s "$WORK/verdicts-$phase.txt" ]] || continue
      echo
      echo "## Проверки: фаза $phase"
      echo
      sed 's/^/- /' "$WORK/verdicts-$phase.txt"
    done
    if [[ -s "$RESULTS_TSV" ]]; then
      echo
      echo "## Прежний код на трёх схемах"
      echo "(control - до v2, red - после v2 без отката, green - после v2 и отката)"
      echo
      echo "| схема | набор | pass | fail | skip | вывод |"
      echo "|---|---|---|---|---|---|"
      for phase in targeted full e2e-knowledge e2e; do
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
  want full && phase_full
  want e2e-knowledge && phase_e2e_knowledge
  want e2e && phase_e2e
  write_result
  echo
  echo "=== Итог ==="
  printf '%s\n' "${SUMMARY[@]}"
  [[ "$FAILS" -eq 0 ]] || { echo "РАСХОЖДЕНИЙ: $FAILS"; exit 1; }
  echo "ВСЁ СОШЛОСЬ"
}

main
