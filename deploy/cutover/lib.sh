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
# которых здесь нет (например, заглушка шлюза стенда), идут перед app.
SERVICE_ORDER=(postgres pseudonymizer embeddings documents gateway-mtls indexer
  docker-socket-proxy alloy sandbox speech mask)
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
