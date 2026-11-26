#!/usr/bin/env bash
# Стенд обновления pii-guard на настоящем Docker (только синтетика, 127.0.0.1).
# Старый шлюз собирается из git-объектов старого репозитория (compose и код боя), litellm и db -
# заглушки, nginx - настоящий с боевым шаблоном и самодельными сертификатами. Пакет собирается
# из тега платформы и прогоняется: preflight -> apply -> проверки -> rollback -> apply в режимах
# log_only и enforce, автооткат, иной mem_limit, расхождения настроек, смена адреса guard.
# Замеряются простой и память.
#
# Использование: bash tools/gateway-9w-synth.sh
# Окружение: SYNTH_TMP (временный каталог), KEEP=1 (не убирать стенд),
#            SYNTH_STEPS (шаги из «log_only enforce auto settings address», по умолчанию все),
#            SYNTH_MEMORY=0 (без замеров памяти: проверка хода втрое быстрее),
#            OLD_REPO, OLD_REF, PLATFORM_REPO.
set -euo pipefail
umask 022

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly HERE
readonly PREFIX="pragmatika-p9w-gw"
readonly LABEL="bai.stage=pd"
readonly PORT=22580
readonly HOST_NAME="gw.test"
readonly OLD_REPO="${OLD_REPO:-$HOME/pragmatika-purchasing}"
readonly OLD_REF="${OLD_REF:-origin/prod}"
readonly PLATFORM_REPO="${PLATFORM_REPO:-$HOME/agent-platform-template}"
readonly STUB_IMAGE="python:3.12.7-slim-bookworm"
readonly SOAK_SECONDS=5
readonly MIN_DISK_GB=8
readonly BODY_BYTES=8388608
readonly PARALLEL=10
readonly POLL_PAUSE=0.2
readonly MIB=1048576
readonly REQUEST_TIMEOUT_S=20
# Опрос простоя: зависший на старом адресе запрос не должен заслонять восстановление
readonly POLL_REQUEST_TIMEOUT_S=2
# Смена адреса guard не должна растягивать простой до первой проверки здоровья (20 с)
readonly RELOAD_DOWNTIME_LIMIT_S=12
LAST_DOWNTIME=""
readonly STEPS="${SYNTH_STEPS:-log_only enforce auto settings address}"
readonly MEMORY="${SYNTH_MEMORY:-1}"

STAND="${SYNTH_TMP:-$(mktemp -d)}/synth"
readonly STAND
readonly ROOT_DIR="$STAND/opt/pragmatika"
readonly GW="$ROOT_DIR/gateway"
readonly CERTS="$STAND/certs"
readonly PKG="$STAND/pkg/gateway-9w"
PASS=0
FAIL=0
POLLER=""
SUMMARY="$STAND/summary.txt"

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
log() { echo "== $(date -u +%H:%M:%S) $*"; }
note() { echo "$*" | tee -a "$SUMMARY"; }

compose() { (cd "$GW" && docker compose -p "$PREFIX" "$@"); }
cid() { compose ps -q "$1"; }

cleanup() {
  set +e
  [[ -n "$POLLER" ]] && kill "$POLLER" 2>/dev/null
  if [[ "${KEEP:-0}" == "1" ]]; then
    echo "KEEP=1: стенд оставлен в $STAND"
    return
  fi
  log "уборка стенда"
  docker rm -f "$PREFIX-pii-guard-9w-probe" "$PREFIX-address-holder" >/dev/null 2>&1
  [[ -f "$GW/docker-compose.yml" ]] &&
    compose -f docker-compose.yml down -v --remove-orphans >/dev/null 2>&1
  local image
  for image in $(docker image ls --format '{{.Repository}}:{{.Tag}}' |
    grep "^$PREFIX-pii-guard:" || true); do
    docker rmi "$image" >/dev/null 2>&1 || echo "не удалён образ $image"
  done
  rm -rf "${STAND:?}"
}

wait_healthy() {
  local container state=""
  for _ in $(seq 1 90); do
    container="$(cid "$1")"
    state="$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || true)"
    [[ "$state" == "healthy" ]] && return 0
    command sleep 2
  done
  echo "служба $1 не healthy: $state" >&2
  return 1
}

# Запрос через nginx стенда с клиентским сертификатом: печатает статус.
through_nginx() {
  local path="$1" body="${2:-}" key="${3:-}"
  local -a args=(-s -o /dev/null -w '%{http_code}'
    --max-time "${CURL_TIMEOUT_S:-$REQUEST_TIMEOUT_S}" --cacert "$CERTS/ca.crt"
    --cert "$CERTS/client.crt" --key "$CERTS/client.key"
    --resolve "$HOST_NAME:$PORT:127.0.0.1")
  [[ -n "$body" ]] && args+=(-H 'content-type: application/json' --data-binary "$body")
  [[ -n "$key" ]] && args+=(-H "x-api-key: $key")
  curl "${args[@]}" "https://$HOST_NAME:$PORT$path" || true
}

message() {
  printf '{"model":"agent-main","max_tokens":1,"messages":[{"role":"user","content":"%s"}]}' "$1"
}

start_poller() {
  : >"$STAND/poll.log"
  (
    while true; do
      printf '%s %s\n' "$(date +%s.%N)" \
        "$(CURL_TIMEOUT_S="$POLL_REQUEST_TIMEOUT_S" through_nginx /healthz)" >>"$STAND/poll.log"
      command sleep "$POLL_PAUSE"
    done
  ) &
  POLLER=$!
}

# Самый длинный перерыв: от последнего 200 до следующего 200, секунды.
stop_poller() {
  command sleep 2
  kill "$POLLER" 2>/dev/null || true
  wait "$POLLER" 2>/dev/null || true
  POLLER=""
  python3 -I - "$STAND/poll.log" <<'PY'
import sys
last_ok = None
worst = 0.0
broken = False
for line in open(sys.argv[1], encoding="ascii"):
    parts = line.split()
    if len(parts) != 2:
        continue
    moment, code = float(parts[0]), parts[1]
    if code == "200":
        if broken and last_ok is not None:
            worst = max(worst, moment - last_ok)
        last_ok, broken = moment, False
    else:
        broken = True
print("не восстановился" if broken else f"{worst:.1f}")
PY
}

patch() {
  local name="$1" rc=0
  shift
  PATCH9W_GW_ROOT="$ROOT_DIR" PATCH9W_PROJECT="$PREFIX" PATCH9W_BACKUP_ROOT="$STAND/backups" \
    PATCH9W_OUT_DIR="$STAND/out" PATCH9W_BUILD_LABEL="$LABEL" \
    bash "$PKG/update-guard.sh" "$@" >"$STAND/logs/$name.log" 2>&1 || rc=$?
  echo "$rc"
}

snapshot() {
  (cd "$ROOT_DIR" && find . -type f ! -path '*/__pycache__/*' -print0 | LC_ALL=C sort -z |
    xargs -0 sha256sum)
  (cd "$ROOT_DIR" && find . -type d ! -name __pycache__ | LC_ALL=C sort)
}

others() {
  local service
  for service in nginx litellm db; do
    docker inspect -f "$service {{.Id}} {{.State.StartedAt}}" "$(cid "$service")"
  done
}

guard_env() {
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(cid pii-guard)" |
    grep -E '^(PII_GUARD_NAMES_MODE|PII_GUARD_ADDRESS_MODE|SEARCH_|VISION_|WEBPAGE_|MAX_BODY)' |
    LC_ALL=C sort
}

guard_python() {
  docker exec "$(cid pii-guard)" python -c "$1"
}

library_version() {
  guard_python 'import labops_pii; print(labops_pii.__version__)'
}

# Слова-исключения не должны попасть ни в журнал патча, ни в архив результата.
words_absent_in() {
  local words word
  words="$(guard_python 'from labops_pii.allowlist import allowed_stems
print(" ".join(allowed_stems()))')"
  [[ -n "$words" ]] || return 1
  for word in $words; do
    if grep -qiF -- "$word" "$@"; then return 1; fi
  done
}

# Память: покой, одно тело 8 МиБ, 10 одновременно. Клиент - в контейнере заглушки litellm.
measure_memory() {
  local label="$1" container idle result peak oom restarts
  container="$(cid pii-guard)"
  command sleep 20
  idle="$(docker exec "$container" cat /sys/fs/cgroup/memory.current)"
  result="$(docker exec "$(cid litellm)" python /stub/load.py "$BODY_BYTES" 1)"
  peak="$(docker exec "$container" cat /sys/fs/cgroup/memory.peak)"
  note "память $label: покой $((idle / MIB)) МиБ; 1 тело 8 МиБ: $result, пик $((peak / MIB)) МиБ"
  result="$(docker exec "$(cid litellm)" python /stub/load.py "$BODY_BYTES" "$PARALLEL")"
  peak="$(docker exec "$container" cat /sys/fs/cgroup/memory.peak)"
  oom="$(docker exec "$container" awk '/^oom_kill / { print $2 }' /sys/fs/cgroup/memory.events)"
  restarts="$(docker inspect -f '{{.RestartCount}}' "$container")"
  note "память $label: $PARALLEL тел по 8 МиБ: $result, пик $((peak / MIB)) МиБ," \
    "oom_kill $oom, перезапусков $restarts"
  assert "$label: нагрузка без OOM и все 200" \
    "[[ '$oom' == 0 && '$restarts' == 0 && '$result' == 'статусы {200: $PARALLEL}'* ]]"
}

# ---------------------------------------------------------------------------------------------
prepare_stand() {
  local free
  free="$(df -BG --output=avail / | tail -n 1 | tr -dc '0-9')"
  ((free >= MIN_DISK_GB)) || { echo "на диске меньше $MIN_DISK_GB ГБ" >&2; exit 1; }
  [[ ! -e "$STAND" ]] || { echo "каталог стенда уже есть: $STAND" >&2; exit 1; }
  [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PREFIX")" ]] ||
    { echo "проект $PREFIX уже существует" >&2; exit 1; }
  mkdir -p "$ROOT_DIR" "$CERTS" "$STAND"/{backups,out,logs,stub,pkg}
  : >"$SUMMARY"
  log "старый шлюз из git-объектов $OLD_REF"
  git -C "$OLD_REPO" archive "$OLD_REF" -- gateway vendor/labops-pii | tar -x -C "$ROOT_DIR"
  git -C "$OLD_REPO" rev-parse --short "$OLD_REF" >"$GW/.git-commit"
  make_certs
  make_stubs
  cat >"$GW/.env" <<EOF
SERVER_NAME=$HOST_NAME
RU_SERVER_IP=0.0.0.0/0
MTLS_DIR=$CERTS
LITELLM_MASTER_KEY=sk-synthetic-master
ANTHROPIC_API_KEY=synthetic
MAIN_MODEL=anthropic/synthetic-main
FALLBACK_MODEL=anthropic/synthetic-fallback
POSTGRES_PASSWORD=synthetic-password
PII_GUARD_NAMES_MODE=log_only
PII_GUARD_ADDRESS_MODE=log_only
EOF
  chmod 600 "$GW/.env"
  adapt_compose
  log "пакет из тега платформы"
  bash "$HERE/build-gateway-9w-package.sh" --platform-repo "$PLATFORM_REPO" \
    --script "$HERE/../deploy/patch-9w/gateway/update-guard.sh" \
    --out "$STAND/pkg/gateway-9w.tgz" >"$STAND/logs/build-package.log"
  (umask 077 && tar -xzf "$STAND/pkg/gateway-9w.tgz" -C "$STAND/pkg")
}

make_certs() {
  local name
  (
    cd "$CERTS"
    openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=synthetic-ca" \
      -keyout ca.key -out ca.crt 2>/dev/null
    for name in server client; do
      openssl req -newkey rsa:2048 -nodes -subj "/CN=$HOST_NAME" -keyout "$name.key" \
        -out "$name.csr" 2>/dev/null
      printf 'subjectAltName=DNS:%s\nextendedKeyUsage=%sAuth\n' "$HOST_NAME" "$name" >"$name.ext"
      openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 \
        -extfile "$name.ext" -out "$name.crt" 2>/dev/null
    done
  )
  local print
  print="$(openssl x509 -in "$CERTS/client.crt" -noout -fingerprint -sha1 |
    sed 's/.*=//; s/://g' | tr 'A-F' 'a-f')"
  printf 'map $ssl_client_fingerprint $client_cert_allowed {\n  default 0;\n  "%s" 1;\n}\n' \
    "$print" >"$GW/nginx/allowed-clients.conf"
}

make_stubs() {
  # Заглушка litellm: без ключа 401 (как с master key), с ключом 200; файл fail - 503.
  cat >"$STAND/stub/litellm.py" <<'PY'
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get("content-length") or 0))
        keyed = self.headers.get("x-api-key") or self.headers.get("authorization")
        code = 200 if keyed else (503 if Path("/stub/fail").exists() else 401)
        body = b'{"stub":"litellm"}'
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        pass


ThreadingHTTPServer(("0.0.0.0", 4000), Handler).serve_forever()
PY
  # Нагрузка: N разных тел заданного размера одновременно, прямо в guard.
  cat >"$STAND/stub/load.py" <<'PY'
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import Counter

size, count = int(sys.argv[1]), int(sys.argv[2])
OVERHEAD = 512


def body(index: int) -> bytes:
    lines, total, number = [], 0, 0
    while total < size - OVERHEAD:
        number += 1
        line = (f"поставка партии {index}.{number} для [PERSON_{number % 900 + 1}] по договору, "
                f"склад [ADDRESS_{index + 1}], цена 1250 руб за штуку.\n")
        total += len(json.dumps(line, ensure_ascii=False).encode()) - 2
        if total >= size - OVERHEAD:
            break
        lines.append(line)
    data = {"model": "agent-main", "max_tokens": 1,
            "messages": [{"role": "user", "content": "".join(lines)}]}
    return json.dumps(data, ensure_ascii=False).encode()


bodies = [body(i) for i in range(count)]
statuses: list[int] = []


def send(data: bytes) -> None:
    request = urllib.request.Request(
        "http://pii-guard:8080/v1/messages", data=data,
        headers={"content-type": "application/json", "x-api-key": "sk-synthetic"})
    try:
        with urllib.request.urlopen(request, timeout=600) as reply:
            statuses.append(reply.status)
    except urllib.error.HTTPError as error:
        statuses.append(error.code)


threads = [threading.Thread(target=send, args=(item,)) for item in bodies]
started = time.monotonic()
for thread in threads:
    thread.start()
for thread in threads:
    thread.join()
print(f"статусы {dict(Counter(statuses))} за {time.monotonic() - started:.1f} с "
      f"(тело {max(len(b) for b in bodies)} байт)")
PY
}

# Боевой compose с заменами для стенда: имя проекта, порт 127.0.0.1, заглушки, метки.
adapt_compose() {
  python3 - "$GW/docker-compose.yml" "$PREFIX" "$PORT" "$STUB_IMAGE" "$STAND/stub" \
    "$LABEL" <<'PY'
import sys
from pathlib import Path

import yaml

path, prefix, port, image, stub, label = sys.argv[1:7]
key, value = label.split("=")
data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
data = {k: v for k, v in data.items() if not str(k).startswith("x-")}
data["name"] = prefix
services = data["services"]
for name in [n for n in services if n not in ("nginx", "pii-guard", "litellm", "db")]:
    del services[name]
services["nginx"]["ports"] = [f"127.0.0.1:{port}:443"]
services["litellm"] = {
    "image": image, "command": ["python", "/stub/litellm.py"],
    "volumes": [f"{stub}:/stub:ro"], "networks": services["litellm"]["networks"],
}
services["db"] = {
    "image": image, "command": ["python", "-c", "import time; time.sleep(10**8)"],
    "networks": services["db"]["networks"],
}
for service in services.values():
    service.setdefault("labels", {})[key] = value
services["pii-guard"]["build"]["labels"] = {key: value}
used = {n for s in services.values() for n in s.get("networks", [])}
data["networks"] = {n: {**(data["networks"].get(n) or {}), "labels": {key: value}} for n in used}
data.pop("volumes", None)
Path(path).write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False),
                      encoding="utf-8")
PY
}

# Изменение настроек самим стендом (как это сделал бы владелец): пересоздать и перечитать nginx.
reconfigure() {
  compose up -d --no-deps pii-guard >/dev/null 2>&1
  wait_healthy pii-guard
  docker exec "$(cid nginx)" nginx -s reload >/dev/null 2>&1
  command sleep 2
}

recreate_fresh() {
  compose up -d --no-deps --force-recreate pii-guard >/dev/null 2>&1
  wait_healthy pii-guard
  docker exec "$(cid nginx)" nginx -s reload >/dev/null 2>&1
  command sleep 2
}

set_env() {
  sed -i "s/^$1=.*/$1=$2/" "$GW/.env"
}

set_guard_mem() {
  python3 - "$GW/docker-compose.yml" "$1" <<'PY'
import sys
from pathlib import Path

import yaml

path = Path(sys.argv[1])
data = yaml.safe_load(path.read_text(encoding="utf-8"))
data["services"]["pii-guard"]["mem_limit"] = sys.argv[2]
path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")
PY
}

check_traffic() {
  local label="$1"
  assert "$label: через nginx /healthz 200" "[[ \$(through_nginx /healthz) == 200 ]]"
  assert "$label: через nginx телефон 422" \
    "[[ \$(through_nginx /v1/messages \"\$(message 'тел +7 916 555-01-23')\" k) == 422 ]]"
  assert "$label: через nginx обычный запрос 200" \
    "[[ \$(through_nginx /v1/messages \"\$(message 'привет [PERSON_1]')\" k) == 200 ]]"
  assert "$label: токены без ключа 401" \
    "[[ \$(through_nginx /v1/messages \"\$(message '[PERSON_1] [ADDRESS_1]')\") == 401 ]]"
}

apply_and_check() {
  local label="$1" env_before env_sum others_before rc downtime log_file
  env_before="$(guard_env)"
  env_sum="$(sha256sum "$GW/.env")"
  others_before="$(others)"
  start_poller
  command sleep 1
  rc="$(patch "$label-apply" --soak-seconds "$SOAK_SECONDS")"
  downtime="$(stop_poller)"
  LAST_DOWNTIME="$downtime"
  log_file="$STAND/logs/$label-apply.log"
  assert "$label: apply код 0 (получен $rc)" "[[ $rc == 0 ]]"
  if [[ "$rc" != 0 ]]; then tail -n 30 "$log_file"; fi
  note "простой $label apply: $downtime с; $(grep -o 'замена заняла.*' "$log_file" || true);" \
    "$(grep -oE 'адрес pii-guard [^:]*' "$log_file" || true)"
  assert "$label: библиотека 1.3.0" "[[ \$(library_version) == 1.3.0 ]]"
  assert "$label: режимы и маршруты прежние" "[[ \"\$(guard_env)\" == \"$env_before\" ]]"
  assert "$label: .env не изменён" "[[ \"\$(sha256sum \"$GW/.env\")\" == \"$env_sum\" ]]"
  assert "$label: nginx, litellm, db не пересоздавались" \
    "[[ \"\$(others)\" == \"$others_before\" ]]"
  assert "$label: override с правами 600" \
    "[[ \$(stat -c %a \"$GW/docker-compose.override.yml\") == 600 ]]"
  assert "$label: mem_limit прежний" \
    "[[ \$(docker inspect -f '{{.HostConfig.Memory}}' \"\$(cid pii-guard)\") == 654311424 ]]"
  assert "$label: слов-исключений нет в журнале патча" "words_absent_in \"$log_file\""
  check_traffic "$label после apply"
}

rollback_and_check() {
  local label="$1" before="$2" image="$3" rc downtime others_before
  others_before="$(others)"
  start_poller
  command sleep 1
  rc="$(patch "$label-rollback" --rollback)"
  downtime="$(stop_poller)"
  assert "$label: rollback код 0 (получен $rc)" "[[ $rc == 0 ]]"
  if [[ "$rc" != 0 ]]; then tail -n 30 "$STAND/logs/$label-rollback.log"; fi
  note "простой $label rollback: $downtime с"
  assert "$label: файлы и каталоги как до патча" "[[ \"\$(snapshot)\" == \"$before\" ]]"
  assert "$label: прежний образ" \
    "[[ \$(docker inspect -f '{{.Image}}' \"\$(cid pii-guard)\") == $image ]]"
  assert "$label: прежняя библиотека" "guard_python 'import pragmatika_guard'"
  assert "$label: другие службы не пересоздавались" "[[ \"\$(others)\" == \"$others_before\" ]]"
  check_traffic "$label после rollback"
}

run_mode() {
  local mode="$1" before image rc env_sum
  log "режим $mode"
  set_env PII_GUARD_NAMES_MODE "$mode"
  set_env PII_GUARD_ADDRESS_MODE "$mode"
  recreate_fresh
  check_traffic "$mode исходный"
  if [[ "$MEMORY" == "1" ]]; then measure_memory "$mode старый"; fi
  recreate_fresh
  before="$(snapshot)"
  image="$(docker inspect -f '{{.Image}}' "$(cid pii-guard)")"
  rc="$(patch "$mode-preflight" --preflight-only)"
  assert "$mode: preflight код 0 (получен $rc)" "[[ $rc == 0 ]]"
  [[ "$rc" == 0 ]] || tail -n 30 "$STAND/logs/$mode-preflight.log"
  assert "$mode: preflight ничего не менял" "[[ \"\$(snapshot)\" == \"$before\" ]]"
  sed -n '1,60p' "$STAND/logs/$mode-preflight.log" >>"$STAND/preflight-$mode.txt"
  assert "$mode: preflight называет режим и память" \
    "grep -q 'режим PII_GUARD_NAMES_MODE=$mode' \"$STAND/logs/$mode-preflight.log\" &&
     grep -q 'не меньше 610 МиБ' \"$STAND/logs/$mode-preflight.log\""
  assert "$mode: слов нет в журнале preflight" \
    "words_absent_in \"$STAND/logs/$mode-preflight.log\""

  apply_and_check "$mode"
  rc="$(patch "$mode-again" --soak-seconds 0)"
  assert "$mode: повторный apply отклонён кодом 3 (получен $rc)" "[[ $rc == 3 ]]"
  if [[ "$MEMORY" == "1" ]]; then measure_memory "$mode новый"; fi
  rollback_and_check "$mode" "$before" "$image"
  rc="$(patch "$mode-rollback2" --rollback)"
  assert "$mode: повторный rollback кодом 3 (получен $rc)" "[[ $rc == 3 ]]"
  command sleep 1
  apply_and_check "$mode-second"
  rollback_and_check "$mode-second" "$before" "$image"
}

run_auto_rollback() {
  local before image rc others_before watcher downtime log_file
  log "автооткат: litellm перестаёт отвечать 401 после замены"
  recreate_fresh
  before="$(snapshot)"
  image="$(docker inspect -f '{{.Image}}' "$(cid pii-guard)")"
  others_before="$(others)"
  log_file="$STAND/logs/auto-apply.log"
  : >"$log_file"
  (
    until grep -q 'пересоздаю только' "$log_file" 2>/dev/null; do command sleep 0.2; done
    touch "$STAND/stub/fail"
  ) &
  watcher=$!
  start_poller
  rc="$(patch auto-apply --soak-seconds "$SOAK_SECONDS")"
  downtime="$(stop_poller)"
  kill "$watcher" 2>/dev/null || true
  rm -f "${STAND:?}/stub/fail"
  assert "автооткат: код 1 (получен $rc)" "[[ $rc == 1 ]]"
  assert "автооткат: в журнале отметка об откате" "grep -q 'откат выполнен' \"$log_file\""
  note "простой при автооткате (замена + возврат): $downtime с"
  assert "автооткат: файлы как до патча" "[[ \"\$(snapshot)\" == \"$before\" ]]"
  assert "автооткат: прежний образ" \
    "[[ \$(docker inspect -f '{{.Image}}' \"\$(cid pii-guard)\") == $image ]]"
  assert "автооткат: другие службы не пересоздавались" \
    "[[ \"\$(others)\" == \"$others_before\" ]]"
  check_traffic "после автоотката"
}

expect_refusal() {
  local name="$1" pattern="$2" before after rc image
  before="$(snapshot)"
  image="$(docker inspect -f '{{.Id}}' "$(cid pii-guard)")"
  rc="$(patch "$name" --soak-seconds 0)"
  after="$(snapshot)"
  assert "$name: отказ кодом 3 (получен $rc)" "[[ $rc == 3 ]]"
  assert "$name: причина названа" "grep -q -- '$pattern' \"$STAND/logs/$name.log\""
  assert "$name: файлы боя не тронуты" "[[ \"$before\" == \"$after\" ]]"
  assert "$name: контейнер guard тот же" \
    "[[ \$(docker inspect -f '{{.Id}}' \"\$(cid pii-guard)\") == $image ]]"
}

run_settings_cases() {
  local rc before image
  log "другой mem_limit и расхождения настроек"
  set_guard_mem 512m
  reconfigure
  expect_refusal mem-512 'меньше нужных 610'
  set_guard_mem 1g
  expect_refusal mem-drift 'не равен compose'
  reconfigure
  before="$(snapshot)"
  image="$(docker inspect -f '{{.Image}}' "$(cid pii-guard)")"
  rc="$(patch mem-1g --soak-seconds 0)"
  assert "mem 1g: apply код 0 (получен $rc)" "[[ $rc == 0 ]]"
  assert "mem 1g: потолок остался 1 ГиБ" \
    "[[ \$(docker inspect -f '{{.HostConfig.Memory}}' \"\$(cid pii-guard)\") == 1073741824 ]]"
  rollback_and_check mem-1g "$before" "$image"
  set_guard_mem 624m
  reconfigure
  # Значение, которого не ставит ни один режим стенда: расхождение есть при любом наборе шагов
  set_env PII_GUARD_NAMES_MODE off
  expect_refusal env-drift 'расходятся с запущенным'
  set_env PII_GUARD_NAMES_MODE log_only
  reconfigure
  echo 'services: {}' >"$GW/docker-compose.override.yml"
  expect_refusal foreign-override 'посторонний файл compose'
  rm -f "${GW:?}/docker-compose.override.yml"
}

# Docker выдал новому контейнеру другой адрес, чем знает nginx: без перечитывания nginx шлёт
# запросы в никуда. Адрес меняется так: заглушка занимает младший адрес, guard получает старший,
# заглушка уходит.
shift_guard_address() {
  docker rm -f "$PREFIX-address-holder" >/dev/null 2>&1 || true
  compose stop pii-guard >/dev/null 2>&1
  docker run -d --name "$PREFIX-address-holder" --label "$LABEL" --network "${PREFIX}_front" \
    "$STUB_IMAGE" python -c 'import time; time.sleep(10**8)' >/dev/null
  recreate_fresh
  docker rm -f "$PREFIX-address-holder" >/dev/null
}

guard_address() {
  local format="{{with index .NetworkSettings.Networks \"${PREFIX}_front\"}}"
  docker inspect -f "$format{{.IPAddress}}{{end}}" "$(cid pii-guard)"
}

run_address_case() {
  local before image old new
  log "смена адреса guard"
  shift_guard_address
  old="$(guard_address)"
  compose up -d --no-deps --force-recreate pii-guard >/dev/null 2>&1
  wait_healthy pii-guard
  new="$(guard_address)"
  assert "адрес: пересоздание без перечитывания сменило адрес ($old -> $new)" \
    "[[ \"$old\" != \"$new\" ]]"
  assert "адрес: nginx без перечитывания guard не видит" \
    "[[ \$(through_nginx /healthz) != 200 ]]"
  shift_guard_address
  old="$(guard_address)"
  before="$(snapshot)"
  image="$(docker inspect -f '{{.Image}}' "$(cid pii-guard)")"
  check_traffic "адрес: исходный"
  apply_and_check address
  new="$(guard_address)"
  assert "адрес: apply получил другой адрес ($old -> $new)" "[[ \"$old\" != \"$new\" ]]"
  assert "адрес: простой $LAST_DOWNTIME с меньше $RELOAD_DOWNTIME_LIMIT_S с" \
    "awk 'BEGIN { exit !($LAST_DOWNTIME > 0 && $LAST_DOWNTIME < $RELOAD_DOWNTIME_LIMIT_S) }'"
  assert "адрес: apply перечитал nginx" \
    "grep -q 'nginx перечитал конфигурацию' \"$STAND/logs/address-apply.log\""
  rollback_and_check address "$before" "$image"
}

wants() {
  [[ " $STEPS " == *" $1 "* ]]
}

main() {
  trap cleanup EXIT
  prepare_stand
  log "сборка и запуск старого стека"
  compose up -d --build >"$STAND/logs/stand-up.log" 2>&1 ||
    { tail -n 40 "$STAND/logs/stand-up.log"; exit 1; }
  wait_healthy pii-guard
  command sleep 3
  assert "старый стек: библиотека 0.8.0 (модуль pragmatika_guard)" \
    "guard_python 'import pragmatika_guard, labops_pii.profiles'"
  if wants log_only; then run_mode log_only; fi
  if wants enforce; then run_mode enforce; fi
  if wants auto; then run_auto_rollback; fi
  if wants settings; then run_settings_cases; fi
  if wants address; then run_address_case; fi
  local names archive
  names="$(for archive in "$STAND"/out/patch9w-gw-*.tgz; do tar tzf "$archive"; done)"
  assert "результат: архивы есть, в них только журнал и VERSION" \
    "[[ -n \"$names\" ]] && ! grep -vqE '/(run\\.log|VERSION)?$' <<<\"$names\""
  echo
  if wants log_only; then
    echo "--- preflight (log_only)"
    cat "$STAND/preflight-log_only.txt"
  fi
  echo "--- замеры"
  cat "$SUMMARY"
  echo "--- итог: проверок $((PASS + FAIL)), провалов $FAIL"
  ((FAIL == 0))
}

main "$@"
