#!/usr/bin/env bash
# Тест deploy/patch-9w/patch.sh (патч G9w: платформа 1.1.11 -> 1.1.12, четыре образа:
# pseudonymizer, mask, documents, app; из файлов дерева заменяются только images.lock и
# platform/PLATFORM-VERSION; том псевдонимизатора архивируется до замены) без настоящего Docker:
# вместо docker - заглушка с памятью о контейнерах, их образах, окружении, состоянии и времени
# старта; том псевдонимизатора - настоящий каталог с настоящей базой SQLite, архивы тома и их
# проверка выполняются настоящими tar и Python. Проверяются: отказы по предусловиям (бой не
# тронут, код 3), --preflight-only, --images-tar, успешный ход и порядок замены, бэкап тома,
# проверки после замены, mask не запущен, сбои на каждом шаге с автооткатом (код 1, дерево
# побайтно прежнее), невозможный откат (код 4), ручной --rollback,
# --restore-pseudonymizer-volume, проба labops-pii против локальной заглушки сервиса, отсутствие
# секретов в журнале и архиве. Ход на настоящем Docker проверяет tools/patch-9w-synth.sh.
# PATCH9W_SRC подменяет каталог со скриптом; PATCH9W_TEST_KEEP=1 оставляет рабочий каталог.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="${PATCH9W_SRC:-$ROOT/deploy/patch-9w}"
TMP="${PATCH9W_TEST_TMP:-$(mktemp -d)}"
SERVER_PID=""
cleanup() {
  [[ -z "$SERVER_PID" ]] || kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "${PATCH9W_TEST_KEEP:-}" ]] || rm -rf "${TMP:?}"
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
VOLUME_ROWS=3
VER_FROM="1.1.11-pragmatika.1"
VER_TO="1.1.12-pragmatika.1"
# Digest app и documents боя - закреплены в патче (состояние после G9q4).
H_OLD_APP="7fc173b46a41dbbd572aaf10d05f28ae828a5eaab0d2924428c342d39bcdbea8"
H_OLD_DOCS="69319c5553caf23ddc42a75d503c68117b9d545b235d25f26ed0adba521ed064"
hex() { printf "%064d" 0 | tr 0 "$1"; }
H_NEW_APP="$(hex 2)"
H_NEW_DOCS="$(hex a)"
H_OLD_PSEUDO="$(hex 3)"
H_NEW_PSEUDO="$(hex 4)"
H_OLD_MASK="$(hex 5)"
H_NEW_MASK="$(hex 6)"
H_BASE="$(hex 7)"
H_BASE_NEW="$(hex 8)"
H_OTHER="$(hex 9)"
OLD_APP="r/pragmatika-app@sha256:$H_OLD_APP"
NEW_APP="r/pragmatika-app@sha256:$H_NEW_APP"
OLD_DOCS="r/pragmatika-documents@sha256:$H_OLD_DOCS"
NEW_DOCS="r/pragmatika-documents@sha256:$H_NEW_DOCS"
OLD_PSEUDO="r/bai-pseudonymizer@sha256:$H_OLD_PSEUDO"
NEW_PSEUDO="r/bai-pseudonymizer@sha256:$H_NEW_PSEUDO"
OLD_MASK="r/bai-mask@sha256:$H_OLD_MASK"
NEW_MASK="r/bai-mask@sha256:$H_NEW_MASK"
# Выдуманные секреты и слово-исключение: ни в журнале, ни в архиве, ни в выводе их быть не должно.
SECRET_KEY="stub-fernet-key-0123456789abcdef"
SECRET_TOKEN="stub-pseudo-token-0123456789"
SECRET_WORDS="Вымышленнослов,Придуманнослов"
SECRET_MASK="stub-mask-token-0123456789"
APP_ENV_SECRET="TOPSEC1"
# Изменяющие команды docker: при отказе не должна появиться ни одна.
MUTATING_RE='^(create|rm|stop|kill|start|restart|load|pull|volume|network|compose .*(up|stop|down))'

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# --- Заглушка docker ---------------------------------------------------------------------------
# Память стенда: $STUB/containers (имя<TAB>образ), $STUB/env/<имя>, $STUB/started/<имя>,
# $STUB/status/<имя>, том - $STUB/volume; журнал вызовов - $DOCKER_LOG. Ручки сбоев - STUB_*.
BIN="$TMP/bin"
mkdir -p "$BIN"
cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" | head -1 >>"$DOCKER_LOG"
echo "${PSEUDONYMIZER_ADDRESS_MASK-<unset>} ${PII_ALLOWED_WORDS-<unset>}" \
  "${BAI_IMAGE_APP-<unset>} ${PRICES_SCAN_FLOW_ENABLED-<unset>} ${VISION_TEXT_FIRST-<unset>}" \
  "${DOCUMENTS_EDIT_PDF_TEXT-<unset>} ${MASK_TOKEN-<unset>}" >>"$STUB/shellenv.log"
lock_ref() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2-; }
image_of() { grep "^$1"$'\t' "$STUB/containers" | cut -f2 || true; }
set_image() {
  grep -v "^$1"$'\t' "$STUB/containers" >"$STUB/containers.n" || true
  printf '%s\t%s\n' "$1" "$2" >>"$STUB/containers.n"
  mv "$STUB/containers.n" "$STUB/containers"
}
bump_started() {
  local n
  n="$(cat "$STUB/counter" 2>/dev/null || echo 0)"
  echo $((n + 1)) >"$STUB/counter"
  printf '2026-11-26T10:00:%02dZ\n' "$((n + 1))" >"$STUB/started/$1"
}
new_hash() {
  case "$1" in
    app) echo "$H_NEW_APP" ;;
    documents) echo "$H_NEW_DOCS" ;;
    pseudonymizer) echo "$H_NEW_PSEUDO" ;;
    mask) echo "$H_NEW_MASK" ;;
    *) echo none ;;
  esac
}
is_new() { [[ "$(image_of "p-$1-1")" == *"$(new_hash "$1")"* ]]; }
set_env() { # set_env <имя> <ИМЯ=значение>
  grep -v "^${2%%=*}=" "$STUB/env/$1" >"$STUB/env/$1.n" || true
  echo "$2" >>"$STUB/env/$1.n"
  mv "$STUB/env/$1.n" "$STUB/env/$1"
}
id_of() { echo "sha256:id-$(printf '%s' "$1" | tr -c 'a-z0-9' '-')"; }
config_json() { # config_json <каталог deploy> <lock>
  local dir="$1" lock="$2" stage=0 root mem=1g pg=r/postgres@sha256:pg drift="${STUB_CFG:-}"
  root="$(dirname "$dir")"
  [[ "$dir" != */work/stage/deploy ]] || stage=1
  [[ "$drift" != livefail || $stage == 1 ]] || exit 1
  [[ "$drift" != stagefail || $stage == 0 ]] || exit 1
  [[ "$drift" != badjson ]] || { echo '{"services":'; return 0; }
  ((stage)) || drift=""
  [[ "$drift" != appmem ]] || mem=2g
  [[ "$drift" != other ]] || pg=r/postgres@sha256:other
  img() {
    if [[ "$drift" == "image-$2" ]]; then echo "r/x@sha256:other"; else lock_ref "$lock" "$1"; fi
  }
  base="$(lock_ref "$lock" BAI_IMAGE_APP_BASE)"
  [[ "$drift" != base ]] || base=r/base@sha256:elsewhere
  printf '{"name":"p","services":{'
  if [[ "$drift" != nosvc ]]; then
    printf '"mask":{"image":"%s"},' "$(img BAI_IMAGE_MASK mask)"
  fi
  printf '"pseudonymizer":{"image":"%s","environment":{"PSEUDONYMIZER_KEY":"%s"}},' \
    "$(img BAI_IMAGE_PSEUDONYMIZER pseudonymizer)" "$APP_ENV_SECRET"
  printf '"app":{"image":"%s","mem_limit":"%s",' "$(img BAI_IMAGE_APP app)" "$mem"
  printf '"build":{"context":"%s","args":{"BAI_APP_BASE":"%s"}},' "$root" "$base"
  printf '"volumes":[{"type":"bind","source":"%s/nginx.conf"}]},' "$dir"
  printf '"documents":{"image":"%s"},' "$(img BAI_IMAGE_DOCUMENTS documents)"
  printf '"migrate":{"volumes":[{"type":"bind","source":"%s/db/app"}]},' "$root"
  printf '"postgres":{"image":"%s"}}}\n' "$pg"
}
mount_dir() { # mount_dir <точка в контейнере> <аргументы...>: каталог хоста из -v
  local want="$1" prev="" a
  shift
  for a in "$@"; do
    if [[ "$prev" == -v ]]; then
      case "$a" in *":$want" | *":$want:ro") echo "${a%%:*}"; return 0 ;; esac
    fi
    prev="$a"
  done
}
env_arg() { printf '%s\n' "$@" | sed -n "s/^$ENV_NAME=//p" | head -1; }
case "$1" in
  compose)
    lock="$(printf '%s\n' "$@" | grep -m1 'images.lock$' || true)"
    dir="$(dirname "${lock:-/nonexistent/x}")"
    case " $* " in
      *" config "*"--format json"*) config_json "$dir" "$lock" ;;
      *" stop "*)
        svc="${*: -1}"
        [[ "${STUB_STOP_FAIL:-0}" != 1 ]] || { echo "compose: ошибка stop" >&2; exit 1; }
        [[ "${STUB_STOP_NOOP:-0}" == 1 ]] || echo exited >"$STUB/status/p-$svc-1" ;;
      *" up "*)
        svc="${*: -1}"
        name="p-$svc-1"
        touch "$STUB/started-any"
        case "$svc" in
          app) ref="$(lock_ref "$lock" BAI_IMAGE_APP)" ;;
          documents) ref="$(lock_ref "$lock" BAI_IMAGE_DOCUMENTS)" ;;
          pseudonymizer) ref="$(lock_ref "$lock" BAI_IMAGE_PSEUDONYMIZER)" ;;
          mask) ref="$(lock_ref "$lock" BAI_IMAGE_MASK)" ;;
        esac
        changed=0
        [[ "$ref" == "$(image_of "$name")" \
          && "$(cat "$STUB/status/$name" 2>/dev/null || echo running)" == running ]] || changed=1
        if [[ "$ref" == *"$(new_hash "$svc")"* ]]; then
          [[ "${STUB_UP_FAIL:-}" != "$svc" ]] || { echo "compose: ошибка up" >&2; exit 1; }
          [[ "${STUB_WRONG_IMAGE:-}" != "$svc" ]] || ref="r/wrong@sha256:wrong"
          if [[ "${STUB_SIGNAL_AT:-}" == "$svc" ]]; then
            kill "-${STUB_SIGNAL:-HUP}" "$PPID"
          fi
          set_image "$name" "$ref"
          [[ "${STUB_ENV_SET%%:*}" != "$svc" ]] || set_env "$name" "${STUB_ENV_SET#*:}"
          [[ "${STUB_ENV_DEL%%:*}" != "$svc" ]] \
            || sed -i "/^${STUB_ENV_DEL#*:}=/d" "$STUB/env/$name"
        else
          [[ "${STUB_RB_FAIL:-}" != "$svc" ]] || { echo "compose: ошибка up" >&2; exit 1; }
          set_image "$name" "$ref"
          cp "$STUB/env-golden/$name" "$STUB/env/$name"
        fi
        echo running >"$STUB/status/$name"
        ((changed == 0)) || bump_started "$name" ;;
    esac ;;
  ps)
    svc="$(printf '%s\n' "$@" | sed -n 's/^label=com.docker.compose.service=//p')"
    if [[ -n "$svc" ]]; then
      cut -f1 "$STUB/containers" | grep -x "p-$svc-1" || true
    else
      cut -f1 "$STUB/containers"
    fi ;;
  inspect)
    name="${*: -1}"
    img="$(image_of "$name")"
    [[ -n "$img" ]] || exit 1
    svc="${name#p-}"
    svc="${svc%-1}"
    status="$(cat "$STUB/status/$name" 2>/dev/null || echo running)"
    case "$*" in
      *"json .Config.Env"*)
        python3 -I -c 'import json, sys
print(json.dumps(open(sys.argv[1], encoding="utf-8").read().splitlines()))' "$STUB/env/$name" ;;
      *"range .Config.Env"*) cat "$STUB/env/$name" ;;
      *".Mounts"*) echo "${STUB_VOLUME_NAME:-p_pseudonymizer-data}" ;;
      *"State.StartedAt"*) cat "$STUB/started/$name" ;;
      *"{{.Config.Image}}"*) echo "$img" ;;
      *"{{.Image}}"*) id_of "$img" ;;
      *"RestartCount"*)
        if [[ "${STUB_RESTART_LOOP:-}" == "$svc" ]] && is_new "$svc"; then
          n="$(cat "$STUB/restarts-$name" 2>/dev/null || echo 0)"
          echo $((n + 1)) >"$STUB/restarts-$name"
          echo "$n"
        else
          echo 0
        fi ;;
      *"State.Health"*)
        if [[ "$status" != running ]]; then
          echo "$status"
        elif [[ "${STUB_UNHEALTHY:-}" == "$svc" ]] && is_new "$svc"; then
          echo unhealthy
        elif [[ "${STUB_UNHEALTHY_OLD:-}" == "$svc" ]]; then
          echo unhealthy
        elif [[ "${STUB_PSEUDO_SICK_LATE:-0}" == 1 && "$svc" == pseudonymizer ]] && is_new app; then
          echo unhealthy
        elif [[ "$svc" == mask ]]; then
          echo running
        else
          echo healthy
        fi ;;
      *"State.Status"*) echo "$status" ;;
    esac ;;
  image)
    ref="${*: -1}"
    if [[ "$*" == *"{{.Id}}"* ]]; then id_of "$ref"; exit 0; fi
    if [[ -s "$STUB/missing" ]] && grep -qF -f "$STUB/missing" <<<"$ref"; then exit 1; fi ;;
  load)
    [[ "${STUB_LOAD_FAIL:-0}" != 1 ]] || exit 1
    grep -vxF -f "$3" "$STUB/missing" >"$STUB/missing.n" || true
    mv "$STUB/missing.n" "$STUB/missing" ;;
  info) echo "$TMP_DOCKER_ROOT" ;;
  exec)
    code="${*: -1}"
    [[ -z "${STUB_PROBE_LINE:-}" ]] || { echo "$STUB_PROBE_LINE"; exit 0; }
    if [[ -n "${STUB_REAL_PY_PORT:-}" ]]; then
      PYTHONPATH="$FAKE_PII" PSEUDONYMIZER_PORT="$STUB_REAL_PY_PORT" \
        PSEUDONYMIZER_API_TOKEN="$SECRET_TOKEN" PROBE_THREAD=patch-9w-probe \
        python3 -c "$code"
      exit $?
    fi
    echo "version=1.3.0 masked=yes restored=yes" ;;
  run)
    code="${*: -1}"
    if [[ "$*" == *"--entrypoint sh "* ]]; then
      out="$(mount_dir /out "$@")"
      bk="$(mount_dir /bk "$@")"
      case "$code" in
        "du -sk"*)
          [[ "${STUB_DU_FAIL:-0}" != 1 ]] || exit 1
          printf '%s\t/data\n' "${STUB_DU_KIB:-40}" ;;
        "tar -czf /out/"*)
          file="${code#tar -czf /out/}"
          file="${file%% *}"
          [[ "${STUB_TAR_FAIL:-0}" != 1 ]] || exit 1
          [[ "${STUB_TAR_GARBAGE:-0}" != 1 ]] \
            || { echo garbage >"$out/$file"; chmod 600 "$out/$file"; exit 0; }
          tar -czf "$out/$file" -C "$STUB/volume" .
          chmod "${STUB_TAR_MODE:-600}" "$out/$file" ;;
        "find /data -mindepth 1 -delete"*)
          file="${code##*/bk/}"
          file="${file%% *}"
          find "${STUB:?}/volume" -mindepth 1 -delete
          [[ "${STUB_RESTORE_FAIL:-0}" != 1 ]] || exit 1
          tar -xzf "$bk/$file" -C "$STUB/volume" ;;
        *) echo "неизвестная программа sh" >&2; exit 97 ;;
      esac
    elif [[ "$*" == *"--entrypoint python "* ]]; then
      # Настоящая проверка архива настоящим Python.
      bk="$(mount_dir /bk "$@")"
      body=""
      prev=""
      for a in "$@"; do
        [[ "$prev" != -c ]] || body="$a"
        prev="$a"
      done
      ENV_NAME=ARCHIVE_NAME
      archive="$(env_arg "$@")"
      ENV_NAME=DB_NAME
      db="$(env_arg "$@")"
      ARCHIVE_NAME="$archive" DB_NAME="$db" python3 -I -c "${body//\/bk\//$bk\/}"
    elif [[ "$*" == *"--entrypoint bun "* ]]; then
      case "$*" in
        *"/docx/pages"*) ;;
      esac
      body="$(printf '%s\n' "$@")"
      if grep -q "base + '/docx/pages'" <<<"$body"; then
        if is_new documents && [[ -n "${STUB_PAGES_NEW:-}" ]]; then echo "$STUB_PAGES_NEW"
        else echo "${STUB_PAGES:-422 bad_request}"; fi
      elif grep -q "base + '/parse'" <<<"$body"; then
        if is_new documents && [[ -n "${STUB_PARSE_NEW:-}" ]]; then echo "$STUB_PARSE_NEW"
        else echo "${STUB_PARSE:-200 pdf 1 1}"; fi
      elif grep -q "8320/health" <<<"$body"; then
        if [[ "${STUB_MASK_DOWN_OLD:-0}" == 1 ]] \
          || { [[ "${STUB_MASK_DOWN:-0}" == 1 ]] && is_new mask; } \
          || { [[ "${STUB_MASK_DOWN_LATE:-0}" == 1 ]] && is_new app; }; then
          echo "mask недоступен: refused"; exit 1
        fi
        echo '200 {}'
      elif grep -q "base + '/health'" <<<"$body"; then
        if { [[ "${STUB_DOCS_HEALTH_500:-0}" == 1 ]] && is_new documents; } \
          || { [[ "${STUB_DOCS_HEALTH_500_LATE:-0}" == 1 ]] && is_new app; }; then
          echo '500 {}'; exit 1
        fi
        echo '200 {}'
      else
        if [[ "${STUB_STUCK:-0}" == 1 && -e "$STUB/started-any" ]] \
          || [[ "${STUB_NO_READY:-0}" == 1 ]]; then
          echo "app недоступен"; exit 1
        fi
        if [[ "${STUB_READY_500:-0}" == 1 ]] && is_new app; then
          echo '500 {"bots":{"ready":0}}'; exit 1
        fi
        bots="${STUB_BOTS:-4}"
        if is_new app; then bots="${STUB_BOTS_NEW:-$bots}"; fi
        echo "200 {\"bots\":{\"ready\":$bots}}"
      fi
    fi ;;
esac
exit 0
STUB
chmod +x "$BIN/docker"
printf '#!/usr/bin/env bash\nexit "${STUB_COSIGN_RC:-0}"\n' >"$BIN/cosign-stub"
chmod +x "$BIN/cosign-stub"

# --- Боевое дерево (после G9q4), пакет и заглушки инструментов ---------------------------------
LIVE_ROOT="$TMP/opt/pragmatika-v2"
LIVE="$LIVE_ROOT/deploy"
GOLDEN="$TMP/golden"
PKG="$TMP/pkg"
PKGG="$TMP/pkg-golden"
write_lock() { # write_lock <файл> <app> <основа app> <docs> <основа docs> <pseudo> <mask> <версия>
  {
    echo "BAI_VERSION=$8"
    echo "BAI_IMAGE_APP=$2"
    echo "BAI_IMAGE_APP_BASE=$3"
    echo "BAI_IMAGE_ALLOY=r/alloy@sha256:$H_OTHER"
    echo "BAI_IMAGE_MASK=$7"
    echo "BAI_IMAGE_DOCUMENTS=$4"
    echo "BAI_IMAGE_DOCUMENTS_BASE=$5"
    echo "BAI_IMAGE_PSEUDONYMIZER=$6"
    echo "BAI_IMAGE_SPEECH=r/speech@sha256:$H_OTHER"
  } >"$1"
}
write_platform() { # write_platform <каталог deploy> <версия> <compose.base.yml для суммы>
  mkdir -p "$1/platform"
  printf '# копия платформы\nPLATFORM_PACKAGES_VERSION=%s\nsha256 %s  compose.base.yml\n' "$2" \
    "$(sha256sum "$3" | cut -d' ' -f1)" >"$1/platform/PLATFORM-VERSION"
}
mkdir -p "$GOLDEN/platform" "$GOLDEN/hotfix" "$PKGG/tools" "$PKGG/deploy" \
  "$PKGG/reference/deploy/platform"
write_lock "$GOLDEN/images.lock" "$OLD_APP" "r/app-base@sha256:$H_BASE" "$OLD_DOCS" \
  "r/bai-documents@sha256:$H_BASE" "$OLD_PSEUDO" "$OLD_MASK" "$VER_FROM"
write_lock "$PKGG/images.lock" "$NEW_APP" "r/app-base@sha256:$H_BASE_NEW" "$NEW_DOCS" \
  "r/bai-documents@sha256:$H_BASE_NEW" "$NEW_PSEUDO" "$NEW_MASK" "$VER_TO"
echo "services: {}" >"$GOLDEN/compose.yml"
echo "MARK=compat" >"$GOLDEN/compat.env"
echo "# compose.project.yml боя" >"$GOLDEN/compose.project.yml"
echo "# compose.base.yml 1.1.11" >"$GOLDEN/platform/compose.base.yml"
write_platform "$GOLDEN" 1.1.11 "$GOLDEN/platform/compose.base.yml"
for f in compose.yml compat.env compose.project.yml platform/compose.base.yml; do
  cp "$GOLDEN/$f" "$PKGG/reference/deploy/$f"
done
write_platform "$PKGG/deploy" 1.1.12 "$GOLDEN/platform/compose.base.yml"
printf 'POSTGRES_USER=pragmatika\nPSEUDONYMIZER_KEY=%s\nPSEUDONYMIZER_API_TOKEN=%s\n' \
  "$SECRET_KEY" "$SECRET_TOKEN" >"$GOLDEN/.env"
printf 'PII_ALLOWED_WORDS=%s\n' "$SECRET_WORDS" >>"$GOLDEN/.env"
chmod 600 "$GOLDEN/.env"
echo "MASK_TOKEN=$SECRET_MASK" >"$GOLDEN/secrets.mask.env"
chmod 600 "$GOLDEN/secrets.mask.env"
echo "#!/bin/true" >"$GOLDEN/hotfix/dc-v2.sh"
date -u +%FT%TZ >"$GOLDEN/.cutover-deployed"
cp "$ROOT/deploy/cutover/lib.sh" "$PKGG/lib.sh"
cp "$SRC/patch.sh" "$PKGG/patch.sh"
cp "$ROOT/tools/route-flags.tsv" "$PKGG/tools/route-flags.tsv"
printf 'documents\tPOST\t/docx/pages\troute\n' >"$PKGG/routes.tsv"
cat >"$PKGG/tools/check-routes.sh" <<'ROUTES'
#!/usr/bin/env bash
echo "[check-routes] args: $*"
echo "[check-routes] ok"
exit "${STUB_ROUTES_RC:-0}"
ROUTES
echo "public-key" >"$PKGG/cosign.pub"
PUB_SHA="$(sha256sum "$PKGG/cosign.pub" | cut -d' ' -f1)"

make_sigs() { # make_sigs <файл> <result>: подтверждение подписей по lock пакета
  local key ref
  printf '# verify-signatures v1\nlock_sha256=%s\npubkey_sha256=%s\ncosign=v3\n' \
    "$(sha256sum "$PKG/images.lock" | cut -d' ' -f1)" "$PUB_SHA" >"$1"
  while IFS='=' read -r key ref; do
    [[ "$key" == BAI_IMAGE_* ]] || continue
    printf 'image\t%s\t%s\tOK\n' "$key" "$ref" >>"$1"
  done <"$PKG/images.lock"
  printf 'result=%s\n' "$2" >>"$1"
}
seal() { (cd "$PKG" && find . -type f ! -name MANIFEST.sha256 | sort | sed 's|^\./||' \
  | xargs -d '\n' sha256sum >MANIFEST.sha256); }
reset_pkg() {
  rm -rf "${PKG:?}"
  cp -a "$PKGG" "$PKG"
  make_sigs "$PKG/signatures.txt" OK
  seal
}
pkg_lock_edit() { # pkg_lock_edit <sed-выражение>
  sed -i "$1" "$PKG/images.lock"
  make_sigs "$PKG/signatures.txt" OK
  seal
}

make_volume() { # make_volume <каталог> <строк>
  mkdir -p "$1"
  python3 -I - "$1/pseudonymizer.sqlite3" "$2" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE IF NOT EXISTS replacements (thread_id TEXT, token TEXT)")
for index in range(int(sys.argv[2])):
    db.execute("INSERT INTO replacements VALUES (?, ?)", (f"t{index}", f"[PERSON_{index}]"))
db.commit()
db.close()
PY
}
db_rows() { # db_rows <файл базы>
  python3 -I -c 'import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
print(db.execute("SELECT COUNT(*) FROM replacements").fetchone()[0])' "$1"
}
volume_rows() { db_rows "$STUB/volume/pseudonymizer.sqlite3"; }

SERVICES=(postgres pseudonymizer mask documents app alloy)
reset_stand() { # бой «после G9q4», пакет как собран
  STUB="$TMP/stub"
  rm -rf "${STUB:?}" "${LIVE_ROOT:?}"
  mkdir -p "$STUB/env" "$STUB/env-golden" "$STUB/started" "$STUB/status" "$LIVE_ROOT"
  cp -a "$GOLDEN" "$LIVE"
  printf '%s\t%s\n' "p-postgres-1" "r/postgres@sha256:pg" "p-pseudonymizer-1" "$OLD_PSEUDO" \
    "p-mask-1" "$OLD_MASK" "p-documents-1" "$OLD_DOCS" "p-app-1" "$OLD_APP" \
    "p-alloy-1" "r/alloy@sha256:$H_OTHER" >"$STUB/containers"
  local svc
  for svc in "${SERVICES[@]}"; do
    echo "2026-11-23T08:00:00Z" >"$STUB/started/p-$svc-1"
    echo "PATH=/usr/bin" >"$STUB/env/p-$svc-1"
  done
  printf '%s\n' "PSEUDONYMIZER_KEY=$SECRET_KEY" "PSEUDONYMIZER_API_TOKEN=$SECRET_TOKEN" \
    "PII_ALLOWED_WORDS=$SECRET_WORDS" "PSEUDONYMIZER_ADDRESS_MASK=on" \
    >>"$STUB/env/p-pseudonymizer-1"
  printf '%s\n' "MEDIA_MASKER_API_TOKEN=$SECRET_MASK" "MEDIA_MASKER_ADDRESS_MASK=on" \
    >>"$STUB/env/p-mask-1"
  printf '%s\n' DOCUMENTS_EDIT_PPTX=true DOCUMENTS_EDIT_PDF=true DOCUMENTS_PPT_CONVERT=true \
    DOCUMENTS_EDIT_PDF_FALLBACK_FONT=false DOCUMENTS_EDIT_PDF_TEXT= >>"$STUB/env/p-documents-1"
  printf '%s\n' "DOCUMENTS_URL=http://documents:8310" "LITELLM_API_KEY=$APP_ENV_SECRET" \
    "PSEUDONYMIZER_API_TOKEN=$SECRET_TOKEN" PSEUDONYMIZER_URL=http://pseudonymizer:8300 \
    CHAT_ATTACHMENTS_STORE_ENABLED=true CHAT_ATTACHMENTS_RETENTION_DAYS=30 \
    CHAT_ATTACHMENTS_MAX_BYTES=3221225472 PRICE_FILE_ONCE_PER_TURN_ENABLED=true \
    STEP_TEXT_SEPARATE_ENABLED=true EMPTY_REPLY_GUARD_ENABLED=true \
    PRICE_EDIT_DB_WRITE_ENABLED=true PRICE_EDIT_TEXT_BLOCKS_ENABLED=true \
    PRICE_EDIT_FIRST_ENABLED=true DOCX_PAGES_ENABLED=true SHORTLIST_PAGING_ENABLED=true \
    SUPPLIER_DISCOVERY_ENABLED=true YANDEX_SEARCH_MAX_CONCURRENCY=1 \
    YANDEX_SEARCH_MIN_INTERVAL_MS=1200 B24_CALL_RECORDING_MAX_BYTES=104857600 \
    B24_CALL_RECORDING_TIMEOUT_MS=600000 PRICES_SCAN_FLOW_ENABLED=true VISION_TEXT_FIRST=true \
    >>"$STUB/env/p-app-1"
  for svc in "${SERVICES[@]}"; do cp "$STUB/env/p-$svc-1" "$STUB/env-golden/p-$svc-1"; done
  make_volume "$STUB/volume" "$VOLUME_ROWS"
  : >"$STUB/missing"
  : >"$STUB/shellenv.log"
  reset_pkg
}
drop_container() { # drop_container <имя>
  grep -v "^$1"$'\t' "$STUB/containers" >"$STUB/containers.n" || true
  mv "$STUB/containers.n" "$STUB/containers"
}

tree_snapshot() { (cd "$LIVE" && find . -type f | sort | xargs -d '\n' sha256sum \
  && find . -type f -printf '%m %p\n' | sort); }
tree_without_patched() { (cd "$LIVE" && find . -type f ! -name 'images.lock' \
  ! -path './platform/PLATFORM-VERSION' | sort | xargs -d '\n' sha256sum); }

# run <имя> [аргументы patch.sh]: изолированный $HOME (T_HOME - общий); код в RC.
run() {
  local name="$1" home="${T_HOME:-$1}"
  shift
  : >"$TMP/docker-$name.log"
  mkdir -p "$TMP/home-$home"
  RC=0
  env HOME="$TMP/home-$home" PATH="$BIN:$PATH" DOCKER_LOG="$TMP/docker-$name.log" STUB="$STUB" \
    TMP_DOCKER_ROOT="$TMP" H_NEW_APP="$H_NEW_APP" H_NEW_DOCS="$H_NEW_DOCS" \
    H_NEW_PSEUDO="$H_NEW_PSEUDO" H_NEW_MASK="$H_NEW_MASK" APP_ENV_SECRET="$APP_ENV_SECRET" \
    SECRET_TOKEN="$SECRET_TOKEN" FAKE_PII="$TMP/fakepii" \
    STUB_ENV_SET="${STUB_ENV_SET:-}" STUB_ENV_DEL="${STUB_ENV_DEL:-}" \
    CUTOVER_COSIGN="${TEST_COSIGN:-/nonexistent-cosign}" CUTOVER_NEW_DIR="$LIVE_ROOT" \
    CUTOVER_PROJECT=p CUTOVER_APP_CONTAINER=p-app-1 CUTOVER_ENV_FILE="$TMP/none.env" \
    CUTOVER_READY_WAIT_S=2 CUTOVER_POLL_S=1 CUTOVER_HEALTH_WAIT_S=2 \
    PATCH9W_MIN_DISK_MIB="${T_MIN_DISK:-1}" PATCH9W_MIN_AVAILABLE_MIB="${T_MIN_MEM:-1}" \
    PATCH9W_SOAK_POLL_S=1 PATCH9W_PREFLIGHT_WAIT_S=2 \
    timeout 120 bash "$PKG/patch.sh" --soak-seconds 1 "$@" >"$TMP/out-$name" 2>&1 || RC=$?
}
no_mutation() { ! grep -qE "$MUTATING_RE" "$TMP/docker-$1.log" \
  && ! grep -qE 'tar -czf|-delete' "$TMP/docker-$1.log"; }
out_has() { grep -qF -- "$2" "$TMP/out-$1"; }
log_line() { grep -nE -- "$2" "$TMP/docker-$1.log" | head -1 | cut -d: -f1; }
ups() { grep -oE ' up -d --no-deps [a-z]+$' "$TMP/docker-$1.log" | awk '{ print $NF }' \
  | tr '\n' ' ' | sed 's/ $//'; }
image_is() { grep -q "^p-$1-1"$'\t'"$2\$" "$STUB/containers"; }
all_old() { image_is pseudonymizer "$OLD_PSEUDO" && image_is mask "$OLD_MASK" \
  && image_is documents "$OLD_DOCS" && image_is app "$OLD_APP"; }
all_new() { image_is pseudonymizer "$NEW_PSEUDO" && image_is mask "$NEW_MASK" \
  && image_is documents "$NEW_DOCS" && image_is app "$NEW_APP"; }
pseudo_running() { [[ "$(cat "$STUB/status/p-pseudonymizer-1" 2>/dev/null || echo running)" \
  == running ]]; }
run_dir() { echo "$TMP/home-$1/.pragmatika-cutover"; }
backup_of() { find "$TMP/home-$1/backups" -mindepth 1 -maxdepth 1 -type d | head -1; }
# refuse_case <имя> <описание>: код 3, бой не тронут (нет изменяющих команд), дерево прежнее.
refuse_case() {
  assert "$2: код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
  assert "$2: бой не тронут" "no_mutation $1 && [[ \"\$(tree_snapshot)\" == \"\$T1\" ]]"
}
# stand_refuse <имя> <описание> <фрагмент сообщения> [команда подготовки боя]
stand_refuse() {
  reset_stand
  [[ -z "${4:-}" ]] || eval "$4"
  T1="$(tree_snapshot)"
  run "$1"
  refuse_case "$1" "$2"
  assert "$2: сообщение называет причину" "out_has $1 '$3'"
}
# pkg_refuse <имя> <описание> <фрагмент сообщения> <команда порчи пакета>
pkg_refuse() {
  reset_stand
  eval "$4"
  T1="$(tree_snapshot)"
  run "$1"
  refuse_case "$1" "$2"
  assert "$2: сообщение называет причину" "out_has $1 '$3'"
}

# fail_case <имя> <описание> <фрагмент сообщения>: переменные STUB_* заданы перед вызовом.
fail_case() {
  reset_stand
  T1="$(tree_snapshot)"
  run "$1"
  assert "$2: код 1" "[[ $RC -eq $EXIT_FAILED ]]"
  assert "$2: причина названа" "out_has $1 '$3'"
  assert "$2: дерево побайтно прежнее" "[[ \"\$(tree_snapshot)\" == \"\$T1\" ]]"
  assert "$2: все сервисы на прежних образах и pseudonymizer запущен" \
    "all_old && pseudo_running"
  assert "$2: откат проверен" "out_has $1 'ОТКАТ ПАТЧА ВЫПОЛНЕН'"
  assert "$2: том не менялся" \
    "[[ \$(volume_rows) -eq $VOLUME_ROWS ]] && ! grep -q 'find /data' '$TMP/docker-$1.log'"
}
assert "patch.sh на месте" "[[ -f '$SRC/patch.sh' ]]"

# 0. Стиль и вызов.
assert "bash -n patch.sh" "bash -n '$SRC/patch.sh'"
assert "строки patch.sh не длиннее $LIMIT" \
  "LC_ALL=C.UTF-8 awk -v n=$LIMIT 'length(\$0) > n { bad = 1 } END { exit bad }' '$SRC/patch.sh'"
assert "set -euo pipefail" "grep -q '^set -euo pipefail' '$SRC/patch.sh'"
assert "в командах нет down, --remove-orphans, --force-recreate, pull, prune" \
  "! grep -vE '^[[:space:]]*#' '$SRC/patch.sh' \
   | grep -qE 'dc_new down|--remove-orphans|--force-recreate|docker pull|compose pull|prune'"
assert "digest G9q4 в патче равны ожидаемым" \
  "grep -q 'sha256:$H_OLD_APP' '$SRC/patch.sh' && grep -q 'sha256:$H_OLD_DOCS' '$SRC/patch.sh'"
reset_stand
run help --help
assert "--help: код 0 и ключи" "[[ $RC -eq 0 ]] && out_has help '--rollback' \
  && out_has help '--restore-pseudonymizer-volume' && out_has help '--images-tar' \
  && out_has help 'transfer-images-9w.sh'"
assert "--help не печатает код" "! grep -q 'set -euo' '$TMP/out-help'"
for args in "--bogus" "--soak-seconds abc" "--expected-bots x" "--preflight-only --rollback" \
  "--preflight-only --restore-pseudonymizer-volume" "--rollback"; do
  name="usage-${args//[^a-z]/}"
  # shellcheck disable=SC2086
  run "$name" $args
  assert "вызов '$args': код 2" "[[ $RC -eq $EXIT_USAGE ]]"
  assert "вызов '$args': docker не вызывался" "[[ ! -s '$TMP/docker-$name.log' ]]"
done

# 12. Согласованность с lib.sh: порядок и ключи сервисов.
assert "порядок замены и отката в патче" \
  "grep -q '^APPLY_ORDER=(pseudonymizer mask documents app)' '$SRC/patch.sh' \
   && grep -q '^ROLLBACK_ORDER=(app documents mask pseudonymizer)' '$SRC/patch.sh'"

# 13. Стенд на настоящем Docker: вызов и ограничения (сам стенд здесь не запускается).
SYNTH_SH="$HERE/patch-9w-synth.sh"
STANDIN_YML="$ROOT/deploy/patch-9w/standin/patch-9w-stand.compose.yml"
assert "стенд: bash -n" "bash -n '$SYNTH_SH'"
assert "стенд: строки не длиннее $LIMIT" "LC_ALL=C.UTF-8 awk -v n=$LIMIT \
  'length(\$0) > n { bad = 1 } END { exit bad }' '$SYNTH_SH' '$STANDIN_YML'"
assert "стенд: --help называет шаги" \
  "bash '$SYNTH_SH' --help | grep -q 'restore-pseudonymizer-volume'"
for args in "--bogus" "--steps nosuch"; do
  RC=0
  # shellcheck disable=SC2086
  OUT="$TMP/synth-out" bash "$SYNTH_SH" $args >/dev/null 2>&1 || RC=$?
  assert "стенд: вызов '$args': код 2, каталог результатов не создан" \
    "[[ $RC -eq $EXIT_USAGE && ! -e '$TMP/synth-out' ]]"
done
assert "стенд: префикс проекта и метка этапа" \
  "grep -qx 'PROJECT=\"pragmatika-p9w\"' '$SYNTH_SH' \
   && grep -qx 'STAGE_LABEL=\"bai.stage=pd\"' '$SYNTH_SH' \
   && grep -qx '  bai.stage: pd' '$STANDIN_YML'"
assert "стенд: порты на хост не публикуются" "! grep -qE '^[[:space:]]*ports:' '$STANDIN_YML'"
assert "стенд: метка этапа у каждого сервиса, сети и тома надстройки" \
  "awk '/^[a-z]/ { section = \$1 }
     section ~ /^(services|networks|volumes):\$/ && /^  [a-z-]+:\$/ {
       if (open && !seen) bad = 1; open = 1; seen = 0 }
     /labels: \\*stand_labels/ { seen = 1 }
     END { exit (bad || !open || !seen) }' '$STANDIN_YML'"
assert "стенд: уборка только своих ресурсов (без prune и docker rmi)" \
  "! grep -vE '^[[:space:]]*#' '$SYNTH_SH' | grep -qE 'prune|docker rmi'"

group_package() {
# 1. Отказы по пакету.
pkg_refuse manifest "MANIFEST не сходится" "MANIFEST.sha256" 'echo x >>"$PKG/routes.tsv"'
pkg_refuse nosig "нет подписей и cosign" "signatures" 'rm "$PKG/signatures.txt"; seal'
pkg_refuse sigfail "подписи result=FAIL" "result не OK" \
  'make_sigs "$PKG/signatures.txt" FAIL; seal'
pkg_refuse sigstale "подписи от другого lock" "sha256 images.lock" \
  'echo "# x" >>"$PKG/images.lock"; seal'
TEST_COSIGN="$BIN/cosign-stub" STUB_COSIGN_RC=1 pkg_refuse cosignfail "cosign verify красный" \
  "cosign verify не прошёл" ':'
reset_stand
TEST_COSIGN="$BIN/cosign-stub" run cosignok --preflight-only
assert "cosign verify зелёный: preflight код 0" \
  "[[ $RC -eq 0 ]] && out_has cosignok 'cosign verify на хосте'"
pkg_refuse extrakey "lock меняет alloy" "BAI_IMAGE_ALLOY" \
  "pkg_lock_edit 's|^BAI_IMAGE_ALLOY=.*|BAI_IMAGE_ALLOY=r/alloy@sha256:$H_BASE|'"
pkg_refuse speechkey "lock меняет speech" "BAI_IMAGE_SPEECH" \
  "pkg_lock_edit 's|^BAI_IMAGE_SPEECH=.*|BAI_IMAGE_SPEECH=r/speech@sha256:$H_BASE|'"
pkg_refuse delkey "lock теряет ключ" "BAI_IMAGE_ALLOY" "pkg_lock_edit '/^BAI_IMAGE_ALLOY=/d'"
pkg_refuse addkey "lock добавляет ключ" "BAI_IMAGE_NEWSVC" \
  "echo 'BAI_IMAGE_NEWSVC=r/n@sha256:$H_BASE' >>\"\$PKG/images.lock\"; pkg_lock_edit ''"
pkg_refuse wrongver "версия пакета не $VER_TO" "$VER_TO" \
  "pkg_lock_edit 's|^BAI_VERSION=.*|BAI_VERSION=1.1.12-pragmatika.2|'"
for pair in "BAI_IMAGE_APP|$OLD_APP" "BAI_IMAGE_DOCUMENTS|$OLD_DOCS" \
  "BAI_IMAGE_PSEUDONYMIZER|$OLD_PSEUDO" "BAI_IMAGE_MASK|$OLD_MASK"; do
  key="${pair%%|*}"
  pkg_refuse "same-$key" "lock не меняет $key" "не меняет образ" \
    "pkg_lock_edit 's|^$key=.*|$key=${pair#*|}|'"
  pkg_refuse "tag-$key" "$key по тегу" "формате" \
    "pkg_lock_edit 's|^$key=.*|$key=r/x:latest|'"
done
pkg_refuse nomask "в lock нет mask" "BAI_IMAGE_MASK" "pkg_lock_edit '/^BAI_IMAGE_MASK=/d'"
pkg_refuse nopseudo "в lock нет pseudonymizer" "BAI_IMAGE_PSEUDONYMIZER" \
  "pkg_lock_edit '/^BAI_IMAGE_PSEUDONYMIZER=/d'"
pkg_refuse noappbase "в lock нет основы app" "BAI_IMAGE_APP_BASE" \
  "pkg_lock_edit '/^BAI_IMAGE_APP_BASE=/d'"
for rel in compose.yml images.lock .env compat.env compose.project.yml \
  platform/compose.base.yml; do
  name="extra-${rel//[^a-z]/}"
  pkg_refuse "$name" "чужой файл deploy/$rel в пакете" "deploy/$rel" \
    "echo x >\"\$PKG/deploy/$rel\"; seal"
done
pkg_refuse extradb "каталог db в deploy пакета" "каталог db" \
  'mkdir -p "$PKG/deploy/db/app"; echo x >"$PKG/deploy/db/app/1.sql"; seal'
pkg_refuse rootdb "каталог db в корне пакета" "каталог db" 'mkdir -p "$PKG/db"; seal'
pkg_refuse extraref "лишний эталон" "reference/deploy/extra.yml" \
  'echo x >"$PKG/reference/deploy/extra.yml"; seal'
pkg_refuse noref "нет эталона compose.project.yml" "reference/deploy/compose.project.yml" \
  'rm "$PKG/reference/deploy/compose.project.yml"; seal'
pkg_refuse noplat "нет PLATFORM-VERSION" "platform/PLATFORM-VERSION" \
  'rm "$PKG/deploy/platform/PLATFORM-VERSION"; seal'
pkg_refuse oldplat "платформа пакета 1.1.11" "1.1.12" \
  'write_platform "$PKG/deploy" 1.1.11 "$GOLDEN/platform/compose.base.yml"; seal'
pkg_refuse badsum "сумма эталона не сходится" "сумма эталона" \
  'echo "# x" >>"$PKG/reference/deploy/platform/compose.base.yml"; seal'
pkg_refuse extrasum "суммы копии платформы отличаются от боя" "суммы файлов копии платформы" \
  'printf "sha256 %s  other.yml\n" "$H_BASE" >>"$PKG/deploy/platform/PLATFORM-VERSION"; seal'
pkg_refuse notools "нет инструментов проверки маршрутов" "инструментов проверки" \
  'rm "$PKG/tools/check-routes.sh"; seal'
}

group_battle() {
# 2. Бой не на G9q4 или нездоров.
G9="только поверх G9q4"
stand_refuse lockver "lock боя другой версии" "$G9" \
  "sed -i 's|^BAI_VERSION=.*|BAI_VERSION=1.1.10-pragmatika.2|' \"\$LIVE/images.lock\""
stand_refuse liveplat "платформа боя 1.1.10" "$G9" \
  "write_platform \"\$LIVE\" 1.1.10 \"\$GOLDEN/platform/compose.base.yml\""
stand_refuse noliveplat "нет PLATFORM-VERSION боя" "$G9" \
  'rm "$LIVE/platform/PLATFORM-VERSION"'
for svc in app documents; do
  key="BAI_IMAGE_${svc^^}"
  stand_refuse "digest-$svc" "lock боя: $svc не на digest G9q4" "не от G9q4" \
    "sed -i 's|^$key=.*|$key=r/pragmatika-$svc@sha256:$H_BASE|' \"\$LIVE/images.lock\"; \
     sed -i 's|^p-$svc-1\t.*|p-$svc-1\tr/pragmatika-$svc@sha256:$H_BASE|' \"\$STUB/containers\""
  stand_refuse "running-$svc" "запущенный $svc не на digest" "не на образе из lock боя" \
    "sed -i 's|^p-$svc-1\t.*|p-$svc-1\tr/pragmatika-$svc@sha256:$H_BASE|' \"\$STUB/containers\""
  stand_refuse "stopped-$svc" "$svc не запущен" "не запущен" \
    "echo exited >\"\$STUB/status/p-$svc-1\""
  stand_refuse "absent-$svc" "нет контейнера $svc" "нет контейнера $svc" \
    "drop_container p-$svc-1"
done
stand_refuse pseudoimage "pseudonymizer не на образе lock" "не на образе из lock боя" \
  "sed -i 's|^p-pseudonymizer-1\t.*|p-pseudonymizer-1\tr/x@sha256:$H_BASE|' \"\$STUB/containers\""
stand_refuse pseudoabsent "нет pseudonymizer" "нет контейнера pseudonymizer" \
  'drop_container p-pseudonymizer-1'
STUB_UNHEALTHY_OLD=pseudonymizer stand_refuse pseudosick "pseudonymizer нездоров" "не healthy"
STUB_VOLUME_NAME=other_volume stand_refuse volname "том подключён другой" "other_volume"
STUB_UNHEALTHY_OLD=documents stand_refuse docssick "documents нездоров" "не healthy"
stand_refuse maskrestarting "mask перезапускается" "restarting" \
  'echo restarting >"$STUB/status/p-mask-1"'
stand_refuse maskpaused "mask на паузе" "paused" 'echo paused >"$STUB/status/p-mask-1"'
STUB_MASK_DOWN_OLD=1 stand_refuse maskdownold "mask запущен, /health не 200" "/health не 200"
stand_refuse maskimage "mask не на образе lock" "не на образе из lock боя" \
  "sed -i 's|^p-mask-1\t.*|p-mask-1\tr/x@sha256:$H_BASE|' \"\$STUB/containers\""
}

group_vars() {
G9="только поверх G9q4"
KEEP_KEYS="$(sed -n '/^KEEP_APP_KEYS=(/,/)$/p; /^G9S_APP_KEYS=(/,/)$/p' "$SRC/patch.sh" \
  | grep -oE '\b[A-Z][A-Z0-9_]{7,}\b' | grep -vE '^(KEEP|G9S)_APP_KEYS$' | sort -u)"
assert "список переменных app: 18 имён" "[[ \$(wc -w <<<\"\$KEEP_KEYS\") -eq 18 ]]"
for var in $KEEP_KEYS; do
  stand_refuse "no-$var" "у app нет $var" "$var" "sed -i '/^$var=/d' \"\$STUB/env/p-app-1\""
done
for var in DOCUMENTS_EDIT_PPTX DOCUMENTS_EDIT_PDF DOCUMENTS_PPT_CONVERT \
  DOCUMENTS_EDIT_PDF_FALLBACK_FONT; do
  stand_refuse "no-$var" "у documents нет $var" "$var" \
    "sed -i '/^$var=/d' \"\$STUB/env/p-documents-1\""
done
for rel in compose.yml compat.env compose.project.yml platform/compose.base.yml; do
  stand_refuse "ref-${rel//[^a-z]/}" "боевой $rel отличается от эталона" "$rel" \
    "echo '# правка на бою' >>\"\$LIVE/$rel\""
done
stand_refuse nomark "дерево создано не cutover.sh" ".cutover-deployed" \
  'rm "$LIVE/.cutover-deployed"'
STUB_NO_READY=1 stand_refuse noready "/ready не отвечает" "/ready боя не 200"
STUB_BOTS=3 stand_refuse fewbots "ботов меньше ожидаемого" "ботов 3"
STUB_PAGES="404 -" stand_refuse pagesold "проба pages до замены" "/docx/pages"
STUB_PARSE="documents недоступен" stand_refuse parseold "проба parse до замены" "/parse"
T_MIN_DISK=999999999 stand_refuse nodisk "мало диска" "мало места"
T_MIN_MEM=999999999 stand_refuse nomem "мало памяти" "мало памяти"
STUB_DU_FAIL=1 stand_refuse dufail "том не измерен" "не измерен том"
STUB_DU_KIB=999999999999 stand_refuse bigvolume "нет места под бэкап тома" "под бэкап"
for pair in "pseudonymizer|$NEW_PSEUDO" "mask|$NEW_MASK" "documents|$NEW_DOCS" "app|$NEW_APP"; do
  svc="${pair%%|*}"
  stand_refuse "miss-$svc" "нет нового образа $svc" "нет образов на хосте: $svc" \
    "echo '${pair#*|}' >\"\$STUB/missing\""
  assert "нет образа $svc: подсказка о переносе" "out_has 'miss-$svc' 'transfer-images-9w.sh'"
done
for pair in "pseudonymizer|$OLD_PSEUDO" "mask|$OLD_MASK" "documents|$OLD_DOCS" "app|$OLD_APP"; do
  svc="${pair%%|*}"
  stand_refuse "rbmiss-$svc" "нет откатного образа $svc" "откат был бы невозможен" \
    "echo '${pair#*|}' >\"\$STUB/missing\""
done
for pair in "livefail|снимка нет" "stagefail|не принял новые файлы" \
  "badjson|нет одного из сервисов" "nosvc|нет одного из сервисов" "other|со снимком боя" \
  "appmem|со снимком боя" "base|со снимком боя" "image-pseudonymizer|со снимком боя" \
  "image-mask|со снимком боя" "image-documents|со снимком боя" "image-app|со снимком боя"; do
  drift="${pair%%|*}"
  STUB_CFG="$drift" stand_refuse "cfg-$drift" "конфигурация compose: $drift" "${pair#*|}"
done
assert "дрейф конфигурации: значения не печатаются" \
  "! grep -q '$APP_ENV_SECRET' '$TMP/out-cfg-other'"
}

group_pre() {
# 3. Уже применён.
for case_name in lockequal lockver platform; do
  reset_stand
  case "$case_name" in
    lockequal) cp "$PKG/images.lock" "$LIVE/images.lock" ;;
    lockver) sed -i "s|^BAI_VERSION=.*|BAI_VERSION=$VER_TO|" "$LIVE/images.lock" ;;
    platform) cp "$PKG/deploy/platform/PLATFORM-VERSION" "$LIVE/platform/PLATFORM-VERSION" ;;
  esac
  T1="$(tree_snapshot)"
  run "applied-$case_name"
  refuse_case "applied-$case_name" "уже применён ($case_name)"
  assert "уже применён ($case_name): сообщение" "out_has 'applied-$case_name' 'уже применён'"
done

# 4. --preflight-only и --images-tar.
reset_stand
T1="$(tree_snapshot)"
run pre --preflight-only
assert "preflight: код 0" "[[ $RC -eq 0 ]]"
assert "preflight: бой не тронут, дерево прежнее" \
  "no_mutation pre && [[ \"\$(tree_snapshot)\" == \"\$T1\" ]]"
assert "preflight: нет бэкапа и ссылки latest" \
  "[[ ! -e '$TMP/home-pre/backups' && ! -e '$(run_dir pre)/patch-9w-latest' ]]"
assert "preflight: итог в состоянии" \
  "grep -q '^RESULT=PREFLIGHT_OK' '$(run_dir pre)'/patch-9w-2*/state.env"
reset_stand
printf '%s\n' "$NEW_APP" "$NEW_PSEUDO" >"$STUB/missing"
printf '%s\n' "$NEW_APP" "$NEW_PSEUDO" >"$TMP/images.tar"
run tarpre --preflight-only --images-tar "$TMP/images.tar"
assert "--images-tar: образы загружены, preflight код 0" \
  "[[ $RC -eq 0 ]] && grep -q '^load -i $TMP/images.tar' '$TMP/docker-tarpre.log'"
reset_stand
T1="$(tree_snapshot)"
run tarmissing --preflight-only --images-tar "$TMP/нет.tar"
assert "--images-tar без файла: код 3" \
  "[[ $RC -eq $EXIT_REFUSED ]] && out_has tarmissing 'нет архива'"
reset_stand
STUB_LOAD_FAIL=1 run tarfail --preflight-only --images-tar "$TMP/images.tar"
assert "--images-tar: сбой docker load - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
reset_stand
printf '%s\n' "$NEW_MASK" >"$STUB/missing"
run tarpartial --preflight-only --images-tar "$TMP/images.tar"
assert "--images-tar без нужного образа: код 3, назван mask" \
  "[[ $RC -eq $EXIT_REFUSED ]] && out_has tarpartial 'нет образов на хосте: mask'"
}

group_success() {
# 5. Успешный ход.
reset_stand
T1="$(tree_snapshot)"
W1="$(tree_without_patched)"
export PSEUDONYMIZER_ADDRESS_MASK=off PII_ALLOWED_WORDS=shell BAI_IMAGE_APP=shell \
  PRICES_SCAN_FLOW_ENABLED=false VISION_TEXT_FIRST=false DOCUMENTS_EDIT_PDF_TEXT=shell \
  MASK_TOKEN=shell
run good
unset PSEUDONYMIZER_ADDRESS_MASK PII_ALLOWED_WORDS BAI_IMAGE_APP PRICES_SCAN_FLOW_ENABLED \
  VISION_TEXT_FIRST DOCUMENTS_EDIT_PDF_TEXT MASK_TOKEN
GOOD_RUN="$(readlink -f "$(run_dir good)/patch-9w-latest" || true)"
B="$(backup_of good)"
assert "успех: код 0" "[[ $RC -eq 0 ]]"
assert "успех: все четыре сервиса на новых образах" "all_new"
assert "успех: порядок up pseudonymizer mask documents app" \
  "[[ \"\$(ups good)\" == 'pseudonymizer mask documents app' ]]"
assert "успех: stop < архив тома < up pseudonymizer < проба < up mask" \
  "(( \$(log_line good ' stop -t [0-9]+ pseudonymizer') < \$(log_line good 'tar -czf') \
   && \$(log_line good 'tar -czf') < \$(log_line good 'up -d --no-deps pseudonymizer') \
   && \$(log_line good 'up -d --no-deps pseudonymizer') < \$(log_line good '^exec ') \
   && \$(log_line good '^exec ') < \$(log_line good 'up -d --no-deps mask') ))"
assert "успех: архив тома снят прежним образом, только чтение, без сети" \
  "grep 'tar -czf' '$TMP/docker-good.log' | grep -q -- '--network none .*:/data:ro .*$OLD_PSEUDO'"
assert "успех: останавливается только pseudonymizer" \
  "[[ \$(grep -c ' stop ' '$TMP/docker-good.log') -eq 1 ]]"
assert "успех: нет down, rm, pull" \
  "! grep -qE '^(rm|pull|volume|network)|compose .* (down|rm|pull)( |\$)' '$TMP/docker-good.log'"
assert "успех: images.lock = пакетный" "cmp -s '$PKG/images.lock' '$LIVE/images.lock'"
assert "успех: PLATFORM-VERSION = пакетный" \
  "cmp -s '$PKG/deploy/platform/PLATFORM-VERSION' '$LIVE/platform/PLATFORM-VERSION'"
assert "успех: прочие файлы дерева и .env прежние" \
  "[[ \"\$(tree_without_patched)\" == \"\$W1\" && \$(stat -c %a '$LIVE/.env') == 600 ]]"
assert "успех: бэкап deploy равен прежнему дереву" \
  "[[ \"\$(cd '$B/deploy' && find . -type f | sort | xargs -d '\n' sha256sum)\" \
   == \"\$(cd '$GOLDEN' && find . -type f | sort | xargs -d '\n' sha256sum)\" ]]"
assert "успех: .env в бэкапе 600, каталог бэкапа 700" \
  "[[ \$(stat -c %a '$B/deploy/.env') == 600 && \$(stat -c %a '$B') == 700 ]]"
assert "успех: архив тома 600, с суммой, читается" \
  "[[ \$(stat -c %a '$B/pseudonymizer-data.tgz') == 600 ]] \
   && (cd '$B' && sha256sum -c --quiet pseudonymizer-data.tgz.sha256) \
   && tar -tzf '$B/pseudonymizer-data.tgz' | grep -q pseudonymizer.sqlite3"
assert "успех: проверка архива называет число записей" \
  "out_has good 'integrity=ok rows=$VOLUME_ROWS'"
assert "успех: проба labops-pii в отчёте" \
  "out_has good 'version=1.3.0 masked=yes restored=yes' && out_has good 'patch-9w-probe'"
assert "успех: проверки образов четырёх сервисов" \
  "[[ \$(grep -c 'совпал' '$GOOD_RUN/results/images-running.tsv') -eq 4 ]]"
assert "успех: переменные ПДн сверены у всех четырёх" \
  "[[ \$(grep -c '^переменные ПДн .*'\$'\t''ok' '$GOOD_RUN/results/checks.tsv') -eq 4 ]]"
assert "успех: маршруты без пропуска сервисов" \
  "! grep -q -- '--skip-service mask' '$GOOD_RUN/results/routes-stack.txt'"
assert "успех: провалов в проверках нет" \
  "! grep -q \$'\tfail\t' '$GOOD_RUN/results/checks.tsv'"
assert "успех: итог OK и архив результатов" \
  "grep -q '^RESULT=OK' '$GOOD_RUN/state.env' && ls '$TMP'/home-good/patch9w-*.tgz >/dev/null"
mkdir -p "$TMP/arch-good"
tar -C "$TMP/arch-good" -xzf "$(ls "$TMP"/home-good/patch9w-*.tgz | head -1)"
for secret in "$SECRET_KEY" "$SECRET_TOKEN" "$SECRET_WORDS" "$SECRET_MASK" "$APP_ENV_SECRET" \
  "Вымышленнослов"; do
  assert "успех: секрета ${secret:0:9}... нет в выводе, архиве и результатах" \
    "! grep -rqF -- '$secret' '$TMP/out-good' '$TMP/arch-good' '$GOOD_RUN/results'"
done
assert "успех: в архиве нет окружения и тома" \
  "! tar -tzf '$TMP'/home-good/patch9w-*.tgz | grep -qE 'sqlite|/\.env\$|pii-env|secrets'"
assert "хэши окружения ПДн не содержат значений" \
  "! grep -rqF -- '$SECRET_TOKEN' '$GOOD_RUN'/pii-env-* '$GOOD_RUN/work'"
assert "переменные оболочки сброшены до вызовов docker" \
  "! grep -qv '^<unset> <unset> <unset> <unset> <unset> <unset> <unset>\$' '$STUB/shellenv.log'"

# 6. Повторный запуск после успеха.
T1="$(tree_snapshot)"
T_HOME=good run again
refuse_case again "повторный запуск"
assert "повторный запуск: latest указывает на успешный ход" \
  "[[ \"\$(readlink -f '$(run_dir good)/patch-9w-latest')\" == '$GOOD_RUN' ]]"

# 7. Ручной откат и восстановление тома после успешного хода.
cp -a "$STUB/volume" "$TMP/volume-after"
make_volume "$STUB/volume" 2 # записи, появившиеся после бэкапа
T_HOME=good run rb --rollback
assert "--rollback: код 0" "[[ $RC -eq 0 ]]"
assert "--rollback: все четыре на прежних образах" "all_old"
assert "--rollback: порядок app documents mask pseudonymizer" \
  "[[ \"\$(ups rb)\" == 'app documents mask pseudonymizer' ]]"
assert "--rollback: дерево побайтно как до патча" \
  "[[ \"\$(tree_snapshot)\" == \"\$(cd '$GOLDEN' && find . -type f | sort \
   | xargs -d '\n' sha256sum && find . -type f -printf '%m %p\n' | sort)\" ]]"
assert "--rollback: том не трогается" \
  "! grep -qE -- '-delete|tar -czf| stop ' '$TMP/docker-rb.log' \
   && [[ \$(volume_rows) -eq $((VOLUME_ROWS + 2)) ]]"
T_HOME=good run rb2 --rollback
assert "--rollback повторно: код 0, всё прежнее" "[[ $RC -eq 0 ]] && all_old"
# Том: после отката (lock боя прежний).
T_HOME=good run restore --restore-pseudonymizer-volume
assert "восстановление тома: код 0" "[[ $RC -eq 0 ]]"
assert "восстановление тома: записей как в бэкапе" "[[ \$(volume_rows) -eq $VOLUME_ROWS ]]"
SAFETY="$(find "$B" -name 'pseudonymizer-data-before-restore-*.tgz' | head -1)"
mkdir -p "$TMP/safety"
tar -C "$TMP/safety" -xzf "$SAFETY"
assert "восстановление тома: копия прежнего содержимого 600 с добавленными записями" \
  "[[ \$(stat -c %a '$SAFETY') == 600 \
   && \$(db_rows '$TMP/safety/pseudonymizer.sqlite3') -eq $((VOLUME_ROWS + 2)) ]]"
assert "восстановление тома: stop, копия, очистка, up" \
  "(( \$(log_line restore ' stop -t') < \$(log_line restore 'before-restore') \
   && \$(log_line restore 'before-restore') < \$(log_line restore 'find /data') \
   && \$(log_line restore 'find /data') < \$(log_line restore 'up -d --no-deps pseudonymizer') ))"
assert "восстановление тома: только pseudonymizer, сервис запущен" \
  "[[ \"\$(ups restore)\" == pseudonymizer ]] && pseudo_running"
assert "восстановление тома: предупреждение о потере записей" "out_has restore 'пропадут'"
}

group_volume() {
fresh_applied() { # fresh_applied <имя home>: успешный ход и два новых «поздних» записи
  reset_stand
  T_HOME="$1" run "$1-apply"
  assert "$1: подготовка (патч применён)" "[[ $RC -eq 0 ]] && all_new"
  make_volume "$STUB/volume" 2
}
fresh_applied both
T_HOME=both run both-rb --rollback --restore-pseudonymizer-volume
assert "откат с томом: код 0, образы прежние, том из бэкапа" \
  "[[ $RC -eq 0 ]] && all_old && [[ \$(volume_rows) -eq $VOLUME_ROWS ]]"
assert "откат с томом: том восстановлен после отката" \
  "(( \$(log_line both-rb 'up -d --no-deps app') < \$(log_line both-rb 'find /data') ))"
fresh_applied onlyvol
T_HOME=onlyvol run onlyvol-r --restore-pseudonymizer-volume \
  --run-dir "$(readlink -f "$(run_dir onlyvol)/patch-9w-latest")"
assert "только том на новой версии (--run-dir): код 0, образы новые" \
  "[[ $RC -eq 0 ]] && all_new && [[ \$(volume_rows) -eq $VOLUME_ROWS ]]"
fresh_applied badsum
echo x >>"$(backup_of badsum)/pseudonymizer-data.tgz"
T1="$(tree_snapshot)"
T_HOME=badsum run badsum-r --rollback --restore-pseudonymizer-volume
assert "порченый архив: код 3, ни отката, ни изменений тома" \
  "[[ $RC -eq $EXIT_REFUSED ]] && all_new && no_mutation badsum-r \
   && [[ \$(volume_rows) -eq $((VOLUME_ROWS + 2)) && \"\$(tree_snapshot)\" == \"\$T1\" ]]"
fresh_applied noarch
rm -f "$(backup_of noarch)/pseudonymizer-data.tgz"
T_HOME=noarch run noarch-r --restore-pseudonymizer-volume
assert "нет архива: код 3" "[[ $RC -eq $EXIT_REFUSED ]] && out_has noarch-r 'нет архива тома'"
fresh_applied resfail
STUB_RESTORE_FAIL=1 T_HOME=resfail run resfail-r --restore-pseudonymizer-volume
assert "сбой распаковки: код 4" "[[ $RC -eq $EXIT_STUCK ]]"
assert "сбой распаковки: копия до восстановления есть" \
  "ls '$(backup_of resfail)'/pseudonymizer-data-before-restore-*.tgz >/dev/null"
fresh_applied copyfail
STUB_TAR_FAIL=1 T_HOME=copyfail run copyfail-r --restore-pseudonymizer-volume
assert "нет копии до восстановления: код 4, том не менялся, сервис снова запущен" \
  "[[ $RC -eq $EXIT_STUCK && \$(volume_rows) -eq $((VOLUME_ROWS + 2)) ]] && pseudo_running \
   && ! grep -q 'find /data' '$TMP/docker-copyfail-r.log'"
fresh_applied foreign
sed -i "s|^BAI_VERSION=.*|BAI_VERSION=1.1.13-pragmatika.1|" "$LIVE/images.lock"
T1="$(tree_snapshot)"
T_HOME=foreign run foreign-rb --rollback
refuse_case foreign-rb "--rollback после другого патча"
fresh_applied rbstuck
STUB_RB_FAIL=documents T_HOME=rbstuck run rbstuck-rb --rollback
assert "ручной откат не удался: код 4" "[[ $RC -eq $EXIT_STUCK ]]"
reset_stand
mkdir -p "$TMP/emptyrun"
run norunstate --rollback --run-dir "$TMP/emptyrun"
assert "--rollback по пустому каталогу: код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
}

group_mask() {
# 8. mask не запущен: не трогается ни при замене, ни при откате.
for mode in absent exited; do
  reset_stand
  if [[ "$mode" == absent ]]; then drop_container p-mask-1
  else echo exited >"$STUB/status/p-mask-1"; fi
  run "mask-$mode"
  RD="$(readlink -f "$(run_dir "mask-$mode")/patch-9w-latest" || true)"
  assert "mask $mode: код 0" "[[ $RC -eq 0 ]]"
  assert "mask $mode: up только трёх" \
    "[[ \"\$(ups mask-$mode)\" == 'pseudonymizer documents app' ]]"
  assert "mask $mode: маршруты mask пропущены" \
    "grep -q -- '--skip-service mask' '$RD/results/routes-stack.txt' \
     && ! grep -q -- '--skip-service documents' '$RD/results/routes-stack.txt'"
  assert "mask $mode: предупреждение" "out_has mask-$mode 'не запускал'"
  [[ "$mode" != exited ]] || assert "mask exited: образ контейнера прежний" \
    "image_is mask '$OLD_MASK'"
  T_HOME="mask-$mode" run "mask-$mode-rb" --rollback
  assert "mask $mode: откат код 0 без up mask" \
    "[[ $RC -eq 0 && \"\$(ups mask-$mode-rb)\" == 'app documents pseudonymizer' ]]"
done
reset_stand
drop_container p-mask-1
echo "$OLD_MASK" >"$STUB/missing"
run mask-noold --preflight-only
assert "mask нет: прежний образ mask не требуется" "[[ $RC -eq 0 ]]"
reset_stand
drop_container p-mask-1
echo "$NEW_MASK" >"$STUB/missing"
run mask-nonew --preflight-only
assert "mask нет: новый образ mask всё равно требуется" "[[ $RC -eq $EXIT_REFUSED ]]"
}

group_failfirst() {
STUB_STOP_FAIL=1 fail_case stopfail "stop pseudonymizer не удался" "compose stop"
STUB_STOP_NOOP=1 fail_case stopnoop "pseudonymizer не остановился" "не остановился"
STUB_TAR_FAIL=1 fail_case tarfail2 "архив тома не снят" "не снят архив тома"
assert "архив тома не снят: файлы дерева не заменялись, новые образы не поднимались" \
  "! grep -q 'FILE_REPLACED' '$(run_dir tarfail2)'/patch-9w-2*/state.env"
STUB_TAR_GARBAGE=1 fail_case targarbage "архив тома не читается" "не читается"
STUB_TAR_MODE=644 fail_case tarmode "права архива не 600" "права архива"
reset_stand
echo garbage-not-sqlite >"$STUB/volume/pseudonymizer.sqlite3"
run corrupt
assert "повреждённая база: код 1, образы прежние, дерево не менялось" \
  "[[ $RC -eq $EXIT_FAILED ]] && all_old && pseudo_running \
   && out_has corrupt 'не прошёл проверку хранилища'"
for svc in pseudonymizer mask documents app; do
  STUB_UP_FAIL="$svc" fail_case "upfail-$svc" "up $svc не удался" "compose up $svc"
  STUB_WRONG_IMAGE="$svc" fail_case "wrong-$svc" "неверный образ $svc" "не равен lock"
done
for svc in pseudonymizer documents app; do
  STUB_UNHEALTHY="$svc" fail_case "sick-$svc" "$svc нездоров" "не стал здоровым"
done
STUB_MASK_DOWN=1 fail_case maskdown "mask /health не 200" "не стал здоровым"
STUB_DOCS_HEALTH_500=1 fail_case docs500 "documents /health 500" "не стал здоровым"
STUB_PROBE_LINE="version=1.1.4 masked=yes restored=yes" \
  fail_case probever "проба: прежняя версия" "проба labops-pii"
STUB_PROBE_LINE="version=1.3.0 masked=no restored=no" \
  fail_case probemask "проба: не замаскировано" "проба labops-pii"
STUB_PROBE_LINE="version=1.3.0 masked=yes restored=no" \
  fail_case proberestore "проба: не восстановлено" "проба labops-pii"
STUB_PROBE_LINE="version=1.3.0 error=HTTPError 500" \
  fail_case probeerr "проба: ошибка сервиса" "проба labops-pii"
}

group_failsecond() {
for pair in "pseudonymizer|PII_ALLOWED_WORDS=другое" \
  "pseudonymizer|PSEUDONYMIZER_ADDRESS_MASK=off" \
  "pseudonymizer|PSEUDONYMIZER_NEW=1" "mask|MEDIA_MASKER_ADDRESS_MASK=off" \
  "app|PSEUDONYMIZER_URL=http://other:1"; do
  svc="${pair%%|*}"
  var="${pair#*|}"
  STUB_ENV_SET="$svc:$var" fail_case "piienv-$svc-${var%%=*}" \
    "переменная ${var%%=*} у $svc изменилась" "${var%%=*}"
done
assert "изменение PII_ALLOWED_WORDS: значения не печатаются" \
  "! grep -qF -e 'другое' -e 'Вымышленнослов' '$TMP/out-piienv-pseudonymizer-PII_ALLOWED_WORDS'"
STUB_ENV_DEL="pseudonymizer:PII_ALLOWED_WORDS" \
  fail_case piidel "PII_ALLOWED_WORDS пропала" "PII_ALLOWED_WORDS"
STUB_PAGES_NEW="404 -" fail_case pagesnew "проба pages после замены" "проба /docx/pages"
STUB_PARSE_NEW="200 - - -" fail_case parsenew "проба parse изменилась" "проба /parse"
STUB_ENV_SET="documents:DOCUMENTS_EDIT_PDF=false" \
  fail_case docsenv "флаг documents изменился" "DOCUMENTS_EDIT_PDF"
STUB_ENV_DEL="documents:DOCUMENTS_EDIT_PDF_TEXT" \
  fail_case docsenvdel "DOCUMENTS_EDIT_PDF_TEXT пропала" "DOCUMENTS_EDIT_PDF_TEXT"
STUB_READY_500=1 fail_case ready500 "/ready 500 после замены" "/ready не 200"
STUB_BOTS_NEW=2 fail_case botsnew "ботов меньше после замены" "ботов 2"
STUB_ENV_SET="app:VISION_TEXT_FIRST=false" \
  fail_case appenv "значение VISION_TEXT_FIRST изменилось" "VISION_TEXT_FIRST"
STUB_ENV_DEL="app:PRICES_SCAN_FLOW_ENABLED" \
  fail_case appenvdel "PRICES_SCAN_FLOW_ENABLED пропала" "PRICES_SCAN_FLOW_ENABLED"
STUB_ROUTES_RC=1 fail_case routes "маршруты стека" "маршрутов стека"
for svc in pseudonymizer app; do
  STUB_RESTART_LOOP="$svc" fail_case "loop-$svc" "$svc перезапускается в выдержку" "перезапускался"
done
STUB_PSEUDO_SICK_LATE=1 fail_case sicklate "pseudonymizer заболел позже" "pseudonymizer не healthy"
STUB_DOCS_HEALTH_500_LATE=1 fail_case docslate "documents заболел позже" "/health documents"
STUB_MASK_DOWN_LATE=1 fail_case masklate "mask заболел позже" "/health mask"
STUB_SIGNAL_AT=app STUB_SIGNAL=TERM fail_case sigterm "обрыв сигналом TERM" "автоматический откат"
reset_stand
T1="$(tree_snapshot)"
STUB_SIGNAL_AT=documents STUB_SIGNAL=HUP run sighup
assert "обрыв сеанса (HUP): код 1 после отката" "[[ $RC -eq $EXIT_FAILED ]]"
assert "обрыв сеанса: дерево и образы прежние" \
  "[[ \"\$(tree_snapshot)\" == \"\$T1\" ]] && all_old && pseudo_running"
assert "обрыв сеанса: откат записан в журнал" \
  "grep -q 'ОТКАТ ПАТЧА ВЫПОЛНЕН' '$(run_dir sighup)'/patch-9w-2*/results/cutover.log"
}

group_stuckprobe() {
# 10. Откат тоже не удался: код 4.
reset_stand
STUB_STUCK=1 run stuck
assert "откат не удался (/ready): код 4" \
  "[[ $RC -eq $EXIT_STUCK ]] && out_has stuck 'ОТКАТ НЕ УДАЛСЯ'"
reset_stand
STUB_UP_FAIL=app STUB_RB_FAIL=pseudonymizer run stuck2
assert "откат не удался (up pseudonymizer): код 4" "[[ $RC -eq $EXIT_STUCK ]]"
assert "откат не удался: дерево всё равно из бэкапа" \
  "cmp -s '$GOLDEN/images.lock' '$LIVE/images.lock'"

# 11. Настоящая программа пробы labops-pii против локальной заглушки сервиса.
mkdir -p "$TMP/fakepii/labops_pii"
echo '__version__ = "1.3.0"' >"$TMP/fakepii/labops_pii/__init__.py"
cat >"$TMP/fake-pseudo.py" <<'PY'
"""Заглушка API псевдонимизатора: режим берётся из файла на каждый запрос."""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODE = Path(sys.argv[1])
STORE: dict[str, str] = {}
BUSY = {"left": 0}


class Handler(BaseHTTPRequestHandler):
    """Ответы /pseudonymize и /restore."""

    def do_POST(self) -> None:  # noqa: N802
        """Обрабатывает запрос по текущему режиму."""
        mode = MODE.read_text().strip()
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.headers.get("Authorization") != "Bearer " + sys.argv[3]:
            self.reply(401, {})
            return
        if mode == "busy" and BUSY["left"] < 1:
            BUSY["left"] += 1
            self.reply(503, {})
            return
        text = body["text"]
        if self.path == "/pseudonymize":
            if mode in ("new", "busy", "norestore"):
                words = text.split()
                masked = f"{words[0]} [PERSON_1] {words[-1]}"
                STORE[masked] = text
                text = masked
        elif mode != "norestore":
            text = STORE.get(text, text)
        self.reply(200, {"text": text})

    def reply(self, code: int, payload: dict) -> None:
        """Пишет JSON-ответ."""
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args: object) -> None:
        """Без журнала."""


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
Path(sys.argv[2]).write_text(str(server.server_address[1]))
server.serve_forever()
PY
echo new >"$TMP/fake-mode"
python3 -I "$TMP/fake-pseudo.py" "$TMP/fake-mode" "$TMP/fake-port" "$SECRET_TOKEN" &
SERVER_PID=$!
for ((i = 0; i < SERVER_WAIT_S * 10; i++)); do
  [[ -s "$TMP/fake-port" ]] && break
  sleep 0.1
done
PORT="$(cat "$TMP/fake-port")"
for mode in new busy; do
  echo "$mode" >"$TMP/fake-mode"
  reset_stand
  STUB_REAL_PY_PORT="$PORT" run "probe-$mode"
  assert "настоящая проба, режим $mode: код 0" \
    "[[ $RC -eq 0 ]] && out_has probe-$mode 'version=1.3.0 masked=yes restored=yes'"
done
assert "настоящая проба: значения пары не печатаются" \
  "! grep -qE 'Смирнов|Иванов' '$TMP/out-probe-new'"
echo old >"$TMP/fake-mode"
STUB_REAL_PY_PORT="$PORT" fail_case probe-oldmode "настоящая проба: без маскирования" \
  "masked=no restored=no"
echo norestore >"$TMP/fake-mode"
STUB_REAL_PY_PORT="$PORT" fail_case probe-norestore "настоящая проба: без восстановления" \
  "masked=yes restored=no"
echo new >"$TMP/fake-mode"
echo '__version__ = "1.1.4"' >"$TMP/fakepii/labops_pii/__init__.py"
STUB_REAL_PY_PORT="$PORT" fail_case probe-oldlib "настоящая проба: версия 1.1.4" "version=1.1.4"
}

# Группы независимы: у каждой свой каталог (дерево, пакет, память заглушки, вывод), поэтому
# они идут параллельно. Группа, не дошедшая до конца, считается провалом.
GROUPS_ALL=(package battle vars pre success volume mask failfirst failsecond stuckprobe)
JOBS="${PATCH9W_TEST_JOBS:-$(nproc)}"
ROOT_TMP="$TMP"
run_group() { # run_group <имя>
  TMP="$ROOT_TMP/g-$1"
  mkdir -p "$TMP"
  LIVE_ROOT="$TMP/opt/pragmatika-v2"
  LIVE="$LIVE_ROOT/deploy"
  PKG="$TMP/pkg"
  "group_$1"
  [[ -z "$SERVER_PID" ]] || kill "$SERVER_PID" 2>/dev/null || true
  echo "GROUP-DONE"
}
for group in "${GROUPS_ALL[@]}"; do
  while (($(jobs -rp | wc -l) >= JOBS)); do wait -n || true; done
  (
    trap '[[ -z "$SERVER_PID" ]] || kill "$SERVER_PID" 2>/dev/null || true' EXIT
    run_group "$group"
  ) >"$ROOT_TMP/g-$group.log" 2>&1 &
done
wait
for group in "${GROUPS_ALL[@]}"; do
  grep -v '^GROUP-DONE$' "$ROOT_TMP/g-$group.log" || true
  PASS=$((PASS + $(grep -c '^PASS ' "$ROOT_TMP/g-$group.log" || true)))
  FAIL=$((FAIL + $(grep -c '^FAIL ' "$ROOT_TMP/g-$group.log" || true)))
  grep -qx 'GROUP-DONE' "$ROOT_TMP/g-$group.log" || bad "группа $group не дошла до конца"
done

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
((FAIL == 0))
