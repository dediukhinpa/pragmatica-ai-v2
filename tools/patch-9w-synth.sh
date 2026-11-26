#!/usr/bin/env bash
# Проверка патч-пакета G9w на синтетическом «бое» (локальный стенд). Настоящие образы postgres,
# pseudonymizer, mask, documents и app: прежние из lock боя после G9q4 (этап 9v), новые из lock
# этапа pd. Настоящие compose-файлы проекта из HEAD, копия PLATFORM-VERSION 1.1.11 из коммита
# P9W_PLATFORM_REV, синтетический .env. Вместо шлюза моделей - заглушка model-stub, каналов нет,
# выхода наружу у app нет, порты на хост не публикуются. Настоящий бой не затрагивается:
# compose-проект pragmatika-p9w, контейнеры, сети и тома с меткой bai.stage=pd, пути стенда под
# $SYNTH. Все значения в проверках выдуманы.
#
# Тяжёлый прогон: скрипт сам перезапускается под `flock` на heavy.lock (P9W_NO_LOCK=1 - без
# блокировки), перед началом ждёт, пока в res.state нет PAUSE и ALERT, и пишет замер памяти и
# диска в $OUT/resources-before.txt.
#
# Пакет собирает tools/build-patch-9w-package.sh из ЗАКОММИЧЕННОГО дерева P9W_PROJECT_DIR (по
# умолчанию этот репозиторий). Пока файлы патча не закоммичены, укажите P9W_PROJECT_DIR на
# репозиторий, в HEAD которого они есть.
#
# Использование:
#   bash tools/patch-9w-synth.sh [--steps "список"] [--help]
# Шаги (по умолчанию все по порядку):
#   prepare    предусловия, дерево стенда «после G9q4», сборка пакета, прежний стек (postgres,
#              миграции, pseudonymizer, mask, documents, model-stub, app); прежним образом
#              записаны токены (ФИО, телефон, адрес) и снята нагрузка для пика памяти
#   preflight  patch.sh --preflight-only: код 0, контейнеры и дерево не изменились
#   refuse     правленый compose.project.yml боя: код 3 с названием файла
#   apply      patch.sh: код 0, четыре новых образа, labops-pii 1.3.0, прежние токены раскрываются,
#              новые записываются, повтор адреса в старом треде, пара «фамилия имя»
#   rollback   patch.sh --rollback: дерево побайтно прежнее, прежние образы, прежний образ
#              раскрывает и старые, и новые токены и пишет дальше
#   reapply    повторный patch.sh после отката: код 0, все токены раскрываются
#   repeat     patch.sh по уже применённому: код 3, ничего не изменилось
#   restore    patch.sh --rollback --restore-pseudonymizer-volume: том из бэкапа reapply; токены до
#              бэкапа раскрываются, записанные после него - нет
#   broken     во время выдержки перезапускается documents: автооткат, код 1
#   cleanup    убрать стенд (контейнеры, сети, тома проекта и каталог $SYNTH)
# Результаты: $OUT/summary.txt, $OUT/steps.tsv, $OUT/downtime.tsv, $OUT/pseudo-memory.txt,
# $OUT/tokens.tsv, журнал стенда $OUT/stand.log, журналы патча $OUT/<шаг>.log.
# Коды выхода: 0 - все проверки ok; 1 - есть FAIL; 2 - неверный вызов или нет ресурсов.
# Окружение: STAGE_DIR, OUT, SYNTH, LOCK, LOCK_OLD, SIGNATURES, PLATFORM_LOCK, P9W_PROJECT_DIR,
# P9W_PLATFORM_REV (по умолчанию 6693b42), HEAVY_LOCK, RES_STATE.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPORTS="${HOME}/reports"
STAGE="${STAGE_DIR:-$REPORTS/pii-130/stage-pd}"
OUT="${OUT:-$STAGE/synth}"
SYNTH="${SYNTH:-$STAGE/tmp/synth-9w}"
LOCK="${LOCK:-$STAGE/images.lock}"
LOCK_OLD="${LOCK_OLD:-$REPORTS/business-ai-modular/stage-9v/images.lock}"
SIGNATURES="${SIGNATURES:-$STAGE/signatures.txt}"
PLATFORM_LOCK="${PLATFORM_LOCK:-$REPORTS/business-ai-modular/release/images-1.1.12.lock}"
PROJECT_DIR="${P9W_PROJECT_DIR:-$ROOT}"
PLATFORM_REV="${P9W_PLATFORM_REV:-6693b42}"
HEAVY_LOCK="${HEAVY_LOCK:-$REPORTS/business-ai-modular/heavy.lock}"
RES_STATE="${RES_STATE:-$REPORTS/pii-130/res.state}"

PROJECT="pragmatika-p9w"
STAGE_LABEL="bai.stage=pd"
LIVE="$SYNTH/opt/pragmatika-v2"
DEPLOY="$LIVE/deploy"
PKG="$SYNTH/pkg"
TOKENS="$SYNTH/tokens"
STANDIN="$ROOT/deploy/patch-9w/standin/patch-9w-stand.compose.yml"
STUB_DIR="$ROOT/deploy/cutover/standin"
PSEUDO="$PROJECT-pseudonymizer-1"
APP="$PROJECT-app-1"
DOCS="$PROJECT-documents-1"
PATCHED_SERVICES=(pseudonymizer mask documents app)
ALL_SERVICES=(postgres pseudonymizer mask documents model-stub app)
# Тома, которые пишет только app (в его образе этих путей проекта нет, том создаётся root).
# documents-exchange не трогается: владельца задаёт образ documents, app ходит в него по группе.
CHOWN_VOLUMES=(intake-data file-spool)
declare -A LOCK_KEY=([pseudonymizer]=BAI_IMAGE_PSEUDONYMIZER [mask]=BAI_IMAGE_MASK
  [documents]=BAI_IMAGE_DOCUMENTS [app]=BAI_IMAGE_APP [postgres]=BAI_IMAGE_POSTGRES)
PII_OLD="1.1.4"
PII_NEW="1.3.0"
STEPS_DEFAULT="prepare preflight refuse apply rollback reapply repeat restore broken cleanup"
STEPS="$STEPS_DEFAULT"

LOCK_WAIT_S=7200
RES_WAIT_S=300
RES_ALERT_LIMIT_S=1800
MIN_AVAILABLE_MIB=3072
MIN_DISK_MIB=4096
SOAK_S=20
SOAK_POLL_S=5
READY_WAIT_S=120
HEALTH_WAIT_S=240
STACK_WAIT_S=300
POLL_S=2
SAMPLE_S=1
EVENTS_SETTLE_S=2
BROKEN_WAIT_S=600
LOAD_CHARS=30000
LOAD_PARALLEL=2
MIB=1048576

# Синтетические тексты. Все имена, телефоны и адреса выдуманы.
OLD_THREAD="stand-old-thread"
NEW_THREAD="stand-new-thread"
BACK_THREAD="stand-back-thread"
LATE_THREAD="stand-late-thread"
OLD_TEXT="Клиент Иван Петрович Сидоров, тел. +7 916 123-45-67,"
OLD_TEXT+=" адрес: г. Тверь, ул. Лесная, д. 5, кв. 7."
REPEAT_TEXT="Повторно: Иван Петрович Сидоров, тел. +7 916 123-45-67,"
REPEAT_TEXT+=" адрес: г. Тверь, ул. Лесная, д. 5, кв. 7."
NEW_TEXT="Менеджер Ольга Игоревна Кузнецова, тел. +7 903 765-43-21,"
NEW_TEXT+=" адрес: г. Казань, ул. Садовая, д. 12."
BACK_TEXT="Ещё контакт: Анна Сергеевна Белова, тел. +7 921 000-11-22,"
BACK_TEXT+=" адрес: г. Псков, ул. Речная, д. 3."
LATE_TEXT="Бухгалтер Пётр Андреевич Орлов, тел. +7 905 111-22-33,"
LATE_TEXT+=" адрес: г. Рязань, ул. Полевая, д. 8."
PAIR_TEXT="Позвоните Смирнов Кирилл завтра."
PAIR_SURNAME="Смирнов"

# Запрос к псевдонимизатору изнутри его контейнера: текст на stdin, ответный текст на stdout.
PII_CLIENT='
import json, os, sys, time, urllib.error, urllib.request
route, thread = sys.argv[1], sys.argv[2]
body = json.dumps({"thread_id": thread, "text": sys.stdin.read()}).encode()
headers = {"Content-Type": "application/json",
           "Authorization": "Bearer " + os.environ["PSEUDONYMIZER_API_TOKEN"]}
request = urllib.request.Request("http://127.0.0.1:8300" + route, body, headers)
for attempt in range(30):
    try:
        with urllib.request.urlopen(request, timeout=300) as reply:
            sys.stdout.write(json.load(reply)["text"])
        break
    except urllib.error.HTTPError as error:
        if error.code != 503 or attempt == 29:
            raise
        time.sleep(2)
'
# Нагрузка для пика памяти: большой синтетический текст с разными ФИО, телефонами и адресами.
PII_LOAD='
import itertools, sys
names = ("Сидоров Иван Петрович", "Кузнецова Ольга Игоревна", "Белова Анна Сергеевна",
         "Орлов Пётр Андреевич", "Смирнов Кирилл", "Иванов Сергей")
streets = ("Лесная", "Садовая", "Речная", "Полевая", "Школьная")
limit, shift = int(sys.argv[1]), int(sys.argv[2])
parts, size = [], 0
for i in itertools.count(shift):
    line = ("Клиент %s, тел. +7 9%02d %03d-%02d-%02d, адрес: г. Тверь, ул. %s, д. %d. "
            "Просит прислать счёт на кабель и крепёж.\n") % (
        names[i % len(names)], i % 100, i % 1000, i % 90, i % 80, streets[i % len(streets)],
        i % 200 + 1)
    if size + len(line) > limit:
        break
    parts.append(line)
    size += len(line)
sys.stdout.write("".join(parts))
'
APP_READY_JS="const r = await fetch('http://127.0.0.1:8088/ready'); console.log(r.status);"

FAILS=0
SAMPLER_PID=""
EVENTS_PID=""
BROKEN_PID=""

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
while (($#)); do
  case "$1" in
    --steps) STEPS="${2:?--steps список}"; shift ;;
    --help | -h) usage; exit 0 ;;
    *) echo "неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
  shift
done
for step in $STEPS; do
  [[ " $STEPS_DEFAULT " == *" $step "* ]] || { echo "неизвестный шаг: $step" >&2; exit 2; }
done
mkdir -p "$OUT"

# Тяжёлый прогон под общей блокировкой.
if [[ "${P9W_NO_LOCK:-0}" != 1 && "${P9W_LOCKED:-0}" != 1 ]]; then
  command -v flock >/dev/null || { echo "нет flock (P9W_NO_LOCK=1 - без блокировки)" >&2; exit 2; }
  echo "[patch-9w-synth] жду блокировку $HEAVY_LOCK (до ${LOCK_WAIT_S} с)"
  P9W_LOCKED=1 exec flock -w "$LOCK_WAIT_S" "$HEAVY_LOCK" bash "${BASH_SOURCE[0]}" \
    --steps "$STEPS"
fi

STEPS_FILE="$OUT/steps.tsv"
log() { echo "[patch-9w-synth] $(date -u +%T) $*"; }
result() { # result <проверка> <ok|FAIL> <пояснение>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$STEPS_FILE"
  log "$1: $2 - $3"
  [[ "$2" == ok ]] || FAILS=$((FAILS + 1))
}
expect() { # expect <проверка> <пояснение ok> <пояснение FAIL> <команда...>
  local name="$1" good="$2" bad="$3"
  shift 3
  if "$@"; then result "$name" ok "$good"; else result "$name" FAIL "$bad"; fi
}

wait_resources() {
  local waited=0 state
  while [[ -f "$RES_STATE" ]] && state="$(head -n 1 "$RES_STATE")" \
    && [[ "$state" == *PAUSE* || "$state" == *ALERT* ]]; do
    [[ "$state" != *ALERT* || "$waited" -lt "$RES_ALERT_LIMIT_S" ]] \
      || { log "ALERT дольше ${RES_ALERT_LIMIT_S} с: стоп"; return 1; }
    log "ресурсы: $state, жду ${RES_WAIT_S} с"
    sleep "$RES_WAIT_S"
    waited=$((waited + RES_WAIT_S))
  done
}

lock_ref() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2-; }
dcs() {
  docker compose -p "$PROJECT" --env-file "$DEPLOY/images.lock" --env-file "$DEPLOY/.env" \
    -f "$DEPLOY/compose.yml" -f "$STANDIN" "$@"
}
project_ids() { docker ps -aq --filter "label=com.docker.compose.project=$PROJECT"; }
health_of() {
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$PROJECT-$1-1" 2>/dev/null || echo отсутствует
}
started_all() {
  local svc
  for svc in "${ALL_SERVICES[@]}"; do
    echo "$svc $(docker inspect -f '{{.Id}} {{.State.StartedAt}}' "$PROJECT-$svc-1" 2>&1)"
  done
}
tree_hash() { (cd "$DEPLOY" && find . -type f -print0 | sort -z | xargs -0 sha256sum); }
tree_hash_other() {
  tree_hash | grep -vE ' \./(images\.lock|platform/PLATFORM-VERSION)$'
}
app_ready() { [[ "$(docker exec "$APP" bun -e "$APP_READY_JS" 2>/dev/null)" == 200 ]]; }
pii_version() {
  docker exec "$PSEUDO" python -c 'import labops_pii; print(labops_pii.__version__)' 2>/dev/null
}

wait_stack() { # wait_stack: все сервисы стенда healthy; печатает отстающие при неудаче
  local started=$SECONDS svc pending
  while :; do
    pending=""
    for svc in "${ALL_SERVICES[@]}"; do
      [[ "$(health_of "$svc")" == healthy ]] || pending+=" $svc=$(health_of "$svc")"
    done
    [[ -n "$pending" ]] || return 0
    ((SECONDS - started < STACK_WAIT_S)) || { log "не healthy:$pending"; return 1; }
    sleep "$POLL_S"
  done
}

check_stack() { # check_stack <шаг>: все сервисы healthy и /ready 200
  expect "$1: все сервисы healthy" "${ALL_SERVICES[*]}" "см. журнал" wait_stack
  expect "$1: /ready app" "200" "не 200" app_ready
}

check_images() { # check_images <шаг> <lock> <подпись>
  local svc ref got bad=""
  for svc in "${PATCHED_SERVICES[@]}"; do
    ref="$(lock_ref "$2" "${LOCK_KEY[$svc]}")"
    got="$(docker inspect -f '{{.Image}}' "$PROJECT-$svc-1" 2>/dev/null || true)"
    [[ -n "$got" && "$got" == "$(docker image inspect -f '{{.Id}}' "$ref")" ]] || bad+=" $svc"
  done
  [[ -z "$bad" ]] && result "$1: образы четырёх сервисов - $3" ok "${PATCHED_SERVICES[*]}" \
    || result "$1: образы четырёх сервисов - $3" FAIL "не те:$bad"
}

check_version() { # check_version <шаг> <версия>
  local got
  got="$(pii_version || true)"
  expect "$1: labops-pii в контейнере" "$got" "${got:-?}, ожидается $2" test "$got" = "$2"
}

check_tree_old() { # check_tree_old <шаг>: дерево побайтно как до патча
  expect "$1: дерево боя побайтно как до патча" "все файлы" "отличается" \
    cmp -s "$OUT/tree-before.sha" <(tree_hash)
}
check_tree_new() { # check_tree_new <шаг>: lock и PLATFORM-VERSION из пакета, прочее прежнее
  expect "$1: images.lock равен пакетному" "да" "нет" cmp -s "$PKG/images.lock" \
    "$DEPLOY/images.lock"
  expect "$1: PLATFORM-VERSION равен пакетному" "да" "нет" cmp -s \
    "$PKG/deploy/platform/PLATFORM-VERSION" "$DEPLOY/platform/PLATFORM-VERSION"
  expect "$1: прочие файлы дерева (в том числе .env) прежние" "да" "отличаются" \
    cmp -s "$OUT/tree-before-other.sha" <(tree_hash_other)
}

# --- совместимость тома --------------------------------------------------------------------------
pii() { printf '%s' "$3" | docker exec -i "$PSEUDO" python -c "$PII_CLIENT" "$1" "$2"; }
tokens_of() { grep -oE '\[[A-Z_]+_[0-9]+\]' <<<"$1" | tr '\n' ' '; }

# write_tokens <шаг> <метка> <тред> <текст>: маскирование и сразу восстановление; сохраняется.
write_tokens() {
  local step="$1" label="$2" thread="$3" text="$4" masked restored
  masked="$(pii /pseudonymize "$thread" "$text" 2>>"$OUT/pii-client.log")" || masked=""
  restored="$(pii /restore "$thread" "$masked" 2>>"$OUT/pii-client.log")" || restored=""
  printf '%s' "$masked" >"$TOKENS/$label.masked"
  printf '%s' "$text" >"$TOKENS/$label.orig"
  printf '%s' "$thread" >"$TOKENS/$label.thread"
  printf '%s\t%s\t%s\t%s\t%s\n' "$step" "$label" "$(pii_version || echo '?')" "$thread" \
    "$masked" >>"$OUT/tokens.tsv"
  if [[ "$masked" == *"[PERSON_"* && "$masked" == *"[PHONE_"* && "$masked" == *"[ADDRESS_"* \
    && "$restored" == "$text" ]]; then
    result "$step: запись токенов «$label»" ok "$(tokens_of "$masked")восстановление сразу"
  else
    result "$step: запись токенов «$label»" FAIL "маска: ${masked:0:160}"
  fi
}

# check_restore <шаг> <метка...>: ранее записанные токены раскрываются в исходный текст.
check_restore() {
  local step="$1" label restored
  shift
  for label in "$@"; do
    restored="$(pii /restore "$(<"$TOKENS/$label.thread")" "$(<"$TOKENS/$label.masked")" \
      2>>"$OUT/pii-client.log")" || restored=""
    expect "$step: раскрытие токенов «$label»" "исходный текст ($(pii_version || echo '?'))" \
      "получено: ${restored:0:160}" test "$restored" = "$(<"$TOKENS/$label.orig")"
  done
}

# check_lost <шаг> <метка>: токены, записанные после восстановленного бэкапа, не раскрываются.
check_lost() {
  local restored
  restored="$(pii /restore "$(<"$TOKENS/$2.thread")" "$(<"$TOKENS/$2.masked")" \
    2>>"$OUT/pii-client.log")" || restored="ошибка запроса"
  expect "$1: токены «$2», записанные после бэкапа, пропали (ожидаемо)" \
    "ответ: ${restored:0:120}" "раскрылись: том не из бэкапа" \
    test "$restored" != "$(<"$TOKENS/$2.orig")"
}

# check_pair <шаг> <yes|no>: пара «фамилия имя» маскируется только новой версией.
check_pair() {
  local masked got=no
  masked="$(pii /pseudonymize "stand-pair-$1" "$PAIR_TEXT" 2>>"$OUT/pii-client.log")" \
    || masked="ошибка запроса"
  [[ "$masked" != *"$PAIR_SURNAME"* && "$masked" == *"[PERSON_"* ]] && got=yes
  expect "$1: пара «фамилия имя» замаскирована: $2" "$masked" "$masked" test "$got" = "$2"
}

load_pseudo() { # load_pseudo <шаг>: параллельные большие тексты, время; для пика памяти
  local i pids=() started failed=0
  started="$(date +%s.%N)"
  for ((i = 0; i < LOAD_PARALLEL; i++)); do
    (
      text="$(docker exec "$PSEUDO" python -c "$PII_LOAD" "$LOAD_CHARS" $((i * 1000)))"
      pii /pseudonymize "stand-load-$1-$i" "$text" >"$SYNTH/load-$1-$i.out"
    ) 2>>"$OUT/pii-client.log" &
    pids+=($!)
  done
  for i in "${pids[@]}"; do wait "$i" || failed=1; done
  local spent
  spent="$(awk -v a="$started" -v b="$(date +%s.%N)" 'BEGIN { printf "%.1f", b - a }')"
  expect "$1: нагрузка $LOAD_PARALLEL x $LOAD_CHARS знаков" \
    "$(pii_version || echo '?'): все ответы за ${spent} с" "ошибка запроса" test "$failed" = 0
}

# --- замеры --------------------------------------------------------------------------------------
# Пик памяти pseudonymizer по cgroup каждого его контейнера (замер раз в секунду).
sample_memory() {
  local id dir seen=""
  while :; do
    id="$(docker ps -q --no-trunc --filter "label=com.docker.compose.project=$PROJECT" \
      --filter "label=com.docker.compose.service=pseudonymizer" 2>/dev/null | head -n 1)" || id=""
    dir="/sys/fs/cgroup/system.slice/docker-$id.scope"
    if [[ -n "$id" && -r "$dir/memory.peak" ]]; then
      if [[ "$seen" != *"$id"* ]]; then
        seen+=" $id"
        printf '%s\t%s\n' "$id" "$(docker inspect -f '{{.Config.Image}}' "$id" 2>/dev/null)" \
          >>"$OUT/pseudo-ids.tsv"
      fi
      printf '%s\t%s\t%s\t%s\n' "$id" "$(cat "$dir/memory.peak" 2>/dev/null)" \
        "$(cat "$dir/memory.current" 2>/dev/null)" \
        "$(awk '$1 == "anon" { print $2 }' "$dir/memory.stat" 2>/dev/null)" \
        >>"$OUT/pseudo-mem.tsv"
    fi
    sleep "$SAMPLE_S"
  done
}
start_sampler() {
  [[ -z "$SAMPLER_PID" ]] || return 0
  sample_memory &
  SAMPLER_PID=$!
}
start_events() { # start_events <фаза>
  docker events --filter "label=com.docker.compose.project=$PROJECT" --filter type=container \
    --filter event=kill --filter event=die --filter event=start --filter event=health_status \
    --format '{{.TimeNano}}	{{.Action}}	{{index .Actor.Attributes "com.docker.compose.service"}}' \
    >"$OUT/events-$1.tsv" 2>/dev/null &
  EVENTS_PID=$!
}
stop_events() { # stop_events <фаза>: останавливает запись и считает простой по сервисам
  sleep "$EVENTS_SETTLE_S"
  kill "$EVENTS_PID" 2>/dev/null || true
  wait "$EVENTS_PID" 2>/dev/null || true
  EVENTS_PID=""
  python3 -I - "$1" "$OUT/events-$1.tsv" "${PATCHED_SERVICES[@]}" >>"$OUT/downtime.tsv" <<'PY'
import sys

phase, path, services = sys.argv[1], sys.argv[2], sys.argv[3:]
events = []
for line in open(path, encoding="utf-8"):
    parts = line.rstrip("\n").split("\t")
    if len(parts) == 3:
        events.append((int(parts[0]) / 1e9, parts[1], parts[2]))
spans = []
for service in services:
    own = [(t, a) for t, a, s in events if s == service]
    stops = [t for t, a in own if a in ("kill", "die")]
    if not stops:
        print(f"{phase}\t{service}\t-\tне останавливался")
        continue
    last_start = max((t for t, a in own if a == "start"), default=None)
    healthy = next((t for t, a in own if last_start is not None and t >= last_start
                    and a == "health_status: healthy"), None)
    if healthy is None:
        print(f"{phase}\t{service}\t-\tнет события healthy")
        continue
    spans.append((stops[0], healthy))
    print(f"{phase}\t{service}\t{healthy - stops[0]:.1f}\tот stop до healthy, с")
if spans:
    total = max(b for _, b in spans) - min(a for a, _ in spans)
    print(f"{phase}\tвсе вместе\t{total:.1f}\tот первого stop до последнего healthy, с")
PY
}

# --- пакет и patch.sh ----------------------------------------------------------------------------
patch_run() { # patch_run <шаг> [аргументы patch.sh]: код в RC, журнал $OUT/<шаг>.log
  local step="$1"
  shift
  RC=0
  env CUTOVER_PROJECT="$PROJECT" CUTOVER_NEW_DIR="$LIVE" CUTOVER_ENV_FILE="$DEPLOY/.env" \
    CUTOVER_EXTRA_COMPOSE="$STANDIN" CUTOVER_SERVICES="${ALL_SERVICES[*]}" \
    CUTOVER_HOME="$SYNTH/home" CUTOVER_BACKUP_ROOT="$SYNTH/backups" \
    CUTOVER_OUT_DIR="$OUT/archives" CUTOVER_COSIGN=/nonexistent-cosign CUTOVER_EXPECT_BOTS=0 \
    CUTOVER_READY_WAIT_S="$READY_WAIT_S" CUTOVER_HEALTH_WAIT_S="$HEALTH_WAIT_S" \
    PATCH9W_SOAK_POLL_S="$SOAK_POLL_S" \
    bash "$PKG/patch.sh" --soak-seconds "$SOAK_S" "$@" >"$OUT/$step.log" 2>&1 </dev/null || RC=$?
}
expect_rc() { # expect_rc <шаг> <код>
  expect "$1: код выхода patch.sh" "$RC" "$RC, ожидается $2 ($1.log)" test "$RC" = "$2"
}
backup_dir_of_latest() { sed -n 's/^BACKUP_DIR=//p' "$SYNTH/home/patch-9w-latest/state.env"; }

# --- дерево стенда --------------------------------------------------------------------------------
random_token() { python3 -I -c 'import secrets; print(secrets.token_hex(24))'; }
fernet_key() {
  python3 -I -c 'import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())'
}

make_tree() {
  local etc="$SYNTH/etc" data="$SYNTH/data"
  (
    # Файлы, которые читают контейнеры под своими uid, должны быть читаемыми.
    umask 022
    mkdir -p "$LIVE" "$etc/config" "$etc/access" "$etc/mail" "$etc/mtls" "$data/documents" \
      "$data/templates" "$data/local" "$data/models" "$TOKENS"
    git -C "$ROOT" archive --format=tar HEAD deploy/compose.yml deploy/compat.env \
      deploy/compose.project.yml deploy/platform db/app db/legacy-map.tsv | tar -x -C "$LIVE"
    git -C "$ROOT" show "$PLATFORM_REV:deploy/platform/PLATFORM-VERSION" \
      >"$DEPLOY/platform/PLATFORM-VERSION"
    git -C "$ROOT" show HEAD:config/access-policy.example.json >"$etc/access/access-policy.json"
    printf '# синтетический список контактов стенда\n' >"$etc/contacts.txt"
    git -C "$ROOT" show HEAD:deploy/.env.example >"$DEPLOY/.env"
  )
  cp "$LOCK_OLD" "$DEPLOY/images.lock"
  chmod 644 "$DEPLOY/images.lock"
  local -A values=(
    [DATA_DIR]="$data" [MODELS_DIR]="$data/models" [DOCUMENTS_HOST_DIR]="$data/documents"
    [TEMPLATES_HOST_DIR]="$data/templates" [LOCAL_HOST_DIR]="$data/local"
    [BAI_CONFIG_HOST_DIR]="$etc/config" [ACCESS_POLICY_HOST_DIR]="$etc/access"
    [ACCESS_POLICY_FILE]=/etc/pragmatika/access/access-policy.json
    [MAIL_HOST_DIR]="$etc/mail" [MTLS_DIR]="$etc/mtls"
    [PSEUDONYMIZER_CONTACTS_HOST_FILE]="$etc/contacts.txt"
    [POSTGRES_PASSWORD]="$(random_token)" [PSEUDONYMIZER_API_TOKEN]="$(random_token)"
    [PSEUDONYMIZER_KEY]="$(fernet_key)" [MASK_TOKEN]="$(random_token)"
    [LITELLM_API_KEY]=stub [GATEWAY_HOST]=gateway.invalid [GATEWAY_TLS_NAME]=gateway.invalid
    [WEB_SEARCH_PROVIDER]=disabled [WEB_FETCH_ENABLED]=false
    [IMAGE_TEXT_OCR_IN_DOCUMENTS]=true [OWNER_THREAD_ID]=synth-owner [BAI_LOG_TAG]="$PROJECT"
    [DOCUMENTS_MODEL]=stub-model [ORDER_CALC_MODEL]=stub-model [PRICES_MODEL]=stub-model
    [SITE_EXPORT_MODEL]=stub-model [OWN_COMPANY_NAMES]=Синтетика-Стенд
    [STANDIN_DIR]="$STUB_DIR" [STUB_IMAGE]="$(lock_ref "$LOCK_OLD" BAI_IMAGE_APP)")
  local name
  for name in "${!values[@]}"; do
    sed -i "/^$name=/d" "$DEPLOY/.env"
    printf '%s=%s\n' "$name" "${values[$name]}" >>"$DEPLOY/.env"
  done
  chmod 600 "$DEPLOY/.env"
  date -u +%FT%TZ >"$DEPLOY/.cutover-deployed"
}

# Настройки postgres стенда легче боевых: общий хост. Файл надстройки лежит в $SYNTH.
POSTGRES_LIGHT='services:
  postgres:
    shm_size: !override 128m
    command: !override [postgres, -c, shared_buffers=64MB, -c, max_connections=50]
'

# ---------------------------------------------------------------------------------------------
step_prepare() {
  local missing=() f ref svc
  for f in "$LOCK" "$LOCK_OLD" "$SIGNATURES" "$PLATFORM_LOCK" "$STANDIN" \
    "$STUB_DIR/model-stub.ts"; do
    [[ -f "$f" ]] || missing+=("$f")
  done
  ((${#missing[@]} == 0)) \
    || { result "prepare: подготовленные файлы" FAIL "нет: ${missing[*]}"; return 1; }
  command -v docker >/dev/null || { result "prepare: docker" FAIL "нет docker"; return 1; }
  for f in "$LOCK_OLD" "$LOCK"; do
    for svc in "${!LOCK_KEY[@]}"; do
      ref="$(lock_ref "$f" "${LOCK_KEY[$svc]}")"
      docker image inspect "$ref" >/dev/null 2>&1 \
        || { result "prepare: образ на хосте" FAIL "нет ${ref##*/}"; return 1; }
    done
  done
  result "prepare: образы обоих lock на хосте" ok "${!LOCK_KEY[*]}"
  [[ -z "$(project_ids)" ]] \
    || { result "prepare: чистое начало" FAIL "уже есть контейнеры проекта $PROJECT"; return 1; }
  rm -rf "${SYNTH:?}"
  rm -rf "${OUT:?}/archives"
  mkdir -p "$SYNTH" "$OUT/archives"
  : >"$OUT/tokens.tsv"
  : >"$OUT/downtime.tsv"
  : >"$OUT/pseudo-mem.tsv"
  : >"$OUT/pseudo-ids.tsv"
  make_tree || { result "prepare: дерево стенда" FAIL "не собрано"; return 1; }
  result "prepare: дерево стенда" ok "состояние после G9q4, .env синтетический"
  BAI_PROJECT_DIR="$PROJECT_DIR" bash "$HERE/build-patch-9w-package.sh" --out "$PKG" \
    --lock "$LOCK" --prev-lock "$LOCK_OLD" --platform-lock "$PLATFORM_LOCK" \
    --signatures "$SIGNATURES" >"$OUT/build.log" 2>&1 \
    || { result "prepare: сборка пакета" FAIL "см. build.log"; return 1; }
  (cd "$PKG" && sha256sum -c --quiet MANIFEST.sha256) \
    || { result "prepare: манифест пакета" FAIL "не сходится"; return 1; }
  result "prepare: пакет собран" ok "манифест сходится, lock и подписи этапа pd"

  # Прежний стек. Настройки postgres облегчены (общий хост); сам patch.sh postgres не трогает.
  printf '%s' "$POSTGRES_LIGHT" >"$SYNTH/postgres-light.yml"
  dcs -f "$SYNTH/postgres-light.yml" up -d --no-deps postgres >>"$OUT/prepare.log" 2>&1 \
    || { result "prepare: postgres" FAIL "compose up (prepare.log)"; return 1; }
  dcs -f "$SYNTH/postgres-light.yml" --profile tools run --rm -T migrate \
    >>"$OUT/prepare.log" 2>&1 \
    || { result "prepare: миграции" FAIL "migrate (prepare.log)"; return 1; }
  result "prepare: миграции" ok \
    "$(grep -E 'Применено новых миграций' "$OUT/prepare.log" | tail -n 1)"
  # documents создаётся первым: пустой documents-exchange получает владельца из его образа.
  dcs create --no-recreate documents app >>"$OUT/prepare.log" 2>&1 \
    || { result "prepare: compose create" FAIL "см. prepare.log"; return 1; }
  # Тома боя принадлежат uid app (на бою их когда-то создал app).
  local app_image app_uid vol
  app_image="$(lock_ref "$LOCK_OLD" BAI_IMAGE_APP)"
  app_uid="$(docker run --rm --network none --entrypoint id "$app_image" -u)"
  for vol in "${CHOWN_VOLUMES[@]}"; do
    docker run --rm --network none --user 0 --entrypoint chown -v "${PROJECT}_${vol}:/v" \
      "$(lock_ref "$LOCK_OLD" BAI_IMAGE_POSTGRES)" -R "$app_uid:$app_uid" /v \
      >>"$OUT/prepare.log" 2>&1 || { result "prepare: тома" FAIL "chown $vol"; return 1; }
  done
  dcs up -d --no-deps pseudonymizer mask documents model-stub app >>"$OUT/prepare.log" 2>&1 \
    || { result "prepare: прежний стек" FAIL "compose up (prepare.log)"; return 1; }
  start_sampler
  wait_stack || { result "prepare: прежний стек healthy" FAIL "см. журнал"; return 1; }
  result "prepare: прежний стек healthy" ok "${ALL_SERVICES[*]}"
  expect "prepare: /ready прежнего app" "200" "не 200" app_ready
  local labeled
  labeled="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=$STAGE_LABEL" | wc -l)"
  expect "prepare: контейнеры с меткой $STAGE_LABEL" "$labeled" "$labeled" \
    test "$labeled" = "${#ALL_SERVICES[@]}"
  check_images prepare "$LOCK_OLD" "прежние"
  check_version prepare "$PII_OLD"
  check_pair prepare no
  write_tokens prepare old "$OLD_THREAD" "$OLD_TEXT"
  load_pseudo prepare
  tree_hash >"$OUT/tree-before.sha"
  tree_hash_other >"$OUT/tree-before-other.sha"
}

step_preflight() {
  started_all >"$OUT/started-before.txt"
  patch_run preflight --preflight-only
  expect_rc preflight 0
  expect "preflight: контейнеры не пересоздавались" "StartedAt прежние" "изменились" \
    cmp -s "$OUT/started-before.txt" <(started_all)
  check_tree_old preflight
  check_restore preflight old
}

step_refuse() {
  started_all >"$OUT/started-before.txt"
  cp -p "$DEPLOY/compose.project.yml" "$SYNTH/compose.project.keep"
  printf '# ручная правка стенда\n' >>"$DEPLOY/compose.project.yml"
  patch_run refuse --preflight-only
  cp -p "$SYNTH/compose.project.keep" "$DEPLOY/compose.project.yml"
  expect_rc refuse 3
  expect "refuse: отказ называет изменённый файл" "compose.project.yml" "нет в журнале" \
    grep -q 'отличаются от эталона пакета: compose.project.yml' "$OUT/refuse.log"
  expect "refuse: контейнеры не пересоздавались" "StartedAt прежние" "изменились" \
    cmp -s "$OUT/started-before.txt" <(started_all)
  check_tree_old refuse
}

step_apply() {
  start_events apply
  patch_run apply
  expect_rc apply 0
  check_stack apply
  stop_events apply
  check_images apply "$LOCK" "новые"
  check_version apply "$PII_NEW"
  check_tree_new apply
  expect "apply: проба labops-pii в журнале патча" "пройдена" "нет записи" \
    grep -q "version=$PII_NEW masked=yes restored=yes" "$OUT/apply.log"
  local backup
  backup="$(backup_dir_of_latest)"
  expect "apply: архив тома в бэкапе (600)" \
    "$(du -h "$backup/pseudonymizer-data.tgz" 2>/dev/null | cut -f1)" "нет или права не 600" \
    test "$(stat -c %a "$backup/pseudonymizer-data.tgz" 2>/dev/null)" = 600
  # Совместимость тома: старые токены раскрывает новый образ, новые пишутся.
  check_restore apply old
  write_tokens apply new "$NEW_THREAD" "$NEW_TEXT"
  write_tokens apply repeat "$OLD_THREAD" "$REPEAT_TEXT"
  local before after
  before="$(grep -oE '\[ADDRESS_[0-9]+\]' "$TOKENS/old.masked" | tail -n 1)"
  after="$(grep -oE '\[ADDRESS_[0-9]+\]' "$TOKENS/repeat.masked" | tail -n 1)"
  local num="${before//[^0-9]/}"
  expect "apply: повтор адреса в старом треде получил новый токен" "$before -> $after" \
    "$before -> $after, ожидался [ADDRESS_$((num + 1))]" test "$after" = "[ADDRESS_$((num + 1))]"
  result "apply: токены ФИО и телефона при повторе (наблюдение)" ok \
    "было: $(tokens_of "$(<"$TOKENS/old.masked")")| повтор: $(tokens_of \
      "$(<"$TOKENS/repeat.masked")")"
  check_restore apply old repeat
  check_pair apply yes
  load_pseudo apply
}

step_rollback() {
  start_events rollback
  patch_run rollback --rollback
  expect_rc rollback 0
  check_stack rollback
  stop_events rollback
  check_images rollback "$LOCK_OLD" "прежние"
  check_version rollback "$PII_OLD"
  check_tree_old rollback
  # Прежний образ на томе, в который писал новый: старые и новые токены и запись дальше.
  check_restore rollback old new repeat
  write_tokens rollback back "$OLD_THREAD" "$BACK_TEXT"
  check_restore rollback old repeat back
  check_pair rollback no
}

step_reapply() {
  start_events reapply
  patch_run reapply
  expect_rc reapply 0
  check_stack reapply
  stop_events reapply
  check_images reapply "$LOCK" "новые"
  check_version reapply "$PII_NEW"
  check_tree_new reapply
  check_restore reapply old new repeat back
  write_tokens reapply late "$LATE_THREAD" "$LATE_TEXT"
}

step_repeat() {
  started_all >"$OUT/started-before.txt"
  patch_run repeat
  expect_rc repeat 3
  expect "repeat: отказ «уже применён»" "есть в журнале" "нет записи" \
    grep -q 'патч G9w уже применён' "$OUT/repeat.log"
  expect "repeat: контейнеры не пересоздавались" "StartedAt прежние" "изменились" \
    cmp -s "$OUT/started-before.txt" <(started_all)
}

step_restore() {
  start_events restore
  patch_run restore --rollback --restore-pseudonymizer-volume
  expect_rc restore 0
  check_stack restore
  stop_events restore
  check_images restore "$LOCK_OLD" "прежние"
  check_tree_old restore
  check_restore restore old new repeat back
  check_lost restore late
  local backup safety
  backup="$(backup_dir_of_latest)"
  safety="$(find "$backup" -maxdepth 1 -name 'pseudonymizer-data-before-restore-*.tgz' | head -1)"
  expect "restore: копия тома до восстановления сохранена" "${safety##*/}" "нет" test -n "$safety"
}

# Чужой сбой во время выдержки: перезапуск documents.
step_broken() {
  start_events broken
  patch_run broken &
  BROKEN_PID=$!
  local started=$SECONDS seen=0
  while ((SECONDS - started < BROKEN_WAIT_S)) && kill -0 "$BROKEN_PID" 2>/dev/null; do
    if grep -q "выдержка $SOAK_S с (проверка" "$OUT/broken.log" 2>/dev/null; then
      docker restart -t 1 "$DOCS" >/dev/null && seen=1
      break
    fi
    sleep 1
  done
  # Код patch.sh из фонового запуска: patch_run кладёт его в RC своей подоболочки.
  wait "$BROKEN_PID" || true
  BROKEN_PID=""
  expect "broken: documents перезапущен во время выдержки" "да" "выдержка не дождалась" \
    test "$seen" = 1
  expect "broken: автоматический откат, код 1" "есть в журнале" "нет записи" \
    grep -q 'ЗАВЕРШЕНО С КОДОМ 1\.' "$OUT/broken.log"
  expect "broken: в журнале запуск автоотката" "есть" "нет" \
    grep -q 'запускаю автоматический откат' "$OUT/broken.log"
  check_stack broken
  stop_events broken
  check_images broken "$LOCK_OLD" "прежние"
  check_tree_old broken
  check_restore broken old new repeat back
}

step_cleanup() {
  [[ -z "$SAMPLER_PID" ]] || { kill "$SAMPLER_PID" 2>/dev/null || true; SAMPLER_PID=""; }
  if [[ -f "$DEPLOY/compose.yml" ]]; then
    dcs --profile tools down -v --remove-orphans -t 30 >>"$OUT/cleanup.log" 2>&1 \
      || result "cleanup: compose down" FAIL "см. cleanup.log"
  fi
  local left=""
  left+="$(project_ids)"
  left+="$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")"
  left+="$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT")"
  expect "cleanup: контейнеров, томов и сетей стенда нет" "чисто" "остались: $left" \
    test -z "$left"
  rm -rf "${SYNTH:?}"
  expect "cleanup: каталог стенда удалён" "да" "остался" test ! -e "$SYNTH"
}

summarize() {
  {
    echo "Синтетический стенд патча G9w, $(date -u +%FT%TZ)"
    echo "Шаги: $STEPS"
    echo "Проверок: $(wc -l <"$STEPS_FILE"), FAIL: $FAILS"
    echo
    echo "== Простой по сервисам (фаза, сервис, секунды; точность - период healthcheck старта)"
    [[ ! -f "$OUT/downtime.tsv" ]] || cat "$OUT/downtime.tsv"
    echo
    echo "== Память pseudonymizer по cgroup (МиБ): образ, пик cgroup, макс. anon, замеров"
    python3 -I - "$OUT/pseudo-ids.tsv" "$OUT/pseudo-mem.tsv" "$MIB" <<'PY' \
      | tee "$OUT/pseudo-memory.txt"
import pathlib, sys

ids_path, mem_path, mib = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), int(sys.argv[3])
if ids_path.is_file() and mem_path.is_file():
    images = dict(line.split("\t", 1) for line in ids_path.read_text().splitlines() if line)
    stats: dict[str, list[int]] = {}
    for line in mem_path.read_text().splitlines():
        parts = line.split("\t")
        if len(parts) != 4 or not all(p.isdigit() for p in parts[1:]):
            continue
        peak, _, anon = (int(p) for p in parts[1:])
        row = stats.setdefault(images.get(parts[0], "?").rsplit("/", 1)[-1][:40], [0, 0, 0])
        row[0], row[1], row[2] = max(row[0], peak), max(row[1], anon), row[2] + 1
    for image, (peak, anon, count) in stats.items():
        print(f"{image}\tпик {peak // mib}\tanon {anon // mib}\t{count}")
PY
    echo
    echo "== Токены (шаг, метка, версия, тред, маскированный синтетический текст)"
    [[ ! -f "$OUT/tokens.tsv" ]] || cat "$OUT/tokens.tsv"
    echo
    echo "== Проверки"
    awk -F'\t' '{ printf "%s  %s - %s\n", $2, $1, $3 }' "$STEPS_FILE"
  } >"$OUT/summary.txt"
}

on_exit() {
  local rc=$?
  trap - EXIT
  set +e
  [[ -z "$EVENTS_PID" ]] || kill "$EVENTS_PID" 2>/dev/null
  [[ -z "$SAMPLER_PID" ]] || kill "$SAMPLER_PID" 2>/dev/null
  [[ -z "$BROKEN_PID" ]] || wait "$BROKEN_PID"
  summarize
  log "итог: проверок $(wc -l <"$STEPS_FILE"), FAIL $FAILS; $OUT/summary.txt"
  exit "$rc"
}

exec > >(tee -a "$OUT/stand.log") 2>&1
log "стенд G9w: шаги: $STEPS"
{ echo "# free -m"; free -m; echo "# df -h /"; df -h /; } | tee "$OUT/resources-before.txt"
wait_resources || exit 2
if [[ " $STEPS " == *" prepare "* ]]; then
  avail="$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)"
  disk="$(df -Pm / | awk 'NR == 2 { print $4 }')"
  ((avail >= MIN_AVAILABLE_MIB && disk >= MIN_DISK_MIB)) \
    || { log "мало ресурсов: память ${avail} МиБ, диск ${disk} МиБ"; exit 2; }
  : >"$STEPS_FILE"
else
  touch "$STEPS_FILE"
  FAILS="$(awk -F'\t' '$2 != "ok"' "$STEPS_FILE" | wc -l)"
  [[ "$STEPS" == cleanup ]] || start_sampler
fi
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

for step in $STEPS; do
  log "=== шаг $step"
  if ! "step_$step"; then
    result "$step: шаг" FAIL "прерван"
    # Без подготовленного стека дальнейшие шаги бессмысленны; уборка выполняется всегда.
    [[ " $STEPS " != *" cleanup "* ]] || { log "=== шаг cleanup"; step_cleanup; }
    break
  fi
done
((FAILS == 0)) || exit 1
