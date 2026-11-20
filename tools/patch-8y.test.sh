#!/usr/bin/env bash
# Тест deploy/patch-8y/patch.sh (патч G8y: платформа остаётся 1.1.6, меняются только образы
# pragmatika-app и pragmatika-documents 1.1.6-pragmatika.2, заменяется один файл дерева -
# images.lock) без настоящего Docker: вместо docker - заглушка с памятью о контейнерах, их образах,
# окружении и времени старта (в том числе пробы /health, /ready и POST /docx/amend). Проверяются
# отказы по предусловиям (бой не тронут, код 3), в том числе «патч G8x не применён», чужой ключ
# lock, файл deploy/ в пакете и повторный запуск; --preflight-only (дерево побайтно прежнее);
# успешный ход (documents, затем app; образы, четыре флага G8x, проба /docx/amend); сбои с
# автооткатом (код 1, дерево побайтно прежнее, оба контейнера на образах G8x); невозможный откат
# (код 4); ручной --rollback; настоящий JS пробы (если на хосте есть bun) против локального
# сервера; стиль. Ход на настоящем Docker проверяет tools/patch-8y-synth.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$ROOT/deploy/patch-8y"
TMP="${PATCH8Y_TEST_TMP:-$(mktemp -d)}"
SERVER_PID=""
# PATCH8Y_TEST_KEEP=1 оставляет рабочий каталог теста (выводы и журналы запусков) для разбора.
cleanup() {
  [[ -z "$SERVER_PID" ]] || kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "${PATCH8Y_TEST_KEEP:-}" ]] || rm -rf "${TMP:?}"
}
trap cleanup EXIT
PASS=0
FAIL=0
LIMIT=100
EXIT_FAILED=1
EXIT_USAGE=2
EXIT_REFUSED=3
EXIT_STUCK=4
SERVER_WAIT_S=10
VER_FROM="1.1.6-pragmatika.1"
VER_TO="1.1.6-pragmatika.2"
H_OLD_APP="1111111111111111111111111111111111111111111111111111111111111111"
H_NEW_APP="2222222222222222222222222222222222222222222222222222222222222222"
H_BASE="3333333333333333333333333333333333333333333333333333333333333333"
H_BASE2="4444444444444444444444444444444444444444444444444444444444444444"
H_OLD_DOCS="5555555555555555555555555555555555555555555555555555555555555555"
H_NEW_DOCS="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
H_DBASE="6666666666666666666666666666666666666666666666666666666666666666"
H_ALLOY="7777777777777777777777777777777777777777777777777777777777777777"
H_ALLOY2="8888888888888888888888888888888888888888888888888888888888888888"
H_MASK="9999999999999999999999999999999999999999999999999999999999999999"
# Секрет только в окружении контейнера app (короче порога маскирования журнала): если он попал в
# журнал или архив, значит, патч печатает окружение целиком.
APP_ENV_SECRET="TOPSEC1"
FILE_SECRET="live-secret-token-0123456789"
# Метка в теле ответа documents: если она попала в журнал, патч печатает тело ответа пробы.
BODY_MARK="LEAKMARK-body-7731"
# Изменяющие команды docker: при отказе не должна появиться ни одна (одноразовые пробы без сети
# и пробы /ready, /health в сети app допустимы: они ничего не меняют).
MUTATING_RE='^(create|rm|stop|kill|start|restart|load|pull|volume|network|compose .*up)'

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# --- Заглушка docker ---------------------------------------------------------------------------
# Память стенда: $STUB/containers (имя<TAB>образ), $STUB/env/<имя> (окружение контейнера),
# $STUB/started/<имя> (StartedAt), журнал вызовов в $DOCKER_LOG. Ручки сбоев - STUB_* (ниже).
BIN="$TMP/bin"
mkdir -p "$BIN"
cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_LOG"
set_image() { # set_image <имя> <образ>: заменить или добавить строку контейнера
  grep -v "^$1"$'\t' "$STUB/containers" >"$STUB/containers.n" || true
  printf '%s\t%s\n' "$1" "$2" >>"$STUB/containers.n"
  mv "$STUB/containers.n" "$STUB/containers"
}
lock_ref() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2-; }
bump_started() { # bump_started <имя>: новое время старта контейнера
  local n
  n="$(cat "$STUB/counter" 2>/dev/null || echo 0)"
  n=$((n + 1))
  echo "$n" >"$STUB/counter"
  printf '2026-11-19T10:00:%02dZ\n' "$n" >"$STUB/started/$1"
}
docs_is_new() { grep "^p-documents-1"$'\t' "$STUB/containers" | grep -q "$H_NEW_DOCS"; }
app_is_new() { grep "^p-app-1"$'\t' "$STUB/containers" | grep -q "$H_NEW_APP"; }
# Ответ пробы /docx/amend: новый образ documents - «422 bad_request», старый (поля игнорирует) -
# иной ответ. Статус и код ошибки новой пробы настраиваются.
amend_reply() {
  local old=0
  if [[ "${STUB_AMEND_DOWN:-0}" == 1 ]]; then echo "documents недоступен: refused"; exit 1; fi
  docs_is_new || old=1
  [[ "${STUB_AMEND_OLD_BEHAVIOR:-0}" != 1 ]] || old=1
  if [[ "${STUB_AMEND_APP_STAGE_FAIL:-0}" == 1 ]] && app_is_new; then old=1; fi
  if ((old)); then
    echo "${STUB_AMEND_OLD_REPLY:-400 empty_content}"
  else
    echo "${STUB_AMEND_CODE:-422} ${STUB_AMEND_ERR-bad_request}"
  fi
  exit 0
}
case "$1" in
  compose)
    lock="$(printf '%s\n' "$@" | grep -m1 'images.lock$' || true)"
    dir="$(dirname "${lock:-/nonexistent/x}")"
    case " $* " in
      *" version "*) echo "2.40.3" ;;
      *" config "*"--format json"*)
        printf '{"services":{"app":{"environment":{"OPENAI_API_KEY":"%s"' "$APP_ENV_SECRET"
        if [[ "${STUB_CFG_NO_YANDEX:-0}" != 1 ]]; then
          printf ',"YANDEX_SEARCH_MAX_CONCURRENCY":"1","YANDEX_SEARCH_MIN_INTERVAL_MS":"1200"'
        fi
        printf '}},"documents":{"environment":{"DOCUMENTS_EDIT_ENDPOINTS":"true"'
        if grep -q 'DOCUMENTS_EDIT_PPTX' "$dir/compose.project.yml" 2>/dev/null; then
          printf ',"DOCUMENTS_EDIT_PPTX":"%s","DOCUMENTS_EDIT_PDF":"true"' "${STUB_CFG_PPTX:-true}"
          printf ',"DOCUMENTS_PPT_CONVERT":"true"'
          printf ',"DOCUMENTS_EDIT_PDF_FALLBACK_FONT":"%s"' "${STUB_CFG_FALLBACK:-false}"
        fi
        printf '}}}}\n' ;;
      *" config "*) exit "${STUB_CONFIG_RC:-0}" ;;
      *" up "*)
        touch "$STUB/started-any"
        svc="${*: -1}"
        case "$svc" in
          documents)
            ref="$(lock_ref "$lock" BAI_IMAGE_DOCUMENTS)"
            pdf=true
            fallback=false
            flags=1
            if [[ "$ref" == *"$H_NEW_DOCS"* ]]; then
              [[ "${STUB_DOCS_UP_FAIL:-0}" != 1 ]] || { echo "compose: ошибка up" >&2; exit 1; }
              [[ "${STUB_WRONG_DOCS_IMAGE:-0}" != 1 ]] || ref="r/documents@sha256:wrong"
              pdf="${STUB_ENV_PDF:-true}"
              fallback="${STUB_ENV_FALLBACK:-false}"
              [[ "${STUB_NO_DOCS_FLAGS:-0}" != 1 ]] || flags=0
            fi
            set_image p-documents-1 "$ref"
            bump_started p-documents-1
            grep -v '^DOCUMENTS_' "$STUB/env/p-documents-1" >"$STUB/env/p-documents-1.n" || true
            if ((flags)); then
              {
                echo "DOCUMENTS_EDIT_PPTX=true"
                echo "DOCUMENTS_EDIT_PDF=$pdf"
                echo "DOCUMENTS_PPT_CONVERT=true"
                echo "DOCUMENTS_EDIT_PDF_FALLBACK_FONT=$fallback"
              } >>"$STUB/env/p-documents-1.n"
            fi
            mv "$STUB/env/p-documents-1.n" "$STUB/env/p-documents-1" ;;
          app)
            ref="$(lock_ref "$lock" BAI_IMAGE_APP)"
            if [[ "$ref" == *"$H_NEW_APP"* ]]; then
              [[ "${STUB_UP_FAIL:-0}" != 1 ]] || { echo "compose: ошибка up" >&2; exit 1; }
              [[ "${STUB_WRONG_APP_IMAGE:-0}" != 1 ]] || ref="r/app@sha256:wrong"
            fi
            set_image p-app-1 "$ref"
            bump_started p-app-1
            grep -v '^YANDEX_' "$STUB/env/p-app-1" >"$STUB/env/p-app-1.n" || true
            if [[ "${STUB_APP_LOSE_YANDEX:-0}" != 1 || "$ref" != *"$H_NEW_APP"* ]]; then
              echo "YANDEX_SEARCH_MAX_CONCURRENCY=1" >>"$STUB/env/p-app-1.n"
              echo "YANDEX_SEARCH_MIN_INTERVAL_MS=1200" >>"$STUB/env/p-app-1.n"
            fi
            mv "$STUB/env/p-app-1.n" "$STUB/env/p-app-1"
            [[ "${STUB_DOCS_RESTART:-0}" != 1 ]] || bump_started p-documents-1 ;;
        esac ;;
    esac ;;
  ps)
    if [[ "$*" == *"name=^"* ]]; then echo abc123; exit 0; fi
    svc="$(printf '%s\n' "$@" | sed -n 's/^label=com.docker.compose.service=//p')"
    if [[ -n "$svc" ]]; then
      cut -f1 "$STUB/containers" | grep -x "p-$svc-1" || true
    else
      cut -f1 "$STUB/containers"
    fi ;;
  inspect)
    name="${*: -1}"
    img="$(grep "^$name"$'\t' "$STUB/containers" | cut -f2 || true)"
    case "$*" in
      *"range .Config.Env"*) [[ -n "$img" ]] && cat "$STUB/env/$name" || exit 1 ;;
      *"State.StartedAt"*) [[ -n "$img" ]] && cat "$STUB/started/$name" || exit 1 ;;
      *"{{.Config.Image}}"*) [[ -n "$img" ]] && echo "$img" || exit 1 ;;
      *"{{.Image}}"*) [[ -n "$img" ]] || exit 1
        echo "sha256:id-$(printf '%s' "$img" | tr -c 'a-z0-9' '-')" ;;
      *"RestartCount"*)
        if [[ "${STUB_RESTART_LOOP:-0}" == 1 && "$name" == p-app-1 ]] \
          || [[ "${STUB_DOCS_RESTART_LOOP:-0}" == 1 && "$name" == p-documents-1 ]]; then
          n="$(cat "$STUB/restarts-$name" 2>/dev/null || echo 0)"
          echo $((n + 1)) >"$STUB/restarts-$name"
          echo "$n"
        else
          echo 0
        fi ;;
      *"State.Status"*)
        [[ -n "$img" ]] || exit 1
        if [[ "${STUB_DOCS_EXITED:-0}" == 1 && "$name" == p-documents-1 ]] && docs_is_new; then
          echo exited
        else
          echo running
        fi ;;
      *"State.Health"*) [[ -n "$img" ]] && echo healthy || echo отсутствует ;;
    esac ;;
  image)
    ref="${*: -1}"
    # Запрос id по ссылке (для сравнения образов) отвечает всегда; проверка наличия образа
    # (без формата) - по списку «отсутствующих».
    if [[ "$2" == inspect && "$*" == *"{{.Id}}"* ]]; then
      echo "sha256:id-$(printf '%s' "$ref" | tr -c 'a-z0-9' '-')"
      exit 0
    fi
    if [[ -s "$STUB/missing" ]] && grep -qF -f "$STUB/missing" <<<"$ref"; then exit 1; fi ;;
  pull)
    # Образ появился на хосте: убрать его из списка «отсутствующих».
    while IFS= read -r m; do [[ "$2" == *"$m"* ]] || echo "$m"; done <"$STUB/missing" \
      >"$STUB/missing.n"
    mv "$STUB/missing.n" "$STUB/missing" ;;
  info) echo "$TMP_DOCKER_ROOT" ;;
  stop) ;;
  rm) grep -v "^$2"$'\t' "$STUB/containers" >"$STUB/containers.n" || true
      mv "$STUB/containers.n" "$STUB/containers" ;;
  exec)
    # У G8y внутри контейнеров проверять нечего: любой docker exec - ошибка патча.
    echo "docker exec не нужен патчу G8y" >&2
    exit 99 ;;
  run)
    if [[ "$*" == *"bun"* ]]; then
      [[ "${STUB_NO_READY:-0}" != 1 ]] || { echo "app недоступен"; exit 1; }
      # Откат не удался: после первого up стенд больше не отвечает
      if [[ "${STUB_STUCK:-0}" == 1 && -e "$STUB/started-any" ]]; then
        echo "app недоступен"; exit 1
      fi
      case "$*" in
        *"/docx/amend"*)
          # Настоящий JS пробы против локального сервера (тест разбора ответа).
          if [[ -n "${STUB_REAL_JS_URL:-}" ]]; then
            body="$(printf '%s\n' "$@" | sed -n 's/^PATCH_AMEND_BODY=//p')"
            PATCH_DOCS_URL="$STUB_REAL_JS_URL" PATCH_AMEND_BODY="$body" bun -e "${*: -1}"
            exit $?
          fi
          amend_reply ;;
        *"/health"*)
          if [[ "${STUB_DOCS_HEALTH_500:-0}" == 1 ]] && docs_is_new; then
            echo '500 {}'; exit 1
          fi
          echo '200 {}'; exit 0 ;;
      esac
      if [[ "${STUB_READY_500:-0}" == 1 ]] && app_is_new; then
        echo '500 {"bots":{"ready":0}}'; exit 1
      fi
      echo "200 {\"bots\":{\"ready\":${STUB_BOTS:-4}}}"
    fi ;;
esac
exit 0
STUB
chmod +x "$BIN/docker"
printf '#!/usr/bin/env bash\nexit "${STUB_COSIGN_RC:-0}"\n' >"$BIN/cosign-stub"
chmod +x "$BIN/cosign-stub"

# --- Боевое дерево (после G8x), пакет и заглушки инструментов ----------------------------------
LIVE_ROOT="$TMP/opt/pragmatika-v2"
LIVE="$LIVE_ROOT/deploy"
GOLDEN="$TMP/golden"
PKG="$TMP/pkg"
PKGG="$TMP/pkg-golden"
OLD_APP="r/app@sha256:$H_OLD_APP"
NEW_APP="r/app@sha256:$H_NEW_APP"
OLD_DOCS="r/pragmatika-documents@sha256:$H_OLD_DOCS"
NEW_DOCS="r/pragmatika-documents@sha256:$H_NEW_DOCS"
YANDEX_VARS='      YANDEX_SEARCH_MAX_CONCURRENCY: ${YANDEX_SEARCH_MAX_CONCURRENCY:-1}
      YANDEX_SEARCH_MIN_INTERVAL_MS: ${YANDEX_SEARCH_MIN_INTERVAL_MS:-1200}'
write_lock() { # write_lock <файл> <app> <основа app> <documents> <основа documents> <версия>
  {
    echo "BAI_VERSION=$6"
    echo "BAI_IMAGE_APP=$2"
    echo "BAI_IMAGE_APP_BASE=$3"
    echo "BAI_IMAGE_ALLOY=r/alloy@sha256:$H_ALLOY"
    echo "BAI_IMAGE_MASK=r/mask@sha256:$H_MASK"
    echo "BAI_IMAGE_DOCUMENTS=$4"
    echo "BAI_IMAGE_DOCUMENTS_BASE=$5"
  } >"$1"
}
mkdir -p "$GOLDEN/platform" "$GOLDEN/hotfix" "$PKGG/tools"
# Основы app и documents у G8x и G8y одни и те же (G8y строится поверх тех же образов платформы).
write_lock "$GOLDEN/images.lock" "$OLD_APP" "r/app-base@sha256:$H_BASE" "$OLD_DOCS" \
  "r/bai-documents@sha256:$H_DBASE" "$VER_FROM"
write_lock "$PKGG/images.lock" "$NEW_APP" "r/app-base@sha256:$H_BASE" "$NEW_DOCS" \
  "r/bai-documents@sha256:$H_DBASE" "$VER_TO"
echo "services: {}" >"$GOLDEN/compose.yml"
echo "MARK=old" >"$GOLDEN/compat.env"
{
  printf 'services:\n  app:\n    environment:\n%s\n  documents:\n    environment:\n' "$YANDEX_VARS"
  printf '      DOCUMENTS_EDIT_PPTX: ${DOCUMENTS_EDIT_PPTX:-true}\n'
  printf '      DOCUMENTS_EDIT_PDF: ${DOCUMENTS_EDIT_PDF:-true}\n'
  printf '      DOCUMENTS_PPT_CONVERT: ${DOCUMENTS_PPT_CONVERT:-true}\n'
  printf '      DOCUMENTS_EDIT_PDF_FALLBACK_FONT: ${DOCUMENTS_EDIT_PDF_FALLBACK_FONT:-false}\n'
} >"$GOLDEN/compose.project.yml"
cp "$GOLDEN/compose.project.yml" "$GOLDEN/platform/compose.base.yml"
echo "PLATFORM_PACKAGES_VERSION=1.1.6" >"$GOLDEN/platform/PLATFORM-VERSION"
printf 'POSTGRES_USER=pragmatika\nOPENAI_API_KEY=%s\n' "$FILE_SECRET" >"$GOLDEN/.env"
chmod 600 "$GOLDEN/.env"
echo "MASK_TOKEN=$FILE_SECRET-mask" >"$GOLDEN/secrets.mask.env"
chmod 600 "$GOLDEN/secrets.mask.env"
echo "#!/bin/true" >"$GOLDEN/hotfix/dc-v2.sh"
date -u +%FT%TZ >"$GOLDEN/.cutover-deployed"
cp "$ROOT/deploy/cutover/lib.sh" "$PKGG/lib.sh"
cp "$SRC/patch.sh" "$PKGG/patch.sh"
cp "$ROOT/tools/route-flags.tsv" "$PKGG/tools/route-flags.tsv"
printf 'documents\tPOST\t/docx/amend\troute\n' >"$PKGG/routes.tsv"
# Заглушка проверки маршрутов стека: код задаёт файл STUB_ROUTES_RC_FILE (0 - успех); настоящий
# скрипт тестируется отдельно.
printf '#!/usr/bin/env bash\necho "[check-routes] ok"\n' >"$PKGG/tools/check-routes.sh"
printf 'exit "$(cat "${STUB_ROUTES_RC_FILE:-/nonexistent}" 2>/dev/null || echo 0)"\n' \
  >>"$PKGG/tools/check-routes.sh"
chmod +x "$PKGG/tools/check-routes.sh"
echo "public-key" >"$PKGG/cosign.pub"
PUB_SHA="$(sha256sum "$PKGG/cosign.pub" | cut -d' ' -f1)"

make_sigs() { # make_sigs <файл> <result>: подтверждение подписей по lock пакета
  local key ref
  printf '# verify-signatures v1\nlock_sha256=%s\npubkey_sha256=%s\ncosign=v3\n' \
    "$(sha256sum "$PKG/images.lock" | cut -d' ' -f1)" "$PUB_SHA" >"$1"
  printf 'verified_at=2026-11-20T08:00:00Z\n' >>"$1"
  while IFS='=' read -r key ref; do
    [[ "$key" == BAI_IMAGE_* ]] || continue
    printf 'image\t%s\t%s\tOK\n' "$key" "$ref" >>"$1"
  done <"$PKG/images.lock"
  printf 'result=%s\n' "$2" >>"$1"
}
seal() { (cd "$PKG" && find . -type f ! -name MANIFEST.sha256 | sort | sed 's|^\./||' \
  | xargs -d '\n' sha256sum >MANIFEST.sha256); }
reset_pkg() { # reset_pkg: пакет как собран (подписи OK, манифест сходится)
  rm -rf "${PKG:?}"
  cp -a "$PKGG" "$PKG"
  make_sigs "$PKG/signatures.txt" OK
  seal
}
# pkg_lock_edit <sed-выражение>: правка lock пакета с пересчётом подписей и манифеста.
pkg_lock_edit() {
  sed -i "$1" "$PKG/images.lock"
  make_sigs "$PKG/signatures.txt" OK
  seal
}

reset_stand() { # reset_stand: бой «после G8x» (дерево, контейнеры, окружение), пакет как собран
  STUB="$TMP/stub"
  rm -rf "${STUB:?}" "${LIVE_ROOT:?}"
  mkdir -p "$STUB/env" "$STUB/started" "$LIVE_ROOT"
  cp -a "$GOLDEN" "$LIVE"
  printf '%s\t%s\n' "p-postgres-1" "r/postgres@sha256:pg" \
    "p-documents-1" "$OLD_DOCS" "p-alloy-1" "r/alloy@sha256:$H_ALLOY" \
    "p-app-1" "$OLD_APP" >"$STUB/containers"
  local name
  for name in p-postgres-1 p-documents-1 p-alloy-1 p-app-1; do
    echo "2026-11-18T08:00:00Z" >"$STUB/started/$name"
    echo "PATH=/usr/bin" >"$STUB/env/$name"
  done
  printf 'DOCUMENTS_URL=http://documents:8310\nOPENAI_API_KEY=%s\n' "$APP_ENV_SECRET" \
    >>"$STUB/env/p-app-1"
  printf 'YANDEX_SEARCH_MAX_CONCURRENCY=1\nYANDEX_SEARCH_MIN_INTERVAL_MS=1200\n' \
    >>"$STUB/env/p-app-1"
  printf 'DOCUMENTS_EDIT_PPTX=true\nDOCUMENTS_EDIT_PDF=true\nDOCUMENTS_PPT_CONVERT=true\n' \
    >>"$STUB/env/p-documents-1"
  printf 'DOCUMENTS_EDIT_PDF_FALLBACK_FONT=false\n' >>"$STUB/env/p-documents-1"
  : >"$STUB/missing"
  reset_pkg
}

# Хэши и права всех файлов боевого дерева: «побайтно прежнее» = равенство снимков.
tree_snapshot() { (cd "$LIVE" && find . -type f | sort | xargs -d '\n' sha256sum \
  && find . -type f -printf '%m %p\n' | sort); }
# Хэши файлов дерева, КРОМЕ images.lock: патч G8y их менять не вправе.
tree_without_lock() { (cd "$LIVE" && find . -type f ! -name 'images.lock' | sort \
  | xargs -d '\n' sha256sum); }

# run <имя> [аргументы patch.sh]: изолированный $HOME (T_HOME - общий для запусков); код в RC,
# вывод в $TMP/out-<имя>.
run() {
  local name="$1" home="${T_HOME:-$1}"
  shift
  : >"$TMP/docker-$name.log"
  mkdir -p "$TMP/home-$home"
  RC=0
  env HOME="$TMP/home-$home" PATH="$BIN:$PATH" DOCKER_LOG="$TMP/docker-$name.log" STUB="$STUB" \
    TMP_DOCKER_ROOT="$TMP" H_NEW_APP="$H_NEW_APP" H_NEW_DOCS="$H_NEW_DOCS" \
    APP_ENV_SECRET="$APP_ENV_SECRET" \
    CUTOVER_COSIGN="${TEST_COSIGN:-/nonexistent-cosign}" CUTOVER_NEW_DIR="$LIVE_ROOT" \
    CUTOVER_PROJECT=p CUTOVER_APP_CONTAINER=p-app-1 CUTOVER_ENV_FILE="$TMP/none.env" \
    CUTOVER_READY_WAIT_S=3 CUTOVER_POLL_S=1 CUTOVER_HEALTH_WAIT_S=3 \
    PATCH8Y_MIN_DISK_MIB="${T_MIN_DISK:-1}" PATCH8Y_MIN_AVAILABLE_MIB=1 PATCH8Y_SOAK_POLL_S=1 \
    bash "$PKG/patch.sh" --soak-seconds 2 "$@" >"$TMP/out-$name" 2>&1 || RC=$?
}
no_mutation() { ! grep -E "$MUTATING_RE" "$TMP/docker-$1.log" | grep -qv '^compose version'; }
out_has() { grep -q -- "$2" "$TMP/out-$1"; }
app_up_count() { grep -cE '^compose .* up -d --no-deps app$' "$TMP/docker-$1.log" || true; }
docs_up_count() { grep -cE '^compose .* up -d --no-deps documents$' "$TMP/docker-$1.log" || true; }
other_up() { grep -E '^compose .* up ' "$TMP/docker-$1.log" \
  | grep -vE ' up -d --no-deps (app|documents)$'; }
amend_probe_count() { grep -c "fetch(base + '/docx/amend'" "$TMP/docker-$1.log" || true; }
app_is_old() { grep -q "^p-app-1"$'\t'"$OLD_APP" "$STUB/containers"; }
app_is_new() { grep -q "^p-app-1"$'\t'"$NEW_APP" "$STUB/containers"; }
docs_is_old() { grep -q "^p-documents-1"$'\t'"$OLD_DOCS" "$STUB/containers"; }
docs_is_new() { grep -q "^p-documents-1"$'\t'"$NEW_DOCS" "$STUB/containers"; }
# Строка журнала docker, в которой первый раз встретился up указанного сервиса.
up_line() {
  grep -nE "^compose .* up -d --no-deps $2\$" "$TMP/docker-$1.log" | head -1 | cut -d: -f1
}
# refuse_case <имя> <описание>: код 3, бой не тронут (нет изменяющих команд), дерево прежнее.
refuse_case() {
  assert "$2: код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
  assert "$2: бой не тронут" "no_mutation $1 && [[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
}

assert "patch.sh на месте" "[[ -f '$SRC/patch.sh' ]]"
reset_stand
T0="$(tree_snapshot)"
W0="$(tree_without_lock)"

# 1. Отказы по предусловиям: бой не тронут (ни stop/rm/pull/compose up), дерево прежнее.
echo "tamper" >>"$PKG/routes.tsv"
run manifest
refuse_case manifest "MANIFEST не сходится"

reset_pkg
rm -f "$PKG/signatures.txt"
seal
run nosig
refuse_case nosig "нет подтверждения подписей и cosign"
assert "нет подписей: сообщение называет signatures" "out_has nosig 'signatures'"

reset_pkg
make_sigs "$PKG/signatures.txt" FAIL
seal
run sigfail
refuse_case sigfail "подписи result=FAIL"

reset_pkg
TEST_COSIGN="$BIN/cosign-stub" STUB_COSIGN_RC=1 run cosignfail
refuse_case cosignfail "cosign verify красный"
TEST_COSIGN="$BIN/cosign-stub" run cosignok --preflight-only
assert "cosign verify зелёный: preflight код 0" "[[ $RC -eq 0 ]]"
assert "cosign: журнал называет проверку на хосте" "out_has cosignok 'cosign verify на хосте'"

# Чужие ключи lock: alloy, mask, основы app и documents (патч меняет только app и documents).
reset_pkg
pkg_lock_edit "s|^BAI_IMAGE_ALLOY=.*|BAI_IMAGE_ALLOY=r/alloy@sha256:$H_ALLOY2|"
run alloylock
refuse_case alloylock "lock меняет образ alloy"
assert "alloy: сообщение называет ключ" "out_has alloylock 'BAI_IMAGE_ALLOY'"
reset_pkg
pkg_lock_edit "s|^BAI_IMAGE_MASK=.*|BAI_IMAGE_MASK=r/mask@sha256:$H_ALLOY2|"
run masklock
refuse_case masklock "lock меняет образ mask"
reset_pkg
pkg_lock_edit "s|^BAI_IMAGE_APP_BASE=.*|BAI_IMAGE_APP_BASE=r/app-base@sha256:$H_BASE2|"
run appbase
refuse_case appbase "lock меняет основу app (BAI_IMAGE_APP_BASE)"
assert "основа app: сообщение называет ключ" "out_has appbase 'BAI_IMAGE_APP_BASE'"
reset_pkg
pkg_lock_edit \
  "s|^BAI_IMAGE_DOCUMENTS_BASE=.*|BAI_IMAGE_DOCUMENTS_BASE=r/bai-documents@sha256:$H_BASE2|"
run docsbase
refuse_case docsbase "lock меняет основу documents (BAI_IMAGE_DOCUMENTS_BASE)"
assert "основа documents: сообщение называет ключ" "out_has docsbase 'BAI_IMAGE_DOCUMENTS_BASE'"
reset_pkg
pkg_lock_edit '/^BAI_IMAGE_ALLOY=/d'
run lockdelkey
refuse_case lockdelkey "lock пакета теряет чужой ключ (alloy)"
reset_pkg
pkg_lock_edit "s|^BAI_VERSION=.*|BAI_VERSION=1.1.6-pragmatika.3|"
run pkgwrongver
refuse_case pkgwrongver "BAI_VERSION пакета не $VER_TO"
assert "версия пакета: сообщение называет $VER_TO" "out_has pkgwrongver '$VER_TO'"

# G8x не применён: разные признаки, подсказка «сначала примените патч G8x».
g8x_case() { # g8x_case <имя> <описание>: код 3, бой не тронут, подсказка в сообщении
  assert "$2: код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
  assert "$2: бой не тронут" "no_mutation $1 && [[ \"\$(tree_snapshot)\" == \"\$T1\" ]]"
  assert "$2: сообщение «сначала примените патч G8x»" "out_has $1 'сначала примените патч G8x'"
}
reset_stand
sed -i "s|^BAI_VERSION=.*|BAI_VERSION=1.1.5-pragmatika.1|" "$LIVE/images.lock"
T1="$(tree_snapshot)"
run lockver115
g8x_case lockver115 "G8x не применён: BAI_VERSION боя 1.1.5-pragmatika.1"
reset_stand
sed -i "s|^BAI_VERSION=.*|BAI_VERSION=1.1.6-pragmatika.0|" "$LIVE/images.lock"
T1="$(tree_snapshot)"
run lockver0
g8x_case lockver0 "G8x не применён: BAI_VERSION боя не .1"
assert "версия lock: сообщение называет ожидаемую" "out_has lockver0 '$VER_FROM'"
reset_stand
echo "PLATFORM_PACKAGES_VERSION=1.1.5" >"$LIVE/platform/PLATFORM-VERSION"
T1="$(tree_snapshot)"
run platform115
g8x_case platform115 "G8x не применён: платформа боя 1.1.5"
reset_stand
rm -f "$LIVE/platform/PLATFORM-VERSION"
T1="$(tree_snapshot)"
run noplatform
g8x_case noplatform "G8x не применён: нет PLATFORM-VERSION"
reset_stand
sed -i "s|^p-app-1.*|p-app-1\tr/app@sha256:other|" "$STUB/containers"
T1="$(tree_snapshot)"
run appimage
g8x_case appimage "G8x не применён: app не на образе из lock боя"
reset_stand
sed -i "s|^p-documents-1.*|p-documents-1\tr/other-documents@sha256:other|" "$STUB/containers"
T1="$(tree_snapshot)"
run docsimage
g8x_case docsimage "G8x не применён: documents не на образе из lock боя"
reset_stand
sed -i '/^YANDEX_SEARCH_MAX_CONCURRENCY/d' "$STUB/env/p-app-1"
T1="$(tree_snapshot)"
run noyandex
g8x_case noyandex "G8x не применён: у app нет переменной поиска G8w"
assert "нет переменной поиска: сообщение называет её" \
  "out_has noyandex 'YANDEX_SEARCH_MAX_CONCURRENCY'"
for flag_case in "DOCUMENTS_EDIT_PPTX|d" "DOCUMENTS_EDIT_PDF|d" "DOCUMENTS_PPT_CONVERT|d" \
  "DOCUMENTS_EDIT_PDF_FALLBACK_FONT|d" "DOCUMENTS_EDIT_PPTX|s=false" \
  "DOCUMENTS_EDIT_PDF_FALLBACK_FONT|s=true"; do
  flag="${flag_case%%|*}"
  how="${flag_case#*|}"
  reset_stand
  if [[ "$how" == d ]]; then
    sed -i "/^$flag=/d" "$STUB/env/p-documents-1"
  else
    sed -i "s|^$flag=.*|$flag=${how#s=}|" "$STUB/env/p-documents-1"
  fi
  T1="$(tree_snapshot)"
  run "flag-$flag-$how"
  g8x_case "flag-$flag-$how" "G8x не применён: флаг $flag ($how)"
  assert "флаг $flag ($how): сообщение называет флаг" "out_has 'flag-$flag-$how' '$flag'"
done

# Файлы дерева в пакете: у G8y заменяется только images.lock, любой файл deploy/ - отказ.
reset_stand
mkdir -p "$PKG/deploy/platform"
cp "$GOLDEN/compose.project.yml" "$PKG/deploy/compose.project.yml"
seal
run depcompose
refuse_case depcompose "в пакете deploy/compose.project.yml"
assert "файл deploy: сообщение называет файл" "out_has depcompose 'deploy/compose.project.yml'"
reset_pkg
mkdir -p "$PKG/deploy/platform"
echo "PLATFORM_PACKAGES_VERSION=1.1.6" >"$PKG/deploy/platform/PLATFORM-VERSION"
seal
run depplatform
refuse_case depplatform "в пакете deploy/platform/PLATFORM-VERSION"
reset_pkg
mkdir -p "$PKG/deploy"
cp "$PKG/images.lock" "$PKG/deploy/images.lock"
seal
run deplock
refuse_case deplock "в пакете deploy/images.lock (даже lock внутри deploy/)"
reset_pkg
mkdir -p "$PKG/deploy"
echo "x" >"$PKG/deploy/.env"
seal
run depenv
refuse_case depenv "в пакете deploy/.env"
reset_pkg
mkdir -p "$PKG/deploy"
cp "$GOLDEN/compose.yml" "$PKG/deploy/compose.yml"
seal
run depcomposeyml
refuse_case depcomposeyml "в пакете deploy/compose.yml"
reset_pkg
mkdir -p "$PKG/deploy/platform"
seal
run depempty --preflight-only
assert "пустой каталог deploy/ (без файлов) отказом не считается: preflight код 0" "[[ $RC -eq 0 ]]"
reset_stand
mkdir -p "$PKG/db"
seal
run withdb
refuse_case withdb "в патче есть db"

# Повторный запуск: lock боя уже равен lock пакета (или уже целевой версии) - код 3.
reset_stand
cp "$PKG/images.lock" "$LIVE/images.lock"
T1="$(tree_snapshot)"
run lockequal
assert "lock боя = lock пакета - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "lock боя = lock пакета: бой не тронут" \
  "no_mutation lockequal && [[ \"\$(tree_snapshot)\" == \"\$T1\" ]]"
assert "lock боя = lock пакета: сообщение «уже применён»" "out_has lockequal 'уже применён'"
reset_stand
sed -i "s|^BAI_VERSION=.*|BAI_VERSION=$VER_TO|" "$LIVE/images.lock"
T1="$(tree_snapshot)"
run lockverto
assert "версия lock боя уже $VER_TO - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "версия lock боя уже целевая: сообщение «уже применён»" "out_has lockverto 'уже применён'"

# Предусловия боя и хоста.
reset_stand
rm -f "$LIVE/.cutover-deployed"
T1="$(tree_snapshot)"
run nomark
assert "дерево создано не cutover.sh - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
cp "$GOLDEN/.cutover-deployed" "$LIVE/.cutover-deployed"
STUB_CONFIG_RC=1 run badconfig
refuse_case badconfig "compose config не принял новый lock"
STUB_CFG_PPTX=false run cfgpptx
refuse_case cfgpptx "в конфигурации DOCUMENTS_EDIT_PPTX=false (значение из .env)"
assert "флаг false в конфигурации: сообщение называет флаг" "out_has cfgpptx 'DOCUMENTS_EDIT_PPTX'"
STUB_CFG_FALLBACK=true run cfgfallback
refuse_case cfgfallback "в конфигурации DOCUMENTS_EDIT_PDF_FALLBACK_FONT=true"
assert "флаг шрифта в конфигурации: сообщение называет флаг" \
  "out_has cfgfallback 'DOCUMENTS_EDIT_PDF_FALLBACK_FONT'"
STUB_CFG_NO_YANDEX=1 run cfgnoyandex
refuse_case cfgnoyandex "новая конфигурация app теряет переменные Яндекса"
reset_stand
sed -i '/DOCUMENTS_EDIT_PPTX/d' "$LIVE/compose.project.yml"
T1="$(tree_snapshot)"
run cfgnoflags
assert "в compose боя нет флагов documents: код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "в compose боя нет флагов: бой не тронут" \
  "no_mutation cfgnoflags && [[ \"\$(tree_snapshot)\" == \"\$T1\" ]]"
assert "в compose боя нет флагов: сообщение называет флаг" \
  "out_has cfgnoflags 'DOCUMENTS_EDIT_PPTX'"
reset_stand
STUB_NO_READY=1 run noready
refuse_case noready "бой нездоров (/ready)"
STUB_BOTS=1 run fewbots --expected-bots 4
refuse_case fewbots "ботов меньше ожидаемого"
T_MIN_DISK=999999999 run lowdisk
refuse_case lowdisk "мало места на диске"
printf 'sha256:%s\n' "$H_OLD_APP" >"$STUB/missing"
run norollbackapp
refuse_case norollbackapp "прежнего образа app нет на хосте"
assert "откатный образ app: сообщение" "out_has norollbackapp 'прежнего образа APP'"
printf 'sha256:%s\n' "$H_OLD_DOCS" >"$STUB/missing"
run norollbackdocs
refuse_case norollbackdocs "прежнего образа documents нет на хосте"
assert "откатный образ documents: сообщение" "out_has norollbackdocs 'прежнего образа DOCUMENTS'"
: >"$STUB/missing"

# 2. --preflight-only: код 0, ничего не менялось.
run preflight --preflight-only
assert "--preflight-only - код 0" "[[ $RC -eq 0 ]]"
assert "--preflight-only: бой не тронут" "no_mutation preflight"
assert "--preflight-only: дерево боя побайтно прежнее" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "--preflight-only: documents и app на прежних образах" "app_is_old && docs_is_old"
assert "--preflight-only: бэкап не создан" "! compgen -G '$TMP/home-preflight/backups/*'"
assert "--preflight-only: проба amend не выполнялась" "[[ \$(amend_probe_count preflight) -eq 0 ]]"
assert "--preflight-only: PREFLIGHT_OK в состоянии" \
  "grep -rq 'RESULT=PREFLIGHT_OK' '$TMP'/home-preflight/.pragmatika-cutover/patch-8y-*/state.env"
assert "--preflight-only: журнал называет G8x применённым" \
  "out_has preflight 'патч G8x применён: ok'"
assert "--preflight-only: журнал называет флаги documents" \
  "out_has preflight 'DOCUMENTS_EDIT_PPTX=true'"

# Образы не на хосте: preflight делает docker pull по digest (оба образа).
reset_stand
printf '%s\n%s\n' "$H_NEW_APP" "$H_NEW_DOCS" >"$STUB/missing"
run pullimages --preflight-only
assert "образов нет на хосте: docker pull app по digest, код 0" \
  "[[ $RC -eq 0 ]] && grep -q '^pull r/app@sha256:$H_NEW_APP' '$TMP/docker-pullimages.log'"
assert "образов нет на хосте: docker pull documents по digest" \
  "grep -q '^pull r/pragmatika-documents@sha256:$H_NEW_DOCS' '$TMP/docker-pullimages.log'"
reset_stand
echo "$H_NEW_DOCS" >"$STUB/missing"
echo "tar" >"$TMP/images.tar"
run loadimages --preflight-only --images-tar "$TMP/images.tar"
assert "--images-tar: docker load выполнен" \
  "grep -q '^load -i $TMP/images.tar' '$TMP/docker-loadimages.log'"

# 3. Успех: заменён только images.lock, пересозданы documents, затем app; остальное не тронуто.
reset_stand
run apply
assert "успех: код 0" "[[ $RC -eq 0 ]]"
assert "успех: lock боя равен lock пакета (образы app и documents новые)" \
  "cmp -s '$LIVE/images.lock' '$PKG/images.lock' \
   && grep -q '$NEW_APP' '$LIVE/images.lock' && grep -q '$NEW_DOCS' '$LIVE/images.lock'"
assert "успех: BAI_VERSION боя $VER_TO" "grep -qx 'BAI_VERSION=$VER_TO' '$LIVE/images.lock'"
assert "успех: основы app и documents в lock прежние" \
  "grep -q 'BAI_IMAGE_APP_BASE=r/app-base@sha256:$H_BASE' '$LIVE/images.lock' \
   && grep -q 'BAI_IMAGE_DOCUMENTS_BASE=r/bai-documents@sha256:$H_DBASE' '$LIVE/images.lock'"
assert "успех: все файлы дерева, кроме images.lock, побайтно прежние" \
  "[[ \"\$(tree_without_lock)\" == \"\$W0\" ]]"
assert "успех: PLATFORM-VERSION прежняя (1.1.6)" "grep -q '1.1.6' '$LIVE/platform/PLATFORM-VERSION'"
assert "успех: права .env прежние (600)" "[[ \$(stat -c %a '$LIVE/.env') == 600 ]]"
assert "успех: бэкап deploy с прежним lock" \
  "grep -q '$OLD_APP' '$TMP'/home-apply/backups/pragmatika-patch8y-*/deploy/images.lock"
assert "успех: бэкап хранит .env с правами 600" \
  "[[ \$(stat -c %a '$TMP'/home-apply/backups/pragmatika-patch8y-*/deploy/.env) == 600 ]]"
assert "успех: в бэкапе снимок контейнеров и образов (documents и app)" \
  "grep -q 'p-documents-1' '$TMP'/home-apply/backups/pragmatika-patch8y-*/containers-before.tsv \
   && grep -q 'p-app-1' '$TMP'/home-apply/backups/pragmatika-patch8y-*/containers-before.tsv"
assert "успех: documents пересоздан ровно один раз" "[[ \$(docs_up_count apply) -eq 1 ]]"
assert "успех: app пересоздан ровно один раз" "[[ \$(app_up_count apply) -eq 1 ]]"
assert "успех: сначала documents, затем app" \
  "(( \$(up_line apply documents) < \$(up_line apply app) ))"
assert "успех: compose up только для documents и app (--no-deps)" "! other_up apply | grep -q ."
assert "успех: БЕЗ down, --remove-orphans, --force-recreate" \
  "! grep -E ' (down|--remove-orphans|--force-recreate)( |\$)' '$TMP/docker-apply.log'"
assert "успех: ни stop, ни rm, ни образы не трогались" \
  "! grep -E '^(stop|rm|rmi|image rm|tag|kill|restart) ' '$TMP/docker-apply.log'"
assert "успех: documents на новом образе, app на новом образе" "docs_is_new && app_is_new"
assert "успех: в окружении documents четыре флага G8x остались" \
  "grep -qx 'DOCUMENTS_EDIT_PPTX=true' '$STUB/env/p-documents-1' \
   && grep -qx 'DOCUMENTS_EDIT_PDF=true' '$STUB/env/p-documents-1' \
   && grep -qx 'DOCUMENTS_PPT_CONVERT=true' '$STUB/env/p-documents-1' \
   && grep -qx 'DOCUMENTS_EDIT_PDF_FALLBACK_FONT=false' '$STUB/env/p-documents-1'"
assert "успех: журнал называет флаги со значениями" \
  "out_has apply 'DOCUMENTS_EDIT_PDF_FALLBACK_FONT=false' \
   && out_has apply 'DOCUMENTS_EDIT_PPTX=true'"
assert "успех: переменные Яндекса у app на месте" \
  "grep -qx 'YANDEX_SEARCH_MAX_CONCURRENCY=1' '$STUB/env/p-app-1' \
   && grep -qx 'YANDEX_SEARCH_MIN_INTERVAL_MS=1200' '$STUB/env/p-app-1'"
assert "успех: ни одного docker exec (внутри контейнеров проверять нечего)" \
  "! grep -q '^exec ' '$TMP/docker-apply.log'"
assert "успех: проба /docx/amend выполнена после documents и после app" \
  "[[ \$(amend_probe_count apply) -eq 2 ]] && out_has apply 'проба /docx/amend: ok'"
assert "успех: проба несёт новые параметры number_edit и party" \
  "grep -q 'PATCH_AMEND_BODY={\"file_name\":\"probe.docx\",\"content_base64\":\"\",\
\"party\":\"zz\",\"number_edit\":{\"mode\":\"zz\",\"text\":\"1\"}}' '$TMP/docker-apply.log'"
assert "успех: журнал пробы - только статус и код ошибки" \
  "out_has apply 'documents ответил 422 bad_request'"
assert "успех: documents и app в images-running.tsv совпали с lock" \
  "[[ \$(cat '$TMP'/home-apply/.pragmatika-cutover/patch-8y-2*/results/images-running.tsv \
     | grep -c 'совпал') -ge 2 ]]"
assert "успех: архив patch8y-<время>.tgz создан" \
  "compgen -G '$TMP/home-apply/patch8y-*.tgz' >/dev/null"
mkdir -p "$TMP/arch"
tar -C "$TMP/arch" -xzf "$(compgen -G "$TMP/home-apply/patch8y-*.tgz" | head -1)"
assert "успех: в архиве журнал и проверки" \
  "[[ -f '$TMP/arch/results/cutover.log' && -f '$TMP/arch/results/checks.tsv' ]]"
assert "успех: окружение app (секрет) не попало в журнал, вывод и архив" \
  "! grep -rq '$APP_ENV_SECRET' '$TMP/out-apply' '$TMP/arch' '$TMP/home-apply'"
assert "успех: секреты из файлов не попали в вывод и архив" \
  "! grep -rq '$FILE_SECRET' '$TMP/out-apply' '$TMP/arch'"

# 4. Повторный запуск того же патча: lock боя уже новый - код 3 с понятным текстом, без изменений.
T1="$(tree_snapshot)"
run again
assert "повтор того же патча - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "повтор: сообщение «уже применён» и «ничего не меняет»" \
  "out_has again 'уже применён' && out_has again 'ничего не меняет'"
assert "повтор: ни documents, ни app не пересоздавались" \
  "[[ \$(app_up_count again) -eq 0 && \$(docs_up_count again) -eq 0 ]]"
assert "повтор: бой не тронут, дерево прежнее" \
  "no_mutation again && [[ \"\$(tree_snapshot)\" == \"\$T1\" ]]"

# 5. Сбои после замены: автооткат, lock из бэкапа побайтно, оба контейнера на образах G8x.
# rollback_case <имя> <описание>: после сбоя проверяется одинаковый набор признаков отката.
rollback_case() {
  assert "$2: код 1 (откат выполнен)" "[[ $RC -eq $EXIT_FAILED ]]"
  assert "$2: автоматический откат запущен" "out_has $1 'автоматический откат'"
  assert "$2: дерево боя побайтно прежнее" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
  assert "$2: documents и app на прежних образах, откат без down" \
    "app_is_old && docs_is_old && ! grep -E ' (down|--remove-orphans)( |\$)' '$TMP/docker-$1.log'"
  assert "$2: откат только через up --no-deps documents и app" "! other_up $1 | grep -q ."
  assert "$2: ОТКАТ ПАТЧА ВЫПОЛНЕН в журнале" "out_has $1 'ОТКАТ ПАТЧА ВЫПОЛНЕН'"
}
# Сбой на проверках documents: app до этого не пересоздавался (только откатный up).
docs_stage_case() {
  assert "$2: app патчем не пересоздавался (один up - откатный)" "[[ \$(app_up_count $1) -eq 1 ]]"
}
reset_stand
STUB_NO_DOCS_FLAGS=1 run noflagsenv
rollback_case noflagsenv "после пересоздания в окружении documents пропали флаги G8x"
docs_stage_case noflagsenv "нет флагов"
assert "нет флагов: причина в журнале" "out_has noflagsenv 'потеряны флаги G8x'"
reset_stand
STUB_ENV_PDF=false run pdfoff
rollback_case pdfoff "DOCUMENTS_EDIT_PDF=false в окружении documents"
docs_stage_case pdfoff "флаг PDF выключен"
reset_stand
STUB_ENV_FALLBACK=true run fallbackon
rollback_case fallbackon "DOCUMENTS_EDIT_PDF_FALLBACK_FONT=true в окружении documents"
# Проба /docx/amend: старый образ (поля игнорирует) и прочие расхождения -> автооткат.
reset_stand
STUB_AMEND_OLD_BEHAVIOR=1 run amendold
rollback_case amendold "documents отвечает на amend как старый образ (поля игнорирует)"
docs_stage_case amendold "проба amend (старый образ)"
assert "старый образ: причина в журнале" \
  "out_has amendold 'проба /docx/amend: ответ 400 empty_content'"
assert "старый образ: в причине ожидаемые значения" "out_has amendold 'ожидается 422 bad_request'"
reset_stand
STUB_AMEND_CODE=200 STUB_AMEND_ERR= run amend200
rollback_case amend200 "проба amend отвечает 200"
docs_stage_case amend200 "проба amend 200"
reset_stand
STUB_AMEND_ERR=empty_file run amenderr
rollback_case amenderr "проба amend: 422, но иной код ошибки"
docs_stage_case amenderr "проба amend (код ошибки)"
reset_stand
STUB_AMEND_DOWN=1 run amenddown
rollback_case amenddown "проба amend: documents не отвечает"
docs_stage_case amenddown "проба amend (нет ответа)"
assert "нет ответа: причина в журнале" "out_has amenddown 'не отвечает'"
reset_stand
STUB_AMEND_APP_STAGE_FAIL=1 run amendapp
rollback_case amendapp "проба amend красная после пересоздания app"
assert "проба после app: documents и app успели обновиться и откатились" \
  "[[ \$(docs_up_count amendapp) -eq 2 && \$(app_up_count amendapp) -eq 2 ]]"
# Ожидаемые статус и код ошибки переопределяются окружением стенда.
reset_stand
PATCH8Y_AMEND_PROBE_STATUS=200 PATCH8Y_AMEND_PROBE_ERROR=other STUB_AMEND_CODE=200 \
  STUB_AMEND_ERR=other run amendoverride
assert "ожидаемые статус и код пробы переопределены окружением: код 0" "[[ $RC -eq 0 ]]"
assert "переопределённая проба: в журнале 200 other" "out_has amendoverride 'ответил 200 other'"
reset_stand
PATCH8Y_AMEND_PROBE_STATUS=200 STUB_AMEND_CODE=422 run amendoverride2
rollback_case amendoverride2 "переопределён только статус пробы, ответ иной"
reset_stand
STUB_DOCS_HEALTH_500=1 run docshealth
rollback_case docshealth "/health documents не 200"
docs_stage_case docshealth "/health 500"
reset_stand
STUB_DOCS_EXITED=1 run docsexited
rollback_case docsexited "documents упал после пересоздания"
docs_stage_case docsexited "documents упал"
reset_stand
STUB_DOCS_UP_FAIL=1 run docsupfail
rollback_case docsupfail "compose up documents не удался"
docs_stage_case docsupfail "up documents не удался"
reset_stand
STUB_WRONG_DOCS_IMAGE=1 run wrongdocs
rollback_case wrongdocs "запущен не тот образ documents"
docs_stage_case wrongdocs "не тот образ documents"
reset_stand
STUB_UP_FAIL=1 run upfail
rollback_case upfail "compose up app не удался (documents уже новый)"
assert "up app не удался: documents успели обновиться и откатились" \
  "[[ \$(docs_up_count upfail) -eq 2 ]]"
reset_stand
STUB_WRONG_APP_IMAGE=1 run wrongimage
rollback_case wrongimage "запущен не тот образ app"
reset_stand
STUB_READY_500=1 run ready500
rollback_case ready500 "/ready 500 на новом образе app"
assert "/ready 500: после отката /ready 200" "out_has ready500 'откат: /ready: ok'"
reset_stand
STUB_APP_LOSE_YANDEX=1 run loseyandex
rollback_case loseyandex "после пересоздания в app пропали переменные Яндекса"
assert "пропали переменные: причина в журнале" "out_has loseyandex 'пропали переменные G8w'"
reset_stand
STUB_DOCS_RESTART=1 run docsrestart
rollback_case docsrestart "documents перезапущен при пересоздании app"
assert "перезапуск documents: причина в журнале" \
  "out_has docsrestart 'перезапускался при пересоздании'"
reset_stand
printf '1\n' >"$TMP/rc-stack"
STUB_ROUTES_RC_FILE="$TMP/rc-stack" run routesfail
rollback_case routesfail "маршруты стека красные"
reset_stand
STUB_RESTART_LOOP=1 run soakapp
rollback_case soakapp "app перезапускается во время выдержки"
assert "выдержка (app): причина в журнале" "out_has soakapp 'во время выдержки'"
reset_stand
STUB_DOCS_RESTART_LOOP=1 run soakdocs
rollback_case soakdocs "documents перезапускается во время выдержки"
assert "выдержка (documents): причина в журнале" "out_has soakdocs 'во время выдержки'"

# 6. Откат не удался: стенд не приходит в /ready - код 4, файлы всё равно возвращены.
reset_stand
STUB_STUCK=1 run stuck
assert "откат не удался (/ready не отвечает): код 4" "[[ $RC -eq $EXIT_STUCK ]]"
assert "откат не удался: файлы дерева возвращены побайтно" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "откат не удался: сообщение о ручном вмешательстве" "out_has stuck 'ОТКАТ НЕ УДАЛСЯ'"

# 7. Ручной откат: patch.sh --rollback по каталогу успешного запуска возвращает дерево.
reset_stand
run manual_apply
assert "ручной откат: исходный запуск успешен" "[[ $RC -eq 0 ]]"
rundir="$(readlink -f "$TMP/home-manual_apply/.pragmatika-cutover/patch-8y-latest")"
run manual_rollback --rollback --run-dir "$rundir"
assert "ручной откат - код 0" "[[ $RC -eq 0 ]]"
assert "ручной откат: дерево побайтно прежнее" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "ручной откат: documents и app на образах G8x" "app_is_old && docs_is_old"
assert "ручной откат: флаги documents на месте" \
  "grep -qx 'DOCUMENTS_EDIT_PPTX=true' '$STUB/env/p-documents-1'"
assert "ручной откат: только up --no-deps documents и app" \
  "! other_up manual_rollback | grep -q ."
assert "ручной откат: сначала documents, затем app" \
  "(( \$(up_line manual_rollback documents) < \$(up_line manual_rollback app) ))"
assert "ручной откат: БЕЗ down и --remove-orphans" \
  "! grep -E ' (down|--remove-orphans)( |\$)' '$TMP/docker-manual_rollback.log'"
# Без --run-dir берётся последний запуск (patch-8y-latest) из того же HOME.
reset_stand
run latest_apply
assert "откат по умолчанию: исходный запуск успешен" "[[ $RC -eq 0 ]]"
T_HOME=latest_apply run latest_rollback --rollback
assert "--rollback без --run-dir - код 0 (последний запуск)" "[[ $RC -eq 0 ]]"
assert "--rollback без --run-dir: дерево прежнее" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
# Откат по каталогу без бэкапа невозможен.
mkdir -p "$TMP/empty-run"
reset_stand
run norun --rollback --run-dir "$TMP/empty-run"
assert "--rollback по каталогу без бэкапа - код 4" "[[ $RC -eq $EXIT_STUCK ]]"

# 8. Неверный вызов.
run badargs --preflight-only --rollback
assert "--preflight-only и --rollback вместе - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run unknownarg --nonsense
assert "неизвестный аргумент - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run badsoak --soak-seconds abc
assert "--soak-seconds не число - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run badbots --expected-bots x
assert "--expected-bots не число - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run nodir --rollback --run-dir "$TMP/нет-такого"
assert "--rollback по несуществующему каталогу - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run helpout --help
assert "--help - код 0 и описание G8y" "[[ $RC -eq 0 ]] && out_has helpout 'G8y'"
assert "неверный вызов: бой не тронут" "no_mutation badargs && no_mutation unknownarg"

# 9. Настоящий JS пробы /docx/amend (нужен bun) против локального сервера: разбирается только
# detail.error, тело ответа в журнал не попадает.
cat >"$TMP/amend-server.py" <<'PY'
import http.server
import sys

port_file, status, body_file, seen_file = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        size = int(self.headers.get("content-length") or 0)
        with open(seen_file, "ab") as seen:
            seen.write(self.path.encode() + b" " + self.rfile.read(size) + b"\n")
        out = open(body_file, "rb").read()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args: object) -> None:
        return


server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
open(port_file, "w").write(str(server.server_address[1]))
server.serve_forever()
PY
# start_server <статус> <файл тела>: запускает сервер, адрес в REAL_URL, журнал запросов SEEN.
start_server() {
  [[ -z "$SERVER_PID" ]] || { kill "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""; }
  local waited=0
  rm -f "$TMP/server.port" "$TMP/server.seen"
  python3 -I "$TMP/amend-server.py" "$TMP/server.port" "$1" "$2" "$TMP/server.seen" &
  SERVER_PID=$!
  while [[ ! -s "$TMP/server.port" ]] && ((waited < SERVER_WAIT_S * 10)); do
    sleep 0.1
    waited=$((waited + 1))
  done
  REAL_URL="http://127.0.0.1:$(cat "$TMP/server.port")"
}
if command -v bun >/dev/null 2>&1; then
  printf '{"detail":{"error":"bad_request","message":"%s"}}' "$BODY_MARK" >"$TMP/body-ok.json"
  start_server 422 "$TMP/body-ok.json"
  reset_stand
  STUB_REAL_JS_URL="$REAL_URL" run realok
  assert "настоящий JS пробы: ответ 422 bad_request - успех, код 0" "[[ $RC -eq 0 ]]"
  assert "настоящий JS пробы: сервер получил POST /docx/amend с новыми полями" \
    "grep -q '^/docx/amend .*\"party\":\"zz\".*\"number_edit\"' '$TMP/server.seen'"
  assert "настоящий JS пробы: тело ответа не попало в вывод, журнал и архив" \
    "! grep -rq '$BODY_MARK' '$TMP/out-realok' '$TMP/home-realok'"
  assert "настоящий JS пробы: в журнале статус и код ошибки" \
    "out_has realok 'documents ответил 422 bad_request'"
  printf '{"detail":"%s"}' "$BODY_MARK" >"$TMP/body-str.json"
  start_server 422 "$TMP/body-str.json"
  reset_stand
  STUB_REAL_JS_URL="$REAL_URL" run realstr
  rollback_case realstr "настоящий JS: detail строкой (кода ошибки нет)"
  assert "настоящий JS: строка detail не напечатана" "! grep -rq '$BODY_MARK' '$TMP/out-realstr'"
  printf '{"detail":[{"loc":["body","party"],"msg":"%s"}]}' "$BODY_MARK" >"$TMP/body-list.json"
  start_server 422 "$TMP/body-list.json"
  reset_stand
  STUB_REAL_JS_URL="$REAL_URL" run reallist
  rollback_case reallist "настоящий JS: ответ 422 валидации pydantic (detail списком)"
  assert "настоящий JS: список detail не напечатан" "! grep -rq '$BODY_MARK' '$TMP/out-reallist'"
  printf '{"detail":{"error":"Bad Request %s"}}' "$BODY_MARK" >"$TMP/body-weird.json"
  start_server 422 "$TMP/body-weird.json"
  reset_stand
  STUB_REAL_JS_URL="$REAL_URL" run realweird
  rollback_case realweird "настоящий JS: код ошибки не похож на идентификатор"
  assert "настоящий JS: неидентификатор не напечатан" "! grep -rq '$BODY_MARK' '$TMP/out-realweird'"
  printf '{"ok":true}' >"$TMP/body-200.json"
  start_server 200 "$TMP/body-200.json"
  reset_stand
  STUB_REAL_JS_URL="$REAL_URL" run real200
  rollback_case real200 "настоящий JS: старый образ отвечает 200 на новые поля"
  [[ -z "$SERVER_PID" ]] || { kill "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""; }
else
  echo "SKIP настоящий JS пробы: нет bun"
fi

# 10. Стиль и безопасность сценария.
PS="$SRC/patch.sh"
assert "строки patch.sh до $LIMIT знаков" \
  "! LC_ALL=C.UTF-8 awk 'length > $LIMIT' '$PS' | grep -q ."
assert "строки теста до $LIMIT знаков" "! LC_ALL=C.UTF-8 awk 'length > $LIMIT' '$0' | grep -q ."
assert "patch.sh: set -euo pipefail" "grep -q '^set -euo pipefail' '$PS'"
assert "patch.sh: bash -n проходит" "bash -n '$PS'"
assert "в patch.sh нет sudo и curl|sh" \
  "! grep -nE 'curl[^|]*\\| *(ba)?sh|^[^#]*\\bsudo\\b' '$PS'"
assert "patch.sh не трогает БД и миграции (нет migrate, psql, pg_dump)" \
  "! grep -vE '^[[:space:]]*#' '$PS' | grep -qE 'migrate|psql|pg_dump'"
assert "patch.sh не удаляет образы и контейнеры (нет rmi, image rm, down, stop, rm -f docker)" \
  "! grep -vE '^[[:space:]]*#' '$PS' \
   | grep -qE 'docker (rmi|image rm|rm|stop|kill)|compose.* down|dc_new down'"
assert "patch.sh: нет --remove-orphans и --force-recreate вне комментариев" \
  "! grep -vE '^[[:space:]]*#' '$PS' | grep -qE -- '--remove-orphans|--force-recreate'"
assert "patch.sh: rm только с литеральным путём или \${VAR:?} (нет масок)" \
  "! grep -vE '^[[:space:]]*#' '$PS' | grep -E '\\brm\\b' | grep -qE '[*?]|/\\$'"
assert "patch.sh: нет интерактива (read без -r из stdin, select)" \
  "! grep -vE '^[[:space:]]*#' '$PS' | grep -qE '^[[:space:]]*(select|read -p)'"
assert "patch.sh: нет docker exec (G8y ничего не проверяет внутри контейнеров)" \
  "! grep -vE '^[[:space:]]*#' '$PS' | grep -q 'docker exec'"
assert "patch.sh: окружение контейнера читается только в container_env_value (один раз)" \
  "[[ \$(grep -vE '^[[:space:]]*#' '$PS' | grep -c 'Config.Env') -eq 1 ]]"
assert "patch.sh: окружение читается через фильтр одного ключа (sed -n)" \
  "sed -n '/^container_env_value()/,/^}/p' '$PS' | grep -q 'sed -n'"
assert "patch.sh: PATCH_FILE_ALLOW пуст (из файлов дерева меняется только images.lock)" \
  "[[ \"\$(grep -m1 '^PATCH_FILE_ALLOW=(' '$PS')\" == 'PATCH_FILE_ALLOW=()' ]]"
assert "patch.sh: ключи lock - ровно BAI_VERSION, BAI_IMAGE_APP, BAI_IMAGE_DOCUMENTS" \
  "[[ \"\$(grep -m1 '^PATCH_LOCK_KEYS=' '$PS')\" == \
     'PATCH_LOCK_KEYS=\"BAI_VERSION BAI_IMAGE_APP BAI_IMAGE_DOCUMENTS\"' ]]"
assert "patch.sh: ожидаемые статус и код пробы amend - константы с переопределением" \
  "grep -q 'AMEND_PROBE_STATUS=\"\${PATCH8Y_AMEND_PROBE_STATUS:-422}\"' '$PS' \
   && grep -q 'AMEND_PROBE_ERROR=\"\${PATCH8Y_AMEND_PROBE_ERROR:-bad_request}\"' '$PS'"
assert "patch.sh: нет предмета G8x (pypdf, Impress, /edit-cells) и префиксов G8x" \
  "! grep -qiE 'pypdf|impress|edit-cells|PATCH8X|patch-8x|patch8x' '$PS'"
assert "patch.sh: префиксы G8y (бэкап, архив, запуск)" \
  "grep -q 'BACKUP_PREFIX=\"pragmatika-patch8y\"' '$PS' \
   && grep -q 'ARCHIVE_PREFIX=\"patch8y\"' '$PS' && grep -q 'RUN_PREFIX=\"patch-8y\"' '$PS'"

echo "проверок: $((PASS + FAIL)), провалено: $FAIL"
[[ "$FAIL" -eq 0 ]]
