#!/usr/bin/env bash
# Применяет миграции двух потоков; учёт в таблице schema_migrations.
#
#   bash db/migrate.sh            применить всё неприменённое
#   bash db/migrate.sh --plan     показать, что будет применено и почему, ничего не меняя
#   bash db/migrate.sh --list     показать записи schema_migrations
#
# Потоки и порядок: сначала все миграции `platform` (db/platform), затем все `app`
# (APP_MIGRATIONS_DIR); внутри потока - по имени файла. Версия в учёте = `<поток>/<имя>`,
# например `platform/005_workflow_state`.
#
# Совместимость со старым учётом (legacy-map.tsv, строки `старая_версия<TAB>новая_версия`):
# новая версия считается применённой, если в schema_migrations есть она сама или ЛЮБАЯ
# старая версия, отображаемая на неё. Раннер дописывает новые версии рядом со старыми и
# старых записей не удаляет (откат образа и старого раннера остаётся возможным). Старая
# (без префикса потока) версия, которой нет ни в одной карте, - ошибка остановки.
#
# Переменные окружения:
#   DATABASE_URL          строка подключения postgres://... (обязательна; пароль не печатаем)
#   APP_MIGRATIONS_DIR    каталог миграций проекта (поток app); пусто - потока app нет
#   APP_LEGACY_MAP        карта старых версий проекта; по умолчанию
#                         $APP_MIGRATIONS_DIR/legacy-map.tsv, если файл есть
#   PLATFORM_MIGRATIONS_DIR  каталог платформенного потока (по умолчанию db/platform; нужен
#                         тестам)
#   MIGRATE_LEGACY_NAMES  аварийный флаг, по умолчанию 0. 1 - раннер пишет в schema_migrations
#                         только прежние имена версий (без префикса потока), как старый
#                         db/migrate.sh, и не дописывает platform/..., app/...; карты старых
#                         версий по-прежнему решают, что уже применено. Нужен, пока рядом с
#                         новым образом может запускаться прежний раннер. Допустимо 0 или 1.
# Платформенная карта db/platform/legacy-map.tsv читается всегда, если файл есть.
#
# Коды выхода: 0 - успех; 1 - ошибка окружения, карты или миграции; 2 - неверные аргументы;
# 3 - в schema_migrations есть старая версия, которой нет в картах.
set -euo pipefail

# Имена файлов сортируются побайтово, а не по локали: порядок применения одинаков везде.
export LC_COLLATE=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM_DIR="${PLATFORM_MIGRATIONS_DIR:-$HERE/platform}"
APP_DIR="${APP_MIGRATIONS_DIR:-}"
APP_MAP="${APP_LEGACY_MAP:-}"
PLATFORM_MAP="$PLATFORM_DIR/legacy-map.tsv"
MAP_FILE_NAME="legacy-map.tsv"

# Произвольное число для pg_advisory_xact_lock: защита от параллельного запуска.
LOCK_ID=48151623
# Метка, которую psql печатает, когда миграцию под блокировкой уже применил другой процесс.
SKIP_MARK="MIGRATE_ALREADY_APPLIED"
# Коды выхода.
EXIT_FAIL=1
EXIT_USAGE=2
EXIT_UNKNOWN_LEGACY=3
# Допустимый вид имён версий и файлов: они попадают в SQL, поэтому только безопасные знаки.
NAME_RE='^[A-Za-z0-9_.-]+$'
NEW_VERSION_RE='^(platform|app)/[A-Za-z0-9_.-]+$'
# lock_timeout: миграция, ждущая чужую блокировку, падает через 30 с, а не висит вечно
# и не держит за собой очередь запросов приложения (R8). На время выполнения не влияет.
LOCK_TIMEOUT_MS=30000

MODE="apply"
case "${1:-}" in
  "") ;;
  --plan) MODE="plan" ;;
  --list) MODE="list" ;;
  -h | --help)
    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "ОШИБКА: неизвестный аргумент: $1 (допустимо: --plan, --list)" >&2
    exit "$EXIT_USAGE"
    ;;
esac
if [[ $# -gt 1 ]]; then
  echo "ОШИБКА: лишние аргументы (допустим один: --plan или --list)" >&2
  exit "$EXIT_USAGE"
fi

fail() {
  echo "ОШИБКА: $*" >&2
  exit "$EXIT_FAIL"
}

if [[ "${BASH_VERSINFO[0]}" -lt 4 ]]; then
  fail "нужен bash 4 или новее (ассоциативные массивы)"
fi
[[ -n "${DATABASE_URL:-}" ]] || fail "не задана DATABASE_URL"
command -v psql >/dev/null 2>&1 || fail "не найден psql"
[[ -d "$PLATFORM_DIR" ]] || fail "нет каталога платформенных миграций: $PLATFORM_DIR"
# Строгий флаг: опечатка (например, "true") не должна тихо оставить обычный режим.
LEGACY_NAMES="${MIGRATE_LEGACY_NAMES:-0}"
[[ "$LEGACY_NAMES" == "0" || "$LEGACY_NAMES" == "1" ]] \
  || fail "MIGRATE_LEGACY_NAMES: допустимо 0 или 1, получено: $LEGACY_NAMES"
if [[ -n "$APP_DIR" && ! -d "$APP_DIR" ]]; then
  fail "нет каталога миграций проекта (APP_MIGRATIONS_DIR): $APP_DIR"
fi

# PGDATABASE не раскрывает URI, поэтому строка идёт аргументом (виден в ps только
# владельцу процесса); сами команды и строку подключения в лог не пишем.
run_psql() {
  PGOPTIONS="-c client_min_messages=warning -c lock_timeout=${LOCK_TIMEOUT_MS}" \
    psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 "$DATABASE_URL" "$@"
}

# ---- Каталоги потоков ------------------------------------------------------------------

# Упорядоченный список версий (platform, затем app) и файл каждой версии.
declare -a VERSIONS=()
declare -A FILE_OF=()

collect_stream() {
  local stream="$1" dir="$2" file name
  shopt -s nullglob
  for file in "$dir"/*.sql; do
    name="$(basename "$file" .sql)"
    [[ "$name" =~ $NAME_RE ]] || fail "недопустимое имя миграции (только A-Za-z0-9_.-): $file"
    VERSIONS+=("$stream/$name")
    FILE_OF["$stream/$name"]="$file"
  done
  shopt -u nullglob
}

collect_stream platform "$PLATFORM_DIR"
if [[ -n "$APP_DIR" ]]; then
  collect_stream app "$APP_DIR"
fi

# ---- Карты старых версий ---------------------------------------------------------------

# KNOWN_LEGACY[старая]=1 - старая версия описана в какой-либо карте.
declare -A KNOWN_LEGACY=()
# OLDS_FOR[новая] - старые версии через пробел, отображаемые на новую.
declare -A OLDS_FOR=()

load_legacy_map() {
  local map="$1" line_no=0 old new extra
  while IFS=$'\t' read -r old new extra || [[ -n "${old:-}" ]]; do
    line_no=$((line_no + 1))
    old="${old%$'\r'}"
    new="${new%$'\r'}"
    # Пустые строки и комментарии пропускаем.
    if [[ -z "$old" || "$old" == \#* ]]; then
      old=""
      continue
    fi
    [[ -z "${extra:-}" ]] || fail "$map:$line_no: ожидаются два поля через табуляцию"
    [[ -n "$new" ]] || fail "$map:$line_no: нет новой версии (нужно: старая<TAB>новая)"
    [[ "$old" =~ $NAME_RE ]] || fail "$map:$line_no: недопустимая старая версия: $old"
    [[ "$new" =~ $NEW_VERSION_RE ]] \
      || fail "$map:$line_no: новая версия должна быть вида platform/<имя> или app/<имя>: $new"
    [[ -n "${FILE_OF[$new]:-}" ]] \
      || fail "$map:$line_no: в каталоге потока нет миграции $new (опечатка в карте?)"
    KNOWN_LEGACY["$old"]=1
    # Повтор той же пары (платформенная и проектная карта могут совпасть) безвреден.
    if [[ " ${OLDS_FOR[$new]:-} " != *" $old "* ]]; then
      OLDS_FOR["$new"]="${OLDS_FOR[$new]:+${OLDS_FOR[$new]} }$old"
    fi
    old=""
  done <"$map"
}

if [[ -f "$PLATFORM_MAP" ]]; then
  load_legacy_map "$PLATFORM_MAP"
fi
if [[ -z "$APP_MAP" && -n "$APP_DIR" && -f "$APP_DIR/$MAP_FILE_NAME" ]]; then
  APP_MAP="$APP_DIR/$MAP_FILE_NAME"
fi
if [[ -n "$APP_MAP" ]]; then
  [[ -f "$APP_MAP" ]] || fail "нет файла карты старых версий (APP_LEGACY_MAP): $APP_MAP"
  load_legacy_map "$APP_MAP"
fi

# ---- Режим прежних имён (MIGRATE_LEGACY_NAMES=1) ---------------------------------------

# Версии без записи в картах учитываются под именем файла без префикса потока - так их
# записал бы старый раннер. Имя регистрируется как известная старая версия: иначе следующий
# запуск счёл бы собственную запись неизвестной (код 3). Имя не должно совпасть с именем
# другой миграции или старой версией из карты: в плоском учёте прежнего раннера это одна запись.
register_derived_legacy_names() {
  local version name
  declare -A owner=()
  for version in "${VERSIONS[@]}"; do
    [[ -z "${OLDS_FOR[$version]:-}" ]] || continue
    name="${version#*/}"
    if [[ -n "${KNOWN_LEGACY[$name]:-}" || -n "${owner[$name]:-}" ]]; then
      fail "режим MIGRATE_LEGACY_NAMES=1: имя $name совпадает у ${owner[$name]:-карты} и $version"
    fi
    owner["$name"]="$version"
  done
  for name in "${!owner[@]}"; do
    version="${owner[$name]}"
    KNOWN_LEGACY["$name"]=1
    OLDS_FOR["$version"]="$name"
  done
}

# Прежние имена версии для записи: старые версии из карт (и выведенное из файла имя).
legacy_names_of() {
  printf '%s\n' ${OLDS_FOR[$1]}
}

if [[ "$LEGACY_NAMES" == "1" ]]; then
  register_derived_legacy_names
fi

# ---- Учёт в базе -----------------------------------------------------------------------

table_exists() {
  [[ "$(run_psql --tuples-only --no-align -c \
    "SELECT to_regclass('schema_migrations') IS NOT NULL")" == "t" ]]
}

# Создание таблицы под той же блокировкой, что и миграции: два первых запуска на пустой базе
# иначе оба делают CREATE TABLE IF NOT EXISTS и один падает на "already exists".
ensure_table() {
  if table_exists; then
    return
  fi
  echo "Создаю таблицу schema_migrations"
  {
    echo "SELECT pg_advisory_xact_lock($LOCK_ID) \\gset"
    echo "CREATE TABLE IF NOT EXISTS schema_migrations ("
    echo "  version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());"
  } | run_psql --single-transaction --file - >/dev/null
}

declare -A RECORDED=()

load_recorded() {
  RECORDED=()
  table_exists || return 0
  local version
  while IFS= read -r version; do
    [[ -z "$version" ]] || RECORDED["$version"]=1
  done < <(run_psql --tuples-only --no-align -c "SELECT version FROM schema_migrations")
}

# Старая (без префикса потока) версия вне карт - остановка с именами всех таких версий.
check_unknown_legacy() {
  local version unknown=()
  for version in "${!RECORDED[@]}"; do
    [[ "$version" == */* ]] && continue
    [[ -n "${KNOWN_LEGACY[$version]:-}" ]] || unknown+=("$version")
  done
  if [[ "${#unknown[@]}" -gt 0 ]]; then
    {
      echo "ОШИБКА: в schema_migrations есть старые версии, которых нет в картах legacy-map.tsv:"
      printf '  %s\n' "${unknown[@]}" | sort
      echo "Ничего не применено. Добавьте их в карту (старая<TAB>новая) и повторите запуск."
    } >&2
    exit "$EXIT_UNKNOWN_LEGACY"
  fi
}

# Статус версии: applied | applied-by-legacy <старая> | pending.
STATUS=""
STATUS_OLD=""
version_status() {
  local version="$1" old
  STATUS_OLD=""
  if [[ -n "${RECORDED[$version]:-}" ]]; then
    STATUS="applied"
    return
  fi
  for old in ${OLDS_FOR[$version]:-}; do
    if [[ -n "${RECORDED[$old]:-}" ]]; then
      STATUS="applied-by-legacy"
      STATUS_OLD="$old"
      return
    fi
  done
  STATUS="pending"
}

run_plan() {
  local version n_applied=0 n_legacy=0 n_pending=0
  for version in "${VERSIONS[@]}"; do
    version_status "$version"
    case "$STATUS" in
      applied) n_applied=$((n_applied + 1)); echo "applied $version" ;;
      applied-by-legacy)
        n_legacy=$((n_legacy + 1)); echo "applied-by-legacy $STATUS_OLD $version" ;;
      pending) n_pending=$((n_pending + 1)); echo "pending $version" ;;
    esac
  done
  # Записи с префиксом потока, для которых нет файла (образ старее базы): только сведение.
  for version in "${!RECORDED[@]}"; do
    if [[ "$version" == */* && -z "${FILE_OF[$version]:-}" ]]; then
      echo "no-file $version"
    fi
  done | sort
  echo "План: applied $n_applied, applied-by-legacy $n_legacy, pending $n_pending"
}

run_list() {
  if ! table_exists; then
    echo "Таблицы schema_migrations нет"
    return
  fi
  run_psql --tuples-only --no-align --field-separator $'\t' \
    -c "SELECT version, applied_at FROM schema_migrations ORDER BY version"
}

# Дописать новые версии рядом со старыми (одна транзакция, под общей блокировкой).
append_legacy_versions() {
  local version appended=()
  for version in "${VERSIONS[@]}"; do
    version_status "$version"
    if [[ "$STATUS" == "applied-by-legacy" ]]; then
      appended+=("$version")
      echo "Применена по старой версии $STATUS_OLD: $version (дописываю запись)"
    fi
  done
  [[ "${#appended[@]}" -gt 0 ]] || return 0
  {
    echo "SELECT pg_advisory_xact_lock($LOCK_ID) \\gset"
    for version in "${appended[@]}"; do
      echo "INSERT INTO schema_migrations (version) VALUES ('$version') ON CONFLICT DO NOTHING;"
    done
  } | run_psql --single-transaction --file - >/dev/null
  for version in "${appended[@]}"; do
    RECORDED["$version"]=1
  done
}

# Версии, записанные прежними именами в этом запуске: одна старая запись может закрывать
# несколько новых (смешанная миграция), вторая и далее не должна считаться чужим занятием.
declare -A WRITTEN_NOW=()

# Часть SQL занятия версии под блокировкой: печатает WITH claim ... \gset.
claim_sql() {
  local version="$1" name values="" expected=0
  if [[ "$LEGACY_NAMES" == "1" ]]; then
    while IFS= read -r name; do
      values+="${values:+,}('$name')"
      [[ -n "${WRITTEN_NOW[$name]:-}" ]] || expected=$((expected + 1))
    done < <(legacy_names_of "$version")
    echo "WITH claim AS (INSERT INTO schema_migrations (version) VALUES $values"
    echo "  ON CONFLICT DO NOTHING RETURNING 1) SELECT count(*) = $expected AS claimed FROM claim \\gset"
  else
    echo "WITH claim AS (INSERT INTO schema_migrations (version) VALUES ('$version')"
    echo "  ON CONFLICT DO NOTHING RETURNING 1) SELECT count(*) = 1 AS claimed FROM claim \\gset"
  fi
}

apply_one() {
  local version="$1" file="${FILE_OF[$1]}" out name
  echo "Применяю: $version"
  # Одна транзакция: блокировка, затем занятие версии и тело миграции. Проверка "применена
  # ли" сделана ДО блокировки: параллельный запуск мог применить эту же миграцию, пока мы
  # ждали. Поэтому под блокировкой версия занимается заново (ON CONFLICT DO NOTHING): строки
  # нет - миграцию уже применил другой процесс, тело не исполняется (иначе оно прошло бы
  # второй раз, а неидемпотентная миграция, как UPDATE в 011, испортила бы данные, и вставка
  # отметки упала бы на первичном ключе). Отметка в той же транзакции: сбой тела откатывает
  # и её.
  if ! out="$({
    echo "SELECT pg_advisory_xact_lock($LOCK_ID) \\gset"
    claim_sql "$version"
    echo "\\if :claimed"
    cat "$file"
    echo
    echo "\\else"
    echo "\\echo $SKIP_MARK"
    echo "\\endif"
  } | run_psql --single-transaction --file -)"; then
    fail "миграция $version не применена (её изменения откатаны, версия не записана)"
  fi
  if [[ "$out" == *"$SKIP_MARK"* ]]; then
    echo "Уже применена другим процессом: $version"
    return 1
  fi
  [[ -z "$out" ]] || printf '%s\n' "$out"
  if [[ "$LEGACY_NAMES" == "1" ]]; then
    while IFS= read -r name; do
      WRITTEN_NOW["$name"]=1
    done < <(legacy_names_of "$version")
  fi
  return 0
}

run_apply() {
  ensure_table
  load_recorded
  check_unknown_legacy
  local applied=0 version
  if [[ "$LEGACY_NAMES" == "1" ]]; then
    echo "Режим MIGRATE_LEGACY_NAMES=1: в schema_migrations пишутся прежние имена версий"
    # Ожидающие версии определены по состоянию на начало запуска: запись старого имени
    # смешанной миграции не должна скрыть от применения её вторую половину.
    local pending=()
    for version in "${VERSIONS[@]}"; do
      version_status "$version"
      if [[ "$STATUS" == "pending" ]]; then
        pending+=("$version")
      else
        echo "Уже применена: $version"
      fi
    done
    for version in "${pending[@]}"; do
      if apply_one "$version"; then
        applied=$((applied + 1))
      fi
    done
    echo "Готово. Применено новых миграций: $applied"
    return
  fi
  append_legacy_versions
  for version in "${VERSIONS[@]}"; do
    version_status "$version"
    if [[ "$STATUS" == "applied" ]]; then
      echo "Уже применена: $version"
      continue
    fi
    if apply_one "$version"; then
      applied=$((applied + 1))
    fi
  done
  echo "Готово. Применено новых миграций: $applied"
}

case "$MODE" in
  list) run_list ;;
  plan)
    load_recorded
    check_unknown_legacy
    run_plan
    ;;
  apply) run_apply ;;
esac
