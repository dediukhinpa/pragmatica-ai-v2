#!/usr/bin/env bash
# Тест deploy/patch-8x/patch.sh (патч G8x: платформа 1.1.6, образы documents и app, правка цен в
# pptx, PDF и .ppt) без настоящего Docker: вместо docker - заглушка с памятью о контейнерах, их
# образах, окружении и времени старта (в том числе `docker exec` и пробы /health, /ready,
# /edit-cells). Проверяются отказы по предусловиям (бой не тронут, код 3), в том числе «патч G8w
# не применён», --preflight-only (дерево побайтно прежнее), успешный ход (documents, затем app;
# флаги, образы, pypdf, Impress, маршрут /edit-cells), сбои с автооткатом (код 1, дерево побайтно
# прежнее, оба контейнера на прежних образах), невозможный откат (код 4), ручной --rollback и
# стиль. Ход на настоящем Docker проверяет tools/patch-8x-synth.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$ROOT/deploy/patch-8x"
TMP="${PATCH8X_TEST_TMP:-$(mktemp -d)}"
# PATCH8X_TEST_KEEP=1 оставляет рабочий каталог теста (выводы и журналы запусков) для разбора.
trap '[[ -n "${PATCH8X_TEST_KEEP:-}" ]] || rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
EXIT_FAILED=1
EXIT_USAGE=2
EXIT_REFUSED=3
EXIT_STUCK=4
H_OLD_APP="1111111111111111111111111111111111111111111111111111111111111111"
H_NEW_APP="2222222222222222222222222222222222222222222222222222222222222222"
H_OLD_BASE="3333333333333333333333333333333333333333333333333333333333333333"
H_NEW_BASE="4444444444444444444444444444444444444444444444444444444444444444"
H_OLD_DOCS="5555555555555555555555555555555555555555555555555555555555555555"
H_NEW_DOCS="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
H_OLD_DBASE="6666666666666666666666666666666666666666666666666666666666666666"
H_NEW_DBASE="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
H_ALLOY="7777777777777777777777777777777777777777777777777777777777777777"
H_ALLOY2="8888888888888888888888888888888888888888888888888888888888888888"
H_MASK="9999999999999999999999999999999999999999999999999999999999999999"
# Секрет только в окружении контейнера app (короче порога маскирования журнала): если он попал в
# журнал или архив, значит, патч печатает окружение целиком.
APP_ENV_SECRET="TOPSEC1"
FILE_SECRET="live-secret-token-0123456789"
# Изменяющие команды docker: при отказе не должна появиться ни одна (одноразовые пробы без сети
# и пробы /ready, /health в сети app, `docker exec` на чтение допустимы: они ничего не меняют).
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
        printf '}},"documents":{"environment":{"DOCUMENTS_EDIT_ENDPOINTS":"%s"' \
          "${STUB_CFG_ENDPOINTS:-true}"
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
            if [[ "$ref" == *"$H_NEW_DOCS"* ]]; then
              [[ "${STUB_DOCS_UP_FAIL:-0}" != 1 ]] || { echo "compose: ошибка up" >&2; exit 1; }
              [[ "${STUB_WRONG_DOCS_IMAGE:-0}" != 1 ]] || ref="r/documents@sha256:wrong"
            fi
            set_image p-documents-1 "$ref"
            bump_started p-documents-1
            grep -v '^DOCUMENTS_' "$STUB/env/p-documents-1" >"$STUB/env/p-documents-1.n" || true
            if grep -q 'DOCUMENTS_EDIT_PPTX' "$dir/compose.project.yml" \
              && [[ "${STUB_NO_DOCS_FLAGS:-0}" != 1 ]]; then
              {
                echo "DOCUMENTS_EDIT_PPTX=true"
                echo "DOCUMENTS_EDIT_PDF=${STUB_ENV_PDF:-true}"
                echo "DOCUMENTS_PPT_CONVERT=true"
                echo "DOCUMENTS_EDIT_PDF_FALLBACK_FONT=${STUB_ENV_FALLBACK:-false}"
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
    # Проверки образа documents: pypdf и Impress (только чтение).
    case "$*" in
      *"import pypdf"*) exit "${STUB_PYPDF_RC:-0}" ;;
      *"libsdlo.so"*)
        [[ "${STUB_NO_IMPRESS:-0}" == 1 ]] || echo "/usr/lib/libreoffice/program/libsdlo.so" ;;
    esac ;;
  run)
    if [[ "$*" == *"bun"* ]]; then
      [[ "${STUB_NO_READY:-0}" != 1 ]] || { echo "app недоступен"; exit 1; }
      # Откат не удался: после первого up стенд больше не отвечает
      if [[ "${STUB_STUCK:-0}" == 1 && -e "$STUB/started-any" ]]; then
        echo "app недоступен"; exit 1
      fi
      case "$*" in
        *"/edit-cells"*)
          echo "${STUB_EDIT_CODE:-422}"; exit 0 ;;
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

# --- Боевое дерево (после G8w), пакет и заглушки инструментов ----------------------------------
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
mkdir -p "$GOLDEN/platform" "$GOLDEN/hotfix" "$PKGG/deploy/platform" "$PKGG/tools"
write_lock "$GOLDEN/images.lock" "$OLD_APP" "r/app-base@sha256:$H_OLD_BASE" "$OLD_DOCS" \
  "r/bai-documents@sha256:$H_OLD_DBASE" "1.1.5-pragmatika.1"
write_lock "$PKGG/images.lock" "$NEW_APP" "r/app-base@sha256:$H_NEW_BASE" "$NEW_DOCS" \
  "r/bai-documents@sha256:$H_NEW_DBASE" "1.1.6-pragmatika.1"
echo "services: {}" >"$GOLDEN/compose.yml"
echo "MARK=old" >"$GOLDEN/compat.env"
printf 'services:\n  app:\n    environment:\n%s\n' "$YANDEX_VARS" >"$GOLDEN/compose.project.yml"
printf 'services:\n  app: {}\n# base 1.1.5\n' >"$GOLDEN/platform/compose.base.yml"
echo "PLATFORM_PACKAGES_VERSION=1.1.5" >"$GOLDEN/platform/PLATFORM-VERSION"
printf 'POSTGRES_USER=pragmatika\nOPENAI_API_KEY=%s\n' "$FILE_SECRET" >"$GOLDEN/.env"
chmod 600 "$GOLDEN/.env"
echo "MASK_TOKEN=$FILE_SECRET-mask" >"$GOLDEN/secrets.mask.env"
chmod 600 "$GOLDEN/secrets.mask.env"
echo "#!/bin/true" >"$GOLDEN/hotfix/dc-v2.sh"
date -u +%FT%TZ >"$GOLDEN/.cutover-deployed"
{
  printf 'services:\n  app:\n    environment:\n%s\n  documents:\n    environment:\n' "$YANDEX_VARS"
  printf '      DOCUMENTS_EDIT_ENDPOINTS: ${DOCUMENTS_EDIT_ENDPOINTS:-true}\n'
  printf '      DOCUMENTS_EDIT_PPTX: ${DOCUMENTS_EDIT_PPTX:-true}\n'
  printf '      DOCUMENTS_EDIT_PDF: ${DOCUMENTS_EDIT_PDF:-true}\n'
  printf '      DOCUMENTS_PPT_CONVERT: ${DOCUMENTS_PPT_CONVERT:-true}\n'
  printf '      DOCUMENTS_EDIT_PDF_FALLBACK_FONT: ${DOCUMENTS_EDIT_PDF_FALLBACK_FONT:-false}\n'
} >"$PKGG/deploy/compose.project.yml"
cp "$PKGG/deploy/compose.project.yml" "$PKGG/deploy/platform/compose.base.yml"
echo "PLATFORM_PACKAGES_VERSION=1.1.6" >"$PKGG/deploy/platform/PLATFORM-VERSION"
cp "$ROOT/deploy/cutover/lib.sh" "$PKGG/lib.sh"
cp "$SRC/patch.sh" "$PKGG/patch.sh"
cp "$ROOT/tools/route-flags.tsv" "$PKGG/tools/route-flags.tsv"
printf 'documents\tPOST\t/edit-prices\troute\n' >"$PKGG/routes.tsv"
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
  printf 'verified_at=2026-11-19T08:00:00Z\n' >>"$1"
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

reset_stand() { # reset_stand: бой «после G8w» (дерево, контейнеры, окружение), пакет как собран
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
  : >"$STUB/missing"
  reset_pkg
}

# Хэши и права всех файлов боевого дерева: «побайтно прежнее» = равенство снимков.
tree_snapshot() { (cd "$LIVE" && find . -type f | sort | xargs -d '\n' sha256sum \
  && find . -type f -printf '%m %p\n' | sort); }

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
    PATCH8X_MIN_DISK_MIB="${T_MIN_DISK:-1}" PATCH8X_MIN_AVAILABLE_MIB=1 PATCH8X_SOAK_POLL_S=1 \
    bash "$PKG/patch.sh" --soak-seconds 2 "$@" >"$TMP/out-$name" 2>&1 || RC=$?
}
no_mutation() { ! grep -E "$MUTATING_RE" "$TMP/docker-$1.log" | grep -qv '^compose version'; }
out_has() { grep -q -- "$2" "$TMP/out-$1"; }
app_up_count() { grep -cE '^compose .* up -d --no-deps app$' "$TMP/docker-$1.log" || true; }
docs_up_count() { grep -cE '^compose .* up -d --no-deps documents$' "$TMP/docker-$1.log" || true; }
other_up() { grep -E '^compose .* up ' "$TMP/docker-$1.log" \
  | grep -vE ' up -d --no-deps (app|documents)$'; }
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

# Чужие ключи lock: alloy, mask.
reset_pkg
sed -i "s|^BAI_IMAGE_ALLOY=.*|BAI_IMAGE_ALLOY=r/alloy@sha256:$H_ALLOY2|" "$PKG/images.lock"
make_sigs "$PKG/signatures.txt" OK
seal
run alloylock
refuse_case alloylock "lock меняет образ alloy"
assert "alloy: сообщение называет ключ" "out_has alloylock 'BAI_IMAGE_ALLOY'"

reset_pkg
sed -i "s|^BAI_IMAGE_MASK=.*|BAI_IMAGE_MASK=r/mask@sha256:$H_ALLOY2|" "$PKG/images.lock"
make_sigs "$PKG/signatures.txt" OK
seal
run masklock
refuse_case masklock "lock меняет образ mask"

# G8w не применён: разные признаки, подсказка «сначала примените патч G8w».
reset_stand
sed -i '/^YANDEX_/d' "$STUB/env/p-app-1"
run g8wnoenv
refuse_case g8wnoenv "G8w не применён: в окружении app нет переменных Яндекса"
assert "G8w (окружение): сообщение «сначала примените патч G8w»" \
  "out_has g8wnoenv 'сначала примените патч G8w'"
assert "G8w (окружение): сообщение называет переменную" \
  "out_has g8wnoenv 'YANDEX_SEARCH_MIN_INTERVAL_MS'"
reset_stand
sed -i '/^YANDEX_SEARCH_MAX_CONCURRENCY/d' "$STUB/env/p-app-1"
run g8wonevar
refuse_case g8wonevar "G8w не применён: нет одной из двух переменных"
reset_stand
sed -i "s|^p-app-1.*|p-app-1\tr/app@sha256:other|" "$STUB/containers"
run g8wimage
refuse_case g8wimage "G8w не применён: app не на образе из lock боя"
assert "G8w (образ app): сообщение «сначала примените патч G8w»" \
  "out_has g8wimage 'сначала примените патч G8w'"
reset_stand
echo "PLATFORM_PACKAGES_VERSION=1.1.3" >"$LIVE/platform/PLATFORM-VERSION"
T1="$(tree_snapshot)"
run g8wplatform
assert "G8w не применён: платформа боя 1.1.3 - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "G8w (платформа): бой не тронут" \
  "no_mutation g8wplatform && [[ \"\$(tree_snapshot)\" == \"\$T1\" ]]"
assert "G8w (платформа): сообщение «сначала примените патч G8w»" \
  "out_has g8wplatform 'сначала примените патч G8w'"
reset_stand
sed -i "s|^p-documents-1.*|p-documents-1\tr/other-documents@sha256:other|" "$STUB/containers"
run docsother
refuse_case docsother "documents запущен не на образе из lock боя"
reset_stand
echo "PLATFORM_PACKAGES_VERSION=1.1.5" >"$PKG/deploy/platform/PLATFORM-VERSION"
seal
run pkgoldver
refuse_case pkgoldver "в пакете платформа 1.1.5, а не 1.1.6"
assert "пакет не 1.1.6: сообщение называет версию" "out_has pkgoldver '1.1.6'"

# Состав пакета: миграции, чужие файлы.
reset_stand
mkdir -p "$PKG/db"
seal
run withdb
refuse_case withdb "в патче есть db"
reset_pkg
echo "x" >"$PKG/deploy/.env"
seal
run foreignenv
refuse_case foreignenv "чужой файл .env в пакете"
reset_pkg
cp "$GOLDEN/compose.yml" "$PKG/deploy/compose.yml"
seal
run foreigncompose
refuse_case foreigncompose "compose.yml в пакете (вне списка G8x)"
assert "чужой файл: сообщение называет compose.yml" "out_has foreigncompose 'compose.yml'"
reset_pkg
echo "# x" >"$PKG/deploy/compat.env"
seal
run foreigncompat
refuse_case foreigncompat "compat.env в пакете (вне списка G8x)"

# Предусловия боя и хоста.
reset_pkg
rm -f "$LIVE/.cutover-deployed"
T1="$(tree_snapshot)"
run nomark
assert "дерево создано не cutover.sh - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
cp "$GOLDEN/.cutover-deployed" "$LIVE/.cutover-deployed"
STUB_CONFIG_RC=1 run badconfig
refuse_case badconfig "compose config не принял файлы"
sed -i '/DOCUMENTS_EDIT_PPTX/d' "$PKG/deploy/compose.project.yml" \
  "$PKG/deploy/platform/compose.base.yml"
seal
run noflags
refuse_case noflags "в compose пакета нет флагов правки documents"
assert "нет флагов: сообщение называет ключ" "out_has noflags 'DOCUMENTS_EDIT_PPTX'"
reset_pkg
STUB_CFG_PPTX=false run cfgpptx
refuse_case cfgpptx "в конфигурации DOCUMENTS_EDIT_PPTX=false (значение из .env)"
assert "флаг false: сообщение называет флаг" "out_has cfgpptx 'DOCUMENTS_EDIT_PPTX'"
STUB_CFG_FALLBACK=true run cfgfallback
refuse_case cfgfallback "в конфигурации DOCUMENTS_EDIT_PDF_FALLBACK_FONT=true"
assert "флаг шрифта: сообщение называет флаг" \
  "out_has cfgfallback 'DOCUMENTS_EDIT_PDF_FALLBACK_FONT'"
STUB_CFG_ENDPOINTS=false run cfgendpoints
refuse_case cfgendpoints "в конфигурации DOCUMENTS_EDIT_ENDPOINTS=false (нет маршрута правки)"
STUB_CFG_NO_YANDEX=1 run cfgnoyandex
refuse_case cfgnoyandex "новая конфигурация app теряет переменные Яндекса"
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
assert "--preflight-only: PREFLIGHT_OK в состоянии" \
  "grep -rq 'RESULT=PREFLIGHT_OK' '$TMP'/home-preflight/.pragmatika-cutover/patch-8x-*/state.env"
assert "--preflight-only: журнал называет G8w применённым" \
  "out_has preflight 'патч G8w применён: ok'"
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

# 3. Успех: файлы заменены, пересозданы documents, затем app; остальное не тронуто.
reset_stand
run apply
assert "успех: код 0" "[[ $RC -eq 0 ]]"
assert "успех: lock боя новый (образы app и documents)" \
  "grep -q '$NEW_APP' '$LIVE/images.lock' && grep -q '$NEW_DOCS' '$LIVE/images.lock'"
assert "успех: compose.project.yml новый" \
  "grep -q 'DOCUMENTS_EDIT_PPTX' '$LIVE/compose.project.yml'"
assert "успех: PLATFORM-VERSION новый" "grep -q '1.1.6' '$LIVE/platform/PLATFORM-VERSION'"
assert "успех: файлы вне патча (compose.yml, .env) прежние" \
  "cmp -s '$LIVE/compose.yml' '$GOLDEN/compose.yml' && cmp -s '$LIVE/.env' '$GOLDEN/.env'"
assert "успех: права .env прежние (600)" "[[ \$(stat -c %a '$LIVE/.env') == 600 ]]"
assert "успех: бэкап deploy с прежним lock" \
  "grep -q '$OLD_APP' '$TMP'/home-apply/backups/pragmatika-patch8x-*/deploy/images.lock"
assert "успех: бэкап хранит .env с правами 600" \
  "[[ \$(stat -c %a '$TMP'/home-apply/backups/pragmatika-patch8x-*/deploy/.env) == 600 ]]"
assert "успех: в бэкапе снимок контейнеров и образов (documents и app)" \
  "grep -q 'p-documents-1' '$TMP'/home-apply/backups/pragmatika-patch8x-*/containers-before.tsv \
   && grep -q 'p-app-1' '$TMP'/home-apply/backups/pragmatika-patch8x-*/containers-before.tsv"
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
assert "успех: в окружении documents четыре флага правки" \
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
assert "успех: проверены pypdf и Impress (docker exec, только чтение)" \
  "grep -qx 'exec p-documents-1 python -c import pypdf' '$TMP/docker-apply.log' \
   && grep -qx 'exec p-documents-1 find /usr/lib/libreoffice -name libsdlo.so' \
     '$TMP/docker-apply.log'"
assert "успех: docker exec только эти две команды" \
  "[[ \$(grep -c '^exec ' '$TMP/docker-apply.log') -eq 2 ]]"
assert "успех: маршрут /edit-cells пробовался" \
  "grep -q '/edit-cells' '$TMP/docker-apply.log' && out_has apply 'маршрут /edit-cells: ok'"
assert "успех: журнал называет Impress и pypdf" "out_has apply 'pypdf и Impress: ok'"
assert "успех: documents и app в images-running.tsv совпали с lock" \
  "[[ \$(cat '$TMP'/home-apply/.pragmatika-cutover/patch-8x-2*/results/images-running.tsv \
     | grep -c 'совпал') -ge 2 ]]"
assert "успех: архив patch8x-<время>.tgz создан" \
  "compgen -G '$TMP/home-apply/patch8x-*.tgz' >/dev/null"
mkdir -p "$TMP/arch"
tar -C "$TMP/arch" -xzf "$(compgen -G "$TMP/home-apply/patch8x-*.tgz" | head -1)"
assert "успех: в архиве журнал и проверки" \
  "[[ -f '$TMP/arch/results/cutover.log' && -f '$TMP/arch/results/checks.tsv' ]]"
assert "успех: окружение app (секрет) не попало в журнал, вывод и архив" \
  "! grep -rq '$APP_ENV_SECRET' '$TMP/out-apply' '$TMP/arch' '$TMP/home-apply'"
assert "успех: секреты из файлов не попали в вывод и архив" \
  "! grep -rq '$FILE_SECRET' '$TMP/out-apply' '$TMP/arch'"

# 4. Повторный запуск того же патча: нечего применять - код 3.
run again
assert "повтор того же патча - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "повтор: ни documents, ни app не пересоздавались" \
  "[[ \$(app_up_count again) -eq 0 && \$(docs_up_count again) -eq 0 ]]"

# 5. Сбои после замены: автооткат, файлы из бэкапа побайтно, оба контейнера на прежних образах.
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
rollback_case noflagsenv "в окружении documents нет флагов"
docs_stage_case noflagsenv "нет флагов"
assert "нет флагов: причина в журнале" "out_has noflagsenv 'неверные флаги правки'"
reset_stand
STUB_ENV_PDF=false run pdfoff
rollback_case pdfoff "DOCUMENTS_EDIT_PDF=false в окружении documents"
docs_stage_case pdfoff "флаг PDF выключен"
reset_stand
STUB_ENV_FALLBACK=true run fallbackon
rollback_case fallbackon "DOCUMENTS_EDIT_PDF_FALLBACK_FONT=true в окружении documents"
reset_stand
STUB_PYPDF_RC=1 run nopypdf
rollback_case nopypdf "в documents не импортируется pypdf"
docs_stage_case nopypdf "нет pypdf"
assert "нет pypdf: причина в журнале" "out_has nopypdf 'не импортируется pypdf'"
reset_stand
STUB_NO_IMPRESS=1 run noimpress
rollback_case noimpress "в documents нет Impress"
docs_stage_case noimpress "нет Impress"
assert "нет Impress: причина в журнале" "out_has noimpress 'нет Impress'"
reset_stand
STUB_EDIT_CODE=404 run noroute
rollback_case noroute "маршрут /edit-cells отвечает 404"
docs_stage_case noroute "нет /edit-cells"
assert "нет маршрута: причина в журнале" "out_has noroute 'маршрута /edit-cells в documents нет'"
reset_stand
STUB_EDIT_CODE=405 run route405
rollback_case route405 "маршрут /edit-cells отвечает 405"
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
rundir="$(readlink -f "$TMP/home-manual_apply/.pragmatika-cutover/patch-8x-latest")"
run manual_rollback --rollback --run-dir "$rundir"
assert "ручной откат - код 0" "[[ $RC -eq 0 ]]"
assert "ручной откат: дерево побайтно прежнее" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "ручной откат: documents и app на прежних образах" "app_is_old && docs_is_old"
assert "ручной откат: только up --no-deps documents и app" \
  "! other_up manual_rollback | grep -q ."
assert "ручной откат: сначала documents, затем app" \
  "(( \$(up_line manual_rollback documents) < \$(up_line manual_rollback app) ))"
# Без --run-dir берётся последний запуск (patch-8x-latest) из того же HOME.
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
assert "--help - код 0 и описание G8x" "[[ $RC -eq 0 ]] && out_has helpout 'G8x'"
assert "неверный вызов: бой не тронут" "no_mutation badargs && no_mutation unknownarg"

# 9. Стиль и безопасность сценария.
assert "строки patch.sh до $LIMIT знаков" \
  "! LC_ALL=C.UTF-8 awk 'length > $LIMIT' '$SRC/patch.sh' | grep -q ."
assert "строки теста до $LIMIT знаков" "! LC_ALL=C.UTF-8 awk 'length > $LIMIT' '$0' | grep -q ."
assert "patch.sh: set -euo pipefail" "grep -q '^set -euo pipefail' '$SRC/patch.sh'"
assert "patch.sh: bash -n проходит" "bash -n '$SRC/patch.sh'"
assert "в patch.sh нет sudo и curl|sh" \
  "! grep -nE 'curl[^|]*\\| *(ba)?sh|^[^#]*\\bsudo\\b' '$SRC/patch.sh'"
assert "patch.sh не трогает БД и миграции (нет migrate, psql, pg_dump)" \
  "! grep -vE '^[[:space:]]*#' '$SRC/patch.sh' | grep -qE 'migrate|psql|pg_dump'"
assert "patch.sh не удаляет образы и контейнеры (нет rmi, image rm, down, stop, rm -f docker)" \
  "! grep -vE '^[[:space:]]*#' '$SRC/patch.sh' \
   | grep -qE 'docker (rmi|image rm|rm|stop|kill)|compose.* down|dc_new down'"
assert "patch.sh: нет --remove-orphans и --force-recreate вне комментариев" \
  "! grep -vE '^[[:space:]]*#' '$SRC/patch.sh' | grep -qE -- '--remove-orphans|--force-recreate'"
assert "patch.sh: rm только с литеральным путём или \${VAR:?} (нет масок)" \
  "! grep -vE '^[[:space:]]*#' '$SRC/patch.sh' | grep -E '\\brm\\b' | grep -qE '[*?]|/\\$'"
assert "patch.sh: нет интерактива (read без -r из stdin, select)" \
  "! grep -vE '^[[:space:]]*#' '$SRC/patch.sh' | grep -qE '^[[:space:]]*(select|read -p)'"
assert "patch.sh: docker exec только на чтение (pypdf и Impress, без sh -c)" \
  "[[ \$(grep -vE '^[[:space:]]*#' '$SRC/patch.sh' | grep -c 'docker exec') -eq 2 ]] \
   && ! grep -vE '^[[:space:]]*#' '$SRC/patch.sh' | grep 'docker exec' | grep -qE 'sh -c|bash -c'"
assert "patch.sh: окружение контейнера читается только в container_env_value (один раз)" \
  "[[ \$(grep -vE '^[[:space:]]*#' '$SRC/patch.sh' | grep -c 'Config.Env') -eq 1 ]]"
assert "patch.sh: окружение читается через фильтр одного ключа (sed -n)" \
  "sed -n '/^container_env_value()/,/^}/p' '$SRC/patch.sh' | grep -q 'sed -n'"
ALLOW_LINE='PATCH_FILE_ALLOW=(compose.project.yml platform/compose.base.yml'
ALLOW_LINE+=' platform/PLATFORM-VERSION)'
assert "patch.sh: PATCH_FILE_ALLOW не шире трёх файлов G8w" \
  "[[ \"\$(grep -m1 '^PATCH_FILE_ALLOW=(' '$SRC/patch.sh')\" == '$ALLOW_LINE' ]]"

echo "проверок: $((PASS + FAIL)), провалено: $FAIL"
[[ "$FAIL" -eq 0 ]]
