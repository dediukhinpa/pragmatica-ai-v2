#!/usr/bin/env bash
# Тест deploy/patch-9w/gateway/update-guard.sh на заглушке docker (настоящий Docker не нужен):
# параметры и коды выхода 0/1/2/3/4, отказы предусловий без изменений боя, сборка и проба до
# замены, состав замены, override и слова-исключения (только синтетика, в журналы не попадают),
# перечитывание nginx при смене адреса guard, откат и автооткат, обрыв сеанса, архив результата.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${GATEWAY9W_SCRIPT:-$HERE/../deploy/patch-9w/gateway/update-guard.sh}"
BASE="$(mktemp -d)"
trap 'chmod -R u+rwX "${BASE:?}" 2>/dev/null; rm -rf "${BASE:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
SYNTH_WORDS="выдуманка,мнимослов"
NEED_MIB=610
MIB=1048576

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# ---------------------------------------------------------------------------------------------
# Заглушка docker: состояние «шлюза» в JSON; nginx помнит адрес guard, как настоящий.
# ---------------------------------------------------------------------------------------------
mkdir -p "$BASE/bin"
cat >"$BASE/bin/docker" <<'PY'
#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys

STATE = os.environ["FAKE_STATE"]
state = json.load(open(STATE, encoding="utf-8"))
args = sys.argv[1:]
fault = state["faults"]
with open(STATE + ".calls", "a", encoding="utf-8") as calls:
    calls.write(" ".join(a for a in args if "\n" not in a) + "\n")


def done(code: int = 0, out: str = "") -> None:
    # Запись заменой файла: в конвейере две заглушки читают состояние одновременно
    draft = f"{STATE}.{os.getpid()}"
    with open(draft, "w", encoding="utf-8") as target:
        json.dump(state, target, ensure_ascii=False)
    os.replace(draft, STATE)
    if out:
        print(out)
    sys.exit(code)


def by_id(ref: str) -> dict:
    for name, item in state["containers"].items():
        if ref in (item["id"], name):
            return item
    done(1)


def override_env() -> dict:
    path = os.path.join(state["gw"], "docker-compose.override.yml")
    paths = [a for a in args if a.endswith("override.yml")]
    found = {}
    for item in paths:
        full = item if item.startswith("/") else os.path.join(state["gw"], item)
        for key, value in re.findall(r'^      (\w+): "(.*)"$', open(full, encoding="utf-8").read(),
                                     re.M):
            found[key] = value
    del path
    return found


def new_guard(image: str, probe: bool) -> dict:
    state["serial"] += 1
    module = "old" if image == "img-old" else "new"
    env = dict(state["compose_env"])
    env.update(override_env())
    env["PATH"] = "/usr/bin"
    if module == "old":
        env["LABOPS_PII_PROFILE"] = "pragmatika"
    health = "healthy"
    if module == "new" and (fault.get("probe_unhealthy") if probe else
                            fault.get("new_unhealthy")):
        health = "unhealthy"
    last = state["last_ip"]
    ip = last if fault.get("same_ip") else last + 1
    if not probe:
        state["last_ip"] = ip
    return {"id": f"c-guard-{state['serial']}", "image": image, "env": env, "module": module,
            "probe": probe, "memory": state["memory"], "ip": f"10.0.0.{ip}", "health": health,
            "restarts": 0, "started": f"t{state['serial']}", "service": "pii-guard",
            "files": state["gw"] + "/docker-compose.yml"}


if args[0] == "info":
    done(1 if fault.get("no_docker") else 0, state["root"] if "-f" in args else "")
if args[0] == "compose":
    if args[1] == "version":
        done(0, "v2")
    rest = args[1:]
    while rest and rest[0] in ("-p", "-f"):
        rest = rest[2:]
    command = rest[0]
    if command == "config":
        if "-q" in rest:
            done(1 if fault.get("config_bad") else 0)
        env = dict(state["compose_env"])
        env.update(override_env())
        done(0, json.dumps({"services": {
            "litellm": {"environment": {"SECRET": "sk-secret"}},
            "pii-guard": {"environment": env, "mem_limit": str(state["compose_memory"]),
                          "build": {"dockerfile": "gateway/pii-guard/Dockerfile"}}}}))
    if command == "ps":
        service = rest[-1]
        item = state["containers"].get(service)
        done(0, item["id"] if item else "")
    if command == "run":
        name = rest[rest.index("--name") + 1]
        state["containers"][name] = new_guard("img-new", True)
        done(0, "probe")
    if command == "up":
        if "--no-deps" not in rest or "--no-build" not in rest or rest[-1] != "pii-guard":
            done(9)
        image = state["images"]["pragmatika-gateway-pii-guard"]
        if fault.get("up_fail") == "always" or (fault.get("up_fail") and image != "img-old"):
            state["containers"].pop("pii-guard", None)
            done(1, "up failed")
        if fault.get("restore_fail") and image == "img-old":
            done(1, "up failed")
        state["containers"]["pii-guard"] = new_guard(image, False)
        if fault.get("touch_others") and image != "img-old":
            state["containers"]["nginx"]["started"] = "t-new"
        done(0)
    done(9)
if args[0] == "inspect":
    fmt, ref = args[2], args[3]
    item = by_id(ref)
    if "config_files" in fmt:
        done(0, fault.get("files_label") or item["files"])
    if "compose.service" in fmt:
        done(0, item["service"])
    if ".State.StartedAt" in fmt:
        done(0, item["started"])
    if ".State.Status" in fmt:
        done(0, f"running {item['health']}")
    if ".Config.Env" in fmt:
        done(0, "\n".join(f"{k}={v}" for k, v in item["env"].items()))
    if ".Config.Image" in fmt:
        done(0, "pragmatika-gateway-pii-guard")
    if ".HostConfig.Memory" in fmt:
        done(0, str(item["memory"]))
    if "NetworkSettings" in fmt:
        done(0, item["ip"])
    if ".RestartCount" in fmt:
        done(0, str(fault.get("restarts", 0) if item.get("module") == "new" else 0))
    if fmt == "{{.Image}}":
        done(0, item["image"])
    if fmt == "{{.Id}}":
        done(0, item["id"])
    done(9)
if args[0] == "ps":
    done(0, "\n".join(i["id"] for i in state["containers"].values() if not i.get("probe")))
if args[0] == "exec":
    rest = args[1:]
    if rest[0] == "-i":
        rest = rest[1:]
    item = by_id(rest[0])
    command = rest[1:]
    if command[0] == "nginx":
        if command[1] == "-t":
            done(1 if fault.get("nginx_bad") else 0)
        state["nginx_ip"] = state["containers"]["pii-guard"]["ip"]
        state["reloads"] += 1
        done(0)
    if command[0] == "wget":
        done(0 if state["nginx_ip"] == state["containers"]["pii-guard"]["ip"] else 1)
    code = command[2]
    new = item["module"] == "new"
    if 'json.load(sys.stdin)["services"]' in code:
        result = subprocess.run([sys.executable, "-c", code], input=sys.stdin.read(),
                                capture_output=True, text=True)
        done(result.returncode, result.stdout.rstrip("\n"))
    if "import pragmatika_guard" in code:
        done(1 if new or fault.get("no_module") else 0)
    if "agentplatform_guard" in code:
        done(0 if new else 1, fault.get("late_version") if not item.get("probe") and
             fault.get("late_version") else "1.3.0")
    if "urllib.request" in code:
        words = sys.stdin.read().strip()
        if words != state["words"]:
            done(1)
        token = "401"
        phone = "422"
        clear = "1"
        if not new:
            token = fault.get("old_token", token)
            phone = fault.get("old_phone", phone)
            clear = fault.get("old_clear", clear)
        elif not item.get("probe"):
            token = fault.get("late_token", token)
        done(0, f"phone={phone}\ntoken={token}\nwords_clear={clear}")
    if "get_profile" in code:
        done(0, "2")
    if "allowed_stems" in code:
        if fault.get("bad_words"):
            done(1)
        words = state["words"]
        if new:
            words = item["env"].get("PII_ALLOWED_WORDS", "")
            if item.get("probe") and fault.get("probe_words"):
                words = "другое"
            if not item.get("probe") and fault.get("late_words"):
                words = "другое"
        done(0, words)
    done(9)
if args[0] == "build":
    if fault.get("build_fail"):
        done(1, "pip: no network")
    tag = args[args.index("-t") + 1]
    state["images"][tag] = "img-new"
    context = args[-1]
    modes = []
    for folder, _, files in os.walk(context):
        modes += [os.stat(os.path.join(folder, f)).st_mode & 0o044 for f in files]
    state["context_readable"] = all(m == 0o044 for m in modes) and bool(modes)
    done(0)
if args[0] == "run":
    done(0, fault.get("image_version", "1.3.0"))
if args[0] == "tag":
    source, target = args[1], args[2]
    state["images"][target] = state["images"].get(source, source)
    done(0)
if args[0] == "image":
    ref = args[-1]
    if ref.startswith("python:"):
        done(0)
    if ref not in state["images"]:
        done(1)
    done(0, state["images"][ref])
if args[0] == "logs":
    done(0, '{"event": "pii_guard_failed"}' if fault.get("log_errors") else
         '{"event": "pii_guard_denied"}')
if args[0] == "rm":
    state["containers"].pop(args[-1], None)
    done(0)
done(9)
PY
chmod +x "$BASE/bin/docker"

# ---------------------------------------------------------------------------------------------
# «Мир»: дерево шлюза, пакет и состояние заглушки. Каждый сценарий начинает заново.
# ---------------------------------------------------------------------------------------------
WORLD=0
T=""
GW=""
PKG=""
OUTPUT=""
CODE=0

world() {
  WORLD=$((WORLD + 1))
  T="$BASE/w$WORLD"
  GW="$T/opt/pragmatika/gateway"
  PKG="$T/pkg/gateway-9w"
  local vendor="$T/opt/pragmatika/vendor/labops-pii"
  mkdir -p "$GW/pii-guard/pragmatika_guard" "$vendor/labops_pii" "$T/backups" "$T/out" \
    "$PKG/platform/gateway/pii-guard/agentplatform_guard" "$PKG/platform/deploy/docker" \
    "$PKG/platform/vendor/labops-pii/labops_pii" "$T/root"
  cat >"$GW/docker-compose.yml" <<'EOF'
name: pragmatika-gateway
services:
  pii-guard:
    environment:
      PII_GUARD_NAMES_MODE: ${PII_GUARD_NAMES_MODE:-log_only}
      PII_GUARD_SCAN_PROCESSES: ${PII_GUARD_SCAN_PROCESSES:-2}
EOF
  printf 'LITELLM_MASTER_KEY=sk-secret\nPII_GUARD_NAMES_MODE=enforce\n' >"$GW/.env"
  chmod 600 "$GW/.env"
  echo ef0374f >"$GW/.git-commit"
  echo 'old = 1' >"$GW/pii-guard/pragmatika_guard/app.py"
  echo 'FROM old' >"$GW/pii-guard/Dockerfile"
  printf 'tag: v0.8.0\n' >"$vendor/VERSION"
  echo 'old = 1' >"$vendor/labops_pii/__init__.py"
  cp "$SCRIPT" "$PKG/update-guard.sh"
  echo 'gateway-9w: тест' >"$PKG/VERSION"
  echo 'FROM new' >"$PKG/platform/gateway/pii-guard/Dockerfile"
  echo 'new = 1' >"$PKG/platform/gateway/pii-guard/agentplatform_guard/app.py"
  echo '#!/bin/sh' >"$PKG/platform/deploy/docker/config-env.sh"
  printf 'tag: v1.3.0\n' >"$PKG/platform/vendor/labops-pii/VERSION"
  echo 'new = 1' >"$PKG/platform/vendor/labops-pii/labops_pii/__init__.py"
  manifest
  printf 'MemAvailable:    2000000 kB\n' >"$T/meminfo"
  python3 - "$T" "$GW" "$SYNTH_WORDS" <<'PY'
import json
import sys

root, gw, words = sys.argv[1:4]
env = {
    "PII_GUARD_NAMES_MODE": "enforce", "PII_GUARD_ADDRESS_MODE": "log_only",
    "PII_GUARD_SCAN_PROCESSES": "2", "SEARCH_ROUTE_ENABLED": "0", "SEARCH_ALLOWED_MODELS": "",
    "VISION_ROUTE_ENABLED": "1", "VISION_MAX_CONCURRENT": "2", "MAX_BODY_BYTES": "8388608",
    "VISION_MAX_BODY_BYTES": "16777216", "WEBPAGE_ROUTE_ENABLED": "0",
}


def other(name: str) -> dict:
    return {"id": f"c-{name}", "service": name, "started": "t0", "ip": "10.0.0.9"}


guard = {"id": "c-guard-0", "image": "img-old", "module": "old", "service": "pii-guard",
         "env": {**env, "LABOPS_PII_PROFILE": "pragmatika"}, "memory": 654311424,
         "ip": "10.0.0.2", "health": "healthy", "restarts": 0, "started": "t0",
         "files": gw + "/docker-compose.yml"}
state = {
    "gw": gw, "root": root + "/root", "words": words, "serial": 0, "last_ip": 2,
    "nginx_ip": "10.0.0.2", "reloads": 0, "compose_env": env, "memory": 654311424,
    "compose_memory": 654311424, "faults": {},
    "images": {"pragmatika-gateway-pii-guard": "img-old", "img-old": "img-old"},
    "containers": {"pii-guard": guard, "nginx": other("nginx"), "litellm": other("litellm"),
                   "db": other("db")},
}
json.dump(state, open(root + "/state.json", "w", encoding="utf-8"), ensure_ascii=False)
PY
}

manifest() {
  (cd "$PKG" && find . -type f ! -name MANIFEST.sha256 | sed 's|^\./||' | LC_ALL=C sort |
    xargs -d '\n' sha256sum >MANIFEST.sha256)
}

# Правка состояния заглушки: выражение Python над переменной s.
tweak() {
  python3 - "$T/state.json" "$1" <<'PY'
import json
import sys

s = json.load(open(sys.argv[1], encoding="utf-8"))
exec(sys.argv[2])
json.dump(s, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False)
PY
}

query() {
  python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' \
    "$T/state.json" "$1"
}

# Настройка боя меняется и в compose, и в запущенном контейнере (расхождения нет).
setting() {
  tweak "s['compose_env']['$1'] = '$2'; s['containers']['pii-guard']['env']['$1'] = '$2'"
}

environment() {
  env PATH="$BASE/bin:$PATH" FAKE_STATE="$T/state.json" PATCH9W_GW_ROOT="$T/opt/pragmatika" \
    PATCH9W_BACKUP_ROOT="$T/backups" PATCH9W_OUT_DIR="$T/out" PATCH9W_HEALTH_TIMEOUT=1 \
    PATCH9W_POLL_SECONDS=0 PATCH9W_MIN_DISK_MIB="${MIN_DISK:-0}" PATCH9W_MEMINFO="$T/meminfo" \
    "$@"
}

run() {
  CODE=0
  OUTPUT="$(environment bash "$PKG/update-guard.sh" "$@" 2>&1)" || CODE=$?
}

snapshot() {
  (cd "$T/opt" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum)
  (cd "$T/opt" && find . | LC_ALL=C sort)
}

untouched() {
  local name="$1" before="$2"
  assert "$name: файлы боя не изменены" "[[ \"\$(snapshot)\" == \"\$before\" ]]"
  assert "$name: контейнер и образ guard прежние" \
    "[[ \$(query \"s['containers']['pii-guard']['id']\") == c-guard-0 &&
        \$(query \"s['images']['pragmatika-gateway-pii-guard']\") == img-old ]]"
  assert "$name: пробного контейнера не осталось" "[[ \$(query \"len(s['containers'])\") == 4 ]]"
}

# Отказ предусловий: код 3, причина названа, сборки и замены не было.
refusal() {
  local name="$1" pattern="$2" before
  before="$(snapshot)"
  run --soak-seconds 0
  assert "отказ $name: код 3 (получен $CODE)" "[[ $CODE == 3 ]]"
  assert "отказ $name: причина «$pattern»" "grep -qF -- \"\$pattern\" <<<\"\$OUTPUT\""
  untouched "отказ $name" "$before"
  assert "отказ $name: бэкапа и сборки нет" \
    "[[ -z \"\$(ls -A \"$T/backups\")\" ]] && ! grep -q '^build' \"$T/state.json.calls\""
}

# ---------------------------------------------------------------------------------------------
echo "== статические проверки"
assert "скрипт разбирается bash" "bash -n \"$SCRIPT\""
assert "строки не длиннее $LIMIT" \
  "[[ -z \"\$(LC_ALL=C.UTF-8 awk 'length > $LIMIT' \"$SCRIPT\")\" ]]"
assert "нет down, prune и пересоздания чужих служб" \
  "! grep -qE 'compose (-[^ ]+ [^ ]+ )*down|dc .* down|prune|--remove-orphans' \"$SCRIPT\""
assert "на хосте не вызываются python3 и jq" "! grep -qE '^[[:space:]]*(python3|jq) ' \"$SCRIPT\""
# Фрагменты Python, исполняемые в контейнерах, заглушка не запускает: проверяется синтаксис
for name in PY_COMPOSE PY_WORDS PY_PROFILE_COUNT PY_PROBE; do
  code="$(awk -v start="readonly $name='" \
    '$0 == start { f = 1; next } f && $0 == "\047" { exit } f' "$SCRIPT")"
  assert "фрагмент $name разбирается Python" "[[ -n \"\$code\" ]] &&
    python3 -I -c 'import sys; compile(sys.argv[1], \"x\", \"exec\")' \"\$code\""
done

echo "== параметры"
world
run --help
assert "--help: код 0 и использование" "[[ $CODE == 0 ]] && grep -q -- '--rollback' <<<\"\$OUTPUT\""
run --unknown
assert "неизвестный параметр: код 2" "[[ $CODE == 2 ]]"
run --soak-seconds abc
assert "--soak-seconds не число: код 2" "[[ $CODE == 2 ]]"
run --soak-seconds
assert "параметр без значения: код 2" "[[ $CODE == 2 ]]"
run --run-dir /tmp
assert "--run-dir без --rollback: код 2" "[[ $CODE == 2 ]]"
run --out-dir "$T/нет"
assert "нет каталога результата: код 2" "[[ $CODE == 2 ]]"

echo "== preflight"
world
before="$(snapshot)"
run --preflight-only
assert "preflight: код 0 (получен $CODE)" "[[ $CODE == 0 ]]"
untouched preflight "$before"
assert "preflight: бэкапа, сборки, меток и up нет" \
  "[[ -z \"\$(ls -A \"$T/backups\")\" ]] &&
   ! grep -qE '^(build|tag)| up | run ' \"$T/state.json.calls\""
for line in 'вендор labops-pii: v0.8.0' '.git-commit: ef0374f' 'модуль guard: pragmatika_guard' \
  'режим PII_GUARD_NAMES_MODE=enforce' 'режим PII_GUARD_ADDRESS_MODE=log_only' \
  'маршрут VISION_ROUTE_ENABLED=1' "не меньше $NEED_MIB МиБ" 'mem_limit pii-guard: 624 МиБ' \
  'чужих override и COMPOSE_FILE нет' 'слов-исключений действует: 2' 'свободно на диске' \
  'доступно памяти: 1953 МиБ' 'телефон 422, только токены 401' 'предусловия выполнены'; do
  assert "preflight печатает: $line" "grep -qF -- \"\$line\" <<<\"\$OUTPUT\""
done
archive="$(ls "$T"/out/patch9w-gw-*.tgz)"
names="$(tar tzf "$archive" | grep -v '/$' | sed 's|.*/||' | LC_ALL=C sort | tr '\n' ' ')"
assert "архив: только журнал и VERSION" "[[ \"$names\" == 'VERSION run.log ' ]]"
secretless() {
  local text word
  text="$OUTPUT $(tar xzOf "$1")"
  for word in ${SYNTH_WORDS//,/ } sk-secret; do
    [[ "$text" != *"$word"* ]] || return 1
  done
}
assert "preflight: ни слов, ни секретов в выводе и архиве" "secretless \"$archive\""

echo "== отказы предусловий"
world; printf 'tag: v0.9.0\n' >"$T/opt/pragmatika/vendor/labops-pii/VERSION"
refusal "чужой вендор" 'ждали вендор v0.8.0'
world; printf 'tag: v1.3.0\n' >"$T/opt/pragmatika/vendor/labops-pii/VERSION"
refusal "уже применено" 'патч уже применён'
world; rm -rf "${GW:?}/pii-guard/pragmatika_guard"
refusal "нет модуля" 'нет модуля pii-guard/pragmatika_guard'
for name in docker-compose.override.yml compose.override.yaml compose.yaml; do
  world; echo 'services: {}' >"$GW/$name"
  refusal "посторонний $name" "посторонний файл compose: $name"
done
world; echo 'COMPOSE_FILE=docker-compose.yml' >>"$GW/.env"
refusal "COMPOSE_FILE в .env" 'в .env задан COMPOSE_FILE'
world; before="$(snapshot)"
CODE=0
OUTPUT="$(environment COMPOSE_FILE=x.yml bash "$PKG/update-guard.sh" 2>&1)" || CODE=$?
assert "COMPOSE_FILE в окружении: код 3" "[[ $CODE == 3 ]]"
world; tweak "s['containers']['pii-guard']['health'] = 'unhealthy'"
refusal "unhealthy" 'pii-guard не healthy'
world; tweak "s['faults']['nginx_bad'] = True"
refusal "nginx -t" 'nginx -t не проходит'
world; tweak "s['faults']['files_label'] = '/x/a.yml,/x/b.yml'"
refusal "контейнер из других файлов" 'создан не только из docker-compose.yml'
world; tweak "s['faults']['no_module'] = True"
refusal "нет модуля в контейнере" 'в контейнере нет pragmatika_guard'
world; tweak "s['compose_env']['PII_GUARD_NAMES_MODE'] = 'log_only'"
refusal ".env разошёлся с контейнером" 'расходятся с запущенным контейнером по: PII_GUARD_NAMES'
world; setting PII_GUARD_ADDRESS_MODE strict
refusal "неизвестный режим" 'неизвестное значение PII_GUARD_ADDRESS_MODE'
world; setting SEARCH_ROUTE_ENABLED 1
refusal "поиск без моделей" 'пустым SEARCH_ALLOWED_MODELS'
world; setting LABOPS_PII_PROFILE pragmatika
refusal "профиль в compose" 'compose передаёт LABOPS_PII_PROFILE'
world; tweak "s['compose_memory'] = 512*$MIB; s['containers']['pii-guard']['memory'] = 512*$MIB"
refusal "малый mem_limit" "меньше нужных $NEED_MIB МиБ"
world; tweak "s['compose_memory'] = 1024*$MIB"
refusal "mem_limit разошёлся" 'не равен compose'
world; setting MAX_BODY_BYTES 16777216
refusal "тело больше замера" 'MAX_BODY_BYTES=16777216 больше'
world; setting PII_GUARD_SCAN_PROCESSES 9
refusal "процессов больше 8" 'вне 0..8'
world; setting PII_GUARD_SCAN_PROCESSES 4
refusal "процессы повышают потребность в памяти" 'меньше нужных 668 МиБ'
world; tweak "s['words'] = ''"
refusal "пустые слова" 'действующий список пуст'
world; tweak "s['faults']['bad_words'] = True"
refusal "слова не читаются" 'не получить список слов-исключений'
world; MIN_DISK=999999999 refusal "мало диска" 'на диске меньше'
world; printf 'MemAvailable:    100000 kB\n' >"$T/meminfo"
refusal "мало памяти" 'доступной памяти меньше'
world; tweak "s['faults']['old_phone'] = '200'"
refusal "старый guard пропускает телефон" 'старый guard не отклонил телефон'
world; tweak "s['faults']['old_token'] = '502'"
refusal "litellm недоступен" 'не дошёл до litellm'
world; tweak "s['faults']['old_clear'] = '0'"
refusal "слово не работает у старого" 'находит name рядом'
world; echo 'x' >>"$PKG/platform/gateway/pii-guard/Dockerfile"
refusal "повреждённый пакет" 'пакет повреждён'
world; printf 'tag: v1.2.0\n' >"$PKG/platform/vendor/labops-pii/VERSION"; manifest
refusal "в пакете не та библиотека" 'в пакете не labops-pii v1.3.0'
world; rm "$PKG/MANIFEST.sha256"
refusal "не из пакета" 'не из распакованного пакета'
if [[ "$(id -u)" != 0 ]]; then
  world; chmod 500 "$T/opt/pragmatika/vendor/labops-pii"
  refusal "нет прав на запись" 'нет прав на запись'
fi

echo "== сбой до замены: сборка и проба"
before_change() {
  local name="$1" pattern="$2" before
  before="$(snapshot)"
  run --soak-seconds 0
  assert "$name: код 3 (получен $CODE)" "[[ $CODE == 3 ]]"
  assert "$name: причина «$pattern»" "grep -qF -- \"\$pattern\" <<<\"\$OUTPUT\""
  untouched "$name" "$before"
  assert "$name: замены не было" "! grep -q ' up ' \"$T/state.json.calls\""
}
world; tweak "s['faults']['build_fail'] = True"
before_change "сборка не удалась" 'образ не собрался'
world; tweak "s['faults']['image_version'] = '1.2.0'"
before_change "не та версия в образе" 'в новом образе labops-pii 1.2.0'
world; tweak "s['faults']['probe_unhealthy'] = True"
before_change "проба unhealthy" 'не стал healthy'
world; tweak "s['faults']['probe_words'] = True"
before_change "проба: другой набор слов" 'не прошёл пробы'

echo "== успешное применение"
world
before="$(snapshot)"
env_sum="$(sha256sum <"$GW/.env")"
run --soak-seconds 0
assert "apply: код 0 (получен $CODE)" "[[ $CODE == 0 ]]"
[[ $CODE == 0 ]] || echo "$OUTPUT"
run_dir="$(ls -d "$T"/backups/pragmatika-gw-patch9w-*)"
override="$GW/docker-compose.override.yml"
vendor="$T/opt/pragmatika/vendor/labops-pii"
config_env="$T/opt/pragmatika/deploy/docker/config-env.sh"
assert "apply: новый модуль на месте, старого нет" \
  "[[ -f \"$GW/pii-guard/agentplatform_guard/app.py\" &&
      ! -e \"$GW/pii-guard/pragmatika_guard\" ]]"
assert "apply: вендор 1.3.0" "grep -qx 'tag: v1.3.0' \"$vendor/VERSION\""
assert "apply: config-env.sh с правами 755" "[[ \$(stat -c %a \"$config_env\") == 755 ]]"
assert "apply: файлы кода читаемы службой" \
  "[[ \$(stat -c %a \"$GW/pii-guard/agentplatform_guard/app.py\") == 644 &&
      \$(stat -c %a \"$GW/pii-guard\") == 755 ]]"
assert "apply: контекст сборки читаем службой" "[[ \$(query \"s['context_readable']\") == True ]]"
assert "apply: override 600" "[[ \$(stat -c %a \"$override\") == 600 ]]"
for line in 'PII_GUARD_WINDOWED_SCAN: "1"' 'PII_GUARD_STRUCTURE_LIMIT: "1"' \
  'PII_GUARD_MALLOC_TUNING: "1"' "PII_ALLOWED_WORDS: \"$SYNTH_WORDS\""; do
  assert "override: $line" "grep -qF -- \"\$line\" \"$override\""
done
assert "override: число процессов берётся из compose боя" \
  "! grep -q PII_GUARD_SCAN_PROCESSES \"$override\""
assert "override: режимы и mem_limit не задаются" \
  "! grep -qE 'NAMES_MODE|ADDRESS_MODE|mem_limit|ROUTE' \"$override\""
assert "apply: .env не изменён" "[[ \"\$(sha256sum <\"$GW/.env\")\" == \"\$env_sum\" ]]"
assert "apply: .git-commit не изменён" "[[ \$(cat \"$GW/.git-commit\") == ef0374f ]]"
assert "apply: образ службы новый, метка отката на старый" \
  "[[ \$(query \"s['images']['pragmatika-gateway-pii-guard']\") == img-new &&
      \$(query \"s['images']['pragmatika-gateway-pii-guard:pre-9w']\") == img-old ]]"
assert "apply: nginx перечитан при смене адреса" "[[ \$(query \"s['reloads']\") == 1 ]]"
order="$(awk '/ up -d |^up -d / { seen = 1; next } seen && /nginx -s reload/ { print "reload" }
  seen && /State.Status/ { print "health" }' "$T/state.json.calls" | head -n 1)"
assert "apply: nginx перечитывается до ожидания healthy" "[[ \"$order\" == reload ]]"
steps="$(awk '/^build / { print "build" } / run -d / { print "probe" }
  / up -d / { print "up" }' "$T/state.json.calls" | tr '\n' ,)"
assert "apply: сборка и проба раньше замены" "[[ \"$steps\" == 'build,probe,up,' ]]"
assert "apply: up только pii-guard без зависимостей и сборки" \
  "grep -qE ' up -d --no-deps --no-build --force-recreate pii-guard$' \"$T/state.json.calls\""
assert "apply: бэкап 600, каталог 700, .env внутри" \
  "[[ \$(stat -c %a \"$run_dir\") == 700 && \$(stat -c %a \"$run_dir/gateway.tgz\") == 600 ]] &&
   tar tzf \"$run_dir/gateway.tgz\" gateway/.env >/dev/null"
assert "apply: состояние applied" "grep -qx 'STATUS=applied' \"$run_dir/state\""
archive="$(ls "$T"/out/patch9w-gw-*.tgz)"
assert "apply: ни слов, ни секретов в выводе и архиве" "secretless \"$archive\""

run --soak-seconds 0
assert "повторный apply: код 3" "[[ $CODE == 3 ]] && grep -q 'уже применён' <<<\"\$OUTPUT\""

echo "== ручной откат"
run --rollback
assert "rollback: код 0 (получен $CODE)" "[[ $CODE == 0 ]]"
[[ $CODE == 0 ]] || echo "$OUTPUT"
assert "rollback: дерево как до патча (файлы и каталоги)" "[[ \"\$(snapshot)\" == \"\$before\" ]]"
assert "rollback: прежний образ и модуль" \
  "[[ \$(query \"s['containers']['pii-guard']['image']\") == img-old ]]"
assert "rollback: nginx видит guard" \
  "[[ \$(query \"s['nginx_ip'] == s['containers']['pii-guard']['ip']\") == True ]]"
assert "rollback: без сборки" "[[ \$(grep -c '^build' \"$T/state.json.calls\") == 1 ]]"
assert "rollback: состояние rolled_back" "grep -qx 'STATUS=rolled_back' \"$run_dir/state\""
run --rollback
assert "повторный rollback: код 3" "[[ $CODE == 3 ]]"
command sleep 1
run --soak-seconds 0
assert "apply после отката: код 0 (получен $CODE)" "[[ $CODE == 0 ]]"
run --rollback --run-dir "$run_dir"
assert "откат старого запуска по --run-dir: код 3" "[[ $CODE == 3 ]]"
run --rollback
assert "откат второго запуска: код 0" "[[ $CODE == 0 ]]"

echo "== варианты настроек"
world; tweak "s['faults']['same_ip'] = True"
run --soak-seconds 0
assert "адрес прежний: nginx не перечитывается" \
  "[[ $CODE == 0 && \$(query \"s['reloads']\") == 0 ]]"
world; tweak "del s['compose_env']['PII_GUARD_SCAN_PROCESSES']
del s['containers']['pii-guard']['env']['PII_GUARD_SCAN_PROCESSES']"
run --soak-seconds 0
assert "compose без числа процессов: override задаёт прежние 2" \
  "[[ $CODE == 0 ]] &&
   grep -qF 'PII_GUARD_SCAN_PROCESSES: \"2\"' \"$GW/docker-compose.override.yml\""
world; tweak "s['compose_memory'] = s['memory'] = s['containers']['pii-guard']['memory'] = 1<<30"
run --soak-seconds 0
assert "mem_limit 1 ГиБ: применяется" "[[ $CODE == 0 ]]"
world; mkdir -p "$T/opt/pragmatika/deploy/docker"
echo 'прежний' >"$T/opt/pragmatika/deploy/docker/config-env.sh"
before="$(snapshot)"
run --soak-seconds 0
run --rollback
assert "прежний config-env.sh возвращается при откате" \
  "[[ $CODE == 0 && \"\$(snapshot)\" == \"\$before\" ]]"

echo "== автооткат"
auto() {
  local name="$1" fault="$2" expected="$3" before
  world
  tweak "s['faults'].update($fault)"
  before="$(snapshot)"
  run --soak-seconds 0
  assert "автооткат $name: код $expected (получен $CODE)" "[[ $CODE == $expected ]]"
  [[ $CODE == "$expected" ]] || tail -n 20 <<<"$OUTPUT"
  if [[ "$expected" == 1 ]]; then
    assert "автооткат $name: дерево как до патча" "[[ \"\$(snapshot)\" == \"\$before\" ]]"
    assert "автооткат $name: прежний guard, nginx его видит" \
      "[[ \$(query \"s['containers']['pii-guard']['image'] + str(s['nginx_ip'] ==
          s['containers']['pii-guard']['ip'])\") == img-oldTrue ]]"
    assert "автооткат $name: сообщение об откате" "grep -q 'откат выполнен' <<<\"\$OUTPUT\""
  else
    assert "автооткат $name: названы бэкап и ручное вмешательство" \
      "grep -q 'ОТКАТ НЕ УДАЛСЯ. Бэкап: ' <<<\"\$OUTPUT\""
  fi
}
auto "compose up" "{'up_fail': True}" 1
auto "новый unhealthy" "{'new_unhealthy': True}" 1
auto "другой статус пробы с токенами" "{'late_token': '422'}" 1
auto "другая версия после замены" "{'late_version': '1.2.0'}" 1
auto "другой набор слов после замены" "{'late_words': True}" 1
auto "ошибки в журнале" "{'log_errors': True}" 1
auto "перезапуски" "{'restarts': 2}" 1
auto "задеты другие службы" "{'touch_others': True}" 1
auto "откат тоже не удался" "{'up_fail': 'always'}" 4
auto "прежний не поднимается" "{'new_unhealthy': True, 'restore_fail': True}" 4

echo "== обрыв сеанса во время выдержки"
world
before="$(snapshot)"
environment setsid bash "$PKG/update-guard.sh" --soak-seconds 20 >"$T/hup.log" 2>&1 &
job=$!
for _ in $(seq 1 100); do
  grep -q 'выдержка' "$T/hup.log" 2>/dev/null && break
  command sleep 0.1
done
group="$(ps -o pgid= -p "$(pgrep -f "$PKG/update-guard.sh" | head -n 1)" | tr -d ' ')"
kill -HUP -- "-$group"
for _ in $(seq 1 100); do
  grep -qE 'откат выполнен|ОТКАТ НЕ УДАЛСЯ' "$T/hup.log" && break
  command sleep 0.1
done
wait "$job" 2>/dev/null || true
command sleep 1
assert "HUP: откат выполнен" "grep -q 'откат выполнен' \"$T/hup.log\""
assert "HUP: дерево как до патча" "[[ \"\$(snapshot)\" == \"\$before\" ]]"

echo "--- итог: проверок $((PASS + FAIL)), провалов $FAIL"
((FAIL == 0))
