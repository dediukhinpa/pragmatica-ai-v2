#!/usr/bin/env bash
# Переключение боя Прагматики на v2 (КРАСНАЯ ЗОНА: запускает только владелец, шлюз G7).
#
# Использование:
#   bash cutover.sh [--signatures-verified ФАЙЛ] [--images-tar ФАЙЛ] [--config ФАЙЛ]
#                   [--out-dir КАТАЛОГ] [--soak-seconds N] [--expected-bots N]
#                   [--preflight-only] [--help]
#
# Что делает (бой = compose-проект `pragmatika`, имена контейнеров, томов и сетей не меняются):
#   0. Предусловия, бой не меняется: целостность пакета, FREEZE_SRC, подписи ВСЕХ образов из
#      images.lock (cosign на хосте с cosign.pub либо --signatures-verified: вывод
#      verify-signatures.sh; молча пропускать нельзя), свободные диск и память, бой здоров
#      (/ready 200, ботов не меньше ожидаемого), образы прежних контейнеров на месте, боевой .env
#      (пять *_HOST_DIR и ACCESS_POLICY_FILE как у владельца, ни одного ключа образа), каталоги и
#      права файлов app, сухой запуск app --once, тома боя пишутся uid app, `migrate --plan` на
#      живой базе: ровно ожидаемые миграции (expected-pending.txt) и 45 applied-by-legacy.
#   1. Бэкап (бой остановлен только по записи: app и indexer): штатный backup.sh --verify, дамп
#      БД pg_dump -Fc (для rollback.sh --restore-db), .env и secrets.env (600), архив
#      /opt/pragmatika без local/, архив тома pseudonymizer-data, список образов и контейнеров.
#      Всё в ~/backups/pragmatika-before-v2-<время>.
#   2. Остановка прежних контейнеров (образы остаются: по ним работает откат).
#   3. v2: postgres -> `migrate --plan` -> migrate -> прочие сервисы по одному (health после
#      каждого) -> app последним. Каталог v2: /opt/pragmatika-v2/deploy (compose, images.lock,
#      боевой .env без снятых имён, ссылка на secrets.env).
#   4. Проверки: /ready, ботов не меньше ожидаемого, журнал app без ошибок, образы запущенных
#      контейнеров = images.lock, метрики идут, затем выдержка (по умолчанию 10 минут): контейнеры
#      не перезапускаются, /ready зелёный, активные алерты (если задан CUTOVER_ALERTS_URL).
#   Любой сбой после начала изменений -> автоматический rollback.sh и код выхода не 0.
# Результат: ~/cutover-<время>.tgz (журнал, проверки, digest; без секретов и данных) - вернуть в
# stage-8/results/.
#
# Коды выхода: 0 - переключение выполнено и проверено; 1 - сбой, откат выполнен (бой на прежних
# образах); 2 - неверный вызов; 3 - отказ по предусловиям, бой не тронут; 4 - сбой, откат тоже не
# удался (нужно ручное вмешательство, см. журнал и CHECKLIST.md).
set -euo pipefail
umask 077

# ---------------------------------------------------------------------------------------------
# Константы
# ---------------------------------------------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HERE/stack/deploy/compose.yml" ]]; then
  STACK="$HERE/stack" # пакет
else
  STACK="$(cd "$HERE/../.." && pwd)" # дерево проекта v2
fi
# shellcheck source=lib.sh
source "$HERE/lib.sh"
# shellcheck source=../rehearsal/rehearse-files.sh
source "$STACK/deploy/rehearsal/rehearse-files.sh"

# Коммит старого репозитория, зафиксированный этапом 7 (последняя синхронизация, заморозка G5).
EXPECTED_FREEZE_SRC="5ea7f2d308beb476fb8b6fe05e095587c9ee4f40"
# Ожидаемый вид плана миграций на боевой базе (7r): сколько записей переведено по карте.
EXPECTED_LEGACY=45
MIN_COMPOSE_VERSION="2.24"
DEFAULT_SOAK_S=600
SOAK_POLL_S=${CUTOVER_SOAK_POLL_S:-30}
STOP_TIMEOUT_S=120
# Запас диска под дамп и архивы относительно размера БД (дамп -Fc сжат, backup.sh пишет ещё и
# собственный архив): как в репетиции, втрое.
DISK_FACTOR_FOR_DB=3
BACKUP_PREFIX="pragmatika-before-v2"
DEPLOYED_MARK=".cutover-deployed"
APP_EXPECTED_AGENTS="documents order-calc prices site-export"
APP_PATH_VARS=(@ACCESS_POLICY_FILE @MODEL_PRICES_FILE @MAIL_MAILBOXES_FILE)
APP_MOUNT_PATHS=(/etc/pragmatika/access /etc/pragmatika/mail /srv/documents /srv/templates
  /opt/pragmatika/local /var/lib/pragmatika/intake /var/lib/pragmatika/spool
  /var/lib/pragmatika/exchange)
# Тома боя, в которые app пишет (образ v2 не создаёт /var/lib/pragmatika/*, права берутся от тома).
APP_WRITE_VOLUMES=(intake-data file-spool documents-exchange)
# Скрипт внутри контейнера app: пишет ли его uid (с группами) в смонтированный том.
APP_WRITE_SCRIPT='p="$1"
[ -d "$p" ] || { echo "нет каталога"; exit 2; }
set -- $(stat -c "%u %g %a" "$p"); ou=$1; og=$2; mode=$3; bits=$((0$mode)); w=0
[ "$ou" = "$(id -u)" ] && [ $((bits & 0200)) -ne 0 ] && w=1
for g in $(id -G); do [ "$og" = "$g" ] && [ $((bits & 020)) -ne 0 ] && w=1; done
[ $((bits & 02)) -ne 0 ] && w=1
echo "владелец $ou:$og режим $mode, uid app пишет: $([ $w = 1 ] && echo да || echo нет)"
[ $w = 1 ]'
# Каталоги и файл правил, которые боевой .env обязан задавать (пути хоста владельца, 7f3).
REQUIRED_ENV_NAMES=(ACCESS_POLICY_HOST_DIR TEMPLATES_HOST_DIR DOCUMENTS_HOST_DIR MAIL_HOST_DIR
  ACCESS_POLICY_FILE)
# Пятый каталог: на бою может не быть в .env (умолчание compose v2); тогда в .env v2 он
# записывается явно этим значением.
LOCAL_HOST_DIR_NAME="LOCAL_HOST_DIR"
LOCAL_HOST_DIR_DEFAULT="/opt/pragmatika/local"
SPEECH_DROP_RE='^SPEECH_MODEL_(REPO|REVISION)$'
# Каталоги и файлы пакета (в пакете лежат рядом, в дереве проекта - в своих каталогах).
pkg_file() { # pkg_file <имя в пакете> <путь в дереве проекта>
  if [[ -e "$HERE/$1" ]]; then printf '%s' "$HERE/$1"; else printf '%s' "$STACK/$2"; fi
}
LOCK_SRC="$(pkg_file images.lock deploy/images.lock)"
COSIGN_PUB="$(pkg_file cosign.pub deploy/cosign.pub)"
EXPECTED_PENDING="$(pkg_file expected-pending.txt deploy/rehearsal/expected-pending.txt)"
EXPECTED_HOST_DIRS="$(pkg_file expected-host-dirs.txt deploy/cutover/expected-host-dirs.txt)"
ENV_RETIRED="$STACK/deploy/rehearsal/env-retired.txt"
SCHEMA_EXPECTED="$HERE/schema-expected.sql"
SCHEMA_TOOL="$HERE/tools/check_migrations_schema.py"
[[ -f "$SCHEMA_TOOL" ]] || SCHEMA_TOOL="$STACK/tools/check_migrations_schema.py"
DOWN_SQL="$STACK/db/app/rollback/026_down.sql"

# ---------------------------------------------------------------------------------------------
# Аргументы и настройка
# ---------------------------------------------------------------------------------------------
SIGNATURES_FILE=""
IMAGES_TAR=""
CONFIG_FILE=""
SOAK_S="$DEFAULT_SOAK_S"
PREFLIGHT_ONLY=0
EXPECT_BOTS_ARG=""
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
while (($#)); do
  case "$1" in
    --signatures-verified) SIGNATURES_FILE="${2:?--signatures-verified ФАЙЛ}"; shift ;;
    --images-tar) IMAGES_TAR="${2:?--images-tar ФАЙЛ}"; shift ;;
    --config) CONFIG_FILE="${2:?--config ФАЙЛ}"; shift ;;
    --out-dir) CUTOVER_OUT_DIR="${2:?--out-dir КАТАЛОГ}"; shift ;;
    --soak-seconds) SOAK_S="${2:?--soak-seconds N}"; shift ;;
    --expected-bots) EXPECT_BOTS_ARG="${2:?--expected-bots N}"; shift ;;
    --preflight-only) PREFLIGHT_ONLY=1 ;;
    --help | -h) usage; exit "$EXIT_OK" ;;
    *) echo "неизвестный аргумент: $1" >&2; usage >&2; exit "$EXIT_USAGE" ;;
  esac
  shift
done
[[ -z "$CONFIG_FILE" ]] || cut_load_config "$CONFIG_FILE" || exit "$EXIT_USAGE"
[[ -z "$EXPECT_BOTS_ARG" ]] || CUTOVER_EXPECT_BOTS="$EXPECT_BOTS_ARG"
cut_defaults
[[ -z "$CUTOVER_EXPECTED_HOST_DIRS" ]] || EXPECTED_HOST_DIRS="$CUTOVER_EXPECTED_HOST_DIRS"
[[ "$SOAK_S" =~ ^[0-9]+$ ]] || { echo "--soak-seconds: нужно число" >&2; exit "$EXIT_USAGE"; }

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$CUTOVER_HOME"
cut_init_run "$CUTOVER_HOME/run-$RUN_ID"
ln -sfn "$RUN_DIR" "$CUTOVER_HOME/latest"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ARCHIVE_PATH=""
ROLLED_BACK=0

die() { # die <код> <сообщение>
  log "ОШИБКА: $2"
  state_set RESULT "FAILED: $2"
  exit "$1"
}

# Настройка запуска сохраняется для rollback.sh (без секретов: только пути и числа).
save_config() {
  local name
  : >"$RUN_DIR/cutover.conf"
  for name in $(compgen -v CUTOVER_); do
    [[ "$name" =~ ^CUTOVER_(ALERTS_URL|SECRETS_DIR)?$ ]] && continue
    printf '%s=%s\n' "$name" "${!name}" >>"$RUN_DIR/cutover.conf"
  done
  printf 'CUTOVER_ALERTS_URL=%s\n' "$CUTOVER_ALERTS_URL" >>"$RUN_DIR/cutover.conf"
  [[ -z "${CUTOVER_SECRETS_DIR:-}" ]] \
    || printf 'CUTOVER_SECRETS_DIR=%s\n' "$CUTOVER_SECRETS_DIR" >>"$RUN_DIR/cutover.conf"
}

# ---------------------------------------------------------------------------------------------
# Итог и уборка (всегда, при любом выходе)
# ---------------------------------------------------------------------------------------------
# Список значений секретов для маскирования журнала и проверки утечек в архиве.
collect_secret_values() {
  local secrets_dir file
  secrets_dir="${CUTOVER_SECRETS_DIR:-$(env_value "$CUTOVER_ENV_FILE" SECRETS_DIR)}"
  secrets_dir="${secrets_dir:-/etc/pragmatika/secrets}"
  CUTOVER_SECRETS_DIR="$secrets_dir"
  for file in "$CUTOVER_ENV_FILE" "$secrets_dir/secrets.env"; do
    [[ -f "$file" ]] || continue
    python3 -I - "$file" "$MIN_SECRET_LEN" >>"$SECRETS_LIST" <<'PY'
import re, sys
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    if "=" not in line or line.lstrip().startswith("#"):
        continue
    name, raw = line.split("=", 1)
    if not re.search(r"(KEY|TOKEN|PASSWORD|SECRET)", name):
        continue
    raw = raw.strip()
    if raw[:1] in "'\"" and raw[-1:] == raw[:1]:
        raw = raw[1:-1]
    if len(raw) >= int(sys.argv[2]):
        print(raw)
PY
  done
}

# Архив результатов ~/cutover-<время>.tgz: журнал, проверки, выводы планов, digest. Значения
# секретов в архиве не допускаются: при находке архив удаляется.
finish_results() {
  local files
  cp "$STATE_FILE" "$RES/state.env" 2>/dev/null || true
  grep -vE '^(CUTOVER_ALERTS_URL)=' "$RES/state.env" >"$RES/state.env.tmp" 2>/dev/null \
    && mv "$RES/state.env.tmp" "$RES/state.env" || true
  ARCHIVE_PATH="$CUTOVER_OUT_DIR/cutover-$RUN_ID.tgz"
  tar -C "$RUN_DIR" -czf "$ARCHIVE_PATH" results 2>/dev/null || { ARCHIVE_PATH=""; return 0; }
  if [[ -s "$SECRETS_LIST" ]] && files="$(mktemp -d "$WORK/leak.XXXXXX")"; then
    tar -C "$files" -xzf "$ARCHIVE_PATH"
    if grep -rIqF -f <(awk 'length($0) >= '"$MIN_SECRET_LEN" "$SECRETS_LIST") "$files"; then
      rm -f "$ARCHIVE_PATH"
      ARCHIVE_PATH=""
      echo "ОШИБКА: в архиве результатов найдено значение секрета, архив удалён" >&2
    fi
  fi
}

on_exit() {
  local rc=$?
  trap - EXIT INT TERM
  set +e
  if ((rc != EXIT_OK && rc != EXIT_REFUSED && rc != EXIT_USAGE)); then
    if [[ "$(state_get QUIESCED)" == 1 && "$ROLLED_BACK" != 1 ]]; then
      log "СБОЙ: запускаю автоматический откат (rollback.sh)"
      ROLLED_BACK=1
      if bash "$HERE/rollback.sh" --run-dir "$RUN_DIR" --auto; then
        rc="$EXIT_FAILED"
      else
        rc="$EXIT_STUCK"
        log "ОТКАТ НЕ УДАЛСЯ: нужно ручное вмешательство (rollback.log, CHECKLIST.md)"
      fi
    fi
  fi
  finish_results
  if [[ "$rc" == "$EXIT_OK" ]]; then
    log "ГОТОВО: v2 на бою проверен. Архив результатов: ${ARCHIVE_PATH:-не создан}"
  else
    log "ЗАВЕРШЕНО С КОДОМ $rc. Архив результатов: ${ARCHIVE_PATH:-не создан}"
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

# refuse <сообщение>: отказ по предусловиям, бой не тронут.
refuse() {
  check "предусловия" fail "$*"
  if [[ "$(state_get QUIESCED)" == 1 ]]; then
    die "$EXIT_FAILED" "$*" # изменения уже начались: нужен откат, а не отказ
  fi
  die "$EXIT_REFUSED" "отказ: $*"
}

# ---------------------------------------------------------------------------------------------
# 0. Предусловия
# ---------------------------------------------------------------------------------------------
dir_free_mib() { df -Pm "$1" 2>/dev/null | awk 'NR == 2 { print $4 }'; }
mem_available_mib() { awk '/^MemAvailable:/ { print int($2 / '"$KIB_PER_MIB"') }' /proc/meminfo; }

version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }

check_sources() {
  phase "целостность пакета и источников"
  local frozen
  if [[ -f "$HERE/MANIFEST.sha256" ]]; then
    (cd "$HERE" && sha256sum -c --quiet MANIFEST.sha256) >>"$LOG_FILE" 2>&1 \
      || refuse "MANIFEST.sha256 не сходится: пакет повреждён или изменён"
    check "целостность пакета" ok "MANIFEST.sha256 сходится"
  else
    check "целостность пакета" warn "MANIFEST.sha256 нет (запуск из дерева проекта)"
  fi
  if [[ -f "$HERE/FREEZE_SRC" ]]; then
    frozen="$(tr -d '[:space:]' <"$HERE/FREEZE_SRC")"
  else
    frozen="$(sed -n 's/^- Коммит старого репозитория: `\([0-9a-f]\{40\}\)`.*/\1/p' \
      "$STACK/tools/last-sync.md" 2>/dev/null | head -1)"
  fi
  [[ "$frozen" == "$EXPECTED_FREEZE_SRC" ]] \
    || refuse "FREEZE_SRC пакета (${frozen:-нет}) не равен FREEZE_SRC этапа 7" \
      "($EXPECTED_FREEZE_SRC)"
  check "FREEZE_SRC" ok "${frozen:0:8}, как в этапе 7"
  [[ -f "$LOCK_SRC" ]] || refuse "нет images.lock пакета"
  cut_lock_format "$LOCK_SRC" || refuse "images.lock не в формате платформы (только digest)"
  [[ -f "$DOWN_SQL" ]] || refuse "нет db/app/rollback/026_down.sql: откат БД невозможен"
  check "images.lock и 026_down.sql" ok "формат верен, откат БД есть в пакете"
}

# Подпись ВСЕХ образов lock. Молча пропускать нельзя: нет cosign и нет подтверждения - отказ.
check_signatures() {
  phase "подписи образов"
  local key ref msg failed=0
  if command -v "$CUTOVER_COSIGN" >/dev/null 2>&1 && [[ -f "$COSIGN_PUB" ]]; then
    while read -r key ref; do
      if "$CUTOVER_COSIGN" verify --key "$COSIGN_PUB" --insecure-ignore-tlog=true "$ref" \
        >>"$LOG_FILE" 2>&1; then
        log "подпись $key: OK"
      else
        log "подпись $key: НЕ ПРОШЛА"
        failed=$((failed + 1))
      fi
    done < <(lock_images "$LOCK_SRC")
    ((failed == 0)) || refuse "cosign verify не прошёл у $failed образов"
    check "подписи образов" ok "cosign verify на хосте: все образы lock"
    state_set SIGNATURES "cosign на хосте"
    return 0
  fi
  [[ -n "$SIGNATURES_FILE" ]] \
    || refuse "нет cosign или cosign.pub и не передан --signatures-verified ФАЙЛ" \
      "(вывод verify-signatures.sh с Fornex); проверку подписей пропускать нельзя"
  [[ -f "$SIGNATURES_FILE" ]] || refuse "нет файла $SIGNATURES_FILE"
  if msg="$(cut_check_signatures_file "$SIGNATURES_FILE" "$LOCK_SRC" "$COSIGN_PUB")"; then
    check "подписи образов" ok "по подтверждению verify-signatures.sh: $msg"
    state_set SIGNATURES "подтверждение $(sha256sum "$SIGNATURES_FILE" | cut -c1-16)"
  else
    refuse "подтверждение подписей не принято: $msg"
  fi
}

# Секреты боя для маскирования журнала, .env боя на запрещённые ключи и обязательные пути.
check_battle_env() {
  phase "боевой .env"
  [[ -f "$CUTOVER_ENV_FILE" ]] || refuse "нет боевого .env: $CUTOVER_ENV_FILE"
  local name expected key value host bad=()
  collect_secret_values
  while IFS= read -r line; do
    key="${line%%=*}"
    key="${key#export }"
    [[ "$key" =~ $LOCK_KEYS_RE ]] && bad+=("$key")
  done < <(grep -E '^[[:space:]]*(export )?[A-Z][A-Z0-9_]*=' "$CUTOVER_ENV_FILE" || true)
  ((${#bad[@]} == 0)) || refuse "в .env ключи, перекрывающие образы lock: ${bad[*]}"
  for name in "${REQUIRED_ENV_NAMES[@]}"; do
    value="$(env_value "$CUTOVER_ENV_FILE" "$name")"
    [[ -n "$value" ]] || refuse "в боевом .env не задано $name (берётся боевой .env, не пример)"
    expected="$(grep -E "^$name=" "$EXPECTED_HOST_DIRS" 2>/dev/null | head -1 \
      | cut -d= -f2- || true)"
    if [[ -n "$expected" && "$value" != "$expected" ]]; then
      refuse "$name=$value, а по выводу владельца ожидается $expected"
    fi
    if [[ "$name" == *_HOST_DIR ]]; then
      [[ -d "$value" ]] || refuse "каталог $name не существует: $value"
    fi
  done
  host="$(env_value "$CUTOVER_ENV_FILE" ACCESS_POLICY_HOST_DIR)/$(basename \
    "$(env_value "$CUTOVER_ENV_FILE" ACCESS_POLICY_FILE)")"
  [[ -e "$host" ]] || refuse "файл правил доступа не найден на хосте: $host"
  for name in PRICES_UNVERIFIED_SENDER_POLICY SITE_PUBLISH_ENABLED SPEECH_MODEL_REPO \
    SPEECH_MODEL_REVISION; do
    [[ -z "$(env_value "$CUTOVER_ENV_FILE" "$name")" ]] || log "имя $name будет снято в .env v2"
  done
  value="$(env_value "$CUTOVER_ENV_FILE" DOCUMENTS_IMAGE_TEXT_DETECT_ROTATION)"
  if [[ "$value" == true ]]; then
    check "поворот/OSD фото" warn "в боевом .env DOCUMENTS_IMAGE_TEXT_DETECT_ROTATION=true," \
      "а на бою решено оставить выключенным (по умолчанию v2: false)"
  fi
  value="$(env_value "$CUTOVER_ENV_FILE" "$LOCAL_HOST_DIR_NAME")"
  value="${value:-$LOCAL_HOST_DIR_DEFAULT}"
  [[ -d "$value" ]] || refuse "каталог $LOCAL_HOST_DIR_NAME не существует: $value"
  check "боевой .env" ok "пять *_HOST_DIR и ACCESS_POLICY_FILE как у владельца, ключей образов нет"
}

check_resources() {
  phase "ресурсы и инструменты"
  local cmd db_bytes need_mib free_backup free_docker docker_root mem version
  for cmd in docker python3 tar sha256sum gzip; do
    command -v "$cmd" >/dev/null 2>&1 || refuse "нет команды $cmd"
  done
  version="$(docker compose version --short 2>/dev/null || true)"
  version_ge "${version#v}" "$MIN_COMPOSE_VERSION" \
    || refuse "нужен docker compose не старше $MIN_COMPOSE_VERSION (на хосте: ${version:-нет})"
  [[ -f "$CUTOVER_BACKUP_SCRIPT" ]] || refuse "нет штатного backup.sh: $CUTOVER_BACKUP_SCRIPT"
  [[ -f "$CUTOVER_OLD_COMPOSE" ]] || refuse "нет прежнего compose: $CUTOVER_OLD_COMPOSE"
  db_bytes="$(docker exec "$CUTOVER_PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -Atc \
    'SELECT pg_database_size(current_database())' 2>/dev/null || echo 0)"
  [[ "$db_bytes" =~ ^[0-9]+$ && "$db_bytes" -gt 0 ]] \
    || refuse "не удалось узнать размер БД в $CUTOVER_PG_CONTAINER"
  state_set DB_BYTES "$db_bytes"
  mkdir -p "$CUTOVER_BACKUP_ROOT"
  need_mib=$((db_bytes * DISK_FACTOR_FOR_DB / MIB + CUTOVER_MIN_DISK_MIB))
  free_backup="$(dir_free_mib "$CUTOVER_BACKUP_ROOT")"
  docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  free_docker="$(dir_free_mib "$docker_root")"
  mem="$(mem_available_mib)"
  if ((free_backup < need_mib)); then
    refuse "мало места под бэкапы в $CUTOVER_BACKUP_ROOT: свободно $free_backup МиБ," \
      "нужно $need_mib"
  fi
  if ((free_docker < CUTOVER_MIN_DISK_MIB)); then
    refuse "мало места под образы в $docker_root: свободно $free_docker МиБ"
  fi
  if ((mem < CUTOVER_MIN_AVAILABLE_MIB)); then
    refuse "мало доступной памяти: $mem МиБ, нужно не меньше $CUTOVER_MIN_AVAILABLE_MIB"
  fi
  check "ресурсы" ok "БД $((db_bytes / MIB)) МиБ, диск бэкапов $free_backup МиБ" \
    "(нужно $need_mib)," \
    "диск docker $free_docker МиБ, память $mem МиБ"
}

# Бой здоров: все контейнеры проекта работают, app отвечает /ready, ботов достаточно.
check_battle_health() {
  phase "бой здоров до начала"
  local names state bots
  mapfile -t names < <(project_containers)
  ((${#names[@]} > 0)) || refuse "контейнеров проекта $CUTOVER_PROJECT нет: бой не запущен"
  for state in "${names[@]}"; do
    [[ "$(docker inspect -f '{{.State.Status}}' "$state")" == running ]] \
      || refuse "контейнер $state не работает: бой не здоров, переключение не начинаем"
  done
  READY_BODY="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
  [[ "$READY_BODY" == 200* ]] || refuse "/ready боя не 200: ${READY_BODY:0:120}"
  bots="$(ready_bots "$READY_BODY")"
  ((bots >= CUTOVER_EXPECT_BOTS)) \
    || refuse "bitrix24_bot_ready = $bots, ожидается не меньше $CUTOVER_EXPECT_BOTS"
  state_set BOTS_BEFORE "$bots"
  state_set MAIL_BEFORE "$(mail_summary "$READY_BODY")"
  state_set BATTLE_CONTAINERS "${names[*]}"
  if [[ "$READY_BODY" == *'"unconfigured"'* ]]; then
    check "почта боя" warn "mail.state = unconfigured на бою до переключения"
  fi
  check "бой здоров" ok "контейнеров ${#names[@]}, /ready 200, ботов $bots"
}

# Снимок прежних контейнеров и образов: по нему проверяется откат. Образы должны быть на месте.
# Формат docker inspect для снимка контейнеров (поля через табуляцию).
SNAP_FORMAT='{{.Name}}{{"\t"}}{{.Id}}{{"\t"}}{{.State.Status}}{{"\t"}}{{.State.StartedAt}}'
SNAP_FORMAT+='{{"\t"}}{{.RestartCount}}{{"\t"}}{{.Image}}{{"\t"}}{{.Config.Image}}'
snapshot_old() { # snapshot_old <каталог>
  local dir="$1" name
  mkdir -p "$dir"
  : >"$dir/containers-before.tsv"
  : >"$dir/images-before.tsv"
  while read -r name; do
    docker inspect -f "$SNAP_FORMAT" "$name" | sed 's|^/||' >>"$dir/containers-before.tsv"
  done < <(project_containers)
  cut -f6 "$dir/containers-before.tsv" | sort -u | while read -r image; do
    printf '%s\t%s\n' "$image" \
      "$(docker image inspect -f '{{join .RepoTags ","}}' "$image" 2>/dev/null || echo ?)"
  done >"$dir/images-before.tsv"
}

check_old_images() {
  local image missing=()
  snapshot_old "$RES"
  while IFS=$'\t' read -r image _; do
    docker image inspect "$image" >/dev/null 2>&1 || missing+=("${image:0:19}")
  done <"$RES/images-before.tsv"
  ((${#missing[@]} == 0)) || refuse "образы прежних контейнеров отсутствуют (откат невозможен):" \
    "${missing[*]}"
  check "образы прежних контейнеров" ok "$(wc -l <"$RES/images-before.tsv") образов на месте"
}

# Образы lock, нужные стеку, должны быть локально по digest: загрузка из архива или pull.
ensure_images() {
  phase "образы v2"
  local ref refs
  if [[ -n "$IMAGES_TAR" ]]; then
    [[ -f "$IMAGES_TAR" ]] || refuse "нет архива образов $IMAGES_TAR"
    log "загружаю образы из $IMAGES_TAR"
    docker load -i "$IMAGES_TAR" >>"$LOG_FILE" 2>&1 || refuse "docker load не удался"
  fi
  mapfile -t refs < <(dc_new --profile tools config --images 2>/dev/null | sort -u)
  ((${#refs[@]} > 0)) || refuse "compose не вернул список образов (docker compose config --images)"
  for ref in "${refs[@]}"; do
    [[ "$ref" == *@sha256:* ]] \
      || refuse "образ $ref без digest: стек идёт только из images.lock"
    if ! docker image inspect "$ref" >/dev/null 2>&1; then
      log "образ ${ref##*/} не найден локально, docker pull"
      docker pull "$ref" >>"$LOG_FILE" 2>&1 \
        || refuse "образ ${ref##*/} не найден: docker login или --images-tar"
    fi
  done
  printf '%s\n' "${refs[@]}" >"$RES/images-v2.txt"
  check "образы v2" ok "${#refs[@]} образов по digest на месте"
}

# Дерево v2: /opt/pragmatika-v2/deploy и db; боевой .env без снятых имён, ссылка на secrets.env.
prepare_tree() {
  phase "дерево v2 в $CUTOVER_NEW_DIR"
  local deploy="$CUTOVER_NEW_DIR/deploy" key line
  if [[ -n "$(ls -A "$deploy" 2>/dev/null)" && ! -f "$deploy/$DEPLOYED_MARK" ]]; then
    refuse "$deploy не пуст и создан не этим пакетом (нет $DEPLOYED_MARK): не затираю"
  fi
  mkdir -p "$deploy" "$CUTOVER_NEW_DIR/db"
  cp -a "$STACK/deploy/." "$deploy/"
  cp -a "$STACK/db/." "$CUTOVER_NEW_DIR/db/"
  [[ ! -f "$HERE/bai" ]] || cp -a "$HERE/bai" "$deploy/bai"
  cp "$LOCK_SRC" "$deploy/images.lock"
  chmod 644 "$deploy/images.lock"
  # Боевой .env как есть, кроме снятых имён (код v2 их не читает) и сборочных имён speech.
  local drop=() pattern
  while IFS= read -r pattern; do
    [[ -z "$pattern" || "$pattern" == \#* ]] || drop+=("$pattern")
  done <"$ENV_RETIRED"
  drop+=("$SPEECH_DROP_RE")
  : >"$deploy/.env"
  chmod 600 "$deploy/.env"
  while IFS= read -r line || [[ -n "$line" ]]; do
    key="${line%%=*}"
    key="${key#export }"
    key="${key// /}"
    if [[ "$line" == *=* && "$key" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
      for pattern in "${drop[@]}"; do
        if [[ "$key" =~ $pattern ]]; then continue 2; fi
      done
    fi
    printf '%s\n' "$line" >>"$deploy/.env"
  done <"$CUTOVER_ENV_FILE"
  # LOCAL_HOST_DIR на бою может быть не задан (умолчание compose): v2 получает его явно.
  if [[ -z "$(env_value "$deploy/.env" "$LOCAL_HOST_DIR_NAME")" ]]; then
    printf '%s=%s\n' "$LOCAL_HOST_DIR_NAME" "$LOCAL_HOST_DIR_DEFAULT" >>"$deploy/.env"
  fi
  if [[ -f "$CUTOVER_SECRETS_DIR/secrets.env" ]]; then
    ln -sfn "$CUTOVER_SECRETS_DIR/secrets.env" "$deploy/secrets.env"
  fi
  date -u +%FT%TZ >"$deploy/$DEPLOYED_MARK"
  check "дерево v2" ok "compose, images.lock, .env (600), ссылка на secrets.env;" \
    "прежнее дерево не тронуто"
}

# Список сервисов стека v2 в порядке старта; app последним.
service_list() {
  local all=() svc ordered=() rest=()
  if [[ -n "${CUTOVER_SERVICES:-}" ]]; then
    read -r -a all <<<"$CUTOVER_SERVICES"
  else
    mapfile -t all < <(dc_new config --services 2>/dev/null | sort)
  fi
  for svc in "${SERVICE_ORDER[@]}"; do
    [[ " ${all[*]} " == *" $svc "* ]] && ordered+=("$svc")
  done
  for svc in "${all[@]}"; do
    [[ "$svc" == "$SERVICE_LAST" || "$svc" == "$MIGRATE_SERVICE" ]] && continue
    [[ " ${SERVICE_ORDER[*]} " == *" $svc "* ]] || rest+=("$svc")
  done
  printf '%s\n' "${ordered[@]}" "${rest[@]}" "$SERVICE_LAST"
}

plan_check() { # plan_check <файл вывода> <метка>
  local pending expected legacy
  dc_new --profile tools run --rm --no-deps -T "$MIGRATE_SERVICE" --plan >"$1" 2>>"$LOG_FILE" \
    || refuse "migrate --plan не отработал ($2)"
  pending="$(grep -E '^pending ' "$1" | sed 's/^pending //' | sort | tr '\n' ' ')"
  expected="$(grep -vE '^(#|$)' "$EXPECTED_PENDING" | sort | tr '\n' ' ')"
  legacy="$(grep -cE '^applied-by-legacy ' "$1" || true)"
  [[ "$pending" == "$expected" ]] \
    || refuse "план миграций ($2): ожидают ${pending:-ничего}, ожидалось ${expected:-ничего}"
  ((legacy == EXPECTED_LEGACY)) \
    || refuse "план миграций ($2): applied-by-legacy $legacy, ожидалось $EXPECTED_LEGACY"
  check "план миграций ($2)" ok "ожидают только: $pending; applied-by-legacy $legacy"
}

# Условия старта app: файлы читаются его uid, тома боя пишутся им, сухой запуск ядра --once.
check_app_start() {
  phase "условия старта app (до остановки боя)"
  local out name vol bad=() good=() rc=0 agents
  if ! out="$(dc_new run --rm --no-deps -T --entrypoint sh app -c "$REH_READ_SCRIPT" sh \
    "${APP_PATH_VARS[@]}" "${APP_MOUNT_PATHS[@]}" 2>>"$LOG_FILE")"; then
    refuse "файлы app не читаются его uid: $(printf '%s' "$out" | grep -v ' ok$' | tr '\n' ';' \
      | cut -c1-300)"
  fi
  check "файлы app читаются его uid" ok "$(printf '%s' "$out" | tr '\n' ';' | cut -c1-200)"
  for name in "${APP_WRITE_VOLUMES[@]}"; do
    vol="${CUTOVER_PROJECT}_$name"
    if ! docker volume inspect "$vol" >/dev/null 2>&1; then bad+=("$name: тома нет"); continue; fi
    if out="$(dc_new run --rm --no-deps -T -v "$vol:/bv:ro" --entrypoint sh app \
      -c "$APP_WRITE_SCRIPT" sh /bv 2>>"$LOG_FILE")"; then
      good+=("$name")
    else
      bad+=("$name: ${out:0:80}")
    fi
  done
  ((${#bad[@]} == 0)) || refuse "тома боя не пишутся uid app: ${bad[*]} (chown/chmod на хосте)"
  check "тома боя пишутся uid app" ok "${good[*]}"
  out="$(dc_new run --rm --no-deps -T app bun run src/main.ts --once 2>"$WORK/app-once.err")" \
    || rc=$?
  ((rc == 0)) || refuse "сухой запуск app --once, код $rc:" \
    "$(tail -1 "$WORK/app-once.err" | cut -c1-240)"
  agents="$(printf '%s\n' "$out" | python3 -I -c '
import json, sys
for line in sys.stdin:
    try:
        d = json.loads(line)
    except ValueError:
        continue
    if "agents" in d:
        print(" ".join(sorted(d["agents"])))
        break')"
  [[ "$agents" == "$APP_EXPECTED_AGENTS" ]] \
    || refuse "сухой запуск: агенты \"$agents\", ожидались \"$APP_EXPECTED_AGENTS\""
  check "сухой запуск app (--once)" ok "конфигурация принята, агентов 4: $agents"
}

# ---------------------------------------------------------------------------------------------
# 1. Бэкап
# ---------------------------------------------------------------------------------------------
stop_service_containers() { # stop_service_containers <сервис>...
  local svc id
  for svc in "$@"; do
    while read -r id; do
      [[ -n "$id" ]] && docker stop -t "$STOP_TIMEOUT_S" "$id" >>"$LOG_FILE" 2>&1
    done < <(docker ps -q --filter "label=com.docker.compose.project=$CUTOVER_PROJECT" \
      --filter "label=com.docker.compose.service=$svc")
  done
}

make_backups() {
  phase "бэкап"
  local dir="$CUTOVER_BACKUP_ROOT/$BACKUP_PREFIX-$RUN_ID" out archive uid gid image
  mkdir -p "$dir"
  chmod 700 "$dir"
  state_set BACKUP_DIR "$dir"
  uid="$(id -u)"
  gid="$(id -g)"
  # Остановка записи: app и indexer. С этой точки сбой ведёт к автоматическому откату.
  state_set QUIESCED 1
  stop_service_containers app indexer
  log "app и indexer остановлены (запись в БД прекращена)"
  # Штатный backup.sh с проверкой (дамп + SQLite + intake -> age -> S3, --verify).
  if out="$(bash "$CUTOVER_BACKUP_SCRIPT" --verify 2>&1)"; then
    printf '%s\n' "$out" | tail -n 5 | cut_redact >>"$LOG_FILE"
    archive="$(printf '%s\n' "$out" | grep -oE '[^[:space:]]+\.tar\.age' | tail -1 || true)"
    state_set BACKUP_SH_ARCHIVE "${archive:-неизвестен}"
    check "бэкап backup.sh --verify" ok "архив: ${archive:-путь не распознан в выводе}"
  else
    printf '%s\n' "$out" | tail -n 15 | cut_redact >>"$LOG_FILE"
    die "$EXIT_FAILED" "штатный backup.sh --verify завершился с ошибкой: бой не меняем"
  fi
  # Дамп для rollback.sh --restore-db (backup.sh зашифрован age, ключ у владельца офлайн).
  docker exec "$CUTOVER_PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc --no-owner \
    >"$dir/db.dump" 2>>"$LOG_FILE" || die "$EXIT_FAILED" "pg_dump не удался"
  chmod 600 "$dir/db.dump"
  docker exec -i "$CUTOVER_PG_CONTAINER" pg_restore --list <"$dir/db.dump" >"$dir/db.dump.toc" \
    2>>"$LOG_FILE" || die "$EXIT_FAILED" "дамп БД не читается pg_restore --list"
  sha256sum "$dir/db.dump" >"$dir/db.dump.sha256"
  check "дамп БД" ok "pg_dump -Fc, $(du -h "$dir/db.dump" | cut -f1)," \
    "оглавление $(wc -l <"$dir/db.dump.toc") строк"
  # .env и secrets.env (600) и архив прежнего дерева без local/.
  cp "$CUTOVER_ENV_FILE" "$dir/env.battle"
  [[ ! -f "$CUTOVER_SECRETS_DIR/secrets.env" ]] \
    || cp "$CUTOVER_SECRETS_DIR/secrets.env" "$dir/secrets.env"
  chmod 600 "$dir"/env.battle "$dir"/secrets.env 2>/dev/null || true
  tar -C / -czf "$dir/old-tree.tgz" --exclude="${CUTOVER_OLD_DIR#/}/local" "${CUTOVER_OLD_DIR#/}" \
    2>>"$LOG_FILE" || die "$EXIT_FAILED" "не снят архив $CUTOVER_OLD_DIR"
  chmod 600 "$dir/old-tree.tgz"
  check "архив прежнего дерева" ok "$CUTOVER_OLD_DIR без local/:" \
    "$(du -h "$dir/old-tree.tgz" | cut -f1)"
  # Хранилище псевдонимизатора: сервис останавливается (чистая копия), том архивируется.
  stop_service_containers pseudonymizer
  image="$(lock_value "$LOCK_SRC" BAI_IMAGE_POSTGRES)"
  docker run --rm --network none --user 0:0 -v "$CUTOVER_PSEUDO_VOLUME:/data:ro" \
    -v "$dir:/out" --entrypoint sh "$image" -c \
    "tar -czf /out/pseudonymizer-data.tgz -C /data . \
&& chown $uid:$gid /out/pseudonymizer-data.tgz && chmod 600 /out/pseudonymizer-data.tgz" \
    >>"$LOG_FILE" 2>&1 \
    || die "$EXIT_FAILED" "не снят архив тома $CUTOVER_PSEUDO_VOLUME"
  tar -tzf "$dir/pseudonymizer-data.tgz" >/dev/null || die "$EXIT_FAILED" "архив тома повреждён"
  check "архив тома pseudonymizer-data" ok "$(du -h "$dir/pseudonymizer-data.tgz" | cut -f1)"
  snapshot_old "$dir"
  cp "$dir/containers-before.tsv" "$dir/images-before.tsv" "$RES/" 2>/dev/null || true
  chmod 600 "$dir"/*.tsv
  state_set BACKUP_DONE 1
}

# ---------------------------------------------------------------------------------------------
# 2-3. Остановка прежнего стека и запуск v2
# ---------------------------------------------------------------------------------------------
stop_old_stack() {
  phase "остановка прежних контейнеров"
  local names name rest=() pg=""
  mapfile -t names < <(project_containers)
  for name in "${names[@]}"; do
    if [[ "$name" == "$CUTOVER_PG_CONTAINER" ]]; then pg="$name"; else rest+=("$name"); fi
  done
  state_set OLD_STOPPED 1
  for name in "${rest[@]}" ${pg:+"$pg"}; do
    docker stop -t "$STOP_TIMEOUT_S" "$name" >>"$LOG_FILE" 2>&1 || true
  done
  for name in "${names[@]}"; do docker rm "$name" >>"$LOG_FILE" 2>&1 || true; done
  check "прежние контейнеры" ok "остановлены и убраны ${#names[@]} шт.;" \
    "тома и образы на месте"
}

migrate_and_verify_schema() {
  local schema_ok=1
  state_set DB_MIGRATE_STARTED 1
  if ! dc_new --profile tools run --rm --no-deps -T "$MIGRATE_SERVICE" \
    >"$RES/migrate-apply.txt" 2>&1; then
    tail -n 12 "$RES/migrate-apply.txt" | cut_redact >>"$LOG_FILE"
    die "$EXIT_FAILED" "migrate завершился ошибкой (migrate-apply.txt)"
  fi
  check "применение миграций" ok "$(tail -1 "$RES/migrate-apply.txt")"
  dc_new --profile tools run --rm --no-deps -T "$MIGRATE_SERVICE" --plan \
    >"$RES/migrate-plan-after.txt" 2>>"$LOG_FILE" || true
  if grep -qE '^pending ' "$RES/migrate-plan-after.txt"; then
    die "$EXIT_FAILED" "после применения остались ожидающие миграции"
  fi
  check "план после применения" ok "ожидающих миграций нет"
  if [[ -f "$SCHEMA_EXPECTED" && -f "$SCHEMA_TOOL" ]]; then
    docker exec "$CUTOVER_PG_CONTAINER" pg_dump --schema-only --no-owner --no-privileges \
      -U "$PG_USER" -d "$PG_DB" >"$WORK/schema-actual.sql" 2>>"$LOG_FILE" || schema_ok=0
    python3 -I "$SCHEMA_TOOL" normalize "$WORK/schema-actual.sql" \
      "$RES/schema-actual.normalized.sql" 2>>"$LOG_FILE" || schema_ok=0
    if ((schema_ok)) && python3 -I "$SCHEMA_TOOL" compare "$SCHEMA_EXPECTED" \
      "$RES/schema-actual.normalized.sql" --diff-out "$RES/schema-diff.txt" \
      >"$RES/schema-compare.txt" 2>&1; then
      check "схема против ожидаемой v2" ok "различий объектов нет"
    else
      die "$EXIT_FAILED" "схема после миграций отличается от ожидаемой v2 (schema-diff.txt)"
    fi
  else
    check "схема против ожидаемой v2" warn "нет schema-expected.sql или инструмента:" \
      "сверка пропущена"
  fi
}

start_v2() {
  phase "запуск v2"
  local svc services name
  mapfile -t services < <(service_list)
  log "порядок сервисов: ${services[*]}"
  state_set V2_STARTED 1
  for svc in "${services[@]}"; do
    name="${CUTOVER_PROJECT}-${svc}-1"
    if [[ "$svc" == "$SERVICE_LAST" ]]; then phase "app (последним)"; fi
    dc_new up -d --no-deps --no-build --pull never "$svc" >>"$LOG_FILE" 2>&1 \
      || { docker logs --tail 20 "$name" 2>&1 | cut_redact >>"$LOG_FILE"; \
           die "$EXIT_FAILED" "compose up $svc не удался"; }
    if wait_healthy "$name" "$HEALTH_WAIT_S"; then
      check "сервис $svc" ok "healthy"
    else
      docker logs --tail 20 "$name" 2>&1 | cut_redact >>"$LOG_FILE"
      die "$EXIT_FAILED" "сервис $svc не стал healthy за ${HEALTH_WAIT_S} с"
    fi
    if [[ "$svc" == postgres ]]; then
      plan_check "$RES/migrate-plan-v2pg.txt" "на postgres v2"
      migrate_and_verify_schema
    fi
  done
}

# ---------------------------------------------------------------------------------------------
# 4. Проверки после и выдержка
# ---------------------------------------------------------------------------------------------
inspect_app_log() {
  docker logs --since "$STARTED_AT" "$CUTOVER_APP_CONTAINER" >"$WORK/app.log" 2>&1 || true
  python3 -I - "$WORK/app.log" "$RES" "$CUTOVER_EXPECT_BOTS" <<'PY'
import collections, json, pathlib, sys

log_path, res, bots = sys.argv[1], pathlib.Path(sys.argv[2]), int(sys.argv[3])
events = collections.Counter()
raw = 0
bot_ready = 0
for line in open(log_path, encoding="utf-8", errors="replace"):
    line = line.strip()
    if not line:
        continue
    try:
        item = json.loads(line)
    except ValueError:
        raw += 1
        continue
    if item.get("event") == "bitrix24_bot_ready":
        bot_ready += 1
    level = item.get("level") or item.get("severity")
    if level in ("error", "warn", "warning"):
        events[(level, item.get("event", "?"))] += 1
errors = sum(v for k, v in events.items() if k[0] == "error")
rows = ["уровень\tсобытие\tчисло"] + [f"{k[0]}\t{k[1]}\t{v}" for k, v in sorted(events.items())]
(res / "app-log-events.tsv").write_text("\n".join(rows) + "\n", encoding="utf-8")
(res / "app-log-summary.txt").write_text(
    f"строк не JSON: {raw}\nсобытий error: {errors}\nbitrix24_bot_ready: {bot_ready}\n",
    encoding="utf-8")
sys.exit(0 if raw == 0 and errors == 0 and bot_ready >= bots else 1)
PY
}

# Образы запущенных контейнеров против images.lock (Config.Image - ссылка из lock, Image - id).
verify_running_images() {
  local ref name want got bad=0
  : >"$RES/images-running.tsv"
  while IFS= read -r name; do
    ref="$(docker inspect -f '{{.Config.Image}}' "$name")"
    got="$(docker inspect -f '{{.Image}}' "$name")"
    want="$(docker image inspect -f '{{.Id}}' "$ref" 2>/dev/null || echo ?)"
    if grep -qxF "$ref" "$RES/images-v2.txt" && [[ "$got" == "$want" ]]; then
      printf '%s\t%s\tсовпал\n' "$name" "$ref" >>"$RES/images-running.tsv"
    else
      printf '%s\t%s\tОТЛИЧАЕТСЯ\n' "$name" "$ref" >>"$RES/images-running.tsv"
      bad=$((bad + 1))
    fi
  done < <(project_containers)
  ((bad == 0)) || die "$EXIT_FAILED" "образы запущенных контейнеров не равны images.lock: $bad"
  check "образы = images.lock" ok "digest запущенных контейнеров совпал с images.lock"
}

metrics_check() {
  local dir files
  dir="$(env_value "$CUTOVER_ENV_FILE" TEXTFILE_METRICS_DIR)"
  dir="${dir:-/var/lib/pragmatika/metrics}"
  if [[ ! -d "$dir" ]]; then
    check "метрики (textfile)" warn "каталога $dir нет: проверить вручную (CHECKLIST.md)"
    return 0
  fi
  files="$(find "$dir" -maxdepth 1 -name '*.prom' -newermt "$STARTED_AT" 2>/dev/null | wc -l)"
  if ((files > 0)); then
    check "метрики (textfile)" ok "файлов .prom обновлено после начала: $files"
  else
    check "метрики (textfile)" warn "в $dir нет .prom новее начала переключения (юниты метрик," \
      "CHECKLIST.md п. про 3 юнита)"
  fi
}

alerts_count() {
  [[ -n "$CUTOVER_ALERTS_URL" ]] || { echo -; return 0; }
  python3 -I - "$CUTOVER_ALERTS_URL" <<'PY' 2>/dev/null || echo ошибка
import json, sys, urllib.request
with urllib.request.urlopen(sys.argv[1], timeout=10) as r:
    items = json.load(r)
print(sum(1 for a in items if a.get("status", {}).get("state") == "active"))
PY
}

verify_v2() {
  phase "проверки после переключения"
  local bots=0 body waited=0 restarts_before restarts_now alerts
  ready_wait "$CUTOVER_APP_CONTAINER" "$READY_WAIT_S" \
    || die "$EXIT_FAILED" "/ready не 200 за ${READY_WAIT_S} с: ${READY_BODY:0:160}"
  while ((waited < READY_WAIT_S)); do
    body="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
    bots="$(ready_bots "$body")"
    ((bots >= CUTOVER_EXPECT_BOTS)) && break
    sleep "$POLL_S"
    waited=$((waited + POLL_S))
  done
  ((bots >= CUTOVER_EXPECT_BOTS)) \
    || die "$EXIT_FAILED" "bitrix24_bot_ready = $bots, ожидается не меньше $CUTOVER_EXPECT_BOTS"
  check "/ready и боты" ok "200, ботов $bots"
  check_mail "$body"
  if inspect_app_log; then
    check "журнал app" ok "$(tr '\n' ';' <"$RES/app-log-summary.txt")"
  else
    cat "$RES/app-log-summary.txt" >>"$LOG_FILE"
    die "$EXIT_FAILED" "журнал app: ошибки или не хватает bitrix24_bot_ready (app-log-summary.txt)"
  fi
  verify_running_images
  metrics_check
  # Выдержка: контейнеры не перезапускаются, /ready зелёный.
  restarts_before="$(restart_total)"
  waited=0
  log "выдержка ${SOAK_S} с (проверка каждые ${SOAK_POLL_S} с)"
  while ((waited < SOAK_S)); do
    sleep "$((SOAK_POLL_S < SOAK_S - waited ? SOAK_POLL_S : SOAK_S - waited))"
    waited=$((waited + SOAK_POLL_S))
    restarts_now="$(restart_total)"
    ((restarts_now == restarts_before)) \
      || die "$EXIT_FAILED" "во время выдержки перезапуски контейнеров:" \
        "$restarts_before -> $restarts_now"
    body="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
    [[ "$body" == 200* ]] || die "$EXIT_FAILED" "во время выдержки /ready не 200: ${body:0:120}"
  done
  check "выдержка ${SOAK_S} с" ok "перезапусков нет, /ready 200"
  alerts="$(alerts_count)"
  case "$alerts" in
    -) check "алерты" warn "CUTOVER_ALERTS_URL не задан: смотреть алерты вручную (CHECKLIST.md)" ;;
    0) check "алерты" ok "активных алертов нет" ;;
    ошибка) check "алерты" warn "CUTOVER_ALERTS_URL не отвечает: смотреть алерты вручную" ;;
    *) die "$EXIT_FAILED" "активных алертов: $alerts" ;;
  esac
}

# Почта: состояние, число ящиков и блокировки входа после переключения как до него.
check_mail() { # check_mail <тело /ready после>
  local before after waited=0
  before="$(state_get MAIL_BEFORE)"
  after="$(mail_summary "$1")"
  if [[ -z "$before" || "$before" == unconfigured* || "$before" == "-" ]]; then
    check "почта" warn "до переключения почта не настроена в /ready ($before): сравнивать нечего"
    return 0
  fi
  while [[ "$after" != "$before" ]] && ((waited < READY_WAIT_S)); do
    sleep "$POLL_S"
    waited=$((waited + POLL_S))
    after="$(mail_summary "$(ready_probe "$CUTOVER_APP_CONTAINER" || true)")"
  done
  if [[ "$after" == "$before" ]]; then
    check "почта" ok "как до переключения: $after"
  else
    die "$EXIT_FAILED" "почта после переключения иной ($after), до переключения $before"
  fi
}

restart_total() {
  local name sum=0 n
  while read -r name; do
    n="$(docker inspect -f '{{.RestartCount}}' "$name" 2>/dev/null || echo 0)"
    sum=$((sum + n))
  done < <(project_containers)
  echo "$sum"
}

# ---------------------------------------------------------------------------------------------
main() {
  cut_init_secrets_defaults
  save_config
  log "cutover.sh $RUN_ID: проект $CUTOVER_PROJECT, прежнее дерево $CUTOVER_OLD_DIR," \
    "новое $CUTOVER_NEW_DIR, каталог запуска $RUN_DIR"
  PG_USER="${PG_USER:-$(env_value "$CUTOVER_ENV_FILE" POSTGRES_USER)}"
  PG_DB="${PG_DB:-$(env_value "$CUTOVER_ENV_FILE" POSTGRES_DB)}"
  PG_USER="${PG_USER:-pragmatika}"
  PG_DB="${PG_DB:-pragmatika}"
  check_sources
  check_signatures
  check_battle_env
  check_resources
  check_battle_health
  check_old_images
  prepare_tree
  phase "проверка конфигурации v2"
  dc_new --profile tools config --quiet >>"$LOG_FILE" 2>&1 \
    || refuse "docker compose config не принял конфигурацию v2 (нет обязательной переменной?)"
  check "конфигурация v2" ok "compose config без ошибок"
  ensure_images
  check_app_start
  plan_check "$RES/migrate-plan-pre.txt" "на живой базе боя"
  if ((PREFLIGHT_ONLY)); then
    check "режим" ok "--preflight-only: бой не менялся"
    state_set RESULT "PREFLIGHT_OK"
    return 0
  fi
  make_backups
  stop_old_stack
  start_v2
  verify_v2
  state_set RESULT OK
}

cut_init_secrets_defaults() {
  # Бой читается только с хоста: SECRETS_DIR из боевого .env (умолчание /etc/pragmatika/secrets).
  CUTOVER_SECRETS_DIR="${CUTOVER_SECRETS_DIR:-$(env_value "$CUTOVER_ENV_FILE" SECRETS_DIR)}"
  CUTOVER_SECRETS_DIR="${CUTOVER_SECRETS_DIR:-/etc/pragmatika/secrets}"
}

main
