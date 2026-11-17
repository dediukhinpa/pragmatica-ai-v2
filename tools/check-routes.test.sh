#!/usr/bin/env bash
# Тест tools/check-routes.sh: проба маршрутов на заглушках HTTP (python3, только 127.0.0.1 и порты
# 21150-21199, гасятся в конце) и заглушка docker для режима --stack. Проверяются: сервис без
# проектных маршрутов (404 на /docx/* - код 1), с ними (422 - код 0), 401 без токена
# (UNVERIFIED, код 0) и с токеном (OK), 405 (FAIL), недоступный порт и таймаут (ERROR), вид
# запроса (POST с {} и JSON, GET для get-маршрутов), шаблоны и внешние сервисы не пробуются,
# режим --stack (одноразовый контейнер в сети app, токены из окружения app не печатаются),
# неверные вызовы (код 2) и стиль. Манифест строит tools/route-manifest.ts (нужен bun).
#
#   bash tools/check-routes.test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SCRIPT="$HERE/check-routes.sh"
TMP="$(mktemp -d)"
STUB_PIDS=()
cleanup() {
  local pid
  for pid in "${STUB_PIDS[@]:-}"; do
    [[ -z "$pid" ]] || kill "$pid" 2>/dev/null || true
  done
  rm -rf "${TMP:?}"
}
trap cleanup EXIT
PASS=0
FAIL=0
LIMIT=100
EXIT_FAILED=1
EXIT_USAGE=2
# Порты заглушек: только из диапазона 21150-21199. Занятые другими процессами пропускаются
# (диапазон общий для стендов), свободные выбираются при запуске теста.
PORT_MIN=21150
PORT_SPAN=50
USED_PORTS=" "
alloc_port() { # alloc_port <ИМЯ_ПЕРЕМЕННОЙ>: свободный порт диапазона в переменную
  local offset=$((RANDOM % PORT_SPAN)) i port
  for ((i = 0; i < PORT_SPAN; i++)); do
    port=$((PORT_MIN + (offset + i) % PORT_SPAN))
    [[ "$USED_PORTS" != *" $port "* ]] || continue
    python3 -I -c 'import socket, sys
s = socket.socket()
s.bind(("127.0.0.1", int(sys.argv[1])))' "$port" 2>/dev/null || continue
    USED_PORTS+="$port "
    printf -v "$1" '%s' "$port"
    return 0
  done
  echo "нет свободного порта в диапазоне $PORT_MIN-$((PORT_MIN + PORT_SPAN - 1))" >&2
  exit 1
}
for name in PORT_NO_DOCX PORT_FULL PORT_AUTH PORT_405 PORT_DEAD PORT_SLOW PORT_ALL \
  PORT_STACK_DOCS PORT_STACK_PSEUDO PORT_STACK_MASK PORT_STACK_EMB PORT_FLAGS PORT_FLAGS_STACK; do
  alloc_port "$name" # PORT_DEAD: порт без заглушки (никто не слушает)
done
HOST=127.0.0.1
TOKEN_OK="tok-pseudo-4f9a1c77d2"
TOKEN_BAD="tok-wrong-00aa11bb22"
TOKEN_APP_PSEUDO="app-pseudo-7b3e9d51a0"
TOKEN_APP_MASK="app-mask-c4d82f6e19"

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# --- Заглушка HTTP сервиса ----------------------------------------------------------------------
# Правила (JSON): default - статус по умолчанию; routes - «МЕТОД путь» -> статус; token - если
# задан, без заголовка Authorization: Bearer <token> отвечает 401; delay - «МЕТОД путь» -> секунд.
# Журнал: «МЕТОД путь ct=<Content-Type или -> body=<тело> auth=<yes|no>».
cat >"$TMP/stub.py" <<'PY'
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port, rules_path, log_path = int(sys.argv[1]), sys.argv[2], sys.argv[3]
rules = json.load(open(rules_path, encoding="utf-8"))


class Handler(BaseHTTPRequestHandler):
    def _serve(self):
        size = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(size).decode("utf-8", "replace") if size else ""
        key = f"{self.command} {self.path}"
        auth = self.headers.get("authorization") or ""
        with open(log_path, "a", encoding="utf-8") as log:
            log.write(
                f"{key} ct={self.headers.get('content-type') or '-'} body={body} "
                f"auth={'yes' if auth else 'no'}\n"
            )
        time.sleep(rules.get("delay", {}).get(key, 0))
        token = rules.get("token")
        if token and auth != f"Bearer {token}":
            code = 401
        else:
            code = rules.get("routes", {}).get(key, rules.get("default", 404))
        try:
            self.send_response(code)
            self.send_header("content-length", "0")
            self.end_headers()
        except OSError:
            pass  # клиент оборвал запрос по таймауту: для заглушки это норма

    do_GET = do_POST = do_DELETE = do_PUT = _serve

    def log_message(self, *args):
        pass


class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        pass  # обрывы соединения клиентом не засоряют вывод теста


Server(("127.0.0.1", port), Handler).serve_forever()
PY

# start_stub <порт> <имя> <правила JSON>: заглушка в фоне; журнал запросов - $TMP/<имя>.log.
start_stub() {
  local port="$1" name="$2" rules="$3" waited=0
  printf '%s' "$rules" >"$TMP/$name.rules.json"
  : >"$TMP/$name.log"
  python3 -I "$TMP/stub.py" "$port" "$TMP/$name.rules.json" "$TMP/$name.log" &
  STUB_PIDS+=("$!")
  until (exec 3<>"/dev/tcp/$HOST/$port") 2>/dev/null; do
    sleep 0.1
    waited=$((waited + 1))
    ((waited < 50)) || { echo "заглушка $name на порту $port не поднялась" >&2; return 1; }
  done
}
url() { echo "http://$HOST:$1"; }

# --- Запуск проверки ---------------------------------------------------------------------------
# run <имя> [аргументы]: код в RC, вывод в $TMP/out-<имя>; таймаут запроса 2 с.
run() {
  local name="$1"
  shift
  RC=0
  CHECK_ROUTES_TIMEOUT_S=2 bash "$SCRIPT" "$@" >"$TMP/out-$name" 2>&1 || RC=$?
}
out_has() { grep -qE -- "$2" "$TMP/out-$1"; }
row_has() { grep -qE -- "$2" "$TMP/out-$1"; } # строка таблицы по шаблону

# --- Манифесты ---------------------------------------------------------------------------------
printf '%s\n' \
  $'documents\tPOST\t/parse\troute' \
  $'documents\tPOST\t/docx/amend\troute' \
  $'documents\tPOST\t/docx/classify\troute' \
  $'documents\tPOST\t/docx/party-block\troute' \
  $'documents\tPOST\t/docx/replace-signatory\troute' >"$TMP/docs.tsv"
printf '%s\n' \
  '# комментарий и пустая строка пропускаются' '' \
  $'pseudonymizer\tGET\t/health\troute' \
  $'pseudonymizer\tPOST\t/pseudonymize\troute' \
  $'speech\tGET\t/jobs/{jobId}\ttemplate' \
  $'gateway\tPOST\t/v1/messages\texternal' >"$TMP/pseudo.tsv"
printf '%s\n' \
  $'documents\tPOST\t/parse\troute' \
  $'pseudonymizer\tPOST\t/pseudonymize\troute' \
  $'mask\tPOST\t/mask_image\troute' \
  $'embeddings\tPOST\t/embed\troute' \
  $'speech\tPOST\t/transcribe\troute' >"$TMP/stack.tsv"

assert "скрипт и сборщик на месте" "[[ -f '$SCRIPT' && -f '$ROOT/tools/route-manifest.ts' ]]"
assert "bash -n check-routes.sh" "bash -n '$SCRIPT'"

# 1. Сервис без проектных маршрутов: /docx/* дают 404, платформенные - 422.
start_stub "$PORT_NO_DOCX" nodocx '{"default":404,"routes":{"POST /parse":422}}'
run nodocx --manifest "$TMP/docs.tsv" --base "documents=$(url "$PORT_NO_DOCX")"
assert "без /docx/*: код 1" "[[ $RC -eq $EXIT_FAILED ]]"
for route in amend classify party-block replace-signatory; do
  assert "без /docx/*: FAIL по /docx/$route" \
    "row_has nodocx '/docx/$route +404 +FAIL'"
done
assert "без /docx/*: /parse - OK" "row_has nodocx '/parse +422 +OK'"
assert "без /docx/*: итог FAIL=4" "out_has nodocx 'OK=1 FAIL=4 ERROR=0'"

# 2. С проектными маршрутами (заглушка отвечает 422 на всё).
start_stub "$PORT_FULL" full '{"default":422}'
run full --manifest "$TMP/docs.tsv" --base "documents=$(url "$PORT_FULL")"
assert "с проектными маршрутами: код 0" "[[ $RC -eq 0 ]]"
assert "с проектными маршрутами: все OK" "out_has full 'OK=5 FAIL=0 ERROR=0 UNVERIFIED=0'"
assert "POST с телом {} и Content-Type JSON" \
  "grep -q '^POST /docx/amend ct=application/json body={} ' '$TMP/full.log'"
assert "запросы без токена не несут Authorization" "! grep -q 'auth=yes' '$TMP/full.log'"

# 3. 401 без токена - UNVERIFIED и код 0; с токеном - OK; чужой токен - UNVERIFIED.
start_stub "$PORT_AUTH" auth "{\"default\":422,\"token\":\"$TOKEN_OK\"}"
run noauth --manifest "$TMP/pseudo.tsv" --base "pseudonymizer=$(url "$PORT_AUTH")"
assert "401 без токена: код 0" "[[ $RC -eq 0 ]]"
assert "401 без токена: UNVERIFIED в таблице" "row_has noauth '/pseudonymize +401 +UNVERIFIED'"
assert "401 без токена: отдельное предупреждение и счётчик" \
  "out_has noauth 'ПРЕДУПРЕЖДЕНИЕ: UNVERIFIED 2 - существование не проверено'"
assert "401 без токена: итог UNVERIFIED=2" "out_has noauth 'OK=0 FAIL=0 ERROR=0 UNVERIFIED=2'"
assert "401 без токена: не FAIL" "! out_has noauth 'FAIL$'"
export ROUTES_TEST_TOKEN="$TOKEN_OK"
run withtoken --manifest "$TMP/pseudo.tsv" --base "pseudonymizer=$(url "$PORT_AUTH")" \
  --token-env ROUTES_TEST_TOKEN
assert "с токеном: код 0" "[[ $RC -eq 0 ]]"
assert "с токеном: OK" "out_has withtoken 'OK=2 FAIL=0 ERROR=0 UNVERIFIED=0'"
assert "с токеном: значение не печатается" "! grep -q '$TOKEN_OK' '$TMP/out-withtoken'"
assert "с токеном: повтор несёт Authorization" "grep -q 'auth=yes' '$TMP/auth.log'"
assert "с токеном: GET для get-маршрута, без тела и Content-Type" \
  "grep -q '^GET /health ct=- body= ' '$TMP/auth.log'"
assert "шаблон и внешний сервис не пробуются" \
  "! grep -qE '/jobs|/v1/messages' '$TMP/auth.log'"
assert "шаблон и внешний сервис: отдельные строки" \
  "out_has withtoken 'не пробовалось: 1 \\(вид template\\)' && out_has withtoken 'gateway'"
export ROUTES_TEST_TOKEN="$TOKEN_BAD"
run badtoken --manifest "$TMP/pseudo.tsv" --base "pseudonymizer=$(url "$PORT_AUTH")" \
  --token-env pseudonymizer=ROUTES_TEST_TOKEN
assert "чужой токен: UNVERIFIED и код 0" "[[ $RC -eq 0 ]] && out_has badtoken 'токен отклонён'"
assert "чужой токен не печатается" "! grep -q '$TOKEN_BAD' '$TMP/out-badtoken'"
unset ROUTES_TEST_TOKEN

# 4. 405 - FAIL.
start_stub "$PORT_405" m405 '{"default":422,"routes":{"POST /docx/amend":405}}'
run m405 --manifest "$TMP/docs.tsv" --base "documents=$(url "$PORT_405")"
assert "405: код 1" "[[ $RC -eq $EXIT_FAILED ]]"
assert "405: FAIL по /docx/amend" "row_has m405 '/docx/amend +405 +FAIL'"
assert "405: остальные OK" "out_has m405 'OK=4 FAIL=1 ERROR=0'"

# 5. Недоступный порт - ERROR, код 1.
run dead --manifest "$TMP/docs.tsv" --base "documents=$(url "$PORT_DEAD")"
assert "недоступный порт: код 1" "[[ $RC -eq $EXIT_FAILED ]]"
assert "недоступный порт: ERROR по каждому маршруту" "out_has dead 'OK=0 FAIL=0 ERROR=5'"
assert "недоступный порт: статус ERR:network" "row_has dead '/parse +ERR:network +ERROR'"

# 6. Таймаут - ERROR.
start_stub "$PORT_SLOW" slow '{"default":422,"delay":{"POST /parse":4}}'
run slow --manifest "$TMP/docs.tsv" --base "documents=$(url "$PORT_SLOW")"
assert "таймаут: код 1 и ERR:timeout" \
  "[[ $RC -eq $EXIT_FAILED ]] && row_has slow 'ERR:timeout +ERROR'"
assert "таймаут: остальные маршруты проверены" "out_has slow 'OK=4 FAIL=0 ERROR=1'"

# 7. Манифест строится сборщиком по реальному дереву; все сервисы указывают на одну заглушку.
if command -v bun >/dev/null 2>&1; then
  start_stub "$PORT_ALL" all '{"default":422}'
  base_all="$(url "$PORT_ALL")"
  run all --base "documents=$base_all" --base "pseudonymizer=$base_all" --base "mask=$base_all" \
    --base "embeddings=$base_all" --base "speech=$base_all"
  assert "манифест из сборщика: код 0" "[[ $RC -eq 0 ]]"
  assert "манифест из сборщика: проверены все четыре /docx/*" \
    "[[ \$(grep -c '^POST /docx/' '$TMP/all.log') -eq 4 ]]"
  assert "манифест из сборщика: пробован /mask_image и /embed" \
    "grep -q '^POST /mask_image ' '$TMP/all.log' && grep -q '^POST /embed ' '$TMP/all.log'"
  assert "манифест из сборщика: шаблоны и шлюз не пробуются" \
    "! grep -qE '/jobs/|/v1/messages|/vision/' '$TMP/all.log'"
  assert "манифест из сборщика: нет UNVERIFIED и ERROR" "out_has all 'ERROR=0 UNVERIFIED=0'"
else
  echo "SKIP манифест из сборщика: нет bun"
fi

# 8. --skip-service: пропуск виден отдельной строкой, а не молчанием.
run skip --manifest "$TMP/docs.tsv" --base "documents=$(url "$PORT_FULL")" \
  --skip-service documents
assert "--skip-service: все маршруты пропущены - код 1 (нечего проверять)" "[[ $RC -eq 1 ]]"
printf '%s\n' $'documents\tPOST\t/parse\troute' $'embeddings\tPOST\t/embed\troute' >"$TMP/two.tsv"
run skip2 --manifest "$TMP/two.tsv" --base "documents=$(url "$PORT_FULL")" \
  --skip-service embeddings
assert "--skip-service: пропуск печатается и не провал" \
  "[[ $RC -eq 0 ]] && out_has skip2 'embeddings пропущен по --skip-service'"

# 9. Режим --stack на заглушке docker: проба идёт одноразовым контейнером в сети app.
BIN="$TMP/bin"
mkdir -p "$BIN"
cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
# В журнал идут все аргументы, кроме последнего у run (многострочный код пробы).
if [[ "$1" == run ]]; then printf '%s\n' "${*:1:$#-1}" >>"$DOCKER_LOG"
else printf '%s\n' "$*" >>"$DOCKER_LOG"; fi
case "$1" in
  ps)
    case "$*" in
      *service=app*) echo "appcid" ;;
      *service=documents*) [[ -n "${NO_DOCS:-}" ]] || echo "docscid" ;;
      *service=speech*) ;;
      *) echo "othercid" ;;
    esac ;;
  inspect)
    [[ -z "${NO_APP:-}" ]] || exit 1
    if [[ "$*" == *".Config.Env"*docscid* ]]; then cat "$DOCS_ENV_FILE"
    elif [[ "$*" == *".Config.Env"* ]]; then cat "$APP_ENV_FILE"
    else echo "sha256:probe-image"; fi ;;
  run) bun -e "${@: -1}" ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$BIN/docker"
cat >"$TMP/app.env" <<ENV
PATH=/usr/local/bin:/usr/bin
DOCUMENTS_URL=$(url "$PORT_STACK_DOCS")
PSEUDONYMIZER_URL=$(url "$PORT_STACK_PSEUDO")
PSEUDONYMIZER_API_TOKEN=$TOKEN_APP_PSEUDO
MASK_URL=$(url "$PORT_STACK_MASK")
MASK_TOKEN=$TOKEN_APP_MASK
EMBEDDINGS_URL=$(url "$PORT_STACK_EMB")
ENV
start_stub "$PORT_STACK_DOCS" sdocs '{"default":422}'
start_stub "$PORT_STACK_PSEUDO" spseudo "{\"default\":422,\"token\":\"$TOKEN_APP_PSEUDO\"}"
start_stub "$PORT_STACK_MASK" smask "{\"default\":422,\"token\":\"$TOKEN_APP_MASK\"}"
start_stub "$PORT_STACK_EMB" semb '{"default":422}'
: >"$TMP/docker.log"
RC=0
env PATH="$BIN:$PATH" DOCKER_LOG="$TMP/docker.log" APP_ENV_FILE="$TMP/app.env" \
  CHECK_ROUTES_TIMEOUT_S=2 bash "$SCRIPT" --stack --manifest "$TMP/stack.tsv" \
  >"$TMP/out-stack" 2>&1 || RC=$?
assert "--stack: код 0, токены из окружения app, UNVERIFIED нет" \
  "[[ $RC -eq 0 ]] && out_has stack 'OK=4 FAIL=0 ERROR=0 UNVERIFIED=0'"
assert "--stack: одноразовый контейнер в сети app, малая память" \
  "grep -q '^run --rm --network container:appcid --memory 128m ' '$TMP/docker.log'"
assert "--stack: образ пробы - образ app, точка входа bun" \
  "grep -q -- '--entrypoint bun sha256:probe-image -e$' '$TMP/docker.log'"
assert "--stack: изменяющих команд docker нет (только run --rm)" \
  "! grep -qvE '^(ps|inspect|run --rm) ' '$TMP/docker.log'"
assert "--stack: значения (токены, список маршрутов) не в аргументах docker" \
  "! grep -qE '$TOKEN_APP_PSEUDO|$TOKEN_APP_MASK|ROUTECHK_[A-Z_]+=' '$TMP/docker.log'"
assert "--stack: токены не в выводе" \
  "! grep -qE '$TOKEN_APP_PSEUDO|$TOKEN_APP_MASK' '$TMP/out-stack'"
assert "--stack: необязательный speech без контейнера - предупреждение, не провал" \
  "out_has stack 'сервиса speech нет в стеке'"
assert "--stack: токен ушёл только повтором после 401" \
  "[[ \$(grep -c 'auth=yes' '$TMP/spseudo.log') -eq 1 ]] \
    && [[ \$(grep -c 'auth=no' '$TMP/spseudo.log') -eq 1 ]]"
assert "--stack: documents не получил токена" "! grep -q 'auth=yes' '$TMP/sdocs.log'"
RC=0
env PATH="$BIN:$PATH" DOCKER_LOG="$TMP/docker.log" APP_ENV_FILE="$TMP/app.env" NO_APP=1 \
  bash "$SCRIPT" --stack --manifest "$TMP/stack.tsv" >"$TMP/out-noapp" 2>&1 || RC=$?
assert "--stack: нет контейнера app - код 1 с понятной причиной" \
  "[[ $RC -eq $EXIT_FAILED ]] && out_has noapp 'нет контейнера app'"

# 9a. Маршруты за флагами сервиса (tools/route-flags.tsv): выключенный флаг - SKIP, не FAIL.
printf '%s\n' \
  $'documents\tPOST\t/parse\troute' \
  $'documents\tPOST\t/parse-archive\troute' \
  $'documents\tPOST\t/edit-prices\troute' >"$TMP/flags.tsv"
start_stub "$PORT_FLAGS" flags '{"default":404,"routes":{"POST /parse":422}}'
flag_base="documents=$(url "$PORT_FLAGS")"
run flagoff --manifest "$TMP/flags.tsv" --base "$flag_base" \
  --flag DOCUMENTS_ARCHIVES_ENABLED=false --flag DOCUMENTS_EDIT_ENDPOINTS=
assert "флаг выключен, заглушка 404: SKIP и код 0" \
  "[[ $RC -eq 0 ]] && row_has flagoff '/parse-archive +- +SKIP \\(флаг DOCUMENTS_ARCHIVES_ENABLED'"
assert "флаг выключен: пустое значение тоже выключает" \
  "row_has flagoff '/edit-prices +- +SKIP \\(флаг DOCUMENTS_EDIT_ENDPOINTS выключен'"
assert "флаг выключен: отдельный счётчик в итоге" "out_has flagoff 'OK=1 FAIL=0 ERROR=0 .*SKIP=2'"
assert "флаг выключен: маршрут не пробовался" "! grep -q '/parse-archive' '$TMP/flags.log'"
: >"$TMP/flags.log"
run flagon --manifest "$TMP/flags.tsv" --base "$flag_base" \
  --flag DOCUMENTS_ARCHIVES_ENABLED=ON --flag DOCUMENTS_EDIT_ENDPOINTS=1
assert "флаг включён (ON, 1), заглушка 404: FAIL и код 1" \
  "[[ $RC -eq $EXIT_FAILED ]] && row_has flagon '/parse-archive +404 +FAIL' \
    && row_has flagon '/edit-prices +404 +FAIL' && out_has flagon 'SKIP=0'"
run flagunk --manifest "$TMP/flags.tsv" --base "$flag_base"
assert "флаг неизвестен, заглушка 404: FAIL и код 1" \
  "[[ $RC -eq $EXIT_FAILED ]] && row_has flagunk '/parse-archive +404 +FAIL' \
    && out_has flagunk 'флаг DOCUMENTS_ARCHIVES_ENABLED: значение неизвестно'"
run flagwords --manifest "$TMP/flags.tsv" --base "$flag_base" \
  --flag DOCUMENTS_ARCHIVES_ENABLED=0 --flag DOCUMENTS_EDIT_ENDPOINTS=enabled
assert "флаг: 0 и посторонние слова - выключен" "[[ $RC -eq 0 ]] && out_has flagwords 'SKIP=2'"
printf '%s\n' '# своя карта' $'documents\t/parse\tMY_FLAG' >"$TMP/myflags.tsv"
run flagfile --manifest "$TMP/flags.tsv" --base "$flag_base" --flags-file "$TMP/myflags.tsv" \
  --flag MY_FLAG=no
assert "--flags-file: своя карта действует" \
  "row_has flagfile '/parse +- +SKIP \\(флаг MY_FLAG' && row_has flagfile '/edit-prices +404 +FAIL'"
run flagwarn --manifest "$TMP/flags.tsv" --base "$flag_base" --flag NO_SUCH_FLAG=1
assert "--flag вне карты: предупреждение" "out_has flagwarn 'NO_SUCH_FLAG не упомянут в карте'"
printf '%s\n' $'documents\t/parse' >"$TMP/badflags.tsv"
run flagbad --manifest "$TMP/flags.tsv" --base "$flag_base" --flags-file "$TMP/badflags.tsv"
assert "карта флагов неверного вида - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run flagnone --manifest "$TMP/flags.tsv" --base "$flag_base" --flags-file "$TMP/нет.tsv"
assert "нет файла карты флагов - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run flagbadarg --manifest "$TMP/flags.tsv" --base "$flag_base" --flag "без-значения"
assert "неверный --flag - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
assert "карта флагов: tools/route-flags.tsv на месте и читается" \
  "[[ -f '$HERE/route-flags.tsv' ]] \
    && grep -q '^documents.*/parse-archive.*DOCUMENTS_ARCHIVES_ENABLED' \
    '$HERE/route-flags.tsv'"

# 9b. --stack: флаги из окружения контейнера documents; прочие переменные не читаются и не
# печатаются.
SECRET_DOCS="docs-secret-zz81f3"
cat >"$TMP/docs.env" <<ENV
PATH=/usr/bin
DOCUMENTS_API_SECRET=$SECRET_DOCS
DOCUMENTS_ARCHIVES_ENABLED=True
DOCUMENTS_EDIT_ENDPOINTS=false
DOCUMENTS_IMAGE_TEXT_ENDPOINT=
ENV
flags_url="$(url "$PORT_FLAGS_STACK")"
sed "s#^DOCUMENTS_URL=.*#DOCUMENTS_URL=$flags_url#" "$TMP/app.env" >"$TMP/app-flags.env"
printf '%s\n' \
  $'documents\tPOST\t/parse\troute' \
  $'documents\tPOST\t/parse-archive\troute' \
  $'documents\tPOST\t/edit-prices\troute' \
  $'documents\tPOST\t/xlsx/write\troute' \
  $'documents\tPOST\t/images/recognize-text\troute' >"$TMP/stackflags.tsv"
start_stub "$PORT_FLAGS_STACK" sflags \
  '{"default":404,"routes":{"POST /parse":422,"POST /parse-archive":422}}'
stack_flags() { # stack_flags <имя> [аргументы]: --stack на заглушке docker с окружением documents
  local name="$1"
  shift
  RC=0
  env PATH="$BIN:$PATH" DOCKER_LOG="$TMP/docker-$name.log" APP_ENV_FILE="$TMP/app-flags.env" \
    DOCS_ENV_FILE="$TMP/docs.env" CHECK_ROUTES_TIMEOUT_S=2 ${NO_DOCS:+NO_DOCS=1} \
    bash "$SCRIPT" --stack --manifest "$TMP/stackflags.tsv" "$@" >"$TMP/out-$name" 2>&1 || RC=$?
}
stack_flags sflags
assert "--stack: флаги из окружения documents: код 0" "[[ $RC -eq 0 ]]"
assert "--stack: включённый флаг (True) - маршрут пробуется и OK" \
  "row_has sflags '/parse-archive +422 +OK' \
    && out_has sflags 'флаг DOCUMENTS_ARCHIVES_ENABLED: включён'"
assert "--stack: выключенный флаг, пустой флаг и флаг, которого нет, - SKIP" \
  "row_has sflags '/edit-prices +- +SKIP' && row_has sflags '/images/recognize-text +- +SKIP' \
    && row_has sflags '/xlsx/write +- +SKIP \\(флаг DOCUMENTS_TEMPLATE_ENDPOINTS' \
    && out_has sflags 'OK=2 FAIL=0 ERROR=0 UNVERIFIED=0 SKIP=3'"
assert "--stack: другие переменные контейнера не печатаются" \
  "! grep -qE '$SECRET_DOCS|DOCUMENTS_API_SECRET' '$TMP/out-sflags' '$TMP/docker-sflags.log'"
assert "--stack: окружение читалось у контейнера documents (docker inspect по его id)" \
  "grep -q '^inspect -f .*Config.Env.* docscid\$' '$TMP/docker-sflags.log'"
assert "--stack: SKIP-маршруты не отправлялись" \
  "! grep -qE '/edit-prices|/xlsx/write|/images/recognize-text' '$TMP/sflags.log'"
: >"$TMP/sflags.log"
stack_flags sflagover --flag DOCUMENTS_ARCHIVES_ENABLED=0 --flag DOCUMENTS_EDIT_ENDPOINTS=true
assert "--stack: --flag сильнее окружения контейнера" \
  "[[ $RC -eq $EXIT_FAILED ]] && row_has sflagover '/parse-archive +- +SKIP' \
    && row_has sflagover '/edit-prices +404 +FAIL'"
NO_DOCS=1 stack_flags sflagnocont
assert "--stack: контейнера documents нет - значение неизвестно, маршруты пробуются (FAIL на 404)" \
  "[[ $RC -eq $EXIT_FAILED ]] && row_has sflagnocont '/edit-prices +404 +FAIL' \
    && out_has sflagnocont 'значение неизвестно'"

# 10. Неверные вызовы: код 2.
run usage1
assert "без режима - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run usage2 --bogus
assert "неизвестный аргумент - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run usage3 --base "documents=не-адрес"
assert "неверный --base - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run usage4 --manifest "$TMP/docs.tsv" --base "embeddings=$(url "$PORT_FULL")"
assert "нет адреса сервиса из манифеста - код 2 и подсказка" \
  "[[ $RC -eq $EXIT_USAGE ]] && out_has usage4 'не задан адрес сервиса documents'"
run usage5 --manifest "$TMP/нет.tsv" --base "documents=$(url "$PORT_FULL")"
assert "нет файла манифеста - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
printf '%s\n' $'documents\tPOST\t/parse\tweird' >"$TMP/weird.tsv"
run usage6 --manifest "$TMP/weird.tsv" --base "documents=$(url "$PORT_FULL")"
assert "неизвестный вид маршрута в манифесте - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run usage7 --token-env "1плохое имя" --base "documents=$(url "$PORT_FULL")"
assert "неверный --token-env - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run help --help
assert "--help: код 0" "[[ $RC -eq 0 ]] && out_has help 'Использование'"

# 11. Стиль.
assert "set -euo pipefail в скрипте" "grep -q '^set -euo pipefail' '$SCRIPT'"
long_lines() { # long_lines <файл>: строки длиннее LIMIT знаков (по символам, не байтам)
  python3 -I -c '
import sys
limit = int(sys.argv[2])
bad = [n for n, l in enumerate(open(sys.argv[1], encoding="utf-8"), 1)
       if len(l.rstrip("\n")) > limit]
print(*bad)' "$1" "$LIMIT"
}
assert "check-routes.sh: строки до $LIMIT знаков" "[[ -z \"\$(long_lines '$SCRIPT')\" ]]"
assert "строки теста до $LIMIT знаков" "[[ -z \"\$(long_lines '$0')\" ]]"
assert "в скрипте нет sudo и curl|sh" \
  "! grep -nE 'curl[^|]*\\| *(ba)?sh|^[^#]*\\bsudo\\b' '$SCRIPT'"
assert "скрипт не вызывает изменяющих команд docker" \
  "! grep -nE '^[^#]*docker (rm|stop|kill|start|restart|create|exec|compose|volume|network)' \
    '$SCRIPT'"
assert "токен не передаётся значением в аргументах docker run" \
  "! grep -nE 'docker run[^|]*-e [A-Z_]+=' '$SCRIPT'"

echo "проверок: $((PASS + FAIL)), провалено: $FAIL"
[[ "$FAIL" -eq 0 ]]
