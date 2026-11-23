#!/usr/bin/env bash
# Тест deploy/patch-9s/patch.sh (патч G9s: платформа остаётся 1.1.10, катится ОДИН образ проекта
# pragmatika-app 1.1.10-pragmatika.2, образ documents не меняется; из файлов дерева заменяются
# images.lock и compose.project.yml с тремя новыми переменными app: CHAT_ATTACHMENTS_STORE_ENABLED
# (по умолчанию true, false - выключатель), CHAT_ATTACHMENTS_RETENTION_DAYS (30) и
# CHAT_ATTACHMENTS_MAX_BYTES (3221225472)) без настоящего Docker: вместо docker - заглушка с
# памятью о контейнерах, их образах, окружении, монтированиях и времени старта (в том числе пробы
# /health, /ready и POST /docx/pages, `compose config --format json` и docker exec пробы тома
# приёма). Проверяются отказы по предусловиям (бой не тронут, код 3), в том числе «патч G9r не
# применён» (версия lock, платформа и её копия, образы, переменные G9r, G9q3, G9q2, G9q, G9p, G8z
# и G8w у app, флаги G8x у documents; подсказка «сначала примените патч G9r»), чужой ключ lock
# (в том числе образ documents), lock без смены образа app, чужой файл deploy/ в пакете, нет
# переменных CHAT_ATTACHMENTS_* в compose.project.yml пакета или иное умолчание, значение из .env
# боя недопустимо, значение не равно эффективному (из .env боя, иначе умолчание) или иное
# различие в конфигурации compose (в том числе у documents, его образ обязан остаться прежним) и
# повторный запуск; устойчивость сравнения конфигураций к каталогу рендера; том приёма до
# замены (нет INTAKE_ROOT, нет монтирования intake-data, нет записи); нехватка диска (порог 4096
# МиБ по умолчанию) и памяти; --preflight-only (дерево побайтно прежнее); успешный ход (documents
# не пересоздаётся, app пересоздаётся один раз; образы, четыре флага G8x, проба /docx/pages, три
# новые переменные, проба тома: подкаталог создаётся, чужих записей нет; явное выключение
# хранения в .env боя не отказ, .env не меняется, подкаталог не создаётся); разные ответы пробы
# /docx/pages; сбои на каждом шаге с автооткатом (код 1, дерево побайтно прежнее, app на образе
# G9r, documents не тронут), в том числе том приёма недоступен после замены; невозможный откат
# (код 4); ручной --rollback; настоящий JS пробы /docx/pages и пробы тома (если на хосте есть bun);
# в журнале нет содержимого тома, имён файлов и .env; стиль. Ход на настоящем Docker проверяет
# tools/patch-9s-synth.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$ROOT/deploy/patch-9s"
TMP="${PATCH9S_TEST_TMP:-$(mktemp -d)}"
SERVER_PID=""
# PATCH9S_TEST_KEEP=1 оставляет рабочий каталог теста (выводы и журналы запусков) для разбора.
cleanup() {
  [[ -z "$SERVER_PID" ]] || kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "${PATCH9S_TEST_KEEP:-}" ]] || rm -rf "${TMP:?}"
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
VER_FROM="1.1.10-pragmatika.1"
VER_TO="1.1.10-pragmatika.2"
PLATFORM_VER="1.1.10"
# Новые переменные app G9s и их умолчания (при смене имён править только эти строки).
NEW_STORE="CHAT_ATTACHMENTS_STORE_ENABLED"
NEW_DAYS="CHAT_ATTACHMENTS_RETENTION_DAYS"
NEW_BYTES="CHAT_ATTACHMENTS_MAX_BYTES"
DEF_STORE="true"
DEF_DAYS="30"
DEF_BYTES="3221225472"
NEW_NAMES=("$NEW_STORE" "$NEW_DAYS" "$NEW_BYTES")
NEW_LINE="$NEW_STORE=$DEF_STORE $NEW_DAYS=$DEF_DAYS $NEW_BYTES=$DEF_BYTES"
# Переменные app, уже стоящие на бою после G9r и прежних патчей (не переменные этого патча):
# имя=умолчание. Группы нужны для проверок отказа «G9r не применён» и потери при замене app.
G9R_VARS_LIST=(B24_CALL_RECORDING_MAX_BYTES B24_CALL_RECORDING_TIMEOUT_MS)
G9Q3_VARS_LIST=(PRICE_FILE_ONCE_PER_TURN_ENABLED STEP_TEXT_SEPARATE_ENABLED)
G9Q2_VARS_LIST=(EMPTY_REPLY_GUARD_ENABLED)
G9Q_VARS_LIST=(PRICE_EDIT_DB_WRITE_ENABLED PRICE_EDIT_TEXT_BLOCKS_ENABLED)
G9P_VARS_LIST=(PRICE_EDIT_FIRST_ENABLED DOCX_PAGES_ENABLED)
G8Z_VARS_LIST=(SHORTLIST_PAGING_ENABLED SUPPLIER_DISCOVERY_ENABLED)
G8W_VARS_LIST=(YANDEX_SEARCH_MAX_CONCURRENCY YANDEX_SEARCH_MIN_INTERVAL_MS)
KEEP_VARS_LIST=("${G9R_VARS_LIST[@]}" "${G9Q3_VARS_LIST[@]}" "${G9Q2_VARS_LIST[@]}"
  "${G9Q_VARS_LIST[@]}" "${G9P_VARS_LIST[@]}" "${G8Z_VARS_LIST[@]}" "${G8W_VARS_LIST[@]}")
INTAKE_ROOT_PATH="/var/lib/pragmatika/intake"
H_OLD_APP="1111111111111111111111111111111111111111111111111111111111111111"
H_NEW_APP="2222222222222222222222222222222222222222222222222222222222222222"
H_BASE="3333333333333333333333333333333333333333333333333333333333333333"
H_BASE2="4444444444444444444444444444444444444444444444444444444444444444"
H_DOCS="5555555555555555555555555555555555555555555555555555555555555555"
H_DBASE="6666666666666666666666666666666666666666666666666666666666666666"
H_ALLOY="7777777777777777777777777777777777777777777777777777777777777777"
H_ALLOY2="8888888888888888888888888888888888888888888888888888888888888888"
H_MASK="9999999999999999999999999999999999999999999999999999999999999999"
# Секрет только в окружении контейнера app и в выводе compose config (короче порога маскирования
# журнала): если он попал в журнал или архив, значит, патч печатает окружение или конфигурацию.
APP_ENV_SECRET="TOPSEC1"
FILE_SECRET="live-secret-token-0123456789"
# Метка в теле ответа documents: если она попала в журнал, патч печатает тело ответа пробы.
BODY_MARK="LEAKMARK-body-7731"
# Метка в «содержимом тома»: заглушка docker exec печатает её лишней строкой; если она попала в
# журнал или архив, патч печатает вывод пробы тома целиком.
INTAKE_MARK="LEAKMARK-intake-file-4471"
# Изменяющие команды docker: при отказе не должна появиться ни одна (одноразовые пробы без сети
# и пробы /ready, /health в сети app допустимы: они ничего не меняют; docker exec - проба тома).
MUTATING_RE='^(create|rm|stop|kill|start|restart|load|pull|volume|network|compose .*up)'

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# --- Заглушка docker ---------------------------------------------------------------------------
# Память стенда: $STUB/containers (имя<TAB>образ), $STUB/env/<имя> (окружение контейнера),
# $STUB/started/<имя> (StartedAt), $STUB/intake.log (пробы тома), журнал вызовов в $DOCKER_LOG.
# Ручки сбоев - STUB_* (ниже).
BIN="$TMP/bin"
mkdir -p "$BIN"
cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_LOG"
# Что видит docker из оболочечных переменных новых и прежних переменных app: патч обязан их
# сбросить (шестнадцать полей: три новые и тринадцать прежних).
echo "${!NEW_STORE-<unset>} ${!NEW_DAYS-<unset>} ${!NEW_BYTES-<unset>}" \
  "${B24_CALL_RECORDING_MAX_BYTES-<unset>} ${B24_CALL_RECORDING_TIMEOUT_MS-<unset>}" \
  "${PRICE_FILE_ONCE_PER_TURN_ENABLED-<unset>} ${STEP_TEXT_SEPARATE_ENABLED-<unset>}" \
  "${EMPTY_REPLY_GUARD_ENABLED-<unset>} ${PRICE_EDIT_DB_WRITE_ENABLED-<unset>}" \
  "${PRICE_EDIT_TEXT_BLOCKS_ENABLED-<unset>} ${PRICE_EDIT_FIRST_ENABLED-<unset>}" \
  "${DOCX_PAGES_ENABLED-<unset>} ${SHORTLIST_PAGING_ENABLED-<unset>}" \
  "${SUPPLIER_DISCOVERY_ENABLED-<unset>} ${YANDEX_SEARCH_MAX_CONCURRENCY-<unset>}" \
  "${YANDEX_SEARCH_MIN_INTERVAL_MS-<unset>}" >>"$STUB/shellenv.log"
# Прежние переменные app (ИМЯ=умолчание): всегда есть у app и в конфигурации боя.
KEEP_PAIRS="YANDEX_SEARCH_MAX_CONCURRENCY=1 YANDEX_SEARCH_MIN_INTERVAL_MS=1200 \
SHORTLIST_PAGING_ENABLED=true SUPPLIER_DISCOVERY_ENABLED=true PRICE_EDIT_FIRST_ENABLED=true \
DOCX_PAGES_ENABLED=true PRICE_EDIT_DB_WRITE_ENABLED=true PRICE_EDIT_TEXT_BLOCKS_ENABLED=true \
EMPTY_REPLY_GUARD_ENABLED=true PRICE_FILE_ONCE_PER_TURN_ENABLED=true \
STEP_TEXT_SEPARATE_ENABLED=true B24_CALL_RECORDING_MAX_BYTES=104857600 \
B24_CALL_RECORDING_TIMEOUT_MS=600000"
# Новые переменные app G9s (ИМЯ=умолчание).
NEW_PAIRS="$NEW_STORE=$DEF_STORE $NEW_DAYS=$DEF_DAYS $NEW_BYTES=$DEF_BYTES"
set_image() { # set_image <имя> <образ>: заменить или добавить строку контейнера
  grep -v "^$1"$'\t' "$STUB/containers" >"$STUB/containers.n" || true
  printf '%s\t%s\n' "$1" "$2" >>"$STUB/containers.n"
  mv "$STUB/containers.n" "$STUB/containers"
}
lock_ref() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2-; }
# Эффективное значение переменной для заглушки: из .env, затем secrets.env дерева (без кавычек),
# пусто - умолчание.
stub_var() { # stub_var <каталог deploy> <ИМЯ> <умолчание>
  local v
  v="$(cat "$1/.env" "$1/secrets.env" 2>/dev/null | sed -n "s/^$2=//p" | tail -1 \
    | tr -d "\"'")"
  echo "${v:-$3}"
}
bump_started() { # bump_started <имя>: новое время старта контейнера
  local n
  n="$(cat "$STUB/counter" 2>/dev/null || echo 0)"
  n=$((n + 1))
  echo "$n" >"$STUB/counter"
  printf '2026-11-22T10:00:%02dZ\n' "$n" >"$STUB/started/$1"
}
app_is_new() { grep "^p-app-1"$'\t' "$STUB/containers" | grep -q "$H_NEW_APP"; }
# Ответ пробы /docx/pages: образ documents с ручкой (G9p и далее одинаково) - «422 bad_request»;
# образ без ручки (его в этом патче нет, ручка STUB_PAGES_OLD_BEHAVIOR его имитирует) - «404 -».
# Статус и код ошибки настраиваются.
pages_reply() {
  local old=0
  if [[ "${STUB_PAGES_DOWN:-0}" == 1 ]]; then echo "documents недоступен: refused"; exit 1; fi
  [[ "${STUB_PAGES_OLD_BEHAVIOR:-0}" != 1 ]] || old=1
  if [[ "${STUB_PAGES_APP_STAGE_FAIL:-0}" == 1 ]] && app_is_new; then old=1; fi
  if ((old)); then
    echo "${STUB_PAGES_OLD_REPLY:-404 -}"
  else
    echo "${STUB_PAGES_CODE:-422} ${STUB_PAGES_ERR-bad_request}"
  fi
  exit 0
}
# Конфигурация compose одним JSON. Новые переменные app есть, только если они в compose.project.yml
# дерева (новый файл), значение - от .env дерева (иначе умолчание); прежние переменные есть всегда
# (бой после G9r); ручки STUB_CFG_* портят только конфигурацию с новым файлом (STUB_CFG_DRIFT_VAR -
# имя прежней переменной с иным значением, STUB_CFG_NEWVAL=ИМЯ=значение - иное значение новой,
# STUB_CFG_NEWDROP=ИМЯ - новой переменной нет). Образ documents берётся из lock дерева (он
# одинаков у боя и примерки). Как настоящий compose, пути раскрываются от каталога файлов: том
# app лежит под deploy, а контекст сборки app и том migrate - ВЫШЕ deploy (`../..`), то есть
# зависят от корня дерева (боевого или примерки): проверка нормализации корня.
config_json() { # config_json <каталог deploy> <lock>
  local dir="$1" lock="$2" newvars=0 mem=1g pptx=true pg=r/postgres@sha256:pg
  local root ctx vol docs_ref pair name val
  root="$(dirname "$dir")"
  ctx="$root"
  vol="$root/db/app"
  grep -q "$NEW_STORE" "$dir/compose.project.yml" 2>/dev/null && newvars=1
  if ((newvars == 0)) && [[ "${STUB_LIVE_CFG_FAIL:-0}" == 1 ]]; then exit 1; fi
  [[ "${STUB_CFG_BAD_JSON:-0}" != 1 ]] || { echo '{"services":'; exit 0; }
  if ((newvars)); then
    [[ "${STUB_CFG_APP_DRIFT:-0}" != 1 ]] || mem=2g
    [[ "${STUB_CFG_DOCS_DRIFT:-0}" != 1 ]] || pptx=false
    [[ "${STUB_CFG_OTHER_DRIFT:-0}" != 1 ]] || pg=r/postgres@sha256:other
    [[ "${STUB_CFG_CONTEXT_DRIFT:-0}" != 1 ]] || ctx=/elsewhere/src
    [[ "${STUB_CFG_PATH_DRIFT:-0}" != 1 ]] || vol=/elsewhere/db/app
  fi
  docs_ref="$(lock_ref "$lock" BAI_IMAGE_DOCUMENTS)"
  if ((newvars)) && [[ "${STUB_CFG_DOCS_IMAGE_DRIFT:-0}" == 1 ]]; then
    docs_ref="r/pragmatika-documents@sha256:other"
  fi
  echo "context $ctx" >>"$STUB/cfg-roots.log"
  printf '{"name":"p","services":{'
  if [[ "${STUB_CFG_NO_APP:-0}" != 1 ]]; then
    printf '"app":{"image":"%s","mem_limit":"%s",' "$(lock_ref "$lock" BAI_IMAGE_APP)" "$mem"
    printf '"build":{"context":"%s"},' "$ctx"
    printf '"volumes":[{"type":"bind","source":"%s/nginx.conf"}],' "$dir"
    printf '"environment":{"OPENAI_API_KEY":"%s"' "$APP_ENV_SECRET"
    for pair in $KEEP_PAIRS; do
      name="${pair%%=*}"
      val="$(stub_var "$dir" "$name" "${pair#*=}")"
      if ((newvars)) && [[ "${STUB_CFG_DRIFT_VAR:-}" == "$name" ]]; then val=changed; fi
      printf ',"%s":"%s"' "$name" "$val"
    done
    if ((newvars)); then
      for pair in $NEW_PAIRS; do
        name="${pair%%=*}"
        [[ "${STUB_CFG_NEWDROP:-}" != "$name" ]] || continue
        val="$(stub_var "$dir" "$name" "${pair#*=}")"
        if [[ "${STUB_CFG_NEWVAL:-}" == "$name="* ]]; then val="${STUB_CFG_NEWVAL#*=}"; fi
        printf ',"%s":"%s"' "$name" "$val"
      done
    fi
    printf '}},'
  fi
  printf '"documents":{"image":"%s","environment":{"DOCUMENTS_EDIT_PPTX":"%s",' \
    "$docs_ref" "$pptx"
  printf '"DOCUMENTS_EDIT_PDF":"true","DOCUMENTS_PPT_CONVERT":"true",'
  printf '"DOCUMENTS_EDIT_PDF_FALLBACK_FONT":"false"}},'
  printf '"migrate":{"volumes":[{"type":"bind","source":"%s"}]},' "$vol"
  printf '"postgres":{"image":"%s"}}}\n' "$pg"
}
# Окружение app после up: прочее сохраняется, переменные патчей и INTAKE_ROOT собираются заново
# из compose.project.yml дерева. STUB_APP_LOSE=ИМЯ,ИМЯ - прежние переменные пропадают (только на
# новом образе), STUB_APP_NO_NEWVARS=1 - новых нет, STUB_ENV_OVERRIDE=ИМЯ=значение - иное
# значение новой переменной, STUB_APP_INTAKE_ROOT_AFTER - иной INTAKE_ROOT на новом образе.
recreate_env() { # recreate_env <каталог deploy> <новый образ: 0|1>
  local dir="$1" newimg="$2" pair name val
  local re='^(YANDEX_|SHORTLIST_|SUPPLIER_DISCOVERY_|PRICE_|DOCX_PAGES_|EMPTY_REPLY_GUARD_'
  re+='|STEP_TEXT_|B24_CALL_|CHAT_ATTACHMENTS_|INTAKE_ROOT=)'
  grep -vE "$re" "$STUB/env/p-app-1" >"$STUB/env/p-app-1.n" || true
  for pair in $KEEP_PAIRS; do
    name="${pair%%=*}"
    if ((newimg)) && [[ ",${STUB_APP_LOSE:-}," == *",$name,"* ]]; then continue; fi
    echo "$name=$(stub_var "$dir" "$name" "${pair#*=}")" >>"$STUB/env/p-app-1.n"
  done
  if ((newimg)); then
    echo "INTAKE_ROOT=${STUB_APP_INTAKE_ROOT_AFTER:-$INTAKE_ROOT_PATH}" >>"$STUB/env/p-app-1.n"
  else
    echo "INTAKE_ROOT=$INTAKE_ROOT_PATH" >>"$STUB/env/p-app-1.n"
  fi
  if grep -q "$NEW_STORE" "$dir/compose.project.yml" 2>/dev/null \
    && [[ "${STUB_APP_NO_NEWVARS:-0}" != 1 ]]; then
    for pair in $NEW_PAIRS; do
      name="${pair%%=*}"
      val="$(stub_var "$dir" "$name" "${pair#*=}")"
      if [[ "${STUB_ENV_OVERRIDE:-}" == "$name="* ]]; then val="${STUB_ENV_OVERRIDE#*=}"; fi
      echo "$name=$val" >>"$STUB/env/p-app-1.n"
    done
  fi
  mv "$STUB/env/p-app-1.n" "$STUB/env/p-app-1"
}
case "$1" in
  compose)
    lock="$(printf '%s\n' "$@" | grep -m1 'images.lock$' || true)"
    dir="$(dirname "${lock:-/nonexistent/x}")"
    case " $* " in
      *" version "*) echo "2.40.3" ;;
      *" config "*"--format json"*) config_json "$dir" "$lock" ;;
      *" config "*) exit "${STUB_CONFIG_RC:-0}" ;;
      *" up "*)
        touch "$STUB/started-any"
        svc="${*: -1}"
        case "$svc" in
          documents)
            # Патч G9s documents не пересоздаёт: заглушка только фиксирует такой up (тест
            # проверяет, что их ноль), образ берётся из lock, окружение остаётся прежним.
            set_image p-documents-1 "$(lock_ref "$lock" BAI_IMAGE_DOCUMENTS)"
            bump_started p-documents-1 ;;
          app)
            ref="$(lock_ref "$lock" BAI_IMAGE_APP)"
            newimg=0
            if [[ "$ref" == *"$H_NEW_APP"* ]]; then
              newimg=1
              [[ "${STUB_UP_FAIL:-0}" != 1 ]] || { echo "compose: ошибка up" >&2; exit 1; }
              [[ "${STUB_WRONG_APP_IMAGE:-0}" != 1 ]] || ref="r/app@sha256:wrong"
            fi
            set_image p-app-1 "$ref"
            bump_started p-app-1
            recreate_env "$dir" "$newimg"
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
      *"range .Mounts"*)
        [[ -n "$img" ]] || exit 1
        # Монтирования app: том приёма по пути INTAKE_ROOT (ручки STUB_NO_MOUNT,
        # STUB_NO_MOUNT_AFTER, STUB_MOUNT_NAME), прочие тома. Имён файлов тома заглушка не знает.
        echo "/var/lib/pragmatika/spool pragmatika_file-spool"
        if [[ "${STUB_NO_MOUNT:-0}" == 1 ]]; then
          :
        elif [[ "${STUB_NO_MOUNT_AFTER:-0}" == 1 ]] && app_is_new; then
          :
        else
          echo "$INTAKE_ROOT_PATH ${STUB_MOUNT_NAME-pragmatika_intake-data}"
        fi ;;
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
        if [[ "${STUB_DOCS_EXITED:-0}" == 1 && "$name" == p-documents-1 ]]; then
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
    # Единственный разрешённый docker exec - проба тома приёма в app: переменные
    # PATCH_INTAKE_ROOT, PATCH_INTAKE_SUB, PATCH_INTAKE_CREATE и `bun -e <JS>`. Заглушка пишет
    # в $STUB/intake.log «режим корень подкаталог» и отвечает одной строкой (до замены и после
    # замены ответы настраиваются отдельно); STUB_INTAKE_NOISE=1 добавляет «содержимое тома».
    iroot="" isub="" icreate=""
    for a in "$@"; do
      case "$a" in
        PATCH_INTAKE_ROOT=*) iroot="${a#*=}" ;;
        PATCH_INTAKE_SUB=*) isub="${a#*=}" ;;
        PATCH_INTAKE_CREATE=*) icreate="${a#*=}" ;;
      esac
    done
    if app_is_new; then stage=after; else stage=before; fi
    printf '%s create=%s root=%s sub=%s\n' "$stage" "$icreate" "$iroot" "$isub" \
      >>"$STUB/intake.log"
    [[ "${STUB_INTAKE_EXEC_FAIL:-0}" != 1 ]] || { echo "OCI runtime exec failed" >&2; exit 1; }
    if [[ "${STUB_INTAKE_NOISE:-0}" == 1 ]]; then
      echo "$INTAKE_MARK"
      echo "$INTAKE_MARK" >&2
    fi
    # Настоящий JS пробы против каталога на диске хоста (нужен bun).
    if [[ -n "${STUB_REAL_INTAKE_DIR:-}" ]]; then
      PATCH_INTAKE_ROOT="$STUB_REAL_INTAKE_DIR" PATCH_INTAKE_SUB="$isub" \
        PATCH_INTAKE_CREATE="$icreate" bun -e "${*: -1}"
      exit 0
    fi
    if [[ "$stage" == after ]]; then
      echo "${STUB_INTAKE_AFTER_REPLY:-ok 0}"
    else
      echo "${STUB_INTAKE_BEFORE_REPLY:-ok 0}"
    fi ;;
  run)
    if [[ "$*" == *"bun"* ]]; then
      [[ "${STUB_NO_READY:-0}" != 1 ]] || { echo "app недоступен"; exit 1; }
      # Откат не удался: после первого up стенд больше не отвечает
      if [[ "${STUB_STUCK:-0}" == 1 && -e "$STUB/started-any" ]]; then
        echo "app недоступен"; exit 1
      fi
      case "$*" in
        *"/docx/pages"*)
          # Настоящий JS пробы против локального сервера (тест разбора ответа).
          if [[ -n "${STUB_REAL_JS_URL:-}" ]]; then
            body="$(printf '%s\n' "$@" | sed -n 's/^PATCH_PAGES_BODY=//p')"
            PATCH_DOCS_URL="$STUB_REAL_JS_URL" PATCH_PAGES_BODY="$body" bun -e "${*: -1}"
            exit $?
          fi
          pages_reply ;;
        *"/health"*)
          if [[ "${STUB_DOCS_HEALTH_500:-0}" == 1 ]]; then
            echo '500 {}'; exit 1
          fi
          if [[ "${STUB_DOCS_HEALTH_500_APP:-0}" == 1 ]] && app_is_new; then
            echo '500 {}'; exit 1
          fi
          echo '200 {}'; exit 0 ;;
      esac
      if [[ "${STUB_READY_500:-0}" == 1 ]] && app_is_new; then
        echo '500 {"bots":{"ready":0}}'; exit 1
      fi
      bots="${STUB_BOTS:-4}"
      if app_is_new; then bots="${STUB_BOTS_NEW:-$bots}"; fi
      echo "200 {\"bots\":{\"ready\":$bots}}"
    fi ;;
esac
exit 0
STUB
chmod +x "$BIN/docker"
printf '#!/usr/bin/env bash\nexit "${STUB_COSIGN_RC:-0}"\n' >"$BIN/cosign-stub"
chmod +x "$BIN/cosign-stub"

# --- Боевое дерево (после G9r), пакет и заглушки инструментов -----------------------------------
LIVE_ROOT="$TMP/opt/pragmatika-v2"
LIVE="$LIVE_ROOT/deploy"
GOLDEN="$TMP/golden"
PKG="$TMP/pkg"
PKGG="$TMP/pkg-golden"
OLD_APP="r/app@sha256:$H_OLD_APP"
NEW_APP="r/app@sha256:$H_NEW_APP"
DOCS="r/pragmatika-documents@sha256:$H_DOCS"
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
# compose.project.yml боя после G9r (без новых переменных) и пакета G9s (с ними): прежние
# переменные app (кроме записи звонка: она приходит из платформы) и четыре флага documents.
write_compose() { # write_compose <файл> <с новыми переменными: 0|1> [умолчание хранения]
  local pair
  {
    printf 'services:\n  app:\n    environment:\n'
    for pair in YANDEX_SEARCH_MAX_CONCURRENCY=1 YANDEX_SEARCH_MIN_INTERVAL_MS=1200 \
      SHORTLIST_PAGING_ENABLED=true SUPPLIER_DISCOVERY_ENABLED=true PRICE_EDIT_FIRST_ENABLED=true \
      DOCX_PAGES_ENABLED=true PRICE_EDIT_DB_WRITE_ENABLED=true \
      PRICE_EDIT_TEXT_BLOCKS_ENABLED=true EMPTY_REPLY_GUARD_ENABLED=true \
      PRICE_FILE_ONCE_PER_TURN_ENABLED=true STEP_TEXT_SEPARATE_ENABLED=true; do
      printf '      %s: ${%s:-%s}\n' "${pair%%=*}" "${pair%%=*}" "${pair#*=}"
    done
    if (($2)); then
      printf '      %s: ${%s:-%s}\n' "$NEW_STORE" "$NEW_STORE" "${3:-$DEF_STORE}"
      printf '      %s: ${%s:-%s}\n' "$NEW_DAYS" "$NEW_DAYS" "${4:-$DEF_DAYS}"
      printf '      %s: ${%s:-%s}\n' "$NEW_BYTES" "$NEW_BYTES" "${5:-$DEF_BYTES}"
    fi
    printf '  documents:\n    environment:\n'
    printf '      DOCUMENTS_EDIT_PPTX: ${DOCUMENTS_EDIT_PPTX:-true}\n'
    printf '      DOCUMENTS_EDIT_PDF: ${DOCUMENTS_EDIT_PDF:-true}\n'
    printf '      DOCUMENTS_PPT_CONVERT: ${DOCUMENTS_PPT_CONVERT:-true}\n'
    printf '      DOCUMENTS_EDIT_PDF_FALLBACK_FONT: ${DOCUMENTS_EDIT_PDF_FALLBACK_FONT:-false}\n'
  } >"$1"
}
# Копия платформы 1.1.10 боя: файл с переменными платформы (запись звонка Bitrix24).
write_platform_base() { # write_platform_base <файл>
  {
    echo "services:"
    echo "  app:"
    echo "    environment:"
    echo '      B24_CALL_RECORDING_MAX_BYTES: ${B24_CALL_RECORDING_MAX_BYTES:-104857600}'
    echo '      B24_CALL_RECORDING_TIMEOUT_MS: ${B24_CALL_RECORDING_TIMEOUT_MS:-600000}'
  } >"$1"
}
mkdir -p "$GOLDEN/platform" "$GOLDEN/hotfix" "$PKGG/tools" "$PKGG/deploy"
# Основы app и documents у G9r и G9s одни и те же; меняется только образ app (documents
# в обоих lock один и тот же).
write_lock "$GOLDEN/images.lock" "$OLD_APP" "r/app-base@sha256:$H_BASE" "$DOCS" \
  "r/bai-documents@sha256:$H_DBASE" "$VER_FROM"
write_lock "$PKGG/images.lock" "$NEW_APP" "r/app-base@sha256:$H_BASE" "$DOCS" \
  "r/bai-documents@sha256:$H_DBASE" "$VER_TO"
echo "services: {}" >"$GOLDEN/compose.yml"
echo "MARK=old" >"$GOLDEN/compat.env"
write_compose "$GOLDEN/compose.project.yml" 0
write_compose "$PKGG/deploy/compose.project.yml" 1
write_platform_base "$GOLDEN/platform/compose.base.yml"
echo "PLATFORM_PACKAGES_VERSION=$PLATFORM_VER" >"$GOLDEN/platform/PLATFORM-VERSION"
printf 'POSTGRES_USER=pragmatika\nOPENAI_API_KEY=%s\n' "$FILE_SECRET" >"$GOLDEN/.env"
chmod 600 "$GOLDEN/.env"
echo "MASK_TOKEN=$FILE_SECRET-mask" >"$GOLDEN/secrets.mask.env"
chmod 600 "$GOLDEN/secrets.mask.env"
echo "#!/bin/true" >"$GOLDEN/hotfix/dc-v2.sh"
date -u +%FT%TZ >"$GOLDEN/.cutover-deployed"
cp "$ROOT/deploy/cutover/lib.sh" "$PKGG/lib.sh"
cp "$SRC/patch.sh" "$PKGG/patch.sh"
cp "$ROOT/tools/route-flags.tsv" "$PKGG/tools/route-flags.tsv"
printf 'documents\tPOST\t/docx/pages\troute\n' >"$PKGG/routes.tsv"

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
  printf 'verified_at=2026-11-22T08:00:00Z\n' >>"$1"
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

reset_stand() { # reset_stand: бой «после G9r» (дерево, контейнеры, окружение), пакет как собран
  STUB="$TMP/stub"
  rm -rf "${STUB:?}" "${LIVE_ROOT:?}"
  mkdir -p "$STUB/env" "$STUB/started" "$LIVE_ROOT"
  cp -a "$GOLDEN" "$LIVE"
  printf '%s\t%s\n' "p-postgres-1" "r/postgres@sha256:pg" \
    "p-documents-1" "$DOCS" "p-alloy-1" "r/alloy@sha256:$H_ALLOY" \
    "p-app-1" "$OLD_APP" >"$STUB/containers"
  local name pair
  for name in p-postgres-1 p-documents-1 p-alloy-1 p-app-1; do
    echo "2026-11-18T08:00:00Z" >"$STUB/started/$name"
    echo "PATH=/usr/bin" >"$STUB/env/$name"
  done
  printf 'DOCUMENTS_URL=http://documents:8310\nOPENAI_API_KEY=%s\n' "$APP_ENV_SECRET" \
    >>"$STUB/env/p-app-1"
  printf 'INTAKE_ROOT=%s\n' "$INTAKE_ROOT_PATH" >>"$STUB/env/p-app-1"
  for pair in YANDEX_SEARCH_MAX_CONCURRENCY=1 YANDEX_SEARCH_MIN_INTERVAL_MS=1200 \
    SHORTLIST_PAGING_ENABLED=true SUPPLIER_DISCOVERY_ENABLED=true PRICE_EDIT_FIRST_ENABLED=true \
    DOCX_PAGES_ENABLED=true PRICE_EDIT_DB_WRITE_ENABLED=true \
    PRICE_EDIT_TEXT_BLOCKS_ENABLED=true EMPTY_REPLY_GUARD_ENABLED=true \
    PRICE_FILE_ONCE_PER_TURN_ENABLED=true STEP_TEXT_SEPARATE_ENABLED=true \
    B24_CALL_RECORDING_MAX_BYTES=104857600 B24_CALL_RECORDING_TIMEOUT_MS=600000; do
    echo "$pair" >>"$STUB/env/p-app-1"
  done
  printf 'DOCUMENTS_EDIT_PPTX=true\nDOCUMENTS_EDIT_PDF=true\nDOCUMENTS_PPT_CONVERT=true\n' \
    >>"$STUB/env/p-documents-1"
  printf 'DOCUMENTS_EDIT_PDF_FALLBACK_FONT=false\n' >>"$STUB/env/p-documents-1"
  : >"$STUB/missing"
  : >"$STUB/shellenv.log"
  : >"$STUB/intake.log"
  reset_pkg
}

# Хэши и права всех файлов боевого дерева: «побайтно прежнее» = равенство снимков.
tree_snapshot() { (cd "$LIVE" && find . -type f | sort | xargs -d '\n' sha256sum \
  && find . -type f -printf '%m %p\n' | sort); }
# Хэши файлов дерева, КРОМЕ images.lock и compose.project.yml: патч G9s их менять не вправе.
tree_without_patched() { (cd "$LIVE" && find . -type f ! -name 'images.lock' \
  ! -name 'compose.project.yml' | sort | xargs -d '\n' sha256sum); }

# run <имя> [аргументы patch.sh]: изолированный $HOME (T_HOME - общий для запусков); код в RC,
# вывод в $TMP/out-<имя>.
run() {
  local name="$1" home="${T_HOME:-$1}"
  shift
  : >"$TMP/docker-$name.log"
  : >"$STUB/intake.log"
  mkdir -p "$TMP/home-$home"
  RC=0
  env HOME="$TMP/home-$home" PATH="$BIN:$PATH" DOCKER_LOG="$TMP/docker-$name.log" STUB="$STUB" \
    TMP_DOCKER_ROOT="$TMP" H_NEW_APP="$H_NEW_APP" \
    APP_ENV_SECRET="$APP_ENV_SECRET" NEW_STORE="$NEW_STORE" NEW_DAYS="$NEW_DAYS" \
    NEW_BYTES="$NEW_BYTES" DEF_STORE="$DEF_STORE" DEF_DAYS="$DEF_DAYS" DEF_BYTES="$DEF_BYTES" \
    INTAKE_ROOT_PATH="$INTAKE_ROOT_PATH" INTAKE_MARK="$INTAKE_MARK" \
    CUTOVER_COSIGN="${TEST_COSIGN:-/nonexistent-cosign}" CUTOVER_NEW_DIR="$LIVE_ROOT" \
    CUTOVER_PROJECT=p CUTOVER_APP_CONTAINER=p-app-1 CUTOVER_ENV_FILE="$TMP/none.env" \
    CUTOVER_READY_WAIT_S=3 CUTOVER_POLL_S=1 CUTOVER_HEALTH_WAIT_S=3 \
    PATCH9S_MIN_DISK_MIB="${T_MIN_DISK:-1}" PATCH9S_MIN_AVAILABLE_MIB="${T_MIN_MEM:-1}" \
    PATCH9S_SOAK_POLL_S=1 \
    bash "$PKG/patch.sh" --soak-seconds 2 "$@" >"$TMP/out-$name" 2>&1 || RC=$?
}
no_mutation() { ! grep -E "$MUTATING_RE" "$TMP/docker-$1.log" | grep -qv '^compose version'; }
out_has() { grep -q -- "$2" "$TMP/out-$1"; }
app_up_count() { grep -cE '^compose .* up -d --no-deps app$' "$TMP/docker-$1.log" || true; }
docs_up_count() { grep -cE '^compose .* up -d --no-deps documents$' "$TMP/docker-$1.log" || true; }
# Любой compose up, кроме `up -d --no-deps app` (в том числе documents: G9s его не трогает).
other_up() { grep -E '^compose .* up ' "$TMP/docker-$1.log" | grep -vE ' up -d --no-deps app$'; }
pages_probe_count() { grep -c "fetch(base + '/docx/pages'" "$TMP/docker-$1.log" || true; }
# Число проб тома приёма (docker exec) в журнале заглушки; режим create=0/1.
exec_count() { grep -c '^exec ' "$TMP/docker-$1.log" || true; }
app_is_old() { grep -q "^p-app-1"$'\t'"$OLD_APP" "$STUB/containers"; }
app_is_new() { grep -q "^p-app-1"$'\t'"$NEW_APP" "$STUB/containers"; }
docs_is_old() { grep -q "^p-documents-1"$'\t'"$DOCS" "$STUB/containers"; }
# refuse_case <имя> <описание>: код 3, бой не тронут (нет изменяющих команд), дерево прежнее.
refuse_case() {
  assert "$2: код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
  assert "$2: бой не тронут" "no_mutation $1 && [[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
  assert "$2: подкаталог тома не создавался (проб с созданием нет)" \
    "! grep -q 'create=1' '$STUB/intake.log'"
}
# Все прежние переменные app (G9r, G9q3, G9q2, G9q, G9p, G8z, G8w) есть в окружении app заглушки.
keep_vars_present() {
  local n
  for n in "${KEEP_VARS_LIST[@]}"; do grep -q "^$n=" "$STUB/env/p-app-1" || return 1; done
}

assert "patch.sh на месте" "[[ -f '$SRC/patch.sh' ]]"
reset_stand
T0="$(tree_snapshot)"
W0="$(tree_without_patched)"

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

# Чужие ключи lock: основы app и documents, alloy, mask, образ documents. Патч меняет только
# образ app.
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
pkg_lock_edit "s|^BAI_VERSION=.*|BAI_VERSION=1.1.10-pragmatika.3|"
run pkgwrongver
refuse_case pkgwrongver "BAI_VERSION пакета не $VER_TO"
assert "версия пакета: сообщение называет $VER_TO" "out_has pkgwrongver '$VER_TO'"
reset_pkg
pkg_lock_edit "s|^BAI_VERSION=.*|BAI_VERSION=$VER_FROM|"
run pkgoldver
refuse_case pkgoldver "BAI_VERSION пакета равен версии боя ($VER_FROM)"
reset_pkg
pkg_lock_edit "s|^BAI_IMAGE_APP=.*|BAI_IMAGE_APP=$OLD_APP|"
run sameapp
refuse_case sameapp "lock пакета не меняет образ app"
assert "тот же образ app: сообщение называет ключ" "out_has sameapp 'BAI_IMAGE_APP'"
reset_pkg
pkg_lock_edit \
  "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=r/pragmatika-documents@sha256:$H_ALLOY2|"
run newdocs
refuse_case newdocs "lock пакета меняет образ documents (G9s катит только app)"
assert "другой образ documents: сообщение называет ключ" "out_has newdocs 'BAI_IMAGE_DOCUMENTS'"
reset_pkg
pkg_lock_edit "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=r/pragmatika-documents:latest|"
run docstag
refuse_case docstag "образ documents в lock пакета по тегу, не по digest"
reset_pkg
pkg_lock_edit '/^BAI_IMAGE_DOCUMENTS=/d'
run nodocslock
refuse_case nodocslock "в lock пакета нет BAI_IMAGE_DOCUMENTS"

# G9r не применён: разные признаки, подсказка «сначала примените патч G9r».
g9r_case() { # g9r_case <имя> <описание>: код 3, бой не тронут, подсказка в сообщении
  assert "$2: код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
  assert "$2: бой не тронут" "no_mutation $1 && [[ \"\$(tree_snapshot)\" == \"\$T1\" ]]"
  assert "$2: сообщение «сначала примените патч G9r»" "out_has $1 'сначала примените патч G9r'"
}
for old_ver in 1.1.6-pragmatika.7 1.1.10-pragmatika.0 1.1.9-pragmatika.1 1.1.6-pragmatika.6; do
  reset_stand
  sed -i "s|^BAI_VERSION=.*|BAI_VERSION=$old_ver|" "$LIVE/images.lock"
  T1="$(tree_snapshot)"
  run "lockver-$old_ver"
  g9r_case "lockver-$old_ver" "G9r не применён: BAI_VERSION боя $old_ver"
  assert "версия lock $old_ver: сообщение называет ожидаемую" \
    "out_has 'lockver-$old_ver' '$VER_FROM'"
done
reset_stand
echo "PLATFORM_PACKAGES_VERSION=1.1.6" >"$LIVE/platform/PLATFORM-VERSION"
T1="$(tree_snapshot)"
run platform116
g9r_case platform116 "G9r не применён: платформа боя 1.1.6"
reset_stand
rm -f "$LIVE/platform/PLATFORM-VERSION"
T1="$(tree_snapshot)"
run noplatform
g9r_case noplatform "G9r не применён: нет PLATFORM-VERSION"
reset_stand
echo "services: {}" >"$LIVE/platform/compose.base.yml"
T1="$(tree_snapshot)"
run oldbase
g9r_case oldbase "G9r не применён: копия платформы боя без переменных записи звонка"
assert "старая копия платформы: сообщение называет переменную" \
  "out_has oldbase 'B24_CALL_RECORDING_MAX_BYTES'"
reset_stand
sed -i "s|^p-app-1.*|p-app-1\tr/app@sha256:other|" "$STUB/containers"
T1="$(tree_snapshot)"
run appimage
g9r_case appimage "G9r не применён: app не на образе из lock боя"
reset_stand
sed -i "s|^p-documents-1.*|p-documents-1\tr/other-documents@sha256:other|" "$STUB/containers"
T1="$(tree_snapshot)"
run docsimage
g9r_case docsimage "G9r не применён: documents не на образе из lock боя"
# У запущенного app нет одной из переменных G9r, G9q3, G9q2, G9q, G9p, G8z или G8w (по одной).
for old_var in "${KEEP_VARS_LIST[@]}"; do
  reset_stand
  sed -i "/^$old_var=/d" "$STUB/env/p-app-1"
  T1="$(tree_snapshot)"
  run "no-$old_var"
  g9r_case "no-$old_var" "G9r не применён: у app нет переменной $old_var"
  assert "нет $old_var: сообщение называет её" "out_has 'no-$old_var' '$old_var'"
done
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
  g9r_case "flag-$flag-$how" "G9r не применён: флаг $flag ($how)"
  assert "флаг $flag ($how): сообщение называет флаг" "out_has 'flag-$flag-$how' '$flag'"
done

# Файлы дерева в пакете: разрешён только compose.project.yml; любой другой файл - отказ (код 3).
reset_stand
mkdir -p "$PKG/deploy/platform"
cp "$GOLDEN/platform/compose.base.yml" "$PKG/deploy/platform/compose.base.yml"
seal
run depbase
refuse_case depbase "в пакете deploy/platform/compose.base.yml (кроме compose.project.yml)"
assert "чужой файл deploy: сообщение называет файл" \
  "out_has depbase 'deploy/platform/compose.base.yml'"
reset_pkg
mkdir -p "$PKG/deploy/platform"
echo "PLATFORM_PACKAGES_VERSION=1.1.10" >"$PKG/deploy/platform/PLATFORM-VERSION"
seal
run depplatform
refuse_case depplatform "в пакете deploy/platform/PLATFORM-VERSION"
reset_pkg
cp "$PKG/images.lock" "$PKG/deploy/images.lock"
seal
run deplock
refuse_case deplock "в пакете deploy/images.lock (lock лежит только в корне пакета)"
reset_pkg
echo "x" >"$PKG/deploy/.env"
seal
run depenv
refuse_case depenv "в пакете deploy/.env"
reset_pkg
cp "$GOLDEN/compose.yml" "$PKG/deploy/compose.yml"
seal
run depcomposeyml
refuse_case depcomposeyml "в пакете deploy/compose.yml"
reset_pkg
cp "$GOLDEN/compat.env" "$PKG/deploy/compat.env"
seal
run depcompat
refuse_case depcompat "в пакете deploy/compat.env"
reset_pkg
rm -f "$PKG/deploy/compose.project.yml"
seal
run nodepcompose
refuse_case nodepcompose "в пакете нет deploy/compose.project.yml"
assert "нет compose.project.yml: сообщение называет файл" \
  "out_has nodepcompose 'compose.project.yml'"
reset_pkg
rm -rf "${PKG:?}/deploy"
seal
run nodeploy
refuse_case nodeploy "в пакете нет каталога deploy"
reset_pkg
mkdir -p "$PKG/deploy/platform"
seal
run depemptydir --preflight-only
assert "пустой подкаталог deploy/platform (без файлов) отказом не считается: preflight код 0" \
  "[[ $RC -eq 0 ]]"
reset_stand
mkdir -p "$PKG/db"
seal
run withdb
refuse_case withdb "в патче есть db"
reset_pkg
rm -f "$PKG/tools/check-routes.sh"
seal
run notools
refuse_case notools "в пакете нет инструментов проверки маршрутов"

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
assert "версия lock боя уже целевая: сообщение называет G9s" "out_has lockverto 'G9s'"

# Предусловия боя и хоста.
reset_stand
rm -f "$LIVE/.cutover-deployed"
T1="$(tree_snapshot)"
run nomark
assert "дерево создано не cutover.sh - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
cp "$GOLDEN/.cutover-deployed" "$LIVE/.cutover-deployed"
STUB_CONFIG_RC=1 run badconfig
refuse_case badconfig "compose config не принял новые файлы"
STUB_LIVE_CFG_FAIL=1 run livecfgfail
refuse_case livecfgfail "compose config боевого дерева не собрался (снимка нет)"
STUB_CFG_BAD_JSON=1 run badjson
refuse_case badjson "compose config отдал неразбираемый JSON"
STUB_CFG_NO_APP=1 run noappsvc
refuse_case noappsvc "в конфигурации нет сервиса app"

# Конфигурация compose: новые переменные обязаны быть и равняться эффективному значению
# (при пустом .env - умолчание compose); остальная конфигурация совпадает со снимком боя.
reset_stand
for item in "$NEW_STORE=false" "$NEW_STORE=1" "$NEW_DAYS=31" "$NEW_BYTES=1"; do
  name="${item%%=*}"
  STUB_CFG_NEWVAL="$item" run "cfgval-$item"
  refuse_case "cfgval-$item" "в новой конфигурации $item при пустом .env"
  assert "значение $item: сообщение называет переменную" "out_has 'cfgval-$item' '$name'"
  assert "значение $item: сообщение называет эффективное значение" \
    "out_has 'cfgval-$item' 'эффективн'"
done
for name in "${NEW_NAMES[@]}"; do
  STUB_CFG_NEWDROP="$name" run "cfgdrop-$name"
  refuse_case "cfgdrop-$name" "в новой конфигурации у app нет $name"
  assert "нет $name: сообщение называет переменную" "out_has 'cfgdrop-$name' '$name'"
done
# Любая прежняя переменная app (G9r, G9q3, G9q2, G9q, G9p, G8z, G8w) в новой конфигурации иная.
for name in "${KEEP_VARS_LIST[@]}"; do
  STUB_CFG_DRIFT_VAR="$name" run "cfgdrift-$name"
  refuse_case "cfgdrift-$name" "переменная $name у app в новой конфигурации изменилась"
  assert "дрейф $name: сообщение называет переменную" \
    "out_has 'cfgdrift-$name' 'services.app.environment.$name'"
done
STUB_CFG_APP_DRIFT=1 run cfgappdrift
refuse_case cfgappdrift "прочая конфигурация app изменилась (mem_limit)"
assert "дрейф app: сообщение называет путь services.app.mem_limit" \
  "out_has cfgappdrift 'services.app.mem_limit'"
STUB_CFG_DOCS_DRIFT=1 run cfgdocsdrift
refuse_case cfgdocsdrift "конфигурация documents изменилась"
assert "дрейф documents: сообщение называет путь" "out_has cfgdocsdrift 'services.documents'"
STUB_CFG_DOCS_IMAGE_DRIFT=1 run cfgdocsimage
refuse_case cfgdocsimage "образ documents в новой конфигурации иной (documents должен остаться)"
assert "дрейф образа documents: сообщение называет путь" \
  "out_has cfgdocsimage 'services.documents.image'"
STUB_CFG_OTHER_DRIFT=1 run cfgotherdrift
refuse_case cfgotherdrift "конфигурация другого сервиса (postgres) изменилась"
assert "дрейф postgres: сообщение называет путь" "out_has cfgotherdrift 'services.postgres'"
assert "дрейф: значения конфигурации (секрет) не попали в вывод" \
  "! grep -rq '$APP_ENV_SECRET' '$TMP/out-cfgappdrift' '$TMP/out-cfgotherdrift' \
   '$TMP/home-cfgappdrift'"
# Пакет, у которого compose.project.yml не отличается от боевого (новых переменных нет).
reset_stand
cp "$GOLDEN/compose.project.yml" "$PKG/deploy/compose.project.yml"
seal
run cfgsame
refuse_case cfgsame "compose.project.yml пакета без новых переменных"
assert "без новых переменных: сообщение называет переменные" \
  "out_has cfgsame '$NEW_STORE' && out_has cfgsame '$NEW_DAYS' && out_has cfgsame '$NEW_BYTES'"
# Пакет без одной из трёх переменных - отказ, сообщение называет недостающую.
for name in "${NEW_NAMES[@]}"; do
  reset_stand
  sed -i "/$name/d" "$PKG/deploy/compose.project.yml"
  seal
  run "cfgonly-$name"
  refuse_case "cfgonly-$name" "compose.project.yml пакета без $name"
  assert "без $name: сообщение называет её" "out_has 'cfgonly-$name' '$name'"
done
# Пакет, у которого умолчание иное (хранение `:-false`, срок и предел не те): решение владельца -
# по умолчанию включено, 30 суток, 3 ГиБ; такой пакет собран неверно.
reset_stand
write_compose "$PKG/deploy/compose.project.yml" 1 false
seal
run cfgdeffalse
refuse_case cfgdeffalse "в compose.project.yml пакета хранение по умолчанию false"
assert "default false: сообщение называет строку по умолчанию" \
  "out_has cfgdeffalse '$NEW_STORE:-true'"
reset_stand
write_compose "$PKG/deploy/compose.project.yml" 1 true 31
seal
run cfgdefdays
refuse_case cfgdefdays "в compose.project.yml пакета срок по умолчанию 31"
assert "срок не 30: сообщение называет переменную" "out_has cfgdefdays '$NEW_DAYS:-$DEF_DAYS'"
reset_stand
write_compose "$PKG/deploy/compose.project.yml" 1 true 30 1024
seal
run cfgdefbytes
refuse_case cfgdefbytes "в compose.project.yml пакета предел по умолчанию 1024"
assert "предел не 3 ГиБ: сообщение называет переменную" \
  "out_has cfgdefbytes '$NEW_BYTES:-$DEF_BYTES'"
# Корень дерева рендера: пути выше deploy (контекст сборки app, том migrate) раскрываются от
# каталога файлов и в примерке отличаются от боевых. Нормализуется корень, но любое реальное
# различие путей по-прежнему замечается.
reset_stand
STUB_CFG_CONTEXT_DRIFT=1 run cfgctxdrift
refuse_case cfgctxdrift "контекст сборки app указывает в другое место"
assert "дрейф контекста: сообщение называет services.app.build.context" \
  "out_has cfgctxdrift 'services.app.build.context'"
STUB_CFG_PATH_DRIFT=1 run cfgpathdrift
refuse_case cfgpathdrift "том migrate указывает в другое место"
assert "дрейф тома: сообщение называет services.migrate.volumes" \
  "out_has cfgpathdrift 'services.migrate.volumes'"

# Оболочечные переменные новых и прежних переменных app патч сбрасывает: значение из окружения
# запуска сильнее .env.
reset_stand
for name in "${NEW_NAMES[@]}" "${KEEP_VARS_LIST[@]}"; do export "$name=false"; done
run shellenv --preflight-only
for name in "${NEW_NAMES[@]}" "${KEEP_VARS_LIST[@]}"; do unset "$name"; done
assert "переменные в оболочке владельца: preflight код 0" "[[ $RC -eq 0 ]]"
assert "переменные в оболочке: docker их не видит (сброшены)" \
  "[[ -s '$STUB/shellenv.log' ]] && ! grep -qvE \\
   '^(<unset> ){15}<unset>\$' '$STUB/shellenv.log'"
reset_stand
STUB_NO_READY=1 run noready
refuse_case noready "бой нездоров (/ready)"
STUB_BOTS=1 run fewbots --expected-bots 4
refuse_case fewbots "ботов меньше ожидаемого"
T_MIN_DISK=999999999 run lowdisk
refuse_case lowdisk "мало места на диске"
assert "мало места: сообщение называет диск" "out_has lowdisk 'мало места'"
T_MIN_MEM=999999999 run lowmem
refuse_case lowmem "мало памяти"
assert "мало памяти: сообщение называет память" "out_has lowmem 'мало памяти'"
printf 'sha256:%s\n' "$H_OLD_APP" >"$STUB/missing"
run norollbackapp
refuse_case norollbackapp "прежнего образа app нет на хосте"
assert "откатный образ app: сообщение" "out_has norollbackapp 'прежнего образа APP'"
# Образ documents у патча прежний и запущен: откатного образа он не требует, отказа нет.
printf 'sha256:%s\n' "$H_DOCS" >"$STUB/missing"
run docsimgmissing --preflight-only
assert "образа documents нет в списке хоста (он не меняется): preflight код 0" "[[ $RC -eq 0 ]]"
: >"$STUB/missing"

# Том приёма до замены: INTAKE_ROOT в окружении app, том intake-data смонтирован по этому пути,
# запись пользователю app доступна. Бой не меняется (подкаталог не создаётся).
intake_refuse_case() { # intake_refuse_case <имя> <описание> <слово в сообщении>
  assert "$2: код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
  assert "$2: бой не тронут, дерево прежнее, подкаталог не создавался" \
    "no_mutation $1 && [[ \"\$(tree_snapshot)\" == \"\$T0\" ]] \
     && ! grep -q 'create=1' '$STUB/intake.log' && [[ \$(app_up_count $1) -eq 0 ]]"
  assert "$2: сообщение называет «$3»" "out_has $1 '$3'"
}
reset_stand
T0="$(tree_snapshot)"
sed -i '/^INTAKE_ROOT=/d' "$STUB/env/p-app-1"
run nointakeroot
intake_refuse_case nointakeroot "у app нет INTAKE_ROOT" "INTAKE_ROOT"
reset_stand
sed -i 's|^INTAKE_ROOT=.*|INTAKE_ROOT=relative/intake|' "$STUB/env/p-app-1"
run relintakeroot
intake_refuse_case relintakeroot "INTAKE_ROOT не абсолютный путь" "INTAKE_ROOT"
reset_stand
sed -i 's|^INTAKE_ROOT=.*|INTAKE_ROOT=/var/lib/../etc|' "$STUB/env/p-app-1"
run dotsintakeroot
intake_refuse_case dotsintakeroot "INTAKE_ROOT с .." "INTAKE_ROOT"
reset_stand
STUB_NO_MOUNT=1 run nomount
intake_refuse_case nomount "том приёма не смонтирован в app" "intake-data"
STUB_MOUNT_NAME= run bindmount
intake_refuse_case bindmount "по пути приёма не именованный том (bind)" "intake-data"
STUB_MOUNT_NAME=pragmatika_other-data run othervolume
intake_refuse_case othervolume "по пути приёма иной том" "intake-data"
STUB_INTAKE_BEFORE_REPLY="fail root_not_writable" run introro
intake_refuse_case introro "корень тома недоступен на запись" "root_not_writable"
STUB_INTAKE_BEFORE_REPLY="fail no_root" run intnoroot
intake_refuse_case intnoroot "корня тома нет в app" "no_root"
STUB_INTAKE_EXEC_FAIL=1 run intexecfail
intake_refuse_case intexecfail "docker exec пробы тома не удался" "нет ответа"
STUB_INTAKE_BEFORE_REPLY="$INTAKE_MARK" run intgarbage
intake_refuse_case intgarbage "проба тома отвечает не по формату" "нет ответа"
assert "ответ не по формату: содержимое вывода пробы не попало в журнал и вывод" \
  "! grep -rq '$INTAKE_MARK' '$TMP/out-intgarbage' '$TMP/home-intgarbage'"
assert "проба тома до замены: только без создания, в app и на bun" \
  "grep -q '^exec ' '$TMP/docker-introro.log' \
   && ! grep -E '^exec ' '$TMP/docker-introro.log' | grep -v 'p-app-1 bun -e' | grep -q ."
# Шум в выводе пробы (лишние строки, stderr) отбрасывается: preflight проходит, метки нигде нет.
STUB_INTAKE_NOISE=1 run intnoise --preflight-only
assert "шум в выводе пробы тома: preflight код 0" "[[ $RC -eq 0 ]]"
assert "шум в выводе пробы: метка содержимого не попала в журнал, вывод и архив" \
  "! grep -rq '$INTAKE_MARK' '$TMP/out-intnoise' '$TMP/home-intnoise'"

# 2. --preflight-only: код 0, ничего не менялось.
reset_stand
PF_RES="$TMP/home-preflight/.pragmatika-cutover/patch-9s-2*/results"
run preflight --preflight-only
assert "--preflight-only - код 0" "[[ $RC -eq 0 ]]"
assert "--preflight-only: бой не тронут" "no_mutation preflight"
assert "--preflight-only: дерево боя побайтно прежнее" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "--preflight-only: app и documents на прежних образах" "app_is_old && docs_is_old"
assert "--preflight-only: бэкап не создан" "! compgen -G '$TMP/home-preflight/backups/*'"
assert "--preflight-only: проба pages не выполнялась" "[[ \$(pages_probe_count preflight) -eq 0 ]]"
assert "--preflight-only: PREFLIGHT_OK в состоянии" \
  "grep -rq 'RESULT=PREFLIGHT_OK' '$TMP'/home-preflight/.pragmatika-cutover/patch-9s-*/state.env"
assert "--preflight-only: журнал называет G9r применённым" \
  "out_has preflight 'патч G9r применён: ok'"
assert "--preflight-only: журнал называет хранение включённым (по умолчанию compose)" \
  "out_has preflight '$NEW_STORE включено' && out_has preflight '$NEW_DAYS=$DEF_DAYS' \
   && out_has preflight '$NEW_BYTES=$DEF_BYTES'"
assert "--preflight-only: том приёма проверен до замены (одна проба без создания)" \
  "[[ \$(grep -c '^before create=0 root=$INTAKE_ROOT_PATH sub=chat-attachments' \
     '$STUB/intake.log') -eq 1 ]] && ! grep -q 'create=1' '$STUB/intake.log' \
   && out_has preflight 'том приёма: ok'"
assert "--preflight-only: пути сравнены при разных корнях (боевой и примерка), код 0" \
  "[[ \$(sort -u '$STUB/cfg-roots.log' | wc -l) -ge 2 ]] \
   && grep -q 'context $LIVE_ROOT\$' '$STUB/cfg-roots.log' \
   && grep -qE 'context .*/stage\$' '$STUB/cfg-roots.log'"
assert "--preflight-only: эффективные значения записаны в результаты" \
  "[[ \"\$(sort $PF_RES/vars-effective.txt | tr '\n' ' ')\" == \
     '$NEW_BYTES=$DEF_BYTES $NEW_DAYS=$DEF_DAYS $NEW_STORE=$DEF_STORE ' ]]"
assert "--preflight-only: журнал называет сходство прочей конфигурации" \
  "out_has preflight 'прочая конфигурация: ok'"
assert "--preflight-only: в списке замены compose.project.yml" \
  "[[ \"\$(cat $PF_RES/file-changes.txt)\" == 'compose.project.yml' ]]"
assert "--preflight-only: в списке lock два ключа (app и версия), documents нет" \
  "[[ \"\$(sort $PF_RES/lock-changes.txt | tr '\n' ' ')\" == 'BAI_IMAGE_APP BAI_VERSION ' ]]"
assert "--preflight-only: секрет из конфигурации не попал в вывод и журнал" \
  "! grep -rq '$APP_ENV_SECRET' '$TMP/out-preflight' '$TMP/home-preflight'"

# Явный выключатель хранения в .env боя: патч не отказывает и .env не меняет, хранение остаётся
# выключенным, подкаталог тома после замены не создаётся.
reset_stand
printf '%s=false\n' "$NEW_STORE" >>"$LIVE/.env"
ENV_OFF_SUM="$(sha256sum <"$LIVE/.env")"
W_OFF="$(tree_without_patched)"
run offswitch
assert "выключатель false в .env: патч не отказывает, код 0" "[[ $RC -eq 0 ]] && app_is_new"
assert "выключатель false: .env боя побайтно прежний" \
  "[[ \"\$(sha256sum <'$LIVE/.env')\" == \"\$ENV_OFF_SUM\" ]] \
   && [[ \$(stat -c %a '$LIVE/.env') == 600 ]]"
assert "выключатель false: в окружении app хранение false, срок и предел по умолчанию" \
  "grep -qx '$NEW_STORE=false' '$STUB/env/p-app-1' && grep -qx '$NEW_DAYS=$DEF_DAYS' \
   '$STUB/env/p-app-1' && grep -qx '$NEW_BYTES=$DEF_BYTES' '$STUB/env/p-app-1'"
assert "выключатель false: журнал говорит, что хранение выключено выключателем в .env" \
  "out_has offswitch '$NEW_STORE выключено выключателем'"
assert "выключатель false: эффективные значения в результатах" \
  "[[ \"\$(sort '$TMP'/home-offswitch/.pragmatika-cutover/patch-9s-2*/results/vars-effective.txt \
     | tr '\n' ' ')\" == '$NEW_BYTES=$DEF_BYTES $NEW_DAYS=$DEF_DAYS $NEW_STORE=false ' ]]"
assert "выключатель false: прочие файлы дерева (включая .env) побайтно прежние" \
  "[[ \"\$(tree_without_patched)\" == \"\$W_OFF\" ]]"
assert "выключатель false: app пересоздан один раз, documents не пересоздавался, больше ничего" \
  "[[ \$(docs_up_count offswitch) -eq 0 && \$(app_up_count offswitch) -eq 1 ]] \
   && ! other_up offswitch | grep -q ."
assert "выключатель false: том проверен без создания подкаталога (до и после замены)" \
  "! grep -q 'create=1' '$STUB/intake.log' && grep -q '^after create=0 ' '$STUB/intake.log' \
   && out_has offswitch 'подкаталог chat-attachments не создавался'"
# Допустимые значения срока и предела из .env боя: берутся как эффективные.
reset_stand
printf '%s=90\n%s=1073741824\n' "$NEW_DAYS" "$NEW_BYTES" >>"$LIVE/.env"
run envvalues
assert "срок и предел из .env: код 0, у app 90 и 1073741824, хранение true" \
  "[[ $RC -eq 0 ]] && grep -qx '$NEW_DAYS=90' '$STUB/env/p-app-1' \
   && grep -qx '$NEW_BYTES=1073741824' '$STUB/env/p-app-1' \
   && grep -qx '$NEW_STORE=true' '$STUB/env/p-app-1'"
assert "срок и предел из .env: журнал называет эффективные значения" \
  "out_has envvalues '$NEW_DAYS=90' && out_has envvalues '$NEW_BYTES=1073741824'"
for item in "$NEW_DAYS=1" "$NEW_DAYS=365" "$NEW_BYTES=1" "$NEW_STORE=TRUE" "$NEW_STORE=off"; do
  reset_stand
  printf '%s\n' "$item" >>"$LIVE/.env"
  run "edge-$item" --preflight-only
  assert "граничное значение из .env $item допустимо: preflight код 0" "[[ $RC -eq 0 ]]"
done
# Недопустимые значения из .env боя: отказ (код 3) до всяких изменений, сообщение называет
# переменную; иное значение приложение либо не приняло бы, либо поняло бы неверно.
for item in "$NEW_STORE=maybe" "$NEW_STORE=2" "$NEW_DAYS=0" "$NEW_DAYS=366" "$NEW_DAYS=abc" \
  "$NEW_DAYS=-5" "$NEW_DAYS=1.5" "$NEW_BYTES=0" "$NEW_BYTES=abc" "$NEW_BYTES=1.5" \
  "$NEW_BYTES=1234567890123456" "$NEW_BYTES=-1"; do
  name="${item%%=*}"
  reset_stand
  printf '%s\n' "$item" >>"$LIVE/.env"
  T1="$(tree_snapshot)"
  run "bad-$item"
  assert "недопустимое значение из .env $item: код 3, бой не тронут" \
    "[[ $RC -eq $EXIT_REFUSED ]] && no_mutation 'bad-$item' \
     && [[ \"\$(tree_snapshot)\" == \"\$T1\" ]]"
  assert "недопустимое значение $item: сообщение называет переменную" \
    "out_has 'bad-$item' 'значение $name в .env боя'"
done
# Пустое значение и значение в кавычках: умолчание и значение без кавычек.
reset_stand
printf '%s=\n' "$NEW_DAYS" >>"$LIVE/.env"
run emptyval
assert "пустое значение: код 0, у app умолчание $DEF_DAYS" \
  "[[ $RC -eq 0 ]] && grep -qx '$NEW_DAYS=$DEF_DAYS' '$STUB/env/p-app-1'"
reset_stand
printf '%s="45"\n' "$NEW_DAYS" >>"$LIVE/.env"
run quotedval
assert "значение в кавычках: код 0, у app 45" \
  "[[ $RC -eq 0 ]] && grep -qx '$NEW_DAYS=45' '$STUB/env/p-app-1'"
# Прежние флаги (G9q, G9q2, G9q3) выключены владельцем в .env боя: это отказом не считается.
reset_stand
printf 'PRICE_EDIT_DB_WRITE_ENABLED=false\nEMPTY_REPLY_GUARD_ENABLED=false\n' >>"$LIVE/.env"
printf 'STEP_TEXT_SEPARATE_ENABLED=false\n' >>"$LIVE/.env"
run oldoff --preflight-only
assert "выключатель прежних флагов G9q, G9q2 и G9q3 в .env: preflight код 0" "[[ $RC -eq 0 ]]"
# Значение из secrets.env сильнее .env (порядок --env-file).
reset_stand
printf '%s=false\n' "$NEW_STORE" >"$LIVE/secrets.env"
chmod 600 "$LIVE/secrets.env"
run secretsoff --preflight-only
assert "secrets.env с false: эффективное значение false, preflight код 0" \
  "[[ $RC -eq 0 ]] && out_has secretsoff '$NEW_STORE выключено выключателем'"

# Образа app нет на хосте: preflight делает docker pull по digest (documents не катится).
reset_stand
printf '%s\n' "$H_NEW_APP" >"$STUB/missing"
run pullimages --preflight-only
assert "образа app нет на хосте: docker pull app по digest, код 0" \
  "[[ $RC -eq 0 ]] && grep -q '^pull r/app@sha256:$H_NEW_APP' '$TMP/docker-pullimages.log'"
assert "образа app нет на хосте: documents не загружается" \
  "! grep -q '^pull r/pragmatika-documents' '$TMP/docker-pullimages.log'"
reset_stand
echo "$H_NEW_APP" >"$STUB/missing"
echo "tar" >"$TMP/images.tar"
run loadimages --preflight-only --images-tar "$TMP/images.tar"
assert "--images-tar: docker load выполнен" \
  "grep -q '^load -i $TMP/images.tar' '$TMP/docker-loadimages.log'"
reset_stand
printf '%s\n' "$H_NEW_APP" >"$STUB/missing"
run nopull --preflight-only --images-tar "$TMP/нет-такого.tar"
refuse_case nopull "--images-tar: нет файла архива"

# 3. Успех: заменены images.lock и compose.project.yml, пересоздан только app (documents - нет).
# Проба тома отвечает с шумом (метка «содержимого»): она не должна попасть ни в журнал, ни в архив.
reset_stand
STUB_INTAKE_NOISE=1 run apply
assert "успех: код 0" "[[ $RC -eq 0 ]]"
assert "успех: lock боя равен lock пакета (образ app новый, образ documents прежний)" \
  "cmp -s '$LIVE/images.lock' '$PKG/images.lock' \
   && grep -q '$NEW_APP' '$LIVE/images.lock' && grep -q '$DOCS' '$LIVE/images.lock'"
assert "успех: compose.project.yml боя равен файлу пакета" \
  "cmp -s '$LIVE/compose.project.yml' '$PKG/deploy/compose.project.yml'"
assert "успех: в compose.project.yml боя три новые переменные с умолчаниями" \
  "grep -q '$NEW_STORE: \${$NEW_STORE:-$DEF_STORE}' '$LIVE/compose.project.yml' \
   && grep -q '$NEW_DAYS: \${$NEW_DAYS:-$DEF_DAYS}' '$LIVE/compose.project.yml' \
   && grep -q '$NEW_BYTES: \${$NEW_BYTES:-$DEF_BYTES}' '$LIVE/compose.project.yml'"
assert "успех: BAI_VERSION боя $VER_TO" "grep -qx 'BAI_VERSION=$VER_TO' '$LIVE/images.lock'"
assert "успех: основы app и documents в lock прежние" \
  "grep -q 'BAI_IMAGE_APP_BASE=r/app-base@sha256:$H_BASE' '$LIVE/images.lock' \
   && grep -q 'BAI_IMAGE_DOCUMENTS_BASE=r/bai-documents@sha256:$H_DBASE' '$LIVE/images.lock'"
assert "успех: все файлы дерева, кроме images.lock и compose.project.yml, побайтно прежние" \
  "[[ \"\$(tree_without_patched)\" == \"\$W0\" ]]"
assert "успех: platform/compose.base.yml и PLATFORM-VERSION прежние (платформа $PLATFORM_VER)" \
  "cmp -s '$LIVE/platform/compose.base.yml' '$GOLDEN/platform/compose.base.yml' \
   && grep -q '$PLATFORM_VER' '$LIVE/platform/PLATFORM-VERSION'"
assert "успех: права .env прежние (600)" "[[ \$(stat -c %a '$LIVE/.env') == 600 ]]"
assert "успех: бэкап deploy с прежними lock и compose.project.yml" \
  "grep -q '$OLD_APP' '$TMP'/home-apply/backups/pragmatika-patch9s-*/deploy/images.lock \
   && grep -q '$DOCS' '$TMP'/home-apply/backups/pragmatika-patch9s-*/deploy/images.lock \
   && cmp -s '$GOLDEN/compose.project.yml' \
   '$TMP'/home-apply/backups/pragmatika-patch9s-*/deploy/compose.project.yml"
assert "успех: бэкап хранит .env с правами 600" \
  "[[ \$(stat -c %a '$TMP'/home-apply/backups/pragmatika-patch9s-*/deploy/.env) == 600 ]]"
assert "успех: в бэкапе снимок контейнеров и образов (documents и app)" \
  "grep -q 'p-documents-1' '$TMP'/home-apply/backups/pragmatika-patch9s-*/containers-before.tsv \
   && grep -q 'p-app-1' '$TMP'/home-apply/backups/pragmatika-patch9s-*/containers-before.tsv"
assert "успех: documents НЕ пересоздавался и не перезапускался" \
  "[[ \$(docs_up_count apply) -eq 0 ]] \
   && [[ \$(cat '$STUB/started/p-documents-1') == 2026-11-18T08:00:00Z ]]"
assert "успех: app пересоздан ровно один раз" "[[ \$(app_up_count apply) -eq 1 ]]"
assert "успех: compose up только для app (--no-deps)" "! other_up apply | grep -q ."
assert "успех: БЕЗ down, --remove-orphans, --force-recreate" \
  "! grep -E ' (down|--remove-orphans|--force-recreate)( |\$)' '$TMP/docker-apply.log'"
assert "успех: ни stop, ни rm, ни образы не трогались" \
  "! grep -E '^(stop|rm|rmi|image rm|tag|kill|restart) ' '$TMP/docker-apply.log'"
assert "успех: documents на прежнем образе, app на новом образе" "docs_is_old && app_is_new"
assert "успех: в окружении app три новые переменные со значениями по умолчанию" \
  "grep -qx '$NEW_STORE=$DEF_STORE' '$STUB/env/p-app-1' \
   && grep -qx '$NEW_DAYS=$DEF_DAYS' '$STUB/env/p-app-1' \
   && grep -qx '$NEW_BYTES=$DEF_BYTES' '$STUB/env/p-app-1'"
assert "успех: журнал называет новые переменные с эффективными значениями" \
  "out_has apply 'новые переменные: $NEW_LINE'"
assert "успех: все прежние переменные app (G9r, G9q3, G9q2, G9q, G9p, G8z, G8w) на месте" \
  "keep_vars_present"
assert "успех: переменные записи звонка G9r у app со значениями платформы" \
  "grep -qx 'B24_CALL_RECORDING_MAX_BYTES=104857600' '$STUB/env/p-app-1' \
   && grep -qx 'B24_CALL_RECORDING_TIMEOUT_MS=600000' '$STUB/env/p-app-1'"
assert "успех: .env боя патч не менял (нет переменных - нет и после)" \
  "! grep -q 'CHAT_ATTACHMENTS' '$LIVE/.env' && cmp -s '$LIVE/.env' '$GOLDEN/.env'"
assert "успех: в окружении documents четыре флага G8x остались" \
  "grep -qx 'DOCUMENTS_EDIT_PPTX=true' '$STUB/env/p-documents-1' \
   && grep -qx 'DOCUMENTS_EDIT_PDF=true' '$STUB/env/p-documents-1' \
   && grep -qx 'DOCUMENTS_PPT_CONVERT=true' '$STUB/env/p-documents-1' \
   && grep -qx 'DOCUMENTS_EDIT_PDF_FALLBACK_FONT=false' '$STUB/env/p-documents-1'"
assert "успех: журнал называет флаги documents со значениями" \
  "out_has apply 'DOCUMENTS_EDIT_PDF_FALLBACK_FONT=false' \
   && out_has apply 'DOCUMENTS_EDIT_PPTX=true'"
assert "успех: том приёма: проба до замены без создания и после замены с созданием, по одной" \
  "[[ \$(grep -c '^before create=0 root=$INTAKE_ROOT_PATH sub=chat-attachments\$' \
     '$STUB/intake.log') -eq 1 ]] \
   && [[ \$(grep -c '^after create=1 root=$INTAKE_ROOT_PATH sub=chat-attachments\$' \
     '$STUB/intake.log') -eq 1 ]] && [[ \$(wc -l <'$STUB/intake.log') -eq 2 ]]"
assert "успех: docker exec только проба тома в app (bun), других exec нет" \
  "[[ \$(exec_count apply) -eq 2 ]] \
   && ! grep -E '^exec ' '$TMP/docker-apply.log' | grep -v ' p-app-1 bun -e ' | grep -q ."
assert "успех: журнал называет проверки тома приёма до и после замены" \
  "out_has apply 'том приёма: ok' && out_has apply 'том приёма после замены: ok' \
   && out_has apply 'чужих записей 0'"
assert "успех: пробе тома передан только подкаталог chat-attachments (корень тома не обходится)" \
  "! grep -E '^exec ' '$TMP/docker-apply.log' | grep -v 'PATCH_INTAKE_SUB=chat-attachments' \
   | grep -q ."
assert "успех: «содержимое тома» из вывода пробы не попало в журнал и вывод" \
  "! grep -rq '$INTAKE_MARK' '$TMP/out-apply' '$TMP/home-apply'"
assert "успех: переменные Яндекса у app на месте" \
  "grep -qx 'YANDEX_SEARCH_MAX_CONCURRENCY=1' '$STUB/env/p-app-1' \
   && grep -qx 'YANDEX_SEARCH_MIN_INTERVAL_MS=1200' '$STUB/env/p-app-1'"
assert "успех: проба /docx/pages выполнена один раз, после app" \
  "[[ \$(pages_probe_count apply) -eq 1 ]] && out_has apply 'проба /docx/pages: ok'"
assert "успех: проба несёт некорректное тело (content_base64 не base64), не файл" \
  "grep -q 'PATCH_PAGES_BODY={\"file_name\":\"probe.docx\",\"content_base64\":\"%%%\"}' \
   '$TMP/docker-apply.log'"
assert "успех: журнал пробы - только статус и код ошибки" \
  "out_has apply 'documents ответил 422 bad_request'"
assert "успех: documents и app в images-running.tsv совпали с lock" \
  "[[ \$(cat '$TMP'/home-apply/.pragmatika-cutover/patch-9s-2*/results/images-running.tsv \
     | grep -c 'совпал') -ge 2 ]]"
assert "успех: эффективные значения записаны в результаты (три переменные)" \
  "[[ \"\$(sort '$TMP'/home-apply/.pragmatika-cutover/patch-9s-2*/results/vars-effective.txt \
     | tr '\n' ' ')\" == '$NEW_BYTES=$DEF_BYTES $NEW_DAYS=$DEF_DAYS $NEW_STORE=$DEF_STORE ' ]]"
assert "успех: архив patch9s-<время>.tgz создан" \
  "compgen -G '$TMP/home-apply/patch9s-*.tgz' >/dev/null"
mkdir -p "$TMP/arch"
tar -C "$TMP/arch" -xzf "$(compgen -G "$TMP/home-apply/patch9s-*.tgz" | head -1)"
assert "успех: в архиве журнал и проверки" \
  "[[ -f '$TMP/arch/results/cutover.log' && -f '$TMP/arch/results/checks.tsv' ]]"
assert "успех: окружение app и конфигурация (секрет) не попали в журнал, вывод и архив" \
  "! grep -rq '$APP_ENV_SECRET' '$TMP/out-apply' '$TMP/arch' '$TMP/home-apply'"
assert "успех: секреты из файлов не попали в вывод и архив" \
  "! grep -rq '$FILE_SECRET' '$TMP/out-apply' '$TMP/arch'"
assert "успех: содержимое тома и .env в архиве отсутствуют (метка, значения .env)" \
  "! grep -rq '$INTAKE_MARK' '$TMP/arch' && ! grep -rq 'POSTGRES_USER' '$TMP/arch'"

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
assert "повтор: проба pages не выполнялась" "[[ \$(pages_probe_count again) -eq 0 ]]"

# 5. Сбои после замены: автооткат, файлы из бэкапа побайтно, app на образе G9r, documents не
# тронут.
# rollback_case <имя> <описание>: после сбоя проверяется одинаковый набор признаков отката.
rollback_case() {
  assert "$2: код 1 (откат выполнен)" "[[ $RC -eq $EXIT_FAILED ]]"
  assert "$2: автоматический откат запущен" "out_has $1 'автоматический откат'"
  assert "$2: дерево боя побайтно прежнее (lock и compose.project.yml из бэкапа)" \
    "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
  assert "$2: documents и app на прежних образах, откат без down" \
    "app_is_old && docs_is_old && ! grep -E ' (down|--remove-orphans)( |\$)' '$TMP/docker-$1.log'"
  assert "$2: откат только через up --no-deps app (documents не пересоздавался)" \
    "! other_up $1 | grep -q . && [[ \$(docs_up_count $1) -eq 0 ]]"
  assert "$2: ОТКАТ ПАТЧА ВЫПОЛНЕН в журнале" "out_has $1 'ОТКАТ ПАТЧА ВЫПОЛНЕН'"
  assert "$2: журнал отката: файлы архива тома откатом не удаляются" \
    "out_has $1 'откатом не удаляются'"
  assert "$2: у app после отката нет новых переменных (старый compose), прежние на месте" \
    "! grep -q 'CHAT_ATTACHMENTS' '$STUB/env/p-app-1' \
     && keep_vars_present"
}
# Сбой на шаге app (все сбои после замены файлов): app пересоздан дважды (замена и откат),
# documents - ни разу.
app_stage_case() {
  assert "$2: app пересоздан дважды (замена и откат), documents ни разу" \
    "[[ \$(app_up_count $1) -eq 2 && \$(docs_up_count $1) -eq 0 ]]"
}
# documents нездоров или не запущен ДО замены: отказ по предусловиям (код 3), бой не тронут.
reset_stand
STUB_DOCS_EXITED=1 run docsexited
refuse_case docsexited "documents не запущен до замены"
assert "documents не запущен: app не пересоздавался" "[[ \$(app_up_count docsexited) -eq 0 ]]"
reset_stand
STUB_DOCS_HEALTH_500=1 run docshealth
refuse_case docshealth "/health documents не 200 до замены"
assert "/health 500 до замены: причина в журнале" "out_has docshealth '/health documents не 200'"
assert "/health 500 до замены: app не пересоздавался" "[[ \$(app_up_count docshealth) -eq 0 ]]"
# Проба /docx/pages (после app): образ без ручки (404) и прочие расхождения -> автооткат.
reset_stand
STUB_PAGES_OLD_BEHAVIOR=1 run pagesold
rollback_case pagesold "documents отвечает на /docx/pages как старый образ (404)"
app_stage_case pagesold "проба pages (старый образ)"
assert "старый образ: причина в журнале" "out_has pagesold 'проба /docx/pages: ответ 404 -'"
assert "старый образ: в причине ожидаемые значения" "out_has pagesold 'ожидается 422 bad_request'"
reset_stand
STUB_PAGES_OLD_REPLY="405 -" STUB_PAGES_OLD_BEHAVIOR=1 run pages405
rollback_case pages405 "проба pages: 405"
app_stage_case pages405 "проба pages 405"
reset_stand
STUB_PAGES_CODE=200 STUB_PAGES_ERR= run pages200
rollback_case pages200 "проба pages отвечает 200"
app_stage_case pages200 "проба pages 200"
reset_stand
STUB_PAGES_CODE=500 STUB_PAGES_ERR=internal_error run pages500
rollback_case pages500 "проба pages отвечает 500"
app_stage_case pages500 "проба pages 500"
reset_stand
STUB_PAGES_ERR=unsupported_format run pageserr
rollback_case pageserr "проба pages: 422, но иной код ошибки (unsupported_format)"
app_stage_case pageserr "проба pages (код ошибки)"
assert "иной код: причина в журнале" "out_has pageserr 'ответ 422 unsupported_format'"
reset_stand
STUB_PAGES_DOWN=1 run pagesdown
rollback_case pagesdown "проба pages: documents не отвечает"
app_stage_case pagesdown "проба pages (нет ответа)"
assert "нет ответа: причина в журнале" "out_has pagesdown 'не отвечает'"
reset_stand
STUB_PAGES_APP_STAGE_FAIL=1 run pagesapp
rollback_case pagesapp "проба pages красная после пересоздания app"
app_stage_case pagesapp "проба pages после app"
# Ожидаемые статус и код ошибки переопределяются окружением стенда.
reset_stand
PATCH9S_PAGES_PROBE_ERROR=unsupported_format STUB_PAGES_ERR=unsupported_format run pagesoverride
assert "ожидаемый код пробы переопределён окружением: код 0" "[[ $RC -eq 0 ]]"
assert "переопределённая проба: в журнале 422 unsupported_format" \
  "out_has pagesoverride 'ответил 422 unsupported_format'"
reset_stand
PATCH9S_PAGES_PROBE_STATUS=200 PATCH9S_PAGES_PROBE_ERROR=other STUB_PAGES_CODE=200 \
  STUB_PAGES_ERR=other run pagesoverride2
assert "ожидаемые статус и код пробы переопределены окружением: код 0" "[[ $RC -eq 0 ]]"
reset_stand
PATCH9S_PAGES_PROBE_STATUS=200 STUB_PAGES_CODE=422 run pagesoverride3
rollback_case pagesoverride3 "переопределён только статус пробы, ответ иной"
# Шаг app.
reset_stand
STUB_UP_FAIL=1 run upfail
rollback_case upfail "compose up app не удался"
app_stage_case upfail "up app не удался"
reset_stand
STUB_WRONG_APP_IMAGE=1 run wrongimage
rollback_case wrongimage "запущен не тот образ app"
app_stage_case wrongimage "не тот образ app"
reset_stand
STUB_READY_500=1 run ready500
rollback_case ready500 "/ready 500 на новом образе app"
assert "/ready 500: после отката /ready 200" "out_has ready500 'откат: /ready: ok'"
app_stage_case ready500 "/ready 500"
reset_stand
STUB_BOTS_NEW=1 run fewbotsafter --expected-bots 4
rollback_case fewbotsafter "после замены ботов меньше ожидаемого"
# Том приёма после замены: проба сообщает сбой, чужие записи, нет ответа, иной корень, том
# пропал - автооткат (код 1), в журнале только код и число, без содержимого.
reset_stand
STUB_INTAKE_AFTER_REPLY="fail mkdir" run intmkdir
rollback_case intmkdir "подкаталог chat-attachments не создаётся (mkdir)"
app_stage_case intmkdir "mkdir тома"
assert "mkdir: причина в журнале с кодом" \
  "out_has intmkdir 'подкаталог chat-attachments не создан или недоступен' \
   && out_has intmkdir 'fail mkdir'"
reset_stand
STUB_INTAKE_AFTER_REPLY="fail sub_not_writable" run intsubro
rollback_case intsubro "подкаталог chat-attachments недоступен на запись"
app_stage_case intsubro "подкаталог недоступен на запись"
assert "подкаталог недоступен: код в журнале" "out_has intsubro 'sub_not_writable'"
reset_stand
STUB_INTAKE_AFTER_REPLY="fail root_not_writable" run introotro
rollback_case introotro "корень тома недоступен на запись после замены"
reset_stand
STUB_INTAKE_AFTER_REPLY="ok 2" run intforeign
rollback_case intforeign "в chat-attachments чужие записи"
app_stage_case intforeign "чужие записи в томе"
assert "чужие записи: в журнале число, не имена" \
  "out_has intforeign 'записей не от пользователя app: 2'"
reset_stand
STUB_INTAKE_AFTER_REPLY="$INTAKE_MARK" run intnoanswer
rollback_case intnoanswer "проба тома после замены отвечает не по формату"
assert "нет ответа: «содержимое» вывода не попало в журнал и вывод" \
  "out_has intnoanswer 'нет ответа' && ! grep -rq '$INTAKE_MARK' '$TMP/out-intnoanswer' \
   '$TMP/home-intnoanswer'"
reset_stand
STUB_APP_INTAKE_ROOT_AFTER=/var/lib/other/intake run introotchanged
rollback_case introotchanged "после замены INTAKE_ROOT у app иной"
assert "иной INTAKE_ROOT: причина в журнале" "out_has introotchanged 'у app иной'"
reset_stand
STUB_NO_MOUNT_AFTER=1 run mountlost
rollback_case mountlost "после замены том приёма в app не смонтирован"
assert "том пропал: причина в журнале" "out_has mountlost 'нет тома'"
# Пропажа прежних переменных app (G9r, G9q3, G9q2, G9q, G9p, G8z, G8w) после пересоздания.
for name in "${KEEP_VARS_LIST[@]}"; do
  reset_stand
  STUB_APP_LOSE="$name" run "lose-$name"
  rollback_case "lose-$name" "после пересоздания в app пропала переменная $name"
  assert "пропала $name: причина в журнале" \
    "out_has 'lose-$name' 'пропали переменные G9r, G9q3, G9q2, G9q, G9p, G8z или G8w' \
     && out_has 'lose-$name' '$name'"
done
reset_stand
STUB_APP_NO_NEWVARS=1 run nonewvars
rollback_case nonewvars "в окружении app после замены нет новых переменных"
assert "нет новой переменной: причина в журнале" \
  "out_has nonewvars 'нет новой переменной $NEW_STORE'"
for item in "$NEW_STORE=false" "$NEW_DAYS=31" "$NEW_BYTES=1"; do
  reset_stand
  STUB_ENV_OVERRIDE="$item" run "envval-$item"
  rollback_case "envval-$item" "в окружении app $item (ждали умолчание)"
  assert "не то значение $item: причина в журнале" \
    "out_has 'envval-$item' 'не равны эффективным значениям' \
     && out_has 'envval-$item' '${item%%=*}'"
done
reset_stand
STUB_DOCS_RESTART=1 run docsrestart
rollback_case docsrestart "documents перезапущен при пересоздании app"
app_stage_case docsrestart "documents перезапущен"
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
reset_stand
STUB_DOCS_HEALTH_500_APP=1 run soakhealth
rollback_case soakhealth "/health documents не 200 во время выдержки"
assert "выдержка (/health): причина в журнале" "out_has soakhealth 'во время выдержки'"

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
rundir="$(readlink -f "$TMP/home-manual_apply/.pragmatika-cutover/patch-9s-latest")"
run manual_rollback --rollback --run-dir "$rundir"
assert "ручной откат - код 0" "[[ $RC -eq 0 ]]"
assert "ручной откат: дерево побайтно прежнее (lock и compose.project.yml)" \
  "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "ручной откат: app на образе G9r, documents на прежнем" "app_is_old && docs_is_old"
assert "ручной откат: флаги documents на месте" \
  "grep -qx 'DOCUMENTS_EDIT_PPTX=true' '$STUB/env/p-documents-1'"
assert "ручной откат: у app больше нет новых переменных (старый compose), прежние на месте" \
  "! grep -q 'CHAT_ATTACHMENTS' '$STUB/env/p-app-1' \
   && keep_vars_present"
assert "ручной откат: только up --no-deps app, documents не пересоздаётся" \
  "! other_up manual_rollback | grep -q . && [[ \$(docs_up_count manual_rollback) -eq 0 ]] \
   && [[ \$(app_up_count manual_rollback) -eq 1 ]]"
assert "ручной откат: БЕЗ down и --remove-orphans" \
  "! grep -E ' (down|--remove-orphans)( |\$)' '$TMP/docker-manual_rollback.log'"
# Без --run-dir берётся последний запуск (patch-9s-latest) из того же HOME.
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
assert "--help - код 0 и описание G9s" "[[ $RC -eq 0 ]] && out_has helpout 'G9s'"
assert "неверный вызов: бой не тронут" "no_mutation badargs && no_mutation unknownarg"

# 9. Настоящий JS пробы /docx/pages (нужен bun) против локального сервера: разбирается только
# detail.error, тело ответа в журнал не попадает.
cat >"$TMP/pages-server.py" <<'PY'
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
  python3 -I "$TMP/pages-server.py" "$TMP/server.port" "$1" "$2" "$TMP/server.seen" &
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
  assert "настоящий JS пробы: сервер получил POST /docx/pages с некорректным base64" \
    "grep -q '^/docx/pages .*\"content_base64\":\"%%%\"' '$TMP/server.seen'"
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
  printf '{"detail":[{"loc":["body","x"],"msg":"%s"}]}' "$BODY_MARK" >"$TMP/body-list.json"
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
  printf '{"detail":"Not Found %s"}' "$BODY_MARK" >"$TMP/body-404.json"
  start_server 404 "$TMP/body-404.json"
  reset_stand
  STUB_REAL_JS_URL="$REAL_URL" run real404
  rollback_case real404 "настоящий JS: documents без ручки страниц отвечает 404"
  assert "настоящий JS: ответ 404 в причине, тело не напечатано" \
    "out_has real404 'ответ 404 -' && ! grep -rq '$BODY_MARK' '$TMP/out-real404'"
  printf '{"ok":true}' >"$TMP/body-200.json"
  start_server 200 "$TMP/body-200.json"
  reset_stand
  STUB_REAL_JS_URL="$REAL_URL" run real200
  rollback_case real200 "настоящий JS: ответ 200 вместо отказа на некорректное тело"
  [[ -z "$SERVER_PID" ]] || { kill "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""; }
else
  echo "SKIP настоящий JS пробы: нет bun"
fi

# 9a. Настоящий JS пробы тома (нужен bun) против каталога на диске: корень тома записываемый,
# подкаталог chat-attachments создаётся только после замены, файлы приёма прайсов (каталоги из 16
# шестнадцатеричных знаков) и содержимое подкаталога не меняются и в вывод не попадают.
if command -v bun >/dev/null 2>&1; then
  VOL="$TMP/real-volume"
  PRICE_DIR="$VOL/0123456789abcdef"
  PRICE_FILE_NAME="price-secret-name-5521.xlsx"
  KEPT_FILE_NAME="kept-secret-name-9913.pdf"
  reset_stand
  rm -rf "${VOL:?}"
  mkdir -p "$PRICE_DIR"
  echo "price-body" >"$PRICE_DIR/$PRICE_FILE_NAME"
  VOL_SUM0="$(cd "$VOL" && find . -type f | sort | xargs -d '\n' sha256sum)"
  STUB_REAL_INTAKE_DIR="$VOL" run realpf --preflight-only
  assert "настоящий JS: preflight код 0, подкаталог не создан до замены" \
    "[[ $RC -eq 0 ]] && [[ ! -e '$VOL/chat-attachments' ]]"
  STUB_REAL_INTAKE_DIR="$VOL" run realapply
  assert "настоящий JS: ход код 0, подкаталог chat-attachments создан после замены" \
    "[[ $RC -eq 0 ]] && [[ -d '$VOL/chat-attachments' ]] && out_has realapply 'чужих записей 0'"
  assert "настоящий JS: файлы приёма прайсов не тронуты" \
    "[[ \"\$(cd '$VOL' && find . -type f | sort | xargs -d '\n' sha256sum)\" == \"\$VOL_SUM0\" ]]"
  assert "настоящий JS: имён файлов тома нет в выводе, журнале и архиве" \
    "! grep -rq '$PRICE_FILE_NAME' '$TMP/out-realapply' '$TMP/home-realapply'"
  # Свои файлы в подкаталоге: проба их не удаляет и не печатает, чужих (по uid) нет.
  reset_stand
  echo "kept" >"$VOL/chat-attachments/$KEPT_FILE_NAME"
  STUB_REAL_INTAKE_DIR="$VOL" run realkeep
  assert "настоящий JS: свои файлы в подкаталоге остались, код 0, имена не напечатаны" \
    "[[ $RC -eq 0 ]] && [[ -f '$VOL/chat-attachments/$KEPT_FILE_NAME' ]] \
     && ! grep -rq '$KEPT_FILE_NAME' '$TMP/out-realkeep' '$TMP/home-realkeep'"
  # Корня тома нет: до замены отказ (код 3), бой не тронут.
  reset_stand
  STUB_REAL_INTAKE_DIR="$TMP/real-volume-missing" run realnoroot
  refuse_case realnoroot "настоящий JS: корня тома в app нет"
  assert "настоящий JS: нет корня: сообщение называет код" "out_has realnoroot 'no_root'"
  # Корень только для чтения (если тест идёт не от root): до замены отказ.
  if [[ "$(id -u)" != 0 ]]; then
    reset_stand
    chmod 500 "$VOL"
    STUB_REAL_INTAKE_DIR="$VOL" run realro
    chmod 700 "$VOL"
    refuse_case realro "настоящий JS: корень тома недоступен на запись"
    assert "настоящий JS: корень read-only: сообщение называет код" \
      "out_has realro 'root_not_writable'"
    # Подкаталог уже есть, но закрыт на запись: после замены откат.
    reset_stand
    chmod 500 "$VOL/chat-attachments"
    STUB_REAL_INTAKE_DIR="$VOL" run realsubro
    chmod 700 "$VOL/chat-attachments"
    rollback_case realsubro "настоящий JS: подкаталог chat-attachments закрыт на запись"
    assert "настоящий JS: подкаталог read-only: код в журнале" \
      "out_has realsubro 'sub_not_writable'"
  fi
  rm -rf "${VOL:?}"
else
  echo "SKIP настоящий JS пробы тома: нет bun"
fi

# 10. Стиль и безопасность сценария.
PS="$SRC/patch.sh"
SD="$SRC/standin/patch-9s-stand.compose.yml"
assert "строки patch.sh до $LIMIT знаков" \
  "! LC_ALL=C.UTF-8 awk 'length > $LIMIT' '$PS' | grep -q ."
assert "строки теста до $LIMIT знаков" "! LC_ALL=C.UTF-8 awk 'length > $LIMIT' '$0' | grep -q ."
assert "строки стенда-заглушки до $LIMIT знаков" \
  "! LC_ALL=C.UTF-8 awk 'length > $LIMIT' '$SD' | grep -q ."
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
assert "patch.sh: docker exec ровно один (проба тома в app на bun), без sh -c и без -it" \
  "[[ \$(grep -vE '^[[:space:]]*#' '$PS' | grep -c 'docker exec') -eq 1 ]] \
   && grep -vE '^[[:space:]]*#' '$PS' | grep -A2 'docker exec' | grep -q 'bun -e' \
   && ! grep -vE '^[[:space:]]*#' '$PS' | grep 'docker exec' | grep -qE ' -i| -t|sh -c'"
assert "patch.sh: docker exec только в intake_probe" \
  "sed -n '/^intake_probe()/,/^}/p' '$PS' | grep -q 'docker exec'"
assert "patch.sh: пробе тома передаётся только подкаталог (INTAKE_SUBDIR), листинга корня нет" \
  "grep -q '^INTAKE_SUBDIR=\"chat-attachments\"' '$PS' \
   && ! sed -n '/^INTAKE_JS=/,/^INTAKE_REPLY_RE=/p' '$PS' | grep -q 'readdirSync(root'"
assert "patch.sh: проба тома не печатает имена и содержимое (в JS только ok N или fail код)" \
  "! sed -n '/^INTAKE_JS=/,/^INTAKE_REPLY_RE=/p' '$PS' | grep -E 'console.log' \
   | grep -qE 'console.log\\((name|e\\)|e\\.|sub|root)'"
assert "patch.sh: ответ пробы тома отсекается по формату (INTAKE_REPLY_RE) перед печатью" \
  "grep -q '^INTAKE_REPLY_RE=' '$PS' && sed -n '/^intake_probe()/,/^}/p' '$PS' \
   | grep -q 'grep -E \"\$INTAKE_REPLY_RE\"'"
assert "patch.sh: окружение контейнера читается только в container_env_value (один раз)" \
  "[[ \$(grep -vE '^[[:space:]]*#' '$PS' | grep -c 'Config.Env') -eq 1 ]]"
assert "patch.sh: окружение читается через фильтр одного ключа (sed -n)" \
  "sed -n '/^container_env_value()/,/^}/p' '$PS' | grep -q 'sed -n'"
assert "patch.sh: монтирования читаются только в intake_mounted и не печатаются" \
  "[[ \$(grep -vE '^[[:space:]]*#' '$PS' | grep -c '\\.Mounts') -eq 1 ]] \
   && sed -n '/^intake_mounted()/,/^}/p' '$PS' | grep -q '\\.Mounts'"
assert "patch.sh: compose up ровно в двух местах (только app: замена и откат)" \
  "[[ \$(grep -vE '^[[:space:]]*#' '$PS' | grep -c 'dc_new up ') -eq 2 ]] \
   && ! grep -vE '^[[:space:]]*#' '$PS' | grep 'dc_new up ' | grep -vq 'APP_SERVICE' \
   && ! grep -vE '^[[:space:]]*#' '$PS' | grep 'dc_new up ' | grep -q 'DOCUMENTS_SERVICE'"
assert "patch.sh: PATCH_FILE_ALLOW - ровно compose.project.yml" \
  "[[ \"\$(grep -m1 '^PATCH_FILE_ALLOW=(' '$PS')\" == 'PATCH_FILE_ALLOW=(compose.project.yml)' ]]"
assert "patch.sh: ключи lock - ровно BAI_VERSION и BAI_IMAGE_APP (documents не меняется)" \
  "[[ \"\$(grep -m1 '^PATCH_LOCK_KEYS=' '$PS')\" == \
     'PATCH_LOCK_KEYS=\"BAI_VERSION BAI_IMAGE_APP\"' ]]"
assert "patch.sh: новые переменные app - ровно три CHAT_ATTACHMENTS_* с умолчаниями теста" \
  "[[ \"\$(grep -A1 -m1 '^NEW_APP_VARS=(' '$PS' | tr -d '\n' | tr -s ' ')\" == \
     'NEW_APP_VARS=($NEW_STORE=$DEF_STORE $NEW_DAYS=$DEF_DAYS $NEW_BYTES=$DEF_BYTES)' ]]"
assert "patch.sh: имена переменных в константах VAR_* равны именам теста" \
  "grep -q '^VAR_STORE=\"$NEW_STORE\"' '$PS' && grep -q '^VAR_DAYS=\"$NEW_DAYS\"' '$PS' \
   && grep -q '^VAR_BYTES=\"$NEW_BYTES\"' '$PS'"
assert "patch.sh: допустимые пределы - константы (1..365 суток, предел не меньше 1 байта)" \
  "grep -q '^DAYS_MIN=1\$' '$PS' && grep -q '^DAYS_MAX=365\$' '$PS' \
   && grep -q '^BYTES_MIN=1\$' '$PS'"
assert "patch.sh: патч не пишет в .env (нет sed -i, tee и перенаправлений в .env)" \
  "! grep -vE '^[[:space:]]*#' '$PS' | grep -E '(>|>>|tee|sed -i).*(ENV_FILE_NAME|\\.env)' \
   | grep -v 'cut_redact'"
assert "patch.sh: сравнение конфигураций заменяет КОРЕНЬ примерки на боевой (не только deploy)" \
  "sed -n '/^stage_tree()/,/^}/p' '$PS' | grep -q '\"\\\$LIVE_NEW_DIR\" \"\\\$STAGE_DIR\"'"
assert "patch.sh: оболочечные переменные сбрасываются (unset новых и прежних)" \
  "grep -qE '^unset \"\\\$\\{NEW_VAR_NAMES\\[@\\]\\}\" \"\\\$\\{KEEP_APP_KEYS\\[@\\]\\}\"' '$PS'"
assert "patch.sh: конфигурация сравнивается без печати значений (config_delta, без журнала)" \
  "grep -q '^config_delta()' '$PS' && ! grep -vE '^[[:space:]]*#' '$PS' \
   | grep 'format json' | grep -qE '>>|tee|LOG_FILE'"
assert "patch.sh: ожидаемые статус и код пробы pages - константы с переопределением" \
  "grep -q 'PAGES_PROBE_STATUS=\"\${PATCH9S_PAGES_PROBE_STATUS:-422}\"' '$PS' \
   && grep -q 'PAGES_PROBE_ERROR=\"\${PATCH9S_PAGES_PROBE_ERROR:-bad_request}\"' '$PS'"
assert "patch.sh: тело пробы pages - некорректный base64 (файл не передаётся)" \
  "grep -q '^PAGES_PROBE_BODY=.*content_base64.*%%%' '$PS'"
assert "patch.sh: порог диска - 4096 МиБ (меняется один образ)" \
  "grep -q 'PATCH_MIN_DISK_MIB=\"\${PATCH9S_MIN_DISK_MIB:-4096}\"' '$PS'"
assert "patch.sh: нет префиксов других патчей (PATCH8X..8Z, PATCH9P, 9Q, 9R, 9T, 9U)" \
  "! grep -qE 'PATCH8[XYZ]|PATCH9[PQRTU]|patch-8[xyz]|patch8[xyz]|patch-9[pqrtu]|patch9[pqrtu]' \
   '$PS'"
assert "patch.sh: префиксы G9s (бэкап, архив, запуск)" \
  "grep -q 'BACKUP_PREFIX=\"pragmatika-patch9s\"' '$PS' \
   && grep -q 'ARCHIVE_PREFIX=\"patch9s\"' '$PS' && grep -q 'RUN_PREFIX=\"patch-9s\"' '$PS'"
assert "patch.sh: версии lock - константы (боевая 1.1.10-pragmatika.1, целевая .2)" \
  "grep -q '^LOCK_VERSION_FROM=\"$VER_FROM\"' '$PS' \
   && grep -q '^LOCK_VERSION_TO=\"$VER_TO\"' '$PS' \
   && grep -q '^PLATFORM_NOW=\"$PLATFORM_VER\"' '$PS'"
assert "patch.sh: откатные версии образов - из lock боя (нет жёстких digest)" \
  "! grep -vE '^[[:space:]]*#' '$PS' | grep -qE 'sha256:[0-9a-f]{16,}'"
assert "patch.sh: в тексте нет упоминаний инструментов разработки и ИИ" \
  "! grep -qiE 'cla[u]de|anthr[o]pic|\\bcopil[o]t\\b|\\bg[p]t\\b' '$PS' '$SD' '$0'"
# Стенд-заглушка для синтетической проверки: метка 9s, порты стенда 21400-21449 на 127.0.0.1,
# том приёма у app, без упоминаний прежних патчей как своего этапа.
assert "стенд-заглушка на месте, метка bai.stage=9s у обоих сервисов" \
  "[[ -f '$SD' ]] && [[ \$(grep -c 'bai.stage: \"9s\"' '$SD') -eq 2 ]]"
assert "стенд-заглушка: порты по умолчанию 21400 и 21401 на 127.0.0.1 (диапазон 21400-21449)" \
  "grep -q '127.0.0.1:\${STAND_APP_PORT:-21400}:8088' '$SD' \
   && grep -q '127.0.0.1:\${STAND_DOCS_PORT:-21401}:8310' '$SD' \
   && ! grep -E '\"[0-9.]+:[0-9]+:' '$SD' | grep -qv '127.0.0.1'"
assert "стенд-заглушка: у app смонтирован том intake-data по пути INTAKE_ROOT" \
  "grep -q 'intake-data:$INTAKE_ROOT_PATH' '$SD'"
assert "стенд-заглушка: нет метки и баз портов прежних стендов (9u, 21700)" \
  "! grep -qE '9u|9U|2170[0-9]' '$SD'"

echo "проверок: $((PASS + FAIL)), провалено: $FAIL"
[[ "$FAIL" -eq 0 ]]
