#!/usr/bin/env bash
# Тест deploy/patch-8w/patch.sh (патч G8w: образ app 1.1.4 и две переменные Яндекс-поиска) без
# настоящего Docker: вместо docker - заглушка с памятью о контейнерах, их образах, окружении и
# времени старта. Проверяются отказы по предусловиям (бой не тронут, код 3), в том числе «патч G8
# не применён», --preflight-only (дерево побайтно прежнее), успешный ход (app пересоздан, documents
# не тронут, переменные на месте), сбои с автооткатом (код 1, дерево побайтно прежнее), невозможный
# откат (код 4), ручной --rollback и стиль. Ход на настоящем Docker проверяет
# tools/patch-8w-synth.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$ROOT/deploy/patch-8w"
TMP="${PATCH8W_TEST_TMP:-$(mktemp -d)}"
# PATCH8W_TEST_KEEP=1 оставляет рабочий каталог теста (выводы и журналы запусков) для разбора.
trap '[[ -n "${PATCH8W_TEST_KEEP:-}" ]] || rm -rf "${TMP:?}"' EXIT
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
H_DOCS="5555555555555555555555555555555555555555555555555555555555555555"
H_OLD_DOCS="6666666666666666666666666666666666666666666666666666666666666666"
H_ALLOY="7777777777777777777777777777777777777777777777777777777777777777"
H_ALLOY2="8888888888888888888888888888888888888888888888888888888888888888"
H_MASK="9999999999999999999999999999999999999999999999999999999999999999"
# Секрет только в окружении контейнера app (короче порога маскирования журнала): если он попал в
# журнал или архив, значит, патч печатает окружение целиком.
APP_ENV_SECRET="TOPSEC1"
FILE_SECRET="live-secret-token-0123456789"
# Изменяющие команды docker: при отказе не должна появиться ни одна (одноразовые пробы без сети
# и пробы /ready в сети app допустимы: они ничего не меняют).
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
  printf '2026-11-18T10:00:%02dZ\n' "$n" >"$STUB/started/$1"
}
case "$1" in
  compose)
    lock="$(printf '%s\n' "$@" | grep -m1 'images.lock$' || true)"
    dir="$(dirname "${lock:-/nonexistent/x}")"
    case " $* " in
      *" version "*) echo "2.40.3" ;;
      *" config "*"--format json"*)
        if grep -q 'YANDEX_SEARCH_MAX_CONCURRENCY' "$dir/compose.project.yml" 2>/dev/null; then
          printf '{"services":{"app":{"environment":{"OPENAI_API_KEY":"%s",' "$APP_ENV_SECRET"
          printf '"YANDEX_SEARCH_MAX_CONCURRENCY":"1",'
          printf '"YANDEX_SEARCH_MIN_INTERVAL_MS":"%s"}},"documents":{"environment":{}}}}\n' \
            "${STUB_CFG_INTERVAL:-1000}"
        else
          printf '{"services":{"app":{"environment":{"OPENAI_API_KEY":"%s"}}}}\n' "$APP_ENV_SECRET"
        fi ;;
      *" config "*) exit "${STUB_CONFIG_RC:-0}" ;;
      *" up "*)
        touch "$STUB/started-any"
        svc="${*: -1}"
        [[ "$svc" == app ]] || exit 0
        ref="$(lock_ref "$lock" BAI_IMAGE_APP)"
        if [[ "$ref" == *"$H_NEW_APP"* ]]; then
          [[ "${STUB_UP_FAIL:-0}" != 1 ]] || { echo "compose: ошибка up" >&2; exit 1; }
          [[ "${STUB_WRONG_APP_IMAGE:-0}" != 1 ]] || ref="r/app@sha256:wrong"
        fi
        set_image p-app-1 "$ref"
        bump_started p-app-1
        grep -v '^YANDEX_' "$STUB/env/p-app-1" >"$STUB/env/p-app-1.n" || true
        if grep -q 'YANDEX_SEARCH_MAX_CONCURRENCY' "$dir/compose.project.yml" \
          && [[ "${STUB_NO_YANDEX_ENV:-0}" != 1 ]]; then
          echo "YANDEX_SEARCH_MAX_CONCURRENCY=1" >>"$STUB/env/p-app-1.n"
          echo "YANDEX_SEARCH_MIN_INTERVAL_MS=${STUB_ENV_INTERVAL:-1000}" >>"$STUB/env/p-app-1.n"
        fi
        mv "$STUB/env/p-app-1.n" "$STUB/env/p-app-1"
        [[ "${STUB_DOCS_RESTART:-0}" != 1 ]] || bump_started p-documents-1 ;;
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
        if [[ "${STUB_RESTART_LOOP:-0}" == 1 && "$name" == p-app-1 ]]; then
          n="$(cat "$STUB/restarts" 2>/dev/null || echo 0)"
          echo $((n + 1)) >"$STUB/restarts"
          echo "$n"
        else
          echo 0
        fi ;;
      *"State.Status"*) [[ -n "$img" ]] && echo running || exit 1 ;;
      *"State.Health"*) [[ -n "$img" ]] && echo healthy || echo отсутствует ;;
    esac ;;
  image)
    ref="${*: -1}"
    if [[ -s "$STUB/missing" ]] && grep -qF -f "$STUB/missing" <<<"$ref"; then exit 1; fi
    if [[ "$2" == inspect && "$*" == *"{{.Id}}"* ]]; then
      echo "sha256:id-$(printf '%s' "$ref" | tr -c 'a-z0-9' '-')"
    fi ;;
  pull)
    # Образ появился на хосте: убрать его из списка «отсутствующих».
    while IFS= read -r m; do [[ "$2" == *"$m"* ]] || echo "$m"; done <"$STUB/missing" \
      >"$STUB/missing.n"
    mv "$STUB/missing.n" "$STUB/missing" ;;
  info) echo "$TMP_DOCKER_ROOT" ;;
  stop) ;;
  rm) grep -v "^$2"$'\t' "$STUB/containers" >"$STUB/containers.n" || true
      mv "$STUB/containers.n" "$STUB/containers" ;;
  run)
    if [[ "$*" == *"bun"* ]]; then
      [[ "${STUB_NO_READY:-0}" != 1 ]] || { echo "app недоступен"; exit 1; }
      # Откат не удался: после первого up app больше не отвечает
      if [[ "${STUB_STUCK:-0}" == 1 && -e "$STUB/started-any" ]]; then
        echo "app недоступен"; exit 1
      fi
      app_img="$(grep "^p-app-1"$'\t' "$STUB/containers" | cut -f2)"
      if [[ "${STUB_READY_500:-0}" == 1 && "$app_img" == *"$H_NEW_APP"* ]]; then
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

# --- Боевое дерево (после G8), пакет и заглушки инструментов -----------------------------------
LIVE_ROOT="$TMP/opt/pragmatika-v2"
LIVE="$LIVE_ROOT/deploy"
GOLDEN="$TMP/golden"
PKG="$TMP/pkg"
PKGG="$TMP/pkg-golden"
OLD_APP="r/app@sha256:$H_OLD_APP"
NEW_APP="r/app@sha256:$H_NEW_APP"
DOCS="r/pragmatika-documents@sha256:$H_DOCS"
write_lock() { # write_lock <файл> <образ app> <основа app> <версия>
  {
    echo "BAI_VERSION=$4"
    echo "BAI_IMAGE_APP=$2"
    echo "BAI_IMAGE_APP_BASE=$3"
    echo "BAI_IMAGE_ALLOY=r/alloy@sha256:$H_ALLOY"
    echo "BAI_IMAGE_MASK=r/mask@sha256:$H_MASK"
    echo "BAI_IMAGE_DOCUMENTS=$DOCS"
    echo "BAI_IMAGE_DOCUMENTS_BASE=r/bai-documents@sha256:$H_OLD_DOCS"
  } >"$1"
}
mkdir -p "$GOLDEN/platform" "$GOLDEN/hotfix" "$PKGG/deploy/platform" "$PKGG/tools"
write_lock "$GOLDEN/images.lock" "$OLD_APP" "r/app-base@sha256:$H_OLD_BASE" "1.1.3-pragmatika.2"
write_lock "$PKGG/images.lock" "$NEW_APP" "r/app-base@sha256:$H_NEW_BASE" "1.1.4-pragmatika.1"
echo "services: {}" >"$GOLDEN/compose.yml"
echo "MARK=old" >"$GOLDEN/compat.env"
printf 'services:\n  app: {}\n' >"$GOLDEN/compose.project.yml"
printf 'services:\n  app: {}\n# base 1.1.3\n' >"$GOLDEN/platform/compose.base.yml"
echo "PLATFORM_PACKAGES_VERSION=1.1.3" >"$GOLDEN/platform/PLATFORM-VERSION"
printf 'POSTGRES_USER=pragmatika\nOPENAI_API_KEY=%s\n' "$FILE_SECRET" >"$GOLDEN/.env"
chmod 600 "$GOLDEN/.env"
echo "MASK_TOKEN=$FILE_SECRET-mask" >"$GOLDEN/secrets.mask.env"
chmod 600 "$GOLDEN/secrets.mask.env"
echo "#!/bin/true" >"$GOLDEN/hotfix/dc-v2.sh"
date -u +%FT%TZ >"$GOLDEN/.cutover-deployed"
{
  printf 'services:\n  app:\n    environment:\n'
  printf '      YANDEX_SEARCH_MAX_CONCURRENCY: ${YANDEX_SEARCH_MAX_CONCURRENCY:-1}\n'
  printf '      YANDEX_SEARCH_MIN_INTERVAL_MS: ${YANDEX_SEARCH_MIN_INTERVAL_MS:-1000}\n'
} >"$PKGG/deploy/compose.project.yml"
cp "$PKGG/deploy/compose.project.yml" "$PKGG/deploy/platform/compose.base.yml"
echo "PLATFORM_PACKAGES_VERSION=1.1.4" >"$PKGG/deploy/platform/PLATFORM-VERSION"
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
  printf 'verified_at=2026-11-18T08:00:00Z\n' >>"$1"
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

reset_stand() { # reset_stand: бой «после G8» (дерево, контейнеры, окружение), пакет как собран
  STUB="$TMP/stub"
  rm -rf "${STUB:?}" "${LIVE_ROOT:?}"
  mkdir -p "$STUB/env" "$STUB/started" "$LIVE_ROOT"
  cp -a "$GOLDEN" "$LIVE"
  printf '%s\t%s\n' "p-postgres-1" "r/postgres@sha256:pg" \
    "p-documents-1" "$DOCS" "p-alloy-1" "r/alloy@sha256:$H_ALLOY" \
    "p-app-1" "$OLD_APP" >"$STUB/containers"
  local name
  for name in p-postgres-1 p-documents-1 p-alloy-1 p-app-1; do
    echo "2026-11-17T08:00:00Z" >"$STUB/started/$name"
    echo "PATH=/usr/bin" >"$STUB/env/$name"
  done
  printf 'DOCUMENTS_URL=http://documents:8310\nOPENAI_API_KEY=%s\n' "$APP_ENV_SECRET" \
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
    TMP_DOCKER_ROOT="$TMP" H_NEW_APP="$H_NEW_APP" APP_ENV_SECRET="$APP_ENV_SECRET" \
    CUTOVER_COSIGN="${TEST_COSIGN:-/nonexistent-cosign}" CUTOVER_NEW_DIR="$LIVE_ROOT" \
    CUTOVER_PROJECT=p CUTOVER_APP_CONTAINER=p-app-1 CUTOVER_ENV_FILE="$TMP/none.env" \
    CUTOVER_READY_WAIT_S=3 CUTOVER_POLL_S=1 CUTOVER_HEALTH_WAIT_S=3 \
    PATCH8W_MIN_DISK_MIB="${T_MIN_DISK:-1}" PATCH8W_MIN_AVAILABLE_MIB=1 PATCH8W_SOAK_POLL_S=1 \
    bash "$PKG/patch.sh" --soak-seconds 2 "$@" >"$TMP/out-$name" 2>&1 || RC=$?
}
no_mutation() { ! grep -E "$MUTATING_RE" "$TMP/docker-$1.log" | grep -qv '^compose version'; }
out_has() { grep -q -- "$2" "$TMP/out-$1"; }
app_up_count() { grep -cE '^compose .* up -d --no-deps app$' "$TMP/docker-$1.log" || true; }
other_up() { grep -E '^compose .* up ' "$TMP/docker-$1.log" | grep -vE ' up -d --no-deps app$'; }
app_is_old() { grep -q "^p-app-1"$'\t'"$OLD_APP" "$STUB/containers"; }
app_is_new() { grep -q "^p-app-1"$'\t'"$NEW_APP" "$STUB/containers"; }
docs_untouched() { [[ "$(cat "$STUB/started/p-documents-1")" == "2026-11-17T08:00:00Z" ]] \
  && grep -q "^p-documents-1"$'\t'"$DOCS" "$STUB/containers"; }
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

# Чужие ключи lock: документы, alloy.
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

# G8 не применён: три разных признака.
reset_pkg
printf '%s\t%s\n' "p-documents-router-1" "nginx@sha256:router" >>"$STUB/containers"
run g8router
refuse_case g8router "G8 не применён: есть documents-router"
assert "G8: сообщение «сначала примените патч G8»" "out_has g8router 'сначала примените патч G8'"
reset_stand
printf '%s\t%s\n' "p-documents-legacy-1" "pragmatika-documents:legacy-docx" >>"$STUB/containers"
run g8legacy
refuse_case g8legacy "G8 не применён: есть documents-legacy"
reset_stand
sed -i "s|^p-documents-1.*|p-documents-1\tr/bai-documents@sha256:$H_OLD_DOCS|" "$STUB/containers"
run g8olddocs
refuse_case g8olddocs "G8 не применён: documents на старом образе"
assert "G8 (старый documents): сообщение" "out_has g8olddocs 'сначала примените патч G8'"
reset_stand
sed -i "s|^DOCUMENTS_URL=.*|DOCUMENTS_URL=http://documents-router:8310|" "$STUB/env/p-app-1"
run g8url
refuse_case g8url "G8 не применён: app смотрит на documents-router"
assert "G8 (адрес app): сообщение" "out_has g8url 'сначала примените патч G8'"
reset_stand
sed -i "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=r/bai-documents@sha256:$H_OLD_DOCS|" \
  "$LIVE/images.lock"
T1="$(tree_snapshot)"
run g8lock
assert "G8 не применён: lock боя с другим documents - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "G8 (lock боя): бой не тронут" \
  "no_mutation g8lock && [[ \"\$(tree_snapshot)\" == \"\$T1\" ]]"

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
refuse_case foreigncompose "compose.yml в пакете (вне списка G8w)"
assert "чужой файл: сообщение называет compose.yml" "out_has foreigncompose 'compose.yml'"
reset_pkg
echo "# x" >"$PKG/deploy/compat.env"
seal
run foreigncompat
refuse_case foreigncompat "compat.env в пакете (вне списка G8w)"

# Предусловия боя и хоста.
reset_pkg
rm -f "$LIVE/.cutover-deployed"
T1="$(tree_snapshot)"
run nomark
assert "дерево создано не cutover.sh - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
cp "$GOLDEN/.cutover-deployed" "$LIVE/.cutover-deployed"
STUB_CONFIG_RC=1 run badconfig
refuse_case badconfig "compose config не принял файлы"
sed -i '/YANDEX/d' "$PKG/deploy/compose.project.yml" "$PKG/deploy/platform/compose.base.yml"
seal
run novars
refuse_case novars "в compose пакета нет переменных Яндекса"
assert "нет переменных: сообщение называет ключ" "out_has novars 'YANDEX_SEARCH_MAX_CONCURRENCY'"
reset_pkg
STUB_CFG_INTERVAL=500 run badinterval
refuse_case badinterval "compose отдаёт другое значение интервала"
STUB_NO_READY=1 run noready
refuse_case noready "бой нездоров (/ready)"
STUB_BOTS=1 run fewbots --expected-bots 4
refuse_case fewbots "ботов меньше ожидаемого"
T_MIN_DISK=999999999 run lowdisk
refuse_case lowdisk "мало места на диске"
printf 'sha256:%s\n' "$H_OLD_APP" >"$STUB/missing"
run norollbackimage
refuse_case norollbackimage "прежнего образа app нет на хосте"
assert "откатный образ: сообщение" "out_has norollbackimage 'прежнего образа app'"
: >"$STUB/missing"

# 2. --preflight-only: код 0, ничего не менялось.
run preflight --preflight-only
assert "--preflight-only - код 0" "[[ $RC -eq 0 ]]"
assert "--preflight-only: бой не тронут" "no_mutation preflight"
assert "--preflight-only: дерево боя побайтно прежнее" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "--preflight-only: app на прежнем образе, documents не тронут" \
  "app_is_old && docs_untouched"
assert "--preflight-only: бэкап не создан" "! compgen -G '$TMP/home-preflight/backups/*'"
assert "--preflight-only: PREFLIGHT_OK в состоянии" \
  "grep -rq 'RESULT=PREFLIGHT_OK' '$TMP'/home-preflight/.pragmatika-cutover/patch-8w-*/state.env"

# Образ app не на хосте: preflight делает docker pull по digest.
reset_stand
echo "$H_NEW_APP" >"$STUB/missing"
run pullapp --preflight-only
assert "образа app нет на хосте: docker pull по digest, код 0" \
  "[[ $RC -eq 0 ]] && grep -q '^pull r/app@sha256:$H_NEW_APP' '$TMP/docker-pullapp.log'"
reset_stand
echo "$H_NEW_APP" >"$STUB/missing"
echo "tar" >"$TMP/images.tar"
run loadapp --preflight-only --images-tar "$TMP/images.tar"
assert "--images-tar: docker load выполнен" \
  "grep -q '^load -i $TMP/images.tar' '$TMP/docker-loadapp.log'"

# 3. Успех: файлы заменены, пересоздан только app, documents не тронут.
reset_stand
run apply
assert "успех: код 0" "[[ $RC -eq 0 ]]"
assert "успех: lock боя новый (образ app)" "grep -q '$NEW_APP' '$LIVE/images.lock'"
assert "успех: compose.project.yml новый" \
  "grep -q 'YANDEX_SEARCH_MAX_CONCURRENCY' '$LIVE/compose.project.yml'"
assert "успех: PLATFORM-VERSION новый" "grep -q '1.1.4' '$LIVE/platform/PLATFORM-VERSION'"
assert "успех: файлы вне патча (compose.yml, .env) прежние" \
  "cmp -s '$LIVE/compose.yml' '$GOLDEN/compose.yml' && cmp -s '$LIVE/.env' '$GOLDEN/.env'"
assert "успех: права .env прежние (600)" "[[ \$(stat -c %a '$LIVE/.env') == 600 ]]"
assert "успех: бэкап deploy с прежним lock" \
  "grep -q '$OLD_APP' '$TMP'/home-apply/backups/pragmatika-patch8w-*/deploy/images.lock"
assert "успех: бэкап хранит .env с правами 600" \
  "[[ \$(stat -c %a '$TMP'/home-apply/backups/pragmatika-patch8w-*/deploy/.env) == 600 ]]"
assert "успех: в бэкапе снимок контейнеров и образов" \
  "grep -q 'p-documents-1' '$TMP'/home-apply/backups/pragmatika-patch8w-*/containers-before.tsv"
assert "успех: app пересоздан ровно один раз" "[[ \$(app_up_count apply) -eq 1 ]]"
assert "успех: compose up только для app (--no-deps)" "! other_up apply | grep -q ."
assert "успех: БЕЗ down, --remove-orphans, --force-recreate" \
  "! grep -E ' (down|--remove-orphans|--force-recreate)( |\$)' '$TMP/docker-apply.log'"
assert "успех: ни stop, ни rm, ни образы не трогались" \
  "! grep -E '^(stop|rm|rmi|image rm|tag|kill|restart) ' '$TMP/docker-apply.log'"
assert "успех: app на новом образе" "app_is_new"
assert "успех: documents не тронут (образ и StartedAt прежние)" "docs_untouched"
assert "успех: в окружении app обе переменные" \
  "grep -qx 'YANDEX_SEARCH_MAX_CONCURRENCY=1' '$STUB/env/p-app-1' \
   && grep -qx 'YANDEX_SEARCH_MIN_INTERVAL_MS=1000' '$STUB/env/p-app-1'"
assert "успех: журнал называет обе переменные со значениями" \
  "out_has apply 'YANDEX_SEARCH_MAX_CONCURRENCY=1' \
   && out_has apply 'YANDEX_SEARCH_MIN_INTERVAL_MS=1000'"
assert "успех: архив patch8w-<время>.tgz создан" \
  "compgen -G '$TMP/home-apply/patch8w-*.tgz' >/dev/null"
mkdir -p "$TMP/arch"
tar -C "$TMP/arch" -xzf "$(compgen -G "$TMP/home-apply/patch8w-*.tgz" | head -1)"
assert "успех: в архиве журнал и проверки" \
  "[[ -f '$TMP/arch/results/cutover.log' && -f '$TMP/arch/results/checks.tsv' ]]"
assert "успех: окружение app (секрет) не попало в журнал, вывод и архив" \
  "! grep -rq '$APP_ENV_SECRET' '$TMP/out-apply' '$TMP/arch' '$TMP/home-apply'"
assert "успех: секреты из файлов не попали в вывод и архив" \
  "! grep -rq '$FILE_SECRET' '$TMP/out-apply' '$TMP/arch'"

# 4. Повторный запуск того же патча: нечего применять - код 3.
run again
assert "повтор того же патча - код 3 (нечего применять)" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "повтор: сообщение «нечего применять»" "out_has again 'нечего применять'"
assert "повтор: app не пересоздавался" "[[ \$(app_up_count again) -eq 0 ]]"

# 5. Сбои после замены: автооткат, файлы из бэкапа побайтно, app на прежнем образе, код 1.
# rollback_case <имя> <описание>: после сбоя проверяется одинаковый набор признаков отката.
rollback_case() {
  assert "$2: код 1 (откат выполнен)" "[[ $RC -eq $EXIT_FAILED ]]"
  assert "$2: автоматический откат запущен" "out_has $1 'автоматический откат'"
  assert "$2: дерево боя побайтно прежнее" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
  assert "$2: app на прежнем образе, откат без down" \
    "app_is_old && ! grep -E ' (down|--remove-orphans)( |\$)' '$TMP/docker-$1.log'"
  assert "$2: откат только через up --no-deps app" "! other_up $1 | grep -q ."
}
reset_stand
STUB_NO_YANDEX_ENV=1 run noenv
rollback_case noenv "в окружении app нет переменных"
assert "нет переменных: причина в журнале" "out_has noenv 'неверные значения'"
assert "нет переменных: documents не тронут" "docs_untouched"
assert "нет переменных: откат вернул окружение (нет YANDEX)" \
  "! grep -q '^YANDEX_' '$STUB/env/p-app-1'"
reset_stand
STUB_ENV_INTERVAL=500 run badenv
rollback_case badenv "неверное значение интервала в окружении app"
reset_stand
STUB_READY_500=1 run ready500
rollback_case ready500 "/ready 500 на новом образе"
assert "/ready 500: после отката /ready 200" "out_has ready500 'откат: /ready: ok'"
reset_stand
STUB_DOCS_RESTART=1 run docsrestart
rollback_case docsrestart "documents перезапущен"
assert "documents перезапущен: причина в журнале" "out_has docsrestart 'перезапускался'"
reset_stand
STUB_WRONG_APP_IMAGE=1 run wrongimage
rollback_case wrongimage "запущен не тот образ app"
reset_stand
STUB_UP_FAIL=1 run upfail
rollback_case upfail "compose up app не удался"
reset_stand
printf '1\n' >"$TMP/rc-stack"
STUB_ROUTES_RC_FILE="$TMP/rc-stack" run routesfail
rollback_case routesfail "маршруты стека красные"
reset_stand
STUB_RESTART_LOOP=1 run soakfail
rollback_case soakfail "app перезапускается во время выдержки"
assert "выдержка: причина в журнале" "out_has soakfail 'во время выдержки'"

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
rundir="$(readlink -f "$TMP/home-manual_apply/.pragmatika-cutover/patch-8w-latest")"
run manual_rollback --rollback --run-dir "$rundir"
assert "ручной откат - код 0" "[[ $RC -eq 0 ]]"
assert "ручной откат: дерево побайтно прежнее" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "ручной откат: app на прежнем образе, documents не тронут" "app_is_old && docs_untouched"
assert "ручной откат: только up --no-deps app" "! other_up manual_rollback | grep -q ."
# Без --run-dir берётся последний запуск (patch-8w-latest) из того же HOME.
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
assert "--help - код 0 и описание G8w" "[[ $RC -eq 0 ]] && out_has helpout 'G8w'"
assert "неверный вызов: бой не тронут" "no_mutation badargs && no_mutation unknownarg"

# 9. Стиль.
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
assert "patch.sh: окружение контейнера читается только в container_env_value (один раз)" \
  "[[ \$(grep -vE '^[[:space:]]*#' '$SRC/patch.sh' | grep -c 'Config.Env') -eq 1 ]]"
assert "patch.sh: окружение читается через фильтр одного ключа (sed -n)" \
  "sed -n '/^container_env_value()/,/^}/p' '$SRC/patch.sh' | grep -q 'sed -n'"

echo "проверок: $((PASS + FAIL)), провалено: $FAIL"
[[ "$FAIL" -eq 0 ]]
