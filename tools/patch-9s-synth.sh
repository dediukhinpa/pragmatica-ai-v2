#!/usr/bin/env bash
# Проверка патч-пакета G9s на синтетическом «бое» (локальный стенд): настоящие compose-файлы
# дерева v2 ПОСЛЕ патча G9r (платформа 1.1.10, lock 1.1.10-pragmatika.1, compose.project.yml без
# трёх новых переменных CHAT_ATTACHMENTS_* у app), настоящие образы app (прежний из lock этапа 9r
# и новый из lock этапа 9s); у documents вместо сервиса заглушка на bun (образ заглушки - образ с
# bun: по умолчанию прежний образ app из lock боя; он ОДИН и тот же до и после патча, потому что
# G9s documents не меняет). У app заглушка заменяет только сервер (entrypoint), образ настоящий:
# в нём работают `bun run src/chat-attachments-cli.ts ...` и пробы тома приёма. Бой
# (pragmatika-ru) не затрагивается: compose-проект pragmatika-p9s, порты 127.0.0.1 в диапазоне
# P9S_PORT_BASE..+49 (по умолчанию 21400-21449), пути стенда под $SYNTH, контейнеры стенда с
# меткой bai.stage=9s. Реальных данных нет: всё содержимое тома приёма синтетическое.
#
# Тяжёлый прогон (docker, образы): запускать под общей блокировкой heavy.lock; скрипт сам
# перезапускается под `flock` (P9S_NO_LOCK=1 - не брать блокировку, например если её уже держит
# вызывающий) и перед прогоном пишет замер `free -m` и `df -h /` в $OUT/resources-before.txt и в
# вывод.
#
# Скрипт стенд «из воздуха» не создаёт: нужны образы и lock'и. Шаг prepare проверяет
# предусловия и печатает, чего нет (lock'и, подтверждение подписей, образы на хосте, свободные
# порты); если в $SYNTH нет дерева v2, оно собирается из HEAD репозитория: compose.yml, compat.env,
# platform/compose.base.yml, platform/PLATFORM-VERSION, compose.project.yml БЕЗ трёх переменных
# CHAT_ATTACHMENTS_* (состояние «G9r применён») и синтетический .env из .env.example; затем
# поднимает documents и app «до патча» и кладёт в том приёма intake-data синтетические каталоги
# приёма прайсов (16 шестнадцатеричных знаков) с файлами.
#
# Использование:
#   bash tools/patch-9s-synth.sh [--steps список] [--help]
# Шаги (по умолчанию все по порядку):
#   prepare   предусловия, lock'и стенда и дерево, documents и app «до патча» (образы G9r), том
#             приёма смонтирован в app и заполнен синтетикой (список имён и sha256 запоминается),
#             в прежнем образе команды архива нет, подкаталога chat-attachments нет; у app
#             переменные G9r, G9q3, G9q2, G9q, G9p, G8z и G8w, НЕТ трёх новых переменных G9s
#   preflight patch.sh --preflight-only: код 0, ничего не изменилось, подкаталог не создан
#   refuse    lock боя версии 1.1.10-pragmatika.0 (имитация «патч G9r не применён»): код 3 с
#             текстом «сначала примените патч G9r»; ничего не изменилось. Отказа по флагу в .env
#             нет: явный false в .env - выключатель (сценарий offswitch)
#   apply     patch.sh: код 0; app на новом образе, documents НЕ пересоздан, images.lock и
#             compose.project.yml боя равны пакету, прочие файлы дерева (в том числе .env)
#             побайтно прежние, у app три новые переменные со значениями по умолчанию compose
#             (true, 30, 3221225472), прежние переменные и флаги G8x на месте, проба /docx/pages
#             как до патча, простой app (опрос хоста). Том приёма: каталоги приёма прайсов
#             побайтно те же (имена и sha256); chat-attachments создан с правами 700 и принадлежит
#             пользователю app; настоящий код образа: `stats` и `find` на пустом архиве работают;
#             в том вручную (docker exec от пользователя app) кладутся файл и строка индекса
#             формата index-file.ts (свежая запись и просроченная на 40 суток): `find --json`
#             видит обе, `path` отдаёт абсолютный путь, `stats` считает; `purge` с реальными
#             часами удаляет просроченную запись с файлом и оставляет свежую; в журналах и
#             результатах нет имён синтетических файлов
#   enable    выключатель enable-flags.sh из пакета: --store false: код 0, у app хранение false
#             (срок и предел прежние), пересоздан только app, запись архива видна через `find`;
#             затем enable-flags.sh --rollback: .env побайтно прежний, у app снова true
#   rollback  patch.sh --rollback по успешному запуску: дерево побайтно как до патча, app на
#             прежнем образе (команды архива в нём снова нет), documents не тронут; файлы
#             chat-attachments остаются в томе (файл и индекс те же), каталоги приёма прайсов
#             побайтно те же
#   offswitch подкаталог chat-attachments убирается, в .env боя явно CHAT_ATTACHMENTS_STORE_ENABLED
#             =false: patch.sh без отказа (код 0), .env не изменён, у app переменная false, в
#             журнале «выключено выключателем», подкаталог chat-attachments НЕ создаётся; затем
#             patch.sh --rollback и возврат .env
#   broken    во время выдержки patch.sh перезапускается documents (как чужой сбой): проверка
#             выдержки красная, автооткат (код 1), дерево побайтно как до патча, оба сервиса на
#             прежних образах, каталоги приёма прайсов побайтно те же
#   cleanup   убрать стенд (контейнеры, сети, тома проекта) и служебные списки имён
# Результаты: $OUT/steps.tsv, $OUT/summary.txt, журналы патча $OUT/<шаг>.log. Имена синтетических
# файлов нигде не печатаются: выводы команд архива разбираются в переменных, список имён лежит
# отдельно в $SYNTH/intake-state и нужен только для проверки «имён нет в журналах».
# Окружение: SYNTH (каталог стенда; дерево v2 после G9r лежит в $SYNTH/opt/pragmatika-v2/deploy),
# OUT (каталог результатов), LOCK (lock этапа 9s), LOCK_OLD (lock боя после G9r, этап 9r),
# SIGNATURES (вывод verify-signatures.sh по LOCK), STUB_IMAGE (образ с bun для заглушки documents;
# по умолчанию образ app из LOCK_OLD), RUNBOOK_FILE (необязательно), P9S_PORT_BASE (первый порт
# диапазона стенда из 50 портов; по умолчанию 21400), PATCH9S_PAGES_PROBE_STATUS и
# PATCH9S_PAGES_PROBE_ERROR (ожидаемые статус и код ошибки пробы /docx/pages, если образ
# отвечает иначе; передаются patch.sh), HEAVY_LOCK (файл блокировки), STAGE_DIR (каталог этапа).
set -euo pipefail
umask 077

# Три новые переменные app G9s (ИМЯ=умолчание compose): хранение включено по умолчанию, false в
# .env - выключатель. При смене имён или умолчаний править только эти строки.
NEW_APP_VARS=(CHAT_ATTACHMENTS_STORE_ENABLED=true CHAT_ATTACHMENTS_RETENTION_DAYS=30
  CHAT_ATTACHMENTS_MAX_BYTES=3221225472)
VAR_STORE="CHAT_ATTACHMENTS_STORE_ENABLED"
VAR_DAYS="CHAT_ATTACHMENTS_RETENTION_DAYS"
VAR_BYTES="CHAT_ATTACHMENTS_MAX_BYTES"
DEFAULT_DAYS="30"
DEFAULT_BYTES="3221225472"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPORTS="${REPORTS:-$HOME/reports/business-ai-modular}"
STAGE="${STAGE_DIR:-$REPORTS/stage-9s}"
SYNTH="${SYNTH:-$STAGE/tmp/synth}"
OUT="${OUT:-$STAGE/synth}"
LOCK="${LOCK:-$STAGE/images.lock}"
LOCK_OLD="${LOCK_OLD:-$REPORTS/stage-9r/images.lock}"
SIGNATURES="${SIGNATURES:-$STAGE/signatures.txt}"
HEAVY_LOCK="${HEAVY_LOCK:-$REPORTS/heavy.lock}"
LOCK_WAIT_S=7200
PROJECT="pragmatika-p9s"
STAGE_LABEL="bai.stage=9s"
LIVE="$SYNTH/opt/pragmatika-v2"
DEPLOY="$LIVE/deploy"
APP="$PROJECT-app-1"
DOCS="$PROJECT-documents-1"
STANDIN="$ROOT/deploy/patch-9s/standin/patch-9s-stand.compose.yml"
STAND_LOCK_OLD="$OUT/stand-old.lock"
STAND_LOCK_NEW="$OUT/stand-new.lock"
STAND_SIGNATURES="$OUT/stand-signatures.txt"
STEPS_DEFAULT="prepare preflight refuse apply enable rollback offswitch broken cleanup"
STEPS="$STEPS_DEFAULT"
# Диапазон портов стенда на 127.0.0.1 (база из P9S_PORT_BASE) и два порта, которые занимает прогон.
PORT_COUNT=50
PORT_FIRST="${P9S_PORT_BASE:-21400}"
PORT_LAST=$((PORT_FIRST + PORT_COUNT - 1))
PORT_APP="$PORT_FIRST"
PORT_DOCS=$((PORT_FIRST + 1))
SOAK_S=20
SOAK_POLL_S=5
READY_WAIT_S=120
HEALTH_WAIT_S=180
MIN_DISK_MIB=2048
EXPECT_BOTS=4
SETTLE_S=15
POLL_INTERVAL_S=0.2
POLL_INTERVAL_MS=200
HTTP_TIMEOUT_S=3
WATCH_TIMEOUT_S=300
YANDEX_CONCURRENCY_KEY="YANDEX_SEARCH_MAX_CONCURRENCY"
YANDEX_INTERVAL_KEY="YANDEX_SEARCH_MIN_INTERVAL_MS"
# Переменные app, уже стоящие на бою после G9r, G9q3, G9q2, G9q, G9p, G8z: остаются на месте,
# значения патч не меняет (только наличие).
OLD_APP_VARS=(B24_CALL_RECORDING_MAX_BYTES B24_CALL_RECORDING_TIMEOUT_MS
  PRICE_FILE_ONCE_PER_TURN_ENABLED STEP_TEXT_SEPARATE_ENABLED EMPTY_REPLY_GUARD_ENABLED
  PRICE_EDIT_DB_WRITE_ENABLED PRICE_EDIT_TEXT_BLOCKS_ENABLED PRICE_EDIT_FIRST_ENABLED
  DOCX_PAGES_ENABLED SHORTLIST_PAGING_ENABLED SUPPLIER_DISCOVERY_ENABLED)
FLAG_OFF="false"
FLAG_ON="true"
# Четыре флага G8x documents: после патча (documents не пересоздаётся) они обязаны остаться.
DOCS_FLAGS=(DOCUMENTS_EDIT_PPTX=true DOCUMENTS_EDIT_PDF=true DOCUMENTS_PPT_CONVERT=true
  DOCUMENTS_EDIT_PDF_FALLBACK_FONT=false)
PLATFORM_NOW="1.1.10"
LOCK_VERSION_FROM="1.1.10-pragmatika.1"
LOCK_VERSION_TO="1.1.10-pragmatika.2"
LOCK_VERSION_G9Q3="1.1.10-pragmatika.0"
# Ключи lock, которыми lock этапа 9s вправе отличаться от lock боя после G9r.
LOCK_DIFF_ALLOWED="BAI_IMAGE_APP BAI_VERSION"
# Проба /docx/pages (как в patch.sh): путь, тело (некорректный base64), ожидаемые статус и код
# ошибки образа documents с ручкой (G9p, у G9s documents не меняется), и до и после патча.
PAGES_ROUTE="/docx/pages"
PAGES_BODY='{"file_name":"probe.docx","content_base64":"%%%"}'
PAGES_STATUS="${PATCH9S_PAGES_PROBE_STATUS:-422}"
PAGES_ERROR="${PATCH9S_PAGES_PROBE_ERROR:-bad_request}"
FAILS=0
POLL_FLAG="$OUT/poll.flag"
NEEDED_FILES=(compose.yml compat.env .env compose.project.yml platform/compose.base.yml
  platform/PLATFORM-VERSION)
# Файлы дерева, которые собираются из HEAD, если дерева стенда нет (путь в HEAD относительно
# deploy/).
TREE_FROM_HEAD=(compose.yml compat.env compose.project.yml platform/compose.base.yml
  platform/PLATFORM-VERSION)

# Архив файлов чата и том приёма. Подкаталог архива и команда образа (путь от WORKDIR образа app,
# как у tools/chat-attachments-cli.sh).
ARCHIVE_SUB="chat-attachments"
CLI_FILE="src/chat-attachments-cli.ts"
INTAKE_ROOT_KEY="INTAKE_ROOT"
# uid пользователя app в образе (bun): владелец корня тома приёма на бою.
APP_UID=1000
INTAKE_VOLUME_SUFFIX="intake-data"
# Права подкаталога архива: только владелец (DIR_MODE образа).
ARCHIVE_MODE_WANT="700"
# Сколько суток назад «просроченная» запись (срок хранения по умолчанию 30 суток).
OLD_RECORD_AGE_DAYS=40
# Минимальная длина имени в списке для проверки журналов.
NAME_MIN_LEN=12
INTAKE_SEED_DIRS=3
INTAKE_SEED_FILES=2
MIN_INTAKE_FILES=$((INTAKE_SEED_DIRS * INTAKE_SEED_FILES))
# Служебные файлы стенда с именами синтетических файлов лежат ВНЕ $OUT (имена не должны попасть
# в результаты): список имён, список тома приёма до патча, описание кладённых записей архива.
PRIV="$SYNTH/intake-state"
NAMES_FILE="$PRIV/names.txt"
INTAKE_BEFORE="$PRIV/intake-before.list"
INTAKE_NOW="$PRIV/intake-now.list"
PLACED_FILE="$PRIV/placed.txt"
FRESH_PATH=""
FRESH_SHA=""
OLD_PATH=""
OLD_SHA=""

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
while (($#)); do
  case "$1" in
    --steps) STEPS="${2:?--steps список}"; shift ;;
    --help | -h) usage; exit 0 ;;
    *) echo "неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$PORT_FIRST" =~ ^[0-9]+$ ]] || { echo "P9S_PORT_BASE: нужно число" >&2; exit 2; }
mkdir -p "$OUT"

# Тяжёлый прогон под общей блокировкой и с замером ресурсов до начала.
if [[ "${P9S_NO_LOCK:-0}" != 1 && "${P9S_LOCKED:-0}" != 1 ]]; then
  command -v flock >/dev/null || { echo "нет flock (P9S_NO_LOCK=1 - без блокировки)" >&2; exit 2; }
  echo "[patch-9s-synth] жду блокировку $HEAVY_LOCK (до ${LOCK_WAIT_S} с)"
  P9S_LOCKED=1 exec flock -w "$LOCK_WAIT_S" "$HEAVY_LOCK" bash "${BASH_SOURCE[0]}" \
    --steps "$STEPS"
fi
{ echo "# free -m"; free -m; echo "# df -h /"; df -h /; } | tee "$OUT/resources-before.txt"

STEPS_FILE="$OUT/steps.tsv"
log() { echo "[patch-9s-synth] $(date -u +%T) $*"; }
result() { # result <проверка> <ok|FAIL> <пояснение>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$STEPS_FILE"
  log "$1: $2 - $3"
  [[ "$2" == ok ]] || FAILS=$((FAILS + 1))
}

export STAND_APP_PORT="$PORT_APP"
export STAND_DOCS_PORT="$PORT_DOCS"

# compose стенда «как на бою после G9r»: файлы дерева + надстройка стенда (заглушки).
dcs() {
  local envs=(--env-file "$DEPLOY/images.lock" --env-file "$DEPLOY/.env") f
  for f in secrets.env secrets.mask.env; do
    [[ ! -f "$DEPLOY/$f" ]] || envs+=(--env-file "$DEPLOY/$f")
  done
  docker compose -p "$PROJECT" "${envs[@]}" -f "$DEPLOY/compose.yml" -f "$STANDIN" "$@"
}

# Хэши и права файлов дерева (без временных): для сравнения «до» и «после» побайтно.
tree_hash() { (cd "$DEPLOY" && find . -type f ! -name '*.patch-new' ! -name '*.rb-new' \
  | sort | xargs -d '\n' sha256sum && find . -type f ! -name '*.patch-new' ! -name '*.rb-new' \
  -printf '%m %p\n' | sort); }
# Хэши файлов дерева, КРОМЕ images.lock и compose.project.yml (патч G9s другие файлы менять не
# вправе).
tree_hash_no_patched() { (cd "$DEPLOY" && find . -type f ! -name 'images.lock' \
  ! -name 'compose.project.yml' ! -name '*.patch-new' ! -name '*.rb-new' | sort \
  | xargs -d '\n' sha256sum); }
container_image() { docker inspect -f '{{.Config.Image}}' "$1" 2>/dev/null || echo отсутствует; }
container_started() { docker inspect -f '{{.State.StartedAt}}' "$1" 2>/dev/null || echo ?; }
# Одна переменная окружения контейнера (остальное окружение не читается и не печатается).
env_of() { # env_of <контейнер> <ИМЯ>
  { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null || true; } \
    | sed -n "s/^$2=//p" | head -1
}
# Ответ с хоста на 127.0.0.1:<порт><путь> без curl, через /dev/tcp: «код [тело]»; 000 - нет ответа.
# Метод GET или POST (POST с телом из четвёртого аргумента, по умолчанию {}).
http_reply() { # http_reply <порт> <путь> [метод] [тело]
  local raw body="${4-}"
  [[ -n "$body" ]] || body='{}'
  raw="$(timeout "$HTTP_TIMEOUT_S" bash -c '
    exec 3<>"/dev/tcp/127.0.0.1/$0"
    if [[ "$2" == POST ]]; then
      printf "POST %s HTTP/1.0\r\nHost: stand\r\nContent-Type: application/json\r\n" "$1" >&3
      printf "Content-Length: %s\r\n\r\n%s" "${#3}" "$3" >&3
    else
      printf "GET %s HTTP/1.0\r\nHost: stand\r\n\r\n" "$1" >&3
    fi
    cat <&3' "$1" "$2" "${3:-GET}" "$body" 2>/dev/null || true)"
  raw="${raw//$'\r'/}"
  if [[ "$raw" =~ ^HTTP/[0-9.]+\ ([0-9]{3}) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    sed -n '/^$/,$p' <<<"$raw" | tail -n +2
  else
    echo 000
  fi
}
http_code() { http_reply "$@" | head -n 1; }
# Проба /docx/pages с хоста: «статус код_ошибки» (только detail.error, остальное тело не
# печатается; у строки detail - «-»).
pages_from_host() {
  local reply code err
  reply="$(http_reply "$PORT_DOCS" "$PAGES_ROUTE" POST "$PAGES_BODY")"
  code="$(head -n 1 <<<"$reply")"
  err="$(tail -n +2 <<<"$reply" | grep -oE '"error" *: *"[a-z_]{1,64}"' | head -1 \
    | sed -E 's/.*"([a-z_]+)"$/\1/' || true)"
  echo "$code ${err:--}"
}
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
lock_ref() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2-; }

# ---------------------------------------------------------------------------------------------
# Внутри app (docker exec от пользователя образа, bun из образа): том приёма и архив
# ---------------------------------------------------------------------------------------------
# app_bun <js> [ИМЯ=значение...]: выполнить скрипт bun внутри app; значения идут в окружение
# скрипта, вывод скрипта (только слова и числа) печатается в stdout, ошибки отбрасываются.
app_bun() {
  local js="$1" kv
  shift
  local args=()
  for kv in "$@"; do args+=(-e "$kv"); done
  docker exec ${args[@]+"${args[@]}"} "$APP" bun -e "$js" 2>/dev/null || true
}
# cli_run <аргументы команды архива>: настоящая команда образа; код в CLI_RC, вывод в CLI_OUT
# (в переменной: имена файлов в нём могут быть, на экран и в файлы он не идёт).
CLI_RC=0
CLI_OUT=""
cli_run() {
  CLI_RC=0
  CLI_OUT="$(docker exec "$APP" bun run "$CLI_FILE" "$@" 2>/dev/null)" || CLI_RC=$?
}

# Синтетические каталоги приёма прайсов: имя - первые 16 знаков sha256 от метки (как у платформы
# приёма: 16 hex), в каждом несколько файлов разного размера. Печатает «ok».
read -r -d '' JS_SEED <<'JS' || true
try {
  const fs = await import('node:fs');
  const crypto = await import('node:crypto');
  const root = process.env.INTAKE_ROOT ?? '';
  for (let i = 1; i <= Number(process.env.SEED_DIRS); i += 1) {
    const dir = crypto.createHash('sha256').update('p9s-intake-dir-' + i).digest('hex')
      .slice(0, 16);
    fs.mkdirSync(root + '/' + dir, { recursive: true, mode: 0o700 });
    for (let j = 1; j <= Number(process.env.SEED_FILES); j += 1) {
      const body = ('synthetic intake body ' + i + '-' + j + '\n').repeat(i * j * 100);
      fs.writeFileSync(root + '/' + dir + '/zq9s-price-' + i + '-' + j + '.xlsx', body,
        { mode: 0o600 });
    }
  }
  console.log('ok');
} catch (e) { console.log('fail ' + (e.code ?? 'error')); }
JS

# Список тома приёма: только каталоги корня вида 16 hex и всё в них; строка файла «путь sha256
# права», строка каталога «путь/ dir права». Подкаталог архива в список не входит.
read -r -d '' JS_LIST <<'JS' || true
try {
  const fs = await import('node:fs');
  const crypto = await import('node:crypto');
  const root = process.env.INTAKE_ROOT ?? '';
  const out = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(root + '/' + rel)) {
      const path = rel + '/' + name;
      const info = fs.lstatSync(root + '/' + path);
      const mode = (info.mode & 0o7777).toString(8);
      if (info.isDirectory()) {
        out.push(path + '/ dir ' + mode);
        walk(path);
      } else {
        const sha = crypto.createHash('sha256').update(fs.readFileSync(root + '/' + path))
          .digest('hex');
        out.push(path + ' ' + sha + ' ' + mode);
      }
    }
  };
  for (const dir of fs.readdirSync(root)) {
    if (!/^[0-9a-f]{16}$/.test(dir)) continue;
    if (!fs.lstatSync(root + '/' + dir).isDirectory()) continue;
    out.push(dir + '/ dir ' + (fs.lstatSync(root + '/' + dir).mode & 0o7777).toString(8));
    walk(dir);
  }
  out.sort();
  console.log(out.join('\n'));
} catch (e) { console.log('fail ' + (e.code ?? 'error')); }
JS

# Права, владелец и тип записи в корне тома (PROBE_REL): «права own|foreign dir|other» либо
# «absent».
read -r -d '' JS_STAT <<'JS' || true
try {
  const fs = await import('node:fs');
  const path = (process.env.INTAKE_ROOT ?? '') + '/' + (process.env.PROBE_REL ?? '');
  try {
    const info = fs.lstatSync(path);
    console.log((info.mode & 0o7777).toString(8) + ' '
      + (info.uid === process.getuid() ? 'own' : 'foreign') + ' '
      + (info.isDirectory() ? 'dir' : 'other'));
  } catch (e) { console.log('absent'); }
} catch (e) { console.log('fail ' + (e.code ?? 'error')); }
JS

# Две записи архива «руками» от пользователя app, формат строки индекса - src/chat-attachments/
# index-file.ts (схема v1) и путь files/<тред 16 hex>/<sha256 16 знаков>_<имя>: свежая (сейчас) и
# просроченная (OLD_AGE суток назад). Печатает по строке «метка путь sha256 размер имя тред».
read -r -d '' JS_PLACE <<'JS' || true
try {
  const fs = await import('node:fs');
  const crypto = await import('node:crypto');
  const DAY_MS = 86400000;
  const root = (process.env.INTAKE_ROOT ?? '') + '/chat-attachments';
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const dir = (path) => {
    fs.mkdirSync(path, { recursive: true, mode: 0o700 });
    fs.chmodSync(path, 0o700);
  };
  const place = (tag, ageDays) => {
    const at = new Date(Date.now() - ageDays * DAY_MS);
    const body = 'synthetic archive body ' + tag + '\n';
    const digest = sha(body);
    const thread = sha('p9s-thread-' + tag).slice(0, 16);
    const name = 'zq9s-archive-' + tag + '.txt';
    const path = 'files/' + thread + '/' + digest.slice(0, 16) + '_' + name;
    dir(root + '/files/' + thread);
    dir(root + '/index');
    fs.writeFileSync(root + '/' + path, body, { mode: 0o600 });
    fs.utimesSync(root + '/' + path, at, at);
    const record = { v: 1, at: at.toISOString(), agent: 'synth-agent', bot: 'synth-bot', thread,
      user: 'synth-user', name, sha256: digest, size: Buffer.byteLength(body), path, key: '' };
    const day = at.toISOString().slice(0, 10);
    fs.appendFileSync(root + '/index/' + day + '.jsonl', JSON.stringify(record) + '\n',
      { mode: 0o600 });
    console.log([tag, path, digest, record.size, name, thread].join(' '));
  };
  place('fresh', 0);
  place('old', Number(process.env.OLD_AGE));
} catch (e) { console.log('fail ' + (e.code ?? 'error')); }
JS

# Запись архива на месте (после отката прежний образ команды не имеет, читаем файлами): файл
# ARCH_PATH есть, его sha256 равен ARCH_SHA, путь назван в одном из файлов индекса. «ok» или
# «fail причина».
read -r -d '' JS_ARCH_STATE <<'JS' || true
try {
  const fs = await import('node:fs');
  const crypto = await import('node:crypto');
  const root = (process.env.INTAKE_ROOT ?? '') + '/chat-attachments';
  const rel = process.env.ARCH_PATH ?? '';
  let body;
  try {
    body = fs.readFileSync(root + '/' + rel);
  } catch (e) {
    console.log('fail no_file');
    process.exit(0);
  }
  if (crypto.createHash('sha256').update(body).digest('hex') !== process.env.ARCH_SHA) {
    console.log('fail sha');
    process.exit(0);
  }
  let indexed = false;
  for (const name of fs.readdirSync(root + '/index')) {
    if (fs.readFileSync(root + '/index/' + name, 'utf8').includes('"path":"' + rel + '"')) {
      indexed = true;
    }
  }
  console.log(indexed ? 'ok' : 'fail no_index');
} catch (e) { console.log('fail ' + (e.code ?? 'error')); }
JS

# Убрать подкаталог архива из тома (только синтетический том стенда; нужен сценарию offswitch,
# чтобы проверить, что патч с выключенным хранением подкаталог не создаёт).
read -r -d '' JS_RM_ARCH <<'JS' || true
try {
  const fs = await import('node:fs');
  const root = process.env.INTAKE_ROOT ?? '';
  if (!root.startsWith('/') || root === '/') { console.log('fail root'); process.exit(0); }
  fs.rmSync(root + '/chat-attachments', { recursive: true, force: true });
  console.log('ok');
} catch (e) { console.log('fail ' + (e.code ?? 'error')); }
JS

# mode_of <относительный путь в корне тома>: слова из JS_STAT.
mode_of() { app_bun "$JS_STAT" "PROBE_REL=$1" | tail -n 1; }

# Список тома приёма в файл $2 (без вывода), число строк-файлов в stdout.
intake_snapshot() { # intake_snapshot <файл>
  app_bun "$JS_LIST" >"$1"
  awk 'NF == 3 && $2 != "dir"' "$1" | wc -l
}

# intake_same <метка>: каталоги приёма прайсов (имена и sha256) побайтно те же, что до патча.
intake_same() {
  local files
  [[ -s "$INTAKE_BEFORE" ]] || {
    result "$1: каталоги приёма прайсов в томе прежние" FAIL "нет списка тома до патча"
    return 0
  }
  files="$(intake_snapshot "$INTAKE_NOW")"
  if cmp -s "$INTAKE_NOW" "$INTAKE_BEFORE"; then
    result "$1: каталоги приёма прайсов в томе прежние" ok \
      "имена, sha256 и права тех же ($files файлов)"
  else
    result "$1: каталоги приёма прайсов в томе прежние" FAIL "список тома изменился"
  fi
}

# check_no_names <метка>: имён синтетических файлов нет ни в журналах стенда и патча, ни в
# копиях дерева, ни в архивах результатов (они распаковываются во временный каталог и
# удаляются). Печатается только число совпавших файлов.
check_no_names() {
  local untar="$OUT/untar.tmp" tgz hits label="$1: имён синтетических файлов нет в журналах"
  if [[ ! -s "$NAMES_FILE" ]]; then
    result "$label и результатах" FAIL "нет списка имён (шаг prepare не выполнялся)"
    return 0
  fi
  rm -rf "${untar:?}"
  mkdir -p "$untar"
  for tgz in "$OUT"/patch9s-*.tgz "$OUT"/flags9s-*.tgz; do
    [[ -f "$tgz" ]] || continue
    mkdir -p "$untar/$(basename "$tgz" .tgz)"
    tar -C "$untar/$(basename "$tgz" .tgz)" -xzf "$tgz" 2>/dev/null || true
  done
  hits="$(grep -rIlF -f "$NAMES_FILE" "$OUT" 2>/dev/null | wc -l)"
  rm -rf "${untar:?}"
  [[ "$hits" == 0 ]] \
    && result "$label и результатах" ok "ни в логах, ни в архивах результатов, ни в бэкапах" \
    || result "$label и результатах" FAIL "совпавших файлов: $hits"
}

# add_names <слова...>: дописать имена в список для check_no_names (по одному в строке).
add_names() {
  mkdir -p "$PRIV"
  # Короткие слова не берутся: они дали бы ложные совпадения в журналах.
  printf '%s\n' "$@" | awk -v min="$NAME_MIN_LEN" 'length($0) >= min' >>"$NAMES_FILE"
  sort -u -o "$NAMES_FILE" "$NAMES_FILE"
}

# Записи архива, положенные шагом apply (метка, путь, sha256): из $PLACED_FILE.
load_placed() {
  [[ -s "$PLACED_FILE" ]] || return 1
  FRESH_PATH="$(awk '$1 == "fresh" { print $2 }' "$PLACED_FILE")"
  FRESH_SHA="$(awk '$1 == "fresh" { print $3 }' "$PLACED_FILE")"
  OLD_PATH="$(awk '$1 == "old" { print $2 }' "$PLACED_FILE")"
  OLD_SHA="$(awk '$1 == "old" { print $3 }' "$PLACED_FILE")"
  [[ -n "$FRESH_PATH" && -n "$FRESH_SHA" && -n "$OLD_PATH" && -n "$OLD_SHA" ]]
}

# Подготовка lock'ов стенда: образ documents заменён на образ-заглушку (в нём есть bun), ОДНУ и ту
# же в lock боя и в lock пакета (G9s documents не меняет); прочее как в lock'ах этапов.
# Подтверждение подписей пересчитано под новый lock (образ заглушки подписан вместе с app: он
# взят из lock этапа 9r).
derive_stand_locks() {
  STUB_IMAGE_REF="${STUB_IMAGE:-$(lock_ref "$LOCK_OLD" BAI_IMAGE_APP)}"
  sed "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=$STUB_IMAGE_REF|" "$LOCK_OLD" \
    >"$STAND_LOCK_OLD"
  sed "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=$STUB_IMAGE_REF|" "$LOCK" >"$STAND_LOCK_NEW"
  python3 -I - "$SIGNATURES" "$STAND_LOCK_NEW" "$STUB_IMAGE_REF" >"$STAND_SIGNATURES" <<'PY'
import hashlib, sys
sig, lock, stub = sys.argv[1:4]
digest = hashlib.sha256(open(lock, "rb").read()).hexdigest()
for line in open(sig, encoding="utf-8").read().splitlines():
    if line.startswith("lock_sha256="):
        line = f"lock_sha256={digest}"
    elif line.startswith("image\tBAI_IMAGE_DOCUMENTS\t"):
        line = f"image\tBAI_IMAGE_DOCUMENTS\t{stub}\tOK"
    print(line)
PY
}

# lock_diff_keys <lock 1> <lock 2>: ключи, значения которых различаются (через пробел, по
# алфавиту).
lock_diff_keys() {
  diff <(sort "$1") <(sort "$2") | sed -nE 's/^[<>] ([A-Za-z0-9_]+)=.*/\1/p' | sort -u \
    | tr '\n' ' ' | sed 's/ $//'
}

# fill_required_env: обязательные переменные compose (${ИМЯ:?...}) без значения в синтетическом
# .env получают синтетическое значение (стенд их не использует, но `compose config` без них не
# соберётся); образы BAI_* берутся из lock.
fill_required_env() {
  local name
  while IFS= read -r name; do
    [[ "$name" != BAI_* ]] || continue
    ! grep -qE "^$name=." "$DEPLOY/.env" || continue
    sed -i "/^$name=/d" "$DEPLOY/.env"
    printf '%s=synthetic-%s\n' "$name" "${name,,}" >>"$DEPLOY/.env"
  done < <(cat "$DEPLOY/compose.project.yml" "$DEPLOY/platform/compose.base.yml" \
    | grep -oE '\$\{[A-Z0-9_]+:\?' | sed -E 's/^\$\{//; s/:\?$//' | sort -u)
}

# Дерево стенда «после G9r» из HEAD репозитория (если его нет): файлы compose,
# compose.project.yml без трёх новых переменных G9s и синтетический .env из .env.example
# (секретов нет).
make_tree() {
  local rel item
  mkdir -p "$DEPLOY/platform"
  for rel in "${TREE_FROM_HEAD[@]}"; do
    git -C "$ROOT" show "HEAD:deploy/$rel" >"$DEPLOY/$rel" \
      || { result "prepare: дерево стенда из HEAD" FAIL "в HEAD нет deploy/$rel"; return 1; }
  done
  for item in "${NEW_APP_VARS[@]}"; do
    sed -i "/^[[:space:]]*${item%%=*}:/d" "$DEPLOY/compose.project.yml"
  done
  git -C "$ROOT" show "HEAD:deploy/.env.example" >"$DEPLOY/.env" \
    || { result "prepare: дерево стенда из HEAD" FAIL "в HEAD нет deploy/.env.example"; return 1; }
  chmod 600 "$DEPLOY/.env"
  fill_required_env
  result "prepare: дерево стенда собрано из HEAD" ok \
    "состояние «G9r применён», .env синтетический"
}

patch_run() { # patch_run <шаг> [аргументы patch.sh]: код в RC, журнал $OUT/<шаг>.log
  local step="$1"
  shift
  RC=0
  env CUTOVER_PROJECT="$PROJECT" CUTOVER_NEW_DIR="$LIVE" CUTOVER_ENV_FILE="$DEPLOY/.env" \
    CUTOVER_EXTRA_COMPOSE="$STANDIN" CUTOVER_EXTRA_ENV="${STAND_EXTRA_ENV:-}" \
    CUTOVER_SERVICES="documents app" \
    CUTOVER_HOME="$OUT/home" CUTOVER_BACKUP_ROOT="$OUT/backups" CUTOVER_OUT_DIR="$OUT" \
    CUTOVER_COSIGN=/nonexistent-cosign PATCH9S_SOAK_POLL_S="$SOAK_POLL_S" \
    CUTOVER_EXPECT_BOTS="$EXPECT_BOTS" PATCH9S_MIN_DISK_MIB="$MIN_DISK_MIB" \
    PATCH9S_PAGES_PROBE_STATUS="$PAGES_STATUS" PATCH9S_PAGES_PROBE_ERROR="$PAGES_ERROR" \
    CUTOVER_READY_WAIT_S="$READY_WAIT_S" CUTOVER_HEALTH_WAIT_S="$HEALTH_WAIT_S" \
    bash "$PKG/patch.sh" --soak-seconds "$SOAK_S" "$@" >"$OUT/$step.log" 2>&1 || RC=$?
}

# flags_run <шаг> [аргументы enable-flags.sh]: код в RC, журнал $OUT/<шаг>.log.
flags_run() {
  local step="$1"
  shift
  RC=0
  env CUTOVER_PROJECT="$PROJECT" CUTOVER_NEW_DIR="$LIVE" CUTOVER_ENV_FILE="$DEPLOY/.env" \
    CUTOVER_EXTRA_COMPOSE="$STANDIN" CUTOVER_SERVICES="documents app" \
    CUTOVER_HOME="$OUT/home" CUTOVER_BACKUP_ROOT="$OUT/backups" CUTOVER_OUT_DIR="$OUT" \
    FLAGS9S_SOAK_POLL_S="$SOAK_POLL_S" CUTOVER_EXPECT_BOTS="$EXPECT_BOTS" \
    CUTOVER_READY_WAIT_S="$READY_WAIT_S" CUTOVER_HEALTH_WAIT_S="$HEALTH_WAIT_S" \
    bash "$PKG/enable-flags.sh" --soak-seconds "$SOAK_S" "$@" >"$OUT/$step.log" 2>&1 || RC=$?
}

# Контекст отдельных шагов (--steps без prepare): lock'и стенда и пакет.
restore_context() {
  mkdir -p "$PRIV"
  [[ -n "$STUB_IMAGE_REF" ]] || derive_stand_locks || return 1
  [[ -f "$PKG/patch.sh" ]] || build_package
}

# ---------------------------------------------------------------------------------------------
step_prepare() {
  log "стенд: предусловия"
  local missing=() f port
  for f in "$LOCK" "$LOCK_OLD" "$SIGNATURES" "$STANDIN"; do
    [[ -f "$f" ]] || missing+=("$f")
  done
  if ((${#missing[@]} > 0)); then
    result "prepare: подготовленные файлы" FAIL "нет: ${missing[*]}"
    log "Нужны lock'и этапов 9r и 9s, подтверждение подписей по lock этапа 9s и надстройка стенда."
    return 1
  fi
  command -v docker >/dev/null || { result "prepare: docker" FAIL "нет docker"; return 1; }
  [[ -f "$DEPLOY/compose.yml" ]] || make_tree || return 1
  for f in "${NEEDED_FILES[@]}"; do
    [[ -f "$DEPLOY/$f" ]] || missing+=("$DEPLOY/$f")
  done
  if ((${#missing[@]} > 0)); then
    result "prepare: дерево стенда" FAIL "нет: ${missing[*]}"
    return 1
  fi
  local flag both
  both="$(cat "$DEPLOY/compose.project.yml" "$DEPLOY/platform/compose.base.yml")"
  for flag in "${DOCS_FLAGS[@]%%=*}" "$YANDEX_CONCURRENCY_KEY" "${OLD_APP_VARS[@]}"; do
    if ! grep -q "$flag" <<<"$both"; then
      result "prepare: дерево стенда после G9r" FAIL "в compose.project.yml и платформе нет $flag"
      return 1
    fi
  done
  for flag in "${NEW_APP_VARS[@]%%=*}"; do
    if grep -q "$flag" "$DEPLOY/compose.project.yml"; then
      result "prepare: дерево стенда до G9s" FAIL \
        "в compose.project.yml уже есть $flag: дерево не «после G9r»"
      return 1
    fi
  done
  if ! grep -qx "PLATFORM_PACKAGES_VERSION=$PLATFORM_NOW" "$DEPLOY/platform/PLATFORM-VERSION"; then
    result "prepare: платформа стенда" FAIL "в PLATFORM-VERSION не $PLATFORM_NOW"
    return 1
  fi
  if ! grep -qx "BAI_VERSION=$LOCK_VERSION_FROM" "$LOCK_OLD"; then
    result "prepare: lock боя G9r" FAIL "в $LOCK_OLD не BAI_VERSION=$LOCK_VERSION_FROM"
    return 1
  fi
  if ! grep -qx "BAI_VERSION=$LOCK_VERSION_TO" "$LOCK"; then
    result "prepare: lock этапа 9s" FAIL "в $LOCK не BAI_VERSION=$LOCK_VERSION_TO"
    return 1
  fi
  local diff_keys
  diff_keys="$(lock_diff_keys "$LOCK_OLD" "$LOCK")"
  if [[ "$diff_keys" != "$LOCK_DIFF_ALLOWED" ]]; then
    result "prepare: lock 9s отличается от lock 9r только версией и образом app" FAIL \
      "отличаются ключи: ${diff_keys:-нет}"
    return 1
  fi
  for ((port = PORT_FIRST; port <= PORT_LAST; port++)); do
    if port_busy "$port"; then
      result "prepare: порты стенда $PORT_FIRST-$PORT_LAST свободны" FAIL "занят порт $port"
      return 1
    fi
  done
  result "prepare: предусловия" ok \
    "дерево, lock'и (различия только $LOCK_DIFF_ALLOWED), подписи, порты $PORT_FIRST-$PORT_LAST"
  derive_stand_locks || return 1
  local ref
  for ref in "$(lock_ref "$LOCK_OLD" BAI_IMAGE_APP)" "$(lock_ref "$LOCK" BAI_IMAGE_APP)" \
    "$STUB_IMAGE_REF"; do
    docker image inspect "$ref" >/dev/null 2>&1 \
      || { result "prepare: образ на хосте" FAIL "нет ${ref##*/} (docker load / pull)"; return 1; }
  done
  result "prepare: образы app и заглушки documents на хосте" ok \
    "прежний и новый app, одна заглушка documents"
  # Синтетический .env стенда - как на бою до G9s: новых переменных в нём нет (значения по
  # умолчанию compose); строки из прежней заготовки убираются (сценарий offswitch задаёт явно).
  for flag in "${NEW_APP_VARS[@]%%=*}"; do
    sed -i -E "/^$flag=/d" "$DEPLOY/.env"
  done
  result "prepare: в .env стенда нет новых переменных (как на бою до G9s)" ok \
    "значения по умолчанию compose"
  dcs down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "${PRIV:?}"
  mkdir -p "$PRIV"
  : >"$NAMES_FILE"
  cp "$STAND_LOCK_OLD" "$DEPLOY/images.lock"
  date -u +%FT%TZ >"$DEPLOY/.cutover-deployed"
  local svc
  for svc in documents app; do
    dcs up -d --no-deps "$svc" >>"$OUT/prepare.log" 2>&1 \
      || { result "prepare: up $svc" FAIL "compose up не удался (prepare.log)"; return 1; }
  done
  sleep "$SETTLE_S"
  tree_hash >"$OUT/tree-before.sha"
  tree_hash_no_patched >"$OUT/tree-before-no-patched.sha"
  cp -p "$DEPLOY/.env" "$OUT/env.keep"
  docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.Names}}\t{{.Image}}' | sort >"$OUT/containers-before.txt"
  DOCS_STARTED_BEFORE="$(container_started "$DOCS")"
  echo "$DOCS_STARTED_BEFORE" >"$OUT/docs-started.before"
  [[ -n "$(env_of "$APP" "$YANDEX_CONCURRENCY_KEY")" \
    && -n "$(env_of "$APP" "$YANDEX_INTERVAL_KEY")" ]] \
    && result "prepare: у app переменные поиска G8w" ok "как на бою после G8w" \
    || result "prepare: у app переменные поиска G8w" FAIL "нет"
  check_old_vars prepare "до патча"
  [[ -z "$(new_flags_present)" ]] \
    && result "prepare: у app нет новых переменных G9s (состояние G9r)" ok "отсутствуют" \
    || result "prepare: у app нет новых переменных G9s (состояние G9r)" FAIL "уже есть"
  check_docs_flags prepare "до патча"
  [[ "$(http_code "$PORT_APP" /ready)" == 200 && "$(http_code "$PORT_DOCS" /health)" == 200 ]] \
    && result "prepare: заглушки app и documents отвечают с хоста" ok \
      "200 на $PORT_APP, $PORT_DOCS" \
    || result "prepare: заглушки app и documents отвечают с хоста" FAIL "нет 200"
  [[ "$(pages_from_host)" == "$PAGES_STATUS $PAGES_ERROR" ]] \
    && result "prepare: заглушка documents отвечает на POST $PAGES_ROUTE как образ G9r" ok \
      "$PAGES_STATUS $PAGES_ERROR" \
    || result "prepare: заглушка documents отвечает на POST $PAGES_ROUTE как образ G9r" FAIL \
      "иной ответ: $(pages_from_host)"
  [[ "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=$STAGE_LABEL" | wc -l)" == 2 ]] \
    && result "prepare: контейнеры стенда с меткой $STAGE_LABEL" ok "documents и app" \
    || result "prepare: контейнеры стенда с меткой $STAGE_LABEL" FAIL "метки нет"
  prepare_intake
}

# Том приёма до патча: смонтирован в app (том intake-data по пути INTAKE_ROOT), в нём
# синтетические каталоги приёма прайсов; подкаталога архива и команды архива в прежнем образе нет.
prepare_intake() {
  local root seeded files
  root="$(env_of "$APP" "$INTAKE_ROOT_KEY")"
  if [[ -n "$root" ]] && { docker inspect \
    -f '{{range .Mounts}}{{.Destination}} {{.Name}}{{println}}{{end}}' "$APP" 2>/dev/null \
    | awk -v root="$root" -v suffix="$INTAKE_VOLUME_SUFFIX" \
      '$1 == root && substr($2, length($2) - length(suffix) + 1) == suffix { found = 1 } \
      END { exit !found }'; }; then
    result "prepare: том $INTAKE_VOLUME_SUFFIX смонтирован в app по пути $INTAKE_ROOT_KEY" ok \
      "$root"
  else
    result "prepare: том $INTAKE_VOLUME_SUFFIX смонтирован в app по пути $INTAKE_ROOT_KEY" FAIL \
      "нет монтирования (корень '${root:-<нет>}')"
    return 1
  fi
  # Как на бою (cutover проверяет, что uid app пишет в том): корень нового тома отдаём app.
  # (у app сброшены все capabilities, поэтому chown делает одноразовый контейнер на том же томе)
  docker run --rm --user 0 --network none --label "bai.stage=9s" \
    -v "${PROJECT}_${INTAKE_VOLUME_SUFFIX}:/v" --entrypoint chown \
    "$(docker inspect -f '{{.Config.Image}}' "$APP")" "$APP_UID:$APP_UID" /v >/dev/null 2>&1 || true
  seeded="$(app_bun "$JS_SEED" "SEED_DIRS=$INTAKE_SEED_DIRS" "SEED_FILES=$INTAKE_SEED_FILES" \
    | tail -n 1)"
  files="$(intake_snapshot "$INTAKE_BEFORE")"
  if [[ "$seeded" == ok && "$files" -ge "$MIN_INTAKE_FILES" ]]; then
    result "prepare: в томе приёма синтетические каталоги приёма прайсов" ok \
      "$files файлов в каталогах из 16 hex (от пользователя app)"
  else
    result "prepare: в томе приёма синтетические каталоги приёма прайсов" FAIL \
      "заполнение: ${seeded:-нет ответа}, файлов $files"
    return 1
  fi
  # Все компоненты путей списка (имена каталогов и файлов) идут в список для проверки журналов.
  add_names $(awk 'NF == 3 { n = split($1, p, "/"); for (i = 1; i <= n; i++) print p[i] }' \
    "$INTAKE_BEFORE")
  [[ "$(mode_of "$ARCHIVE_SUB")" == absent ]] \
    && result "prepare: подкаталога $ARCHIVE_SUB в томе до патча нет" ok "как на бою после G9r" \
    || result "prepare: подкаталога $ARCHIVE_SUB в томе до патча нет" FAIL "он уже есть"
  cli_run stats
  [[ "$CLI_RC" != 0 ]] \
    && result "prepare: в прежнем образе app команды архива нет" ok "код $CLI_RC (образ G9r)" \
    || result "prepare: в прежнем образе app команды архива нет" FAIL \
      "команда отработала: образ не G9r?"
}

# new_flags_present: имена новых переменных G9s, что есть в окружении app (пусто - нет ни одной).
new_flags_present() {
  local name
  for name in "${NEW_APP_VARS[@]%%=*}"; do
    [[ -z "$(env_of "$APP" "$name")" ]] || printf '%s ' "$name"
  done
}

# check_new_vars <метка> <хранение> [срок] [предел]: значения новых переменных в окружении app
# (по умолчанию срок и предел - значения по умолчанию compose).
check_new_vars() {
  local want_store="$2" want_days="${3:-$DEFAULT_DAYS}" want_bytes="${4:-$DEFAULT_BYTES}" bad=""
  [[ "$(env_of "$APP" "$VAR_STORE")" == "$want_store" ]] \
    || bad+=" $VAR_STORE=$(env_of "$APP" "$VAR_STORE")"
  [[ "$(env_of "$APP" "$VAR_DAYS")" == "$want_days" ]] \
    || bad+=" $VAR_DAYS=$(env_of "$APP" "$VAR_DAYS")"
  [[ "$(env_of "$APP" "$VAR_BYTES")" == "$want_bytes" ]] \
    || bad+=" $VAR_BYTES=$(env_of "$APP" "$VAR_BYTES")"
  [[ -z "$bad" ]] \
    && result "$1: у app три новые переменные: хранение $want_store, $want_days сут., $want_bytes" \
      ok "$VAR_STORE, $VAR_DAYS, $VAR_BYTES" \
    || result "$1: у app три новые переменные: хранение $want_store, $want_days сут., $want_bytes" \
      FAIL "иные значения:$bad"
}

# check_old_vars <шаг> <когда>: переменные G9r, G9q3, G9q2, G9q, G9p и G8z у app (патч G9s их
# терять не вправе).
check_old_vars() {
  local name got bad=""
  for name in "${OLD_APP_VARS[@]}"; do
    got="$(env_of "$APP" "$name")"
    [[ -n "$got" ]] || bad+=" $name=<нет>"
  done
  [[ -z "$bad" ]] \
    && result "$1: у app переменные G9r, G9q3, G9q2, G9q, G9p и G8z на месте ($2)" ok \
      "${#OLD_APP_VARS[@]} переменных" \
    || result "$1: у app переменные G9r, G9q3, G9q2, G9q, G9p и G8z на месте ($2)" FAIL "$bad"
}

# check_docs_flags <шаг> <когда>: четыре флага G8x в окружении documents стенда.
check_docs_flags() {
  local item key got bad=""
  for item in "${DOCS_FLAGS[@]}"; do
    key="${item%%=*}"
    got="$(env_of "$DOCS" "$key")"
    [[ "$got" == "${item#*=}" ]] || bad+=" $key=${got:-<нет>}"
  done
  [[ -z "$bad" ]] \
    && result "$1: четыре флага G8x в окружении documents ($2)" ok "${DOCS_FLAGS[*]}" \
    || result "$1: четыре флага G8x в окружении documents ($2)" FAIL "$bad"
}

build_package() {
  local pkg_out="$OUT/package"
  rm -rf "${pkg_out:?}"
  bash "$HERE/build-patch-9s-package.sh" --out "$pkg_out" --lock "$STAND_LOCK_NEW" \
    --prev-lock "$STAND_LOCK_OLD" --signatures "$STAND_SIGNATURES" \
    ${RUNBOOK_FILE:+--runbook "$RUNBOOK_FILE"} >"$OUT/build-package.log" 2>&1 \
    || { result "package: сборка" FAIL "см. build-package.log (файлы patch-9s должны быть в HEAD)"
      return 1; }
  PKG="$pkg_out"
  result "package: сборка" ok "$(find "$pkg_out" -type f | wc -l) файлов"
}

unchanged_since_prepare() { # unchanged_since_prepare <метка>
  local label="$1"
  if diff <(tree_hash) "$OUT/tree-before.sha" >/dev/null; then
    result "$label: файлы дерева прежние" ok "побайтно как до патча"
  else
    result "$label: файлы дерева прежние" FAIL "дерево изменилось"
  fi
  if diff <(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.Names}}\t{{.Image}}' | sort) "$OUT/containers-before.txt" >/dev/null; then
    result "$label: контейнеры и образы прежние" ok "набор и образы как до патча"
  else
    result "$label: контейнеры и образы прежние" FAIL "набор или образы изменились"
  fi
}

# documents не перезапускался с момента prepare: StartedAt прежний (шаги, где патч его не менял).
docs_untouched() { # docs_untouched <метка>
  [[ "$(container_started "$DOCS")" == "$(cat "$OUT/docs-started.before")" ]] \
    && result "$1: documents не перезапускался" ok "StartedAt как до патча" \
    || result "$1: documents не перезапускался" FAIL "StartedAt изменился"
}

# documents на образе заглушки (он один до и после патча: G9s documents не меняет).
docs_is_old() { # docs_is_old <метка>
  [[ "$(container_image "$DOCS")" == "$STUB_IMAGE_REF" ]] \
    && result "$1: documents на прежнем образе" ok "${STUB_IMAGE_REF##*/}" \
    || result "$1: documents на прежнем образе" FAIL "$(container_image "$DOCS")"
}

# Подкаталога архива в томе нет (до замены app патч его не создаёт).
archive_absent() { # archive_absent <метка>
  [[ "$(mode_of "$ARCHIVE_SUB")" == absent ]] \
    && result "$1: подкаталог $ARCHIVE_SUB в томе не создан" ok "его нет" \
    || result "$1: подкаталог $ARCHIVE_SUB в томе не создан" FAIL "он есть"
}

step_preflight() {
  build_package || return 1
  patch_run preflight --preflight-only
  [[ "$RC" == 0 ]] && result "preflight: код" ok "0 (PREFLIGHT_OK)" \
    || result "preflight: код" FAIL "$RC (preflight.log)"
  grep -q 'патч G9r применён: ok' "$OUT/preflight.log" \
    && result "preflight: патч G9r распознан как применённый" ok "запись в журнале" \
    || result "preflight: патч G9r распознан как применённый" FAIL "нет записи в журнале"
  grep -q 'том приёма: ok' "$OUT/preflight.log" \
    && result "preflight: том приёма смонтирован, запись пользователю app доступна" ok \
      "запись в журнале" \
    || result "preflight: том приёма смонтирован, запись пользователю app доступна" FAIL \
      "нет записи в журнале"
  grep -q 'переменные хранения вложений в конфигурации: ok' "$OUT/preflight.log" \
    && grep -q "$VAR_STORE включено" "$OUT/preflight.log" \
    && grep -q "$VAR_DAYS=$DEFAULT_DAYS" "$OUT/preflight.log" \
    && grep -q "$VAR_BYTES=$DEFAULT_BYTES" "$OUT/preflight.log" \
    && result "preflight: три новые переменные в новой конфигурации (хранение включено)" ok \
      "запись в журнале" \
    || result "preflight: три новые переменные в новой конфигурации (хранение включено)" FAIL \
      "нет записи в журнале"
  grep -q 'прочая конфигурация: ok' "$OUT/preflight.log" \
    && result "preflight: прочая конфигурация сходится со снимком боя" ok "запись в журнале" \
    || result "preflight: прочая конфигурация сходится со снимком боя" FAIL "нет записи"
  unchanged_since_prepare preflight
  docs_untouched preflight
  archive_absent preflight
  intake_same preflight
  check_no_names preflight
}

step_refuse() {
  # 1. Lock боя версии G9q3 (.0): предусловие «G9r применён» не выполнено - отказ ДО замены.
  local keep="$OUT/images.lock.keep"
  cp -p "$DEPLOY/images.lock" "$keep"
  sed -i "s|^BAI_VERSION=.*|BAI_VERSION=$LOCK_VERSION_G9Q3|" "$DEPLOY/images.lock"
  patch_run refuse --preflight-only
  cp -p "$keep" "$DEPLOY/images.lock"
  [[ "$RC" == 3 ]] && result "refuse: код (G9r не применён)" ok "3 (отказ по предусловиям)" \
    || result "refuse: код (G9r не применён)" FAIL "$RC (refuse.log)"
  grep -q 'сначала примените патч G9r' "$OUT/refuse.log" \
    && result "refuse: причина" ok "названа: сначала примените патч G9r" \
    || result "refuse: причина" FAIL "причина не названа"
  unchanged_since_prepare refuse
  archive_absent refuse
  intake_same refuse
}

# Опрос заглушек с хоста, пока существует флаг: «мс-время имя код» в $OUT/poll.txt.
poll_stand() {
  local now
  while [[ -e "$POLL_FLAG" ]]; do
    now="$(date +%s%3N)"
    printf '%s docs %s\n' "$now" "$(http_code "$PORT_DOCS" /health)" >>"$OUT/poll.txt"
    printf '%s app %s\n' "$now" "$(http_code "$PORT_APP" /ready)" >>"$OUT/poll.txt"
    sleep "$POLL_INTERVAL_S"
  done
}

# downtime <имя в poll.txt> <метка>: число проб не 200 и оценка простоя (мс).
downtime() {
  local who="$1" label="$2" bad first last
  bad="$(awk -v w="$who" '$2 == w && $3 != 200' "$OUT/poll.txt" | wc -l)"
  first="$(awk -v w="$who" '$2 == w && $3 != 200 { print $1; exit }' "$OUT/poll.txt")"
  last="$(awk -v w="$who" '$2 == w && $3 != 200 { t = $1 } END { print t }' "$OUT/poll.txt")"
  if [[ -n "$first" ]]; then
    result "apply: простой $label (заглушка)" ok \
      "не отвечал $bad проб, около $((last - first + POLL_INTERVAL_MS)) мс"
  else
    result "apply: простой $label (заглушка)" ok "опрос простоя не заметил (пересоздание быстрее)"
  fi
}

# Архив после патча: права подкаталога, настоящая команда образа на пустом архиве, затем
# запись «руками» и проверка команд find, path, stats и purge с реальными часами.
archive_after_apply() {
  local mode intake placed ok_find
  intake="$(env_of "$APP" "$INTAKE_ROOT_KEY")"
  # Подкаталог создаёт проба тома в patch.sh (mkdir без указания прав): если у процесса app
  # umask 022, права будут 755, а не 700 образа (ensureDir образа существующий каталог не
  # перечмодивает). Стенд сообщает фактические права.
  mode="$(mode_of "$ARCHIVE_SUB")"
  [[ "$mode" == "$ARCHIVE_MODE_WANT own dir" ]] \
    && result "apply: в томе есть $ARCHIVE_SUB, права $ARCHIVE_MODE_WANT, владелец app" ok \
      "$mode" \
    || result "apply: в томе есть $ARCHIVE_SUB, права $ARCHIVE_MODE_WANT, владелец app" FAIL \
      "фактически: $mode (проба patch.sh создаёт каталог без явных прав?)"
  cli_run stats
  [[ "$CLI_RC" == 0 && "$CLI_OUT" == *'Записей индекса: 0, файлов: 0,'* ]] \
    && result "apply: настоящий образ: stats на пустом архиве" ok "код 0, записей 0" \
    || result "apply: настоящий образ: stats на пустом архиве" FAIL \
      "код $CLI_RC (команда есть в образе 1.1.10-pragmatika.2?)"
  cli_run find
  [[ "$CLI_RC" == 0 && "$CLI_OUT" == 'Найдено записей: 0' ]] \
    && result "apply: настоящий образ: find на пустом архиве" ok "код 0, найдено 0" \
    || result "apply: настоящий образ: find на пустом архиве" FAIL "код $CLI_RC"
  # Записи «руками» (формат строки индекса из index-file.ts), свежая и просроченная.
  placed="$(app_bun "$JS_PLACE" "OLD_AGE=$OLD_RECORD_AGE_DAYS")"
  if [[ "$(grep -c -E '^(fresh|old) ' <<<"$placed")" != 2 ]]; then
    result "apply: запись архива положена в том от пользователя app" FAIL \
      "ответ: $(tail -n 1 <<<"$placed" | cut -c1-20)"
    return 0
  fi
  printf '%s\n' "$placed" >"$PLACED_FILE"
  load_placed
  # Имя файла, каталог треда и последний компонент пути («префикс sha256_имя»).
  add_names $(awk '{ n = split($2, part, "/"); print $5; print $6; print part[n] }' \
    "$PLACED_FILE")
  result "apply: запись архива положена в том от пользователя app" ok \
    "свежая и просроченная ($OLD_RECORD_AGE_DAYS сут.), файл и строка индекса"
  cli_run find --json
  ok_find=0
  [[ "$CLI_RC" == 0 && "$(grep -c . <<<"$CLI_OUT")" == 2 ]] \
    && grep -qF "\"sha256\":\"$FRESH_SHA\"" <<<"$CLI_OUT" \
    && grep -qF "\"sha256\":\"$OLD_SHA\"" <<<"$CLI_OUT" \
    && [[ "$(grep -cF '"abs":"/' <<<"$CLI_OUT")" == 2 ]] && ok_find=1
  ((ok_find)) \
    && result "apply: настоящий образ: find --json видит обе записи, файлы найдены" ok \
      "2 записи, абсолютные пути заданы" \
    || result "apply: настоящий образ: find --json видит обе записи, файлы найдены" FAIL \
      "код $CLI_RC, строк $(grep -c . <<<"$CLI_OUT")"
  cli_run find --json --sha "${FRESH_SHA:0:8}"
  [[ "$CLI_RC" == 0 && "$(grep -c . <<<"$CLI_OUT")" == 1 ]] \
    && grep -qF "\"sha256\":\"$FRESH_SHA\"" <<<"$CLI_OUT" \
    && result "apply: настоящий образ: find --sha ищет по префиксу хэша" ok "одна запись" \
    || result "apply: настоящий образ: find --sha ищет по префиксу хэша" FAIL "код $CLI_RC"
  cli_run path "$FRESH_PATH"
  [[ "$CLI_RC" == 0 && "$CLI_OUT" == "$intake/$ARCHIVE_SUB/$FRESH_PATH" ]] \
    && result "apply: настоящий образ: path отдаёт абсолютный путь файла" ok \
      "корень приёма и подкаталог архива" \
    || result "apply: настоящий образ: path отдаёт абсолютный путь файла" FAIL "код $CLI_RC"
  cli_run stats
  [[ "$CLI_RC" == 0 && "$CLI_OUT" == *'Записей индекса: 2, файлов: 2,'* ]] \
    && result "apply: настоящий образ: stats считает две записи" ok "записей 2, файлов 2" \
    || result "apply: настоящий образ: stats считает две записи" FAIL "код $CLI_RC"
  # purge с реальными часами: просроченная запись уходит вместе с файлом, свежая остаётся.
  cli_run purge
  [[ "$CLI_RC" == 0 && "$CLI_OUT" == *'Удалено по сроку: файлов 1, записей 1, сирот 0,'* ]] \
    && result "apply: настоящий образ: purge удалил просроченную запись и файл" ok \
      "файлов 1, записей 1, сирот 0" \
    || result "apply: настоящий образ: purge удалил просроченную запись и файл" FAIL \
      "код $CLI_RC, итог не «файлов 1, записей 1, сирот 0»"
  cli_run find --json
  [[ "$CLI_RC" == 0 && "$(grep -c . <<<"$CLI_OUT")" == 1 ]] \
    && grep -qF "\"sha256\":\"$FRESH_SHA\"" <<<"$CLI_OUT" \
    && ! grep -qF "\"sha256\":\"$OLD_SHA\"" <<<"$CLI_OUT" \
    && result "apply: после purge свежая запись на месте, просроченной нет" ok "одна запись" \
    || result "apply: после purge свежая запись на месте, просроченной нет" FAIL \
      "код $CLI_RC, строк $(grep -c . <<<"$CLI_OUT")"
  cli_run path "$FRESH_PATH"
  local fresh_rc="$CLI_RC"
  cli_run path "$OLD_PATH"
  [[ "$fresh_rc" == 0 && "$CLI_RC" != 0 ]] \
    && result "apply: после purge файл свежей записи есть, просроченного нет" ok \
      "path: код 0 и код $CLI_RC" \
    || result "apply: после purge файл свежей записи есть, просроченного нет" FAIL \
      "path свежей: $fresh_rc, просроченной: $CLI_RC"
  [[ "$(app_bun "$JS_ARCH_STATE" "ARCH_PATH=$FRESH_PATH" "ARCH_SHA=$FRESH_SHA" | tail -n 1)" \
    == ok ]] \
    && result "apply: файл свежей записи цел (sha256), путь назван в индексе" ok "ok" \
    || result "apply: файл свежей записи цел (sha256), путь назван в индексе" FAIL "иначе"
  intake_same apply
  check_no_names apply
}

step_apply() {
  local poll_pid
  : >"$OUT/poll.txt"
  : >"$POLL_FLAG"
  poll_stand &
  poll_pid=$!
  patch_run apply
  rm -f "$POLL_FLAG"
  wait "$poll_pid" 2>/dev/null || true
  [[ "$RC" == 0 ]] && result "apply: код" ok "0 (apply.log)" \
    || result "apply: код" FAIL "$RC (apply.log)"
  local ref
  ref="$(lock_ref "$STAND_LOCK_NEW" BAI_IMAGE_APP)"
  [[ "$(container_image "$APP")" == "$ref" ]] \
    && result "apply: app на новом образе" ok "${ref##*/}" \
    || result "apply: app на новом образе" FAIL "$(container_image "$APP")"
  docs_is_old apply
  docs_untouched apply
  cmp -s "$DEPLOY/images.lock" "$STAND_LOCK_NEW" \
    && result "apply: images.lock боя равен lock пакета" ok "версия $(lock_ref "$STAND_LOCK_NEW" \
      BAI_VERSION)" \
    || result "apply: images.lock боя равен lock пакета" FAIL "различаются"
  cmp -s "$DEPLOY/compose.project.yml" "$PKG/deploy/compose.project.yml" \
    && result "apply: compose.project.yml боя равен файлу пакета" ok "новые переменные app" \
    || result "apply: compose.project.yml боя равен файлу пакета" FAIL "различаются"
  diff <(tree_hash_no_patched) "$OUT/tree-before-no-patched.sha" >/dev/null \
    && result "apply: остальные файлы дерева прежние" ok \
      "побайтно (кроме lock и compose.project.yml)" \
    || result "apply: остальные файлы дерева прежние" FAIL "изменились"
  check_new_vars apply "$FLAG_ON"
  check_old_vars apply "после патча"
  check_docs_flags apply "после патча"
  [[ -n "$(env_of "$APP" "$YANDEX_CONCURRENCY_KEY")" \
    && -n "$(env_of "$APP" "$YANDEX_INTERVAL_KEY")" ]] \
    && result "apply: переменные Яндекса у app сохранились" ok "обе на месте" \
    || result "apply: переменные Яндекса у app сохранились" FAIL "пропали"
  [[ "$(pages_from_host)" == "$PAGES_STATUS $PAGES_ERROR" ]] \
    && result "apply: POST $PAGES_ROUTE отвечает с хоста (ручка на месте)" ok \
      "$PAGES_STATUS $PAGES_ERROR (как до патча)" \
    || result "apply: POST $PAGES_ROUTE отвечает с хоста (ручка на месте)" FAIL \
      "иной ответ: $(pages_from_host)"
  grep -q 'проба /docx/pages: ok' "$OUT/apply.log" \
    && result "apply: проба /docx/pages прошла в patch.sh" ok "запись в журнале" \
    || result "apply: проба /docx/pages прошла в patch.sh" FAIL "нет записи в журнале"
  grep -q 'том приёма после замены: ok' "$OUT/apply.log" \
    && grep -q 'чужих записей 0' "$OUT/apply.log" \
    && result "apply: проба тома после замены прошла в patch.sh, чужих записей 0" ok \
      "запись в журнале" \
    || result "apply: проба тома после замены прошла в patch.sh, чужих записей 0" FAIL \
      "нет записи в журнале"
  ! grep -q 'up -d --no-deps documents' "$OUT/apply.log" \
    && grep -q 'up -d --no-deps app' "$OUT/apply.log" \
    && result "apply: в журнале up только app, documents не пересоздавался" ok "запись в журнале" \
    || result "apply: в журнале up только app, documents не пересоздавался" FAIL \
      "есть up documents или нет up app"
  ! grep -qE ' (down|--remove-orphans|--force-recreate)( |$)' "$OUT/apply.log" \
    && result "apply: в журнале нет down, --remove-orphans, --force-recreate" ok \
      "выкатка без down" \
    || result "apply: в журнале нет down, --remove-orphans, --force-recreate" FAIL \
      "есть запись"
  [[ "$(awk '$2 == "docs" && $3 != 200' "$OUT/poll.txt" | wc -l)" == 0 ]] \
    && result "apply: documents не простаивал (опрос хоста)" ok "все пробы 200" \
    || result "apply: documents не простаивал (опрос хоста)" FAIL "были пробы не 200"
  downtime app app
  [[ "$(tail -2 "$OUT/poll.txt" | awk '$3 == 200' | wc -l)" == 2 ]] \
    && result "apply: в конце опроса documents и app отвечают" ok "200 и 200" \
    || result "apply: в конце опроса documents и app отвечают" FAIL "нет 200"
  local backup
  backup="$(find "$OUT/backups" -maxdepth 1 -name 'pragmatika-patch9s-*' 2>/dev/null | head -1)"
  [[ -n "$backup" ]] \
    && result "apply: бэкап файлов дерева" ok "$(basename "$backup")" \
    || result "apply: бэкап файлов дерева" FAIL "нет каталога бэкапа"
  RUN_APPLIED="$(readlink -f "$OUT/home/patch-9s-latest")"
  archive_after_apply
}

# Необязательный шаг runbook: выключатель хранения и откат .env (после apply, до rollback патча).
step_enable() {
  local docs_started
  cp -p "$DEPLOY/.env" "$OUT/env.before-enable"
  docs_started="$(container_started "$DOCS")"
  flags_run enable_dry --store "$FLAG_OFF" --dry-run
  [[ "$RC" == 0 ]] && cmp -s "$DEPLOY/.env" "$OUT/env.before-enable" \
    && result "enable: --dry-run" ok "код 0, .env не тронут" \
    || result "enable: --dry-run" FAIL "$RC (enable_dry.log)"
  flags_run enable --store "$FLAG_OFF"
  [[ "$RC" == 0 ]] && result "enable: код" ok "0 (enable.log)" \
    || result "enable: код" FAIL "$RC (enable.log)"
  check_new_vars enable "$FLAG_OFF"
  [[ "$(container_started "$DOCS")" == "$docs_started" ]] \
    && result "enable: documents не перезапускался" ok "StartedAt прежний" \
    || result "enable: documents не перезапускался" FAIL "StartedAt изменился"
  [[ "$(http_code "$PORT_APP" /ready)" == 200 ]] \
    && result "enable: app отвечает с хоста" ok "200" \
    || result "enable: app отвечает с хоста" FAIL "нет 200"
  ! grep -q 'up -d --no-deps documents' "$OUT/enable.log" \
    && result "enable: пересоздан только app" ok "в журнале нет up documents" \
    || result "enable: пересоздан только app" FAIL "есть запись про documents"
  if load_placed; then
    cli_run find --json
    [[ "$CLI_RC" == 0 ]] && grep -qF "\"sha256\":\"$FRESH_SHA\"" <<<"$CLI_OUT" \
      && result "enable: при выключенном хранении сохранённая запись видна через find" ok \
        "доживает свой срок" \
      || result "enable: при выключенном хранении сохранённая запись видна через find" FAIL \
        "код $CLI_RC, записи нет"
  else
    result "enable: при выключенном хранении сохранённая запись видна через find" FAIL \
      "нет состояния шага apply"
  fi
  flags_run enable_rollback --rollback
  [[ "$RC" == 0 ]] && cmp -s "$DEPLOY/.env" "$OUT/env.before-enable" \
    && result "enable: --rollback возвращает .env побайтно" ok "код 0" \
    || result "enable: --rollback возвращает .env побайтно" FAIL "$RC (enable_rollback.log)"
  check_new_vars "enable после отката" "$FLAG_ON"
  # Синтетический .env возвращается к состоянию prepare.
  cp -p "$OUT/env.keep" "$DEPLOY/.env"
  intake_same enable
  check_no_names enable
}

step_rollback() {
  [[ -n "${RUN_APPLIED:-}" ]] || RUN_APPLIED="$(readlink -f "$OUT/home/patch-9s-latest")"
  patch_run rollback --rollback --run-dir "$RUN_APPLIED"
  [[ "$RC" == 0 ]] && result "rollback: код" ok "0 (rollback.log)" \
    || result "rollback: код" FAIL "$RC (rollback.log)"
  unchanged_since_prepare rollback
  docs_is_old rollback
  docs_untouched rollback
  [[ "$(container_image "$APP")" == "$(lock_ref "$STAND_LOCK_OLD" BAI_IMAGE_APP)" ]] \
    && result "rollback: app на прежнем образе" ok "образ G9r" \
    || result "rollback: app на прежнем образе" FAIL "$(container_image "$APP")"
  check_docs_flags rollback "после отката"
  check_old_vars rollback "после отката"
  [[ -z "$(new_flags_present)" ]] \
    && result "rollback: у app снова нет новых переменных (compose G9r)" ok "отсутствуют" \
    || result "rollback: у app снова нет новых переменных (compose G9r)" FAIL "остались"
  [[ "$(http_code "$PORT_APP" /ready)" == 200 && "$(http_code "$PORT_DOCS" /health)" == 200 ]] \
    && result "rollback: documents и app отвечают с хоста" ok "200 и 200" \
    || result "rollback: documents и app отвечают с хоста" FAIL "нет 200"
  sleep "$SETTLE_S"
  [[ "$(pages_from_host)" == "$PAGES_STATUS $PAGES_ERROR" ]] \
    && result "rollback: POST $PAGES_ROUTE отвечает как образ G9r" ok \
      "$PAGES_STATUS $PAGES_ERROR" \
    || result "rollback: POST $PAGES_ROUTE отвечает как образ G9r" FAIL \
      "иной ответ: $(pages_from_host)"
  grep -q 'откатом не удаляются' "$OUT/rollback.log" \
    && result "rollback: журнал сообщает, что файлы архива откатом не удаляются" ok \
      "запись в журнале" \
    || result "rollback: журнал сообщает, что файлы архива откатом не удаляются" FAIL \
      "нет записи в журнале"
  cli_run stats
  [[ "$CLI_RC" != 0 ]] \
    && result "rollback: в прежнем образе команды архива снова нет" ok "код $CLI_RC" \
    || result "rollback: в прежнем образе команды архива снова нет" FAIL "команда отработала"
  if load_placed; then
    [[ "$(app_bun "$JS_ARCH_STATE" "ARCH_PATH=$FRESH_PATH" "ARCH_SHA=$FRESH_SHA" \
      | tail -n 1)" == ok ]] \
      && result "rollback: файл и запись архива остались в томе (sha256 тот же)" ok \
        "откат их не удаляет" \
      || result "rollback: файл и запись архива остались в томе (sha256 тот же)" FAIL \
        "файла или записи нет"
  else
    result "rollback: файл и запись архива остались в томе (sha256 тот же)" FAIL \
      "нет состояния шага apply"
  fi
  [[ "$(mode_of "$ARCHIVE_SUB")" == *" own dir" ]] \
    && result "rollback: подкаталог $ARCHIVE_SUB в томе на месте" ok "каталог app" \
    || result "rollback: подкаталог $ARCHIVE_SUB в томе на месте" FAIL "$(mode_of "$ARCHIVE_SUB")"
  intake_same rollback
  check_no_names rollback
}

# Явный выключатель в .env боя: патч не отказывает, .env не меняет, функция остаётся выключенной,
# подкаталог архива не создаётся.
step_offswitch() {
  local removed
  # Подкаталог архива остался от прежних шагов (откат его не удаляет): убирается из ТОМА СТЕНДА,
  # чтобы проверить, что патч с выключенным хранением его не создаёт.
  removed="$(app_bun "$JS_RM_ARCH" | tail -n 1)"
  [[ "$removed" == ok && "$(mode_of "$ARCHIVE_SUB")" == absent ]] \
    && result "offswitch: подкаталог $ARCHIVE_SUB убран из тома стенда перед патчем" ok "его нет" \
    || result "offswitch: подкаталог $ARCHIVE_SUB убран из тома стенда перед патчем" FAIL \
      "ответ: ${removed:-нет}"
  printf '%s=%s\n' "$VAR_STORE" "$FLAG_OFF" >>"$DEPLOY/.env"
  cp -p "$DEPLOY/.env" "$OUT/env.offswitch"
  patch_run offswitch
  [[ "$RC" == 0 ]] && result "offswitch: код (патч не отказывает при явном false)" ok \
    "0 (offswitch.log)" \
    || result "offswitch: код (патч не отказывает при явном false)" FAIL "$RC (offswitch.log)"
  [[ "$(container_image "$APP")" == "$(lock_ref "$STAND_LOCK_NEW" BAI_IMAGE_APP)" ]] \
    && result "offswitch: app на новом образе" ok "как при обычном патче" \
    || result "offswitch: app на новом образе" FAIL "$(container_image "$APP")"
  cmp -s "$DEPLOY/.env" "$OUT/env.offswitch" \
    && result "offswitch: .env боя патч не менял" ok "побайтно прежний" \
    || result "offswitch: .env боя патч не менял" FAIL "различается"
  check_new_vars offswitch "$FLAG_OFF"
  grep -q "$VAR_STORE выключено выключателем" "$OUT/offswitch.log" \
    && result "offswitch: журнал называет $VAR_STORE выключенной выключателем" ok \
      "запись в журнале" \
    || result "offswitch: журнал называет $VAR_STORE выключенной выключателем" FAIL \
      "нет записи"
  grep -q "подкаталог $ARCHIVE_SUB не создавался" "$OUT/offswitch.log" \
    && result "offswitch: журнал: подкаталог архива при выключенном хранении не создавался" ok \
      "запись в журнале" \
    || result "offswitch: журнал: подкаталог архива при выключенном хранении не создавался" FAIL \
      "нет записи"
  [[ "$(mode_of "$ARCHIVE_SUB")" == absent ]] \
    && result "offswitch: подкаталог $ARCHIVE_SUB в томе НЕ создан" ok "его нет" \
    || result "offswitch: подкаталог $ARCHIVE_SUB в томе НЕ создан" FAIL \
      "он создан: $(mode_of "$ARCHIVE_SUB")"
  intake_same offswitch
  patch_run offswitch_rollback --rollback --run-dir \
    "$(readlink -f "$OUT/home/patch-9s-latest")"
  cp -p "$OUT/env.keep" "$DEPLOY/.env"
  [[ "$RC" == 0 ]] && result "offswitch: откат патча, код" ok "0 (offswitch_rollback.log)" \
    || result "offswitch: откат патча, код" FAIL "$RC (offswitch_rollback.log)"
  unchanged_since_prepare offswitch
  intake_same "offswitch после отката"
  check_no_names offswitch
}

step_broken() {
  # Во время выдержки (в журнале патча появилась строка «выдержка») перезапускается documents:
  # проверка выдержки краснеет -> автооткат.
  local watcher
  : >"$OUT/broken.log"
  (
    watch_started=$SECONDS
    while ! grep -q 'выдержка' "$OUT/broken.log" 2>/dev/null \
      && ((SECONDS - watch_started < WATCH_TIMEOUT_S)); do
      sleep "$POLL_INTERVAL_S"
    done
    docker restart "$DOCS" >>"$OUT/broken-watcher.log" 2>&1 || true
  ) &
  watcher=$!
  patch_run broken
  wait "$watcher" 2>/dev/null || true
  [[ "$RC" == 1 ]] && result "broken: код" ok "1 (сбой, откат выполнен)" \
    || result "broken: код" FAIL "$RC (broken.log)"
  grep -q 'во время выдержки' "$OUT/broken.log" \
    && result "broken: причина - перезапуск во время выдержки" ok "запись в журнале" \
    || result "broken: причина - перезапуск во время выдержки" FAIL "нет записи"
  grep -q 'автоматический откат' "$OUT/broken.log" \
    && result "broken: автооткат запущен" ok "запись в журнале" \
    || result "broken: автооткат запущен" FAIL "нет записи"
  grep -q 'ОТКАТ ПАТЧА ВЫПОЛНЕН' "$OUT/broken.log" \
    && result "broken: откат выполнен и проверен" ok "проверки отката прошли" \
    || result "broken: откат выполнен и проверен" FAIL "нет записи об успешном откате"
  unchanged_since_prepare broken
  [[ "$(container_image "$APP")" == "$(lock_ref "$STAND_LOCK_OLD" BAI_IMAGE_APP)" \
    && "$(container_image "$DOCS")" == "$STUB_IMAGE_REF" ]] \
    && result "broken: app и documents снова на образах G9r" ok "как до патча" \
    || result "broken: app и documents снова на образах G9r" FAIL \
      "app $(container_image "$APP"), documents $(container_image "$DOCS")"
  intake_same broken
  check_no_names broken
}

step_cleanup() {
  dcs down -v --remove-orphans >/dev/null 2>&1 || true
  [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" ]] \
    && result "cleanup: контейнеры стенда убраны" ok "проект $PROJECT пуст" \
    || result "cleanup: контейнеры стенда убраны" FAIL "остались контейнеры"
  rm -rf "${PRIV:?}"
}

: >"$STEPS_FILE"
PKG="$OUT/package"
STUB_IMAGE_REF=""
DOCS_STARTED_BEFORE=""
run_step() { # run_step <шаг>: контекст и вызов шага
  case "$1" in
    prepare) mkdir -p "$PRIV"; step_prepare ;;
    preflight) restore_context; step_preflight ;;
    refuse) restore_context; step_refuse ;;
    apply) restore_context; step_apply ;;
    enable) restore_context; step_enable ;;
    rollback) restore_context; step_rollback ;;
    offswitch) restore_context; step_offswitch ;;
    broken) restore_context; step_broken ;;
    cleanup) step_cleanup ;;
    *) echo "неизвестный шаг $1" >&2; exit 2 ;;
  esac
}
for s in $STEPS; do
  log "=== шаг $s"
  # Шаг прерван (не выполнено предусловие): итог всё равно пишется, остальные шаги пропускаются.
  if ! run_step "$s"; then
    log "шаг $s прерван"
    ((FAILS > 0)) || FAILS=1
    break
  fi
done
TOTAL="$(wc -l <"$STEPS_FILE")"
{ echo "проверок: $TOTAL, провалено: $FAILS"; cat "$STEPS_FILE"; } >"$OUT/summary.txt"
log "итог: проверок $TOTAL, провалено $FAILS (summary.txt)"
[[ "$FAILS" -eq 0 ]]
