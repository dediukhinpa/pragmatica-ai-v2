#!/usr/bin/env bash
# Проверка маршрутов: каждый HTTP-маршрут, который вызывает приложение v2 у соседних сервисов,
# пробуется безопасным запросом; 404 и 405 - провал (маршрута нет в сервисе).
#
# Зачем: на бою у платформенного documents не было проектных маршрутов /docx/* (404), а
# предпроверка этого не видела. Список маршрутов строит tools/route-manifest.ts из исходников
# адаптеров (TSV: сервис, метод, путь, вид), этот скрипт их пробует.
#
# Использование:
#   bash tools/check-routes.sh --stack [--project ИМЯ] [--app-container ИМЯ] [ОПЦИИ]
#   bash tools/check-routes.sh --base сервис=URL [--base сервис=URL ...] [ОПЦИИ]
#
# Режимы:
#   --stack            пробы идут ИЗНУТРИ сети стека: одноразовый контейнер в сетевом пространстве
#                      контейнера app (как ready_probe в deploy/cutover/lib.sh; образ с bun берётся
#                      у самого app). Только чтение: ничего не создаётся и не пересоздаётся,
#                      контейнер пробы удаляется (--rm). Адреса сервисов и токены читаются из
#                      окружения контейнера app (DOCUMENTS_URL, PSEUDONYMIZER_URL, EMBEDDINGS_URL,
#                      MASK_URL, SPEECH_LOCAL_URL; PSEUDONYMIZER_API_TOKEN, MASK_TOKEN); не
#                      найденный адрес - из compose-умолчаний платформы.
#   --base сервис=URL  адрес сервиса напрямую (стенды и тесты); без --stack пробы идут с этого
#                      хоста. С --stack перекрывает адрес из окружения app.
# Опции:
#   --manifest ФАЙЛ        готовый манифест (TSV); без него строится tools/route-manifest.ts
#   --token-env [сервис=]ИМЯ  имя переменной ОКРУЖЕНИЯ с токеном сервиса (без «сервис=» -
#                          pseudonymizer). Токен уходит только своему сервису, только повтором
#                          после 401/403 и нигде не печатается. С --stack токены pseudonymizer и
#                          mask берутся из окружения контейнера app, если не заданы явно.
#   --skip-service ИМЯ     явно не проверять сервис (повторяемо); печатается отдельной строкой
#   --project ИМЯ          compose-проект (по умолчанию COMPOSE_PROJECT, CUTOVER_PROJECT, иначе
#                          pragmatika)
#   --app-container ИМЯ    контейнер app (по умолчанию ищется по меткам compose проекта)
#   --help
#
# Что делается с маршрутом (вид route манифеста):
#   POST с телом {} и Content-Type: application/json (маршрут GET в манифесте - GET). Статус
#   404/405 - FAIL; 502/504 - ERROR (прокси без ответа сервиса); сеть недоступна или таймаут -
#   ERROR; 401/403 без токена - UNVERIFIED (существование не проверено; с токеном запрос
#   повторяется); любой другой (200, 400, 413, 415, 422, 500...) - OK: маршрут существует.
#   Вид template (маршрут с параметром, /jobs/{jobId}) не пробуется: подстановка дала бы честный
#   404 «задания нет»; вид external (шлюз, телеметрия) не пробуется: запрос ушёл бы за стек.
#
# Коды выхода: 0 - FAIL и ERROR нет (UNVERIFIED допустимо, печатается предупреждением);
# 1 - есть FAIL или ERROR (или манифест/стек недоступны); 2 - неверный вызов.
set -euo pipefail
# Побайтовые ширины колонок таблицы и предсказуемые диапазоны tr.
export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------------------------
# Константы
# ---------------------------------------------------------------------------------------------
EXIT_OK=0
EXIT_FAILED=1
EXIT_USAGE=2
# Таймаут одного запроса, секунд (для тестов и медленных стендов переопределяется окружением).
REQUEST_TIMEOUT_S="${CHECK_ROUTES_TIMEOUT_S:-10}"
MS_PER_S=1000
# Малая память одноразового контейнера: как ONESHOT_MEM в deploy/cutover/lib.sh.
ONESHOT_MEM=128m
# Сервисы, которых в стеке может не быть (профиль compose): без контейнера они пропускаются
# с предупреждением, а не считаются провалом.
OPTIONAL_SERVICES=" speech "
# Адреса и токены по умолчанию в стеке платформы (compose.base.yml).
declare -A STACK_URL_ENV=([documents]=DOCUMENTS_URL [pseudonymizer]=PSEUDONYMIZER_URL
  [embeddings]=EMBEDDINGS_URL [mask]=MASK_URL [speech]=SPEECH_LOCAL_URL)
declare -A STACK_URL_DEFAULT=([documents]=http://documents:8310
  [pseudonymizer]=http://pseudonymizer:8300 [embeddings]=http://embeddings:8320
  [mask]=http://mask:8320 [speech]=http://speech:8330)
declare -A STACK_TOKEN_ENV=([pseudonymizer]=PSEUDONYMIZER_API_TOKEN [mask]=MASK_TOKEN)
DEFAULT_TOKEN_SERVICE="pseudonymizer"
# Префикс переменных, через которые токен попадает в пробу (значение в аргументах не бывает).
TOKEN_VAR_PREFIX="ROUTECHK_TOKEN_"

# Проба: выполняется bun (на хосте или внутри одноразового контейнера). Вход - ROUTECHK_INPUT
# (строки «сервис метод путь базовый_адрес» через TAB), токены - ROUTECHK_TOKEN_<СЕРВИС>.
# Вывод: «сервис метод путь статус авторизация» (статус - число или ERR:timeout/ERR:network).
# Токен печатать нельзя: в вывод идут только статус и слово none/token.
read -r -d '' PROBE_JS <<'JS' || true
const timeoutMs = Number(process.env.ROUTECHK_TIMEOUT_MS ?? '10000');
const rows = (process.env.ROUTECHK_INPUT ?? '').split('\n').filter((line) => line !== '');
const authStatuses = new Set([401, 403]);
async function call(method, url, token) {
  // Без повторного использования соединения: пробы редкие, а сброс сервером «подвисшего»
  // соединения дал бы ложную ошибку сети.
  const headers = { connection: 'close' };
  const init = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) };
  if (method !== 'GET' && method !== 'HEAD') {
    headers['content-type'] = 'application/json';
    init.body = '{}';
  }
  if (token !== '') headers['authorization'] = 'Bearer ' + token;
  const response = await fetch(url, init);
  await response.body?.cancel();
  return response.status;
}
for (const line of rows) {
  const [service, method, path, base] = line.split('\t');
  const url = base.replace(/\/+$/, '') + path;
  const envName = 'ROUTECHK_TOKEN_' + service.toUpperCase().replace(/-/g, '_');
  const token = process.env[envName] ?? '';
  let status;
  let auth = 'none';
  try {
    status = await call(method, url, '');
    if (authStatuses.has(status) && token !== '') {
      status = await call(method, url, token);
      auth = 'token';
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    status = name === 'TimeoutError' || name === 'AbortError' ? 'ERR:timeout' : 'ERR:network';
  }
  console.log([service, method, path, status, auth].join('\t'));
}
JS

# ---------------------------------------------------------------------------------------------
# Вспомогательное
# ---------------------------------------------------------------------------------------------
log() { echo "check-routes: $*"; }
die_usage() { echo "check-routes: $*" >&2; echo "справка: bash $0 --help" >&2; exit "$EXIT_USAGE"; }
need_bun() { # need_bun <зачем>
  command -v bun >/dev/null 2>&1 || { log "ОШИБКА: bun не найден: $1"; exit "$EXIT_FAILED"; }
}
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

declare -A BASES=()
declare -A TOKEN_VARS=()
declare -A SKIP=()
MANIFEST=""
STACK=0
PROJECT="${COMPOSE_PROJECT:-${CUTOVER_PROJECT:-pragmatika}}"
APP_CONTAINER=""

while (($#)); do
  case "$1" in
    --stack) STACK=1 ;;
    --manifest) MANIFEST="${2:?--manifest ФАЙЛ}"; shift ;;
    --base)
      spec="${2:?--base сервис=URL}"
      [[ "$spec" =~ ^([a-z][a-z0-9-]*)=(https?://[^[:space:]]+)$ ]] \
        || die_usage "неверный --base «$spec»: нужен вид сервис=http://хост:порт"
      BASES["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
      shift ;;
    --token-env)
      spec="${2:?--token-env [сервис=]ИМЯ}"
      if [[ "$spec" =~ ^([a-z][a-z0-9-]*)=([A-Za-z_][A-Za-z0-9_]*)$ ]]; then
        TOKEN_VARS["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
      elif [[ "$spec" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
        TOKEN_VARS["$DEFAULT_TOKEN_SERVICE"]="$spec"
      else
        die_usage "неверный --token-env «$spec»: нужно имя переменной окружения"
      fi
      shift ;;
    --skip-service) SKIP["${2:?--skip-service ИМЯ}"]=1; shift ;;
    --project) PROJECT="${2:?--project ИМЯ}"; shift ;;
    --app-container) APP_CONTAINER="${2:?--app-container ИМЯ}"; shift ;;
    --help | -h) usage; exit "$EXIT_OK" ;;
    *) die_usage "неизвестный аргумент: $1" ;;
  esac
  shift
done
((STACK == 1 || ${#BASES[@]} > 0)) \
  || die_usage "нужен режим: --stack или хотя бы один --base сервис=URL"
[[ "$REQUEST_TIMEOUT_S" =~ ^[1-9][0-9]*$ ]] || die_usage "CHECK_ROUTES_TIMEOUT_S: нужно целое > 0"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT

# ---------------------------------------------------------------------------------------------
# Манифест
# ---------------------------------------------------------------------------------------------
if [[ -z "$MANIFEST" ]]; then
  need_bun "манифест не построить"
  MANIFEST="$TMP/manifest.tsv"
  log "строится манифест маршрутов: tools/route-manifest.ts"
  bun "$HERE/route-manifest.ts" >"$MANIFEST" || {
    log "ОШИБКА: манифест не собран (причины выше), проверка невозможна"
    exit "$EXIT_FAILED"
  }
fi
[[ -f "$MANIFEST" ]] || die_usage "нет файла манифеста: $MANIFEST"

# Маршруты по видам. PROBE_ROWS: «сервис<TAB>метод<TAB>путь».
PROBE_ROWS=()
N_TEMPLATE=0
N_EXTERNAL=0
EXTERNAL_SERVICES=""
declare -A SKIPPED_COUNT=()
while IFS=$'\t' read -r svc method path kind || [[ -n "${svc:-}" ]]; do
  [[ -z "${svc:-}" || "$svc" == \#* ]] && continue
  kind="${kind:-route}"
  [[ "$method" =~ ^(GET|POST|PUT|PATCH|DELETE|HEAD)$ && "$path" == /* ]] \
    || die_usage "строка манифеста неверного вида: $svc $method $path"
  case "$kind" in
    route) ;;
    template) N_TEMPLATE=$((N_TEMPLATE + 1)); continue ;;
    external)
      N_EXTERNAL=$((N_EXTERNAL + 1))
      [[ " $EXTERNAL_SERVICES " == *" $svc "* ]] || EXTERNAL_SERVICES+=" $svc"
      continue ;;
    *) die_usage "неизвестный вид маршрута «$kind» в манифесте" ;;
  esac
  if [[ -n "${SKIP[$svc]:-}" ]]; then
    SKIPPED_COUNT["$svc"]=$(( ${SKIPPED_COUNT[$svc]:-0} + 1 ))
    continue
  fi
  PROBE_ROWS+=("$svc"$'\t'"$method"$'\t'"$path")
done <"$MANIFEST"
if ((${#PROBE_ROWS[@]} == 0)); then
  log "ОШИБКА: в манифесте нет маршрутов для проверки"
  exit "$EXIT_FAILED"
fi

# Сервисы, которые нужно пробовать (в порядке манифеста).
SERVICES=()
for row in "${PROBE_ROWS[@]}"; do
  svc="${row%%$'\t'*}"
  [[ " ${SERVICES[*]:-} " == *" $svc "* ]] || SERVICES+=("$svc")
done

# ---------------------------------------------------------------------------------------------
# Стек: контейнер app, адреса, токены
# ---------------------------------------------------------------------------------------------
APP_ENV=""
# app_env_get <ИМЯ>: значение переменной из окружения контейнера app (пусто, если нет). Значение
# секретных переменных в вывод не попадает: вызывающий кладёт его только в переменную.
app_env_get() { sed -n "s/^$1=//p" <<<"$APP_ENV" | head -1; }

# compose_service_present <сервис>: 0, если у проекта есть контейнер этого сервиса (любой).
compose_service_present() {
  [[ -n "$(docker ps -a -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$1" 2>/dev/null)" ]]
}

PROBE_IMAGE=""
if ((STACK == 1)); then
  command -v docker >/dev/null 2>&1 || { log "ОШИБКА: docker не найден"; exit "$EXIT_FAILED"; }
  if [[ -z "$APP_CONTAINER" ]]; then
    APP_CONTAINER="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
      --filter "label=com.docker.compose.service=app" 2>/dev/null | head -1)"
    [[ -n "$APP_CONTAINER" ]] || APP_CONTAINER="$PROJECT-app-1"
  fi
  PROBE_IMAGE="$(docker inspect -f '{{.Image}}' "$APP_CONTAINER" 2>/dev/null)" || {
    log "ОШИБКА: нет контейнера app «$APP_CONTAINER» (проект $PROJECT): стек не запущен?"
    exit "$EXIT_FAILED"
  }
  APP_ENV="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$APP_CONTAINER" \
    2>/dev/null)" || APP_ENV=""
  log "режим стека: проект $PROJECT, пробы из сети контейнера $APP_CONTAINER"
else
  log "режим прямых адресов: пробы с этого хоста"
fi

# Адреса сервисов.
declare -A BASE_OF=()
declare -A MISSING_OPTIONAL=()
for svc in "${SERVICES[@]}"; do
  if [[ -n "${BASES[$svc]:-}" ]]; then
    BASE_OF["$svc"]="${BASES[$svc]}"
  elif ((STACK == 1)) && [[ -n "${STACK_URL_DEFAULT[$svc]:-}" ]]; then
    if [[ " $OPTIONAL_SERVICES " == *" $svc "* ]] && ! compose_service_present "$svc"; then
      MISSING_OPTIONAL["$svc"]=1
      continue
    fi
    url="$(app_env_get "${STACK_URL_ENV[$svc]}")"
    BASE_OF["$svc"]="${url:-${STACK_URL_DEFAULT[$svc]}}"
  else
    die_usage "не задан адрес сервиса $svc: добавьте --base $svc=URL или --skip-service $svc"
  fi
done

# Токены: явные (--token-env) и, в стеке, из окружения app. Значения только в переменных.
declare -A HAVE_TOKEN=()
PASS_ENV=()
for svc in "${SERVICES[@]}"; do
  [[ -z "${MISSING_OPTIONAL[$svc]:-}" ]] || continue
  var="${TOKEN_VARS[$svc]:-}"
  token=""
  if [[ -n "$var" ]]; then
    token="${!var:-}"
    [[ -n "$token" ]] \
      || log "предупреждение: переменная $var пуста или не задана: токен $svc не используется"
  elif ((STACK == 1)) && [[ -n "${STACK_TOKEN_ENV[$svc]:-}" ]]; then
    token="$(app_env_get "${STACK_TOKEN_ENV[$svc]}")"
  fi
  if [[ -n "$token" ]]; then
    envname="${TOKEN_VAR_PREFIX}$(tr 'a-z-' 'A-Z_' <<<"$svc")"
    export "$envname=$token"
    PASS_ENV+=("$envname")
    HAVE_TOKEN["$svc"]=1
  fi
  unset token
done
unset APP_ENV

# ---------------------------------------------------------------------------------------------
# Проба
# ---------------------------------------------------------------------------------------------
INPUT=""
N_PROBED=0
for row in "${PROBE_ROWS[@]}"; do
  svc="${row%%$'\t'*}"
  [[ -z "${MISSING_OPTIONAL[$svc]:-}" ]] || continue
  INPUT+="$row"$'\t'"${BASE_OF[$svc]}"$'\n'
  N_PROBED=$((N_PROBED + 1))
done
export ROUTECHK_INPUT="$INPUT"
export ROUTECHK_TIMEOUT_MS=$((REQUEST_TIMEOUT_S * MS_PER_S))

RESULT="$TMP/result.tsv"
PROBE_ERR="$TMP/probe.err"
log "проверяется маршрутов: $N_PROBED (таймаут запроса ${REQUEST_TIMEOUT_S} с)"
if ((N_PROBED == 0)); then
  : >"$RESULT"
elif ((STACK == 1)); then
  env_args=(-e ROUTECHK_INPUT -e ROUTECHK_TIMEOUT_MS)
  for name in "${PASS_ENV[@]}"; do env_args+=(-e "$name"); done
  docker run --rm --network "container:$APP_CONTAINER" --memory "$ONESHOT_MEM" \
    "${env_args[@]}" --entrypoint bun "$PROBE_IMAGE" -e "$PROBE_JS" \
    >"$RESULT" 2>"$PROBE_ERR" || true
else
  need_bun "пробу выполнить нечем"
  bun -e "$PROBE_JS" >"$RESULT" 2>"$PROBE_ERR" || true
fi

# ---------------------------------------------------------------------------------------------
# Вердикты и таблица
# ---------------------------------------------------------------------------------------------
declare -A STATUS_OF=()
declare -A AUTH_OF=()
while IFS=$'\t' read -r svc method path status auth || [[ -n "${svc:-}" ]]; do
  [[ -n "${path:-}" && -n "${status:-}" ]] || continue
  STATUS_OF["$svc $method $path"]="$status"
  AUTH_OF["$svc $method $path"]="${auth:-none}"
done <"$RESULT"

COUNT_OK=0
COUNT_FAIL=0
COUNT_ERROR=0
COUNT_UNVERIFIED=0
TABLE=()
UNVERIFIED_NOTES=()
for row in "${PROBE_ROWS[@]}"; do
  IFS=$'\t' read -r svc method path <<<"$row"
  [[ -z "${MISSING_OPTIONAL[$svc]:-}" ]] || continue
  key="$svc $method $path"
  status="${STATUS_OF[$key]:-нет-ответа}"
  auth="${AUTH_OF[$key]:-none}"
  case "$status" in
    404 | 405) verdict="FAIL" ;;
    502 | 504) verdict="ERROR" ;;
    401 | 403)
      verdict="UNVERIFIED"
      if [[ "$auth" == token ]]; then
        UNVERIFIED_NOTES+=("$svc $method $path: токен отклонён сервисом ($status)")
      else
        UNVERIFIED_NOTES+=("$svc $method $path: сервис требует токен ($status), токен не передан")
      fi ;;
    [0-9][0-9][0-9]) verdict="OK" ;;
    *) verdict="ERROR" ;;
  esac
  case "$verdict" in
    OK) COUNT_OK=$((COUNT_OK + 1)) ;;
    FAIL) COUNT_FAIL=$((COUNT_FAIL + 1)) ;;
    ERROR) COUNT_ERROR=$((COUNT_ERROR + 1)) ;;
    UNVERIFIED) COUNT_UNVERIFIED=$((COUNT_UNVERIFIED + 1)) ;;
  esac
  TABLE+=("$svc"$'\t'"$method"$'\t'"$path"$'\t'"$status"$'\t'"$verdict")
done

if ((N_PROBED > 0 && ${#STATUS_OF[@]} == 0)) && [[ -s "$PROBE_ERR" ]]; then
  log "проба не дала ни одного ответа; сообщение запуска (первые строки):"
  head -n 5 "$PROBE_ERR" | sed 's/^/  /'
fi

echo
# Заголовок кириллицей: ширины увеличены на лишние байты UTF-8 (по одному на букву).
printf '%-20s %-12s %-32s %-18s %s\n' "сервис" "метод" "путь" "статус" "вердикт"
for line in "${TABLE[@]:-}"; do
  [[ -n "$line" ]] || continue
  IFS=$'\t' read -r svc method path status verdict <<<"$line"
  printf '%-14s %-7s %-28s %-12s %s\n' "$svc" "$method" "$path" "$status" "$verdict"
done
echo

for svc in "${!MISSING_OPTIONAL[@]}"; do
  log "предупреждение: сервиса $svc нет в стеке проекта $PROJECT (профиль): не проверялся"
done
for svc in "${!SKIPPED_COUNT[@]}"; do
  log "предупреждение: сервис $svc пропущен по --skip-service (маршрутов: ${SKIPPED_COUNT[$svc]})"
done
((N_TEMPLATE == 0)) || log "маршрутов с параметром не пробовалось: $N_TEMPLATE (вид template)"
((N_EXTERNAL == 0)) \
  || log "маршрутов внешних сервисов не пробовалось: $N_EXTERNAL (${EXTERNAL_SERVICES# })"
if ((COUNT_UNVERIFIED > 0)); then
  log "ПРЕДУПРЕЖДЕНИЕ: UNVERIFIED $COUNT_UNVERIFIED - существование не проверено:"
  for note in "${UNVERIFIED_NOTES[@]}"; do echo "  $note"; done
  log "передайте токен: --token-env сервис=ИМЯ_ПЕРЕМЕННОЙ (или --stack: токены берутся из app)"
fi
log "итого: OK=$COUNT_OK FAIL=$COUNT_FAIL ERROR=$COUNT_ERROR UNVERIFIED=$COUNT_UNVERIFIED"
if ((COUNT_FAIL + COUNT_ERROR > 0)); then
  log "РЕЗУЛЬТАТ: есть FAIL или ERROR - маршруты отсутствуют или сервис недоступен"
  exit "$EXIT_FAILED"
fi
log "РЕЗУЛЬТАТ: провалов нет"
exit "$EXIT_OK"
