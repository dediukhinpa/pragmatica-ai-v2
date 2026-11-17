#!/usr/bin/env bash
# Общие функции пакета переключения боя на v2: cutover.sh и rollback.sh. Подключается через source,
# сам ничего не выполняет и set -e не ставит (это делает вызывающий скрипт).
#
# Что здесь: настройка (CUTOVER_*), журнал и проверки, обёртки над docker compose для нового (v2)
# и старого деревьев, состояние хода (state.env), разбор подтверждения подписей, ожидание health,
# проба /ready. Значения секретов в журнал не пишутся: всё, что попадает в журнал, проходит через
# cut_redact (значения из списка секретов заменяются на «***»).

# ---------------------------------------------------------------------------------------------
# Константы
# ---------------------------------------------------------------------------------------------
# Коды выхода cutover.sh и rollback.sh.
EXIT_OK=0
EXIT_FAILED=1       # сбой хода; выполнен откат на прежний стек (или откат не требовался)
EXIT_USAGE=2        # неверный вызов
EXIT_REFUSED=3      # отказ по предусловиям: бой не тронут
EXIT_STUCK=4        # сбой и откат тоже не удался: нужно ручное вмешательство

# Переменные, без которых штатный backup.sh не работает (имена, не значения). ДОЛЖЕН совпадать с
# BACKUP_CONFIG_VARS в deploy/scripts/backup-lib.sh старого репозитория (там же код выхода 3
# «не настроено»): пустая любая - бэкап не настроен.
BACKUP_CONFIG_VARS=(BACKUP_AGE_RECIPIENT BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET
  BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY)
# Размеры.
MIB=1048576
KIB_PER_MIB=1024
# Ожидания.
HEALTH_WAIT_S=${CUTOVER_HEALTH_WAIT_S:-300}
READY_WAIT_S=${CUTOVER_READY_WAIT_S:-240}
POLL_S=${CUTOVER_POLL_S:-3}
# Сколько байт секрета считать значимым для замены в журнале (короткие значения не маскируем:
# иначе заменялись бы случайные подстроки).
MIN_SECRET_LEN=8
# Образы в lock: ключ BAI_IMAGE_<ИМЯ>, значение <репозиторий>@sha256:<64 hex>.
LOCK_IMAGE_RE='^BAI_IMAGE_[A-Z0-9_]+=[^@[:space:]]+@sha256:[0-9a-f]{64}$'
# Ключи боевого .env, которые перекрыли бы образы lock (так образ мимо подписи попал бы в стек).
# POSTGRES_IMAGE/NGINX_IMAGE сюда не входят: они есть в боевом .env, но база v2 их не читает
# (образы только из images.lock), а prepare_tree снимает их из .env выкатки (env-drop.txt).
LOCK_KEYS_RE='^(BAI_IMAGE_[A-Z0-9_]+|BAI_VERSION)$'
# Порядок старта сервисов v2: по зависимостям compose (indexer после postgres, documents,
# embeddings; app после postgres, pseudonymizer, gateway-mtls). app всегда последний, сервисы,
# которых здесь нет (например, заглушка шлюза стенда), идут перед app. mask (платформа 1.1.3,
# базовый стек без профиля) - клиенты app и indexer, в compose зависимости от него нет, поэтому
# он стоит ДО indexer: индексатор не должен стартовать, пока mask не поднят.
SERVICE_ORDER=(postgres pseudonymizer embeddings documents mask gateway-mtls indexer
  docker-socket-proxy alloy sandbox speech)
SERVICE_LAST="app"
# Сервис миграций (профиль tools) не входит в стек.
MIGRATE_SERVICE="migrate"
# Проба /ready: ядро слушает только loopback контейнера, поэтому ходим из одноразового контейнера
# в сетевом пространстве app.
READY_JS="try {
  const r = await fetch('http://127.0.0.1:8088/ready');
  console.log(r.status + ' ' + (await r.text()));
  process.exit(r.ok ? 0 : 1);
} catch (e) { console.log('app недоступен: ' + e.message); process.exit(1); }"
# Контейнер для пробы без сети и с малой памятью.
ONESHOT_MEM=128m
# Платформа 1.1.3: сервис mask входит в базовый стек, его образ и токен обязательны.
LOCK_MASK_KEY="BAI_IMAGE_MASK"
LOCK_MASK_RE='^BAI_IMAGE_MASK=[^@[:space:]]+@sha256:[0-9a-f]{64}$'
MASK_TOKEN_KEY="MASK_TOKEN"
# Размер токена в байтах (в окружении - hex вдвое длиннее): как у gen-secrets.sh платформы.
MASK_TOKEN_BYTES=32
# Токен, созданный cutover.sh, лежит отдельным файлом в дереве выкатки (600) и идёт в окружении
# compose после secrets.env; в secrets.env боя он переносится только после успешного хода.
MASK_TOKEN_FILE_NAME="secrets.mask.env"
# Лимит памяти mask в базовом стеке (МиБ), как mem_limit в compose.base.yml платформы 1.1.3.
MASK_MEM_LIMIT_MIB=1536
# Проба mask: loopback его контейнера, путь /health открыт без токена.
MASK_HEALTH_JS="try {
  const r = await fetch('http://127.0.0.1:8320/health');
  console.log(r.status + ' ' + (await r.text()));
  process.exit(r.ok ? 0 : 1);
} catch (e) { console.log('mask недоступен: ' + e.message); process.exit(1); }"

# ---------------------------------------------------------------------------------------------
# Настройка
# ---------------------------------------------------------------------------------------------
# cut_load_config <файл>: строки CUTOVER_*=значение; переменные окружения вызова сильнее файла.
cut_load_config() {
  local line name value
  [[ -f "$1" ]] || { echo "нет файла настройки $1" >&2; return 2; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^(CUTOVER_[A-Z0-9_]+)=(.*)$ ]] || continue
    name="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    [[ -n "${!name:-}" ]] || printf -v "$name" '%s' "$value"
  done <"$1"
}

# cut_defaults: умолчания боя; вызывается после чтения файла настройки.
cut_defaults() {
  CUTOVER_PROJECT="${CUTOVER_PROJECT:-pragmatika}"
  CUTOVER_OLD_DIR="${CUTOVER_OLD_DIR:-/opt/pragmatika}"
  CUTOVER_OLD_COMPOSE="${CUTOVER_OLD_COMPOSE:-$CUTOVER_OLD_DIR/deploy/docker-compose.yml}"
  CUTOVER_ENV_FILE="${CUTOVER_ENV_FILE:-$CUTOVER_OLD_DIR/deploy/.env}"
  CUTOVER_BACKUP_SCRIPT="${CUTOVER_BACKUP_SCRIPT:-$CUTOVER_OLD_DIR/deploy/scripts/backup.sh}"
  CUTOVER_NEW_DIR="${CUTOVER_NEW_DIR:-/opt/pragmatika-v2}"
  CUTOVER_HOME="${CUTOVER_HOME:-$HOME/.pragmatika-cutover}"
  CUTOVER_BACKUP_ROOT="${CUTOVER_BACKUP_ROOT:-$HOME/backups}"
  CUTOVER_OUT_DIR="${CUTOVER_OUT_DIR:-$HOME}"
  CUTOVER_EXPECT_BOTS="${CUTOVER_EXPECT_BOTS:-4}"
  CUTOVER_PG_CONTAINER="${CUTOVER_PG_CONTAINER:-${CUTOVER_PROJECT}-postgres-1}"
  CUTOVER_PSEUDO_CONTAINER="${CUTOVER_PSEUDO_CONTAINER:-${CUTOVER_PROJECT}-pseudonymizer-1}"
  CUTOVER_APP_CONTAINER="${CUTOVER_APP_CONTAINER:-${CUTOVER_PROJECT}-app-1}"
  CUTOVER_PSEUDO_VOLUME="${CUTOVER_PSEUDO_VOLUME:-${CUTOVER_PROJECT}_pseudonymizer-data}"
  # Дополнительные compose-файлы и env-файл поверх боевых: нужны только стендам проверки пакета
  # (заглушка шлюза, снятые каналы); на бою не задаются.
  CUTOVER_EXTRA_COMPOSE="${CUTOVER_EXTRA_COMPOSE:-}"
  CUTOVER_EXTRA_ENV="${CUTOVER_EXTRA_ENV:-}"
  CUTOVER_OLD_EXTRA_COMPOSE="${CUTOVER_OLD_EXTRA_COMPOSE:-}"
  CUTOVER_EXPECTED_HOST_DIRS="${CUTOVER_EXPECTED_HOST_DIRS:-}"
  CUTOVER_COSIGN="${CUTOVER_COSIGN:-cosign}"
  # Минимальные запасы: память МиБ (доступная), диск МиБ сверх расчёта.
  CUTOVER_MIN_AVAILABLE_MIB="${CUTOVER_MIN_AVAILABLE_MIB:-2048}"
  # Добавка к порогу памяти на сервис mask (платформа 1.1.3), если он входит в запускаемый стек;
  # 0 - не добавлять (решение владельца).
  CUTOVER_MASK_MEM_MIB="${CUTOVER_MASK_MEM_MIB:-$MASK_MEM_LIMIT_MIB}"
  CUTOVER_MIN_DISK_MIB="${CUTOVER_MIN_DISK_MIB:-4096}"
  # Необязательный адрес Alertmanager (GET /api/v2/alerts): если задан, активные алерты считаются.
  CUTOVER_ALERTS_URL="${CUTOVER_ALERTS_URL:-}"
}

# ---------------------------------------------------------------------------------------------
# Журнал и проверки
# ---------------------------------------------------------------------------------------------
# cut_init_run <каталог запуска>: создаёт каталоги и файлы журнала.
cut_init_run() {
  RUN_DIR="$1"
  RES="$RUN_DIR/results"
  WORK="$RUN_DIR/work"
  mkdir -p "$RES" "$WORK"
  LOG_FILE="$RES/cutover.log"
  CHECKS_FILE="$RES/checks.tsv"
  STATE_FILE="$RUN_DIR/state.env"
  SECRETS_LIST="$RUN_DIR/secrets.list"
  touch "$LOG_FILE" "$CHECKS_FILE" "$STATE_FILE" "$SECRETS_LIST"
  chmod 600 "$SECRETS_LIST" "$STATE_FILE"
}

# cut_redact: фильтр stdin -> stdout, значения секретов заменяются на «***».
cut_redact() {
  if [[ -s "${SECRETS_LIST:-/dev/null}" ]]; then
    python3 -I -c '
import sys
secrets = [s.rstrip("\n") for s in open(sys.argv[1], encoding="utf-8", errors="replace")]
secrets = sorted({s for s in secrets if len(s) >= int(sys.argv[2])}, key=len, reverse=True)
for line in sys.stdin:
    for s in secrets:
        line = line.replace(s, "***")
    sys.stdout.write(line)' "$SECRETS_LIST" "$MIN_SECRET_LEN"
  else
    cat
  fi
}

log() { printf '%s %s\n' "$(date -u +%T)" "$*" | cut_redact | tee -a "$LOG_FILE"; }

# check <имя> <ok|warn|fail> <описание без секретов и данных>
check() {
  printf '%s\t%s\t%s\n' "$1" "$2" "${*:3}" | cut_redact >>"$CHECKS_FILE"
  log "проверка $1: $2 - ${*:3}"
}

# Текущая фаза хода (для журнала и состояния).
PHASE="старт"
phase() { PHASE="$1"; state_set PHASE_TITLE "$1"; log "=== $1"; }

# state_set <КЛЮЧ> <значение>: запись в state.env (последняя запись ключа главная).
state_set() { printf '%s=%s\n' "$1" "$2" >>"$STATE_FILE"; }
# state_get <КЛЮЧ>: последнее значение ключа; пусто, если нет.
state_get() { grep -E "^$1=" "$STATE_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }

# ---------------------------------------------------------------------------------------------
# Чтение env и lock
# ---------------------------------------------------------------------------------------------
# env_value <файл> <ключ>: последнее значение ключа без экспорта (кавычки и комментарий сняты).
env_value() {
  [[ -f "$1" ]] || return 0
  python3 -I - "$1" "$2" <<'PY'
import re, sys
value = ""
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    if "=" in line and line.split("=", 1)[0].strip() == sys.argv[2]:
        raw = line.split("=", 1)[1].lstrip()
        if raw[:1] in "'\"" and raw[:1] and raw[0] in raw[1:]:
            value = raw[1:].split(raw[0], 1)[0]
        else:
            value = re.split(r"\s#", raw, maxsplit=1)[0].strip()
print(value, end="")
PY
}

# lock_value <файл lock> <ключ>
lock_value() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2-; }
# env_key_state <файл> <ключ>: absent (файла или ключа нет), empty (ключ без значения) или set.
# Значение не печатается: подходит для секретов.
env_key_state() {
  [[ -f "$1" ]] || { echo absent; return 0; }
  grep -qE "^[[:space:]]*$2=" "$1" || { echo absent; return 0; }
  if [[ -n "$(env_value "$1" "$2")" ]]; then echo set; else echo empty; fi
}

# lock_images <файл lock>: строки «КЛЮЧ ссылка» по порядку файла.
lock_images() { grep -E '^BAI_IMAGE_' "$1" | sed 's/=/ /'; }

# cut_lock_format <файл>: 0, если lock в формате платформы (только образы по digest и версия).
cut_lock_format() {
  local line n=0 version=0 keys=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" =~ ^BAI_VERSION=[^[:space:]]+$ ]]; then version=$((version + 1)); continue; fi
    if [[ "$line" =~ $LOCK_IMAGE_RE ]]; then
      n=$((n + 1))
      if [[ " $keys " == *" ${line%%=*} "* ]]; then return 1; fi
      keys+=" ${line%%=*}"
      continue
    fi
    return 1
  done <"$1"
  ((version == 1 && n > 0))
}

# cut_lock_has_mask <файл>: 0, если в lock есть образ mask по digest (платформа 1.1.3: без него
# compose не стартует, а подпись образа проверять нечем).
cut_lock_has_mask() { grep -qE "$LOCK_MASK_RE" "$1"; }

# ---------------------------------------------------------------------------------------------
# docker compose: новое (v2) и старое деревья
# ---------------------------------------------------------------------------------------------
# Профили боя: из COMPOSE_PROFILES боевого .env, явными ключами --profile (результат не зависит
# от того, читает ли compose эту переменную из --env-file).
cut_profile_args() {
  local profiles p
  profiles="$(env_value "$CUTOVER_ENV_FILE" COMPOSE_PROFILES)"
  PROFILE_ARGS=()
  for p in ${profiles//,/ }; do PROFILE_ARGS+=(--profile "$p"); done
}

# Список env-файлов нового стека: lock первым, .env вторым, секреты последними (как у старого dc).
cut_new_env_args() {
  NEW_ENV_ARGS=(--env-file "$CUTOVER_NEW_DIR/deploy/images.lock"
    --env-file "$CUTOVER_NEW_DIR/deploy/.env")
  [[ ! -f "$CUTOVER_NEW_DIR/deploy/secrets.env" ]] \
    || NEW_ENV_ARGS+=(--env-file "$CUTOVER_NEW_DIR/deploy/secrets.env")
  # Токен mask, созданный выкаткой: после secrets.env, чтобы перекрыть пустую строку ключа.
  [[ ! -f "$CUTOVER_NEW_DIR/deploy/$MASK_TOKEN_FILE_NAME" ]] \
    || NEW_ENV_ARGS+=(--env-file "$CUTOVER_NEW_DIR/deploy/$MASK_TOKEN_FILE_NAME")
  [[ -z "$CUTOVER_EXTRA_ENV" ]] || NEW_ENV_ARGS+=(--env-file "$CUTOVER_EXTRA_ENV")
}

# dc_new <аргументы compose>: стек v2, имя проекта прежнее.
dc_new() {
  local files=(-f "$CUTOVER_NEW_DIR/deploy/compose.yml") f
  for f in $CUTOVER_EXTRA_COMPOSE; do files+=(-f "$f"); done
  cut_new_env_args
  cut_profile_args
  docker compose -p "$CUTOVER_PROJECT" "${NEW_ENV_ARGS[@]}" "${files[@]}" "${PROFILE_ARGS[@]}" "$@"
}

# dc_old <аргументы compose>: прежний стек (как deploy/scripts/dc.sh: .env, затем secrets.env).
dc_old() {
  local secrets_dir args
  secrets_dir="${CUTOVER_SECRETS_DIR:-$(env_value "$CUTOVER_ENV_FILE" SECRETS_DIR)}"
  secrets_dir="${secrets_dir:-/etc/pragmatika/secrets}"
  args=(--env-file "$CUTOVER_ENV_FILE")
  [[ ! -f "$secrets_dir/secrets.env" ]] || args+=(--env-file "$secrets_dir/secrets.env")
  local files=(-f "$CUTOVER_OLD_COMPOSE") f
  for f in $CUTOVER_OLD_EXTRA_COMPOSE; do files+=(-f "$f"); done
  docker compose -p "$CUTOVER_PROJECT" "${args[@]}" "${files[@]}" "$@"
}

# ---------------------------------------------------------------------------------------------
# Контейнеры и готовность
# ---------------------------------------------------------------------------------------------
HEALTH_FORMAT='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'

# project_containers: имена всех контейнеров проекта (включая остановленные), по алфавиту.
project_containers() {
  docker ps -a --filter "label=com.docker.compose.project=$CUTOVER_PROJECT" \
    --format '{{.Names}}' | sort
}

# wait_healthy <контейнер> <секунд>: healthy либо (без healthcheck) running; 1 - не дождались.
wait_healthy() {
  local name="$1" limit="$2" waited=0 state
  while ((waited < limit)); do
    state="$(docker inspect -f "$HEALTH_FORMAT" "$name" 2>/dev/null || echo отсутствует)"
    case "$state" in
      healthy | running) return 0 ;;
      exited | dead | отсутствует) return 1 ;;
    esac
    sleep "$POLL_S"
    waited=$((waited + POLL_S))
  done
  return 1
}

# mask_in_stack: 0, если mask входит в запускаемый стек (полный стек боя или он назван явно в
# CUTOVER_SERVICES урезанного стенда).
mask_in_stack() { [[ -z "${CUTOVER_SERVICES:-}" || " $CUTOVER_SERVICES " == *" mask "* ]]; }

# cut_wait_mask_ready <контейнер mask> <образ с bun> <секунд>: в compose у mask нет healthcheck,
# и wait_healthy счёл бы его готовым сразу после старта. Поэтому ждём ответ 200 на /health из
# одноразового контейнера в сетевом пространстве mask; упавший контейнер - отказ сразу.
cut_wait_mask_ready() {
  local name="$1" image="$2" limit="$3" waited=0 state out
  while ((waited < limit)); do
    state="$(docker inspect -f "$HEALTH_FORMAT" "$name" 2>/dev/null || echo отсутствует)"
    case "$state" in exited | dead | отсутствует) return 1 ;; esac
    out="$(docker run --rm --network "container:$name" --memory "$ONESHOT_MEM" \
      --entrypoint bun "$image" -e "$MASK_HEALTH_JS" 2>&1 || true)"
    [[ "$out" == 200* ]] && return 0
    sleep "$POLL_S"
    waited=$((waited + POLL_S))
  done
  return 1
}

# ready_probe <контейнер app>: ответ /ready (код и тело) через одноразовый контейнер в сети app.
# Образ берётся у самого контейнера app (в нём есть bun, и старый, и новый).
ready_probe() {
  local image
  image="$(docker inspect -f '{{.Image}}' "$1" 2>/dev/null)" \
    || { echo "нет контейнера $1"; return 1; }
  docker run --rm --network "container:$1" --memory "$ONESHOT_MEM" --entrypoint bun \
    "$image" -e "$READY_JS" 2>&1
}

# ready_wait <контейнер app> <секунд>: ждёт 200 на /ready; тело последнего ответа в READY_BODY.
READY_BODY=""
ready_wait() {
  local waited=0
  while ((waited < $2)); do
    if READY_BODY="$(ready_probe "$1")" && [[ "$READY_BODY" == 200* ]]; then return 0; fi
    sleep "$POLL_S"
    waited=$((waited + POLL_S))
  done
  return 1
}

# ready_bots <тело /ready>: число готовых ботов из JSON; 0, если поля нет.
ready_bots() {
  python3 -I -c '
import json, sys
body = sys.argv[1].split(" ", 1)[-1]
try:
    print(int(json.loads(body).get("bots", {}).get("ready", 0)))
except ValueError:
    print(0)' "$1"
}

# mail_summary <тело /ready>: «состояние/ящиков/authBlocked» из блока mail; «-», если блока нет.
mail_summary() {
  python3 -I -c '
import json, sys
body = sys.argv[1].split(" ", 1)[-1]
try:
    mail = json.loads(body).get("mail")
except ValueError:
    mail = None
if not isinstance(mail, dict):
    print("-")
else:
    parts = [mail.get(k, "?") for k in ("state", "mailboxes", "authBlocked")]
    print("/".join(str(p) for p in parts))
' "$1"
}

# ---------------------------------------------------------------------------------------------
# Подтверждение подписей (вывод verify-signatures.sh)
# ---------------------------------------------------------------------------------------------
# cut_check_signatures_file <файл подтверждения> <lock> <pubkey|"">: 0 - файл подтверждает ВСЕ
# образы lock с теми же digest; сообщение о причине - в stdout.
cut_check_signatures_file() {
  python3 -I - "$1" "$2" "${3:-}" <<'PY'
import hashlib, re, sys

sig_path, lock_path, pub_path = sys.argv[1:4]
fields: dict[str, str] = {}
images: dict[str, tuple[str, str]] = {}
for raw in open(sig_path, encoding="utf-8", errors="replace"):
    line = raw.rstrip("\n")
    if not line or line.startswith("#"):
        continue
    if line.startswith("image\t"):
        parts = line.split("\t")
        if len(parts) != 4:
            print("строка image неверного формата"); sys.exit(1)
        images[parts[1]] = (parts[2], parts[3])
    elif "=" in line:
        key, value = line.split("=", 1)
        fields[key] = value
lock_text = open(lock_path, "rb").read()
want = {}
for line in lock_text.decode("utf-8").splitlines():
    if re.match(r"^BAI_IMAGE_[A-Z0-9_]+=", line):
        key, value = line.split("=", 1)
        want[key] = value
if fields.get("result") != "OK":
    print("в файле подтверждения result не OK"); sys.exit(1)
if fields.get("lock_sha256") != hashlib.sha256(lock_text).hexdigest():
    print("sha256 images.lock не совпал с указанным в подтверждении"); sys.exit(1)
pub_sha = hashlib.sha256(open(pub_path, "rb").read()).hexdigest() if pub_path else ""
if pub_path and fields.get("pubkey_sha256") != pub_sha:
    print("sha256 cosign.pub не совпал с указанным в подтверждении"); sys.exit(1)
for key, ref in want.items():
    got = images.get(key)
    if got is None:
        print(f"образа {key} нет в подтверждении"); sys.exit(1)
    if got[0] != ref:
        print(f"digest {key} в подтверждении отличается от images.lock"); sys.exit(1)
    if got[1] != "OK":
        print(f"подпись {key}: {got[1]}"); sys.exit(1)
extra = sorted(set(images) - set(want))
if extra:
    print("в подтверждении лишние образы: " + " ".join(extra)); sys.exit(1)
print(f"подтверждены подписи {len(want)} образов")
PY
}

# ---------------------------------------------------------------------------------------------
# MASK_TOKEN (платформа 1.1.3): без него compose не стартует. Значение нигде не печатается:
# ни в журнал, ни в состояние, ни в проверки; оно попадает только в файлы с правами 600 и в
# список секретов для маскирования журнала и проверки архива результатов.
# ---------------------------------------------------------------------------------------------
# cut_mask_token_present: 0, если в окружении compose дерева выкатки итоговое значение MASK_TOKEN
# непустое. Файлы читаются в порядке --env-file (позже заданный перекрывает, в том числе пустым).
cut_mask_token_present() {
  local file state result=absent
  cut_new_env_args
  for file in "${NEW_ENV_ARGS[@]}"; do
    [[ "$file" == --env-file ]] && continue
    state="$(env_key_state "$file" "$MASK_TOKEN_KEY")"
    [[ "$state" == absent ]] || result="$state"
  done
  [[ "$result" == set ]]
}

# cut_ensure_mask_token: токен есть - ничего не меняется; нет или пуст - создаётся случайный
# (hex, как у gen-secrets.sh) в файле выкатки secrets.mask.env (600). Файлы боя не трогаются.
cut_ensure_mask_token() {
  local side="$CUTOVER_NEW_DIR/deploy/$MASK_TOKEN_FILE_NAME" token
  if cut_mask_token_present; then
    if [[ -f "$side" ]]; then
      env_value "$side" "$MASK_TOKEN_KEY" >>"$SECRETS_LIST"
      printf '\n' >>"$SECRETS_LIST"
      state_set MASK_TOKEN_SOURCE "токен выкатки (прежний запуск), $MASK_TOKEN_FILE_NAME"
      check "MASK_TOKEN" ok "используется токен выкатки прежнего запуска; значение не печатается"
    else
      state_set MASK_TOKEN_SOURCE "задан в окружении v2 (secrets.env или .env)"
      check "MASK_TOKEN" ok "уже задан в окружении v2, не меняется"
    fi
    return 0
  fi
  token="$(python3 -I -c 'import secrets, sys; print(secrets.token_hex(int(sys.argv[1])))' \
    "$MASK_TOKEN_BYTES")"
  (umask 077 && printf '%s=%s\n' "$MASK_TOKEN_KEY" "$token" >"$side")
  chmod 600 "$side"
  printf '%s\n' "$token" >>"$SECRETS_LIST"
  unset token
  state_set MASK_TOKEN_SOURCE "сгенерирован, $MASK_TOKEN_FILE_NAME (600)"
  check "MASK_TOKEN" ok "не был задан: сгенерирован в $MASK_TOKEN_FILE_NAME дерева v2 (600)," \
    "значение не печатается; в secrets.env боя переносится после успешного хода"
}

# cut_persist_mask_token: после успешного хода токен выкатки переносится в secrets.env боя (как
# делает `bai update`: пустая строка ключа заменяется, иначе ключ дописывается; права и владелец
# файла сохраняются), файл выкатки убирается. Заданное в secrets.env другое значение не
# перезаписывается. Любая неудача - предупреждение, не сбой: токен остаётся в файле выкатки.
cut_persist_mask_token() {
  local side="$CUTOVER_NEW_DIR/deploy/$MASK_TOKEN_FILE_NAME" target token state
  target="$CUTOVER_SECRETS_DIR/secrets.env"
  [[ -f "$side" ]] || return 0
  token="$(env_value "$side" "$MASK_TOKEN_KEY")"
  [[ -n "$token" ]] || return 0
  state="$(env_key_state "$target" "$MASK_TOKEN_KEY")"
  if [[ "$state" == set ]]; then
    if [[ "$(env_value "$target" "$MASK_TOKEN_KEY")" == "$token" ]]; then
      rm -f -- "${side:?}"
      check "MASK_TOKEN в secrets.env" ok "уже записан, файл выкатки убран"
    else
      check "MASK_TOKEN в secrets.env" warn "в $target задан другой токен: не перезаписан;" \
        "в дереве v2 действует токен из $MASK_TOKEN_FILE_NAME (выровнять вручную)"
    fi
    return 0
  fi
  if [[ ! -f "$target" || ! -w "$target" ]]; then
    check "MASK_TOKEN в secrets.env" warn "$target не на запись: токен остаётся в" \
      "$side (600); перенесите строку MASK_TOKEN в secrets.env владельцем файла (CHECKLIST.md)"
    return 0
  fi
  MASK_TOKEN_NEW="$token" python3 -I - "$target" "$MASK_TOKEN_KEY" <<'PY'
import os, re, sys

path, key = sys.argv[1], sys.argv[2]
token = os.environ["MASK_TOKEN_NEW"]
with open(path, encoding="utf-8", errors="surrogateescape") as src:
    lines = src.read().splitlines(keepends=True)
pattern = re.compile(r"^\s*" + re.escape(key) + "=")
out, replaced = [], False
for line in lines:
    if pattern.match(line):
        if not replaced:
            out.append(f"{key}={token}\n")
            replaced = True
        continue
    out.append(line)
if not replaced:
    if out and not out[-1].endswith("\n"):
        out[-1] += "\n"
    out.append(f"{key}={token}\n")
# Запись поверх (не замена файла): права и владелец остаются прежними.
with open(path, "w", encoding="utf-8", errors="surrogateescape") as dst:
    dst.write("".join(out))
PY
  unset token
  if [[ "$(env_key_state "$target" "$MASK_TOKEN_KEY")" == set ]]; then
    rm -f -- "${side:?}"
    state_set MASK_TOKEN_PERSISTED 1
    check "MASK_TOKEN в secrets.env" ok "записан в secrets.env боя (значение не печатается)"
  else
    check "MASK_TOKEN в secrets.env" warn "запись в $target не подтвердилась: токен остаётся в" \
      "$side (600)"
  fi
}

# ---------------------------------------------------------------------------------------------
# Проверка маршрутов (урок G6/G7: на бою у documents не было проектных /docx/*, а предпроверка
# молчала). Инструменты и манифест ищет вызывающий скрипт: ROUTES_TOOLS_DIR (check-routes.sh,
# check-image-routes.sh, route-flags.tsv) и ROUTES_MANIFEST (routes.tsv).
# ---------------------------------------------------------------------------------------------
# Коды check-image-routes.sh: 1 - маршрутов нет, 3 - проверку выполнить не удалось.
ROUTES_EXIT_MISSING=1
# Сервисы, которые check-routes.sh проверяет в стеке (имена compose).
ROUTES_STACK_SERVICES=(documents pseudonymizer embeddings mask speech)

# cut_documents_flags: строки ИМЯ=ЗНАЧЕНИЕ флагов маршрутов documents, как их видит compose v2
# (после подстановки умолчаний и .env). Имена берутся из route-flags.tsv; прочее окружение сервиса
# не читается и не печатается. Без вывода (compose недоступен) флаги считаются неизвестными.
cut_documents_flags() {
  dc_new --profile tools config --format json 2>/dev/null | python3 -I -c '
import json, sys
names = set()
for line in open(sys.argv[1], encoding="utf-8"):
    cols = line.rstrip("\n").split("\t")
    if len(cols) == 3 and not line.startswith("#") and cols[0] == "documents":
        names.add(cols[2])
try:
    env = json.load(sys.stdin)["services"]["documents"].get("environment", {})
except (ValueError, KeyError, TypeError):
    sys.exit(0)
for name in sorted(names):
    if name in env:
        value = env[name]
        print(name + "=" + ("" if value is None else str(value)))
' "$ROUTES_TOOLS_DIR/route-flags.tsv"
}

# cut_check_routes_image <образ documents> <файл вывода>: маршруты манифеста есть в образе.
# Код check-image-routes.sh (0 - есть, 1 - нет, 3 - не удалось проверить).
cut_check_routes_image() {
  local flags=() line
  while IFS= read -r line; do
    [[ -z "$line" ]] || flags+=(--flag "$line")
  done < <(cut_documents_flags)
  bash "$ROUTES_TOOLS_DIR/check-image-routes.sh" --image "$1" --manifest "$ROUTES_MANIFEST" \
    --flags-file "$ROUTES_TOOLS_DIR/route-flags.tsv" ${flags[@]+"${flags[@]}"} >"$2" 2>&1
}

# cut_check_routes_stack <файл вывода>: пробы маршрутов в сети запущенного стека (только чтение).
# Сервисы вне CUTOVER_SERVICES (урезанный стенд) пропускаются явно.
cut_check_routes_stack() {
  local skip=() svc
  if [[ -n "${CUTOVER_SERVICES:-}" ]]; then
    for svc in "${ROUTES_STACK_SERVICES[@]}"; do
      [[ " $CUTOVER_SERVICES " == *" $svc "* ]] || skip+=(--skip-service "$svc")
    done
  fi
  bash "$ROUTES_TOOLS_DIR/check-routes.sh" --stack --project "$CUTOVER_PROJECT" \
    --app-container "$CUTOVER_APP_CONTAINER" --manifest "$ROUTES_MANIFEST" \
    --flags-file "$ROUTES_TOOLS_DIR/route-flags.tsv" ${skip[@]+"${skip[@]}"} >"$1" 2>&1
}
