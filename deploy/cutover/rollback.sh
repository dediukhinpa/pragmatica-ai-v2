#!/usr/bin/env bash
# Откат переключения на v2: вернуть бой на прежние образы (КРАСНАЯ ЗОНА, запускает владелец;
# cutover.sh вызывает его сам при любом сбое после начала изменений).
#
# Использование:
#   bash rollback.sh [--run-dir КАТАЛОГ] [--restore-db --i-understand-data-loss] [--auto]
#                    [--help]
#   --run-dir   каталог запуска cutover.sh (по умолчанию ~/.pragmatika-cutover/latest)
#   --restore-db   вместо обратной миграции восстановить БД и хранилище псевдонимизатора из
#                  бэкапа ДО переключения: все данные, записанные после переключения, будут
#                  отрезаны от рабочей базы (прежняя БД сохраняется под именем
#                  <БД>_after_v2_<время>, пока её не удалят вручную)
#   --auto      вызов из cutover.sh (только для журнала)
#
# Что делает (обычный откат, без --restore-db):
#   1. Убирает контейнеры v2 (тома, образы и сети не трогает).
#   2. Если миграции v2 начинались: поднимает прежний postgres и применяет
#      db/app/rollback/026_down.sql одной транзакцией (столбец scope -> supplier_id, функции
#      поиска прежней редакции, записи schema_migrations v2 удаляются). Новые миграции v2
#      платформенных изменений не вносят, поэтому старый код после этого работает на своей схеме.
#   3. Поднимает прежний стек старым compose из образов, которые лежат локально
#      (`up -d --no-build`: образы cutover.sh не удаляет).
#   4. Проверяет: набор контейнеров и образы как до переключения, /ready 200, ботов не меньше,
#      схема знаний прежняя, записей schema_migrations с префиксом потока нет.
# Коды выхода: 0 - бой на прежнем стеке и проверен; 1 - откат выполнен, но проверки не прошли;
# 2 - неверный вызов; 4 - откат не удался (ручное вмешательство).
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HERE/stack/deploy/compose.yml" ]]; then
  STACK="$HERE/stack"
else
  STACK="$(cd "$HERE/../.." && pwd)"
fi
# shellcheck source=lib.sh
source "$HERE/lib.sh"

RUN_DIR_ARG=""
RESTORE_DB=0
CONFIRM_LOSS=0
AUTO=0
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
while (($#)); do
  case "$1" in
    --run-dir) RUN_DIR_ARG="${2:?--run-dir КАТАЛОГ}"; shift ;;
    --restore-db) RESTORE_DB=1 ;;
    --i-understand-data-loss) CONFIRM_LOSS=1 ;;
    --auto) AUTO=1 ;;
    --help | -h) usage; exit "$EXIT_OK" ;;
    *) echo "неизвестный аргумент: $1" >&2; usage >&2; exit "$EXIT_USAGE" ;;
  esac
  shift
done

RUN_DIR_ARG="${RUN_DIR_ARG:-${CUTOVER_HOME:-$HOME/.pragmatika-cutover}/latest}"
[[ -d "$RUN_DIR_ARG" ]] || { echo "нет каталога запуска: $RUN_DIR_ARG" >&2; exit "$EXIT_USAGE"; }
RUN_DIR_ARG="$(cd "$RUN_DIR_ARG" && pwd -P)"
[[ -f "$RUN_DIR_ARG/cutover.conf" ]] \
  || { echo "в $RUN_DIR_ARG нет cutover.conf: не каталог запуска cutover.sh" >&2
       exit "$EXIT_USAGE"; }
if ((RESTORE_DB && !CONFIRM_LOSS)); then
  echo "ПРЕДУПРЕЖДЕНИЕ: --restore-db вернёт БД и хранилище псевдонимизатора на момент ДО" >&2
  echo "переключения: всё, что записано после, будет отрезано от рабочей базы." >&2
  echo "Если это нужно, повторите с --i-understand-data-loss." >&2
  exit "$EXIT_USAGE"
fi
# Настройка запуска cutover.sh; значения окружения вызова сильнее (стенды проверки).
cut_load_config "$RUN_DIR_ARG/cutover.conf"
cut_defaults

cut_init_run "$RUN_DIR_ARG"
LOG_FILE="$RES/rollback.log"
CHECKS_FILE="$RES/rollback-checks.tsv"
touch "$LOG_FILE" "$CHECKS_FILE"
ROLLBACK_ID="$(date -u +%Y%m%dT%H%M%SZ)"
FAILED_CHECKS=0
check_rb() { # обёртка: считает провалы
  check "$@"
  [[ "$2" != fail ]] || FAILED_CHECKS=$((FAILED_CHECKS + 1))
}

PG_USER="$(env_value "$CUTOVER_ENV_FILE" POSTGRES_USER)"
PG_DB="$(env_value "$CUTOVER_ENV_FILE" POSTGRES_DB)"
PG_USER="${PG_USER:-pragmatika}"
PG_DB="${PG_DB:-pragmatika}"
BACKUP_DIR="$(state_get BACKUP_DIR)"
DOWN_SQL="$STACK/db/app/rollback/026_down.sql"
[[ -f "$DOWN_SQL" ]] || DOWN_SQL="$CUTOVER_NEW_DIR/db/app/rollback/026_down.sql"
STOP_TIMEOUT_S=120

stuck() { # stuck <сообщение>: откат не удался
  log "ОТКАТ НЕ УДАЛСЯ: $*"
  state_set ROLLBACK_RESULT "STUCK: $*"
  exit "$EXIT_STUCK"
}

# Секреты в журнал не попадают: список значений собирается как в cutover.sh.
collect_secrets() {
  local file
  for file in "$CUTOVER_ENV_FILE" "$CUTOVER_SECRETS_DIR/secrets.env"; do
    [[ -f "$file" ]] || continue
    python3 -I - "$file" "$MIN_SECRET_LEN" >>"$SECRETS_LIST" <<'PY'
import re, sys
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    if "=" not in line or line.lstrip().startswith("#"):
        continue
    name, raw = line.split("=", 1)
    value = raw.strip().strip("'\"")
    if re.search(r"(KEY|TOKEN|PASSWORD|SECRET)", name) and len(value) >= int(sys.argv[2]):
        print(value)
PY
  done
}

psql_old() { # psql_old <аргументы psql>: прежний postgres, БД боя
  docker exec -i "$CUTOVER_PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 "$@"
}

# 1. Убрать контейнеры проекта (v2 и остатки прежних). Тома, образы, сети остаются.
remove_project_containers() {
  phase "откат: убираю контейнеры проекта $CUTOVER_PROJECT"
  local names name
  mapfile -t names < <(project_containers)
  for name in "${names[@]}"; do
    docker stop -t "$STOP_TIMEOUT_S" "$name" >>"$LOG_FILE" 2>&1 || true
  done
  for name in "${names[@]}"; do docker rm "$name" >>"$LOG_FILE" 2>&1 || true; done
  log "убрано контейнеров: ${#names[@]}"
}

start_old_postgres() {
  dc_old up -d --no-build postgres >>"$LOG_FILE" 2>&1 || stuck "не поднялся прежний postgres"
  wait_healthy "$CUTOVER_PG_CONTAINER" "$HEALTH_WAIT_S" \
    || stuck "прежний postgres не стал healthy за ${HEALTH_WAIT_S} с"
}

# 2a. Обратная миграция: схема знаний и учёт миграций возвращаются к виду до v2.
apply_down() {
  phase "откат БД: 026_down.sql"
  [[ -f "$DOWN_SQL" ]] || stuck "нет файла $DOWN_SQL"
  if psql_old --single-transaction -f - <"$DOWN_SQL" >"$RES/rollback-026-down.txt" 2>&1; then
    check_rb "обратная миграция 026" ok "применена одной транзакцией"
  else
    tail -n 8 "$RES/rollback-026-down.txt" | cut_redact >>"$LOG_FILE"
    stuck "026_down.sql не применился (rollback-026-down.txt)"
  fi
}

# 2b. Восстановление из бэкапа до переключения (потеря данных после переключения).
restore_from_backup() {
  phase "откат БД и хранилища из бэкапа $BACKUP_DIR"
  local stamp restore_db image
  [[ -n "$BACKUP_DIR" && -f "$BACKUP_DIR/db.dump" ]] || stuck "нет $BACKUP_DIR/db.dump"
  (cd "$BACKUP_DIR" && sha256sum -c --quiet db.dump.sha256) >>"$LOG_FILE" 2>&1 \
    || stuck "контрольная сумма db.dump не сошлась"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  restore_db="${PG_DB}_restore_$stamp"
  # Восстановление в новую БД, затем переименование: прежняя (после v2) сохраняется.
  docker exec "$CUTOVER_PG_CONTAINER" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$restore_db\" TEMPLATE template0" >>"$LOG_FILE" 2>&1 \
    || stuck "не создана БД $restore_db"
  docker exec -i "$CUTOVER_PG_CONTAINER" pg_restore -U "$PG_USER" -d "$restore_db" --no-owner \
    --exit-on-error <"$BACKUP_DIR/db.dump" >>"$LOG_FILE" 2>&1 || stuck "pg_restore не удался"
  docker exec "$CUTOVER_PG_CONTAINER" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$PG_DB'" \
    -c "ALTER DATABASE \"$PG_DB\" RENAME TO \"${PG_DB}_after_v2_$stamp\"" \
    -c "ALTER DATABASE \"$restore_db\" RENAME TO \"$PG_DB\"" >>"$LOG_FILE" 2>&1 \
    || stuck "не переименованы базы после восстановления"
  state_set DB_AFTER_V2_NAME "${PG_DB}_after_v2_$stamp"
  check_rb "восстановление БД из бэкапа" ok \
    "БД восстановлена; данные после переключения - в ${PG_DB}_after_v2_$stamp"
  [[ -f "$BACKUP_DIR/pseudonymizer-data.tgz" ]] || stuck "нет архива тома псевдонимизатора"
  image="$(lock_value "$CUTOVER_NEW_DIR/deploy/images.lock" BAI_IMAGE_POSTGRES)"
  # Текущее содержимое тома сохраняется рядом, затем том очищается и распаковывается архив.
  docker run --rm --network none --user 0:0 -v "$CUTOVER_PSEUDO_VOLUME:/data" \
    -v "$BACKUP_DIR:/bk" --entrypoint sh "$image" -c \
    'tar -czf /bk/pseudonymizer-data-after-v2.tgz -C /data . \
&& find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + \
&& tar -xzf /bk/pseudonymizer-data.tgz -C /data' >>"$LOG_FILE" 2>&1 \
    || stuck "не восстановлен том $CUTOVER_PSEUDO_VOLUME"
  check_rb "восстановление хранилища псевдонимизатора" ok "том возвращён на момент до переключения"
}

# 3. Прежний стек из локальных образов.
start_old_stack() {
  phase "откат: прежний стек из локальных образов"
  dc_old up -d --no-build >>"$LOG_FILE" 2>&1 || stuck "прежний compose up не удался"
  local name
  while read -r name; do
    wait_healthy "$name" "$HEALTH_WAIT_S" \
      || { check_rb "прежний контейнер $name" fail "не стал healthy"; continue; }
  done < <(project_containers)
}

# 4. Проверки состояния после отката.
verify_old() {
  phase "откат: проверки"
  local before now missing bots count want got name
  before="$(cut -f1 "$RUN_DIR/results/containers-before.tsv" 2>/dev/null | sort || true)"
  now="$(project_containers)"
  missing="$(comm -23 <(printf '%s\n' "$before") <(printf '%s\n' "$now") | tr '\n' ' ')"
  if [[ -z "${before//[$'\n ']/}" ]]; then
    check_rb "набор контейнеров" warn "снимка до переключения нет"
  elif [[ -n "${missing// /}" ]]; then
    check_rb "набор контейнеров" fail "нет контейнеров, которые были до переключения: $missing"
  else
    check_rb "набор контейнеров" ok "все контейнеры до переключения на месте"
  fi
  # Образы: id образа каждого контейнера равен записанному до переключения.
  if [[ -f "$RUN_DIR/results/containers-before.tsv" ]]; then
    while IFS=$'\t' read -r name _ _ _ _ want _; do
      got="$(docker inspect -f '{{.Image}}' "$name" 2>/dev/null || echo отсутствует)"
      if [[ "$got" != "$want" ]]; then
        check_rb "образ $name" fail "после отката $got, до переключения $want"
      fi
    done <"$RUN_DIR/results/containers-before.tsv"
    check_rb "образы после отката" ok "сверены с записанными до переключения"
  fi
  if ready_wait "$CUTOVER_APP_CONTAINER" "$READY_WAIT_S"; then
    bots="$(ready_bots "$READY_BODY")"
    if ((bots >= CUTOVER_EXPECT_BOTS)); then
      check_rb "/ready прежнего стека" ok "200, ботов $bots"
    else
      check_rb "/ready прежнего стека" fail "200, но ботов $bots (нужно $CUTOVER_EXPECT_BOTS)"
    fi
  else
    check_rb "/ready прежнего стека" fail "не 200 за ${READY_WAIT_S} с: ${READY_BODY:0:120}"
  fi
  count="$(psql_old -Atc "SELECT count(*) FROM information_schema.columns WHERE
    table_name = 'knowledge_chunks' AND column_name = 'supplier_id'" 2>/dev/null || echo ?)"
  [[ "$count" == 1 ]] \
    && check_rb "схема знаний" ok "knowledge_chunks.supplier_id на месте" \
    || check_rb "схема знаний" fail "knowledge_chunks.supplier_id не найден ($count)"
  count="$(psql_old -Atc "SELECT count(*) FROM schema_migrations WHERE version LIKE '%/%'" \
    2>/dev/null || echo ?)"
  [[ "$count" == 0 ]] \
    && check_rb "schema_migrations" ok "записей с префиксом потока нет, как до переключения" \
    || check_rb "schema_migrations" fail "записей с префиксом потока: $count"
}

main() {
  collect_secrets
  log "rollback.sh: каталог запуска $RUN_DIR, вызов из cutover.sh: $AUTO, режим" \
    "$([[ $RESTORE_DB == 1 ]] && echo 'с восстановлением БД' || echo 'обратная миграция')"
  state_set ROLLBACK_STARTED "$ROLLBACK_ID"
  if [[ "$(state_get V2_STARTED)" == 1 || $RESTORE_DB == 1 ]]; then
    remove_project_containers
  fi
  if [[ "$(state_get DB_MIGRATE_STARTED)" == 1 || $RESTORE_DB == 1 ]]; then
    start_old_postgres
    if ((RESTORE_DB)); then restore_from_backup; else apply_down; fi
  fi
  start_old_stack
  verify_old
  if ((FAILED_CHECKS > 0)); then
    state_set ROLLBACK_RESULT "CHECKS_FAILED: $FAILED_CHECKS"
    log "откат выполнен, но проверок не прошло: $FAILED_CHECKS (rollback-checks.tsv)"
    exit "$EXIT_FAILED"
  fi
  state_set ROLLBACK_RESULT OK
  log "ОТКАТ ВЫПОЛНЕН: бой на прежних образах, проверки прошли"
}
main
