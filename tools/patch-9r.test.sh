#!/usr/bin/env bash
# Тест deploy/patch-9r/patch.sh (патч G9r: платформа 1.1.6 -> 1.1.10, катятся ДВА образа проекта
# pragmatika-documents и pragmatika-app 1.1.10-pragmatika.1; из файлов дерева заменяются images.lock
# и копия платформы platform/compose.base.yml с platform/PLATFORM-VERSION, compose.project.yml в
# пакете необязателен; новые переменные платформы: app B24_CALL_RECORDING_MAX_BYTES и
# B24_CALL_RECORDING_TIMEOUT_MS, documents DOCUMENTS_EDIT_PDF_TEXT; значения из .env боя, иначе
# умолчания платформы) без настоящего Docker: вместо docker - заглушка с памятью о контейнерах,
# их образах, окружении и времени старта (в том числе пробы /health, /ready, POST /docx/pages и
# POST /parse с locations=true и `compose config --format json`). Проверяются отказы по
# предусловиям (бой не тронут, код 3), в том числе «патч G9q3 не применён», чужой ключ lock, lock
# без смены образа app или documents, чужой файл deploy/ в пакете, битая копия платформы, значения
# новых переменных вне допустимых, иное различие в конфигурации compose и повторный запуск;
# устойчивость сравнения конфигураций к каталогу рендера (корень примерки не равен боевому, пути
# выше deploy); нехватка диска и памяти; --preflight-only (дерево побайтно прежнее); успешный ход
# (documents, затем app; образы, четыре флага G8x, DOCUMENTS_EDIT_PDF_TEXT, пробы /docx/pages и
# /parse, значения переменных G9q-G8w не изменились, новые переменные равны эффективным; явный
# выключатель PDF вне таблиц в .env боя остаётся выключателем, .env не меняется); разные ответы
# проб; сбои на каждом шаге с автооткатом (код 1, дерево побайтно прежнее, оба контейнера на
# образах G9q3); невозможный откат (код 4); ручной --rollback; настоящий JS проб (если на хосте
# есть bun) против локального сервера; стиль. Ход на настоящем Docker проверяет
# tools/patch-9r-synth.sh. PATCH9R_SRC подменяет каталог со скриптом (красный прогон на патче G9q3).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="${PATCH9R_SRC:-$ROOT/deploy/patch-9r}"
TMP="${PATCH9R_TEST_TMP:-$(mktemp -d)}"
SERVER_PID=""
# PATCH9R_TEST_KEEP=1 оставляет рабочий каталог теста (выводы и журналы запусков) для разбора.
cleanup() {
  [[ -z "$SERVER_PID" ]] || kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "${PATCH9R_TEST_KEEP:-}" ]] || rm -rf "${TMP:?}"
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
VER_FROM="1.1.6-pragmatika.7"
VER_TO="1.1.10-pragmatika.1"
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
H_SPEECH="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
H_SPEECH2="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
H_BASE_NEW="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
H_DBASE_NEW="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
# Секрет только в окружении контейнера app и в выводе compose config (короче порога маскирования
# журнала): если он попал в журнал или архив, значит, патч печатает окружение или конфигурацию.
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
# Что видит docker из оболочечных переменных: патч обязан их сбросить.
echo "${EMPTY_REPLY_GUARD_ENABLED-<unset>} ${PRICE_EDIT_DB_WRITE_ENABLED-<unset>}" \
  "${PRICE_EDIT_TEXT_BLOCKS_ENABLED-<unset>}" \
  "${PRICE_EDIT_FIRST_ENABLED-<unset>} ${DOCX_PAGES_ENABLED-<unset>}" \
  "${SHORTLIST_PAGING_ENABLED-<unset>} ${SUPPLIER_DISCOVERY_ENABLED-<unset>}" \
  "${B24_CALL_RECORDING_MAX_BYTES-<unset>} ${B24_CALL_RECORDING_TIMEOUT_MS-<unset>}" \
  "${DOCUMENTS_EDIT_PDF_TEXT-<unset>}" >>"$STUB/shellenv.log"
set_image() { # set_image <имя> <образ>: заменить или добавить строку контейнера
  grep -v "^$1"$'\t' "$STUB/containers" >"$STUB/containers.n" || true
  printf '%s\t%s\n' "$1" "$2" >>"$STUB/containers.n"
  mv "$STUB/containers.n" "$STUB/containers"
}
lock_ref() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2-; }
# Значение переменной для заглушки: из .env, затем secrets.env дерева (без кавычек), пусто -
# умолчание.
stub_val() { # stub_val <каталог deploy> <ИМЯ> <умолчание>
  local v
  v="$(cat "$1/.env" "$1/secrets.env" 2>/dev/null | sed -n "s/^$2=//p" | tail -1 \
    | tr -d "\"'")"
  echo "${v:-$3}"
}
# Копия платформы дерева новая (1.1.10): в ней есть переменная правки PDF вне таблиц.
new_platform() { grep -q 'DOCUMENTS_EDIT_PDF_TEXT' "$1/platform/compose.base.yml" 2>/dev/null; }
bump_started() { # bump_started <имя>: новое время старта контейнера
  local n
  n="$(cat "$STUB/counter" 2>/dev/null || echo 0)"
  n=$((n + 1))
  echo "$n" >"$STUB/counter"
  printf '2026-11-22T10:00:%02dZ\n' "$n" >"$STUB/started/$1"
}
docs_is_new() { grep "^p-documents-1"$'\t' "$STUB/containers" | grep -q "$H_NEW_DOCS"; }
app_is_new() { grep "^p-app-1"$'\t' "$STUB/containers" | grep -q "$H_NEW_APP"; }
# Ответ пробы /docx/pages: новый образ documents - «422 bad_request», старый (ручки нет) - «404 -».
# Статус и код ошибки нового образа настраиваются.
pages_reply() {
  local old=0
  if [[ "${STUB_PAGES_DOWN:-0}" == 1 ]]; then echo "documents недоступен: refused"; exit 1; fi
  docs_is_new || old=1
  [[ "${STUB_PAGES_OLD_BEHAVIOR:-0}" != 1 ]] || old=1
  if [[ "${STUB_PAGES_APP_STAGE_FAIL:-0}" == 1 ]] && app_is_new; then old=1; fi
  if ((old)); then
    echo "${STUB_PAGES_OLD_REPLY:-404 -}"
  else
    echo "${STUB_PAGES_CODE:-422} ${STUB_PAGES_ERR-bad_request}"
  fi
  exit 0
}
# Ответ пробы /parse с locations=true: образ G9r со включённой правкой PDF вне таблиц отдаёт
# «200 pdf 1 1», со старым образом или выключателем (значение в окружении documents - слово
# «выкл») - «200 - - -». Ответ настраивается.
parse_reply() {
  local flag
  if [[ "${STUB_PARSE_DOWN:-0}" == 1 ]]; then echo "documents недоступен: refused"; exit 1; fi
  if [[ "${STUB_PARSE_APP_STAGE_FAIL:-0}" == 1 ]] && app_is_new; then
    echo "200 - - -"; exit 0
  fi
  if [[ -n "${STUB_PARSE_REPLY:-}" ]]; then echo "$STUB_PARSE_REPLY"; exit 0; fi
  flag="$(sed -n 's/^DOCUMENTS_EDIT_PDF_TEXT=//p' "$STUB/env/p-documents-1" | tail -1)"
  if docs_is_new && [[ ! "${flag,,}" =~ ^(0|false|off|no)$ ]]; then
    echo "200 pdf 1 1"
  else
    echo "200 - - -"
  fi
  exit 0
}
# Конфигурация compose одним JSON. Новые переменные платформы есть только в конфигурации с новой
# копией платформы; значения - из .env дерева (иначе умолчание платформы); переменные G9q3-G8w
# есть всегда (бой после G9q3); ручки STUB_CFG_* портят только конфигурацию с новой копией. Образы
# app и documents и основа сборки app берутся из lock дерева (они различаются у боя и примерки -
# это допустимо). Как настоящий compose, пути раскрываются от каталога файлов: том app лежит под
# deploy, а контекст сборки app и том migrate - ВЫШЕ deploy (`../..`), то есть зависят от корня
# дерева (боевого или примерки): проверка нормализации корня.
config_json() { # config_json <каталог deploy> <lock>
  local dir="$1" lock="$2" newp=0 mem=1g pptx=true pg=r/postgres@sha256:pg
  local root ctx vol paging dbw base b24max b24to pdft
  root="$(dirname "$dir")"
  ctx="$root"
  vol="$root/db/app"
  base="$(lock_ref "$lock" BAI_IMAGE_APP_BASE)"
  new_platform "$dir" && newp=1
  if ((newp == 0)) && [[ "${STUB_LIVE_CFG_FAIL:-0}" == 1 ]]; then exit 1; fi
  [[ "${STUB_CFG_BAD_JSON:-0}" != 1 ]] || { echo '{"services":'; exit 0; }
  paging="$(stub_val "$dir" SHORTLIST_PAGING_ENABLED true)"
  dbw="$(stub_val "$dir" PRICE_EDIT_DB_WRITE_ENABLED true)"
  b24max="${STUB_CFG_B24_MAX:-$(stub_val "$dir" B24_CALL_RECORDING_MAX_BYTES 104857600)}"
  b24to="$(stub_val "$dir" B24_CALL_RECORDING_TIMEOUT_MS 600000)"
  pdft="${STUB_CFG_PDF_TEXT-$(stub_val "$dir" DOCUMENTS_EDIT_PDF_TEXT "")}"
  if ((newp)); then
    [[ "${STUB_CFG_APP_DRIFT:-0}" != 1 ]] || mem=2g
    [[ "${STUB_CFG_DOCS_DRIFT:-0}" != 1 ]] || pptx=false
    [[ "${STUB_CFG_OTHER_DRIFT:-0}" != 1 ]] || pg=r/postgres@sha256:other
    [[ "${STUB_CFG_CONTEXT_DRIFT:-0}" != 1 ]] || ctx=/elsewhere/src
    [[ "${STUB_CFG_PATH_DRIFT:-0}" != 1 ]] || vol=/elsewhere/db/app
    [[ "${STUB_CFG_G8Z_DRIFT:-0}" != 1 ]] || paging=changed
    [[ "${STUB_CFG_G9Q_DRIFT:-0}" != 1 ]] || dbw=changed
    [[ "${STUB_CFG_BASE_DRIFT:-0}" != 1 ]] || base=r/app-base@sha256:elsewhere
  fi
  echo "context $ctx" >>"$STUB/cfg-roots.log"
  printf '{"name":"p","services":{'
  if [[ "${STUB_CFG_NO_APP:-0}" != 1 ]]; then
    printf '"app":{"image":"%s","mem_limit":"%s",' "$(lock_ref "$lock" BAI_IMAGE_APP)" "$mem"
    printf '"build":{"context":"%s","args":{"BAI_APP_BASE":"%s"}},' "$ctx" "$base"
    printf '"volumes":[{"type":"bind","source":"%s/nginx.conf"}],' "$dir"
    printf '"environment":{"OPENAI_API_KEY":"%s","YANDEX_SEARCH_MAX_CONCURRENCY":"1",' \
      "$APP_ENV_SECRET"
    printf '"YANDEX_SEARCH_MIN_INTERVAL_MS":"1200","SHORTLIST_PAGING_ENABLED":"%s",' "$paging"
    printf '"SUPPLIER_DISCOVERY_ENABLED":"%s",' "$(stub_val "$dir" SUPPLIER_DISCOVERY_ENABLED true)"
    printf '"PRICE_EDIT_FIRST_ENABLED":"%s",' "$(stub_val "$dir" PRICE_EDIT_FIRST_ENABLED true)"
    printf '"DOCX_PAGES_ENABLED":"%s","PRICE_EDIT_DB_WRITE_ENABLED":"%s",' \
      "$(stub_val "$dir" DOCX_PAGES_ENABLED true)" "$dbw"
    printf '"PRICE_EDIT_TEXT_BLOCKS_ENABLED":"%s",' \
      "$(stub_val "$dir" PRICE_EDIT_TEXT_BLOCKS_ENABLED true)"
    printf '"EMPTY_REPLY_GUARD_ENABLED":"%s"' "$(stub_val "$dir" EMPTY_REPLY_GUARD_ENABLED true)"
    if ((newp)); then
      [[ "${STUB_CFG_NO_B24:-0}" == 1 ]] || printf ',"B24_CALL_RECORDING_MAX_BYTES":"%s"' "$b24max"
      printf ',"B24_CALL_RECORDING_TIMEOUT_MS":"%s"' "$b24to"
    fi
    printf '}},'
  fi
  printf '"documents":{"image":"%s","environment":{"DOCUMENTS_EDIT_PPTX":"%s",' \
    "$(lock_ref "$lock" BAI_IMAGE_DOCUMENTS)" "$pptx"
  printf '"DOCUMENTS_EDIT_PDF":"true","DOCUMENTS_PPT_CONVERT":"true",'
  if ((newp)) && [[ "${STUB_CFG_NO_PDF_TEXT:-0}" != 1 ]]; then
    printf '"DOCUMENTS_EDIT_PDF_TEXT":"%s",' "$pdft"
  fi
  printf '"DOCUMENTS_EDIT_PDF_FALLBACK_FONT":"false"}},'
  if ((newp)) && [[ "${STUB_CFG_SPEECH:-0}" == 1 ]]; then
    printf '"speech":{"image":"r/speech@sha256:%s"},' "$(lock_ref "$lock" BAI_IMAGE_SPEECH)"
  fi
  printf '"migrate":{"volumes":[{"type":"bind","source":"%s"}]},' "$vol"
  printf '"postgres":{"image":"%s"}}}\n' "$pg"
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
            ref="$(lock_ref "$lock" BAI_IMAGE_DOCUMENTS)"
            pdf=true
            fallback=false
            flags=1
            pdftext="$(stub_val "$dir" DOCUMENTS_EDIT_PDF_TEXT "")"
            if [[ "$ref" == *"$H_NEW_DOCS"* ]]; then
              [[ "${STUB_DOCS_UP_FAIL:-0}" != 1 ]] || { echo "compose: ошибка up" >&2; exit 1; }
              [[ "${STUB_WRONG_DOCS_IMAGE:-0}" != 1 ]] || ref="r/documents@sha256:wrong"
              pdf="${STUB_ENV_PDF:-true}"
              fallback="${STUB_ENV_FALLBACK:-false}"
              pdftext="${STUB_ENV_PDF_TEXT-$pdftext}"
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
              if new_platform "$dir"; then
                echo "DOCUMENTS_EDIT_PDF_TEXT=$pdftext" >>"$STUB/env/p-documents-1.n"
              fi
            fi
            mv "$STUB/env/p-documents-1.n" "$STUB/env/p-documents-1" ;;
          app)
            ref="$(lock_ref "$lock" BAI_IMAGE_APP)"
            isnew=0
            if [[ "$ref" == *"$H_NEW_APP"* ]]; then
              isnew=1
              [[ "${STUB_UP_FAIL:-0}" != 1 ]] || { echo "compose: ошибка up" >&2; exit 1; }
              [[ "${STUB_WRONG_APP_IMAGE:-0}" != 1 ]] || ref="r/app@sha256:wrong"
            fi
            set_image p-app-1 "$ref"
            bump_started p-app-1
            grep -vE '^(YANDEX_|SHORTLIST_|SUPPLIER_DISCOVERY_|PRICE_EDIT_|DOCX_PAGES_|B24_)' \
              "$STUB/env/p-app-1" | grep -v '^EMPTY_REPLY_' >"$STUB/env/p-app-1.n" || true
            if [[ "${STUB_APP_LOSE_YANDEX:-0}" != 1 || $isnew != 1 ]]; then
              echo "YANDEX_SEARCH_MAX_CONCURRENCY=1" >>"$STUB/env/p-app-1.n"
              echo "YANDEX_SEARCH_MIN_INTERVAL_MS=1200" >>"$STUB/env/p-app-1.n"
            fi
            if [[ "${STUB_APP_LOSE_G8Z:-0}" != 1 || $isnew != 1 ]]; then
              echo "SHORTLIST_PAGING_ENABLED=$(stub_val "$dir" SHORTLIST_PAGING_ENABLED true)" \
                >>"$STUB/env/p-app-1.n"
              echo "SUPPLIER_DISCOVERY_ENABLED=true" >>"$STUB/env/p-app-1.n"
            fi
            if [[ "${STUB_APP_LOSE_G9P:-0}" != 1 || $isnew != 1 ]]; then
              echo "PRICE_EDIT_FIRST_ENABLED=$(stub_val "$dir" PRICE_EDIT_FIRST_ENABLED true)" \
                >>"$STUB/env/p-app-1.n"
              echo "DOCX_PAGES_ENABLED=$(stub_val "$dir" DOCX_PAGES_ENABLED true)" \
                >>"$STUB/env/p-app-1.n"
            fi
            if [[ "${STUB_APP_LOSE_G9Q:-0}" != 1 || $isnew != 1 ]]; then
              dbw="$(stub_val "$dir" PRICE_EDIT_DB_WRITE_ENABLED true)"
              [[ $isnew != 1 ]] || dbw="${STUB_ENV_DB_WRITE:-$dbw}"
              echo "EMPTY_REPLY_GUARD_ENABLED=$(stub_val "$dir" \
                EMPTY_REPLY_GUARD_ENABLED true)" >>"$STUB/env/p-app-1.n"
              echo "PRICE_EDIT_DB_WRITE_ENABLED=$dbw" >>"$STUB/env/p-app-1.n"
              echo "PRICE_EDIT_TEXT_BLOCKS_ENABLED=$(stub_val "$dir" \
                PRICE_EDIT_TEXT_BLOCKS_ENABLED true)" >>"$STUB/env/p-app-1.n"
            fi
            if new_platform "$dir" && [[ "${STUB_APP_NO_NEWVARS:-0}" != 1 ]]; then
              echo "B24_CALL_RECORDING_MAX_BYTES=${STUB_ENV_B24_MAX:-$(stub_val "$dir" \
                B24_CALL_RECORDING_MAX_BYTES 104857600)}" >>"$STUB/env/p-app-1.n"
              [[ "${STUB_APP_NO_B24_TIMEOUT:-0}" == 1 ]] \
                || echo "B24_CALL_RECORDING_TIMEOUT_MS=$(stub_val "$dir" \
                  B24_CALL_RECORDING_TIMEOUT_MS 600000)" >>"$STUB/env/p-app-1.n"
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
    # У G9r внутри контейнеров проверять нечего: любой docker exec - ошибка патча.
    echo "docker exec не нужен патчу G9r" >&2
    exit 99 ;;
  run)
    if [[ "$*" == *"bun"* ]]; then
      [[ "${STUB_NO_READY:-0}" != 1 ]] || { echo "app недоступен"; exit 1; }
      # Откат не удался: после первого up стенд больше не отвечает
      if [[ "${STUB_STUCK:-0}" == 1 && -e "$STUB/started-any" ]]; then
        echo "app недоступен"; exit 1
      fi
      case "$*" in
        *"fetch(base + '/docx/pages'"*)
          # Настоящий JS пробы против локального сервера (тест разбора ответа).
          if [[ -n "${STUB_REAL_JS_URL:-}" ]]; then
            body="$(printf '%s\n' "$@" | sed -n 's/^PATCH_PAGES_BODY=//p')"
            PATCH_DOCS_URL="$STUB_REAL_JS_URL" PATCH_PAGES_BODY="$body" bun -e "${*: -1}"
            exit $?
          fi
          pages_reply ;;
        *"fetch(base + '/parse'"*)
          if [[ -n "${STUB_REAL_PARSE_URL:-}" ]]; then
            PATCH_DOCS_URL="$STUB_REAL_PARSE_URL" bun -e "${*: -1}"
            exit $?
          fi
          parse_reply ;;
        *"/health"*)
          if [[ "${STUB_DOCS_HEALTH_500:-0}" == 1 ]] && docs_is_new; then
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

# --- Боевое дерево (после G9q3), пакет и заглушки инструментов ---------------------------------
LIVE_ROOT="$TMP/opt/pragmatika-v2"
LIVE="$LIVE_ROOT/deploy"
GOLDEN="$TMP/golden"
PKG="$TMP/pkg"
PKGG="$TMP/pkg-golden"
OLD_APP="r/app@sha256:$H_OLD_APP"
NEW_APP="r/app@sha256:$H_NEW_APP"
OLD_DOCS="r/pragmatika-documents@sha256:$H_OLD_DOCS"
NEW_DOCS="r/pragmatika-documents@sha256:$H_NEW_DOCS"
write_lock() { # write_lock <файл> <app> <основа app> <documents> <основа docs> <speech> <версия>
  {
    echo "BAI_VERSION=$7"
    echo "BAI_IMAGE_APP=$2"
    echo "BAI_IMAGE_APP_BASE=$3"
    echo "BAI_IMAGE_ALLOY=r/alloy@sha256:$H_ALLOY"
    echo "BAI_IMAGE_MASK=r/mask@sha256:$H_MASK"
    echo "BAI_IMAGE_DOCUMENTS=$4"
    echo "BAI_IMAGE_DOCUMENTS_BASE=$5"
    echo "BAI_IMAGE_SPEECH=r/speech@sha256:$6"
  } >"$1"
}
# compose.project.yml боя (после G9q3; на этом этапе не меняется) - одинаковый у боя и пакета.
write_compose() { # write_compose <файл> [значение по умолчанию флагов G9q]
  {
    printf 'services:\n  app:\n    environment:\n'
    printf '      YANDEX_SEARCH_MAX_CONCURRENCY: ${YANDEX_SEARCH_MAX_CONCURRENCY:-1}\n'
    printf '      YANDEX_SEARCH_MIN_INTERVAL_MS: ${YANDEX_SEARCH_MIN_INTERVAL_MS:-1200}\n'
    printf '      SHORTLIST_PAGING_ENABLED: ${SHORTLIST_PAGING_ENABLED:-true}\n'
    printf '      SUPPLIER_DISCOVERY_ENABLED: ${SUPPLIER_DISCOVERY_ENABLED:-true}\n'
    printf '      PRICE_EDIT_FIRST_ENABLED: ${PRICE_EDIT_FIRST_ENABLED:-true}\n'
    printf '      DOCX_PAGES_ENABLED: ${DOCX_PAGES_ENABLED:-true}\n'
    printf '      PRICE_EDIT_DB_WRITE_ENABLED: ${PRICE_EDIT_DB_WRITE_ENABLED:-%s}\n' "${2:-true}"
    printf '      PRICE_EDIT_TEXT_BLOCKS_ENABLED: ${PRICE_EDIT_TEXT_BLOCKS_ENABLED:-%s}\n' \
      "${2:-true}"
    printf '      EMPTY_REPLY_GUARD_ENABLED: ${EMPTY_REPLY_GUARD_ENABLED:-true}\n'
    printf '  documents:\n    environment:\n'
    printf '      DOCUMENTS_EDIT_PPTX: ${DOCUMENTS_EDIT_PPTX:-true}\n'
    printf '      DOCUMENTS_EDIT_PDF: ${DOCUMENTS_EDIT_PDF:-true}\n'
    printf '      DOCUMENTS_PPT_CONVERT: ${DOCUMENTS_PPT_CONVERT:-true}\n'
    printf '      DOCUMENTS_EDIT_PDF_FALLBACK_FONT: ${DOCUMENTS_EDIT_PDF_FALLBACK_FONT:-false}\n'
  } >"$1"
}
# Копия платформы пакета: compose.base.yml с новыми переменными и PLATFORM-VERSION с суммой.
write_platform_pkg() { # write_platform_pkg <каталог deploy> [версия] [строки compose.base.yml]
  local dir="$1" version="${2:-1.1.10}" body="${3-}"
  mkdir -p "$dir/platform"
  if [[ -z "$body" ]]; then
    body='# base 1.1.10 stub
      DOCUMENTS_EDIT_PDF_TEXT: ${DOCUMENTS_EDIT_PDF_TEXT:-}
      B24_CALL_RECORDING_MAX_BYTES: ${B24_CALL_RECORDING_MAX_BYTES:-104857600}
      B24_CALL_RECORDING_TIMEOUT_MS: ${B24_CALL_RECORDING_TIMEOUT_MS:-600000}'
  fi
  printf '%s\n' "$body" >"$dir/platform/compose.base.yml"
  printf 'PLATFORM_PACKAGES_VERSION=%s\nsha256 %s  compose.base.yml\n' "$version" \
    "$(sha256sum "$dir/platform/compose.base.yml" | cut -d' ' -f1)" \
    >"$dir/platform/PLATFORM-VERSION"
}
mkdir -p "$GOLDEN/platform" "$GOLDEN/hotfix" "$PKGG/tools" "$PKGG/deploy"
# Основы app и documents и speech у G9q3 и G9r разные: платформа 1.1.6 -> 1.1.10.
write_lock "$GOLDEN/images.lock" "$OLD_APP" "r/app-base@sha256:$H_BASE" "$OLD_DOCS" \
  "r/bai-documents@sha256:$H_DBASE" "$H_SPEECH" "$VER_FROM"
write_lock "$PKGG/images.lock" "$NEW_APP" "r/app-base@sha256:$H_BASE_NEW" "$NEW_DOCS" \
  "r/bai-documents@sha256:$H_DBASE_NEW" "$H_SPEECH2" "$VER_TO"
echo "services: {}" >"$GOLDEN/compose.yml"
echo "MARK=old" >"$GOLDEN/compat.env"
write_compose "$GOLDEN/compose.project.yml"
write_compose "$PKGG/deploy/compose.project.yml"
printf '# base 1.1.6 stub\n' >"$GOLDEN/platform/compose.base.yml"
printf 'PLATFORM_PACKAGES_VERSION=1.1.6\nsha256 %s  compose.base.yml\n' \
  "$(sha256sum "$GOLDEN/platform/compose.base.yml" | cut -d' ' -f1)" \
  >"$GOLDEN/platform/PLATFORM-VERSION"
write_platform_pkg "$PKGG/deploy"
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

reset_stand() { # reset_stand: бой «после G9q3» (дерево, контейнеры, окружение), пакет как собран
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
  printf 'SHORTLIST_PAGING_ENABLED=true\nSUPPLIER_DISCOVERY_ENABLED=true\n' >>"$STUB/env/p-app-1"
  printf 'PRICE_EDIT_FIRST_ENABLED=true\nDOCX_PAGES_ENABLED=true\n' >>"$STUB/env/p-app-1"
  printf 'PRICE_EDIT_DB_WRITE_ENABLED=true\nPRICE_EDIT_TEXT_BLOCKS_ENABLED=true\n' \
    >>"$STUB/env/p-app-1"
  printf 'EMPTY_REPLY_GUARD_ENABLED=true\n' >>"$STUB/env/p-app-1"
  printf 'DOCUMENTS_EDIT_PPTX=true\nDOCUMENTS_EDIT_PDF=true\nDOCUMENTS_PPT_CONVERT=true\n' \
    >>"$STUB/env/p-documents-1"
  printf 'DOCUMENTS_EDIT_PDF_FALLBACK_FONT=false\n' >>"$STUB/env/p-documents-1"
  : >"$STUB/missing"
  : >"$STUB/shellenv.log"
  reset_pkg
}

# Хэши и права всех файлов боевого дерева: «побайтно прежнее» = равенство снимков.
tree_snapshot() { (cd "$LIVE" && find . -type f | sort | xargs -d '\n' sha256sum \
  && find . -type f -printf '%m %p\n' | sort); }
# Хэши файлов дерева, КРОМЕ images.lock и копии платформы: патч G9r их менять вправе
# (compose.project.yml патч не меняет, пока он равен пакетному).
tree_without_patched() { (cd "$LIVE" && find . -type f ! -name 'images.lock' \
  ! -path './platform/compose.base.yml' ! -path './platform/PLATFORM-VERSION' | sort \
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
    PATCH9R_MIN_DISK_MIB="${T_MIN_DISK:-1}" PATCH9R_MIN_AVAILABLE_MIB="${T_MIN_MEM:-1}" \
    PATCH9R_SOAK_POLL_S=1 \
    bash "$PKG/patch.sh" --soak-seconds 2 "$@" >"$TMP/out-$name" 2>&1 || RC=$?
}
no_mutation() { ! grep -E "$MUTATING_RE" "$TMP/docker-$1.log" | grep -qv '^compose version'; }
out_has() { grep -q -- "$2" "$TMP/out-$1"; }
app_up_count() { grep -cE '^compose .* up -d --no-deps app$' "$TMP/docker-$1.log" || true; }
docs_up_count() { grep -cE '^compose .* up -d --no-deps documents$' "$TMP/docker-$1.log" || true; }
other_up() { grep -E '^compose .* up ' "$TMP/docker-$1.log" \
  | grep -vE ' up -d --no-deps (app|documents)$'; }
pages_probe_count() { grep -c "fetch(base + '/docx/pages'" "$TMP/docker-$1.log" || true; }
parse_probe_count() { grep -c "fetch(base + '/parse'" "$TMP/docker-$1.log" || true; }
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

# Чужие ключи lock: alloy, mask. Допустимы только версия, образы app и documents и ключи,
# которые поменяла платформа (основы app и documents, speech).
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
pkg_lock_edit '/^BAI_IMAGE_ALLOY=/d'
run lockdelkey
refuse_case lockdelkey "lock пакета теряет чужой ключ (alloy)"
reset_pkg
pkg_lock_edit "s|^BAI_VERSION=.*|BAI_VERSION=1.1.6-pragmatika.7|"
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
pkg_lock_edit "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=$OLD_DOCS|"
run samedocs
refuse_case samedocs "lock пакета не меняет образ documents"
assert "тот же образ documents: сообщение называет ключ" "out_has samedocs 'BAI_IMAGE_DOCUMENTS'"
reset_pkg
pkg_lock_edit "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=r/pragmatika-documents:latest|"
run docstag
refuse_case docstag "образ documents в lock пакета по тегу, не по digest"
reset_pkg
pkg_lock_edit '/^BAI_IMAGE_DOCUMENTS=/d'
run nodocslock
refuse_case nodocslock "в lock пакета нет BAI_IMAGE_DOCUMENTS"
reset_pkg
pkg_lock_edit '/^BAI_IMAGE_APP_BASE=/d'
run noappbase
refuse_case noappbase "в lock пакета нет основы app"
assert "нет основы app: сообщение называет ключ" "out_has noappbase 'BAI_IMAGE_APP_BASE'"
# Основы и speech допустимо оставить прежними (платформа могла их не менять).
reset_stand
pkg_lock_edit "s|^BAI_IMAGE_APP_BASE=.*|BAI_IMAGE_APP_BASE=r/app-base@sha256:$H_BASE|"
pkg_lock_edit "s|^BAI_IMAGE_SPEECH=.*|BAI_IMAGE_SPEECH=r/speech@sha256:$H_SPEECH|"
run keepbases --preflight-only
assert "основа app и speech прежние: допустимо, preflight код 0" "[[ $RC -eq 0 ]]"

# G9q3 не применён: разные признаки, подсказка «сначала примените патч G9q3».
g9q2_case() { # g9q2_case <имя> <описание>: код 3, бой не тронут, подсказка в сообщении
  assert "$2: код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
  assert "$2: бой не тронут" "no_mutation $1 && [[ \"\$(tree_snapshot)\" == \"\$T1\" ]]"
  assert "$2: сообщение «сначала примените патч G9q3»" "out_has $1 'сначала примените патч G9q3'"
}
for old_ver in 1.1.6-pragmatika.6 1.1.6-pragmatika.5 1.1.6-pragmatika.4 1.1.5-pragmatika.3; do
  reset_stand
  sed -i "s|^BAI_VERSION=.*|BAI_VERSION=$old_ver|" "$LIVE/images.lock"
  T1="$(tree_snapshot)"
  run "lockver-$old_ver"
  g9q2_case "lockver-$old_ver" "G9q3 не применён: BAI_VERSION боя $old_ver"
  assert "версия lock $old_ver: сообщение называет ожидаемую" \
    "out_has 'lockver-$old_ver' '$VER_FROM'"
done
reset_stand
printf 'PLATFORM_PACKAGES_VERSION=1.1.5\n' >"$LIVE/platform/PLATFORM-VERSION"
T1="$(tree_snapshot)"
run platform115
g9q2_case platform115 "G9q3 не применён: платформа боя 1.1.5"
reset_stand
rm -f "$LIVE/platform/PLATFORM-VERSION"
T1="$(tree_snapshot)"
run noplatform
g9q2_case noplatform "G9q3 не применён: нет PLATFORM-VERSION"
reset_stand
sed -i "s|^p-app-1.*|p-app-1\tr/app@sha256:other|" "$STUB/containers"
T1="$(tree_snapshot)"
run appimage
g9q2_case appimage "G9q3 не применён: app не на образе из lock боя"
reset_stand
sed -i "s|^p-documents-1.*|p-documents-1\tr/other-documents@sha256:other|" "$STUB/containers"
T1="$(tree_snapshot)"
run docsimage
g9q2_case docsimage "G9q3 не применён: documents не на образе из lock боя"
for app_var in YANDEX_SEARCH_MAX_CONCURRENCY YANDEX_SEARCH_MIN_INTERVAL_MS \
  SHORTLIST_PAGING_ENABLED SUPPLIER_DISCOVERY_ENABLED PRICE_EDIT_FIRST_ENABLED \
  DOCX_PAGES_ENABLED PRICE_EDIT_DB_WRITE_ENABLED PRICE_EDIT_TEXT_BLOCKS_ENABLED \
  EMPTY_REPLY_GUARD_ENABLED; do
  reset_stand
  sed -i "/^$app_var=/d" "$STUB/env/p-app-1"
  T1="$(tree_snapshot)"
  run "no-$app_var"
  g9q2_case "no-$app_var" "G9q3 не применён: у app нет переменной $app_var"
  assert "нет $app_var: сообщение называет её" "out_has 'no-$app_var' '$app_var'"
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
  g9q2_case "flag-$flag-$how" "G9q3 не применён: флаг $flag ($how)"
  assert "флаг $flag ($how): сообщение называет флаг" "out_has 'flag-$flag-$how' '$flag'"
done

reset_stand
# Файлы дерева в пакете: разрешены compose.project.yml и две копии платформы; любой другой - отказ.
reset_pkg
cp "$GOLDEN/compose.yml" "$PKG/deploy/compose.yml"
seal
run depcomposeyml
refuse_case depcomposeyml "в пакете deploy/compose.yml"
assert "чужой файл deploy: сообщение называет файл" "out_has depcomposeyml 'deploy/compose.yml'"
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
cp "$GOLDEN/compat.env" "$PKG/deploy/compat.env"
seal
run depcompat
refuse_case depcompat "в пакете deploy/compat.env"
reset_pkg
mkdir -p "$PKG/deploy/platform/nginx"
echo "x" >"$PKG/deploy/platform/nginx/mtls-proxy.conf.template"
seal
run depnginx
refuse_case depnginx "в пакете deploy/platform/nginx (патч не меняет прочие файлы платформы)"
reset_pkg
mkdir -p "$PKG/deploy/db"
seal
run depdb
refuse_case depdb "в пакете deploy/db"
reset_pkg
rm -f "$PKG/deploy/platform/compose.base.yml"
seal
run nobase
refuse_case nobase "в пакете нет platform/compose.base.yml"
assert "нет compose.base.yml: сообщение называет файл" "out_has nobase 'platform/compose.base.yml'"
reset_pkg
rm -f "$PKG/deploy/platform/PLATFORM-VERSION"
seal
run noversionfile
refuse_case noversionfile "в пакете нет platform/PLATFORM-VERSION"
reset_pkg
rm -rf "${PKG:?}/deploy"
seal
run nodeploy
refuse_case nodeploy "в пакете нет каталога deploy"
reset_pkg
write_platform_pkg "$PKG/deploy" 1.1.6
seal
run oldplatformpkg
refuse_case oldplatformpkg "PLATFORM-VERSION пакета 1.1.6, а не 1.1.10"
assert "версия платформы пакета: сообщение называет 1.1.10" "out_has oldplatformpkg '1.1.10'"
reset_pkg
echo "# правка руками" >>"$PKG/deploy/platform/compose.base.yml"
seal
run basesum
refuse_case basesum "сумма compose.base.yml пакета не сходится с PLATFORM-VERSION"
assert "сумма: сообщение называет PLATFORM-VERSION" "out_has basesum 'PLATFORM-VERSION'"
for var in DOCUMENTS_EDIT_PDF_TEXT B24_CALL_RECORDING_MAX_BYTES B24_CALL_RECORDING_TIMEOUT_MS; do
  reset_pkg
  write_platform_pkg "$PKG/deploy" 1.1.10 "$(grep -v "$var" \
    "$PKGG/deploy/platform/compose.base.yml"; echo "# без новой переменной")"
  seal
  run "nonewvar-$var"
  refuse_case "nonewvar-$var" "в compose.base.yml пакета нет $var"
  assert "нет $var: сообщение называет переменную" "out_has 'nonewvar-$var' '$var'"
done
# compose.project.yml в пакете необязателен.
reset_pkg
rm -f "$PKG/deploy/compose.project.yml"
seal
run nocomposeproject --preflight-only
NOCP_RES="$TMP/home-nocomposeproject/.pragmatika-cutover/patch-9r-2*/results"
assert "без compose.project.yml в пакете: preflight код 0" "[[ $RC -eq 0 ]]"
assert "без compose.project.yml: в списке замены только копия платформы" \
  "[[ \"\$(LC_ALL=C sort $NOCP_RES/file-changes.txt | tr '\n' ' ')\" == \
     'platform/PLATFORM-VERSION platform/compose.base.yml ' ]]"
# Пакет с изменённым compose.project.yml (допустимое различие в конфигурации нет) заменяет файл.
reset_pkg
echo "# комментарий пакета" >>"$PKG/deploy/compose.project.yml"
seal
run composechanged --preflight-only
assert "compose.project.yml пакета отличается: preflight код 0, он в списке замены" \
  "[[ $RC -eq 0 ]] && grep -qx 'compose.project.yml' \
   '$TMP'/home-composechanged/.pragmatika-cutover/patch-9r-2*/results/file-changes.txt"
# Флаги G9q по умолчанию выключены в compose.project.yml пакета: собран неверно.
reset_pkg
write_compose "$PKG/deploy/compose.project.yml" false
seal
run cfgdeffalse
refuse_case cfgdeffalse "в compose.project.yml пакета по умолчанию false"
assert "default false: сообщение называет строку по умолчанию" "out_has cfgdeffalse ':-true}'"
reset_pkg
sed -i '/PRICE_EDIT_TEXT_BLOCKS_ENABLED/d' "$PKG/deploy/compose.project.yml"
seal
run cfgnoflag
refuse_case cfgnoflag "в compose.project.yml пакета нет PRICE_EDIT_TEXT_BLOCKS_ENABLED"
assert "нет флага: сообщение называет переменную" \
  "out_has cfgnoflag 'PRICE_EDIT_TEXT_BLOCKS_ENABLED'"
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

# Повторный запуск: lock боя уже равен lock пакета, версия или платформа уже целевые - код 3.
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
assert "версия lock боя уже целевая: сообщение называет G9r" "out_has lockverto 'G9r'"
reset_stand
cp "$PKG/deploy/platform/PLATFORM-VERSION" "$LIVE/platform/PLATFORM-VERSION"
T1="$(tree_snapshot)"
run platformto
assert "платформа боя уже 1.1.10 - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "платформа боя уже 1.1.10: «уже применён», бой не тронут" \
  "out_has platformto 'уже применён' && no_mutation platformto \
   && [[ \"\$(tree_snapshot)\" == \"\$T1\" ]]"
# Копия платформы боя уже равна пакетной при прежней версии: неожиданное состояние.
reset_stand
cp "$PKG/deploy/platform/compose.base.yml" "$LIVE/platform/compose.base.yml"
T1="$(tree_snapshot)"
run baseequal
assert "compose.base.yml боя равен пакетному при прежней версии - код 3" \
  "[[ $RC -eq $EXIT_REFUSED ]] && out_has baseequal 'уже равен пакетному' \
   && no_mutation baseequal && [[ \"\$(tree_snapshot)\" == \"\$T1\" ]]"

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

# Новые переменные платформы в конфигурации: обязаны быть и равняться эффективному значению
# (при пустом .env - умолчанию платформы); остальная конфигурация совпадает со снимком боя.
STUB_CFG_B24_MAX=1 run cfgb24
refuse_case cfgb24 "B24_CALL_RECORDING_MAX_BYTES=1 в новой конфигурации при пустом .env"
assert "b24: сообщение называет переменную" "out_has cfgb24 'B24_CALL_RECORDING_MAX_BYTES'"
assert "b24: сообщение называет эффективное значение" "out_has cfgb24 'эффективн'"
STUB_CFG_NO_B24=1 run cfgnob24
refuse_case cfgnob24 "в новой конфигурации у app нет B24_CALL_RECORDING_MAX_BYTES"
assert "нет b24: сообщение называет переменную" "out_has cfgnob24 'B24_CALL_RECORDING_MAX_BYTES'"
STUB_CFG_PDF_TEXT=false run cfgpdftext
refuse_case cfgpdftext "DOCUMENTS_EDIT_PDF_TEXT=false в новой конфигурации при пустом .env"
assert "pdf text: сообщение называет переменную" "out_has cfgpdftext 'DOCUMENTS_EDIT_PDF_TEXT'"
reset_stand
printf 'DOCUMENTS_EDIT_PDF_TEXT=false\n' >>"$LIVE/.env"
T0B="$(tree_snapshot)"
STUB_CFG_NO_PDF_TEXT=1 run cfgnopdftext
assert "нет DOCUMENTS_EDIT_PDF_TEXT в конфигурации documents при .env - код 3" \
  "[[ $RC -eq $EXIT_REFUSED ]] && out_has cfgnopdftext 'DOCUMENTS_EDIT_PDF_TEXT' \
   && no_mutation cfgnopdftext && [[ \"\$(tree_snapshot)\" == \"\$T0B\" ]]"
reset_stand
STUB_CFG_G8Z_DRIFT=1 run cfgg8z
refuse_case cfgg8z "переменная G8z у app в новой конфигурации изменилась"
assert "дрейф G8z: сообщение называет переменную" \
  "out_has cfgg8z 'services.app.environment.SHORTLIST_PAGING_ENABLED'"
STUB_CFG_G9Q_DRIFT=1 run cfgg9q
refuse_case cfgg9q "флаг G9q у app в новой конфигурации изменился"
assert "дрейф G9q: сообщение называет переменную" \
  "out_has cfgg9q 'services.app.environment.PRICE_EDIT_DB_WRITE_ENABLED'"
STUB_CFG_BASE_DRIFT=1 run cfgbase
refuse_case cfgbase "основа сборки app не из lock пакета"
assert "дрейф основы: сообщение называет аргумент BAI_APP_BASE" "out_has cfgbase 'BAI_APP_BASE'"
STUB_CFG_APP_DRIFT=1 run cfgappdrift
refuse_case cfgappdrift "прочая конфигурация app изменилась (mem_limit)"
assert "дрейф app: сообщение называет путь services.app.mem_limit" \
  "out_has cfgappdrift 'services.app.mem_limit'"
STUB_CFG_DOCS_DRIFT=1 run cfgdocsdrift
refuse_case cfgdocsdrift "конфигурация documents (кроме образа и новой переменной) иная"
assert "дрейф documents: сообщение называет путь" "out_has cfgdocsdrift 'services.documents'"
STUB_CFG_OTHER_DRIFT=1 run cfgotherdrift
refuse_case cfgotherdrift "конфигурация другого сервиса (postgres) изменилась"
assert "дрейф postgres: сообщение называет путь" "out_has cfgotherdrift 'services.postgres'"
STUB_CFG_SPEECH=1 run cfgspeech
refuse_case cfgspeech "профиль speech включён на бою: сервис speech появился в конфигурации"
assert "speech: сообщение называет путь services.speech" "out_has cfgspeech 'services.speech'"
assert "дрейф: значения конфигурации (секрет) не попали в вывод" \
  "! grep -rq '$APP_ENV_SECRET' '$TMP/out-cfgappdrift' '$TMP/out-cfgotherdrift' \
   '$TMP/home-cfgappdrift'"
# Корень дерева рендера: пути выше deploy (контекст сборки app, том migrate) раскрываются от
# каталога файлов и в примерке отличаются от боевых. Нормализуется корень, но любое реальное
# различие путей по-прежнему замечается.
STUB_CFG_CONTEXT_DRIFT=1 run cfgctxdrift
refuse_case cfgctxdrift "контекст сборки app указывает в другое место"
assert "дрейф контекста: сообщение называет services.app.build.context" \
  "out_has cfgctxdrift 'services.app.build.context'"
STUB_CFG_PATH_DRIFT=1 run cfgpathdrift
refuse_case cfgpathdrift "том migrate указывает в другое место"
assert "дрейф тома: сообщение называет services.migrate.volumes" \
  "out_has cfgpathdrift 'services.migrate.volumes'"
# Оболочечные переменные патч сбрасывает: значение из окружения запуска сильнее .env.
PRICE_EDIT_FIRST_ENABLED=true DOCX_PAGES_ENABLED=true SHORTLIST_PAGING_ENABLED=false \
  EMPTY_REPLY_GUARD_ENABLED=false PRICE_EDIT_DB_WRITE_ENABLED=false \
  PRICE_EDIT_TEXT_BLOCKS_ENABLED=false \
  SUPPLIER_DISCOVERY_ENABLED=false B24_CALL_RECORDING_MAX_BYTES=5 \
  B24_CALL_RECORDING_TIMEOUT_MS=5 DOCUMENTS_EDIT_PDF_TEXT=false run shellenv --preflight-only
assert "переменные в оболочке владельца: preflight код 0" "[[ $RC -eq 0 ]]"
assert "переменные в оболочке: docker их не видит (сброшены)" \
  "[[ -s '$STUB/shellenv.log' ]] && ! grep -qv \
   '^<unset> <unset> <unset> <unset> <unset> <unset> <unset> <unset> <unset> <unset>\$' \
   '$STUB/shellenv.log'"
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
printf 'sha256:%s\n' "$H_OLD_DOCS" >"$STUB/missing"
run norollbackdocs
refuse_case norollbackdocs "прежнего образа documents нет на хосте"
assert "откатный образ documents: сообщение" "out_has norollbackdocs 'прежнего образа DOCUMENTS'"
: >"$STUB/missing"

# Значения новых переменных в .env боя вне допустимого: отказ в предусловиях.
bad_value_case() { # bad_value_case <имя> <строка .env> <ключ в сообщении>
  reset_stand
  printf '%s\n' "$2" >>"$LIVE/.env"
  T1="$(tree_snapshot)"
  run "$1" --preflight-only
  assert "$1: код 3, бой не тронут" \
    "[[ $RC -eq $EXIT_REFUSED ]] && no_mutation $1 && [[ \"\$(tree_snapshot)\" == \"\$T1\" ]]"
  assert "$1: сообщение называет ключ" "out_has $1 '$3'"
}
bad_value_case b24text "B24_CALL_RECORDING_MAX_BYTES=много" B24_CALL_RECORDING_MAX_BYTES
bad_value_case b24zero "B24_CALL_RECORDING_MAX_BYTES=0" B24_CALL_RECORDING_MAX_BYTES
bad_value_case b24big "B24_CALL_RECORDING_MAX_BYTES=1073741825" B24_CALL_RECORDING_MAX_BYTES
bad_value_case b24tolow "B24_CALL_RECORDING_TIMEOUT_MS=9999" B24_CALL_RECORDING_TIMEOUT_MS
bad_value_case b24tohigh "B24_CALL_RECORDING_TIMEOUT_MS=3600001" B24_CALL_RECORDING_TIMEOUT_MS
bad_value_case pdftypo "DOCUMENTS_EDIT_PDF_TEXT=banana" DOCUMENTS_EDIT_PDF_TEXT
bad_value_case pdfspaced "DOCUMENTS_EDIT_PDF_TEXT=true on" DOCUMENTS_EDIT_PDF_TEXT
reset_stand
printf 'B24_CALL_RECORDING_MAX_BYTES=1073741824\nB24_CALL_RECORDING_TIMEOUT_MS=10000\n' \
  >>"$LIVE/.env"
run b24edge --preflight-only
assert "граничные допустимые значения B24 (1 ГиБ, 10 с): preflight код 0" "[[ $RC -eq 0 ]]"

# 2. --preflight-only: код 0, ничего не менялось.
reset_stand
PF_RES="$TMP/home-preflight/.pragmatika-cutover/patch-9r-2*/results"
run preflight --preflight-only
assert "--preflight-only - код 0" "[[ $RC -eq 0 ]]"
assert "--preflight-only: бой не тронут" "no_mutation preflight"
assert "--preflight-only: дерево боя побайтно прежнее" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "--preflight-only: app и documents на прежних образах" "app_is_old && docs_is_old"
assert "--preflight-only: бэкап не создан" "! compgen -G '$TMP/home-preflight/backups/*'"
assert "--preflight-only: проб pages и parse не было" \
  "[[ \$(pages_probe_count preflight) -eq 0 && \$(parse_probe_count preflight) -eq 0 ]]"
assert "--preflight-only: PREFLIGHT_OK в состоянии" \
  "grep -rq 'RESULT=PREFLIGHT_OK' '$TMP'/home-preflight/.pragmatika-cutover/patch-9r-*/state.env"
assert "--preflight-only: журнал называет G9q3 применённым" \
  "out_has preflight 'патч G9q3 применён: ok'"
assert "--preflight-only: журнал называет правку PDF вне таблиц включённой (по умолчанию)" \
  "out_has preflight 'DOCUMENTS_EDIT_PDF_TEXT включён'"
assert "--preflight-only: журнал называет обе новые переменные app с умолчаниями" \
  "out_has preflight 'B24_CALL_RECORDING_MAX_BYTES=104857600 B24_CALL_RECORDING_TIMEOUT_MS=600000'"
assert "--preflight-only: пути сравнены при разных корнях (боевой и примерка), код 0" \
  "[[ \$(sort -u '$STUB/cfg-roots.log' | wc -l) -ge 2 ]] \
   && grep -q 'context $LIVE_ROOT\$' '$STUB/cfg-roots.log' \
   && grep -qE 'context .*/stage\$' '$STUB/cfg-roots.log'"
assert "--preflight-only: эффективные значения записаны в результаты" \
  "[[ \"\$(sort $PF_RES/new-settings-effective.txt | tr '\n' ' ')\" == \
     'B24_CALL_RECORDING_MAX_BYTES=104857600 B24_CALL_RECORDING_TIMEOUT_MS=600000 \
DOCUMENTS_EDIT_PDF_TEXT=<пусто: по умолчанию платформы включено> ' ]]"
assert "--preflight-only: значения переменных app до замены записаны (флаги и числа)" \
  "grep -qx 'PRICE_EDIT_DB_WRITE_ENABLED=true' $PF_RES/app-values-before.txt \
   && [[ \$(wc -l <$PF_RES/app-values-before.txt) -eq 9 ]]"
assert "--preflight-only: журнал называет сходство прочей конфигурации" \
  "out_has preflight 'прочая конфигурация: ok'"
assert "--preflight-only: в списке замены две копии платформы (compose.project.yml равен)" \
  "[[ \"\$(LC_ALL=C sort $PF_RES/file-changes.txt | tr '\n' ' ')\" == \
     'platform/PLATFORM-VERSION platform/compose.base.yml ' ]]"
assert "--preflight-only: в списке lock ровно ожидаемые шесть ключей" \
  "[[ \"\$(LC_ALL=C sort $PF_RES/lock-changes.txt | tr '\n' ' ')\" == \
     'BAI_IMAGE_APP BAI_IMAGE_APP_BASE BAI_IMAGE_DOCUMENTS BAI_IMAGE_DOCUMENTS_BASE \
BAI_IMAGE_SPEECH BAI_VERSION ' ]]"
assert "--preflight-only: секрет из конфигурации не попал в вывод и журнал" \
  "! grep -rq '$APP_ENV_SECRET' '$TMP/out-preflight' '$TMP/home-preflight'"

# Явный выключатель PDF вне таблиц в .env боя: патч не отказывает и .env не меняет, функция
# остаётся выключенной, проба /parse ждёт ответ без locations.
reset_stand
printf 'DOCUMENTS_EDIT_PDF_TEXT=false\n' >>"$LIVE/.env"
ENV_OFF_SUM="$(sha256sum <"$LIVE/.env")"
W_OFF="$(tree_without_patched)"
run offswitch
assert "выключатель false в .env: патч не отказывает, код 0" "[[ $RC -eq 0 ]] && app_is_new"
assert "выключатель false: .env боя побайтно прежний" \
  "[[ \"\$(sha256sum <'$LIVE/.env')\" == \"\$ENV_OFF_SUM\" ]] \
   && [[ \$(stat -c %a '$LIVE/.env') == 600 ]]"
assert "выключатель false: в окружении documents DOCUMENTS_EDIT_PDF_TEXT=false" \
  "grep -qx 'DOCUMENTS_EDIT_PDF_TEXT=false' '$STUB/env/p-documents-1'"
assert "выключатель false: журнал говорит, что функция выключена выключателем в .env" \
  "out_has offswitch 'DOCUMENTS_EDIT_PDF_TEXT выключен выключателем'"
assert "выключатель false: проба /parse ожидала и получила ответ без locations" \
  "out_has offswitch 'documents ответил 200 - - -'"
assert "выключатель false: прочие файлы дерева (включая .env) побайтно прежние" \
  "[[ \"\$(tree_without_patched)\" == \"\$W_OFF\" ]]"
assert "выключатель false: documents и app пересозданы по одному разу, больше ничего" \
  "[[ \$(docs_up_count offswitch) -eq 1 && \$(app_up_count offswitch) -eq 1 ]] \
   && ! other_up offswitch | grep -q ."
# Выключатель включён, но documents отвечает locations: расхождение с выключателем - откат.
reset_stand
printf 'DOCUMENTS_EDIT_PDF_TEXT=off\n' >>"$LIVE/.env"
STUB_PARSE_REPLY="200 pdf 1 1" run offbutlocs
assert "выключатель off, но /parse отдаёт locations: код 1 (откат)" \
  "[[ $RC -eq $EXIT_FAILED ]] && out_has offbutlocs 'ожидается' && docs_is_old && app_is_old"
# Слово в другом регистре и в кавычках: допустимы.
reset_stand
printf 'DOCUMENTS_EDIT_PDF_TEXT=TRUE\n' >>"$LIVE/.env"
run uppertrue
assert "TRUE в .env: код 0, documents получил его, проба ждёт locations" \
  "[[ $RC -eq 0 ]] && grep -qx 'DOCUMENTS_EDIT_PDF_TEXT=TRUE' '$STUB/env/p-documents-1' \
   && out_has uppertrue 'documents ответил 200 pdf 1 1'"
reset_stand
printf 'DOCUMENTS_EDIT_PDF_TEXT="off"\n' >>"$LIVE/.env"
run quotedoff --preflight-only
assert "\"off\" в кавычках в .env: preflight код 0, выключено" \
  "[[ $RC -eq 0 ]] && out_has quotedoff 'DOCUMENTS_EDIT_PDF_TEXT выключен выключателем'"
# Значение из secrets.env сильнее .env (порядок --env-file).
reset_stand
printf 'DOCUMENTS_EDIT_PDF_TEXT=0\n' >"$LIVE/secrets.env"
chmod 600 "$LIVE/secrets.env"
run secretsoff --preflight-only
assert "secrets.env с 0: эффективное значение выключено, preflight код 0" \
  "[[ $RC -eq 0 ]] && out_has secretsoff 'DOCUMENTS_EDIT_PDF_TEXT выключен выключателем'"
# Явные значения B24 в .env боя доходят до app как есть.
reset_stand
printf 'B24_CALL_RECORDING_MAX_BYTES=52428800\nB24_CALL_RECORDING_TIMEOUT_MS=30000\n' \
  >>"$LIVE/.env"
run b24explicit
assert "явные B24 в .env: код 0, у app те же значения" \
  "[[ $RC -eq 0 ]] && grep -qx 'B24_CALL_RECORDING_MAX_BYTES=52428800' '$STUB/env/p-app-1' \
   && grep -qx 'B24_CALL_RECORDING_TIMEOUT_MS=30000' '$STUB/env/p-app-1'"
# Флаг G9q выключен в .env боя и у запущенного app: после замены значение прежнее.
reset_stand
printf 'PRICE_EDIT_DB_WRITE_ENABLED=false\n' >>"$LIVE/.env"
sed -i 's/^PRICE_EDIT_DB_WRITE_ENABLED=.*/PRICE_EDIT_DB_WRITE_ENABLED=false/' "$STUB/env/p-app-1"
run keepoff
assert "флаг G9q выключен в .env боя: код 0, значение false сохранено" \
  "[[ $RC -eq 0 ]] && grep -qx 'PRICE_EDIT_DB_WRITE_ENABLED=false' '$STUB/env/p-app-1' \
   && grep -qx 'PRICE_EDIT_TEXT_BLOCKS_ENABLED=true' '$STUB/env/p-app-1'"

# Образы не на хосте: preflight делает docker pull по digest (оба образа).
reset_stand
printf '%s\n%s\n' "$H_NEW_APP" "$H_NEW_DOCS" >"$STUB/missing"
run pullimages --preflight-only
assert "образов нет на хосте: docker pull app по digest, код 0" \
  "[[ $RC -eq 0 ]] && grep -q '^pull r/app@sha256:$H_NEW_APP' '$TMP/docker-pullimages.log'"
assert "образов нет на хосте: docker pull documents по digest" \
  "grep -q '^pull r/pragmatika-documents@sha256:$H_NEW_DOCS' '$TMP/docker-pullimages.log'"
assert "speech не тянется (профиль выключен): нет docker pull speech" \
  "! grep -q 'speech' '$TMP/docker-pullimages.log'"
reset_stand
echo "$H_NEW_DOCS" >"$STUB/missing"
echo "tar" >"$TMP/images.tar"
run loadimages --preflight-only --images-tar "$TMP/images.tar"
assert "--images-tar: docker load выполнен" \
  "grep -q '^load -i $TMP/images.tar' '$TMP/docker-loadimages.log'"
reset_stand
printf '%s\n' "$H_NEW_DOCS" >"$STUB/missing"
run nopull --preflight-only --images-tar "$TMP/нет-такого.tar"
refuse_case nopull "--images-tar: нет файла архива"

# 3. Успех: заменены images.lock и копия платформы, пересозданы documents, затем app.
reset_stand
run apply
APPLY_RES="$TMP/home-apply/.pragmatika-cutover/patch-9r-2*/results"
assert "успех: код 0" "[[ $RC -eq 0 ]]"
assert "успех: lock боя равен lock пакета (образы app и documents новые)" \
  "cmp -s '$LIVE/images.lock' '$PKG/images.lock' \
   && grep -q '$NEW_APP' '$LIVE/images.lock' && grep -q '$NEW_DOCS' '$LIVE/images.lock'"
assert "успех: копия платформы боя равна пакетной (compose.base.yml и PLATFORM-VERSION)" \
  "cmp -s '$LIVE/platform/compose.base.yml' '$PKG/deploy/platform/compose.base.yml' \
   && cmp -s '$LIVE/platform/PLATFORM-VERSION' '$PKG/deploy/platform/PLATFORM-VERSION' \
   && grep -qx 'PLATFORM_PACKAGES_VERSION=1.1.10' '$LIVE/platform/PLATFORM-VERSION'"
assert "успех: compose.project.yml боя прежний (равен пакетному)" \
  "cmp -s '$LIVE/compose.project.yml' '$GOLDEN/compose.project.yml' \
   && cmp -s '$LIVE/compose.project.yml' '$PKG/deploy/compose.project.yml'"
assert "успех: BAI_VERSION боя $VER_TO" "grep -qx 'BAI_VERSION=$VER_TO' '$LIVE/images.lock'"
assert "успех: основы app, documents и speech в lock новые" \
  "grep -q 'BAI_IMAGE_APP_BASE=r/app-base@sha256:$H_BASE_NEW' '$LIVE/images.lock' \
   && grep -q 'BAI_IMAGE_DOCUMENTS_BASE=r/bai-documents@sha256:$H_DBASE_NEW' '$LIVE/images.lock' \
   && grep -q 'BAI_IMAGE_SPEECH=r/speech@sha256:$H_SPEECH2' '$LIVE/images.lock'"
assert "успех: все файлы дерева, кроме images.lock и копии платформы, побайтно прежние" \
  "[[ \"\$(tree_without_patched)\" == \"\$W0\" ]]"
assert "успех: права .env прежние (600)" "[[ \$(stat -c %a '$LIVE/.env') == 600 ]]"
assert "успех: .env боя патч не менял" "cmp -s '$LIVE/.env' '$GOLDEN/.env'"
assert "успех: бэкап deploy с прежними lock и копией платформы 1.1.6" \
  "grep -q '$OLD_APP' '$TMP'/home-apply/backups/pragmatika-patch9r-*/deploy/images.lock \
   && grep -q '$OLD_DOCS' '$TMP'/home-apply/backups/pragmatika-patch9r-*/deploy/images.lock \
   && cmp -s '$GOLDEN/platform/compose.base.yml' \
   '$TMP'/home-apply/backups/pragmatika-patch9r-*/deploy/platform/compose.base.yml \
   && cmp -s '$GOLDEN/platform/PLATFORM-VERSION' \
   '$TMP'/home-apply/backups/pragmatika-patch9r-*/deploy/platform/PLATFORM-VERSION"
assert "успех: бэкап хранит .env с правами 600" \
  "[[ \$(stat -c %a '$TMP'/home-apply/backups/pragmatika-patch9r-*/deploy/.env) == 600 ]]"
assert "успех: в бэкапе снимок контейнеров и образов (documents и app)" \
  "grep -q 'p-documents-1' '$TMP'/home-apply/backups/pragmatika-patch9r-*/containers-before.tsv \
   && grep -q 'p-app-1' '$TMP'/home-apply/backups/pragmatika-patch9r-*/containers-before.tsv"
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
assert "успех: у app обе новые переменные равны умолчаниям платформы (в .env их нет)" \
  "grep -qx 'B24_CALL_RECORDING_MAX_BYTES=104857600' '$STUB/env/p-app-1' \
   && grep -qx 'B24_CALL_RECORDING_TIMEOUT_MS=600000' '$STUB/env/p-app-1'"
assert "успех: журнал называет обе новые переменные app с эффективными значениями" \
  "out_has apply 'новые переменные: B24_CALL_RECORDING_MAX_BYTES=104857600 \
B24_CALL_RECORDING_TIMEOUT_MS=600000'"
assert "успех: переменные G9q, G9p, G8z и G8w у app на месте и прежние" \
  "grep -qx 'PRICE_EDIT_DB_WRITE_ENABLED=true' '$STUB/env/p-app-1' \
   && grep -qx 'PRICE_EDIT_TEXT_BLOCKS_ENABLED=true' '$STUB/env/p-app-1' \
   && grep -qx 'PRICE_EDIT_FIRST_ENABLED=true' '$STUB/env/p-app-1' \
   && grep -qx 'DOCX_PAGES_ENABLED=true' '$STUB/env/p-app-1' \
   && grep -qx 'SHORTLIST_PAGING_ENABLED=true' '$STUB/env/p-app-1' \
   && grep -qx 'SUPPLIER_DISCOVERY_ENABLED=true' '$STUB/env/p-app-1' \
   && grep -qx 'YANDEX_SEARCH_MAX_CONCURRENCY=1' '$STUB/env/p-app-1' \
   && grep -qx 'YANDEX_SEARCH_MIN_INTERVAL_MS=1200' '$STUB/env/p-app-1'"
assert "успех: в окружении documents четыре флага G8x остались, PDF вне таблиц пусто (вкл)" \
  "grep -qx 'DOCUMENTS_EDIT_PPTX=true' '$STUB/env/p-documents-1' \
   && grep -qx 'DOCUMENTS_EDIT_PDF=true' '$STUB/env/p-documents-1' \
   && grep -qx 'DOCUMENTS_PPT_CONVERT=true' '$STUB/env/p-documents-1' \
   && grep -qx 'DOCUMENTS_EDIT_PDF_FALLBACK_FONT=false' '$STUB/env/p-documents-1' \
   && grep -qx 'DOCUMENTS_EDIT_PDF_TEXT=' '$STUB/env/p-documents-1'"
assert "успех: журнал называет флаги documents со значениями" \
  "out_has apply 'DOCUMENTS_EDIT_PDF_FALLBACK_FONT=false' \
   && out_has apply 'DOCUMENTS_EDIT_PPTX=true'"
assert "успех: ни одного docker exec (внутри контейнеров проверять нечего)" \
  "! grep -q '^exec ' '$TMP/docker-apply.log'"
assert "успех: проба /docx/pages выполнена после documents и после app" \
  "[[ \$(pages_probe_count apply) -eq 2 ]] && out_has apply 'проба /docx/pages: ok'"
assert "успех: проба /parse выполнена после documents и после app" \
  "[[ \$(parse_probe_count apply) -eq 2 ]] && out_has apply 'проба /parse: ok'"
assert "успех: проба несёт некорректное тело (content_base64 не base64), не файл" \
  "grep -q 'PATCH_PAGES_BODY={\"file_name\":\"probe.docx\",\"content_base64\":\"%%%\"}' \
   '$TMP/docker-apply.log'"
assert "успех: журнал проб - только статус и код ошибки или формат и числа" \
  "out_has apply 'documents ответил 422 bad_request' \
   && out_has apply 'documents ответил 200 pdf 1 1'"
assert "успех: documents и app в images-running.tsv совпали с lock" \
  "[[ \$(cat $APPLY_RES/images-running.tsv | grep -c 'совпал') -ge 2 ]]"
assert "успех: журнал называет копию платформы 1.1.10 равной пакетной" \
  "out_has apply 'копия платформы 1.1.10 равна пакетной'"
assert "успех: архив patch9r-<время>.tgz создан" \
  "compgen -G '$TMP/home-apply/patch9r-*.tgz' >/dev/null"
mkdir -p "$TMP/arch"
tar -C "$TMP/arch" -xzf "$(compgen -G "$TMP/home-apply/patch9r-*.tgz" | head -1)"
assert "успех: в архиве журнал и проверки" \
  "[[ -f '$TMP/arch/results/cutover.log' && -f '$TMP/arch/results/checks.tsv' ]]"
assert "успех: окружение app и конфигурация (секрет) не попали в журнал, вывод и архив" \
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
assert "повтор: проб pages и parse не было" \
  "[[ \$(pages_probe_count again) -eq 0 && \$(parse_probe_count again) -eq 0 ]]"

# 5. Сбои после замены: автооткат, файлы из бэкапа побайтно, оба контейнера на образах G9q3.
# rollback_case <имя> <описание>: после сбоя проверяется одинаковый набор признаков отката.
rollback_case() {
  assert "$2: код 1 (откат выполнен)" "[[ $RC -eq $EXIT_FAILED ]]"
  assert "$2: автоматический откат запущен" "out_has $1 'автоматический откат'"
  assert "$2: дерево боя побайтно прежнее (lock и копия платформы 1.1.6 из бэкапа)" \
    "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
  assert "$2: documents и app на прежних образах, откат без down" \
    "app_is_old && docs_is_old && ! grep -E ' (down|--remove-orphans)( |\$)' '$TMP/docker-$1.log'"
  assert "$2: откат только через up --no-deps documents и app" "! other_up $1 | grep -q ."
  assert "$2: ОТКАТ ПАТЧА ВЫПОЛНЕН в журнале" "out_has $1 'ОТКАТ ПАТЧА ВЫПОЛНЕН'"
  assert "$2: после отката у app нет новых переменных, прежние на месте" \
    "! grep -q 'B24_CALL_RECORDING' '$STUB/env/p-app-1' \
     && grep -qx 'SHORTLIST_PAGING_ENABLED=true' '$STUB/env/p-app-1' \
     && grep -qx 'PRICE_EDIT_DB_WRITE_ENABLED=true' '$STUB/env/p-app-1'"
  assert "$2: после отката у documents нет DOCUMENTS_EDIT_PDF_TEXT, флаги G8x на месте" \
    "! grep -q 'DOCUMENTS_EDIT_PDF_TEXT' '$STUB/env/p-documents-1' \
     && grep -qx 'DOCUMENTS_EDIT_PDF=true' '$STUB/env/p-documents-1'"
}
# Сбой на проверках documents: app до этого не пересоздавался (только откатный up).
docs_stage_case() {
  assert "$2: app патчем не пересоздавался (один up - откатный)" "[[ \$(app_up_count $1) -eq 1 ]]"
}
# Сбой на шаге app: documents успели обновиться и откатились (два up), app тоже (два up).
app_stage_case() {
  assert "$2: documents и app пересоздавались дважды (замена и откат)" \
    "[[ \$(docs_up_count $1) -eq 2 && \$(app_up_count $1) -eq 2 ]]"
}
reset_stand
STUB_DOCS_UP_FAIL=1 run docsupfail
rollback_case docsupfail "compose up documents не удался"
docs_stage_case docsupfail "up documents не удался"
reset_stand
STUB_WRONG_DOCS_IMAGE=1 run wrongdocs
rollback_case wrongdocs "запущен не тот образ documents"
docs_stage_case wrongdocs "не тот образ documents"
reset_stand
STUB_DOCS_EXITED=1 run docsexited
rollback_case docsexited "documents упал после пересоздания"
docs_stage_case docsexited "documents упал"
reset_stand
STUB_DOCS_HEALTH_500=1 run docshealth
rollback_case docshealth "/health documents не 200 после пересоздания"
docs_stage_case docshealth "/health 500"
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
reset_stand
STUB_ENV_PDF_TEXT=false run pdftextwrong
rollback_case pdftextwrong "DOCUMENTS_EDIT_PDF_TEXT=false у documents при пустом .env"
docs_stage_case pdftextwrong "выключатель PDF вне таблиц не из .env"
assert "иное значение PDF вне таблиц: причина в журнале" \
  "out_has pdftextwrong 'DOCUMENTS_EDIT_PDF_TEXT'"
# Проба /docx/pages: образ без ручки (404) и прочие расхождения -> автооткат.
reset_stand
STUB_PAGES_OLD_BEHAVIOR=1 run pagesold
rollback_case pagesold "documents отвечает на /docx/pages как старый образ (404)"
docs_stage_case pagesold "проба pages (старый образ)"
assert "старый образ: причина в журнале" "out_has pagesold 'проба /docx/pages: ответ 404 -'"
assert "старый образ: в причине ожидаемые значения" "out_has pagesold 'ожидается 422 bad_request'"
reset_stand
STUB_PAGES_OLD_REPLY="405 -" STUB_PAGES_OLD_BEHAVIOR=1 run pages405
rollback_case pages405 "проба pages: 405"
docs_stage_case pages405 "проба pages 405"
reset_stand
STUB_PAGES_CODE=200 STUB_PAGES_ERR= run pages200
rollback_case pages200 "проба pages отвечает 200"
docs_stage_case pages200 "проба pages 200"
reset_stand
STUB_PAGES_CODE=500 STUB_PAGES_ERR=internal_error run pages500
rollback_case pages500 "проба pages отвечает 500"
docs_stage_case pages500 "проба pages 500"
reset_stand
STUB_PAGES_ERR=unsupported_format run pageserr
rollback_case pageserr "проба pages: 422, но иной код ошибки (unsupported_format)"
docs_stage_case pageserr "проба pages (код ошибки)"
assert "иной код: причина в журнале" "out_has pageserr 'ответ 422 unsupported_format'"
reset_stand
STUB_PAGES_DOWN=1 run pagesdown
rollback_case pagesdown "проба pages: documents не отвечает"
docs_stage_case pagesdown "проба pages (нет ответа)"
assert "нет ответа: причина в журнале" "out_has pagesdown 'не отвечает'"
reset_stand
STUB_PAGES_APP_STAGE_FAIL=1 run pagesapp
rollback_case pagesapp "проба pages красная после пересоздания app"
app_stage_case pagesapp "проба pages после app"
# Проба /parse: ответ без locations (образ без правки PDF вне таблиц), лишние места, не тот
# формат, ошибка статуса, нет ответа -> автооткат; тело ответа в журнал не попадает.
reset_stand
STUB_PARSE_REPLY="200 - - -" run parseold
rollback_case parseold "проба /parse: locations нет (образ без правки PDF вне таблиц)"
docs_stage_case parseold "проба parse (старый образ)"
assert "parse без locations: причина в журнале с ожидаемым ответом" \
  "out_has parseold \"ответ '200 - - -', ожидается '200 pdf 1 1'\""
reset_stand
STUB_PARSE_REPLY="200 pdf 1 2" run parsespots
rollback_case parsespots "проба /parse: мест не одно"
docs_stage_case parsespots "проба parse (число мест)"
reset_stand
STUB_PARSE_REPLY="200 pptx 1 1" run parseformat
rollback_case parseformat "проба /parse: формат не pdf"
reset_stand
STUB_PARSE_REPLY="500 - - -" run parse500
rollback_case parse500 "проба /parse: статус 500"
docs_stage_case parse500 "проба parse 500"
reset_stand
STUB_PARSE_DOWN=1 run parsedown
rollback_case parsedown "проба /parse: documents не отвечает"
docs_stage_case parsedown "проба parse (нет ответа)"
assert "parse нет ответа: причина в журнале" "out_has parsedown 'не отвечает'"
reset_stand
STUB_PARSE_APP_STAGE_FAIL=1 run parseapp
rollback_case parseapp "проба /parse красная после пересоздания app"
app_stage_case parseapp "проба parse после app"
# Ожидаемые ответы проб переопределяются окружением стенда.
reset_stand
PATCH9R_PAGES_PROBE_ERROR=unsupported_format STUB_PAGES_ERR=unsupported_format run pagesoverride
assert "ожидаемый код пробы pages переопределён окружением: код 0" "[[ $RC -eq 0 ]]"
assert "переопределённая проба: в журнале 422 unsupported_format" \
  "out_has pagesoverride 'ответил 422 unsupported_format'"
reset_stand
PATCH9R_PARSE_PROBE_ON="200 pdf 2 3" STUB_PARSE_REPLY="200 pdf 2 3" run parseoverride
assert "ожидаемый ответ пробы parse переопределён окружением: код 0" "[[ $RC -eq 0 ]]"
reset_stand
PATCH9R_PAGES_PROBE_STATUS=200 STUB_PAGES_CODE=422 run pagesoverride3
rollback_case pagesoverride3 "переопределён только статус пробы, ответ иной"
# Шаг app.
reset_stand
STUB_UP_FAIL=1 run upfail
rollback_case upfail "compose up app не удался (documents уже новый)"
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
reset_stand
STUB_APP_LOSE_YANDEX=1 run loseyandex
rollback_case loseyandex "после пересоздания в app пропали переменные Яндекса"
assert "пропали переменные: причина в журнале" "out_has loseyandex 'пропали переменные'"
reset_stand
STUB_APP_LOSE_G8Z=1 run loseg8z
rollback_case loseg8z "после пересоздания в app пропали переменные G8z"
assert "пропали переменные G8z: причина в журнале" "out_has loseg8z 'пропали переменные'"
reset_stand
STUB_APP_LOSE_G9P=1 run loseg9p
rollback_case loseg9p "после пересоздания в app пропали переменные G9p"
reset_stand
STUB_APP_LOSE_G9Q=1 run loseg9q
rollback_case loseg9q "после пересоздания в app пропали переменные G9q"
assert "пропали переменные G9q: причина в журнале" "out_has loseg9q 'пропали переменные'"
reset_stand
STUB_ENV_DB_WRITE=false run dbwritechanged
rollback_case dbwritechanged "значение PRICE_EDIT_DB_WRITE_ENABLED у app изменилось при замене"
assert "значение изменилось: причина в журнале" "out_has dbwritechanged 'изменились значения'"
assert "значение изменилось: журнал называет ключ" \
  "out_has dbwritechanged 'PRICE_EDIT_DB_WRITE_ENABLED'"
reset_stand
STUB_APP_NO_NEWVARS=1 run nonewvars
rollback_case nonewvars "в окружении app после замены нет новых переменных"
assert "нет новых переменных: причина в журнале" \
  "out_has nonewvars 'нет новой переменной B24_CALL_RECORDING_MAX_BYTES'"
reset_stand
STUB_APP_NO_B24_TIMEOUT=1 run nob24timeout
rollback_case nob24timeout "в окружении app после замены нет B24_CALL_RECORDING_TIMEOUT_MS"
assert "нет таймаута: причина в журнале" \
  "out_has nob24timeout 'нет новой переменной B24_CALL_RECORDING_TIMEOUT_MS'"
reset_stand
STUB_ENV_B24_MAX=1 run envb24
rollback_case envb24 "в окружении app B24_CALL_RECORDING_MAX_BYTES=1 (ждали умолчание)"
assert "не то значение в окружении: причина в журнале" \
  "out_has envb24 'не равны эффективным значениям'"
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
rundir="$(readlink -f "$TMP/home-manual_apply/.pragmatika-cutover/patch-9r-latest")"
run manual_rollback --rollback --run-dir "$rundir"
assert "ручной откат - код 0" "[[ $RC -eq 0 ]]"
assert "ручной откат: дерево побайтно прежнее (lock и копия платформы 1.1.6)" \
  "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "ручной откат: documents и app на образах G9q3" "app_is_old && docs_is_old"
assert "ручной откат: флаги documents на месте, новых переменных нет" \
  "grep -qx 'DOCUMENTS_EDIT_PPTX=true' '$STUB/env/p-documents-1' \
   && ! grep -q 'DOCUMENTS_EDIT_PDF_TEXT' '$STUB/env/p-documents-1' \
   && ! grep -q 'B24_CALL_RECORDING' '$STUB/env/p-app-1'"
assert "ручной откат: только up --no-deps documents и app" \
  "! other_up manual_rollback | grep -q ."
assert "ручной откат: сначала documents, затем app" \
  "(( \$(up_line manual_rollback documents) < \$(up_line manual_rollback app) ))"
assert "ручной откат: БЕЗ down и --remove-orphans" \
  "! grep -E ' (down|--remove-orphans)( |\$)' '$TMP/docker-manual_rollback.log'"
# Без --run-dir берётся последний запуск (patch-9r-latest) из того же HOME.
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
assert "--help - код 0 и описание G9r" "[[ $RC -eq 0 ]] && out_has helpout 'G9r'"
assert "неверный вызов: бой не тронут" "no_mutation badargs && no_mutation unknownarg"

# 9. Настоящий JS проб /docx/pages и /parse (нужен bun) против локального сервера: разбирается
# только detail.error (pages) и формат с числами (parse), тело ответа в журнал не попадает.
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
  assert "настоящий JS пробы pages: ответ 422 bad_request - успех, код 0" "[[ $RC -eq 0 ]]"
  assert "настоящий JS пробы pages: сервер получил POST /docx/pages с некорректным base64" \
    "grep -q '^/docx/pages .*\"content_base64\":\"%%%\"' '$TMP/server.seen'"
  assert "настоящий JS пробы pages: тело ответа не попало в вывод, журнал и архив" \
    "! grep -rq '$BODY_MARK' '$TMP/out-realok' '$TMP/home-realok'"
  assert "настоящий JS пробы pages: в журнале статус и код ошибки" \
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
  rollback_case real404 "настоящий JS: образ старше G9p отвечает 404 (ручки нет)"
  assert "настоящий JS: ответ 404 в причине, тело не напечатано" \
    "out_has real404 'ответ 404 -' && ! grep -rq '$BODY_MARK' '$TMP/out-real404'"
  printf '{"ok":true}' >"$TMP/body-200.json"
  start_server 200 "$TMP/body-200.json"
  reset_stand
  STUB_REAL_JS_URL="$REAL_URL" run real200
  rollback_case real200 "настоящий JS: ответ 200 вместо отказа на некорректное тело"

  # Проба /parse: сервер отдаёт locations с «текстом места» (метка утечки); в журнал идут только
  # формат, число страниц и число мест. Проба pages в этих прогонах отвечает заглушкой.
  printf '{"markdown":"%s","locations":{"format":"pdf","pages":1,"spots":[{"text":"%s"}]}}' \
    "$BODY_MARK" "$BODY_MARK" >"$TMP/parse-ok.json"
  start_server 200 "$TMP/parse-ok.json"
  reset_stand
  STUB_REAL_PARSE_URL="$REAL_URL" run parsereal
  assert "настоящий JS пробы parse: locations pdf 1 страница 1 место - успех, код 0" \
    "[[ $RC -eq 0 ]] && out_has parsereal 'documents ответил 200 pdf 1 1'"
  assert "настоящий JS пробы parse: сервер получил POST /parse с PDF и locations=true" \
    "grep -aq '^/parse ' '$TMP/server.seen' && grep -aq '%PDF-1.4' '$TMP/server.seen' \
     && grep -aq 'name=\"locations\"' '$TMP/server.seen' && grep -aq 'name=\"file\"' \
     '$TMP/server.seen' && grep -aq 'Price 1 250,00 total' '$TMP/server.seen' \
     && grep -aq '%%EOF' '$TMP/server.seen'"
  assert "настоящий JS пробы parse: тело ответа и текст места не попали в вывод, журнал, архив" \
    "! grep -rq '$BODY_MARK' '$TMP/out-parsereal' '$TMP/home-parsereal'"
  printf '{"markdown":"x"}' >"$TMP/parse-noloc.json"
  start_server 200 "$TMP/parse-noloc.json"
  reset_stand
  STUB_REAL_PARSE_URL="$REAL_URL" run parsenoloc
  rollback_case parsenoloc "настоящий JS parse: в ответе нет locations (образ без правки PDF)"
  assert "настоящий JS parse: в причине «200 - - -»" "out_has parsenoloc \"ответ '200 - - -'\""
  printf '{"locations":{"format":"pdf; %s","pages":1,"spots":[]}}' "$BODY_MARK" \
    >"$TMP/parse-weird.json"
  start_server 200 "$TMP/parse-weird.json"
  reset_stand
  STUB_REAL_PARSE_URL="$REAL_URL" run parseweird
  rollback_case parseweird "настоящий JS parse: формат не похож на слово, мест нет"
  assert "настоящий JS parse: странный формат не напечатан" \
    "! grep -rq '$BODY_MARK' '$TMP/out-parseweird'"
  printf '{"markdown":"x"}' >"$TMP/parse-off.json"
  start_server 200 "$TMP/parse-off.json"
  reset_stand
  printf 'DOCUMENTS_EDIT_PDF_TEXT=false\n' >>"$LIVE/.env"
  STUB_REAL_PARSE_URL="$REAL_URL" run parseoffreal
  assert "настоящий JS parse: выключатель в .env, ответ без locations - успех, код 0" \
    "[[ $RC -eq 0 ]] && out_has parseoffreal 'documents ответил 200 - - -'"
  start_server 500 "$TMP/body-404.json"
  reset_stand
  STUB_REAL_PARSE_URL="$REAL_URL" run parse500real
  rollback_case parse500real "настоящий JS parse: статус 500"
  [[ -z "$SERVER_PID" ]] || { kill "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""; }
else
  echo "SKIP настоящий JS проб: нет bun"
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
assert "patch.sh: нет docker exec (G9r ничего не проверяет внутри контейнеров)" \
  "! grep -vE '^[[:space:]]*#' '$PS' | grep -q 'docker exec'"
assert "patch.sh: окружение контейнера читается только в container_env_value (один раз)" \
  "[[ \$(grep -vE '^[[:space:]]*#' '$PS' | grep -c 'Config.Env') -eq 1 ]]"
assert "patch.sh: окружение читается через фильтр одного ключа (sed -n)" \
  "sed -n '/^container_env_value()/,/^}/p' '$PS' | grep -q 'sed -n'"
assert "patch.sh: compose up ровно в четырёх местах (documents и app, замена и откат)" \
  "[[ \$(grep -vE '^[[:space:]]*#' '$PS' | grep -c 'dc_new up ') -eq 4 ]] \
   && ! grep -vE '^[[:space:]]*#' '$PS' | grep 'dc_new up ' \
      | grep -vqE 'APP_SERVICE|DOCUMENTS_SERVICE'"
assert "patch.sh: PATCH_FILE_ALLOW - ровно compose.project.yml и две копии платформы" \
  "[[ \"\$(grep -m1 '^PATCH_FILE_ALLOW=(' '$PS')\" == \
     'PATCH_FILE_ALLOW=(compose.project.yml platform/compose.base.yml platform/PLATFORM-VERSION)' \
     ]]"
assert "patch.sh: ключи lock - ровно шесть (версия, app, documents, основы, speech)" \
  "[[ \"\$(grep -m1 '^PATCH_LOCK_KEYS=' '$PS')\" == \
     'PATCH_LOCK_KEYS=\"BAI_VERSION BAI_IMAGE_APP BAI_IMAGE_APP_BASE BAI_IMAGE_DOCUMENTS\"' ]] \
   && grep -q '^PATCH_LOCK_KEYS+=\" BAI_IMAGE_DOCUMENTS_BASE BAI_IMAGE_SPEECH\"' '$PS'"
assert "patch.sh: новые переменные app - ровно две, умолчания - константы платформы" \
  "grep -q '^NEW_APP_VARS=(B24_CALL_RECORDING_MAX_BYTES=104857600 \
B24_CALL_RECORDING_TIMEOUT_MS=600000)' '$PS'"
assert "patch.sh: патч не пишет в .env (нет sed -i, tee и перенаправлений в .env)" \
  "! grep -vE '^[[:space:]]*#' '$PS' \
   | grep -E '(>>?|tee( -a)?|sed -i( [^ ]+)?) *\"?[^ \"]*(ENV_FILE_NAME|\\.env)' \
   | grep -v 'cut_redact'"
assert "patch.sh: сравнение конфигураций заменяет КОРЕНЬ примерки на боевой (не только deploy)" \
  "sed -n '/^stage_tree()/,/^}/p' '$PS' | grep -q '\"\\\$LIVE_NEW_DIR\" \"\\\$STAGE_DIR\"'"
assert "patch.sh: оболочечные переменные сбрасываются (unset)" \
  "grep -qE '^unset \"\\\$\\{KEEP_APP_KEYS\\[@\\]\\}\"' '$PS' \
   && [[ \$(sed -n '/^unset /,/^$/p' '$PS' | grep -c 'DOCUMENTS_EDIT_PDF_TEXT') -ge 1 ]]"
assert "patch.sh: конфигурация сравнивается без печати значений (config_delta, без журнала)" \
  "grep -q '^config_delta()' '$PS' && ! grep -vE '^[[:space:]]*#' '$PS' \
   | grep 'format json' | grep -qE '>>|tee|LOG_FILE'"
assert "patch.sh: ожидаемые статус и код пробы pages - константы с переопределением" \
  "grep -q 'PAGES_PROBE_STATUS=\"\${PATCH9R_PAGES_PROBE_STATUS:-422}\"' '$PS' \
   && grep -q 'PAGES_PROBE_ERROR=\"\${PATCH9R_PAGES_PROBE_ERROR:-bad_request}\"' '$PS'"
assert "patch.sh: ожидаемые ответы пробы parse - константы с переопределением" \
  "grep -q 'PARSE_PROBE_ON=\"\${PATCH9R_PARSE_PROBE_ON:-200 pdf 1 1}\"' '$PS' \
   && grep -q 'PARSE_PROBE_OFF=\"\${PATCH9R_PARSE_PROBE_OFF:-200 - - -}\"' '$PS'"
assert "patch.sh: тело пробы pages - некорректный base64 (файл не передаётся)" \
  "grep -q '^PAGES_PROBE_BODY=.*content_base64.*%%%' '$PS'"
assert "patch.sh: PDF пробы parse строится внутри пробы (синтетический текст, без файлов)" \
  "grep -q 'Price 1 250,00 total' '$PS' && grep -q 'PDF-1[.]4' '$PS'"
assert "patch.sh: нет префиксов других патчей (PATCH8X..8Z, PATCH9P, PATCH9Q, patch-9p, patch-9q)" \
  "! grep -qE 'PATCH8[XYZ]|patch-8[xyz]|patch8[xyz]|PATCH9[PQ]|patch-9[pq]|patch9[pq]' '$PS'"
assert "patch.sh: префиксы G9r (бэкап, архив, запуск)" \
  "grep -q 'BACKUP_PREFIX=\"pragmatika-patch9r\"' '$PS' \
   && grep -q 'ARCHIVE_PREFIX=\"patch9r\"' '$PS' && grep -q 'RUN_PREFIX=\"patch-9r\"' '$PS'"
assert "patch.sh: версии lock и платформы - константы (боевая .6, целевая 1.1.10-pragmatika.1)" \
  "grep -q '^LOCK_VERSION_FROM=\"$VER_FROM\"' '$PS' \
   && grep -q '^LOCK_VERSION_TO=\"$VER_TO\"' '$PS' \
   && grep -q '^PLATFORM_FROM=\"1.1.6\"' '$PS' && grep -q '^PLATFORM_TO=\"1.1.10\"' '$PS'"
assert "patch.sh: откатные версии образов - из lock боя (нет жёстких digest)" \
  "! grep -vE '^[[:space:]]*#' '$PS' | grep -qE 'sha256:[0-9a-f]{16,}'"

echo "проверок: $((PASS + FAIL)), провалено: $FAIL"
[[ "$FAIL" -eq 0 ]]
