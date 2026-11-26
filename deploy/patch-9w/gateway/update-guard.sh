#!/usr/bin/env bash
# Патч шлюза 9w: pii-guard на вендоренной labops-pii 0.8.0 (пакет pragmatika_guard) -> код
# платформы 1.1.12 (agentplatform_guard, labops-pii 1.3.0). КРАСНАЯ ЗОНА: запускает только
# владелец на самом шлюзе, из распакованного пакета gateway-9w.tgz.
#
# Использование:
#   bash update-guard.sh --preflight-only            проверки и факты, ничего не меняет
#   bash update-guard.sh [--soak-seconds N]          применить
#   bash update-guard.sh --rollback [--run-dir DIR]  откат применённого патча
#   общий параметр: [--out-dir DIR] - куда сложить архив результата (по умолчанию $HOME)
#
# Меняется только служба pii-guard и её файлы: gateway/pii-guard, vendor/labops-pii,
# deploy/docker/config-env.sh (рядом с gateway) и gateway/docker-compose.override.yml (только
# окружение pii-guard). nginx, litellm, db, tg-reader, alloy, их конфиги и .env не меняются и не
# пересоздаются. Режимы ФИО и адресов и маршруты остаются прежними.
#
# Переменные задаются ОДНИМ способом - файлом override, который создаётся здесь, на шлюзе:
# .env не правится вообще (откат = удалить файл), слова-исключения не лежат ни в пакете, ни в
# репозитории, а override действует и на старый compose, и на compose платформы.
#
# Коды выхода: 0 - успех; 1 - сбой после начала замены, откат выполнен; 2 - неверный вызов;
# 3 - отказ по предусловиям или до замены, бой не тронут; 4 - сбой и откат не удался (нужны руки).
set -euo pipefail
umask 077
trap '' PIPE

# ---------------------------------------------------------------------------------------------
# Константы
# ---------------------------------------------------------------------------------------------
readonly EXIT_OK=0
readonly EXIT_ROLLED_BACK=1
readonly EXIT_USAGE=2
readonly EXIT_REFUSED=3
readonly EXIT_BROKEN=4

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly HERE
readonly PKG_PLATFORM="$HERE/platform"
readonly GW_ROOT="${PATCH9W_GW_ROOT:-/opt/pragmatika}"
readonly GW_DIR="$GW_ROOT/gateway"
readonly VENDOR_DIR="$GW_ROOT/vendor/labops-pii"
readonly CONFIG_ENV_REL="deploy/docker/config-env.sh"
readonly CONFIG_ENV="$GW_ROOT/$CONFIG_ENV_REL"
readonly PROJECT="${PATCH9W_PROJECT:-pragmatika-gateway}"
readonly BACKUP_ROOT="${PATCH9W_BACKUP_ROOT:-$HOME/backups}"
readonly BACKUP_PREFIX="pragmatika-gw-patch9w-"
readonly MEMINFO="${PATCH9W_MEMINFO:-/proc/meminfo}"

readonly SERVICE="pii-guard"
readonly NGINX_SERVICE="nginx"
readonly COMPOSE_BASE="docker-compose.yml"
readonly OVERRIDE="docker-compose.override.yml"
readonly OVERRIDE_MARK="# bai-patch-9w"
readonly FRONT_NETWORK="${PROJECT}_front"
readonly OLD_VENDOR_TAG="v0.8.0"
readonly NEW_VENDOR_TAG="v1.3.0"
readonly NEW_LIBRARY_VERSION="1.3.0"
readonly OLD_MODULE="pragmatika_guard"
readonly NEW_MODULE="agentplatform_guard"
readonly BASE_IMAGE="python:3.12.7-slim-bookworm"

# Память pii-guard с надстройкой, МиБ (README платформы, «Пределы памяти контейнеров»): покой
# дерева 70, копия тела на поток пула 4 x 8, слоты запросов 16 x 16, на процесс проверки 24, на
# слот зрения сверх общего 67 - 16; запас 20%. При 2 процессах и 2 слотах зрения: 508 -> 610.
readonly MEM_TREE_IDLE_MIB=70
readonly MEM_POOL_COPIES_MIB=32
readonly MEM_REQUEST_SLOTS_MIB=256
readonly MEM_PER_PROCESS_MIB=24
readonly MEM_PER_VISION_MIB=51
readonly MEM_MARGIN_PERCENT=120
readonly PERCENT=100
readonly MIB=1048576
# Пределы тел, под которые сделан замер: больше - расчёт памяти неверен.
readonly MAX_BODY_MEASURED=8388608
readonly MAX_VISION_BODY_MEASURED=16777216
readonly MAX_SCAN_PROCESSES=8
readonly DEFAULT_SCAN_PROCESSES=2
readonly DEFAULT_VISION_CONCURRENT=2

readonly MIN_DISK_MIB="${PATCH9W_MIN_DISK_MIB:-3072}"
readonly MIN_MEM_MIB="${PATCH9W_MIN_MEM_MIB:-600}"
readonly HEALTH_TIMEOUT_SECONDS="${PATCH9W_HEALTH_TIMEOUT:-180}"
readonly POLL_SECONDS="${PATCH9W_POLL_SECONDS:-3}"
readonly BUILD_TIMEOUT_SECONDS="${PATCH9W_BUILD_TIMEOUT:-900}"
DEFAULT_SOAK_SECONDS=60
# Дополнительная метка собираемого образа (задают стенды, на бою пусто).
readonly -a BUILD_LABEL=(${PATCH9W_BUILD_LABEL:+--label "$PATCH9W_BUILD_LABEL"})

# Синтетика проб: выдуманный телефон и алиас модели, которого нет ни у одного провайдера (даже
# если бы litellm принял запрос без ключа, вызова модели и трат не будет).
readonly PROBE_PHONE="+7 916 555-01-23"
readonly PROBE_MODEL="guard-probe-nonexistent"
readonly DENIED_STATUS=422
readonly UPSTREAM_STATUSES="400 401 403"

# Переменные, которые добавляет патч: надстройка 1.1.12 ведёт себя как прежняя pragmatika_guard.
readonly -a WRAPPER_FLAGS=(PII_GUARD_WINDOWED_SCAN PII_GUARD_STRUCTURE_LIMIT
  PII_GUARD_MALLOC_TUNING)
readonly WORDS_KEY="PII_ALLOWED_WORDS"
readonly PROCESSES_KEY="PII_GUARD_SCAN_PROCESSES"

# ---------------------------------------------------------------------------------------------
# Python внутри контейнеров (на хосте не нужны ни python3, ни jq)
# ---------------------------------------------------------------------------------------------
# Вход: `docker compose config --format json`. Выход: только служба pii-guard - окружение,
# потолок памяти и сборка. Остальные службы (там секреты) не печатаются.
readonly PY_COMPOSE='
import json, sys
svc = json.load(sys.stdin)["services"]["pii-guard"]
for key, value in sorted((svc.get("environment") or {}).items()):
    print(f"env:{key}={value}")
print("mem_limit=" + str(svc.get("mem_limit", 0)))
build = svc.get("build") or {}
print("dockerfile=" + str(build.get("dockerfile", "")))
'
# Действующий список слов-исключений так, как его считает сама библиотека (профиль + env).
readonly PY_WORDS='
import re, sys
from labops_pii.allowlist import allowed_stems
words = sorted(set(allowed_stems()))
if any(re.fullmatch(r"[a-zа-я0-9][a-zа-я0-9 -]*", word) is None for word in words):
    sys.exit("в списке слов-исключений неожиданные символы")
print(",".join(words))
'
readonly PY_PROFILE_COUNT='
from labops_pii.profiles import get_profile
print(len(get_profile().allowed_words))
'
# Пробы через сам guard. Слова приходят на stdin и никуда не печатаются.
readonly PY_PROBE='
import json, sys, urllib.error, urllib.request
from labops_pii.guard.detector import scan_body
phone, model = sys.argv[1], sys.argv[2]
words = [w for w in sys.stdin.read().strip().split(",") if w]

def body(text):
    data = {"model": model, "max_tokens": 1, "messages": [{"role": "user", "content": text}]}
    return json.dumps(data, ensure_ascii=False).encode()

def status(text):
    request = urllib.request.Request(
        "http://127.0.0.1:8080/v1/messages", data=body(text),
        headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=60) as reply:
            return reply.status
    except urllib.error.HTTPError as error:
        return error.code

near = [w[:1].upper() + w[1:] + " И.П." for w in words]
clear = all("name" not in scan_body(body(text), require_json=True) for text in near)
tokens = "Клиент [PERSON_1], адрес [ADDRESS_1]. " + " ".join(near[:1])
print("phone=" + str(status("Тел " + phone)))
print(f"token={status(tokens)}")
print(f"words_clear={int(clear)}")
'

# ---------------------------------------------------------------------------------------------
# Журнал и общие функции
# ---------------------------------------------------------------------------------------------
LOG_FILE=""
RUN_DIR=""
WORK_DIR=""
OUT_DIR="${PATCH9W_OUT_DIR:-$HOME}"
SOAK_SECONDS="$DEFAULT_SOAK_SECONDS"
MODE="apply"
CHANGED=0
FINISHED=0
STAMP="$(date -u +%Y%m%d-%H%M%S)"
readonly STAMP
PROBE_CONTAINER="${PROJECT}-${SERVICE}-9w-probe"

log() {
  local line
  line="$(date -u +%H:%M:%S) $*"
  if [[ -n "$LOG_FILE" ]]; then printf '%s\n' "$line" >>"$LOG_FILE"; fi
  printf '%s\n' "$line" 2>/dev/null || true
}

refuse() {
  log "ОТКАЗ: $*"
  log "Бой не тронут."
  exit "$EXIT_REFUSED"
}

fail() {
  log "СБОЙ: $*"
  exit "$EXIT_ROLLED_BACK"
}

usage() {
  sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# Команда с выводом в журнал (на экран - только при ошибке: хвост вывода).
logged() {
  local out="$WORK_DIR/cmd.out" rc=0
  "$@" >"$out" 2>&1 || rc=$?
  cat "$out" >>"$LOG_FILE"
  if ((rc != 0)); then tail -n 20 "$out" 2>/dev/null || true; fi
  return "$rc"
}

dc() {
  (cd "$GW_DIR" && docker compose -p "$PROJECT" "$@")
}

service_container() {
  dc -f "$COMPOSE_BASE" ps -q "$1" 2>/dev/null
}

inspect() {
  docker inspect -f "$2" "$1"
}

health_of() {
  inspect "$1" '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}'
}

wait_healthy() {
  local container="$1" waited=0 state=""
  while ((waited <= HEALTH_TIMEOUT_SECONDS)); do
    state="$(health_of "$container" 2>/dev/null || true)"
    [[ "$state" == "running healthy" ]] && return 0
    case "$state" in exited* | dead*) break ;; esac
    sleep "$POLL_SECONDS"
    waited=$((waited + (POLL_SECONDS > 0 ? POLL_SECONDS : 1)))
  done
  log "контейнер не стал healthy (состояние: ${state:-нет})"
  return 1
}

# Значение KEY из строк «KEY=VALUE» (пусто, если ключа нет).
value_of() {
  local key="$1" lines="$2" line
  while IFS= read -r line; do
    if [[ "$line" == "$key="* ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  done <<<"$lines"
}

container_env() {
  inspect "$1" '{{range .Config.Env}}{{println .}}{{end}}'
}

front_ip() {
  inspect "$1" "{{with index .NetworkSettings.Networks \"$FRONT_NETWORK\"}}{{.IPAddress}}{{end}}"
}

tree_sums() {
  (cd "$GW_ROOT" && find gateway/pii-guard vendor/labops-pii -type f ! -path '*/__pycache__/*' \
    -print0 | LC_ALL=C sort -z | xargs -0 sha256sum)
}

file_sum() {
  sha256sum "$1" | cut -d' ' -f1
}

vendor_tag() {
  sed -n 's/^tag: *//p' "$1/VERSION" 2>/dev/null | head -n 1
}

# Контейнеры проекта, кроме pii-guard: ни один не должен пересоздаться или перезапуститься.
other_containers() {
  local id name
  for id in $(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.oneoff=False"); do
    name="$(inspect "$id" '{{index .Config.Labels "com.docker.compose.service"}}')"
    [[ "$name" == "$SERVICE" ]] && continue
    printf '%s %s %s\n' "$name" "$(inspect "$id" '{{.Id}}')" \
      "$(inspect "$id" '{{.State.StartedAt}}')"
  done | LC_ALL=C sort
}

remove_probe() {
  docker rm -f "$PROBE_CONTAINER" >/dev/null 2>&1 || true
}

probe_guard() {
  local container="$1" words="$2"
  docker exec -i "$container" python -c "$PY_PROBE" "$PROBE_PHONE" "$PROBE_MODEL" <<<"$words"
}

in_list() {
  [[ " $2 " == *" $1 "* ]]
}

# ---------------------------------------------------------------------------------------------
# Предусловия (ничего не меняют)
# ---------------------------------------------------------------------------------------------
check_package() {
  local tool
  for tool in docker sha256sum tar find df timeout sed awk; do
    command -v "$tool" >/dev/null 2>&1 || refuse "нет команды $tool"
  done
  docker compose version >/dev/null 2>&1 || refuse "нет docker compose"
  docker info >/dev/null 2>&1 || refuse "нет доступа к Docker (нужна группа docker)"
  [[ -f "$HERE/MANIFEST.sha256" && -f "$HERE/VERSION" ]] ||
    refuse "запуск не из распакованного пакета: нет MANIFEST.sha256 или VERSION"
  (cd "$HERE" && sha256sum --quiet -c MANIFEST.sha256 >/dev/null 2>&1) ||
    refuse "пакет повреждён: суммы MANIFEST.sha256 не сходятся"
  [[ "$(vendor_tag "$PKG_PLATFORM/vendor/labops-pii")" == "$NEW_VENDOR_TAG" ]] ||
    refuse "в пакете не labops-pii $NEW_VENDOR_TAG"
  log "пакет: цел; $(head -n 1 "$HERE/VERSION")"
}

check_tree() {
  local name dir
  [[ -d "$GW_DIR" && -f "$GW_DIR/$COMPOSE_BASE" && -f "$GW_DIR/.env" ]] ||
    refuse "нет $GW_DIR с $COMPOSE_BASE и .env"
  [[ -f "$VENDOR_DIR/VERSION" ]] || refuse "нет $VENDOR_DIR/VERSION"
  local tag
  tag="$(vendor_tag "$VENDOR_DIR")"
  log "вендор labops-pii: ${tag:-неизвестен}"
  log ".git-commit: $(head -n 1 "$GW_DIR/.git-commit" 2>/dev/null || echo 'нет файла')"
  if [[ "$tag" == "$NEW_VENDOR_TAG" ]] || [[ -d "$GW_DIR/$SERVICE/$NEW_MODULE" ]]; then
    refuse "патч уже применён (вендор $tag); откат: --rollback"
  fi
  [[ "$tag" == "$OLD_VENDOR_TAG" ]] || refuse "ждали вендор $OLD_VENDOR_TAG"
  [[ -d "$GW_DIR/$SERVICE/$OLD_MODULE" ]] || refuse "нет модуля $SERVICE/$OLD_MODULE"
  for name in "$OVERRIDE" docker-compose.override.yaml compose.override.yml \
    compose.override.yaml compose.yml compose.yaml; do
    [[ ! -e "$GW_DIR/$name" ]] || refuse "в $GW_DIR есть посторонний файл compose: $name"
  done
  [[ -z "${COMPOSE_FILE:-}" ]] || refuse "в окружении запуска задан COMPOSE_FILE"
  if grep -qE '^[[:space:]]*(export[[:space:]]+)?COMPOSE_FILE=' "$GW_DIR/.env"; then
    refuse "в .env задан COMPOSE_FILE: override не подхватился бы"
  fi
  log "чужих override и COMPOSE_FILE нет"
  for dir in "$GW_DIR" "$GW_ROOT/vendor" "$GW_DIR/$SERVICE" "$VENDOR_DIR"; do
    [[ -z "$(find "$dir" -type d ! -writable -print -quit 2>/dev/null)" ]] ||
      refuse "нет прав на запись внутри $dir"
  done
  # Ближайший существующий каталог на пути к config-env.sh должен быть доступен на запись
  dir="$(dirname "$CONFIG_ENV")"
  while [[ ! -d "$dir" ]]; do dir="$(dirname "$dir")"; done
  [[ -w "$dir" ]] || refuse "нет прав создать $CONFIG_ENV (каталог $dir)"
  [[ -z "$(find "$GW_DIR" "$GW_ROOT/vendor" ! -readable -print -quit 2>/dev/null)" ]] ||
    refuse "в gateway или vendor есть нечитаемые файлы: бэкап был бы неполным"
}

# Значения из окружения оболочки сильнее .env: без сброса compose собрал бы другую службу.
unset_compose_variables() {
  local name
  for name in $(grep -ohE '\$\{[A-Z0-9_]+' "$GW_DIR/$COMPOSE_BASE" | tr -d '${' | sort -u) \
    "${WRAPPER_FLAGS[@]}" "$WORDS_KEY" COMPOSE_PROJECT_NAME; do
    case "$name" in HOME | PATH | USER | PWD) continue ;; esac
    unset "$name"
  done
}

CONTAINER=""
NGINX_CONTAINER=""
IMAGE_REF=""
IMAGE_REPO=""
OLD_IMAGE_ID=""
OLD_ENV=""
COMPOSE_FACTS=""
COMPOSE_KEYS=()
WORDS=""
WORDS_COUNT=0
OLD_TOKEN_STATUS=""
SCAN_PROCESSES=""

check_container() {
  local label state
  unset_compose_variables
  dc -f "$COMPOSE_BASE" config -q >/dev/null 2>&1 || refuse "compose боя не проверяется"
  CONTAINER="$(service_container "$SERVICE")"
  [[ -n "$CONTAINER" && "$CONTAINER" != *$'\n'* ]] ||
    refuse "в проекте $PROJECT нет ровно одного запущенного $SERVICE"
  state="$(health_of "$CONTAINER")"
  [[ "$state" == "running healthy" ]] || refuse "$SERVICE не healthy: $state"
  NGINX_CONTAINER="$(service_container "$NGINX_SERVICE")"
  [[ -n "$NGINX_CONTAINER" ]] || refuse "нет запущенного $NGINX_SERVICE"
  docker exec "$NGINX_CONTAINER" nginx -t >/dev/null 2>&1 ||
    refuse "nginx -t не проходит: после замены guard nginx нельзя было бы перечитать"
  label="$(inspect "$CONTAINER" \
    '{{index .Config.Labels "com.docker.compose.project.config_files"}}')"
  [[ "$label" == "$GW_DIR/$COMPOSE_BASE" ]] ||
    refuse "контейнер создан не только из $COMPOSE_BASE: $label"
  docker exec "$CONTAINER" python -c "import $OLD_MODULE, labops_pii.profiles" \
    >/dev/null 2>&1 || refuse "в контейнере нет $OLD_MODULE и профилей labops-pii 0.8.0"
  IMAGE_REF="$(inspect "$CONTAINER" '{{.Config.Image}}')"
  IMAGE_REPO="${IMAGE_REF%:*}"
  [[ "$IMAGE_REF" != *@* && "$IMAGE_REPO" != */ ]] || refuse "образ задан digest: $IMAGE_REF"
  OLD_IMAGE_ID="$(inspect "$CONTAINER" '{{.Image}}')"
  OLD_ENV="$(container_env "$CONTAINER")"
  log "модуль guard: $OLD_MODULE; контейнер healthy; образ $IMAGE_REF"
}

# Запущенный контейнер должен совпадать с тем, что соберёт compose: иначе пересоздание молча
# сменило бы режим или маршрут (например, .env поправили, а службу не пересоздали).
check_settings() {
  local line key value actual drift=() memory compose_mem need vision body vision_body name
  COMPOSE_FACTS="$(dc -f "$COMPOSE_BASE" config --format json 2>/dev/null |
    docker exec -i "$CONTAINER" python -c "$PY_COMPOSE")" || refuse "не разобрать compose config"
  [[ "$(value_of dockerfile "$COMPOSE_FACTS")" == "gateway/$SERVICE/Dockerfile" ]] ||
    refuse "служба $SERVICE собирается из неожиданного Dockerfile"
  COMPOSE_KEYS=()
  while IFS= read -r line; do
    [[ "$line" == env:* ]] || continue
    line="${line#env:}"
    key="${line%%=*}"
    value="${line#*=}"
    COMPOSE_KEYS+=("$key")
    actual="$(value_of "$key" "$OLD_ENV")"
    [[ "$actual" == "$value" ]] || drift+=("$key")
  done <<<"$COMPOSE_FACTS"
  ((${#drift[@]} == 0)) ||
    refuse "compose и .env расходятся с запущенным контейнером по: ${drift[*]}"
  for name in PII_GUARD_NAMES_MODE PII_GUARD_ADDRESS_MODE; do
    value="$(value_of "$name" "$OLD_ENV")"
    in_list "$value" "off log_only enforce" || refuse "неизвестное значение $name"
    log "режим $name=$value"
  done
  for name in SEARCH_ROUTE_ENABLED VISION_ROUTE_ENABLED WEBPAGE_ROUTE_ENABLED; do
    log "маршрут $name=$(value_of "$name" "$OLD_ENV")"
  done
  if [[ "$(value_of SEARCH_ROUTE_ENABLED "$OLD_ENV")" == "1" &&
    -z "$(value_of SEARCH_ALLOWED_MODELS "$OLD_ENV")" ]]; then
    refuse "SEARCH_ROUTE_ENABLED=1 с пустым SEARCH_ALLOWED_MODELS: новый guard не стартует"
  fi
  [[ -z "$(value_of "env:LABOPS_PII_PROFILE" "$COMPOSE_FACTS")" ]] ||
    refuse "compose передаёт LABOPS_PII_PROFILE: новый guard с ним не стартует"

  SCAN_PROCESSES="$(value_of "$PROCESSES_KEY" "$OLD_ENV")"
  SCAN_PROCESSES="${SCAN_PROCESSES:-$DEFAULT_SCAN_PROCESSES}"
  [[ "$SCAN_PROCESSES" =~ ^[0-9]+$ ]] && ((SCAN_PROCESSES <= MAX_SCAN_PROCESSES)) ||
    refuse "$PROCESSES_KEY вне 0..$MAX_SCAN_PROCESSES"
  vision="$(value_of VISION_MAX_CONCURRENT "$OLD_ENV")"
  vision="${vision:-$DEFAULT_VISION_CONCURRENT}"
  body="$(value_of MAX_BODY_BYTES "$OLD_ENV")"
  vision_body="$(value_of VISION_MAX_BODY_BYTES "$OLD_ENV")"
  [[ "$vision" =~ ^[0-9]+$ && "${body:-0}" =~ ^[0-9]+$ && "${vision_body:-0}" =~ ^[0-9]+$ ]] ||
    refuse "пределы тел или зрения не числа"
  ((${body:-0} <= MAX_BODY_MEASURED)) ||
    refuse "MAX_BODY_BYTES=$body больше замеренного $MAX_BODY_MEASURED"
  ((${vision_body:-0} <= MAX_VISION_BODY_MEASURED)) ||
    refuse "VISION_MAX_BODY_BYTES=$vision_body больше замеренного $MAX_VISION_BODY_MEASURED"
  memory="$(inspect "$CONTAINER" '{{.HostConfig.Memory}}')"
  compose_mem="$(value_of mem_limit "$COMPOSE_FACTS")"
  [[ "$memory" == "$compose_mem" ]] ||
    refuse "mem_limit контейнера ($memory) не равен compose ($compose_mem)"
  need=$(((MEM_TREE_IDLE_MIB + MEM_POOL_COPIES_MIB + MEM_REQUEST_SLOTS_MIB +
    SCAN_PROCESSES * MEM_PER_PROCESS_MIB + vision * MEM_PER_VISION_MIB) *
    MEM_MARGIN_PERCENT + PERCENT - 1))
  need=$((need / PERCENT))
  log "mem_limit $SERVICE: $((memory / MIB)) МиБ; новому коду нужно не меньше $need МиБ" \
    "(процессов $SCAN_PROCESSES, зрение $vision)"
  ((memory == 0 || memory >= need * MIB)) ||
    refuse "mem_limit $((memory / MIB)) МиБ меньше нужных $need МиБ"
  log "MAX_BODY_BYTES=${body:-по умолчанию}; $PROCESSES_KEY=$SCAN_PROCESSES"
}

check_words() {
  local profile_count
  WORDS="$(docker exec "$CONTAINER" python -c "$PY_WORDS" 2>/dev/null)" ||
    refuse "не получить список слов-исключений из работающего guard"
  profile_count="$(docker exec "$CONTAINER" python -c "$PY_PROFILE_COUNT" 2>/dev/null)" ||
    refuse "не получить профиль работающего guard"
  WORDS_COUNT=0
  if [[ -n "$WORDS" ]]; then WORDS_COUNT="$(tr ',' '\n' <<<"$WORDS" | grep -c .)"; fi
  log "слов-исключений действует: $WORDS_COUNT (в профиле: $profile_count); значения скрыты"
  if ((profile_count > 0 && WORDS_COUNT == 0)); then
    refuse "профиль задаёт слова-исключения, а действующий список пуст"
  fi
  if grep -qE "^[[:space:]]*(export[[:space:]]+)?$WORDS_KEY=" "$GW_DIR/.env"; then
    log "ВНИМАНИЕ: в .env есть $WORDS_KEY; старый guard его не получал, действует override"
  fi
}

check_resources() {
  local path free memory docker_root
  docker_root="$(docker info -f '{{.DockerRootDir}}')"
  for path in "$(dirname "$BACKUP_ROOT")" "$docker_root"; do
    free="$(df -Pm "$path" 2>/dev/null | awk 'NR == 2 { print $4 }')"
    if [[ -z "$free" ]]; then
      log "диск $path: не прочитать"
      continue
    fi
    log "свободно на диске ($path): $free МиБ"
    ((free >= MIN_DISK_MIB)) || refuse "на диске меньше $MIN_DISK_MIB МиБ"
  done
  memory="$(awk '/^MemAvailable:/ { print int($2 / 1024) }' "$MEMINFO")"
  log "доступно памяти: $memory МиБ"
  ((memory >= MIN_MEM_MIB)) || refuse "доступной памяти меньше $MIN_MEM_MIB МиБ"
  if docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
    log "базовый образ $BASE_IMAGE есть на хосте"
  else
    log "базового образа $BASE_IMAGE нет: сборка скачает его"
  fi
}

check_behaviour() {
  local out phone clear
  out="$(probe_guard "$CONTAINER" "$WORDS" 2>/dev/null)" || refuse "пробы старого guard не прошли"
  phone="$(value_of phone "$out")"
  OLD_TOKEN_STATUS="$(value_of token "$out")"
  clear="$(value_of words_clear "$out")"
  log "пробы старого guard: телефон $phone, только токены $OLD_TOKEN_STATUS," \
    "слово рядом с инициалом без name: $clear"
  [[ "$phone" == "$DENIED_STATUS" ]] || refuse "старый guard не отклонил телефон"
  in_list "$OLD_TOKEN_STATUS" "$UPSTREAM_STATUSES" ||
    refuse "запрос с токенами без ключа не дошёл до litellm (статус $OLD_TOKEN_STATUS)"
  [[ "$clear" == "1" ]] || refuse "старый guard находит name рядом со словом-исключением"
}

preflight() {
  check_package
  check_tree
  check_container
  check_settings
  check_words
  check_resources
  check_behaviour
  log "контейнеры проекта (кроме $SERVICE): $(other_containers | cut -d' ' -f1 | tr '\n' ' ')"
  log "предусловия выполнены"
}

# ---------------------------------------------------------------------------------------------
# Состояние запуска, бэкап, сборка
# ---------------------------------------------------------------------------------------------
save_state() {
  printf '%s=%s\n' "$1" "$2" >>"$RUN_DIR/state"
}

state_of() {
  # Последнее значение ключа: состояние только дописывается
  sed -n "s/^$1=//p" "$RUN_DIR/state" | tail -n 1
}

backup() {
  RUN_DIR="$BACKUP_ROOT/$BACKUP_PREFIX$STAMP"
  mkdir -p "$BACKUP_ROOT"
  mkdir "$RUN_DIR" || refuse "каталог бэкапа уже есть: $RUN_DIR"
  chmod 700 "$RUN_DIR"
  tar czf "$RUN_DIR/gateway.tgz" -C "$GW_ROOT" gateway || refuse "бэкап gateway не удался"
  tar czf "$RUN_DIR/vendor.tgz" -C "$GW_ROOT" vendor || refuse "бэкап vendor не удался"
  tar tzf "$RUN_DIR/gateway.tgz" gateway/.env >/dev/null 2>&1 || refuse "в бэкапе нет .env"
  tar tzf "$RUN_DIR/vendor.tgz" >/dev/null || refuse "бэкап vendor не читается"
  chmod 600 "$RUN_DIR/gateway.tgz" "$RUN_DIR/vendor.tgz"
  tree_sums >"$RUN_DIR/tree-before.sha256"
  other_containers >"$RUN_DIR/others-before"
  : >"$RUN_DIR/state"
  save_state IMAGE_REF "$IMAGE_REF"
  save_state OLD_IMAGE_ID "$OLD_IMAGE_ID"
  save_state ROLLBACK_TAG "$IMAGE_REPO:pre-9w"
  save_state ENV_SUM "$(file_sum "$GW_DIR/.env")"
  local created=""
  if [[ -f "$CONFIG_ENV" ]]; then
    cp -p "$CONFIG_ENV" "$RUN_DIR/config-env.sh.before"
    save_state CONFIG_ENV_EXISTED 1
  else
    save_state CONFIG_ENV_EXISTED 0
    [[ -d "$GW_ROOT/deploy/docker" ]] || created="deploy/docker"
    [[ -d "$GW_ROOT/deploy" ]] || created="deploy/docker deploy"
  fi
  save_state CREATED_DIRS "$created"
  # Значения настроек до замены (без секретов: только окружение pii-guard из compose)
  local key
  : >"$RUN_DIR/env-before"
  for key in "${COMPOSE_KEYS[@]}"; do
    printf '%s=%s\n' "$key" "$(value_of "$key" "$OLD_ENV")" >>"$RUN_DIR/env-before"
  done
  docker tag "$OLD_IMAGE_ID" "$IMAGE_REPO:pre-9w" || refuse "не создать метку отката"
  [[ "$(docker image inspect -f '{{.Id}}' "$IMAGE_REPO:pre-9w")" == "$OLD_IMAGE_ID" ]] ||
    refuse "метка отката указывает не на старый образ"
  save_state STATUS prepared
  log "бэкап: $RUN_DIR; метка отката $IMAGE_REPO:pre-9w"
}

write_override() {
  local target="$1" flag
  {
    echo "$OVERRIDE_MARK: создан update-guard.sh, удаляется откатом (--rollback)."
    echo "# Только окружение pii-guard для кода платформы 1.1.12. Не удалять при выкатках кода."
    echo "services:"
    echo "  $SERVICE:"
    echo "    environment:"
    for flag in "${WRAPPER_FLAGS[@]}"; do echo "      $flag: \"1\""; done
    if [[ -z "$(value_of "env:$PROCESSES_KEY" "$COMPOSE_FACTS")" ]]; then
      echo "      $PROCESSES_KEY: \"$SCAN_PROCESSES\""
    fi
    echo "      $WORDS_KEY: \"$WORDS\""
  } >"$target"
  chmod 600 "$target"
}

build_candidate() {
  local context="$WORK_DIR/context" version
  mkdir -p "$context"
  cp -R "$PKG_PLATFORM/." "$context/"
  # COPY переносит права файлов в образ, а служба работает не от root
  chmod -R u=rwX,go=rX "$context"
  log "сборка нового образа (старый guard продолжает работать)"
  logged timeout "$BUILD_TIMEOUT_SECONDS" docker build -t "$IMAGE_REPO:9w-candidate" \
    "${BUILD_LABEL[@]}" -f "$context/gateway/$SERVICE/Dockerfile" "$context" ||
    refuse "образ не собрался (нужен доступ к PyPI и Docker Hub); подробности в журнале"
  version="$(docker run --rm --network none "${BUILD_LABEL[@]}" --entrypoint python \
    "$IMAGE_REPO:9w-candidate" -c \
    "import labops_pii, $NEW_MODULE; print(labops_pii.__version__)" 2>/dev/null)" ||
    refuse "в новом образе не импортируются $NEW_MODULE и labops_pii"
  [[ "$version" == "$NEW_LIBRARY_VERSION" ]] ||
    refuse "в новом образе labops-pii $version, ждали $NEW_LIBRARY_VERSION"
  log "образ собран, labops-pii $version"
}

# Окружение контейнера: прежние настройки, флаги надстройки и тот же набор слов.
check_new_environment() {
  local container="$1" env line key words
  env="$(container_env "$container")"
  while IFS= read -r line; do
    key="${line%%=*}"
    [[ "$(value_of "$key" "$env")" == "${line#*=}" ]] || {
      log "настройка $key изменилась"
      return 1
    }
  done <"$RUN_DIR/env-before"
  for key in "${WRAPPER_FLAGS[@]}"; do
    [[ "$(value_of "$key" "$env")" == "1" ]] || {
      log "флаг $key не задан"
      return 1
    }
  done
  [[ -z "$(value_of LABOPS_PII_PROFILE "$env")" ]] || {
    log "в новом контейнере задан LABOPS_PII_PROFILE"
    return 1
  }
  words="$(docker exec "$container" python -c "$PY_WORDS" 2>/dev/null)" || return 1
  [[ "$words" == "$WORDS" ]] || {
    log "набор слов-исключений нового guard не совпал со старым"
    return 1
  }
  log "настройки прежние; слов-исключений $WORDS_COUNT, набор совпал"
}

check_new_guard() {
  local container="$1" out version
  version="$(docker exec "$container" python -c \
    "import labops_pii, $NEW_MODULE; print(labops_pii.__version__)" 2>/dev/null)" || return 1
  [[ "$version" == "$NEW_LIBRARY_VERSION" ]] || {
    log "версия библиотеки $version"
    return 1
  }
  check_new_environment "$container" || return 1
  out="$(probe_guard "$container" "$WORDS" 2>/dev/null)" || {
    log "пробы не выполнились"
    return 1
  }
  log "пробы: телефон $(value_of phone "$out"), только токены $(value_of token "$out")," \
    "слово рядом с инициалом без name: $(value_of words_clear "$out")"
  [[ "$(value_of phone "$out")" == "$DENIED_STATUS" ]] || return 1
  [[ "$(value_of token "$out")" == "$OLD_TOKEN_STATUS" ]] || return 1
  [[ "$(value_of words_clear "$out")" == "1" ]] || return 1
}

# Новый код с настройками боя в отдельном одноразовом контейнере: те же mem_limit, read_only и
# сети, но без имени службы в сети, поэтому запросы nginx в него не попадают.
probe_candidate() {
  write_override "$RUN_DIR/override.yml"
  printf 'services:\n  %s:\n    image: %s\n' "$SERVICE" "$IMAGE_REPO:9w-candidate" \
    >"$RUN_DIR/probe.yml"
  remove_probe
  logged dc -f "$COMPOSE_BASE" -f "$RUN_DIR/override.yml" -f "$RUN_DIR/probe.yml" \
    run -d --no-deps --name "$PROBE_CONTAINER" "$SERVICE" ||
    refuse "пробный контейнер не запустился"
  if ! wait_healthy "$PROBE_CONTAINER"; then
    docker logs --tail 30 "$PROBE_CONTAINER" >>"$LOG_FILE" 2>&1 || true
    refuse "новый guard с настройками боя не стал healthy"
  fi
  check_new_guard "$PROBE_CONTAINER" || refuse "новый guard с настройками боя не прошёл пробы"
  remove_probe
  log "новый образ проверен с настройками боя"
}

# ---------------------------------------------------------------------------------------------
# Замена и откат
# ---------------------------------------------------------------------------------------------
# nginx держит адрес pii-guard с момента старта: если Docker выдал новому контейнеру другой
# адрес, перечитать конфигурацию (контейнер nginx не пересоздаётся). Пустой известный адрес
# (откат) - перечитать всегда. Вызывается сразу после запуска контейнера: если ждать healthy,
# простой растёт с секунд до первой проверки здоровья.
reload_nginx() {
  local container="$1" known_ip="$2" ip nginx
  ip="$(front_ip "$container")"
  if [[ "$ip" == "$known_ip" ]]; then
    log "адрес pii-guard прежний: nginx не трогается"
    return 0
  fi
  nginx="$(service_container "$NGINX_SERVICE")"
  logged docker exec "$nginx" nginx -t || return 1
  logged docker exec "$nginx" nginx -s reload || return 1
  log "адрес pii-guard сменился: nginx перечитал конфигурацию"
}

check_nginx_path() {
  docker exec "$(service_container "$NGINX_SERVICE")" wget -q -O /dev/null -T 10 \
    "http://$SERVICE:8080/_guard/healthz" >/dev/null 2>&1 || {
    log "из nginx guard недоступен"
    return 1
  }
}

check_others() {
  local now
  now="$(other_containers)"
  [[ "$now" == "$(cat "$RUN_DIR/others-before")" ]] || {
    log "другие контейнеры проекта пересозданы или перезапущены"
    return 1
  }
  log "nginx, litellm и остальные контейнеры не пересоздавались"
}

replace_files() {
  local context="$WORK_DIR/context"
  rm -rf "${GW_DIR:?}/${SERVICE:?}" "${VENDOR_DIR:?}"
  cp -R "$context/gateway/$SERVICE" "$GW_DIR/$SERVICE"
  cp -R "$context/vendor/labops-pii" "$VENDOR_DIR"
  mkdir -p "$(dirname "$CONFIG_ENV")"
  cp "$context/$CONFIG_ENV_REL" "$CONFIG_ENV"
  chmod -R u=rwX,go=rX "$GW_DIR/$SERVICE" "$VENDOR_DIR"
  chmod 755 "$CONFIG_ENV"
  local dir
  for dir in $(state_of CREATED_DIRS); do chmod 755 "$GW_ROOT/$dir"; done
  cp "$RUN_DIR/override.yml" "$GW_DIR/$OVERRIDE"
  chmod 600 "$GW_DIR/$OVERRIDE"
  log "файлы pii-guard, vendor, config-env.sh и override установлены"
}

apply() {
  local container old_ip started errors restarts reloaded=0
  old_ip="$(front_ip "$CONTAINER")"
  CHANGED=1
  save_state STATUS applying
  replace_files
  dc -f "$COMPOSE_BASE" -f "$OVERRIDE" config -q >/dev/null 2>&1 ||
    fail "compose с override не проверяется"
  docker tag "$IMAGE_REPO:9w-candidate" "$IMAGE_REF" || fail "не назначить образ службе"
  log "пересоздаю только $SERVICE"
  started="$(date +%s)"
  logged dc -f "$COMPOSE_BASE" -f "$OVERRIDE" up -d --no-deps --no-build --force-recreate \
    "$SERVICE" || fail "compose up не удался"
  container="$(service_container "$SERVICE")"
  [[ -n "$container" ]] || fail "нет контейнера $SERVICE после замены"
  # Неудача ранней попытки не решает: после healthy перечитывание повторяется
  if reload_nginx "$container" "$old_ip"; then reloaded=1; fi
  wait_healthy "$container" || fail "новый $SERVICE не healthy"
  ((reloaded)) || reload_nginx "$container" "$old_ip" || fail "nginx не перечитал конфигурацию"
  check_nginx_path || fail "nginx не видит новый guard"
  log "замена заняла $(($(date +%s) - started)) с (до healthy)"
  [[ "$(inspect "$container" '{{.Image}}')" == "$(docker image inspect -f '{{.Id}}' \
    "$IMAGE_REPO:9w-candidate")" ]] || fail "контейнер работает не на новом образе"
  check_new_guard "$container" || fail "проверки нового guard не прошли"
  check_others || fail "задеты другие службы"
  [[ "$(file_sum "$GW_DIR/.env")" == "$(state_of ENV_SUM)" ]] || fail ".env изменился"
  log "выдержка $SOAK_SECONDS с"
  sleep "$SOAK_SECONDS"
  [[ "$(health_of "$container")" == "running healthy" ]] || fail "после выдержки не healthy"
  restarts="$(inspect "$container" '{{.RestartCount}}')"
  [[ "$restarts" == "0" ]] || fail "перезапусков после замены: $restarts"
  errors="$(docker logs "$container" 2>&1 | grep -cE 'pii_guard_failed|Traceback' || true)"
  log "ошибок в журнале guard после замены: $errors"
  [[ "$errors" == "0" ]] || fail "в журнале guard есть ошибки"
  save_state STATUS applied
}

# Возврат файлов, метки образа и контейнера. Без сети и без сборки.
restore() {
  local ref tag container dir reloaded=0
  ref="$(state_of IMAGE_REF)"
  tag="$(state_of ROLLBACK_TAG)"
  [[ -n "$ref" && -n "$tag" ]] || return 1
  docker image inspect "$tag" >/dev/null 2>&1 || {
    log "нет метки отката $tag"
    return 1
  }
  tar tzf "$RUN_DIR/gateway.tgz" >/dev/null && tar tzf "$RUN_DIR/vendor.tgz" >/dev/null ||
    return 1
  rm -rf "${GW_DIR:?}/${SERVICE:?}" "${VENDOR_DIR:?}"
  tar xzpf "$RUN_DIR/gateway.tgz" -C "$GW_ROOT" "gateway/$SERVICE" || return 1
  tar xzpf "$RUN_DIR/vendor.tgz" -C "$GW_ROOT" vendor/labops-pii || return 1
  if grep -q "^$OVERRIDE_MARK" "$GW_DIR/$OVERRIDE" 2>/dev/null; then
    rm -f "${GW_DIR:?}/${OVERRIDE:?}"
  fi
  if [[ "$(state_of CONFIG_ENV_EXISTED)" == "1" ]]; then
    cp -p "$RUN_DIR/config-env.sh.before" "$CONFIG_ENV" || return 1
  else
    rm -f "${CONFIG_ENV:?}"
    for dir in $(state_of CREATED_DIRS); do rmdir "${GW_ROOT:?}/$dir" 2>/dev/null || true; done
  fi
  [[ "$(tree_sums)" == "$(cat "$RUN_DIR/tree-before.sha256")" ]] || {
    log "восстановленные файлы не совпали с суммами до замены"
    return 1
  }
  docker tag "$tag" "$ref" || return 1
  logged dc -f "$COMPOSE_BASE" up -d --no-deps --no-build --force-recreate "$SERVICE" ||
    return 1
  container="$(service_container "$SERVICE")"
  [[ -n "$container" ]] || return 1
  if reload_nginx "$container" ""; then reloaded=1; fi
  wait_healthy "$container" || return 1
  [[ "$(inspect "$container" '{{.Image}}')" == "$(state_of OLD_IMAGE_ID)" ]] || return 1
  ((reloaded)) || reload_nginx "$container" "" || return 1
  check_nginx_path || return 1
  local env line
  env="$(container_env "$container")"
  while IFS= read -r line; do
    [[ "$(value_of "${line%%=*}" "$env")" == "${line#*=}" ]] || return 1
  done <"$RUN_DIR/env-before"
  docker exec "$container" python -c "import $OLD_MODULE, labops_pii.profiles" >/dev/null 2>&1 ||
    return 1
  save_state STATUS rolled_back
  log "прежний guard восстановлен и healthy"
}

result_archive() {
  local archive="$OUT_DIR/patch9w-gw-$STAMP.tgz" dir="$WORK_DIR/patch9w-gw-$STAMP"
  [[ -n "$LOG_FILE" && -d "$OUT_DIR" ]] || return 0
  mkdir -p "$dir"
  cp "$LOG_FILE" "$dir/run.log"
  cp "$HERE/VERSION" "$dir/VERSION" 2>/dev/null || true
  if tar czf "$archive" -C "$WORK_DIR" "patch9w-gw-$STAMP" 2>/dev/null; then
    printf 'Архив результата (без секретов): %s\n' "$archive" 2>/dev/null || true
  fi
}

on_exit() {
  local code=$?
  trap - EXIT
  trap '' INT TERM HUP
  set +e
  remove_probe
  if ((CHANGED == 1 && FINISHED == 0)); then
    log "АВТООТКАТ"
    if (restore); then
      log "откат выполнен: бой как до патча"
      code=$EXIT_ROLLED_BACK
    else
      log "ОТКАТ НЕ УДАЛСЯ. Бэкап: $RUN_DIR. Нужно ручное вмешательство."
      code=$EXIT_BROKEN
    fi
  fi
  # Пока файлы не менялись, любой неожиданный код означает «бой не тронут»
  if ((CHANGED == 0)); then
    case "$code" in
      "$EXIT_OK" | "$EXIT_USAGE" | "$EXIT_REFUSED" | "$EXIT_BROKEN") ;;
      *) code=$EXIT_REFUSED ;;
    esac
  fi
  result_archive
  [[ -n "$WORK_DIR" ]] && rm -rf "${WORK_DIR:?}"
  exit "$code"
}

latest_run_dir() {
  local dir found=""
  for dir in "$BACKUP_ROOT/$BACKUP_PREFIX"*; do
    [[ -f "$dir/state" ]] || continue
    case "$(sed -n 's/^STATUS=//p' "$dir/state" | tail -n 1)" in
      applied | applying) found="$dir" ;;
    esac
  done
  printf '%s' "$found"
}

manual_rollback() {
  command -v docker >/dev/null 2>&1 || refuse "нет команды docker"
  [[ -n "$RUN_DIR" ]] || RUN_DIR="$(latest_run_dir)"
  [[ -n "$RUN_DIR" && -f "$RUN_DIR/state" ]] || refuse "нет применённого запуска для отката"
  case "$(state_of STATUS)" in
    applied | applying) ;;
    *) refuse "запуск $RUN_DIR не применён (статус $(state_of STATUS))" ;;
  esac
  [[ -d "$GW_DIR" ]] || refuse "нет $GW_DIR"
  unset_compose_variables
  [[ "$(file_sum "$GW_DIR/.env")" == "$(state_of ENV_SUM)" ]] ||
    log "ВНИМАНИЕ: .env меняли после патча; откат .env не трогает"
  log "откат по $RUN_DIR"
  # Начатый откат не прерывается обрывом ssh или Ctrl+C
  trap '' INT TERM HUP
  other_containers >"$RUN_DIR/others-before"
  if (restore); then
    check_others || log "ВНИМАНИЕ: проверьте остальные службы"
    log "ГОТОВО: откат выполнен"
    return 0
  fi
  log "ОТКАТ НЕ УДАЛСЯ. Бэкап: $RUN_DIR. Нужно ручное вмешательство."
  exit "$EXIT_BROKEN"
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --preflight-only) MODE="preflight" ;;
      --rollback) MODE="rollback" ;;
      --run-dir | --out-dir | --soak-seconds)
        (($# >= 2)) || { echo "нет значения у $1" >&2; exit "$EXIT_USAGE"; }
        case "$1" in
          --run-dir) RUN_DIR="$2" ;;
          --out-dir) OUT_DIR="$2" ;;
          --soak-seconds) SOAK_SECONDS="$2" ;;
        esac
        shift
        ;;
      --help | -h)
        usage
        exit "$EXIT_OK"
        ;;
      *)
        echo "неизвестный параметр: $1" >&2
        exit "$EXIT_USAGE"
        ;;
    esac
    shift
  done
  [[ "$SOAK_SECONDS" =~ ^[0-9]+$ ]] || { echo "--soak-seconds: число" >&2; exit "$EXIT_USAGE"; }
  [[ -z "$RUN_DIR" || "$MODE" == "rollback" ]] || {
    echo "--run-dir только вместе с --rollback" >&2
    exit "$EXIT_USAGE"
  }
}

main() {
  parse_args "$@"
  [[ -d "$OUT_DIR" ]] || { echo "нет каталога $OUT_DIR" >&2; exit "$EXIT_USAGE"; }
  WORK_DIR="$(mktemp -d)"
  LOG_FILE="$WORK_DIR/run.log"
  : >"$LOG_FILE"
  trap on_exit EXIT
  trap 'exit "$EXIT_ROLLED_BACK"' INT TERM HUP
  log "патч шлюза 9w, режим: $MODE"
  case "$MODE" in
    rollback)
      manual_rollback
      ;;
    preflight)
      preflight
      log "ГОТОВО: только проверки, бой не менялся"
      ;;
    apply)
      preflight
      backup
      build_candidate
      probe_candidate
      apply
      FINISHED=1
      log "ГОТОВО: pii-guard обновлён и проверен. Откат: bash update-guard.sh --rollback"
      ;;
  esac
}

main "$@"
