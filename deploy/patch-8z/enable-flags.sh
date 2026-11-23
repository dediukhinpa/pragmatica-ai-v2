#!/usr/bin/env bash
# Выключатель флагов G8z у app: необязательный шаг после патча G8z (КРАСНАЯ ЗОНА: запускает
# только владелец на боевом хосте). После патча обе функции ВКЛЮЧЕНЫ по умолчанию (в
# compose.project.yml `:-true`); патч .env не меняет. Этот скрипт ставит значения в боевом .env
# (`false` - выключить функцию без отката образа, `true` - вернуть) и пересоздаёт ТОЛЬКО app.
#   SHORTLIST_PAGING_ENABLED    «ещё 10» поставщиков без повторов
#   SUPPLIER_DISCOVERY_ENABLED  пополнение базы поставщиков (работает, только когда
#                               SUPPLIER_CARDS_ENABLED=true: без карточек инструментов нет)
#
# Использование:
#   bash enable-flags.sh [--paging true|false] [--discovery true|false] [--dry-run]
#                        [--config ФАЙЛ] [--soak-seconds N] [--expected-bots N]
#   bash enable-flags.sh --rollback [--backup ФАЙЛ]   вернуть .env из бэкапа и пересоздать app
#   bash enable-flags.sh --help
#
# Что делает:
#   0. Проверки (бой не меняется, при нарушении код 3): патч G8z применён (BAI_VERSION lock боя
#      1.1.6-pragmatika.3, app запущен на образе из lock, в его окружении обе переменные), app
#      здоров (/ready 200, ботов не меньше ожидаемого), .env на месте; для
#      --discovery true в действующей конфигурации (compose config) должно быть
#      SUPPLIER_CARDS_ENABLED=true (иначе возвращать пополнение базы бессмысленно).
#   1. Бэкап .env (права и владелец сохраняются, 600): ~/backups/pragmatika-flags8z-<время>/.env.
#   2. Правка .env: только строки названных флагов (остальное побайтно прежнее); проверка по
#      `compose config` (значения у app, прочая конфигурация app не изменилась) ДО перезапуска.
#   3. `up -d --no-deps app` (documents и остальное не трогаются), проверки: app healthy, /ready
#      200 и ботов не меньше ожидаемого, в окружении app значения флагов, documents не
#      перезапускался; выдержка (по умолчанию 60 с: app не перезапускается, /ready 200).
#   Любой сбой после правки .env -> автооткат: .env из бэкапа, `up -d --no-deps app`, /ready.
# В журнал и вывод идут только имена двух флагов и их значения; остальной .env (секреты) не
# читается и не печатается.
#
# Откат вручную позже: `bash enable-flags.sh --rollback` (последний бэкап) или с --backup ФАЙЛ:
# .env возвращается побайтно, app пересоздаётся; ожидаемое значение флага после отката - из
# бэкапа, если ключа в нём нет - true (значение по умолчанию compose).
# Коды выхода: 0 - готово; 1 - сбой, откат выполнен; 2 - неверный вызов; 3 - отказ по
# предусловиям, бой не тронут; 4 - сбой, откат тоже не удался (ручное вмешательство).
set -euo pipefail
umask 077

# ---------------------------------------------------------------------------------------------
# Константы
# ---------------------------------------------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HERE/lib.sh" ]]; then
  LIB="$HERE/lib.sh" # пакет: всё рядом
else
  LIB="$HERE/../cutover/lib.sh" # дерево проекта (стенды и тесты)
fi
# shellcheck source=../cutover/lib.sh
source "$LIB"
FLAG_PAGING="SHORTLIST_PAGING_ENABLED"
FLAG_DISCOVERY="SUPPLIER_DISCOVERY_ENABLED"
FLAG_CARDS="SUPPLIER_CARDS_ENABLED"
FLAG_ON="true"
FLAG_OFF="false"
LOCK_KEY_APP="BAI_IMAGE_APP"
LOCK_KEY_VERSION="BAI_VERSION"
LOCK_VERSION_G8Z="1.1.6-pragmatika.3"
APP_SERVICE="app"
DOCUMENTS_SERVICE="documents"
ENV_FILE_NAME=".env"
DEPLOYED_MARK=".cutover-deployed"
BACKUP_PREFIX="pragmatika-flags8z"
RUN_PREFIX="enable-flags-8z"
ARCHIVE_PREFIX="flags8z"
DEFAULT_SOAK_S=60
SOAK_POLL_S=${FLAGS8Z_SOAK_POLL_S:-10}
EXIT_FLAGS_OK=0

ROLLBACK_MODE=0
DRY_RUN=0
BACKUP_ARG=""
CONFIG_FILE=""
SOAK_S="$DEFAULT_SOAK_S"
EXPECT_BOTS_ARG=""
WANT_PAGING=""
WANT_DISCOVERY=""

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
# flag_value <значение>: true или false (регистр не важен), иначе выход с кодом 2.
flag_value() {
  case "${1,,}" in
    "$FLAG_ON" | "$FLAG_OFF") printf '%s' "${1,,}" ;;
    *) echo "значение флага: $FLAG_ON или $FLAG_OFF, получено '$1'" >&2; exit "$EXIT_USAGE" ;;
  esac
}
while (($#)); do
  case "$1" in
    --paging) WANT_PAGING="$(flag_value "${2:?--paging true|false}")"; shift ;;
    --discovery) WANT_DISCOVERY="$(flag_value "${2:?--discovery true|false}")"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    --rollback) ROLLBACK_MODE=1 ;;
    --backup) BACKUP_ARG="${2:?--backup ФАЙЛ}"; shift ;;
    --config) CONFIG_FILE="${2:?--config ФАЙЛ}"; shift ;;
    --out-dir) CUTOVER_OUT_DIR="${2:?--out-dir КАТАЛОГ}"; shift ;;
    --soak-seconds) SOAK_S="${2:?--soak-seconds N}"; shift ;;
    --expected-bots) EXPECT_BOTS_ARG="${2:?--expected-bots N}"; shift ;;
    --help | -h) usage; exit "$EXIT_OK" ;;
    *) echo "неизвестный аргумент: $1" >&2; usage >&2; exit "$EXIT_USAGE" ;;
  esac
  shift
done
[[ "$SOAK_S" =~ ^[0-9]+$ ]] || { echo "--soak-seconds: нужно число" >&2; exit "$EXIT_USAGE"; }
[[ -z "$EXPECT_BOTS_ARG" || "$EXPECT_BOTS_ARG" =~ ^[0-9]+$ ]] \
  || { echo "--expected-bots: нужно число" >&2; exit "$EXIT_USAGE"; }
if ((ROLLBACK_MODE)); then
  [[ -z "$WANT_PAGING$WANT_DISCOVERY" ]] \
    || { echo "--rollback несовместим с --paging и --discovery" >&2; exit "$EXIT_USAGE"; }
  ((DRY_RUN == 0)) || { echo "--rollback и --dry-run несовместимы" >&2; exit "$EXIT_USAGE"; }
else
  [[ -z "$BACKUP_ARG" ]] || { echo "--backup только с --rollback" >&2; exit "$EXIT_USAGE"; }
  [[ -n "$WANT_PAGING$WANT_DISCOVERY" ]] \
    || { echo "нужен хотя бы один из --paging, --discovery (или --rollback)" >&2
      usage >&2; exit "$EXIT_USAGE"; }
fi

[[ -z "$CONFIG_FILE" ]] || cut_load_config "$CONFIG_FILE" || exit "$EXIT_USAGE"
[[ -z "$EXPECT_BOTS_ARG" ]] || CUTOVER_EXPECT_BOTS="$EXPECT_BOTS_ARG"
cut_defaults
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$CUTOVER_HOME"
cut_init_run "$CUTOVER_HOME/$RUN_PREFIX-$RUN_ID"
ln -sfn "$RUN_DIR" "$CUTOVER_HOME/$RUN_PREFIX-latest"
LIVE_NEW_DIR="$CUTOVER_NEW_DIR"
LIVE_DEPLOY="$LIVE_NEW_DIR/deploy"
LIVE_ENV="$LIVE_DEPLOY/$ENV_FILE_NAME"
BACKUP_FILE=""
ENV_CHANGED=0
ROLLED_BACK=0
DOCS_STARTED_BEFORE=""

die() { # die <код> <сообщение...>
  local code="$1"
  shift
  log "ОШИБКА: $*"
  state_set RESULT "FAILED: $*"
  exit "$code"
}
# refuse <сообщение>: отказ по предусловиям, бой не тронут; после правки .env - сбой хода (откат).
refuse() {
  check "предусловия" fail "$*"
  if ((ENV_CHANGED)); then die "$EXIT_FAILED" "$*"; fi
  die "$EXIT_REFUSED" "отказ: $*"
}

# ---------------------------------------------------------------------------------------------
# Вспомогательное (значения читаются только у двух флагов и SUPPLIER_CARDS_ENABLED)
# ---------------------------------------------------------------------------------------------
container_env_value() {
  { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null || true; } \
    | sed -n "s/^$2=//p" | head -1
}
container_started() { docker inspect -f '{{.State.StartedAt}}' "$1" 2>/dev/null || true; }
container_restarts() { docker inspect -f '{{.RestartCount}}' "$1" 2>/dev/null || echo "?"; }
container_image_id() { docker inspect -f '{{.Image}}' "$1" 2>/dev/null || true; }
ref_image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || echo "?"; }
service_containers() {
  docker ps -a --filter "label=com.docker.compose.project=$CUTOVER_PROJECT" \
    --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | sort
}

# effective_app_value <ИМЯ>: значение переменной у app в действующей конфигурации compose
# (`compose config`: .env, lock и умолчания compose). Печатается только это значение.
effective_app_value() {
  { dc_new --profile tools config --format json 2>/dev/null || true; } | python3 -I -c '
import json, sys
try:
    env = json.load(sys.stdin)["services"]["app"].get("environment") or {}
except (ValueError, KeyError, TypeError, AttributeError):
    sys.exit(0)
value = env.get(sys.argv[1])
print("" if value is None else str(value).strip().lower(), end="")
' "$1"
}

# set_env_flags <файл .env> <ИМЯ=значение...>: правит только строки названных ключей (все
# вхождения заменяются, если ключа нет - строка дописывается); остальное побайтно прежнее; права и
# владелец сохраняются; запись атомарная (временный файл рядом и замена).
set_env_flags() {
  python3 -I - "$@" <<'PY'
import os
import sys
import tempfile

path, pairs = sys.argv[1], dict(item.split("=", 1) for item in sys.argv[2:])
stat = os.stat(path)
with open(path, encoding="utf-8", errors="surrogateescape", newline="") as handle:
    lines = handle.read().splitlines(keepends=True)
seen = set()
out = []
for line in lines:
    name = line.split("=", 1)[0].strip() if "=" in line else ""
    if name in pairs and not line.lstrip().startswith("#"):
        ending = line[len(line.rstrip("\r\n")):] or "\n"
        out.append(f"{name}={pairs[name]}{ending}")
        seen.add(name)
    else:
        out.append(line)
for name in pairs:
    if name not in seen:
        if out and not out[-1].endswith("\n"):
            out[-1] += "\n"
        out.append(f"{name}={pairs[name]}\n")
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".env-flags-")
with os.fdopen(fd, "w", encoding="utf-8", errors="surrogateescape", newline="") as handle:
    handle.write("".join(out))
os.chmod(tmp, stat.st_mode & 0o7777)
if os.geteuid() == 0:
    os.chown(tmp, stat.st_uid, stat.st_gid)
os.replace(tmp, path)
PY
}

# env_diff_names <файл A> <файл B>: имена ключей, строки которых различаются (значения не
# печатаются). Нужно, чтобы убедиться: изменены только названные флаги.
env_diff_names() {
  python3 -I - "$1" "$2" <<'PY'
import sys

def load(path: str) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for line in open(path, encoding="utf-8", errors="surrogateescape").read().splitlines():
        key = line.split("=", 1)[0].strip() if "=" in line else "#" + line
        result.setdefault(key, []).append(line)
    return result

left, right = load(sys.argv[1]), load(sys.argv[2])
print(" ".join(sorted(k for k in set(left) | set(right) if left.get(k) != right.get(k))))
PY
}

# restore_env <файл бэкапа>: .env из бэкапа (временный файл рядом и замена, права как у бэкапа).
restore_env() {
  local tmp="$LIVE_ENV.rb-new"
  cp -p "$1" "$tmp" && mv -f "$tmp" "$LIVE_ENV" && cmp -s "$1" "$LIVE_ENV"
}

# app_up_and_check <ИМЯ=значение...>: пересоздание app и проверки; 0 - всё сошлось. Значения у app
# сверяются с переданными (для отката - с теми, что были до правки).
app_up_and_check() {
  local item key want got body bots
  dc_new up -d --no-deps "$APP_SERVICE" >>"$LOG_FILE" 2>&1 \
    || { log "compose up app не удался"; return 1; }
  wait_healthy "$CUTOVER_APP_CONTAINER" "$HEALTH_WAIT_S" \
    || { log "$CUTOVER_APP_CONTAINER не стал healthy за ${HEALTH_WAIT_S} с"; return 1; }
  ready_wait "$CUTOVER_APP_CONTAINER" "$READY_WAIT_S" \
    || { log "/ready не 200 за ${READY_WAIT_S} с: ${READY_BODY:0:160}"; return 1; }
  body="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
  bots="$(ready_bots "$body")"
  ((bots >= CUTOVER_EXPECT_BOTS)) \
    || { log "ботов $bots, ожидается не меньше $CUTOVER_EXPECT_BOTS"; return 1; }
  for item in "$@"; do
    key="${item%%=*}"
    want="${item#*=}"
    got="$(container_env_value "$CUTOVER_APP_CONTAINER" "$key")"
    [[ "${got,,}" == "$want" ]] \
      || { log "в окружении app $key=${got:-<нет>}, ожидается $want"; return 1; }
  done
  return 0
}

# ---------------------------------------------------------------------------------------------
# Откат
# ---------------------------------------------------------------------------------------------
# rollback_env <файл бэкапа> <ИМЯ=значение для проверки...>: .env из бэкапа и app на нём.
rollback_env() {
  local backup="$1"
  shift
  phase "откат .env"
  [[ -f "$backup" ]] || { log "нет бэкапа $backup: откат невозможен"; return 1; }
  restore_env "$backup" || { check "откат: .env" fail "не удалось вернуть из бэкапа"; return 1; }
  check "откат: .env" ok "возвращён из бэкапа, побайтно"
  if app_up_and_check "$@"; then
    check "откат: app" ok "пересоздан на прежнем .env, /ready 200"
    return 0
  fi
  check "откат: app" fail "после возврата .env app не прошёл проверки"
  return 1
}

on_exit() {
  local rc=$?
  trap - EXIT INT TERM
  set +e
  if ((rc != EXIT_OK && rc != EXIT_REFUSED && rc != EXIT_USAGE)) \
    && ((ENV_CHANGED && ROLLED_BACK == 0)); then
    log "СБОЙ: запускаю автоматический откат .env"
    ROLLED_BACK=1
    if rollback_env "$BACKUP_FILE" ${PRE_VALUES[@]+"${PRE_VALUES[@]}"}; then
      rc="$EXIT_FAILED"
      log "ОТКАТ ВЫПОЛНЕН: .env из бэкапа, app пересоздан, проверки прошли"
    else
      rc="$EXIT_STUCK"
      log "ОТКАТ НЕ УДАЛСЯ: нужно ручное вмешательство (OWNER-RUNBOOK.md, бэкап $BACKUP_FILE)"
    fi
  fi
  cp "$STATE_FILE" "$RES/state.env" 2>/dev/null || true
  ARCHIVE_PATH="$CUTOVER_OUT_DIR/$ARCHIVE_PREFIX-$RUN_ID.tgz"
  tar -C "$RUN_DIR" -czf "$ARCHIVE_PATH" results 2>/dev/null || ARCHIVE_PATH=""
  if [[ "$rc" == "$EXIT_OK" ]]; then
    log "ГОТОВО. Архив результатов: ${ARCHIVE_PATH:-не создан}"
  else
    log "ЗАВЕРШЕНО С КОДОМ $rc. Архив результатов: ${ARCHIVE_PATH:-не создан}"
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------------------------------------
# Проверки
# ---------------------------------------------------------------------------------------------
# Значения флагов у app ДО правки (для отката): ИМЯ=значение, только два флага.
PRE_VALUES=()
check_preconditions() {
  phase "предусловия"
  command -v docker >/dev/null || refuse "нет docker"
  [[ -f "$LIVE_DEPLOY/compose.yml" && -f "$LIVE_DEPLOY/images.lock" && -f "$LIVE_ENV" ]] \
    || refuse "в $LIVE_DEPLOY нет compose.yml, images.lock или $ENV_FILE_NAME: это не дерево v2"
  [[ -f "$LIVE_DEPLOY/$DEPLOYED_MARK" ]] \
    || refuse "в $LIVE_DEPLOY нет $DEPLOYED_MARK: дерево создано не cutover.sh"
  local ver ref got want body bots
  ver="$(lock_value "$LIVE_DEPLOY/images.lock" "$LOCK_KEY_VERSION" || true)"
  [[ "$ver" == "$LOCK_VERSION_G8Z" ]] \
    || refuse "BAI_VERSION lock боя '${ver:-?}', ожидается $LOCK_VERSION_G8Z:" \
      "сначала примените патч G8z"
  [[ -n "$(docker ps -q --filter "name=^${CUTOVER_APP_CONTAINER}\$")" ]] \
    || refuse "контейнер $CUTOVER_APP_CONTAINER не запущен"
  ref="$(lock_value "$LIVE_DEPLOY/images.lock" "$LOCK_KEY_APP" || true)"
  got="$(container_image_id "$CUTOVER_APP_CONTAINER")"
  want="$(ref_image_id "$ref")"
  [[ -n "$got" && "$got" == "$want" ]] \
    || refuse "запущенный $CUTOVER_APP_CONTAINER не на образе из lock боя:" \
      "сначала примените патч G8z"
  local flag
  for flag in "$FLAG_PAGING" "$FLAG_DISCOVERY"; do
    got="$(container_env_value "$CUTOVER_APP_CONTAINER" "$flag")"
    [[ -n "$got" ]] \
      || refuse "в окружении $CUTOVER_APP_CONTAINER нет $flag: сначала примените патч G8z"
    PRE_VALUES+=("$flag=${got,,}")
  done
  body="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
  [[ "$body" == 200* ]] || refuse "/ready боя не 200: ${body:0:120}"
  bots="$(ready_bots "$body")"
  ((bots >= CUTOVER_EXPECT_BOTS)) \
    || refuse "ботов $bots, ожидается не меньше $CUTOVER_EXPECT_BOTS (--expected-bots)"
  DOCS_NAME="$(service_containers "$DOCUMENTS_SERVICE" | head -1)"
  DOCS_STARTED_BEFORE="$(container_started "${DOCS_NAME:-none}")"
  if [[ "$WANT_DISCOVERY" == "$FLAG_ON" ]]; then
    got="$(effective_app_value "$FLAG_CARDS")"
    [[ "$got" == "$FLAG_ON" ]] \
      || refuse "$FLAG_DISCOVERY=$FLAG_ON требует $FLAG_CARDS=$FLAG_ON, а в конфигурации" \
        "'${got:-<пусто>}': сначала включите карточки поставщиков (без них пополнение базы" \
        "не подключается)"
  fi
  check "предусловия" ok "G8z применён, app здоров (ботов $bots), флаги сейчас: ${PRE_VALUES[*]}"
}

# ---------------------------------------------------------------------------------------------
# Основной ход
# ---------------------------------------------------------------------------------------------
do_enable() {
  local -a pairs=() want_values=()
  [[ -z "$WANT_PAGING" ]] || { pairs+=("$FLAG_PAGING=$WANT_PAGING"); }
  [[ -z "$WANT_DISCOVERY" ]] || { pairs+=("$FLAG_DISCOVERY=$WANT_DISCOVERY"); }
  check_preconditions
  if ((DRY_RUN)); then
    check "режим" ok "--dry-run: будет выполнено ${pairs[*]}; бой не менялся"
    state_set RESULT "DRY_RUN_OK"
    return 0
  fi
  phase "бэкап .env"
  local backup_dir="$CUTOVER_BACKUP_ROOT/$BACKUP_PREFIX-$RUN_ID"
  mkdir -p "$backup_dir"
  chmod 700 "$backup_dir"
  BACKUP_FILE="$backup_dir/$ENV_FILE_NAME"
  cp -p "$LIVE_ENV" "$BACKUP_FILE" || refuse "не удалось скопировать $ENV_FILE_NAME в бэкап"
  cmp -s "$LIVE_ENV" "$BACKUP_FILE" || refuse "бэкап $ENV_FILE_NAME не совпал с оригиналом"
  [[ "$(stat -c %a "$LIVE_ENV")" == "$(stat -c %a "$BACKUP_FILE")" ]] \
    || refuse "права $ENV_FILE_NAME в бэкапе не совпали с боевыми"
  state_set BACKUP_FILE "$BACKUP_FILE"
  ln -sfn "$backup_dir" "$CUTOVER_HOME/$BACKUP_PREFIX-latest"
  check "бэкап" ok "$BACKUP_FILE (права как у боевого $ENV_FILE_NAME)"

  phase "правка .env"
  ENV_CHANGED=1
  state_set ENV_CHANGED 1
  set_env_flags "$LIVE_ENV" "${pairs[@]}" || die "$EXIT_FAILED" "не удалось записать $ENV_FILE_NAME"
  local diff_names allowed=" ${pairs[*]%%=*} " name
  diff_names="$(env_diff_names "$BACKUP_FILE" "$LIVE_ENV")"
  for name in $diff_names; do
    [[ "$allowed" == *" $name "* ]] \
      || die "$EXIT_FAILED" "правка $ENV_FILE_NAME затронула лишний ключ $name"
  done
  [[ "$(stat -c %a "$LIVE_ENV")" == "$(stat -c %a "$BACKUP_FILE")" ]] \
    || die "$EXIT_FAILED" "права $ENV_FILE_NAME изменились"
  check "правка .env" ok "изменены только: ${diff_names:-<без изменений>}"
  local pair got
  for pair in "${pairs[@]}"; do
    got="$(effective_app_value "${pair%%=*}")"
    [[ "$got" == "${pair#*=}" ]] \
      || die "$EXIT_FAILED" "по compose config ${pair%%=*}='${got:-<пусто>}', ожидается ${pair#*=}"
  done
  check "конфигурация compose" ok "по compose config у app: ${pairs[*]}"

  phase "пересоздание app"
  log "up -d --no-deps app"
  app_up_and_check "${pairs[@]}" || die "$EXIT_FAILED" "app не прошёл проверки после смены флагов"
  check "app" ok "пересоздан, healthy, /ready 200, флаги в окружении: ${pairs[*]}"
  [[ -z "$DOCS_NAME" || "$(container_started "$DOCS_NAME")" == "$DOCS_STARTED_BEFORE" ]] \
    || die "$EXIT_FAILED" "$DOCS_NAME перезапускался (скрипт его не трогает)"
  check "documents" ok "не перезапускался"
  soak
  state_set RESULT OK
}

# Выдержка: app не перезапускается, /ready 200.
soak() {
  local started=$SECONDS left body before_started before_restarts
  before_started="$(container_started "$CUTOVER_APP_CONTAINER")"
  before_restarts="$(container_restarts "$CUTOVER_APP_CONTAINER")"
  log "выдержка ${SOAK_S} с (проверка каждые ${SOAK_POLL_S} с)"
  while ((SECONDS - started < SOAK_S)); do
    left=$((SOAK_S - (SECONDS - started)))
    sleep "$((SOAK_POLL_S < left ? SOAK_POLL_S : left))"
    [[ "$(container_started "$CUTOVER_APP_CONTAINER")" == "$before_started" \
      && "$(container_restarts "$CUTOVER_APP_CONTAINER")" == "$before_restarts" ]] \
      || die "$EXIT_FAILED" "во время выдержки $CUTOVER_APP_CONTAINER перезапускался"
    body="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
    [[ "$body" == 200* ]] || die "$EXIT_FAILED" "во время выдержки /ready не 200: ${body:0:120}"
  done
  check "выдержка ${SOAK_S} с" ok "app не перезапускался, /ready 200"
}

do_rollback() {
  phase "откат вручную"
  local backup="$BACKUP_ARG"
  [[ -n "$backup" ]] || backup="$CUTOVER_HOME/$BACKUP_PREFIX-latest/$ENV_FILE_NAME"
  [[ -f "$backup" ]] || die "$EXIT_USAGE" "нет бэкапа $backup (--backup ФАЙЛ)"
  [[ -f "$LIVE_ENV" ]] || die "$EXIT_USAGE" "нет $LIVE_ENV"
  # Ожидаемые значения флагов - те, что записаны в бэкапе (если ключа нет или он пуст - true:
  # значение по умолчанию compose).
  local -a want=()
  local flag value
  for flag in "$FLAG_PAGING" "$FLAG_DISCOVERY"; do
    value="$(env_value "$backup" "$flag")"
    value="${value,,}"
    want+=("$flag=${value:-$FLAG_ON}")
  done
  rollback_env "$backup" "${want[@]}" || exit "$EXIT_STUCK"
  state_set RESULT "ROLLBACK_OK"
}

if ((ROLLBACK_MODE)); then
  log "enable-flags.sh --rollback: проект $CUTOVER_PROJECT, дерево $LIVE_NEW_DIR"
  do_rollback
else
  log "enable-flags.sh $RUN_ID: проект $CUTOVER_PROJECT, дерево $LIVE_NEW_DIR, флаги: " \
    "${WANT_PAGING:+$FLAG_PAGING=$WANT_PAGING} ${WANT_DISCOVERY:+$FLAG_DISCOVERY=$WANT_DISCOVERY}"
  do_enable
fi
exit "$EXIT_FLAGS_OK"
