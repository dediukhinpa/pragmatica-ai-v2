#!/usr/bin/env bash
# Репетиция переезда Прагматики на v2 рядом с боем. Бой не трогает: читает его БД, хранилище
# псевдонимизатора и каталоги настроек, а всё остальное делает в отдельном compose-проекте
# `pragmatika-rehearsal` (свои контейнеры, тома и сети, без опубликованных портов).
#
# Использование:
#   bash rehearse.sh [--battle-config ФАЙЛ] [--age-identity ФАЙЛ] [--backup-sh]
#                    [--lock ФАЙЛ] [--images-tar ФАЙЛ] [--out-dir КАТАЛОГ] [--keep]
#                    [--preflight-only] [--help]
#
# Что делает (режим «лёгкий»: postgres, миграции, pseudonymizer, app без каналов, заглушка
# шлюза моделей):
#   1. предусловия: память, диск, docker compose, образы по digest из images.lock; нехватка -
#      отказ с кодом 3, бой не тронут;
#   2. снимок боевых контейнеров (в конце сверяется: бой не менялся);
#   3. рабочий дамп БД: pg_dump с чтением из боевого контейнера. Штатный бэкап боя
#      deploy/scripts/backup.sh (с загрузкой в S3 по боевому .env) идёт ТОЛЬКО с явным
#      --backup-sh; если дан и закрытый ключ age, дамп берётся из архива этого бэкапа;
#   4. восстановление в Postgres репетиции, `migrate --plan`, применение, сравнение схемы с
#      ожидаемой схемой v2;
#   5. копия тома хранилища псевдонимизатора, самопроверка хранилища (без значений), старт
#      псевдонимизатора v2, проверка маскирования и восстановления на выдуманном тексте;
#   6. старт app с пустыми каналами и заглушкой шлюза: /ready, 4 агента, журнал без ошибок;
#   7. пики памяти контейнеров против mem_limit;
#   8. уборка проекта репетиции (контейнеры, тома, рабочие копии дампа) и архив результатов
#      ~/rehearsal-<время>.tgz без данных БД.
# Секреты и значения данных в журнал и архив не попадают (проверяется перед упаковкой).
#
# Коды выхода: 0 - все проверки прошли; 1 - есть проваленные проверки (архив создан);
# 2 - неверный вызов; 3 - отказ по предусловиям (бой не тронут); 4 - сбой хода репетиции.
set -euo pipefail
umask 077

# ---------------------------------------------------------------------------------------------
# Константы
# ---------------------------------------------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HERE/stack/deploy/rehearsal/compose.yml" ]]; then
  STACK="$HERE/stack" # пакет репетиции
else
  STACK="$(cd "$HERE/../.." && pwd)" # дерево проекта v2
fi
REH_DIR="$STACK/deploy/rehearsal"
# Копии каталогов хоста боя, владелец копий, проверка чтения (см. заголовок файла).
# shellcheck source=rehearse-files.sh
source "$REH_DIR/rehearse-files.sh"
PROJECT="pragmatika-rehearsal"
EXIT_OK=0 EXIT_CHECKS=1 EXIT_USAGE=2 EXIT_REFUSED=3 EXIT_FAILED=4
EXPECTED_AGENTS=4
EXPECTED_AGENT_NAMES="prices documents order-calc site-export"
# Умолчание compose v2 для DOCUMENTS_HOST_DIR (compose.project.yml).
DEFAULT_DOCUMENTS_DIR="/srv/pragmatika/documents"
MIB=1024
KIB_PER_MIB=1024
# Свободная память хоста: лимит postgres репетиции 3g + app, pseudonymizer, заглушка (~1 ГиБ).
DEFAULT_MIN_AVAILABLE_MIB=4096
DEFAULT_MIN_DISK_MIB=6144
DISK_FACTOR_FOR_DB=3
HEALTH_WAIT_S=240
READY_WAIT_S=180
POLL_S=3
SAMPLE_INTERVAL_S=3
SETTLE_S=20
PG_USER_DEFAULT="pragmatika"
PG_DB_DEFAULT="pragmatika"
# uid:gid процесса псевдонимизатора; при старте уточняются по образу (reh_image_ids).
PSEUDO_UID=10001
PSEUDO_GID=10001
SECRET_BYTES=24
FAILURE_LOG_LINES=20
PG_LOG_TAIL_LINES=400
DMESG_LINES=20
SMOKE_THREAD="rehearsal-smoke"
SMOKE_TEXT="Контакт для проверки: rehearsal.smoke@example.org"
# Шаблоны docker inspect и запросов, вынесенные ради длины строк.
INSPECT_BATTLE_FORMAT='{{.Name}} {{.Id}} {{.State.Status}} {{.State.StartedAt}}'
INSPECT_BATTLE_FORMAT+=' {{.RestartCount}} {{.Image}}'
HEALTH_FORMAT='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'
EXTENSIONS_SQL="SELECT string_agg(extname || ' ' || extversion, ', ' ORDER BY extname)"
EXTENSIONS_SQL+=" FROM pg_extension"
# Роли боя - только имена (без системных pg_*); запрос идёт в транзакции только для чтения.
ROLES_SQL="SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname"
READ_ONLY_PGOPTIONS='-c default_transaction_read_only=on'
# Число объектов с правами (ACL) вне системных схем: сверка боя и копии.
ACL_COUNT_SQL="SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
ACL_COUNT_SQL+=" WHERE c.relacl IS NOT NULL AND n.nspname NOT IN"
ACL_COUNT_SQL+=" ('pg_catalog', 'information_schema', 'pg_toast')"
COUNT_UNKNOWN_PY='import json, sys; print(len(json.load(open(sys.argv[1]))["unknown_to_v2"]))'
COUNT_RETIRED_PY='import json, sys; print(len(json.load(open(sys.argv[1]))["retired_known"]))'
APP_STATE_FORMAT='статус={{.State.Status}} код_выхода={{.State.ExitCode}}'
APP_STATE_FORMAT+=' OOM={{.State.OOMKilled}} перезапусков={{.RestartCount}}'
APP_STATE_FORMAT+=' ошибка={{.State.Error}}'
# Что app читает при старте и работе (пути внутри контейнера, как в overlay). `@ИМЯ` - путь в
# переменной окружения (ядро читает файл при старте и падает, если он не читается).
APP_PATH_VARS=(@ACCESS_POLICY_FILE @MODEL_PRICES_FILE)
APP_MOUNT_PATHS=(/etc/pragmatika/access /etc/pragmatika/mail /srv/documents /srv/templates
  /opt/pragmatika/local /var/lib/pragmatika/intake /var/lib/pragmatika/spool
  /var/lib/pragmatika/exchange)
# Проверки из ОДНОРАЗОВОГО контейнера (образ app, bun) в сети репетиции: отказ или перезапуск app
# не должен скрывать результат проверки псевдонимизатора (попытка 3 G6: три проверки упали
# только из-за `docker exec` в перезапускающийся app).
READY_JS="try {
  const r = await fetch('http://127.0.0.1:8088/ready');
  console.log(r.status + ' ' + (await r.text()));
  process.exit(r.ok ? 0 : 1);
} catch (e) { console.log('app недоступен: ' + e.message); process.exit(1); }"
HEALTH_JS="try {
  const r = await fetch('http://pseudonymizer:8300/health');
  console.log(r.status + ' ' + (await r.text()));
} catch (e) { console.log('недоступен: ' + e.message); }"
SMOKE_JS='const base = "http://pseudonymizer:8300";
const h = {
  authorization: "Bearer " + process.env.PSEUDONYMIZER_API_TOKEN,
  "content-type": "application/json",
};
const post = async (path, body) => (await fetch(base + path, {
  method: "POST", headers: h, body: JSON.stringify(body),
})).json();
const text = process.env.SMOKE_TEXT, thread_id = process.env.SMOKE_THREAD;
const m = await post("/pseudonymize", { thread_id, text });
const r = await post("/restore", { thread_id, text: m.text });
const masked = m.text !== text && !m.text.includes("example.org");
console.log(`masked=${masked} restored=${r.text === text}`);'

# Значения по умолчанию подставляются после чтения --battle-config (иначе файл бы не действовал).
BATTLE_PROJECT="${BATTLE_PROJECT:-}"
BATTLE_CODE_DIR="${BATTLE_CODE_DIR:-}"
BATTLE_ENV_FILE="${BATTLE_ENV_FILE:-}"
BATTLE_SECRETS_DIR="${BATTLE_SECRETS_DIR:-}"
BATTLE_ETC_DIR="${BATTLE_ETC_DIR:-}"
BATTLE_LOCAL_DIR="${BATTLE_LOCAL_DIR:-}"
BATTLE_BIN_DIR="${BATTLE_BIN_DIR:-}"
BATTLE_AGE_IDENTITY="${BATTLE_AGE_IDENTITY:-}"
BATTLE_PG_CONTAINER="${BATTLE_PG_CONTAINER:-}"
BATTLE_PSEUDO_CONTAINER="${BATTLE_PSEUDO_CONTAINER:-}"
BATTLE_PSEUDO_VOLUME="${BATTLE_PSEUDO_VOLUME:-}"
BATTLE_PG_USER="${BATTLE_PG_USER:-}"
BATTLE_PG_DB="${BATTLE_PG_DB:-}"

# Бэкап в S3 боевым backup.sh - запись в сторону боя: только по явному --backup-sh.
USE_BACKUP_SH=0
KEEP=0
PREFLIGHT_ONLY=0
LOCK_FILE=""
IMAGES_TAR=""
OUT_DIR="$HOME"
BATTLE_CONFIG=""
MEMINFO_FILE="${REHEARSAL_MEMINFO_FILE:-/proc/meminfo}"

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

# ---------------------------------------------------------------------------------------------
# Разбор аргументов
# ---------------------------------------------------------------------------------------------
while (($#)); do
  case "$1" in
    --battle-config) BATTLE_CONFIG="${2:?--battle-config ФАЙЛ}"; shift ;;
    --age-identity) BATTLE_AGE_IDENTITY="${2:?--age-identity ФАЙЛ}"; shift ;;
    --backup-sh) USE_BACKUP_SH=1 ;;
    # Прежний флаг: теперь это и так умолчание, оставлен для старых команд.
    --no-backup-sh) USE_BACKUP_SH=0 ;;
    --lock) LOCK_FILE="${2:?--lock ФАЙЛ}"; shift ;;
    --images-tar) IMAGES_TAR="${2:?--images-tar ФАЙЛ}"; shift ;;
    --out-dir) OUT_DIR="${2:?--out-dir КАТАЛОГ}"; shift ;;
    --keep) KEEP=1 ;;
    --preflight-only) PREFLIGHT_ONLY=1 ;;
    --help | -h) usage; exit "$EXIT_OK" ;;
    *) echo "неизвестный аргумент: $1" >&2; usage >&2; exit "$EXIT_USAGE" ;;
  esac
  shift
done

# Файл настройки боя (dotenv BATTLE_*): переменные окружения вызова сильнее файла.
if [[ -n "$BATTLE_CONFIG" ]]; then
  [[ -f "$BATTLE_CONFIG" ]] || { echo "нет файла $BATTLE_CONFIG" >&2; exit "$EXIT_USAGE"; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^(BATTLE_[A-Z_]+)=(.*)$ ]] || continue
    name="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    [[ -n "${!name:-}" ]] || printf -v "$name" '%s' "$value"
  done <"$BATTLE_CONFIG"
fi
BATTLE_PROJECT="${BATTLE_PROJECT:-pragmatika}"
BATTLE_CODE_DIR="${BATTLE_CODE_DIR:-/opt/pragmatika}"
BATTLE_SECRETS_DIR="${BATTLE_SECRETS_DIR:-/etc/pragmatika/secrets}"
BATTLE_ETC_DIR="${BATTLE_ETC_DIR:-/etc/pragmatika}"
BATTLE_LOCAL_DIR="${BATTLE_LOCAL_DIR:-$BATTLE_CODE_DIR/local}"
BATTLE_ENV_FILE="${BATTLE_ENV_FILE:-$BATTLE_CODE_DIR/deploy/.env}"
BATTLE_PG_CONTAINER="${BATTLE_PG_CONTAINER:-${BATTLE_PROJECT}-postgres-1}"
BATTLE_PSEUDO_CONTAINER="${BATTLE_PSEUDO_CONTAINER:-${BATTLE_PROJECT}-pseudonymizer-1}"
BATTLE_PSEUDO_VOLUME="${BATTLE_PSEUDO_VOLUME:-${BATTLE_PROJECT}_pseudonymizer-data}"

LOCK_FILE="${LOCK_FILE:-$([[ -f "$HERE/images.lock" ]] && echo "$HERE/images.lock" \
  || echo "$STACK/deploy/images.lock")}"
# Помощник сравнения схем: в пакете лежит рядом (tools/), в дереве проекта - в tools/ проекта.
SCHEMA_TOOL="$HERE/tools/check_migrations_schema.py"
[[ -f "$SCHEMA_TOOL" ]] || SCHEMA_TOOL="$STACK/tools/check_migrations_schema.py"

# ---------------------------------------------------------------------------------------------
# Каталоги запуска и журнал
# ---------------------------------------------------------------------------------------------
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
REHEARSAL_HOME="${REHEARSAL_HOME:-$HOME/.pragmatika-rehearsal}"
RUN_DIR="$REHEARSAL_HOME/run-$RUN_ID"
RES="$RUN_DIR/results"
WORK="$RUN_DIR/work"
BACKUP_DIR="${REHEARSAL_BACKUP_DIR:-$HOME/backups/rehearsal-$RUN_ID}"
mkdir -p "$RES" "$WORK" "$RUN_DIR/etc"
LOG_FILE="$RES/rehearsal.log"
CHECKS_FILE="$RES/checks.tsv"
BATTLE_CALLS="$RES/battle-calls.log"
TIMINGS="$RES/timings.tsv"
SECRETS_LIST="$RUN_DIR/secrets.list" # значения секретов репетиции для проверки утечек (600)
: >"$LOG_FILE" && : >"$CHECKS_FILE" && : >"$BATTLE_CALLS" && : >"$TIMINGS" && : >"$SECRETS_LIST"
STATUS="$EXIT_OK"
SAMPLER_PID=""
STARTED_STACK=0
ARCHIVE_PATH=""

log() { printf '%s %s\n' "$(date -u +%T)" "$*" | tee -a "$LOG_FILE"; }
# check <имя> <ok|warn|fail> <описание без секретов и данных>
check() {
  printf '%s\t%s\t%s\n' "$1" "$2" "${*:3}" >>"$CHECKS_FILE"
  log "проверка $1: $2 - ${*:3}"
  [[ "$2" != "fail" ]] || STATUS="$EXIT_CHECKS"
}
phase() { PHASE="$1"; PHASE_START="$(date +%s)"; log "=== $1"; }
phase_end() { printf '%s\t%s\n' "$PHASE" "$(($(date +%s) - PHASE_START))" >>"$TIMINGS"; }
PHASE="старт"
PHASE_START="$(date +%s)"

die() { # die <код> <сообщение>
  log "ОШИБКА: $2"
  STATUS="$1"
  exit "$1"
}

dc() {
  docker compose -p "$PROJECT" --env-file "$LOCK_FILE" --env-file "$RUN_DIR/rehearsal.env" \
    -f "$REH_DIR/compose.yml" "$@"
}

# Любое обращение к бою пишется в battle-calls.log (команда без значений секретов).
battle_docker() {
  printf 'docker %s\n' "$*" >>"$BATTLE_CALLS"
  docker "$@"
}

# Значение ключа из боевого .env/secrets.env без экспорта (последнее вхождение, без кавычек).
env_value() { # env_value <файл> <ключ>
  [[ -f "$1" ]] || return 0
  python3 -I - "$1" "$2" <<'PY'
import re, sys
value = ""
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    if "=" in line and line.split("=", 1)[0].strip() == sys.argv[2]:
        raw = line.split("=", 1)[1].lstrip()
        if raw[:1] in "'\"" and raw[:1] and raw[0] in raw[1:]:
            value = raw[1:].split(raw[0], 1)[0]
        else:
            value = re.split(r"\s#", raw, maxsplit=1)[0].strip()
print(value, end="")
PY
}

random_secret() { head -c "$SECRET_BYTES" /dev/urandom | base64 | tr -d '/+=\n'; }

# ---------------------------------------------------------------------------------------------
# Уборка и итог (всегда, при любом выходе)
# ---------------------------------------------------------------------------------------------
snapshot_battle() { # snapshot_battle <файл>
  local ids
  : >"$1"
  mapfile -t ids < <(docker ps -aq --filter "label=com.docker.compose.project=$BATTLE_PROJECT" \
    2>/dev/null || true)
  ((${#ids[@]})) || return 0
  printf 'docker inspect (снимок боя)\n' >>"$BATTLE_CALLS"
  docker inspect -f "$INSPECT_BATTLE_FORMAT" "${ids[@]}" 2>/dev/null | sort >"$1" || true
}

# Каталог cgroup контейнера по полному id (systemd-драйвер или cgroupfs); пусто - не найден.
cgroup_dir() { # cgroup_dir <полный id>
  local dir
  for dir in "/sys/fs/cgroup/system.slice/docker-$1.scope" "/sys/fs/cgroup/docker/$1"; do
    if [[ -d "$dir" ]]; then printf '%s' "$dir"; return 0; fi
  done
  return 0
}

# Строка «имя anon shmem file» (байты) из memory.stat: anon - память процессов, shmem - общая
# память (shared_buffers Postgres), file - страничный кэш (ядро вытесняет сам).
sample_cgroup_anon() { # sample_cgroup_anon <полный id> <имя>
  local dir
  dir="$(cgroup_dir "$1")"
  [[ -n "$dir" && -r "$dir/memory.stat" ]] || return 0
  awk -v n="$2" '$1 == "anon" {a = $2} $1 == "shmem" {m = $2} $1 == "file" {f = $2}
    END {print n "\t" a "\t" m "\t" f}' "$dir/memory.stat"
}

# Диагностика сбоя восстановления и памяти (без данных): отфильтрованный журнал pg_restore,
# число объектов дампа по типам, события памяти cgroup, флаг OOM, ошибки в журнале postgres.
collect_diagnostics() {
  local tools="$REH_DIR/rehearse_tools.py"
  if [[ -f "$WORK/pg-restore.log" ]]; then
    python3 -I "$tools" restore-log --log "$WORK/pg-restore.log" \
      --out "$RES/pg-restore-errors.txt" 2>>"$LOG_FILE" || true
  fi
  if ((STARTED_STACK)) && docker ps -aq --filter "name=$PROJECT-postgres-1" 2>/dev/null | grep -q .
  then
    docker logs --tail "$PG_LOG_TAIL_LINES" "$PROJECT-postgres-1" >"$WORK/postgres.log" 2>&1 \
      || true
    python3 -I "$tools" restore-log --log "$WORK/postgres.log" \
      --out "$RES/postgres-log-errors.txt" 2>>"$LOG_FILE" || true
  fi
  dmesg 2>/dev/null | grep -iE 'out of memory|oom-kill|killed process' \
    | tail -n "$DMESG_LINES" | cut -c1-300 >"$RES/host-oom.txt" || true
}

collect_memory() {
  local ids name id full dir peak
  [[ -n "$SAMPLER_PID" ]] && kill "$SAMPLER_PID" 2>/dev/null || true
  SAMPLER_PID=""
  collect_diagnostics
  [[ -f "$WORK/mem-samples.txt" ]] || return 0
  : >"$WORK/mem-limits.tsv" && : >"$WORK/mem-cgroup.tsv" && : >"$WORK/mem-events.tsv"
  : >"$RES/memory-events.txt"
  mapfile -t ids < <(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" || true)
  for id in "${ids[@]}"; do
    name="$(docker inspect -f '{{.Name}}' "$id")"
    name="${name#/}"
    docker inspect -f '{{.HostConfig.Memory}}' "$id" \
      | sed "s|^|$name\t|" >>"$WORK/mem-limits.tsv"
    full="$(docker inspect -f '{{.Id}}' "$id")"
    dir="$(cgroup_dir "$full")"
    local oom_kill=0
    if [[ -n "$dir" && -r "$dir/memory.peak" ]]; then
      peak="$(cat "$dir/memory.peak")"
      printf '%s\t%s\n' "$name" "$peak" >>"$WORK/mem-cgroup.tsv"
    fi
    # Последний образец anon/file перед остановкой sampler-а.
    sample_cgroup_anon "$full" "$name" >>"$WORK/mem-anon.tsv" || true
    if [[ -n "$dir" && -r "$dir/memory.events" ]]; then
      sed "s|^|$name\t|; s| |\t|" "$dir/memory.events" >>"$RES/memory-events.txt"
      oom_kill="$(awk '$1 == "oom_kill" {print $2}' "$dir/memory.events")"
    fi
    # cgroup пересоздаётся при перезапуске контейнера, поэтому смотрим и флаг Docker.
    docker inspect -f '{{if .State.OOMKilled}}1{{else}}0{{end}}	{{.RestartCount}}' "$id" \
      | sed "s|^|$name\t${oom_kill:-0}\t|" >>"$WORK/mem-events.tsv"
  done
  if python3 -I "$REH_DIR/rehearse_tools.py" mem-peaks --samples "$WORK/mem-samples.txt" \
    --limits "$WORK/mem-limits.tsv" --cgroup "$WORK/mem-cgroup.tsv" \
    --anon "$WORK/mem-anon.tsv" --events "$WORK/mem-events.tsv" --out "$RES/memory.tsv" \
    2>>"$LOG_FILE"; then
    check "память" ok "пик anon+shmem ниже 90 % лимитов, OOM-убийств нет (memory.tsv)"
  else
    check "память" fail "anon+shmem не ниже 90 % лимита, OOM-убийство или нет замеров (memory.tsv)"
  fi
}

cleanup_stack() {
  if ((KEEP)); then
    log "флаг --keep: стек репетиции оставлен (проект $PROJECT), рабочий каталог $RUN_DIR"
    return 0
  fi
  # Чужой (оставшийся от прошлого запуска) проект не трогаем: убираем только то, что подняли сами.
  if ((STARTED_STACK)); then
    dc --profile tools down -v --remove-orphans >>"$LOG_FILE" 2>&1 \
      || log "down завершился с ошибкой"
    # Остатки по метке проекта: тома и сети, которых down не увидел.
    docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null \
      | xargs -r docker volume rm >>"$LOG_FILE" 2>&1 || true
    if docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null \
      | grep -q . \
      || docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null \
      | grep -q .; then
      check "уборка" fail "остались контейнеры или тома проекта $PROJECT"
    else
      check "уборка" ok "контейнеров, томов и сетей проекта $PROJECT не осталось"
    fi
  fi
  # Рабочие копии с данными и секретами: дамп, копия хранилища, контакты, env.
  rm -rf "${WORK:?}" "${RUN_DIR:?}/etc" "${RUN_DIR:?}/share" "${RUN_DIR:?}/local"
  rm -f "${RUN_DIR:?}/rehearsal.env"
}

on_exit() {
  local rc=$?
  trap - EXIT
  set +e
  # Неожиданный сбой скрипта (set -e) при чистом статусе - ход репетиции сорван.
  if [[ "$STATUS" -eq 0 && "$rc" -ne 0 ]]; then STATUS="$EXIT_FAILED"; fi
  collect_memory
  if [[ -s "$RES/battle-before.txt" ]]; then
    snapshot_battle "$RES/battle-after.txt"
    if cmp -s "$RES/battle-before.txt" "$RES/battle-after.txt"; then
      check "бой не тронут" ok "контейнеры боя те же: id, состояние, время старта, перезапуски"
    else
      check "бой не тронут" fail "снимок боевых контейнеров изменился (battle-before/after.txt)"
    fi
  fi
  cleanup_stack
  finish_results
  exit "$STATUS"
}
trap on_exit EXIT

finish_results() {
  python3 -I "$REH_DIR/rehearse_tools.py" summarize --checks "$CHECKS_FILE" \
    --out "$RES/summary.md" 2>>"$LOG_FILE" || true
  {
    echo "время: $RUN_ID"
    echo "docker: $(docker --version 2>/dev/null || echo ?)"
    echo "compose: $(docker compose version --short 2>/dev/null || echo ?)"
    echo "lock: $(grep -E '^BAI_VERSION=' "$LOCK_FILE" 2>/dev/null || echo ?)"
    grep -E '^BAI_IMAGE_(APP|PSEUDONYMIZER|POSTGRES)=' "$LOCK_FILE" 2>/dev/null || true
    echo "ядро: $(uname -r)"
  } >"$RES/versions.txt"
  if ! python3 -I "$REH_DIR/rehearse_tools.py" leak-scan --dir "$RES" \
    --secrets-file "$SECRETS_LIST" 2>>"$LOG_FILE"; then
    rm -f "$RES/rehearsal.log" "$RES/versions.txt"
    echo "ОШИБКА: в результатах найдено значение секрета; архив не создан" >&2
    STATUS="$EXIT_FAILED"
    return 0
  fi
  mkdir -p "$OUT_DIR"
  ARCHIVE_PATH="$OUT_DIR/rehearsal-$RUN_ID.tgz"
  tar -czf "$ARCHIVE_PATH" -C "$RUN_DIR" results
  chmod 600 "$ARCHIVE_PATH"
  rm -f "$SECRETS_LIST"
  echo "Итог репетиции: код $STATUS; архив результатов: $ARCHIVE_PATH"
}

# ---------------------------------------------------------------------------------------------
# 1. Предусловия
# ---------------------------------------------------------------------------------------------
meminfo_available_mib() {
  awk '/^MemAvailable:/ {print int($2 / 1024)}' "$MEMINFO_FILE"
}

dir_free_mib() { # dir_free_mib <каталог>
  df -Pk "$1" | awk 'NR == 2 {print int($4 / 1024)}'
}

refuse() {
  log "ОТКАЗ: $*"
  log "Бой не тронут: репетиция не создала ни одного контейнера, тома или файла вне $RUN_DIR."
  check "предусловия" fail "$*"
  STATUS="$EXIT_REFUSED"
  exit "$EXIT_REFUSED"
}

preflight() {
  phase "предусловия"
  local cmd
  for cmd in docker python3 tar sha256sum awk flock; do
    command -v "$cmd" >/dev/null || refuse "нет команды $cmd"
  done
  local compose_ver
  compose_ver="$(docker compose version --short 2>/dev/null || true)"
  [[ -n "$compose_ver" ]] || refuse "нет docker compose"
  # Нужен compose с !override (2.24+).
  python3 -I - "$compose_ver" <<'PY' || refuse "docker compose $compose_ver старше 2.24"
import sys
parts = [int(p) for p in sys.argv[1].lstrip("v").split(".")[:2]]
sys.exit(0 if parts >= [2, 24] else 1)
PY
  [[ -f "$LOCK_FILE" ]] || refuse "нет images.lock ($LOCK_FILE)"
  [[ -f "$REH_DIR/compose.yml" ]] || refuse "нет $REH_DIR/compose.yml"

  # Боевые контейнеры и том: только чтение.
  local state
  for name in "$BATTLE_PG_CONTAINER" "$BATTLE_PSEUDO_CONTAINER"; do
    state="$(battle_docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || true)"
    [[ "$state" == "running" ]] \
      || refuse "боевой контейнер $name не запущен (состояние: ${state:-нет})"
  done
  battle_docker volume inspect "$BATTLE_PSEUDO_VOLUME" >/dev/null 2>&1 \
    || refuse "нет боевого тома $BATTLE_PSEUDO_VOLUME"
  [[ -f "$BATTLE_ENV_FILE" ]] || refuse "нет боевого .env ($BATTLE_ENV_FILE)"

  BATTLE_PG_USER="${BATTLE_PG_USER:-$(env_value "$BATTLE_ENV_FILE" POSTGRES_USER)}"
  BATTLE_PG_DB="${BATTLE_PG_DB:-$(env_value "$BATTLE_ENV_FILE" POSTGRES_DB)}"
  BATTLE_PG_USER="${BATTLE_PG_USER:-$PG_USER_DEFAULT}"
  BATTLE_PG_DB="${BATTLE_PG_DB:-$PG_DB_DEFAULT}"

  # Размер БД боя: один запрос на чтение.
  DB_BYTES="$(battle_docker exec "$BATTLE_PG_CONTAINER" psql -U "$BATTLE_PG_USER" \
    -d "$BATTLE_PG_DB" -tAc 'SELECT pg_database_size(current_database())' 2>/dev/null \
    | tr -d '[:space:]' || true)"
  [[ "$DB_BYTES" =~ ^[0-9]+$ ]] || refuse "не удалось узнать размер боевой БД"
  local db_mib=$((DB_BYTES / KIB_PER_MIB / KIB_PER_MIB))

  # Память: MemAvailable хоста против порога лёгкого стека.
  local avail min_avail min_disk need_disk
  avail="$(meminfo_available_mib)"
  min_avail="${REHEARSAL_MIN_AVAILABLE_MIB:-$DEFAULT_MIN_AVAILABLE_MIB}"
  min_disk="${REHEARSAL_MIN_DISK_MIB:-$DEFAULT_MIN_DISK_MIB}"
  need_disk=$((db_mib * DISK_FACTOR_FOR_DB))
  ((need_disk >= min_disk)) || need_disk="$min_disk"
  local home_free docker_root docker_free
  home_free="$(dir_free_mib "$HOME")"
  docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  docker_free="$(dir_free_mib "$docker_root" 2>/dev/null || echo "$home_free")"
  {
    echo "размер_БД_МиБ=$db_mib"
    echo "память_доступно_МиБ=$avail (порог $min_avail)"
    echo "диск_домашний_свободно_МиБ=$home_free (нужно $need_disk)"
    echo "диск_docker_свободно_МиБ=$docker_free (нужно $need_disk)"
  } >"$RES/preflight.txt"
  log "ресурсы: БД ${db_mib} МиБ, память ${avail} МиБ, диск ${home_free}/${docker_free} МиБ"
  ((avail >= min_avail)) \
    || refuse "мало памяти: доступно ${avail} МиБ, нужно ${min_avail} МиБ для лёгкого режима"
  ((home_free >= need_disk)) \
    || refuse "мало места в $HOME: свободно ${home_free} МиБ, нужно ${need_disk} МиБ"
  ((docker_free >= need_disk)) \
    || refuse "мало места в $docker_root: свободно ${docker_free} МиБ, нужно ${need_disk} МиБ"

  # Проект репетиции не должен существовать (остаток прошлого запуска убирайте вручную).
  if docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" | grep -q .; then
    refuse "проект $PROJECT уже существует (остаток прошлой репетиции): уберите его" \
      "командой docker compose -p $PROJECT down -v"
  fi
  ensure_images
  check "предусловия" ok "память ${avail} МиБ, диск ${home_free} МиБ, БД ${db_mib} МиБ, образы есть"
  phase_end
}

lock_value() { grep -E "^$1=" "$LOCK_FILE" | head -1 | cut -d= -f2-; }

ensure_images() {
  local key ref
  if [[ -n "$IMAGES_TAR" ]]; then
    [[ -f "$IMAGES_TAR" ]] || refuse "нет архива образов $IMAGES_TAR"
    log "загружаю образы из $IMAGES_TAR"
    docker load -i "$IMAGES_TAR" >>"$LOG_FILE" 2>&1 || refuse "docker load не удался"
  fi
  for key in BAI_IMAGE_POSTGRES BAI_IMAGE_PSEUDONYMIZER BAI_IMAGE_APP; do
    ref="$(lock_value "$key")"
    [[ -n "$ref" ]] || refuse "в $LOCK_FILE нет $key"
    if ! docker image inspect "$ref" >/dev/null 2>&1; then
      log "образ $key не найден локально, пробую docker pull"
      docker pull "$ref" >>"$LOG_FILE" 2>&1 \
        || refuse "образ $ref не найден: выполните docker login для реестра" \
          "или передайте --images-tar"
    fi
  done
  if command -v cosign >/dev/null && [[ -f "$HERE/cosign.pub" ]]; then
    ref="$(lock_value BAI_IMAGE_APP)"
    if cosign verify --key "$HERE/cosign.pub" --insecure-ignore-tlog=true "$ref" \
      >>"$LOG_FILE" 2>&1; then
      check "подпись образа app" ok "cosign verify прошёл"
    else
      check "подпись образа app" warn "cosign verify не прошёл или нет доступа к реестру"
    fi
  else
    check "подпись образа app" warn "подпись не проверена: нет cosign или cosign.pub"
  fi
}

# ---------------------------------------------------------------------------------------------
# Юниты systemd, которые остаются на старом дереве (платформа 1.0.1, только чтение)
# ---------------------------------------------------------------------------------------------
# bai-units.sh переводит на установленную платформу только stack, backup и backup-verify. Остальные
# юниты ссылаются на старое дерево: перед его удалением в них правят пути (пункт чек-листа
# этапа 8, UPGRADE.md платформы 1.0.1, п. 2). Список помогает не забыть, ничего не меняет.
UNITS_MANAGED=(stack backup backup-verify)
UNITS_UNMANAGED=(healthwatch maintenance cert-expiry telemetry-probe container-metrics)
audit_old_tree_units() {
  phase "юниты systemd и старое дерево (только чтение)"
  local prefix="${BATTLE_UNIT_PREFIX:-pragmatika}" file="$RES/units-old-tree.tsv"
  local base unit text refs role stale=0
  printf 'юнит\tкто переводит\tссылок на старое дерево\n' >"$file"
  if ! command -v systemctl >/dev/null 2>&1; then
    check "юниты systemd" warn "systemctl недоступен: список для этапа 8 не снят"
    phase_end
    return 0
  fi
  for base in "${UNITS_MANAGED[@]}" "${UNITS_UNMANAGED[@]}"; do
    unit="$prefix-$base.service"
    role="чек-лист этапа 8"
    [[ " ${UNITS_MANAGED[*]} " == *" $base "* ]] && role="bai-units.sh"
    if ! text="$(systemctl cat "$unit" 2>/dev/null)"; then
      printf '%s\t%s\tнет юнита\n' "$unit" "$role" >>"$file"
      continue
    fi
    refs="$(grep -cF -- "$BATTLE_CODE_DIR" <<<"$text" || true)"
    printf '%s\t%s\t%s\n' "$unit" "$role" "$refs" >>"$file"
    if [[ "$role" != "bai-units.sh" ]] && ((refs > 0)); then stale=$((stale + 1)); fi
  done
  if ((stale > 0)); then
    check "юниты systemd" warn \
      "$stale юнит(ов) со старым деревом вне bai-units.sh (units-old-tree.tsv)"
  else
    check "юниты systemd" ok "юнитов со старым деревом вне bai-units.sh не найдено"
  fi
  phase_end
}

# ---------------------------------------------------------------------------------------------
# 2-3. Бэкап боя и рабочий дамп
# ---------------------------------------------------------------------------------------------
run_battle_backup() {
  phase "бэкап боя штатным backup.sh"
  BACKUP_ARCHIVE=""
  if ((!USE_BACKUP_SH)); then
    check "бэкап backup.sh" warn "не запрашивался (нужен --backup-sh); дамп снят pg_dump"
    phase_end
    return 0
  fi
  local script="$BATTLE_CODE_DIR/deploy/scripts/backup.sh"
  [[ -f "$script" ]] || { check "бэкап backup.sh" fail "нет $script"; phase_end; return 0; }
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  printf 'bash %s (штатный бэкап боя)\n' "$script" >>"$BATTLE_CALLS"
  local rc=0
  (
    export PATH="${BATTLE_BIN_DIR:+$BATTLE_BIN_DIR:}$PATH"
    export PRAGMATIKA_ENV="$BATTLE_ENV_FILE" SECRETS_DIR="$BATTLE_SECRETS_DIR"
    export COMPOSE_PROJECT_NAME="$BATTLE_PROJECT" BACKUP_LOCAL_DIR="$BACKUP_DIR"
    bash "$script"
  ) >"$WORK/backup-sh.log" 2>&1 || rc=$?
  # Журнал backup.sh без значений: только число строк и строки со словом «Бэкап».
  grep -E 'Бэкап|Размер архива|ОШИБКА' "$WORK/backup-sh.log" >"$RES/backup-sh.log" || true
  if ((rc != 0)); then
    check "бэкап backup.sh" fail "backup.sh завершился кодом $rc (см. backup-sh.log)"
    phase_end
    return 0
  fi
  # Архив лежит там, куда backup.sh его положил: наш каталог или BACKUP_LOCAL_DIR боя.
  local dirs=("$BACKUP_DIR") d
  d="$(env_value "$BATTLE_ENV_FILE" BACKUP_LOCAL_DIR)"
  [[ -z "$d" ]] || dirs+=("$d")
  dirs+=(/var/backups/pragmatika)
  BACKUP_ARCHIVE="$(find "${dirs[@]}" -maxdepth 1 -name 'pragmatika-*.tar.age' \
    -newer "$LOG_FILE" -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2- || true)"
  if [[ -n "$BACKUP_ARCHIVE" ]]; then
    check "бэкап backup.sh" ok "архив $BACKUP_ARCHIVE, $(du -h "$BACKUP_ARCHIVE" | cut -f1)," \
      "sha256 $(sha256sum "$BACKUP_ARCHIVE" | cut -c1-16)…"
  else
    check "бэкап backup.sh" warn "backup.sh отработал, но новый архив *.tar.age не найден"
  fi
  phase_end
}

# Рабочий дамп БД: из архива бэкапа (нужен ключ age) или pg_dump с чтением из боевого контейнера.
prepare_dump() {
  phase "рабочий дамп БД"
  DUMP_FILE="$WORK/db.dump"
  SQLITE_FROM_ARCHIVE=""
  if [[ -n "$BATTLE_AGE_IDENTITY" && -n "${BACKUP_ARCHIVE:-}" ]]; then
    local pathbin="${BATTLE_BIN_DIR:+$BATTLE_BIN_DIR:}$PATH"
    mkdir -p "$WORK/unpacked"
    if PATH="$pathbin" age -d -i "$BATTLE_AGE_IDENTITY" "$BACKUP_ARCHIVE" \
      | tar -x -C "$WORK/unpacked" db.dump replacements.sqlite3 manifest.txt 2>>"$LOG_FILE"; then
      mv "$WORK/unpacked/db.dump" "$DUMP_FILE"
      SQLITE_FROM_ARCHIVE="$WORK/unpacked/replacements.sqlite3"
      cp "$WORK/unpacked/manifest.txt" "$RES/backup-manifest.txt" 2>/dev/null || true
      check "дамп БД" ok "взят из архива бэкапа (расшифрован ключом age, хранилище из архива)"
      phase_end
      return 0
    fi
    check "дамп БД из архива" warn "архив не расшифровался, перехожу на pg_dump"
  fi
  battle_docker exec "$BATTLE_PG_CONTAINER" pg_dump -U "$BATTLE_PG_USER" -d "$BATTLE_PG_DB" \
    --format=custom --compress=6 --no-owner >"$DUMP_FILE" \
    || { check "дамп БД" fail "pg_dump боевой БД не удался"; die "$EXIT_FAILED" "нет дампа"; }
  check "дамп БД" ok "pg_dump с чтением из боевого контейнера, $(du -h "$DUMP_FILE" | cut -f1)"
  phase_end
}

# ---------------------------------------------------------------------------------------------
# Каталоги настроек, .env репетиции
# ---------------------------------------------------------------------------------------------
# Каталоги хоста боя для app. Источник - боевой .env (`*_HOST_DIR`), умолчания как в compose v2;
# на бою каталоги не обязаны лежать в /etc/pragmatika (попытка 3 G6: правила доступа в
# /opt/pragmatika/local/access, каталога /etc/pragmatika/access нет). Бой только читается.
resolve_host_dirs() {
  ACCESS_SRC="$(reh_host_dir "$BATTLE_ENV_FILE" ACCESS_POLICY_HOST_DIR "$BATTLE_ETC_DIR/access")"
  MAIL_SRC="$(reh_host_dir "$BATTLE_ENV_FILE" MAIL_HOST_DIR "$BATTLE_ETC_DIR/mail")"
  DOCS_SRC="$(reh_host_dir "$BATTLE_ENV_FILE" DOCUMENTS_HOST_DIR "$DEFAULT_DOCUMENTS_DIR")"
  TEMPLATES_SRC="$(reh_host_dir "$BATTLE_ENV_FILE" TEMPLATES_HOST_DIR "$DOCS_SRC")"
  LOCAL_SRC="$(reh_host_dir "$BATTLE_ENV_FILE" LOCAL_HOST_DIR "$BATTLE_LOCAL_DIR")"
}

# copy_one <имя проверки> <ПЕРЕМЕННАЯ> <источник> <приёмник> <предел МиБ|0> <обязательно 0|1>
copy_one() {
  local name="$1" var="$2" src="$3" dst="$4" limit="$5" required="$6" size err
  if [[ ! -d "$src" ]]; then
    if ((required)); then
      check "$name" fail "$var=$src: каталога нет или нет прав (на бою его не видно)"
    else
      check "$name" warn "$var=$src: каталога нет, копия пустая"
    fi
    return 0
  fi
  size="$(reh_dir_size_mib "$src")"
  if ((limit > 0 && size > limit)); then
    check "$name" warn "$var=$src: ${size} МиБ больше предела ${limit}, копия не снимается"
    return 0
  fi
  printf 'cp -rL (чтение каталога): %s=%s\n' "$var" "$src" >>"$BATTLE_CALLS"
  if err="$(reh_copy_dir "$src" "$dst" 2>&1)"; then
    check "$name" ok "$var=$src: файлов $(find "$dst" -type f | wc -l), ${size} МиБ"
  else
    check "$name" fail "$var=$src: копия не снята: $(printf '%s' "$err" | head -1 | cut -c1-160)"
  fi
}

copy_host_inputs() {
  resolve_host_dirs
  : >"$RES/host-dirs.txt"
  printf '%s=%s\n' ACCESS_POLICY_HOST_DIR "$ACCESS_SRC" MAIL_HOST_DIR "$MAIL_SRC" \
    DOCUMENTS_HOST_DIR "$DOCS_SRC" TEMPLATES_HOST_DIR "$TEMPLATES_SRC" \
    LOCAL_HOST_DIR "$LOCAL_SRC" >>"$RES/host-dirs.txt"
  local access_file required=0
  access_file="$(env_value "$BATTLE_ENV_FILE" ACCESS_POLICY_FILE)"
  [[ -z "$access_file" ]] || required=1
  copy_one "копия правил доступа" ACCESS_POLICY_HOST_DIR "$ACCESS_SRC" "$RUN_DIR/etc/access" 0 \
    "$required"
  # Шаблоны проекта. Если TEMPLATES_HOST_DIR не задан, это шара документов (большая): предел.
  copy_one "копия шаблонов" TEMPLATES_HOST_DIR "$TEMPLATES_SRC" "$RUN_DIR/templates" \
    "$REH_TEMPLATES_MAX_MIB" 0
  copy_one "копия local боя" LOCAL_HOST_DIR "$LOCAL_SRC" "$RUN_DIR/local" "$REH_LOCAL_MAX_MIB" 0
  # Шара документов (цены, договоры) не копируется: большая и с данными; app стартует и без неё.
  printf 'документы: %s (не копируются)\n' "$DOCS_SRC" >>"$BATTLE_CALLS"
}

# Владелец копий: файлы app - uid:gid процесса образа app, файлы псевдонимизатора - его образа.
own_inputs() {
  local app_image pseudo_ids
  app_image="$(lock_value BAI_IMAGE_APP)"
  if pseudo_ids="$(reh_image_ids "$(pseudo_image)")"; then
    read -r PSEUDO_UID PSEUDO_GID <<<"$pseudo_ids"
  else
    check "uid псевдонимизатора" fail "не узнан uid:gid процесса образа псевдонимизатора"
  fi
  if reh_own_for_image "$app_image" "$RUN_DIR/etc/access" "$RUN_DIR/etc/mail" \
    "$RUN_DIR/share" "$RUN_DIR/templates" "$RUN_DIR/local" "$RUN_DIR/stub" 2>>"$LOG_FILE"; then
    check "владелец копий app" ok "файлы: uid:gid процесса образа app, режим $REH_FILE_MODE"
  else
    check "владелец копий app" fail "не заданы владелец и права копий (rehearsal.log)"
  fi
  if reh_own_for_image "$(pseudo_image)" "$RUN_DIR/etc/config" "$RUN_DIR/etc/contacts.txt" \
    2>>"$LOG_FILE"; then
    check "владелец копий псевдонимизатора" ok \
      "uid:gid $PSEUDO_UID:$PSEUDO_GID, режим $REH_FILE_MODE"
  else
    check "владелец копий псевдонимизатора" fail "не заданы владелец и права (rehearsal.log)"
  fi
}

prepare_inputs() {
  phase "копии настроек и .env репетиции"
  local etc="$RUN_DIR/etc"
  mkdir -p "$etc/config" "$etc/access" "$etc/mail" "$RUN_DIR/share" "$RUN_DIR/templates" \
    "$RUN_DIR/local" "$RUN_DIR/stub"
  # Копии только для чтения: исходные каталоги боя не меняются.
  local src="$BATTLE_ETC_DIR/config"
  if [[ -d "$src" ]]; then
    printf 'cp -rL (чтение каталога): BATTLE_ETC_DIR/config=%s\n' "$src" >>"$BATTLE_CALLS"
    cp -rL --no-preserve=all "$src/." "$etc/config/" 2>>"$LOG_FILE" || true
  fi
  if [[ -f "$BATTLE_ETC_DIR/contacts.txt" ]]; then
    printf 'cp -L (чтение файла): %s\n' "$BATTLE_ETC_DIR/contacts.txt" >>"$BATTLE_CALLS"
    cp -L --no-preserve=all "$BATTLE_ETC_DIR/contacts.txt" "$etc/contacts.txt"
  else
    : >"$etc/contacts.txt"
  fi
  cp "$REH_DIR/model-stub.ts" "$RUN_DIR/stub/model-stub.ts"
  copy_host_inputs
  own_inputs
  # Почта: настоящий файл ящиков (логины) не переносится, проверяется только форма.
  local mailboxes="$MAIL_SRC/mailboxes.json"
  if [[ -f "$mailboxes" ]]; then
    local count
    count="$(python3 -I - "$mailboxes" <<'PY' 2>/dev/null || echo ошибка
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
items = data.get("mailboxes", data) if isinstance(data, dict) else data
print(len(items))
PY
)"
    if [[ "$count" == "ошибка" ]]; then
      check "mailboxes.json боя" fail "файл не разбирается как JSON"
    else
      check "mailboxes.json боя" ok "разбирается, ящиков: $count (в репетицию не переносится)"
    fi
  else
    check "mailboxes.json боя" warn "файла нет в MAIL_HOST_DIR ($MAIL_SRC)"
  fi

  local secrets="$BATTLE_SECRETS_DIR/secrets.env" pg_pass api_token
  [[ -f "$secrets" ]] || secrets=""
  PSEUDO_KEY="$(env_value "${secrets:-/dev/null}" PSEUDONYMIZER_KEY)"
  [[ -n "$PSEUDO_KEY" ]] || PSEUDO_KEY="$(env_value "$BATTLE_ENV_FILE" PSEUDONYMIZER_KEY)"
  [[ -n "$PSEUDO_KEY" ]] || die "$EXIT_FAILED" "в боевых .env и secrets.env нет PSEUDONYMIZER_KEY"
  pg_pass="$(random_secret)"
  api_token="$(random_secret)"
  printf '%s\n%s\n%s\n' "$PSEUDO_KEY" "$pg_pass" "$api_token" >>"$SECRETS_LIST"
  local access_file
  access_file="$(env_value "$BATTLE_ENV_FILE" ACCESS_POLICY_FILE)"
  python3 -I "$REH_DIR/rehearse_tools.py" env-build --battle-env "$BATTLE_ENV_FILE" \
    ${secrets:+--secrets "$secrets"} \
    --compose-files "$STACK/deploy/platform/compose.base.yml" "$STACK/deploy/compose.project.yml" \
    "$STACK/deploy/compat.env" "$REH_DIR/compose.overlay.yml" \
    --drop-file "$REH_DIR/env-drop.txt" --take-secret PSEUDONYMIZER_KEY \
    --override "POSTGRES_PASSWORD=$pg_pass" --override "PSEUDONYMIZER_API_TOKEN=$api_token" \
    --override "LITELLM_API_KEY=rehearsal-stub" --override "OWNER_THREAD_ID=rehearsal-owner" \
    --override "GATEWAY_HOST=gateway.invalid" --override "GATEWAY_TLS_NAME=gateway.invalid" \
    --override "BAI_LOG_TAG=$PROJECT" --override "WEB_SEARCH_PROVIDER=disabled" \
    --override "REHEARSAL_RUN_DIR=$RUN_DIR" \
    --override "REHEARSAL_STUB_FILE=$RUN_DIR/stub/model-stub.ts" \
    ${access_file:+--override "ACCESS_POLICY_FILE=$access_file"} \
    --out "$RUN_DIR/rehearsal.env" --report "$RES/env-build.json" 2>>"$LOG_FILE" \
    || die "$EXIT_FAILED" "не собран .env репетиции (нет обязательных имён: см. env-build.json)"
  python3 -I "$REH_DIR/rehearse_tools.py" env-names --battle-env "$BATTLE_ENV_FILE" \
    ${secrets:+--secrets "$secrets"} \
    --compose-files "$STACK/deploy/platform/compose.base.yml" "$STACK/deploy/compose.project.yml" \
    "$STACK/deploy/compat.env" --host-only-file "$REH_DIR/env-host-only.txt" \
    --retired-file "$REH_DIR/env-retired.txt" \
    ${EXPECTED_ENV_NAMES:+--expected-names "$EXPECTED_ENV_NAMES"} \
    --out "$RES/env-names.json" 2>>"$LOG_FILE"
  # Тома боя против томов v2: имена должны совпасть (иначе при выкатке данные «потеряются»).
  compare_volumes
  local unknown retired
  unknown="$(python3 -I -c "$COUNT_UNKNOWN_PY" "$RES/env-names.json")"
  retired="$(python3 -I -c "$COUNT_RETIRED_PY" "$RES/env-names.json")"
  if ((unknown > 0)); then
    check "имена env боя" warn "$unknown имён боя неизвестны compose v2 (env-names.json):" \
      "при выкатке они не дойдут до контейнеров"
  else
    check "имена env боя" ok "все имена боя известны compose v2, относятся к скриптам хоста" \
      "или сняты ($retired: код их не читает, env-retired.txt)"
  fi
  phase_end
}
EXPECTED_ENV_NAMES=""
[[ ! -f "$HERE/expected-env-names.txt" ]] || EXPECTED_ENV_NAMES="$HERE/expected-env-names.txt"

# Тома боя против ВСЕХ томов, объявленных compose v2 (со всеми профилями: speech, telemetry,
# mask, agent-sandbox, tools). `docker compose config --volumes` без профилей такие тома
# опускает (ложный fail попытки 1), поэтому имена читаются из объявлений compose-файлов.
compare_volumes() {
  local battle_vols missing
  battle_vols="$(battle_docker volume ls -q \
    --filter "label=com.docker.compose.project=$BATTLE_PROJECT" \
    | sed "s/^${BATTLE_PROJECT}_//" | sort | tr '\n' ' ')"
  printf '%s\n' $battle_vols >"$RES/volumes-battle.txt"
  if missing="$(python3 -I "$REH_DIR/rehearse_tools.py" volumes-diff --battle "$battle_vols" \
    --compose-files "$STACK/deploy/platform/compose.base.yml" "$STACK/deploy/compose.project.yml" \
    --out "$RES/volumes-v2.txt" 2>>"$LOG_FILE")"; then
    if [[ -z "$battle_vols" ]]; then
      check "тома боя и v2" warn "у боевого проекта $BATTLE_PROJECT нет томов с меткой compose"
    else
      check "тома боя и v2" ok "все тома боя ($battle_vols) есть в compose v2 (все профили)"
    fi
  else
    check "тома боя и v2" fail "у боя есть тома, которых нет в compose v2: $missing"
  fi
}

# ---------------------------------------------------------------------------------------------
# 4. БД репетиции: восстановление, миграции, схема
# ---------------------------------------------------------------------------------------------
psql_reh() { dc exec -T postgres psql -U "$PG_USER_REH" -d "$PG_DB_REH" -v ON_ERROR_STOP=1 "$@"; }

wait_healthy() { # wait_healthy <сервис> <секунд>
  local name="$PROJECT-$1-1" waited=0 st
  while ((waited < $2)); do
    st="$(docker inspect -f "$HEALTH_FORMAT" "$name" 2>/dev/null || echo none)"
    [[ "$st" == "healthy" ]] && return 0
    sleep "$POLL_S"
    waited=$((waited + POLL_S))
  done
  return 1
}

start_sampler() {
  (
    while :; do
      local ids
      mapfile -t ids < <(docker ps -q \
        --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null)
      if ((${#ids[@]})); then
        docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' "${ids[@]}" 2>/dev/null \
          | awk '{print $1, $2}' >>"$WORK/mem-samples.txt" || true
        local full name
        while read -r full name; do
          sample_cgroup_anon "$full" "$name" >>"$WORK/mem-anon.tsv" || true
        done < <(docker ps --no-trunc --format '{{.ID}} {{.Names}}' \
          --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null || true)
      fi
      sleep "$SAMPLE_INTERVAL_S"
    done
  ) &
  SAMPLER_PID=$!
}

# Отфильтрованный журнал pg_restore в результаты (ERROR/FATAL/pg_restore:, без данных COPY).
collect_restore_log() {
  python3 -I "$REH_DIR/rehearse_tools.py" restore-log --log "$WORK/pg-restore.log" \
    --out "$RES/pg-restore-errors.txt" 2>>"$LOG_FILE" || true
}

# Роли боя (только имена, из боевого кластера в транзакции только для чтения) создаются в
# Postgres репетиции без паролей и без права входа: дамп содержит GRANT на эти роли, а в
# чистом postgres их нет. Это заодно репетиция ACL для переезда.
create_battle_roles() {
  if ! battle_docker exec -e PGOPTIONS="$READ_ONLY_PGOPTIONS" "$BATTLE_PG_CONTAINER" \
    psql -U "$BATTLE_PG_USER" -d "$BATTLE_PG_DB" -tA -c "$ROLES_SQL" >"$WORK/battle-roles.txt" \
    2>>"$LOG_FILE"; then
    check "роли боя" warn "список ролей из боевого кластера не получен: GRANT могут не пройти"
    return 0
  fi
  cp "$WORK/battle-roles.txt" "$RES/battle-roles.txt"
  python3 -I "$REH_DIR/rehearse_tools.py" roles-sql --names-file "$WORK/battle-roles.txt" \
    --out "$WORK/roles.sql" 2>>"$LOG_FILE"
  local before after
  before="$(psql_reh -tAc "SELECT count(*) FROM pg_roles" | tr -d '[:space:]')"
  if psql_reh -q <"$WORK/roles.sql" >>"$LOG_FILE" 2>&1; then
    after="$(psql_reh -tAc "SELECT count(*) FROM pg_roles" | tr -d '[:space:]')"
    check "роли боя" ok "в списке боя $(wc -l <"$WORK/roles.sql"), создано $((after - before))" \
      "(NOLOGIN, без паролей; battle-roles.txt)"
  else
    check "роли боя" fail "роли боя не созданы в Postgres репетиции (rehearsal.log)"
    die "$EXIT_FAILED" "нет ролей боя"
  fi
}

# Число объектов с правами в бою и в копии: ACL должны перенестись дампом.
compare_acl_counts() {
  local battle_n reh_n
  battle_n="$(battle_docker exec -e PGOPTIONS="$READ_ONLY_PGOPTIONS" "$BATTLE_PG_CONTAINER" \
    psql -U "$BATTLE_PG_USER" -d "$BATTLE_PG_DB" -tAc "$ACL_COUNT_SQL" 2>/dev/null \
    | tr -d '[:space:]' || true)"
  reh_n="$(psql_reh -tAc "$ACL_COUNT_SQL" | tr -d '[:space:]')"
  if [[ -n "$battle_n" && "$battle_n" == "$reh_n" ]]; then
    check "права (ACL) после восстановления" ok "объектов с правами: $reh_n, как в бою"
  else
    check "права (ACL) после восстановления" warn \
      "в бою ${battle_n:-?} объектов с правами, в копии $reh_n (бой мог измениться после дампа)"
  fi
}

restore_database() {
  phase "восстановление БД и миграции"
  PG_USER_REH="$(env_value "$RUN_DIR/rehearsal.env" POSTGRES_USER)"
  PG_DB_REH="$(env_value "$RUN_DIR/rehearsal.env" POSTGRES_DB)"
  PG_USER_REH="${PG_USER_REH:-$PG_USER_DEFAULT}"
  PG_DB_REH="${PG_DB_REH:-$PG_DB_DEFAULT}"
  : >"$WORK/mem-samples.txt" && : >"$WORK/mem-anon.tsv"
  STARTED_STACK=1
  dc up -d postgres >>"$LOG_FILE" 2>&1 || die "$EXIT_FAILED" "postgres репетиции не стартовал"
  start_sampler
  wait_healthy postgres "$HEALTH_WAIT_S" || die "$EXIT_FAILED" "postgres репетиции не стал healthy"
  create_battle_roles
  # Оглавление дампа по типам (число объектов, без имён): видно, сколько в нём ACL и данных.
  dc exec -T postgres pg_restore -l <"$DUMP_FILE" >"$WORK/dump-toc.txt" 2>>"$WORK/pg-restore.log" \
    || true
  python3 -I "$REH_DIR/rehearse_tools.py" toc-summary --list-file "$WORK/dump-toc.txt" \
    --out "$RES/dump-toc-summary.tsv" 2>>"$LOG_FILE" || true
  local t0 rc=0
  t0="$(date +%s)"
  # Без --exit-on-error: pg_restore доходит до конца и собирает ВСЕ ошибки (за одну репетицию
  # видна полная картина, а не первая); итог тот же - любая ошибка даёт код 1 и провал проверки.
  # ACL не отключается (--no-acl нет): права на роли боя должны восстанавливаться, как при
  # переезде; иначе проблема ACL всплыла бы только на переключении.
  dc exec -T postgres pg_restore -U "$PG_USER_REH" -d "$PG_DB_REH" --no-owner \
    <"$DUMP_FILE" >>"$WORK/pg-restore.log" 2>&1 || rc=$?
  collect_restore_log
  if ((rc == 0)); then
    check "восстановление БД" ok "pg_restore за $(($(date +%s) - t0)) с"
  else
    check "восстановление БД" fail "pg_restore не удался (код $rc): pg-restore-errors.txt"
    die "$EXIT_FAILED" "БД не восстановлена"
  fi
  rm -f "$DUMP_FILE" # рабочая копия дампа с данными больше не нужна
  compare_acl_counts
  # Число применённых миграций: боевая БД и копия.
  local battle_n reh_n
  battle_n="$(battle_docker exec "$BATTLE_PG_CONTAINER" psql -U "$BATTLE_PG_USER" \
    -d "$BATTLE_PG_DB" -tAc 'SELECT count(*) FROM schema_migrations' 2>/dev/null \
    | tr -d '[:space:]' || true)"
  reh_n="$(psql_reh -tAc 'SELECT count(*) FROM schema_migrations' | tr -d '[:space:]')"
  if [[ "$battle_n" == "$reh_n" ]]; then
    check "schema_migrations после восстановления" ok "записей: $reh_n, как в бою"
  else
    check "schema_migrations после восстановления" warn \
      "в бою ${battle_n:-?}, в копии $reh_n (бой мог измениться после дампа)"
  fi
  psql_reh -tAc "$EXTENSIONS_SQL" >"$RES/extensions.txt" || true

  # migrate --plan
  dc --profile tools run --rm migrate --plan >"$RES/migrate-plan.txt" 2>>"$LOG_FILE" \
    || die "$EXIT_FAILED" "migrate --plan не отработал"
  local pending
  pending="$(grep -E '^pending ' "$RES/migrate-plan.txt" | sed 's/^pending //' | sort \
    | tr '\n' ' ')"
  log "план миграций: ожидающие: ${pending:-нет}"
  if [[ -f "$HERE/expected-pending.txt" ]]; then
    local expected
    expected="$(grep -v '^#' "$HERE/expected-pending.txt" | sort | tr '\n' ' ')"
    if [[ "$pending" == "$expected" ]]; then
      check "план миграций" ok "ожидают только: ${pending:-ничего}"
    else
      check "план миграций" fail "ожидают: ${pending:-ничего}; ожидалось: ${expected:-ничего}"
    fi
  else
    check "план миграций" warn "ожидают: ${pending:-ничего} (эталона expected-pending.txt нет)"
  fi
  if dc --profile tools run --rm migrate >"$RES/migrate-apply.txt" 2>&1; then
    check "применение миграций" ok "$(tail -1 "$RES/migrate-apply.txt")"
  else
    check "применение миграций" fail "migrate завершился ошибкой (migrate-apply.txt)"
    die "$EXIT_FAILED" "миграции не применились"
  fi
  dc --profile tools run --rm migrate --plan >"$RES/migrate-plan-after.txt" 2>>"$LOG_FILE" || true
  if grep -qE '^pending ' "$RES/migrate-plan-after.txt"; then
    check "план после применения" fail "после применения остались ожидающие миграции"
  else
    check "план после применения" ok "ожидающих миграций нет"
  fi
  # Схема против ожидаемой схемы v2.
  psql_reh -c '' >/dev/null
  dc exec -T postgres pg_dump --schema-only --no-owner --no-privileges -U "$PG_USER_REH" \
    -d "$PG_DB_REH" >"$WORK/schema-actual.sql"
  if [[ -f "$HERE/schema-expected.sql" ]]; then
    python3 -I "$SCHEMA_TOOL" normalize "$WORK/schema-actual.sql" \
      "$RES/schema-actual.normalized.sql"
    if python3 -I "$SCHEMA_TOOL" compare "$HERE/schema-expected.sql" \
      "$RES/schema-actual.normalized.sql" --diff-out "$RES/schema-diff.txt" \
      >"$RES/schema-compare.txt" 2>&1; then
      check "схема против ожидаемой v2" ok "различий объектов нет"
    else
      check "схема против ожидаемой v2" fail "схема отличается (schema-diff.txt)"
    fi
  else
    check "схема против ожидаемой v2" warn "нет schema-expected.sql: сравнение пропущено"
  fi
  phase_end
}

# ---------------------------------------------------------------------------------------------
# 5. Хранилище псевдонимизатора
# ---------------------------------------------------------------------------------------------
pseudo_image() { lock_value BAI_IMAGE_PSEUDONYMIZER; }

copy_pseudonymizer_store() {
  phase "хранилище псевдонимизатора"
  local vol="${PROJECT}_pseudonymizer-data" pg_image
  pg_image="$(lock_value BAI_IMAGE_POSTGRES)"
  dc create --no-recreate pseudonymizer >>"$LOG_FILE" 2>&1 \
    || die "$EXIT_FAILED" "не создан том репетиции"
  if [[ -n "$SQLITE_FROM_ARCHIVE" && -f "$SQLITE_FROM_ARCHIVE" ]]; then
    docker run --rm --network none --entrypoint sh -v "$vol:/dst" \
      -v "$(dirname "$SQLITE_FROM_ARCHIVE"):/in:ro" "$pg_image" -c \
      "cp /in/replacements.sqlite3 /dst/pseudonymizer.sqlite3 \
       && chown $PSEUDO_UID:$PSEUDO_GID /dst/pseudonymizer.sqlite3 \
       && chmod 600 /dst/pseudonymizer.sqlite3" >>"$LOG_FILE" 2>&1 \
      || die "$EXIT_FAILED" "копия хранилища из архива не легла в том"
    STORE_SOURCE="архив бэкапа (согласованная копия sqlite backup API)"
  else
    # Чтение боевого тома только на чтение; копия снимается средствами SQLite (backup API).
    printf 'docker run --rm -v %s:/src:ro (чтение хранилища)\n' "$BATTLE_PSEUDO_VOLUME" \
      >>"$BATTLE_CALLS"
    # От root: боевые файлы принадлежат uid псевдонимизатора (режим 600), том - root.
    docker run --rm --network none --user 0:0 --entrypoint python -i \
      -e PSEUDO_UID="$PSEUDO_UID" -e PSEUDO_GID="$PSEUDO_GID" \
      -v "$BATTLE_PSEUDO_VOLUME:/src:ro" -v "$vol:/dst" "$(pseudo_image)" - <<'PY' \
      >>"$LOG_FILE" 2>&1 || die "$EXIT_FAILED" "копия хранилища с боя не снята"
import os, sqlite3
src = sqlite3.connect("file:/src/pseudonymizer.sqlite3?mode=ro", uri=True)
dst = sqlite3.connect("/dst/pseudonymizer.sqlite3")
src.backup(dst)
dst.close()
src.close()
uid = int(os.environ["PSEUDO_UID"])
gid = int(os.environ["PSEUDO_GID"])
os.chown("/dst/pseudonymizer.sqlite3", uid, gid)
os.chmod("/dst/pseudonymizer.sqlite3", 0o600)
print("копия хранилища снята")
PY
    STORE_SOURCE="чтение боевого тома (sqlite backup API, том смонтирован :ro)"
  fi
  # Самопроверка: расшифровка всех строк ключом боя, без записи и без значений.
  local out rc=0
  out="$(PSEUDONYMIZER_KEY="$PSEUDO_KEY" docker run --rm --network none --entrypoint python \
    -e PSEUDONYMIZER_KEY -e PSEUDONYMIZER_KEY_SCHEME=v2 -v "$vol:/data" "$(pseudo_image)" \
    -m labops_pii.rekey --db /data/pseudonymizer.sqlite3 --dry-run 2>&1)" || rc=$?
  printf '%s\n' "$out" | grep -E 'всего строк|расшифровка|найден' \
    >"$RES/pseudonymizer-selfcheck.txt" || true
  # При сбое в файл идут последние строки вывода (текст ошибки), обрезанные по длине.
  if ((rc != 0)) && [[ ! -s "$RES/pseudonymizer-selfcheck.txt" ]]; then
    printf '%s\n' "$out" | tail -3 | cut -c1-200 >"$RES/pseudonymizer-selfcheck.txt"
  fi
  if ((rc == 0)); then
    check "хранилище: самопроверка" ok \
      "$(tail -1 "$RES/pseudonymizer-selfcheck.txt"); источник: $STORE_SOURCE"
  else
    check "хранилище: самопроверка" fail \
      "расшифровка не прошла (код $rc): $(tail -1 "$RES/pseudonymizer-selfcheck.txt")"
  fi
  phase_end
}

# ---------------------------------------------------------------------------------------------
# 6. Псевдонимизатор v2, app
# ---------------------------------------------------------------------------------------------
# Последние строки журнала контейнера для разбора сбоя: JSON-строки сводятся к level и event,
# остальное (вывод точки входа) режется по длине. Значения секретов отсеивает leak-scan.
capture_failure_log() { # capture_failure_log <сервис>
  docker logs --tail "$FAILURE_LOG_LINES" "$PROJECT-$1-1" 2>&1 | python3 -I -c '
import json, sys
for line in sys.stdin:
    try:
        d = json.loads(line)
        print({k: d.get(k) for k in ("level", "event", "status")})
    except ValueError:
        print(line.rstrip()[:200])' >"$RES/failure-$1.txt" 2>/dev/null || true
}

# Одноразовый контейнер образа app (bun): reh_oneshot <сеть compose | container:ИМЯ> <js> [-e ...].
# Не зависит от живости app; сеть берётся по меткам проекта.
reh_oneshot() {
  local net="$1" js="$2" net_id
  shift 2
  if [[ "$net" == container:* ]]; then
    # Сетевое пространство уже работающего контейнера (health-сервер app слушает только 127.0.0.1).
    net_id="$net"
  else
    net_id="$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT" \
      --filter "label=com.docker.compose.network=$net" | head -1)"
  fi
  [[ -n "$net_id" ]] || { echo "нет сети $net проекта $PROJECT"; return 1; }
  PSEUDONYMIZER_API_TOKEN="$(env_value "$RUN_DIR/rehearsal.env" PSEUDONYMIZER_API_TOKEN)" \
    docker run --rm --network "$net_id" --read-only --tmpfs /tmp:size=16m --cap-drop ALL \
    --security-opt no-new-privileges:true --memory "$REH_ONESHOT_MEM" \
    -e PSEUDONYMIZER_API_TOKEN "$@" --entrypoint bun "$(lock_value BAI_IMAGE_APP)" -e "$js" 2>&1
}

# Проверки псевдонимизатора: /health и маскирование на выдуманном тексте. Только его контейнер и
# одноразовый клиент; app не участвует.
check_pseudonymizer() {
  local health smoke
  health="$(reh_oneshot pseudonymizer-net "$HEALTH_JS" || true)"
  if [[ "$health" == 200* ]]; then
    check "/health псевдонимизатора" ok "$health"
  else
    check "/health псевдонимизатора" fail "${health:0:120}"
  fi
  smoke="$(reh_oneshot pseudonymizer-net "$SMOKE_JS" -e SMOKE_TEXT="$SMOKE_TEXT" \
    -e SMOKE_THREAD="$SMOKE_THREAD" || true)"
  if [[ "$smoke" == *"masked=true restored=true"* ]]; then
    check "маскирование и восстановление" ok "выдуманный текст маскируется и восстанавливается"
  else
    check "маскирование и восстановление" fail "${smoke:0:160}"
  fi
}

# Проверка чтения внутри контейнера СЕРВИСА compose (его uid, его монтирования и env):
# reh_service_reads <сервис> <аргументы скрипта: `@ПЕРЕМЕННАЯ` или путь>...
reh_service_reads() {
  local svc="$1"
  shift
  dc run --rm --no-deps -T --entrypoint sh "$svc" -c "$REH_READ_SCRIPT" sh "$@" 2>>"$LOG_FILE"
}

# Условия старта app, которые репетиция обеспечивает файлами: переменные-пути (читаются при
# старте ядром) и монтирования overlay. Нарушение - отдельный понятный отказ до старта app.
check_app_files() {
  local out
  if out="$(reh_service_reads app "${APP_PATH_VARS[@]}" "${APP_MOUNT_PATHS[@]}")"; then
    check "файлы app читаются его uid" ok "$(printf '%s' "$out" | tr '\n' ';' | cut -c1-200)"
    return 0
  fi
  check "файлы app читаются его uid" fail \
    "$(printf '%s' "$out" | grep -v ' ok$' | tr '\n' ';' | cut -c1-300)"
  return 1
}

# Сухой запуск ядра (`--once`): тот же образ, uid, монтирования и env, что у службы. Проходит
# сборку конфигурации (env, файл правил доступа и его схема, реестр агентов), не трогает БД и не
# открывает порт. Падение даёт точное имя нарушенной переменной в сообщении ядра (в нём нет
# значений) вместо цикла перезапусков. В результаты идут только статус и имена агентов.
check_app_once() {
  local out rc=0 agents
  out="$(dc run --rm --no-deps -T app bun run src/main.ts --once 2>"$WORK/app-once.err")" || rc=$?
  if ((rc != 0)); then
    check "сухой запуск app (--once)" fail \
      "код $rc: $(tail -1 "$WORK/app-once.err" | cut -c1-240)"
    tail -3 "$WORK/app-once.err" | cut -c1-240 >"$RES/app-once-error.txt"
    return 1
  fi
  # Сводка: имена агентов из JSON-строки ядра и совпадение с ожидаемым составом.
  agents="$(printf '%s\n' "$out" | python3 -I -c '
import json, sys
expected = sorted(sys.argv[1].split())
for line in sys.stdin:
    try:
        d = json.loads(line)
    except ValueError:
        continue
    if "agents" in d:
        got = sorted(d["agents"])
        print(("ok " if got == expected else "diff ") + " ".join(got))
        break' "$EXPECTED_AGENT_NAMES")"
  if [[ "$agents" == ok* ]]; then
    check "сухой запуск app (--once)" ok "конфигурация и правила доступа приняты: ${agents#ok }"
  else
    check "сухой запуск app (--once)" fail \
      "агенты: ${agents#diff }; ожидались: $EXPECTED_AGENT_NAMES"
    return 1
  fi
}

# Диагностика отказа app: что видит процесс контейнера. Только пути, uid:gid, права, коды;
# содержимое файлов не читается. Файл проходит leak-scan вместе с остальными результатами.
collect_app_diagnostics() {
  local out="$RES/app-diagnostics.txt" name="$PROJECT-app-1"
  {
    echo "# контейнер app: статус, код выхода, OOM, число перезапусков, ошибка Docker"
    docker inspect -f "$APP_STATE_FORMAT" "$name" 2>&1 || echo "контейнера нет"
    echo "# процесс app и смонтированные пути (путь uid:gid режим тип)"
    # shellcheck disable=SC2016 # переменные раскрывает sh внутри контейнера
    dc run --rm --no-deps -T --entrypoint sh app -c '
      echo "uid:gid процесса $(id -u):$(id -g)"
      f="$ACCESS_POLICY_FILE"
      for p in "$f" "$(dirname "${f:-/}")" "$@"; do
        [ -n "$p" ] && stat -L -c "%n %u:%g %a %F" "$p" 2>&1 | cut -c1-200
      done
      [ -n "$f" ] && ls -ln "$(dirname "$f")" 2>&1 | head -20 | cut -c1-200
      exit 0' sh "${APP_MOUNT_PATHS[@]}" 2>>"$LOG_FILE" || echo "диагностика контейнером не снята"
  } >"$out" 2>&1
}

start_services() {
  phase "старт псевдонимизатора и app"
  local svc app_ok=0
  # 1. Псевдонимизатор и заглушка шлюза: app стартует только после проверок их файлов и сети.
  if ! dc up -d pseudonymizer model-stub >>"$LOG_FILE" 2>&1; then
    for svc in pseudonymizer model-stub; do capture_failure_log "$svc"; done
    check "старт стека" fail "compose up не удался (failure-<сервис>.txt)"
    die "$EXIT_FAILED" "стек не стартовал"
  fi
  for svc in pseudonymizer model-stub; do
    if wait_healthy "$svc" "$READY_WAIT_S"; then
      check "сервис $svc" ok "healthy"
    else
      check "сервис $svc" fail "не стал healthy за ${READY_WAIT_S} с"
      capture_failure_log "$svc"
    fi
  done
  # 2. Проверки псевдонимизатора не зависят от app.
  check_pseudonymizer
  # 3. Файлы app до старта: понятный отказ с именем переменной, а не цикл перезапусков.
  if check_app_files && check_app_once; then
    if ! dc up -d app >>"$LOG_FILE" 2>&1; then
      capture_failure_log app
      check "старт app" fail "compose up app не удался (failure-app.txt)"
    elif wait_healthy app "$READY_WAIT_S"; then
      check "сервис app" ok "healthy"
      app_ok=1
    else
      check "сервис app" fail "не стал healthy за ${READY_WAIT_S} с (app-diagnostics.txt)"
      capture_failure_log app
    fi
  else
    check "сервис app" fail "не запускался: условия старта не выполнены (см. проверки выше)"
  fi
  ((app_ok)) || collect_app_diagnostics
  # 4. /ready приложения: из одноразового контейнера по сети backend.
  local body
  body="$(reh_oneshot "container:$PROJECT-app-1" "$READY_JS" || true)"
  if [[ "$body" == 200* ]]; then
    check "/ready app" ok "$body"
  else
    check "/ready app" fail "ответ: ${body:0:120}"
  fi
  sleep "$SETTLE_S"
  inspect_app_log
  phase_end
}

inspect_app_log() {
  dc logs --no-log-prefix app >"$WORK/app.log" 2>&1 || true
  python3 -I - "$WORK/app.log" "$RES" "$EXPECTED_AGENTS" "$EXPECTED_AGENT_NAMES" <<'PY'
import collections, json, pathlib, sys

log_path, res = sys.argv[1], pathlib.Path(sys.argv[2])
expected, names = int(sys.argv[3]), sys.argv[4].split()
startup = None
events = collections.Counter()
raw_errors = 0
for line in open(log_path, encoding="utf-8", errors="replace"):
    line = line.strip()
    if not line:
        continue
    try:
        item = json.loads(line)
    except ValueError:
        raw_errors += 1
        continue
    if startup is None and "agents" in item and "status" in item:
        startup = item
    level = item.get("level") or item.get("severity")
    if level in ("error", "warn", "warning"):
        events[(level, item.get("event", "?"))] += 1
rows = ["уровень\tсобытие\tчисло"]
rows += [f"{k[0]}\t{k[1]}\t{v}" for k, v in sorted(events.items())]
(res / "app-log-events.tsv").write_text("\n".join(rows) + "\n", encoding="utf-8")
agents = (startup or {}).get("agents", [])
(res / "app-startup.json").write_text(
    json.dumps({"status": (startup or {}).get("status"), "agents": agents,
                "warnings": (startup or {}).get("warnings", [])},
               ensure_ascii=False, indent=1) + "\n",
    encoding="utf-8")
ok = len(agents) == expected and sorted(agents) == sorted(names)
errors = sum(v for k, v in events.items() if k[0] == "error")
(res / "app-log-summary.txt").write_text(
    f"агентов {len(agents)}: {' '.join(agents)}\n"
    f"строк не JSON: {raw_errors}\nсобытий error: {errors}\n",
    encoding="utf-8")
sys.exit(0 if ok else 1)
PY
  local agents_rc=$?
  if ((agents_rc == 0)); then
    check "реестр агентов" ok "агентов $EXPECTED_AGENTS: $EXPECTED_AGENT_NAMES"
  else
    check "реестр агентов" fail \
      "ожидалось $EXPECTED_AGENTS ($EXPECTED_AGENT_NAMES): $(head -1 "$RES/app-log-summary.txt")"
  fi
  local raw errors
  raw="$(sed -n 's/^строк не JSON: //p' "$RES/app-log-summary.txt")"
  errors="$(sed -n 's/^событий error: //p' "$RES/app-log-summary.txt")"
  if [[ "${raw:-0}" == 0 && "${errors:-0}" == 0 ]]; then
    check "журнал app" ok "ошибок и строк не в JSON нет"
  elif [[ "${raw:-0}" != 0 ]]; then
    check "журнал app" fail "строк не в JSON (ошибка запуска): $raw; событий error: ${errors:-0}"
  else
    check "журнал app" warn "событий уровня error: $errors (app-log-events.tsv)"
  fi
}

# ---------------------------------------------------------------------------------------------
# Ход
# ---------------------------------------------------------------------------------------------
main() {
  log "Репетиция $RUN_ID: проект $PROJECT, бой $BATTLE_PROJECT, лёгкий режим"
  exec 9>"$REHEARSAL_HOME/lock"
  flock -n 9 || refuse "уже идёт другая репетиция ($REHEARSAL_HOME/lock)"
  preflight
  snapshot_battle "$RES/battle-before.txt"
  [[ -s "$RES/battle-before.txt" ]] || log "снимок боя пуст (нет контейнеров с меткой проекта)"
  audit_old_tree_units
  if ((PREFLIGHT_ONLY)); then
    log "флаг --preflight-only: предусловия пройдены, дальше не иду"
    return 0
  fi
  run_battle_backup
  prepare_dump
  prepare_inputs
  restore_database
  copy_pseudonymizer_store
  start_services
}
main
