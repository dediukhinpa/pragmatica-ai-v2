#!/usr/bin/env bash
# Проверка патч-пакета G8 на синтетическом «бое» (Fornex): настоящие образы documents, alloy, app
# и nginx из lock, настоящие compose-файлы развёрнутого дерева v2 и настоящий обход /docx/*
# (hotfix-docx); у app вместо ядра заглушка /ready (deploy/patch/standin). Бой (pragmatika-ru) не
# затрагивается: compose-проект pragmatika-p8v, пути стенда под $SYNTH.
#
# Использование:
#   bash tools/patch-synth.sh [--steps список] [--help]
# Шаги (по умолчанию все по порядку):
#   prepare   пересоздать стенд «до патча»: documents (платформенный, без /docx/*), обход
#             documents-legacy + documents-router, alloy 320m, app на адрес роутера обхода
#   preflight patch.sh --preflight-only: код 0, ничего не изменилось
#   refuse    пакет с образом documents без проектных маршрутов (платформенный): код 3, ничего не
#             изменилось (проверка маршрутов образа ловит это ДО замены)
#   apply     patch.sh: код 0, documents с /docx/*, app на documents, обход снят, alloy 448m,
#             тег legacy-docx цел, замер простоя app
#   rollback  patch.sh --rollback по успешному запуску: бой как до патча (код 0)
#   broken    patch.sh с documents, недоступным для соседей: сбой проверок, автооткат (код 1),
#             файлы дерева побайтно как до патча, обход на месте
#   cleanup   убрать стенд (контейнеры, тома, сети проекта), временный тег legacy-docx
# Результаты: $OUT/steps.tsv, $OUT/summary.txt, журналы патча $OUT/<шаг>.log.
# Окружение: SYNTH (каталог стенда), OUT (каталог результатов), LOCK и SIGNATURES (lock и вывод
# verify-signatures.sh этапа), DOCKER_CONFIG (не нужен: образы уже на хосте).
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPORTS="${REPORTS:-$HOME/reports/business-ai-modular}"
STAGE="$REPORTS/stage-8v"
SYNTH="${SYNTH:-$STAGE/tmp/synth}"
OUT="${OUT:-$STAGE/synth}"
LOCK="${LOCK:-$STAGE/images.lock}"
SIGNATURES="${SIGNATURES:-$STAGE/signatures.txt}"
PROJECT="pragmatika-p8v"
LIVE="$SYNTH/opt/pragmatika-v2"
DEPLOY="$LIVE/deploy"
APP="$PROJECT-app-1"
DOCS="$PROJECT-documents-1"
STANDIN="$ROOT/deploy/patch/standin/patch-stand.compose.yml"
BAD_ROUTES_LOCK="$OUT/images-no-routes.lock"
STEPS_DEFAULT="prepare preflight refuse apply rollback broken cleanup"
STEPS="$STEPS_DEFAULT"
ALLOY_MEM_OLD=335544320
ALLOY_MEM_NEW=469762048
SOAK_S=20
FAILS=0
LABEL="bai.stage=8v"

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
while (($#)); do
  case "$1" in
    --steps) STEPS="${2:?--steps список}"; shift ;;
    --help | -h) usage; exit 0 ;;
    *) echo "неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
  shift
done
mkdir -p "$OUT"
STEPS_FILE="$OUT/steps.tsv"
log() { echo "[patch-synth] $(date -u +%T) $*"; }
result() { # result <проверка> <ok|FAIL> <пояснение>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$STEPS_FILE"
  log "$1: $2 - $3"
  [[ "$2" == ok ]] || FAILS=$((FAILS + 1))
}

# compose стенда «как на бою до патча»: файлы дерева + обход + надстройка стенда.
dcs() {
  docker compose -p "$PROJECT" --env-file "$DEPLOY/images.lock" --env-file "$DEPLOY/.env" \
    -f "$DEPLOY/compose.yml" -f "$DEPLOY/hotfix/compose.hotfix-docx.yml" -f "$STANDIN" \
    --profile telemetry "$@"
}

# Хэши файлов дерева (без временных): для сравнения «до» и «после» побайтно.
tree_hash() { (cd "$DEPLOY" && find . -type f ! -name '*.patch-new' ! -name '*.rb-new' \
  | sort | xargs -d '\n' sha256sum); }
container_image() { docker inspect -f '{{.Config.Image}}' "$1" 2>/dev/null || echo отсутствует; }
service_present() { docker ps -a --format '{{.Names}}' | grep -qx "$PROJECT-$1-1"; }
# Статус POST {} на маршрут сервиса изнутри сети стенда (одноразовый контейнер образа documents).
route_status() { # route_status <контейнер-источник сети> <URL>
  docker run --rm --network "container:$1" --memory 128m --cap-drop ALL \
    --entrypoint python pragmatika-documents:1.1.3-pragmatika.2 -I -c '
import sys, urllib.request, urllib.error
req = urllib.request.Request(sys.argv[1], data=b"{}", method="POST",
                             headers={"Content-Type": "application/json"})
try:
    print(urllib.request.urlopen(req, timeout=20).status)
except urllib.error.HTTPError as exc:
    print(exc.code)
except Exception:
    print("нет ответа")' "$2"
}
patch_env() { # окружение запуска patch.sh на стенде
  echo "CUTOVER_PROJECT=$PROJECT CUTOVER_NEW_DIR=$LIVE CUTOVER_ENV_FILE=$DEPLOY/.env" \
    "CUTOVER_EXTRA_COMPOSE=$STANDIN CUTOVER_SERVICES=documents|alloy|app" \
    "CUTOVER_HOME=$OUT/home CUTOVER_BACKUP_ROOT=$OUT/backups CUTOVER_OUT_DIR=$OUT" \
    "CUTOVER_COSIGN=/nonexistent-cosign PATCH_SOAK_POLL_S=5 CUTOVER_EXPECT_BOTS=4" \
    "PATCH_MIN_DISK_MIB=2048 CUTOVER_READY_WAIT_S=120 CUTOVER_HEALTH_WAIT_S=180"
}
run_patch() { # run_patch <шаг> [аргументы patch.sh]: код в RC, журнал $OUT/<шаг>.log
  local step="$1" env_args=() item
  shift
  # CUTOVER_SERVICES: имена через пробел (в patch_env они склеены | ради одной строки)
  for item in $(patch_env); do env_args+=("${item//|/ }"); done
  RC=0
  env "${env_args[@]}" bash "$PKG/patch.sh" --soak-seconds "$SOAK_S" "$@" \
    >"$OUT/$step.log" 2>&1 || RC=$?
}

step_prepare() {
  log "стенд: пересоздание «до патча»"
  dcs down -v --remove-orphans >/dev/null 2>&1 || true
  # Исходное дерево боя: пакет этапа 8 (stack/deploy) + обход + .env стенда (готовит человек/скрипт
  # подготовки в $SYNTH/opt/pragmatika-v2/deploy; здесь только проверка, что он есть).
  [[ -f "$DEPLOY/compose.yml" && -f "$DEPLOY/.env" && -f "$DEPLOY/hotfix/compose.hotfix-docx.yml" ]] \
    || { result "prepare: дерево стенда" FAIL "нет $DEPLOY (compose.yml, .env, hotfix)"; return 1; }
  date -u +%FT%TZ >"$DEPLOY/.cutover-deployed"
  # Образ legacy-docx: на стенде это образ проекта (в нём те же маршруты /docx/*).
  docker image inspect pragmatika-documents:legacy-docx >/dev/null 2>&1 \
    || docker tag pragmatika-documents:1.1.3-pragmatika.2 pragmatika-documents:legacy-docx
  local svc
  for svc in documents documents-legacy documents-router alloy app; do
    dcs up -d --no-deps "$svc" >>"$OUT/prepare.log" 2>&1 \
      || { result "prepare: up $svc" FAIL "compose up не удался (prepare.log)"; return 1; }
  done
  sleep 15
  tree_hash >"$OUT/tree-before.sha"
  docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}\t{{.Image}}' \
    | sort >"$OUT/containers-before.txt"
  local url
  url="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$APP" \
    | sed -n 's/^DOCUMENTS_URL=//p')"
  [[ "$url" == "http://documents-router:8310" ]] \
    && result "prepare: app на роутере обхода" ok "DOCUMENTS_URL=$url" \
    || result "prepare: app на роутере обхода" FAIL "DOCUMENTS_URL=$url"
  [[ "$(route_status "$APP" http://documents-router:8310/docx/party-block)" != 404 ]] \
    && result "prepare: /docx/party-block через обход" ok "не 404 (legacy отвечает)" \
    || result "prepare: /docx/party-block через обход" FAIL "404"
  [[ "$(route_status "$APP" http://documents:8310/docx/party-block)" == 404 ]] \
    && result "prepare: платформенный documents без /docx/*" ok "404 напрямую (как на бою)" \
    || result "prepare: платформенный documents без /docx/*" FAIL "не 404"
  [[ "$(docker inspect -f '{{.HostConfig.Memory}}' "$PROJECT-alloy-1")" == "$ALLOY_MEM_OLD" ]] \
    && result "prepare: alloy 320 МиБ" ok "$ALLOY_MEM_OLD" \
    || result "prepare: alloy 320 МиБ" FAIL "лимит иной"
}

build_package() {
  local pkg_out="$OUT/package"
  rm -rf "${pkg_out:?}"
  bash "$HERE/build-patch-package.sh" --out "$pkg_out" --lock "$LOCK" --signatures "$SIGNATURES" \
    ${RUNBOOK_FILE:+--runbook "$RUNBOOK_FILE"} >"$OUT/build-package.log" 2>&1 \
    || { result "package: сборка" FAIL "см. build-package.log"; return 1; }
  PKG="$pkg_out"
  result "package: сборка" ok "$(find "$pkg_out" -type f | wc -l) файлов"
}

unchanged_since_prepare() { # unchanged_since_prepare <метка>
  local label="$1"
  if diff <(tree_hash) "$OUT/tree-before.sha" >/dev/null; then
    result "$label: файлы дерева прежние" ok "побайтно как до патча"
  else
    result "$label: файлы дерева прежние" FAIL "дерево изменилось"
  fi
  if diff <(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.Names}}\t{{.Image}}' | sort) "$OUT/containers-before.txt" >/dev/null; then
    result "$label: контейнеры и образы прежние" ok "набор и образы как до патча"
  else
    result "$label: контейнеры и образы прежние" FAIL "набор или образы изменились"
  fi
}

step_preflight() {
  build_package
  run_patch preflight --preflight-only
  [[ "$RC" == 0 ]] && result "preflight: код" ok "0 (PREFLIGHT_OK)" \
    || result "preflight: код" FAIL "$RC (preflight.log)"
  grep -q 'маршруты documents в образе: ok' "$OUT/preflight.log" \
    && result "preflight: маршруты образа" ok "проверены в образе documents" \
    || result "preflight: маршруты образа" FAIL "нет записи в журнале"
  unchanged_since_prepare preflight
}

step_refuse() {
  # Пакет, в котором образ documents - платформенный (без проектных маршрутов): отказ ДО замены.
  local base_ref sig_bad="$OUT/signatures-no-routes.txt" pkg_keep="$PKG"
  base_ref="$(grep '^BAI_IMAGE_DOCUMENTS_BASE=' "$LOCK" | cut -d= -f2-)"
  sed "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=$base_ref|" "$LOCK" >"$BAD_ROUTES_LOCK"
  # Подтверждение подписей: тот же файл, но по новому lock (образ base уже проверен cosign).
  python3 -I - "$SIGNATURES" "$BAD_ROUTES_LOCK" "$base_ref" >"$sig_bad" <<'PY'
import hashlib, sys
sig, lock, base = sys.argv[1:4]
digest = hashlib.sha256(open(lock, "rb").read()).hexdigest()
for line in open(sig, encoding="utf-8").read().splitlines():
    if line.startswith("lock_sha256="):
        line = f"lock_sha256={digest}"
    elif line.startswith("image\tBAI_IMAGE_DOCUMENTS\t"):
        line = f"image\tBAI_IMAGE_DOCUMENTS\t{base}\tOK"
    print(line)
PY
  bash "$HERE/build-patch-package.sh" --out "$OUT/package-no-routes" --lock "$BAD_ROUTES_LOCK" \
    --signatures "$sig_bad" >"$OUT/build-package-no-routes.log" 2>&1 \
    || { result "refuse: сборка пакета без маршрутов" FAIL "см. build-package-no-routes.log"; return 1; }
  PKG="$OUT/package-no-routes"
  run_patch refuse --preflight-only
  [[ "$RC" == 3 ]] && result "refuse: код" ok "3 (отказ по предусловиям)" \
    || result "refuse: код" FAIL "$RC (refuse.log)"
  grep -q 'нет маршрутов' "$OUT/refuse.log" \
    && result "refuse: причина" ok "в образе documents нет маршрутов, которые вызывает app" \
    || result "refuse: причина" FAIL "причина не названа"
  unchanged_since_prepare refuse
  PKG="$pkg_keep"
  rm -rf "${OUT:?}/package-no-routes"
}

step_apply() {
  local t0 t1
  t0="$(date -u +%s)"
  run_patch apply
  t1="$(date -u +%s)"
  [[ "$RC" == 0 ]] && result "apply: код" ok "0 за $((t1 - t0)) с (apply.log)" \
    || result "apply: код" FAIL "$RC (apply.log)"
  local url ref
  url="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$APP" \
    | sed -n 's/^DOCUMENTS_URL=//p')"
  [[ "$url" == "http://documents:8310" ]] \
    && result "apply: app на documents без роутера" ok "DOCUMENTS_URL=$url" \
    || result "apply: app на documents без роутера" FAIL "DOCUMENTS_URL=$url"
  ref="$(grep '^BAI_IMAGE_DOCUMENTS=' "$LOCK" | cut -d= -f2-)"
  [[ "$(container_image "$DOCS")" == "$ref" ]] \
    && result "apply: documents на образе проекта" ok "${ref##*/}" \
    || result "apply: documents на образе проекта" FAIL "$(container_image "$DOCS")"
  local code
  for code in amend party-block replace-signatory classify; do
    [[ "$(route_status "$APP" "http://documents:8310/docx/$code")" != 404 ]] \
      && result "apply: /docx/$code напрямую в documents" ok "не 404" \
      || result "apply: /docx/$code напрямую в documents" FAIL "404"
  done
  { service_present documents-router || service_present documents-legacy; } \
    && result "apply: обход снят" FAIL "контейнеры обхода остались" \
    || result "apply: обход снят" ok "documents-router и documents-legacy удалены"
  docker image inspect pragmatika-documents:legacy-docx >/dev/null 2>&1 \
    && result "apply: тег legacy-docx цел" ok "образ для отката на месте" \
    || result "apply: тег legacy-docx цел" FAIL "тег удалён"
  [[ "$(docker inspect -f '{{.HostConfig.Memory}}' "$PROJECT-alloy-1")" == "$ALLOY_MEM_NEW" ]] \
    && result "apply: alloy 448 МиБ" ok "$ALLOY_MEM_NEW" \
    || result "apply: alloy 448 МиБ" FAIL "лимит иной"
  grep -q 'pragmatika-documents@sha256' "$DEPLOY/images.lock" \
    && result "apply: images.lock боя новый" ok "образ documents проекта" \
    || result "apply: images.lock боя новый" FAIL "lock прежний"
  [[ "$(find "$OUT/backups" -maxdepth 1 -name 'pragmatika-patch-*' | wc -l)" -ge 1 ]] \
    && result "apply: бэкап файлов дерева" ok "$(find "$OUT/backups" -maxdepth 1 -name 'pragmatika-patch-*' | head -1 | xargs -n1 basename)" \
    || result "apply: бэкап файлов дерева" FAIL "нет каталога бэкапа"
  # Простой app: от остановки старого контейнера до старта нового (события docker, UTC).
  local die_ns start_ns
  die_ns="$(docker events --since "$t0" --until "$t1" --filter "container=$APP" \
    --filter event=die --format '{{.TimeNano}}' 2>/dev/null | head -1)"
  start_ns="$(docker events --since "$t0" --until "$t1" --filter "container=$APP" \
    --filter event=start --format '{{.TimeNano}}' 2>/dev/null | tail -1)"
  if [[ -n "$die_ns" && -n "$start_ns" ]]; then
    result "apply: простой app" ok "$(( (start_ns - die_ns) / 1000000 )) мс от остановки до старта (заглушка)"
  else
    result "apply: простой app" FAIL "события docker не получены"
  fi
  RUN_APPLIED="$(readlink -f "$OUT/home/patch-latest")"
}

step_rollback() {
  [[ -n "${RUN_APPLIED:-}" ]] || RUN_APPLIED="$(readlink -f "$OUT/home/patch-latest")"
  run_patch rollback --rollback --run-dir "$RUN_APPLIED"
  [[ "$RC" == 0 ]] && result "rollback: код" ok "0 (rollback.log)" \
    || result "rollback: код" FAIL "$RC (rollback.log)"
  unchanged_since_prepare rollback
  local url
  url="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$APP" \
    | sed -n 's/^DOCUMENTS_URL=//p')"
  [[ "$url" == "http://documents-router:8310" ]] \
    && result "rollback: app снова на роутере обхода" ok "DOCUMENTS_URL=$url" \
    || result "rollback: app снова на роутере обхода" FAIL "DOCUMENTS_URL=$url"
  [[ "$(route_status "$APP" http://documents-router:8310/docx/party-block)" != 404 ]] \
    && result "rollback: /docx/party-block через обход" ok "не 404" \
    || result "rollback: /docx/party-block через обход" FAIL "404"
}

step_broken() {
  # documents слушает только 127.0.0.1: соседи (и проверка маршрутов) его не видят -> сбой после
  # замены файлов -> автооткат.
  RC=0
  STAND_DOCUMENTS_HOST=127.0.0.1 run_patch broken
  [[ "$RC" == 1 ]] && result "broken: код" ok "1 (сбой, откат выполнен)" \
    || result "broken: код" FAIL "$RC (broken.log)"
  grep -q 'автоматический откат' "$OUT/broken.log" \
    && result "broken: автооткат запущен" ok "запись в журнале" \
    || result "broken: автооткат запущен" FAIL "нет записи"
  grep -q 'ОТКАТ ПАТЧА ВЫПОЛНЕН' "$OUT/broken.log" \
    && result "broken: откат выполнен и проверен" ok "проверки отката прошли" \
    || result "broken: откат выполнен и проверен" FAIL "нет записи об успешном откате"
  # documents после отката поднят без STAND_DOCUMENTS_HOST: возвращаем состояние «до патча».
  unchanged_since_prepare broken
  [[ "$(route_status "$APP" http://documents-router:8310/docx/party-block)" != 404 ]] \
    && result "broken: обход работает после отката" ok "/docx/party-block не 404" \
    || result "broken: обход работает после отката" FAIL "404"
}

step_cleanup() {
  dcs down -v --remove-orphans >/dev/null 2>&1 || true
  docker rmi pragmatika-documents:legacy-docx >/dev/null 2>&1 || true
  [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" ]] \
    && result "cleanup: контейнеры стенда убраны" ok "проект $PROJECT пуст" \
    || result "cleanup: контейнеры стенда убраны" FAIL "остались контейнеры"
}

: >"$STEPS_FILE"
PKG="$OUT/package"
for s in $STEPS; do
  log "=== шаг $s"
  case "$s" in
    prepare) step_prepare ;;
    preflight) step_preflight ;;
    refuse) step_refuse ;;
    apply) step_apply ;;
    rollback) step_rollback ;;
    broken) step_broken ;;
    cleanup) step_cleanup ;;
    *) echo "неизвестный шаг $s" >&2; exit 2 ;;
  esac
done
TOTAL="$(wc -l <"$STEPS_FILE")"
{ echo "проверок: $TOTAL, провалено: $FAILS"; cat "$STEPS_FILE"; } >"$OUT/summary.txt"
log "итог: проверок $TOTAL, провалено $FAILS (summary.txt)"
[[ "$FAILS" -eq 0 ]]
