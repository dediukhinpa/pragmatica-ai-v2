#!/usr/bin/env bash
# Патч G8: проектные маршруты /docx/* в образе documents, лимит alloy 448m, снятие обхода
# /docx/* (КРАСНАЯ ЗОНА: запускает только владелец на боевом хосте).
#
# Использование:
#   bash patch.sh [--preflight-only] [--signatures-verified ФАЙЛ] [--images-tar ФАЙЛ]
#                 [--config ФАЙЛ] [--out-dir КАТАЛОГ] [--soak-seconds N] [--expected-bots N]
#   bash patch.sh --rollback [--run-dir КАТАЛОГ]   откат применённого патча вручную
#   bash patch.sh --help
#
# Что делает (бой = compose-проект `pragmatika`, дерево /opt/pragmatika-v2/deploy; БД, миграции,
# образ app, тома и секреты патч НЕ трогает):
#   0. Предусловия, бой не меняется: целостность пакета (MANIFEST.sha256), подписи ВСЕХ образов
#      lock (cosign на хосте либо --signatures-verified: вывод verify-signatures.sh; по умолчанию
#      signatures.txt рядом с пакетом; молча пропускать нельзя), в пакете нет миграций, lock
#      пакета отличается от боевого ТОЛЬКО образом documents (и версией), образ app тот же,
#      бой здоров (/ready 200, ботов не меньше ожидаемого), свободны диск и память, образ
#      documents на хосте (docker load / pull), конфигурация compose новых файлов собирается,
#      маршруты, которые вызывает app, есть в образе documents (tools/check-image-routes.sh).
#      Любое нарушение - код 3, бой не тронут. С --preflight-only на этом всё.
#   1. Бэкап файлов дерева (весь каталог deploy, права сохраняются, .env 600) и снимок
#      контейнеров и образов: ~/backups/pragmatika-patch-<время>.
#   2. Замена файлов compose и images.lock (только из пакета, список ниже) и пересоздание
#      ТОЛЬКО затронутых сервисов без обхода: documents, alloy (если был), app (простой app
#      ~30 с: ядро перезапускается на адрес documents без маршрутизатора обхода).
#   3. Проверки: documents healthy, /ready 200 и ботов не меньше ожидаемого, образы запущенных
#      сервисов = lock, лимит alloy 448 МиБ, ВСЕ маршруты стека не 404/405 (tools/check-routes.sh),
#      смоук сборки договора по HTTP на синтетическом docx (amend, party-block, replace-signatory,
#      classify), затем удаление контейнеров обхода documents-router и documents-legacy (тег
#      pragmatika-documents:legacy-docx НЕ удаляется: по нему работает откат), повторные проверки
#      и выдержка (по умолчанию 2 минуты: контейнеры не перезапускаются, /ready 200).
#   Любой сбой после начала изменений -> автоматический откат: файлы дерева возвращаются из
#   бэкапа, поднимается стек с обходом (как hotfix/dc-v2.sh up -d), проверяется /ready.
# Результат: ~/patch-<время>.tgz (журнал, проверки; без секретов и данных) - вернуть разработчику.
#
# Коды выхода: 0 - патч применён и проверен; 1 - сбой, откат выполнен (бой с обходом, как до
# патча); 2 - неверный вызов; 3 - отказ по предусловиям, бой не тронут; 4 - сбой, откат тоже не
# удался (ручное вмешательство: OWNER-RUNBOOK.md, журнал).
set -euo pipefail
umask 077

# ---------------------------------------------------------------------------------------------
# Константы
# ---------------------------------------------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HERE/lib.sh" ]]; then
  PKG="$HERE" # пакет: всё рядом
  LIB="$HERE/lib.sh"
  ROUTES_TOOLS_DIR="$HERE/tools"
  ROUTES_MANIFEST="$HERE/routes.tsv"
  PKG_DEPLOY="$HERE/deploy"
  LOCK_SRC="$HERE/images.lock"
else
  PKG="$(cd "$HERE/../.." && pwd)" # дерево проекта (стенды и тесты)
  LIB="$HERE/../cutover/lib.sh"
  ROUTES_TOOLS_DIR="$PKG/tools"
  ROUTES_MANIFEST="$PKG/deploy/cutover/routes.tsv"
  PKG_DEPLOY="${PATCH_PKG_DEPLOY:-$PKG/deploy}"
  LOCK_SRC="${PATCH_LOCK:-$PKG/deploy/images.lock}"
fi
# shellcheck source=../cutover/lib.sh
source "$LIB"
SMOKE_SCRIPT="$HERE/smoke_contract.py"
COSIGN_PUB="${PATCH_COSIGN_PUB:-$PKG/cosign.pub}"
[[ -f "$COSIGN_PUB" ]] || COSIGN_PUB="$PKG/deploy/cosign.pub"

# Файлы дерева, которые патч вправе заменить (пути относительно deploy/); всё прочее из пакета
# игнорируется, а чужой файл в пакете - отказ.
PATCH_FILE_ALLOW=(compose.yml compose.project.yml compat.env platform/compose.base.yml
  platform/PLATFORM-VERSION)
# Ключи lock, которые патч вправе менять: образ documents проекта, его платформенная основа и
# версия lock. Любой другой (app, postgres, mask...) - отказ: патч не про них.
PATCH_LOCK_KEYS="BAI_VERSION BAI_IMAGE_DOCUMENTS BAI_IMAGE_DOCUMENTS_BASE"
# Сервисы, которые патч пересоздаёт (порядок: documents -> alloy -> app последним) и ключи их
# образов в lock. alloy и app берутся, только если контейнер уже есть в проекте.
PATCH_UP_SERVICES=(documents alloy app)
declare -A SERVICE_LOCK_KEY=([documents]=BAI_IMAGE_DOCUMENTS [alloy]=BAI_IMAGE_ALLOY
  [app]=BAI_IMAGE_APP)
# Контейнеры временного обхода /docx/* (hotfix-docx) и его файлы в дереве.
BYPASS_SERVICES=(documents-router documents-legacy)
HOTFIX_COMPOSE_REL="hotfix/compose.hotfix-docx.yml"
# Лимит памяти alloy после патча (решение владельца 17.11.2026), байт.
ALLOY_MEM_MIB=448
ALLOY_MEM_BYTES=$((ALLOY_MEM_MIB * MIB))
# Порт сервиса documents внутри стека.
DOCUMENTS_PORT=8310
DEFAULT_SOAK_S=120
SOAK_POLL_S=${PATCH_SOAK_POLL_S:-15}
STOP_TIMEOUT_S=60
DEPLOYED_MARK=".cutover-deployed"
BACKUP_PREFIX="pragmatika-patch"
# Запасы: свободный диск под образ documents (МиБ) и доступная память.
PATCH_MIN_DISK_MIB="${PATCH_MIN_DISK_MIB:-3072}"
PATCH_MIN_AVAILABLE_MIB="${PATCH_MIN_AVAILABLE_MIB:-1024}"
SMOKE_MEM=256m
# Состояние для отката (state.env запуска): PATCH_STARTED, BACKUP_DIR, BYPASS_BEFORE, FILES.
ROLLBACK_MODE=0
RUN_DIR_ARG=""

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
    --rollback) ROLLBACK_MODE=1 ;;
    --run-dir) RUN_DIR_ARG="${2:?--run-dir КАТАЛОГ}"; shift ;;
    --help | -h) usage; exit "$EXIT_OK" ;;
    *) echo "неизвестный аргумент: $1" >&2; usage >&2; exit "$EXIT_USAGE" ;;
  esac
  shift
done
[[ "$SOAK_S" =~ ^[0-9]+$ ]] || { echo "--soak-seconds: нужно число" >&2; exit "$EXIT_USAGE"; }
if ((PREFLIGHT_ONLY && ROLLBACK_MODE)); then
  echo "--preflight-only и --rollback несовместимы" >&2
  exit "$EXIT_USAGE"
fi
[[ -n "$SIGNATURES_FILE" || ! -f "$HERE/signatures.txt" ]] || SIGNATURES_FILE="$HERE/signatures.txt"

[[ -z "$CONFIG_FILE" ]] || cut_load_config "$CONFIG_FILE" || exit "$EXIT_USAGE"
if ((ROLLBACK_MODE)); then
  # Откат вручную: настройка берётся из каталога запуска патча (patch.conf), если он есть.
  CUTOVER_HOME="${CUTOVER_HOME:-$HOME/.pragmatika-cutover}"
  RUN_DIR_ARG="${RUN_DIR_ARG:-$CUTOVER_HOME/patch-latest}"
  [[ -d "$RUN_DIR_ARG" ]] || { echo "нет каталога запуска: $RUN_DIR_ARG" >&2; exit "$EXIT_USAGE"; }
  [[ ! -f "$RUN_DIR_ARG/patch.conf" ]] || cut_load_config "$RUN_DIR_ARG/patch.conf"
fi
[[ -z "$EXPECT_BOTS_ARG" ]] || CUTOVER_EXPECT_BOTS="$EXPECT_BOTS_ARG"
cut_defaults

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$CUTOVER_HOME"
if ((ROLLBACK_MODE)); then
  RUN_DIR_ORIG="$(cd "$RUN_DIR_ARG" && pwd)"
  cut_init_run "$CUTOVER_HOME/patch-rollback-$RUN_ID"
else
  cut_init_run "$CUTOVER_HOME/patch-$RUN_ID"
  ln -sfn "$RUN_DIR" "$CUTOVER_HOME/patch-latest"
fi
ARCHIVE_PATH=""
ROLLED_BACK=0
LIVE_NEW_DIR="$CUTOVER_NEW_DIR"
LIVE_DEPLOY="$LIVE_NEW_DIR/deploy"

die() { # die <код> <сообщение>
  log "ОШИБКА: $2"
  state_set RESULT "FAILED: $2"
  exit "$1"
}

# refuse <сообщение>: отказ по предусловиям, бой не тронут. После начала изменений - сбой
# хода (код 1): on_exit выполнит откат.
refuse() {
  check "предусловия" fail "$*"
  if [[ "$(state_get PATCH_STARTED)" == 1 ]]; then die "$EXIT_FAILED" "$*"; fi
  die "$EXIT_REFUSED" "отказ: $*"
}

# Настройка запуска для --rollback (без секретов: пути и числа).
save_config() {
  local name
  : >"$RUN_DIR/patch.conf"
  for name in $(compgen -v CUTOVER_); do
    [[ "$name" =~ ^CUTOVER_(ALERTS_URL|SECRETS_DIR)?$ ]] && continue
    printf '%s=%s\n' "$name" "${!name}" >>"$RUN_DIR/patch.conf"
  done
}

# ---------------------------------------------------------------------------------------------
# Итог и уборка (всегда, при любом выходе)
# ---------------------------------------------------------------------------------------------
collect_secret_values() {
  local secrets_dir file
  secrets_dir="${CUTOVER_SECRETS_DIR:-$(env_value "$CUTOVER_ENV_FILE" SECRETS_DIR)}"
  secrets_dir="${secrets_dir:-/etc/pragmatika/secrets}"
  for file in "$CUTOVER_ENV_FILE" "$LIVE_DEPLOY/.env" "$secrets_dir/secrets.env" \
    "$LIVE_DEPLOY/$MASK_TOKEN_FILE_NAME"; do
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

# Архив результатов ~/patch-<время>.tgz; значение секрета в нём - архив удаляется.
finish_results() {
  local files
  cp "$STATE_FILE" "$RES/state.env" 2>/dev/null || true
  ARCHIVE_PATH="$CUTOVER_OUT_DIR/patch-$RUN_ID.tgz"
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
  if ((rc != EXIT_OK && rc != EXIT_REFUSED && rc != EXIT_USAGE && ROLLBACK_MODE == 0)); then
    if [[ "$(state_get PATCH_STARTED)" == 1 && "$ROLLED_BACK" != 1 ]]; then
      log "СБОЙ: запускаю автоматический откат патча"
      ROLLED_BACK=1
      if rollback_patch "$RUN_DIR"; then
        rc="$EXIT_FAILED"
      else
        rc="$EXIT_STUCK"
        log "ОТКАТ НЕ УДАЛСЯ: нужно ручное вмешательство (OWNER-RUNBOOK.md, журнал)"
      fi
    fi
  fi
  finish_results
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
# Вспомогательное
# ---------------------------------------------------------------------------------------------
dir_free_mib() { df -Pm "$1" 2>/dev/null | awk 'NR == 2 { print $4 }'; }
mem_available_mib() { awk '/^MemAvailable:/ { print int($2 / '"$KIB_PER_MIB"') }' /proc/meminfo; }

# service_containers <сервис>: имена контейнеров сервиса compose-проекта (включая остановленные).
service_containers() {
  docker ps -a --filter "label=com.docker.compose.project=$CUTOVER_PROJECT" \
    --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | sort
}

# patch_services: сервисы, которые есть в проекте и входят в патч, в порядке PATCH_UP_SERVICES.
patch_services() {
  local svc
  for svc in "${PATCH_UP_SERVICES[@]}"; do
    [[ -n "$(service_containers "$svc")" ]] && printf '%s\n' "$svc"
  done
}

# bypass_present: 0, если хоть один контейнер обхода /docx/* есть в проекте.
bypass_present() {
  local svc
  for svc in "${BYPASS_SERVICES[@]}"; do
    [[ -z "$(service_containers "$svc")" ]] || return 0
  done
  return 1
}

# Образы lock, нужные патчу (ссылки по digest) для сервисов compose.
lock_ref() { lock_value "$LOCK_SRC" "$1" || true; }

# ---------------------------------------------------------------------------------------------
# 0. Предусловия (бой не меняется)
# ---------------------------------------------------------------------------------------------
check_sources() {
  phase "целостность пакета и источников"
  if [[ -f "$HERE/MANIFEST.sha256" ]]; then
    (cd "$HERE" && sha256sum -c --quiet MANIFEST.sha256) >>"$LOG_FILE" 2>&1 \
      || refuse "MANIFEST.sha256 не сходится: пакет повреждён или изменён"
    check "целостность пакета" ok "MANIFEST.sha256 сходится"
  else
    check "целостность пакета" warn "MANIFEST.sha256 нет (запуск из дерева проекта)"
  fi
  [[ -f "$LOCK_SRC" ]] || refuse "нет images.lock пакета ($LOCK_SRC)"
  cut_lock_format "$LOCK_SRC" || refuse "images.lock не в формате платформы (только digest)"
  cut_lock_has_mask "$LOCK_SRC" || refuse "в images.lock нет $LOCK_MASK_KEY"
  [[ ! -e "$PKG/db" && ! -e "$HERE/stack/db" ]] \
    || refuse "в патче есть каталог db: патч не должен менять БД и миграции"
  [[ -d "$PKG_DEPLOY" ]] || refuse "в пакете нет каталога deploy ($PKG_DEPLOY)"
  [[ -f "$ROUTES_MANIFEST" && -f "$ROUTES_TOOLS_DIR/check-routes.sh" \
    && -f "$ROUTES_TOOLS_DIR/check-image-routes.sh" && -f "$SMOKE_SCRIPT" ]] \
    || refuse "в пакете нет инструментов проверки (tools/, routes.tsv, smoke_contract.py)"
  check "состав пакета" ok "lock, инструменты проверки на месте, миграций нет"
}

# Подпись ВСЕХ образов lock. Молча пропускать нельзя.
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
    return 0
  fi
  [[ -n "$SIGNATURES_FILE" ]] \
    || refuse "нет cosign или cosign.pub и нет signatures.txt (--signatures-verified ФАЙЛ):" \
      "проверку подписей пропускать нельзя"
  [[ -f "$SIGNATURES_FILE" ]] || refuse "нет файла $SIGNATURES_FILE"
  if msg="$(cut_check_signatures_file "$SIGNATURES_FILE" "$LOCK_SRC" "$COSIGN_PUB")"; then
    check "подписи образов" ok "по подтверждению verify-signatures.sh: $msg"
  else
    refuse "подтверждение подписей не принято: $msg"
  fi
}

# Дерево боя на месте, создано выкаткой пакета; lock боя отличается от нового только образом
# documents. Образ app тот же: значит, миграций у патча нет.
check_deployed_tree() {
  phase "боевое дерево и состав изменений"
  local live_lock="$LIVE_DEPLOY/images.lock" key old new changed=""
  [[ -f "$LIVE_DEPLOY/compose.yml" && -f "$live_lock" && -f "$LIVE_DEPLOY/.env" ]] \
    || refuse "в $LIVE_DEPLOY нет compose.yml, images.lock или .env: это не дерево v2"
  [[ -f "$LIVE_DEPLOY/$DEPLOYED_MARK" ]] \
    || refuse "в $LIVE_DEPLOY нет $DEPLOYED_MARK: дерево создано не cutover.sh"
  while IFS='=' read -r key new; do
    [[ "$key" =~ ^BAI_ ]] || continue
    old="$(lock_value "$live_lock" "$key" || true)"
    [[ "$old" == "$new" ]] || changed+=" $key"
  done <"$LOCK_SRC"
  while IFS='=' read -r key old; do
    [[ "$key" =~ ^BAI_ ]] || continue
    [[ -n "$(lock_value "$LOCK_SRC" "$key")" ]] || changed+=" $key(удалён)"
  done <"$live_lock"
  for key in $changed; do
    [[ " $PATCH_LOCK_KEYS " == *" ${key%%(*} "* ]] \
      || refuse "lock пакета меняет $key: патч вправе менять только: $PATCH_LOCK_KEYS"
  done
  printf '%s\n' ${changed:-} >"$RES/lock-changes.txt"
  # Файлы пакета: только из списка; различающиеся - в список замены.
  PATCH_FILES=()
  local rel
  while IFS= read -r rel; do
    [[ " ${PATCH_FILE_ALLOW[*]} " == *" $rel "* ]] \
      || refuse "в пакете файл $rel вне списка замены (${PATCH_FILE_ALLOW[*]})"
    [[ -f "$LIVE_DEPLOY/$rel" ]] && cmp -s "$PKG_DEPLOY/$rel" "$LIVE_DEPLOY/$rel" && continue
    PATCH_FILES+=("$rel")
  done < <(cd "$PKG_DEPLOY" && find . -type f ! -name 'images.lock' | sed 's|^\./||' | sort)
  printf '%s\n' ${PATCH_FILES[@]+"${PATCH_FILES[@]}"} >"$RES/file-changes.txt"
  if [[ -z "$changed" && ${#PATCH_FILES[@]} -eq 0 ]]; then
    refuse "нечего применять: lock и файлы дерева уже совпадают с пакетом (патч применён?)"
  fi
  check "состав изменений" ok "lock:${changed:- нет}; файлов: ${#PATCH_FILES[@]}" \
    "(${PATCH_FILES[*]:-})"
}

check_battle_health() {
  phase "бой здоров до начала"
  local body bots
  [[ -n "$(docker ps -q --filter "name=^${CUTOVER_APP_CONTAINER}\$")" ]] \
    || refuse "контейнер $CUTOVER_APP_CONTAINER не запущен"
  body="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
  [[ "$body" == 200* ]] || refuse "/ready боя не 200: ${body:0:120}"
  bots="$(ready_bots "$body")"
  ((bots >= CUTOVER_EXPECT_BOTS)) \
    || refuse "ботов $bots, ожидается не меньше $CUTOVER_EXPECT_BOTS (--expected-bots)"
  check "бой здоров" ok "/ready 200, ботов $bots"
}

check_resources() {
  phase "ресурсы"
  local docker_root free avail
  command -v docker >/dev/null || refuse "нет docker"
  docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  free="$(dir_free_mib "$docker_root")"
  avail="$(mem_available_mib)"
  ((free >= PATCH_MIN_DISK_MIB)) \
    || refuse "мало места в $docker_root: свободно ${free} МиБ, нужно ${PATCH_MIN_DISK_MIB}"
  ((avail >= PATCH_MIN_AVAILABLE_MIB)) \
    || refuse "мало памяти: доступно ${avail} МиБ, нужно ${PATCH_MIN_AVAILABLE_MIB}"
  check "ресурсы" ok "диск ${free} МиБ, память ${avail} МиБ"
}

# Образ documents (и прочие образы lock, нужные патчу) - локально по digest.
ensure_images() {
  phase "образы патча"
  local key ref
  if [[ -n "$IMAGES_TAR" ]]; then
    [[ -f "$IMAGES_TAR" ]] || refuse "нет архива образов $IMAGES_TAR"
    log "загружаю образы из $IMAGES_TAR"
    docker load -i "$IMAGES_TAR" >>"$LOG_FILE" 2>&1 || refuse "docker load не удался"
  fi
  for key in BAI_IMAGE_DOCUMENTS BAI_IMAGE_ALLOY; do
    ref="$(lock_ref "$key")"
    [[ -n "$ref" ]] || refuse "в lock пакета нет $key"
    [[ "$ref" == *@sha256:* ]] || refuse "образ $ref без digest"
    if ! docker image inspect "$ref" >/dev/null 2>&1; then
      log "образ ${ref##*/} не найден локально, docker pull"
      docker pull "$ref" >>"$LOG_FILE" 2>&1 \
        || refuse "образ ${ref##*/} не найден: docker login или --images-tar"
    fi
  done
  check "образы патча" ok "documents и alloy по digest на месте"
}

# Дерево примерки: копия боевого deploy + файлы пакета, секреты ссылками на боевые файлы.
# Проверяется, что compose собирает конфигурацию, и по ней - маршруты образа documents.
stage_tree() {
  phase "примерка новых файлов (бой не меняется)"
  STAGE_DIR="$WORK/stage"
  local deploy="$STAGE_DIR/deploy" rel secret
  mkdir -p "$deploy"
  (cd "$LIVE_DEPLOY" && tar -c --exclude='./.env' --exclude='./secrets.env' \
    --exclude="./$MASK_TOKEN_FILE_NAME" .) | tar -x -C "$deploy"
  for secret in .env secrets.env "$MASK_TOKEN_FILE_NAME"; do
    [[ ! -e "$LIVE_DEPLOY/$secret" ]] || ln -sfn "$LIVE_DEPLOY/$secret" "$deploy/$secret"
  done
  for rel in ${PATCH_FILES[@]+"${PATCH_FILES[@]}"}; do
    mkdir -p "$(dirname "$deploy/$rel")"
    cp -p "$PKG_DEPLOY/$rel" "$deploy/$rel"
  done
  cp "$LOCK_SRC" "$deploy/images.lock"
  CUTOVER_NEW_DIR="$STAGE_DIR"
  dc_new --profile tools config --quiet >>"$LOG_FILE" 2>&1 \
    || { CUTOVER_NEW_DIR="$LIVE_NEW_DIR"; refuse "docker compose config не принял новые файлы"; }
  check "конфигурация compose" ok "новые файлы и lock собираются"
  check_documents_routes
  CUTOVER_NEW_DIR="$LIVE_NEW_DIR"
}

# Маршруты, которые вызывает app, есть в образе documents из нового lock.
check_documents_routes() {
  local ref out="$RES/routes-image.txt" rc=0
  ref="$(lock_ref BAI_IMAGE_DOCUMENTS)"
  cut_check_routes_image "$ref" "$out" || rc=$?
  cat "$out" >>"$LOG_FILE"
  case "$rc" in
    0) check "маршруты documents в образе" ok "$(tail -1 "$out" | sed 's/^\[[^]]*\] //')" ;;
    "$ROUTES_EXIT_MISSING")
      CUTOVER_NEW_DIR="$LIVE_NEW_DIR"
      refuse "в образе documents нет маршрутов, которые вызывает app (routes-image.txt)" ;;
    *) CUTOVER_NEW_DIR="$LIVE_NEW_DIR"
      refuse "маршруты образа documents проверить не удалось, код $rc (routes-image.txt)" ;;
  esac
}

# ---------------------------------------------------------------------------------------------
# 1-2. Бэкап и замена
# ---------------------------------------------------------------------------------------------
make_backup() {
  phase "бэкап файлов дерева"
  BACKUP_DIR="${CUTOVER_BACKUP_ROOT}/${BACKUP_PREFIX}-${RUN_ID}"
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  cp -a "$LIVE_DEPLOY" "$BACKUP_DIR/deploy" || refuse "не удалось скопировать $LIVE_DEPLOY"
  {
    echo "# контейнеры проекта до патча: имя<TAB>образ (Config.Image)<TAB>id образа"
    local name
    while IFS= read -r name; do
      printf '%s\t%s\t%s\n' "$name" "$(docker inspect -f '{{.Config.Image}}' "$name")" \
        "$(docker inspect -f '{{.Image}}' "$name")"
    done < <(project_containers)
  } >"$BACKUP_DIR/containers-before.tsv"
  state_set BACKUP_DIR "$BACKUP_DIR"
  state_set LIVE_DEPLOY "$LIVE_DEPLOY"
  state_set BYPASS_BEFORE "$(bypass_present && echo 1 || echo 0)"
  state_set SERVICES_BEFORE "$(patch_services | tr '\n' ' ')"
  check "бэкап" ok "$BACKUP_DIR (deploy, список контейнеров и образов)"
}

# Замена файлов: временный файл рядом и mv, чтобы compose не увидел наполовину записанный.
apply_files() {
  phase "замена файлов дерева"
  local rel tmp
  state_set PATCH_STARTED 1
  for rel in ${PATCH_FILES[@]+"${PATCH_FILES[@]}"}; do
    tmp="$LIVE_DEPLOY/$rel.patch-new"
    mkdir -p "$(dirname "$LIVE_DEPLOY/$rel")"
    cp -p "$PKG_DEPLOY/$rel" "$tmp"
    mv -f "$tmp" "$LIVE_DEPLOY/$rel"
    state_set FILE_REPLACED "$rel"
  done
  cp "$LOCK_SRC" "$LIVE_DEPLOY/images.lock.patch-new"
  chmod 644 "$LIVE_DEPLOY/images.lock.patch-new"
  mv -f "$LIVE_DEPLOY/images.lock.patch-new" "$LIVE_DEPLOY/images.lock"
  state_set FILE_REPLACED images.lock
  check "замена файлов" ok "заменено файлов: $((${#PATCH_FILES[@]} + 1)) (включая images.lock)"
}

# Пересоздание только затронутых сервисов, без зависимостей и без удаления сирот.
recreate_services() {
  phase "пересоздание сервисов без обхода"
  local svc container
  PATCHED_SERVICES=()
  while IFS= read -r svc; do
    [[ -n "$svc" ]] || continue
    log "up -d --no-deps $svc"
    dc_new up -d --no-deps "$svc" >>"$LOG_FILE" 2>&1 \
      || die "$EXIT_FAILED" "compose up $svc не удался"
    PATCHED_SERVICES+=("$svc")
    container="$(service_containers "$svc" | head -1)"
    wait_healthy "$container" "$HEALTH_WAIT_S" \
      || die "$EXIT_FAILED" "$container не стал healthy за ${HEALTH_WAIT_S} с"
    check "сервис $svc" ok "пересоздан, $container работает"
  done < <(patch_services)
  ((${#PATCHED_SERVICES[@]} > 0)) || die "$EXIT_FAILED" "нет сервисов для пересоздания"
}

# ---------------------------------------------------------------------------------------------
# 3. Проверки после замены
# ---------------------------------------------------------------------------------------------
# Образы запущенных сервисов патча равны lock.
verify_images() {
  local svc name ref want got bad=0
  : >"$RES/images-running.tsv"
  for svc in "${PATCHED_SERVICES[@]}"; do
    ref="$(lock_ref "${SERVICE_LOCK_KEY[$svc]}")"
    name="$(service_containers "$svc" | head -1)"
    got="$(docker inspect -f '{{.Image}}' "$name")"
    want="$(docker image inspect -f '{{.Id}}' "$ref" 2>/dev/null || echo ?)"
    if [[ "$got" == "$want" ]]; then
      printf '%s\t%s\tсовпал\n' "$name" "$ref" >>"$RES/images-running.tsv"
    else
      printf '%s\t%s\tОТЛИЧАЕТСЯ\n' "$name" "$ref" >>"$RES/images-running.tsv"
      bad=$((bad + 1))
    fi
  done
  ((bad == 0)) || die "$EXIT_FAILED" "образы запущенных сервисов не равны lock: $bad"
  check "образы = images.lock" ok "digest сервисов патча совпал с lock"
}

verify_alloy_limit() {
  local name limit
  [[ " ${PATCHED_SERVICES[*]} " == *" alloy "* ]] || return 0
  name="$(service_containers alloy | head -1)"
  limit="$(docker inspect -f '{{.HostConfig.Memory}}' "$name")"
  [[ "$limit" == "$ALLOY_MEM_BYTES" ]] \
    || die "$EXIT_FAILED" "лимит памяти alloy $limit байт, ожидается $ALLOY_MEM_BYTES"
  check "лимит alloy" ok "${ALLOY_MEM_MIB} МиБ"
}

verify_ready() {
  local body bots="0" started=$SECONDS
  ready_wait "$CUTOVER_APP_CONTAINER" "$READY_WAIT_S" \
    || die "$EXIT_FAILED" "/ready не 200 за ${READY_WAIT_S} с: ${READY_BODY:0:160}"
  while ((SECONDS - started < READY_WAIT_S)); do
    body="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
    bots="$(ready_bots "$body")"
    ((bots >= CUTOVER_EXPECT_BOTS)) && break
    sleep "$POLL_S"
  done
  ((bots >= CUTOVER_EXPECT_BOTS)) \
    || die "$EXIT_FAILED" "ботов $bots, ожидается не меньше $CUTOVER_EXPECT_BOTS"
  check "/ready и боты ($1)" ok "200, ботов $bots"
}

verify_routes() {
  local out="$RES/routes-stack-$1.txt" rc=0 summary
  cut_check_routes_stack "$out" || rc=$?
  cat "$out" >>"$LOG_FILE"
  summary="$(tail -1 "$out" | cut -c1-200)"
  ((rc == 0)) || die "$EXIT_FAILED" "проверка маршрутов стека не прошла (routes-stack-$1.txt)"
  check "маршруты стека ($1)" ok "$summary"
}

# Смоук сборки договора: одноразовый контейнер образа documents в сети контейнера documents.
verify_smoke() {
  local out="$RES/smoke-$1.txt" rc=0 container ref
  container="$(service_containers documents | head -1)"
  ref="$(lock_ref BAI_IMAGE_DOCUMENTS)"
  docker run --rm --network "container:$container" --memory "$SMOKE_MEM" --cap-drop ALL \
    --security-opt no-new-privileges:true -e PYTHONDONTWRITEBYTECODE=1 \
    -v "$SMOKE_SCRIPT:/smoke/smoke_contract.py:ro" --entrypoint python "$ref" \
    -I /smoke/smoke_contract.py "http://127.0.0.1:$DOCUMENTS_PORT" >"$out" 2>&1 || rc=$?
  cat "$out" >>"$LOG_FILE"
  ((rc == 0)) \
    || die "$EXIT_FAILED" "смоук сборки договора не прошёл (smoke-$1.txt):" \
      "$(tail -2 "$out" | tr '\n' ' ')"
  check "смоук договора ($1)" ok "amend, party-block, replace-signatory, classify:" \
    "$(grep -c '^OK' "$out") шагов"
}

# Контейнеры обхода убираются, тег образа pragmatika-documents:legacy-docx остаётся.
remove_bypass() {
  phase "снятие обхода /docx/*"
  local svc names=() name
  for svc in "${BYPASS_SERVICES[@]}"; do
    mapfile -t -O "${#names[@]}" names < <(service_containers "$svc")
  done
  if ((${#names[@]} == 0)); then
    check "обход /docx/*" ok "контейнеров обхода нет"
    return 0
  fi
  for name in "${names[@]}"; do
    docker stop -t "$STOP_TIMEOUT_S" "$name" >>"$LOG_FILE" 2>&1 || true
    docker rm "$name" >>"$LOG_FILE" 2>&1 || true
  done
  state_set BYPASS_REMOVED 1
  check "обход /docx/*" ok "убрано контейнеров: ${#names[@]} (${names[*]}); тег legacy-docx цел"
}

soak() {
  local before now started=$SECONDS left body
  before="$(restart_total)"
  log "выдержка ${SOAK_S} с (проверка каждые ${SOAK_POLL_S} с)"
  while ((SECONDS - started < SOAK_S)); do
    left=$((SOAK_S - (SECONDS - started)))
    sleep "$((SOAK_POLL_S < left ? SOAK_POLL_S : left))"
    now="$(restart_total)"
    ((now == before)) \
      || die "$EXIT_FAILED" "во время выдержки перезапуски контейнеров: $before -> $now"
    body="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
    [[ "$body" == 200* ]] || die "$EXIT_FAILED" "во время выдержки /ready не 200: ${body:0:120}"
  done
  check "выдержка ${SOAK_S} с" ok "перезапусков нет, /ready 200"
}

restart_total() {
  local name sum=0 n
  while read -r name; do
    n="$(docker inspect -f '{{.RestartCount}}' "$name" 2>/dev/null || echo 0)"
    sum=$((sum + n))
  done < <(project_containers)
  echo "$sum"
}

verify_patch() {
  phase "проверки после замены"
  verify_images
  verify_alloy_limit
  verify_ready "до снятия обхода"
  verify_routes before
  verify_smoke before
  remove_bypass
  verify_ready "после снятия обхода"
  verify_routes after
  verify_smoke after
  soak
}

# ---------------------------------------------------------------------------------------------
# Откат
# ---------------------------------------------------------------------------------------------
# rollback_patch <каталог запуска патча>: файлы дерева из бэкапа, стек с обходом (если он был),
# проверки. 0 - бой как до патча и проверен; иначе 1.
ROLLBACK_FAILED=0
rb_check() { # rb_check <имя> <ok|fail> <описание>
  check "откат: $1" "$2" "$3"
  [[ "$2" != fail ]] || ROLLBACK_FAILED=$((ROLLBACK_FAILED + 1))
}
rollback_patch() {
  local run="$1" backup live bypass services rel body bots name want got extra="" svc state
  local saved_state="$STATE_FILE"
  STATE_FILE="$run/state.env"
  backup="$(state_get BACKUP_DIR)"
  live="$(state_get LIVE_DEPLOY)"
  bypass="$(state_get BYPASS_BEFORE)"
  services="$(state_get SERVICES_BEFORE)"
  STATE_FILE="$saved_state"
  phase "откат патча"
  if [[ -z "$backup" || ! -d "$backup/deploy" || -z "$live" ]]; then
    log "нет бэкапа в $run/state.env: откат невозможен"
    return 1
  fi
  # 1. Файлы дерева из бэкапа: все, что патч заменил (список в state), и lock.
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    if [[ -e "$backup/deploy/$rel" ]]; then
      cp -a "$backup/deploy/$rel" "$live/$rel.rb-new" && mv -f "$live/$rel.rb-new" "$live/$rel"
    fi
  done < <(grep -E '^FILE_REPLACED=' "$run/state.env" | cut -d= -f2- | sort -u)
  cmp -s "$backup/deploy/images.lock" "$live/images.lock" \
    && rb_check "файлы дерева" ok "images.lock и заменённые файлы возвращены из бэкапа" \
    || rb_check "файлы дерева" fail "images.lock не совпал с бэкапом"
  # 2. Стек с обходом (как hotfix/dc-v2.sh up -d), если обход был до патча.
  CUTOVER_NEW_DIR="$(dirname "$live")"
  if [[ "$bypass" == 1 && -f "$live/$HOTFIX_COMPOSE_REL" ]]; then
    extra="$live/$HOTFIX_COMPOSE_REL"
  fi
  # Файл обхода идёт ПЕРЕД прочими надстройками стенда (на бою их нет): их переопределения сильнее.
  CUTOVER_EXTRA_COMPOSE="$(echo "$extra ${CUTOVER_EXTRA_COMPOSE:-}" | xargs)"
  # Порядок: legacy -> documents -> роутер -> остальное (app последним).
  local up=()
  [[ -z "$extra" ]] || up+=(documents-legacy)
  [[ " $services " != *" documents "* ]] || up+=(documents)
  [[ -z "$extra" ]] || up+=(documents-router)
  for svc in $services; do [[ "$svc" == documents ]] || up+=("$svc"); done
  for svc in ${up[@]+"${up[@]}"}; do
    dc_new up -d --no-deps "$svc" >>"$LOG_FILE" 2>&1 \
      && rb_check "поднят $svc" ok "up -d --no-deps" \
      || rb_check "поднят $svc" fail "compose up не удался"
  done
  # 3. Проверки: /ready, образы сервисов как до патча, обход на месте.
  if ready_wait "$CUTOVER_APP_CONTAINER" "$READY_WAIT_S"; then
    body="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
    bots="$(ready_bots "$body")"
    ((bots >= CUTOVER_EXPECT_BOTS)) \
      && rb_check "/ready" ok "200, ботов $bots" \
      || rb_check "/ready" fail "ботов $bots, ожидается не меньше $CUTOVER_EXPECT_BOTS"
  else
    rb_check "/ready" fail "не 200 за ${READY_WAIT_S} с: ${READY_BODY:0:120}"
  fi
  while IFS=$'\t' read -r name want _; do
    [[ "$name" == \#* || -z "$name" ]] && continue
    got="$(docker inspect -f '{{.Config.Image}}' "$name" 2>/dev/null || echo отсутствует)"
    [[ "$got" == "$want" ]] \
      && rb_check "образ $name" ok "как до патча" \
      || rb_check "образ $name" fail "сейчас $got, до патча $want"
  done <"$backup/containers-before.tsv"
  if [[ "$bypass" == 1 ]]; then
    for svc in "${BYPASS_SERVICES[@]}"; do
      name="$(service_containers "$svc" | head -1)"
      state="$(docker inspect -f '{{.State.Status}}' "${name:-_}" 2>/dev/null || true)"
      [[ -n "$name" && "$state" == running ]] \
        && rb_check "обход $svc" ok "контейнер $name работает" \
        || rb_check "обход $svc" fail "контейнера обхода нет или он не работает"
    done
  fi
  ((ROLLBACK_FAILED == 0)) || return 1
  log "ОТКАТ ПАТЧА ВЫПОЛНЕН: файлы дерева из бэкапа, бой как до патча, проверки прошли"
  state_set ROLLBACK_RESULT OK
}

# ---------------------------------------------------------------------------------------------
main() {
  if ((ROLLBACK_MODE)); then
    log "patch.sh --rollback: откат по каталогу запуска $RUN_DIR_ORIG"
    rollback_patch "$RUN_DIR_ORIG" || exit "$EXIT_STUCK"
    return 0
  fi
  save_config
  log "patch.sh $RUN_ID: проект $CUTOVER_PROJECT, дерево $LIVE_NEW_DIR, каталог запуска $RUN_DIR"
  collect_secret_values
  check_sources
  check_signatures
  check_deployed_tree
  check_battle_health
  check_resources
  ensure_images
  stage_tree
  if ((PREFLIGHT_ONLY)); then
    check "режим" ok "--preflight-only: бой не менялся"
    state_set RESULT "PREFLIGHT_OK"
    return 0
  fi
  make_backup
  apply_files
  recreate_services
  verify_patch
  state_set RESULT OK
}
main
