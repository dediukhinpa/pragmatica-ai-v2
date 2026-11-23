#!/usr/bin/env bash
# Патч G9s: ОДИН образ проекта app 1.1.10-pragmatika.2 и файл compose.project.yml (КРАСНАЯ ЗОНА:
# запускает только владелец на боевом хосте). Платформа остаётся 1.1.10, образ documents НЕ
# меняется и не пересоздаётся (остаётся образ G9r 1.1.10-pragmatika.1). Новое в app: каждый файл,
# присланный сотрудником любому боту в чат, сохраняется в томе приёма (подкаталог
# chat-attachments) на срок хранения для разбора ошибок и затем удаляется ежедневной задачей.
# Три новые переменные app (NEW_APP_VARS): CHAT_ATTACHMENTS_STORE_ENABLED (по умолчанию true,
# false - выключатель), CHAT_ATTACHMENTS_RETENTION_DAYS (по умолчанию 30) и
# CHAT_ATTACHMENTS_MAX_BYTES (по умолчанию 3221225472, 3 ГиБ). Все три в compose.project.yml
# имеют значения по умолчанию (`:-`); значение из .env боя сильнее. Патч .env не меняет: если
# хранение в .env явно выключено, оно остаётся выключенным (патч пишет это в журнал и результат).
# Изменить значения после патча - необязательный шаг runbook (enable-flags.sh). Файлы приёма
# прайсов (каталоги из 16 шестнадцатеричных знаков в корне тома) патч не трогает и не считает.
# Миграций БД нет. Ставится СТРОГО ПОСЛЕ патча G9r: lock боя 1.1.10-pragmatika.1, платформа
# 1.1.10, app и documents работают на образах из lock боя.
#
# Использование:
#   bash patch.sh [--preflight-only] [--signatures-verified ФАЙЛ] [--images-tar ФАЙЛ]
#                 [--config ФАЙЛ] [--out-dir КАТАЛОГ] [--soak-seconds N] [--expected-bots N]
#   bash patch.sh --rollback [--run-dir КАТАЛОГ]   откат применённого патча вручную
#   bash patch.sh --help
#
# Что делает (бой = compose-проект `pragmatika`, дерево /opt/pragmatika-v2/deploy; из файлов дерева
# заменяются ТОЛЬКО images.lock и compose.project.yml; остальные файлы compose, БД, миграции,
# alloy, nginx, mask, pseudonymizer, тома и секреты патч НЕ трогает; documents не пересоздаётся):
#   0. Предусловия, бой не меняется: целостность пакета (MANIFEST.sha256), подписи ВСЕХ образов
#      lock (cosign на хосте либо --signatures-verified: вывод verify-signatures.sh; по умолчанию
#      signatures.txt рядом с пакетом; молча пропускать нельзя), в пакете из файлов deploy/ ровно
#      compose.project.yml (любой другой файл, в том числе копия платформы, и миграции - отказ) и
#      в нём строки трёх новых переменных app со значениями по умолчанию, патч ещё не применён
#      (lock боя не равен lock пакета и версия не 1.1.10-pragmatika.2, иначе отказ: повторный
#      запуск ничего не меняет), патч G9r применён (BAI_VERSION lock боя 1.1.10-pragmatika.1,
#      платформа боя 1.1.10 и её копия с переменными записи звонка, запущенные app и documents
#      работают на образах из lock боя, в окружении app есть переменные G9r
#      (B24_CALL_RECORDING_MAX_BYTES, B24_CALL_RECORDING_TIMEOUT_MS), G9q3
#      (PRICE_FILE_ONCE_PER_TURN_ENABLED, STEP_TEXT_SEPARATE_ENABLED), G9q2
#      (EMPTY_REPLY_GUARD_ENABLED), G9q (PRICE_EDIT_DB_WRITE_ENABLED,
#      PRICE_EDIT_TEXT_BLOCKS_ENABLED), G9p (PRICE_EDIT_FIRST_ENABLED, DOCX_PAGES_ENABLED), G8z
#      (SHORTLIST_PAGING_ENABLED, SUPPLIER_DISCOVERY_ENABLED) и поиска G8w, в окружении documents
#      четыре флага G8x; иначе отказ с подсказкой «сначала примените патч G9r»), lock пакета
#      (BAI_VERSION 1.1.10-pragmatika.2) отличается от боевого ТОЛЬКО ключами BAI_VERSION и
#      BAI_IMAGE_APP (образ app обязан смениться, образ documents - остаться прежним), бой здоров
#      (/ready 200, ботов не меньше ожидаемого), том приёма смонтирован в app (INTAKE_ROOT из
#      окружения app, том intake-data) и доступен на запись пользователю app, свободны диск
#      (не меньше PATCH_MIN_DISK_MIB, 4096 МиБ) и память, образ app на хосте (docker load или
#      pull по digest), прежний (откатный) образ app на хосте есть. Примерка: compose с новыми
#      файлами и боевым .env собирается, у app новые переменные (NEW_APP_VARS) имеют эффективное
#      значение (из .env боя, иначе умолчание compose; значение из .env допустимо: хранение -
#      true/false, срок - целое 1..365 суток, предел - целое число байт не меньше 1), а вся прочая
#      конфигурация (app без образа и этих переменных, documents целиком вместе с образом и
#      остальные сервисы) совпадает со снимком боя до патча при одном и том же корне путей. Любое
#      нарушение - код 3, бой не тронут. Хранение, явно выключенное в .env боя, отказом не
#      является. С --preflight-only на этом всё.
#   1. Бэкап файлов дерева (весь каталог deploy, права сохраняются, .env 600) и снимок
#      контейнеров и образов: ~/backups/pragmatika-patch9s-<время>.
#   2. Замена compose.project.yml и images.lock, затем `up -d --no-deps app` (без down, без
#      --remove-orphans, без --force-recreate; простой app около 30 с; documents не трогается).
#   3. Проверки: образ app = lock (по digest), образ documents = lock и не перезапускался; в
#      окружении documents четыре флага G8x на месте (читаются только эти ключи, остальное
#      окружение и секреты не печатаются); проба POST /docx/pages с заведомо некорректным телом
#      (documents отвечает 422 bad_request, образ старше ручки - 404; в журнал идут только статус и
#      код ошибки); /ready app 200 и ботов не меньше ожидаемого; в окружении app новые переменные
#      на месте и равны эффективным значениям, переменные G9r, G9q3, G9q2, G9q, G9p, G8z и G8w не
#      потерялись; том приёма: в app (docker exec, одна проба на bun) подкаталог chat-attachments
#      создаётся (при выключенном хранении - только проверяется корень тома) и доступен на
#      запись, чужих (не от пользователя app) записей в нём нет; печатаются только слово ok или
#      fail с кодом и число чужих записей, содержимое тома и имена файлов не читаются и не
#      печатаются; маршруты стека не 404/405 (tools/check-routes.sh); выдержка (по умолчанию 2
#      минуты: documents и app не перезапускаются).
#   Любой сбой после начала изменений -> автоматический откат: compose.project.yml и images.lock
#      возвращаются из бэкапа, `up -d --no-deps app` на образ G9r (app 1.1.10-pragmatika.1; он же
#      запасной образ предусловия), проверяется /ready. Сохранённые файлы архива остаются в томе
#      приёма: откат их не удаляет (прежний образ подкаталог не читает, платформенная чистка
#      его не видит).
# Результат: ~/patch9s-<время>.tgz (журнал, проверки; без секретов и данных) - вернуть
# разработчику.
#
# Коды выхода: 0 - патч применён и проверен; 1 - сбой, откат выполнен (бой как до патча); 2 -
# неверный вызов; 3 - отказ по предусловиям, бой не тронут; 4 - сбой, откат тоже не удался
# (ручное вмешательство: OWNER-RUNBOOK.md, журнал).
set -euo pipefail
umask 077

# ---------------------------------------------------------------------------------------------
# Константы
# ---------------------------------------------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HERE/lib.sh" ]]; then
  PKG="$HERE" # пакет: всё рядом
  LIB="$HERE/lib.sh"
  ROUTES_TOOLS_DIR="$HERE/tools"
  ROUTES_MANIFEST="$HERE/routes.tsv"
  PKG_DEPLOY="$HERE/deploy"
  LOCK_SRC="$HERE/images.lock"
else
  PKG="$(cd "$HERE/../.." && pwd)" # дерево проекта (стенды и тесты)
  LIB="$HERE/../cutover/lib.sh"
  ROUTES_TOOLS_DIR="$PKG/tools"
  ROUTES_MANIFEST="$PKG/deploy/cutover/routes.tsv"
  PKG_DEPLOY="${PATCH9S_PKG_DEPLOY:-$PKG/deploy}" # каталог deploy пакета: файлы дерева патча
  LOCK_SRC="${PATCH9S_LOCK:-$PKG/deploy/images.lock}"
fi
# shellcheck source=../cutover/lib.sh
source "$LIB"
COSIGN_PUB="${PATCH9S_COSIGN_PUB:-$PKG/cosign.pub}"
[[ -f "$COSIGN_PUB" ]] || COSIGN_PUB="$PKG/deploy/cosign.pub"

# Файлы дерева, которые патч вправе заменить (пути относительно deploy/), кроме images.lock (он
# лежит в корне пакета). Чужой файл в пакете (в том числе deploy/images.lock) - отказ.
# ДОЛЖНО совпадать с DEPLOY_FILES в tools/build-patch-9s-package.sh.
PATCH_FILE_ALLOW=(compose.project.yml)
COMPOSE_PROJECT_FILE="compose.project.yml"
# Ключи lock, которые патч вправе менять: образ app и версия lock. Любой другой (образ documents,
# основы BAI_IMAGE_APP_BASE и BAI_IMAGE_DOCUMENTS_BASE, alloy, postgres, mask...) - отказ.
PATCH_LOCK_KEYS="BAI_VERSION BAI_IMAGE_APP"
LOCK_KEY_APP="BAI_IMAGE_APP"
LOCK_KEY_DOCUMENTS="BAI_IMAGE_DOCUMENTS"
LOCK_KEY_VERSION="BAI_VERSION"
DOCUMENTS_SERVICE="documents"
APP_SERVICE="app"
# Версия lock: боевая до патча (её ставит G9r) и целевая в пакете. Платформа не меняется.
LOCK_VERSION_FROM="1.1.10-pragmatika.1"
LOCK_VERSION_TO="1.1.10-pragmatika.2"
PLATFORM_VERSION_FILE="platform/PLATFORM-VERSION"
PLATFORM_VERSION_KEY="PLATFORM_PACKAGES_VERSION"
PLATFORM_BASE_FILE="platform/compose.base.yml"
PLATFORM_NOW="1.1.10"
G9R_HINT="сначала примените патч G9r (платформа ${PLATFORM_NOW}, lock ${LOCK_VERSION_FROM})"
# Новые переменные app от этого патча (ИМЯ=значение по умолчанию в compose.project.yml). Эффективное
# значение = значение из .env (затем secrets.env), иначе умолчание; до и после замены app
# сверяется именно оно. Изменить значения после патча - enable-flags.sh. При смене имени или
# умолчания править только эти строки (и допустимые пределы ниже).
VAR_STORE="CHAT_ATTACHMENTS_STORE_ENABLED"
VAR_DAYS="CHAT_ATTACHMENTS_RETENTION_DAYS"
VAR_BYTES="CHAT_ATTACHMENTS_MAX_BYTES"
NEW_APP_VARS=(CHAT_ATTACHMENTS_STORE_ENABLED=true CHAT_ATTACHMENTS_RETENTION_DAYS=30
  CHAT_ATTACHMENTS_MAX_BYTES=3221225472)
NEW_VAR_NAMES=("${NEW_APP_VARS[@]%%=*}")
# Хранение: true включает (по умолчанию), false выключает; допустимые слова - как у прочих флагов.
STORE_ON_WORDS="1 true on yes"
STORE_OFF_WORDS="0 false off no"
# Допустимые значения из .env боя: срок в сутках и предел объёма в байтах (целые).
DAYS_MIN=1
DAYS_MAX=365
BYTES_MIN=1
BYTES_MAX_DIGITS=15
VALUE_SHOW_LEN=40
# Значение из окружения запуска сильнее .env и compose: сброс, чтобы эффективное значение
# определялось только файлами дерева (переменная, экспортированная в оболочке владельца, иначе
# подменила бы и выключатель, и значение по умолчанию). Список KEEP_APP_KEYS - ниже.
# Ожидаемые значения новых переменных (ИМЯ=значение), заполняются в stage_tree.
EXPECT_VARS=()
# Переменные app от патча G9r (запись звонка Bitrix24, значения по умолчанию платформы 1.1.10):
# признак, что G9r применён (значения этим патчем не меняются, при замене app не должны потеряться).
G9R_APP_KEYS=(B24_CALL_RECORDING_MAX_BYTES B24_CALL_RECORDING_TIMEOUT_MS)
# Переменные платформы 1.1.10 в копии compose.base.yml боя: по ним видно, что G9r применён.
PLATFORM_NEW_VARS=(B24_CALL_RECORDING_MAX_BYTES B24_CALL_RECORDING_TIMEOUT_MS)
# Флаги app от патча G9q3 (значения не меняются; явный false в .env боя - выключатель владельца).
G9Q3_APP_FLAGS=(PRICE_FILE_ONCE_PER_TURN_ENABLED STEP_TEXT_SEPARATE_ENABLED)
# Переменная app от патча G9q2: то же (должна остаться при замене app).
G9Q2_APP_FLAGS=(EMPTY_REPLY_GUARD_ENABLED)
# Переменные app от патча G9q: то же.
G9Q_APP_FLAGS=(PRICE_EDIT_DB_WRITE_ENABLED PRICE_EDIT_TEXT_BLOCKS_ENABLED)
# Переменные app от патча G9p: то же.
G9P_APP_FLAGS=(PRICE_EDIT_FIRST_ENABLED DOCX_PAGES_ENABLED)
# Переменные app от патча G8z: то же.
G8Z_APP_FLAGS=(SHORTLIST_PAGING_ENABLED SUPPLIER_DISCOVERY_ENABLED)
# Переменные app от патча G8w: признак, что G8w применён (значения не меняются, при замене app
# не должны потеряться).
G8W_APP_KEYS=(YANDEX_SEARCH_MAX_CONCURRENCY YANDEX_SEARCH_MIN_INTERVAL_MS)
# Все переменные app, которые обязаны быть до патча и остаться после (только наличие).
KEEP_APP_KEYS=("${G9R_APP_KEYS[@]}" "${G9Q3_APP_FLAGS[@]}" "${G9Q2_APP_FLAGS[@]}"
  "${G9Q_APP_FLAGS[@]}" "${G9P_APP_FLAGS[@]}" "${G8Z_APP_FLAGS[@]}" "${G8W_APP_KEYS[@]}")
KEEP_APP_TITLE="G9r, G9q3, G9q2, G9q, G9p, G8z или G8w"
unset "${NEW_VAR_NAMES[@]}" "${KEEP_APP_KEYS[@]}"
# Том приёма: корень берётся из окружения app (INTAKE_ROOT), том называется intake-data (compose
# добавляет к имени префикс проекта, поэтому сверяется окончание). Подкаталог архива файлов чата -
# chat-attachments. Файлы приёма прайсов (каталоги из 16 шестнадцатеричных знаков в корне тома)
# патч не трогает и не считает.
INTAKE_ROOT_KEY="INTAKE_ROOT"
INTAKE_ROOT_RE='^/[A-Za-z0-9_./-]+$'
INTAKE_SUBDIR="chat-attachments"
INTAKE_VOLUME_SUFFIX="intake-data"
# Проба тома внутри app (bun есть в образе app: им же работают пробы documents). Печатает ровно
# одну строку: «ok <число чужих записей>» либо «fail <код>»; имена файлов и содержимое не
# читаются и не печатаются. Режим создания (PATCH_INTAKE_CREATE=1) делает mkdir -p подкаталога,
# проверяет запись и считает записи в подкаталоге, принадлежащие не пользователю app (число,
# имён нет); без создания проверяется только запись в корень тома.
INTAKE_JS="try {
  const fs = await import('node:fs');
  const root = process.env.PATCH_INTAKE_ROOT ?? '';
  const sub = root + '/' + (process.env.PATCH_INTAKE_SUB ?? '');
  const reply = (text) => { console.log(text); process.exit(0); };
  let isDir = false;
  try { isDir = fs.statSync(root).isDirectory(); } catch (e) { isDir = false; }
  if (!isDir) reply('fail no_root');
  try { fs.accessSync(root, fs.constants.W_OK); } catch (e) { reply('fail root_not_writable'); }
  if (process.env.PATCH_INTAKE_CREATE !== '1') reply('ok 0');
  try { fs.mkdirSync(sub, { recursive: true }); } catch (e) { reply('fail mkdir'); }
  try { fs.accessSync(sub, fs.constants.W_OK | fs.constants.X_OK); }
  catch (e) { reply('fail sub_not_writable'); }
  const uid = process.getuid();
  let foreign = fs.statSync(sub).uid === uid ? 0 : 1;
  for (const name of fs.readdirSync(sub)) {
    if (fs.lstatSync(sub + '/' + name).uid !== uid) foreign += 1;
  }
  reply('ok ' + foreign);
} catch (e) { console.log('fail error'); }"
INTAKE_REPLY_RE='^(ok [0-9]+|fail [a-z_]+)$'
# Флаги documents от патча G8x (ИМЯ=значение): признак «G8x применён» и то, что не должно
# потеряться при пересоздании documents. Больше никакие переменные documents не читаются.
DOCS_FLAGS=(DOCUMENTS_EDIT_PPTX=true DOCUMENTS_EDIT_PDF=true DOCUMENTS_PPT_CONVERT=true
  DOCUMENTS_EDIT_PDF_FALLBACK_FONT=false)
# Адрес documents в окружении app (по нему идут и пробы), если ключ в окружении не найден.
DOCUMENTS_URL_KEY="DOCUMENTS_URL"
DOCUMENTS_URL_DEFAULT="http://documents:8310"
# Пробы documents: из одноразового контейнера в сети app (адрес берётся из PATCH_DOCS_URL).
# /health: 200.
DOCS_HEALTH_JS="try {
  const base = process.env.PATCH_DOCS_URL ?? '$DOCUMENTS_URL_DEFAULT';
  const r = await fetch(base + '/health');
  console.log(r.status + ' ' + (await r.text()));
  process.exit(r.ok ? 0 : 1);
} catch (e) { console.log('documents недоступен: ' + e.message); process.exit(1); }"
# Проба POST /docx/pages с заведомо некорректным телом (content_base64 не base64): файл не
# разбирается, LibreOffice не запускается, спул не занимается. Ручка у documents с G9p и она же у
# G9s (documents не меняется): образ отвечает 422 с detail.error=bad_request (CONTRACT-9p.md),
# образ старше ручки не знает: 404.
# Ожидаемые статус и код ошибки сверяются с настоящим образом на стенде и при расхождении
# переопределяются окружением (PATCH9S_PAGES_PROBE_STATUS, PATCH9S_PAGES_PROBE_ERROR). В журнал
# идут ТОЛЬКО статус и код ошибки, тело ответа не печатается: код ошибки выводится лишь если он
# похож на идентификатор.
PAGES_ROUTE_PATH="/docx/pages"
PAGES_PROBE_BODY='{"file_name":"probe.docx","content_base64":"%%%"}'
PAGES_PROBE_STATUS="${PATCH9S_PAGES_PROBE_STATUS:-422}"
PAGES_PROBE_ERROR="${PATCH9S_PAGES_PROBE_ERROR:-bad_request}"
PAGES_ERROR_MAX_LEN=64
PAGES_ERROR_RE="^[a-z][a-z0-9_]{0,$((PAGES_ERROR_MAX_LEN - 1))}\$"
PAGES_ROUTE_JS="try {
  const base = process.env.PATCH_DOCS_URL ?? '$DOCUMENTS_URL_DEFAULT';
  const r = await fetch(base + '$PAGES_ROUTE_PATH', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: process.env.PATCH_PAGES_BODY });
  let code = '-';
  try {
    const detail = (await r.json())?.detail;
    const raw = typeof detail === 'object' && detail !== null ? detail.error : undefined;
    if (typeof raw === 'string' && /$PAGES_ERROR_RE/.test(raw)) code = raw;
  } catch (e) { code = '-'; }
  console.log(r.status + ' ' + code);
} catch (e) { console.log('documents недоступен: ' + e.message); process.exit(1); }"
DEFAULT_SOAK_S=120
SOAK_POLL_S=${PATCH9S_SOAK_POLL_S:-15}
DEPLOYED_MARK=".cutover-deployed"
BACKUP_PREFIX="pragmatika-patch9s"
ARCHIVE_PREFIX="patch9s"
RUN_PREFIX="patch-9s"
# Права .env в бэкапе должны совпасть с боевыми (600).
ENV_FILE_NAME=".env"
# Запасы: свободный диск под новый образ app (МиБ), доступная память (МиБ).
PATCH_MIN_DISK_MIB="${PATCH9S_MIN_DISK_MIB:-4096}"
PATCH_MIN_AVAILABLE_MIB="${PATCH9S_MIN_AVAILABLE_MIB:-1024}"
# Состояние для отката (state.env запуска): PATCH_STARTED, BACKUP_DIR, LIVE_DEPLOY, FILE_REPLACED.
ROLLBACK_MODE=0
RUN_DIR_ARG=""

# ---------------------------------------------------------------------------------------------
# Аргументы и настройка
# ---------------------------------------------------------------------------------------------
SIGNATURES_FILE=""
IMAGES_TAR=""
CONFIG_FILE=""
SOAK_S="$DEFAULT_SOAK_S"
PREFLIGHT_ONLY=0
EXPECT_BOTS_ARG=""
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
while (($#)); do
  case "$1" in
    --signatures-verified) SIGNATURES_FILE="${2:?--signatures-verified ФАЙЛ}"; shift ;;
    --images-tar) IMAGES_TAR="${2:?--images-tar ФАЙЛ}"; shift ;;
    --config) CONFIG_FILE="${2:?--config ФАЙЛ}"; shift ;;
    --out-dir) CUTOVER_OUT_DIR="${2:?--out-dir КАТАЛОГ}"; shift ;;
    --soak-seconds) SOAK_S="${2:?--soak-seconds N}"; shift ;;
    --expected-bots) EXPECT_BOTS_ARG="${2:?--expected-bots N}"; shift ;;
    --preflight-only) PREFLIGHT_ONLY=1 ;;
    --rollback) ROLLBACK_MODE=1 ;;
    --run-dir) RUN_DIR_ARG="${2:?--run-dir КАТАЛОГ}"; shift ;;
    --help | -h) usage; exit "$EXIT_OK" ;;
    *) echo "неизвестный аргумент: $1" >&2; usage >&2; exit "$EXIT_USAGE" ;;
  esac
  shift
done
[[ "$SOAK_S" =~ ^[0-9]+$ ]] || { echo "--soak-seconds: нужно число" >&2; exit "$EXIT_USAGE"; }
[[ -z "$EXPECT_BOTS_ARG" || "$EXPECT_BOTS_ARG" =~ ^[0-9]+$ ]] \
  || { echo "--expected-bots: нужно число" >&2; exit "$EXIT_USAGE"; }
if ((PREFLIGHT_ONLY && ROLLBACK_MODE)); then
  echo "--preflight-only и --rollback несовместимы" >&2
  exit "$EXIT_USAGE"
fi
[[ -n "$SIGNATURES_FILE" || ! -f "$HERE/signatures.txt" ]] || SIGNATURES_FILE="$HERE/signatures.txt"

[[ -z "$CONFIG_FILE" ]] || cut_load_config "$CONFIG_FILE" || exit "$EXIT_USAGE"
if ((ROLLBACK_MODE)); then
  # Откат вручную: настройка берётся из каталога запуска патча (patch.conf), если он есть.
  CUTOVER_HOME="${CUTOVER_HOME:-$HOME/.pragmatika-cutover}"
  RUN_DIR_ARG="${RUN_DIR_ARG:-$CUTOVER_HOME/$RUN_PREFIX-latest}"
  [[ -d "$RUN_DIR_ARG" ]] || { echo "нет каталога запуска: $RUN_DIR_ARG" >&2; exit "$EXIT_USAGE"; }
  [[ ! -f "$RUN_DIR_ARG/patch.conf" ]] || cut_load_config "$RUN_DIR_ARG/patch.conf"
fi
[[ -z "$EXPECT_BOTS_ARG" ]] || CUTOVER_EXPECT_BOTS="$EXPECT_BOTS_ARG"
cut_defaults

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$CUTOVER_HOME"
if ((ROLLBACK_MODE)); then
  RUN_DIR_ORIG="$(cd "$RUN_DIR_ARG" && pwd)"
  cut_init_run "$CUTOVER_HOME/$RUN_PREFIX-rollback-$RUN_ID"
else
  cut_init_run "$CUTOVER_HOME/$RUN_PREFIX-$RUN_ID"
  ln -sfn "$RUN_DIR" "$CUTOVER_HOME/$RUN_PREFIX-latest"
fi
ARCHIVE_PATH=""
ROLLED_BACK=0
LIVE_NEW_DIR="$CUTOVER_NEW_DIR"
LIVE_DEPLOY="$LIVE_NEW_DIR/deploy"
# Контейнер documents (имя берётся при проверке предусловий) и его StartedAt до замены (patch его
# не пересоздаёт: StartedAt обязан остаться прежним).
DOCS_NAME=""
DOCS_STARTED_BEFORE=""

die() { # die <код> <сообщение...>: слова сообщения склеиваются пробелом
  local code="$1"
  shift
  log "ОШИБКА: $*"
  state_set RESULT "FAILED: $*"
  exit "$code"
}

# refuse <сообщение>: отказ по предусловиям, бой не тронут. После начала изменений - сбой
# хода (код 1): on_exit выполнит откат.
refuse() {
  check "предусловия" fail "$*"
  if [[ "$(state_get PATCH_STARTED)" == 1 ]]; then die "$EXIT_FAILED" "$*"; fi
  die "$EXIT_REFUSED" "отказ: $*"
}

# Настройка запуска для --rollback (без секретов: пути и числа).
save_config() {
  local name
  : >"$RUN_DIR/patch.conf"
  for name in $(compgen -v CUTOVER_); do
    [[ "$name" =~ ^CUTOVER_(ALERTS_URL|SECRETS_DIR)?$ ]] && continue
    printf '%s=%s\n' "$name" "${!name}" >>"$RUN_DIR/patch.conf"
  done
}

# ---------------------------------------------------------------------------------------------
# Итог и уборка (всегда, при любом выходе)
# ---------------------------------------------------------------------------------------------
# Значения секретов боя в список маскирования журнала: только значения, имена не нужны.
collect_secret_values() {
  local secrets_dir file
  secrets_dir="${CUTOVER_SECRETS_DIR:-$(env_value "$CUTOVER_ENV_FILE" SECRETS_DIR)}"
  secrets_dir="${secrets_dir:-/etc/pragmatika/secrets}"
  for file in "$CUTOVER_ENV_FILE" "$LIVE_DEPLOY/.env" "$secrets_dir/secrets.env" \
    "$LIVE_DEPLOY/$MASK_TOKEN_FILE_NAME"; do
    [[ -f "$file" ]] || continue
    python3 -I - "$file" "$MIN_SECRET_LEN" >>"$SECRETS_LIST" <<'PY'
import re, sys
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    if "=" not in line or line.lstrip().startswith("#"):
        continue
    name, raw = line.split("=", 1)
    if not re.search(r"(KEY|TOKEN|PASSWORD|SECRET)", name):
        continue
    raw = raw.strip()
    if raw[:1] in "'\"" and raw[-1:] == raw[:1]:
        raw = raw[1:-1]
    if len(raw) >= int(sys.argv[2]):
        print(raw)
PY
  done
}

# Архив результатов ~/patch9s-<время>.tgz; значение секрета в нём - архив удаляется.
finish_results() {
  local files
  cp "$STATE_FILE" "$RES/state.env" 2>/dev/null || true
  ARCHIVE_PATH="$CUTOVER_OUT_DIR/$ARCHIVE_PREFIX-$RUN_ID.tgz"
  tar -C "$RUN_DIR" -czf "$ARCHIVE_PATH" results 2>/dev/null || { ARCHIVE_PATH=""; return 0; }
  if [[ -s "$SECRETS_LIST" ]] && files="$(mktemp -d "$WORK/leak.XXXXXX")"; then
    tar -C "$files" -xzf "$ARCHIVE_PATH"
    if grep -rIqF -f <(awk 'length($0) >= '"$MIN_SECRET_LEN" "$SECRETS_LIST") "$files"; then
      rm -f "$ARCHIVE_PATH"
      ARCHIVE_PATH=""
      echo "ОШИБКА: в архиве результатов найдено значение секрета, архив удалён" >&2
    fi
  fi
}

on_exit() {
  local rc=$?
  trap - EXIT INT TERM
  set +e
  if ((rc != EXIT_OK && rc != EXIT_REFUSED && rc != EXIT_USAGE && ROLLBACK_MODE == 0)); then
    if [[ "$(state_get PATCH_STARTED)" == 1 && "$ROLLED_BACK" != 1 ]]; then
      log "СБОЙ: запускаю автоматический откат патча"
      ROLLED_BACK=1
      if rollback_patch "$RUN_DIR"; then
        rc="$EXIT_FAILED"
      else
        rc="$EXIT_STUCK"
        log "ОТКАТ НЕ УДАЛСЯ: нужно ручное вмешательство (OWNER-RUNBOOK.md, журнал)"
      fi
    fi
  fi
  finish_results
  if [[ "$rc" == "$EXIT_OK" ]]; then
    log "ГОТОВО. Архив результатов: ${ARCHIVE_PATH:-не создан}"
  else
    log "ЗАВЕРШЕНО С КОДОМ $rc. Архив результатов: ${ARCHIVE_PATH:-не создан}"
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------------------------------------
# Вспомогательное
# ---------------------------------------------------------------------------------------------
dir_free_mib() { df -Pm "$1" 2>/dev/null | awk 'NR == 2 { print $4 }'; }
mem_available_mib() { awk '/^MemAvailable:/ { print int($2 / '"$KIB_PER_MIB"') }' /proc/meminfo; }

# service_containers <сервис>: имена контейнеров сервиса compose-проекта (включая остановленные).
service_containers() {
  docker ps -a --filter "label=com.docker.compose.project=$CUTOVER_PROJECT" \
    --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | sort
}

# lock_ref <ключ>: ссылка образа (или версия) из lock пакета (пусто, если ключа нет).
lock_ref() { lock_value "$LOCK_SRC" "$1" || true; }
# live_lock_ref <ключ>: значение из lock боя (пусто, если ключа нет).
live_lock_ref() { lock_value "$LIVE_DEPLOY/images.lock" "$1" || true; }

# container_env_value <контейнер> <ИМЯ>: значение ОДНОЙ переменной окружения контейнера. Остальное
# окружение (секреты) не читается дальше sed и нигде не печатается.
container_env_value() {
  { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null || true; } \
    | sed -n "s/^$2=//p" | head -1
}

# container_started <контейнер>: время старта контейнера (State.StartedAt), пусто при ошибке.
container_started() { docker inspect -f '{{.State.StartedAt}}' "$1" 2>/dev/null || true; }
# container_restarts <контейнер>: счётчик перезапусков политики restart.
container_restarts() { docker inspect -f '{{.RestartCount}}' "$1" 2>/dev/null || echo "?"; }
# container_image_id <контейнер>: id образа, на котором запущен контейнер.
container_image_id() { docker inspect -f '{{.Image}}' "$1" 2>/dev/null || true; }
# ref_image_id <ссылка>: id образа по ссылке на хосте; «?», если образа нет.
ref_image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || echo "?"; }

# docs_probe <JS>: одноразовый контейнер в сети app (образ с bun берётся у самого app); печатает
# вывод пробы. Адрес documents - из окружения app, иначе умолчание платформы; тело пробы pages
# передаётся переменной окружения PATCH_PAGES_BODY.
docs_probe() {
  local image url
  image="$(container_image_id "$CUTOVER_APP_CONTAINER")"
  [[ -n "$image" ]] || { echo "нет контейнера $CUTOVER_APP_CONTAINER"; return 1; }
  url="$(container_env_value "$CUTOVER_APP_CONTAINER" "$DOCUMENTS_URL_KEY")"
  docker run --rm --network "container:$CUTOVER_APP_CONTAINER" --memory "$ONESHOT_MEM" \
    -e "PATCH_DOCS_URL=${url:-$DOCUMENTS_URL_DEFAULT}" -e "PATCH_PAGES_BODY=$PAGES_PROBE_BODY" \
    --entrypoint bun "$image" -e "$1" 2>&1
}

# docs_health_wait <секунд>: ждёт 200 на /health documents; последний ответ в DOCS_HEALTH_BODY.
DOCS_HEALTH_BODY=""
docs_health_wait() {
  local waited=0
  while ((waited < $1)); do
    if DOCS_HEALTH_BODY="$(docs_probe "$DOCS_HEALTH_JS")" && [[ "$DOCS_HEALTH_BODY" == 200* ]]; then
      return 0
    fi
    sleep "$POLL_S"
    waited=$((waited + POLL_S))
  done
  return 1
}

# docs_flags_check <контейнер>: сверяет четыре флага G8x в окружении контейнера documents (читаются
# только эти ключи). FLAGS_REPORT - «ИМЯ=значение ...», FLAGS_BAD - названия не совпавших.
FLAGS_REPORT=""
FLAGS_BAD=""
docs_flags_check() {
  local item key got
  FLAGS_REPORT=""
  FLAGS_BAD=""
  for item in "${DOCS_FLAGS[@]}"; do
    key="${item%%=*}"
    got="$(container_env_value "$1" "$key")"
    FLAGS_REPORT+=" $key=${got:-<нет>}"
    [[ "${got,,}" == "${item#*=}" ]] || FLAGS_BAD+=" $key"
  done
  FLAGS_REPORT="${FLAGS_REPORT# }"
  FLAGS_BAD="${FLAGS_BAD# }"
}

# ---------------------------------------------------------------------------------------------
# 0. Предусловия (бой не меняется)
# ---------------------------------------------------------------------------------------------
check_sources() {
  phase "целостность пакета и источников"
  command -v docker >/dev/null || refuse "нет docker"
  if [[ -f "$HERE/MANIFEST.sha256" ]]; then
    (cd "$HERE" && sha256sum -c --quiet MANIFEST.sha256) >>"$LOG_FILE" 2>&1 \
      || refuse "MANIFEST.sha256 не сходится: пакет повреждён или изменён"
    check "целостность пакета" ok "MANIFEST.sha256 сходится"
  else
    check "целостность пакета" warn "MANIFEST.sha256 нет (запуск из дерева проекта)"
  fi
  [[ -f "$LOCK_SRC" ]] || refuse "нет images.lock пакета ($LOCK_SRC)"
  cut_lock_format "$LOCK_SRC" || refuse "images.lock не в формате платформы (только digest)"
  cut_lock_has_mask "$LOCK_SRC" || refuse "в images.lock нет $LOCK_MASK_KEY"
  [[ -n "$(lock_ref "$LOCK_KEY_APP")" && -n "$(lock_ref "$LOCK_KEY_DOCUMENTS")" ]] \
    || refuse "в images.lock пакета нет $LOCK_KEY_APP или $LOCK_KEY_DOCUMENTS"
  [[ "$(lock_ref "$LOCK_KEY_VERSION")" == "$LOCK_VERSION_TO" ]] \
    || refuse "BAI_VERSION lock пакета '$(lock_ref "$LOCK_KEY_VERSION")'," \
      "ожидается $LOCK_VERSION_TO"
  [[ ! -e "$PKG/db" && ! -e "$HERE/stack/db" && ! -e "${PKG_DEPLOY:-/nonexistent}/db" ]] \
    || refuse "в патче есть каталог db: патч не должен менять БД и миграции"
  # Файлы дерева у G9s: только compose.project.yml (и images.lock из корня пакета). Любой другой
  # файл deploy/ в пакете (в том числе deploy/images.lock) - отказ; compose.project.yml обязан быть.
  local rel
  if [[ -d "$PKG_DEPLOY" ]]; then
    while IFS= read -r rel; do
      [[ " ${PATCH_FILE_ALLOW[*]} " == *" $rel "* ]] \
        || refuse "в пакете файл deploy/$rel: патч G9s заменяет только $COMPOSE_PROJECT_FILE" \
          "и images.lock"
    done < <(cd "$PKG_DEPLOY" && find . -mindepth 1 ! -type d | sed 's|^\./||' | sort)
  fi
  [[ -f "$PKG_DEPLOY/$COMPOSE_PROJECT_FILE" ]] \
    || refuse "в пакете нет deploy/$COMPOSE_PROJECT_FILE (новые переменные app)"
  # Три новые переменные app обязаны быть в compose.project.yml пакета со значениями по умолчанию.
  local missing_vars
  missing_vars="$(compose_missing_vars "$PKG_DEPLOY/$COMPOSE_PROJECT_FILE")"
  [[ -z "$missing_vars" ]] \
    || refuse "в $COMPOSE_PROJECT_FILE пакета нет строк новых переменных app вида" \
      "ИМЯ: \${ИМЯ:-умолчание}: $missing_vars (по умолчанию хранение должно быть включено)"
  [[ -f "$ROUTES_MANIFEST" && -f "$ROUTES_TOOLS_DIR/check-routes.sh" \
    && -f "$ROUTES_TOOLS_DIR/route-flags.tsv" ]] \
    || refuse "в пакете нет инструментов проверки (tools/, routes.tsv)"
  check "состав пакета" ok "lock ${LOCK_VERSION_TO}, инструменты проверки на месте," \
    "из файлов deploy только $COMPOSE_PROJECT_FILE"
}

# Подпись ВСЕХ образов lock. Молча пропускать нельзя.
check_signatures() {
  phase "подписи образов"
  local key ref msg failed=0
  if command -v "$CUTOVER_COSIGN" >/dev/null 2>&1 && [[ -f "$COSIGN_PUB" ]]; then
    while read -r key ref; do
      if "$CUTOVER_COSIGN" verify --key "$COSIGN_PUB" --insecure-ignore-tlog=true "$ref" \
        >>"$LOG_FILE" 2>&1; then
        log "подпись $key: OK"
      else
        log "подпись $key: НЕ ПРОШЛА"
        failed=$((failed + 1))
      fi
    done < <(lock_images "$LOCK_SRC")
    ((failed == 0)) || refuse "cosign verify не прошёл у $failed образов"
    check "подписи образов" ok "cosign verify на хосте: все образы lock"
    return 0
  fi
  [[ -n "$SIGNATURES_FILE" ]] \
    || refuse "нет cosign или cosign.pub и нет signatures.txt (--signatures-verified ФАЙЛ):" \
      "проверку подписей пропускать нельзя"
  [[ -f "$SIGNATURES_FILE" ]] || refuse "нет файла $SIGNATURES_FILE"
  if msg="$(cut_check_signatures_file "$SIGNATURES_FILE" "$LOCK_SRC" "$COSIGN_PUB")"; then
    check "подписи образов" ok "по подтверждению verify-signatures.sh: $msg"
  else
    refuse "подтверждение подписей не принято: $msg"
  fi
}

# Дерево боя на месте и создано выкаткой пакета (cutover.sh).
check_tree_present() {
  phase "боевое дерево"
  [[ -f "$LIVE_DEPLOY/compose.yml" && -f "$LIVE_DEPLOY/images.lock" \
    && -f "$LIVE_DEPLOY/$ENV_FILE_NAME" ]] \
    || refuse "в $LIVE_DEPLOY нет compose.yml, images.lock или .env: это не дерево v2"
  [[ -f "$LIVE_DEPLOY/$DEPLOYED_MARK" ]] \
    || refuse "в $LIVE_DEPLOY нет $DEPLOYED_MARK: дерево создано не cutover.sh"
  check "боевое дерево" ok "$LIVE_DEPLOY создано выкаткой пакета"
}

# platform_version <файл>: значение PLATFORM_PACKAGES_VERSION (пусто, если файла или строки нет).
platform_version() {
  [[ -f "$1" ]] || return 0
  sed -n "s/^$PLATFORM_VERSION_KEY=//p" "$1" | head -1
}

# Патч G9s ещё не применён: lock боя не равен lock пакета и не имеет целевой версии. Повторный
# запуск того же патча - отказ без изменений.
check_not_applied() {
  phase "патч G9s ещё не применён"
  local live_ver
  live_ver="$(live_lock_ref "$LOCK_KEY_VERSION")"
  if cmp -s "$LIVE_DEPLOY/images.lock" "$LOCK_SRC" || [[ "$live_ver" == "$LOCK_VERSION_TO" ]]; then
    refuse "патч G9s уже применён (lock боя ${live_ver:-?}, версия пакета $LOCK_VERSION_TO):" \
      "повторный запуск ничего не меняет"
  fi
  check "патч G9s ещё не применён" ok "lock боя ${live_ver:-?} отличается от пакета"
}

# Патч G9r применён: lock боя 1.1.10-pragmatika.1, платформа боя 1.1.10 (и её копия с переменными
# записи звонка), app и documents работают на образах из lock боя (documents на образе G9r), у
# documents четыре флага G8x, у app переменные G9r, G9q3, G9q2, G9q, G9p, G8z и поиска G8w.
check_g9r_applied() {
  phase "патч G9r применён"
  local ver live_ver key live_ref got want missing=""
  live_ver="$(live_lock_ref "$LOCK_KEY_VERSION")"
  [[ "$live_ver" == "$LOCK_VERSION_FROM" ]] \
    || refuse "BAI_VERSION lock боя '${live_ver:-?}', ожидается $LOCK_VERSION_FROM: $G9R_HINT"
  ver="$(platform_version "$LIVE_DEPLOY/$PLATFORM_VERSION_FILE")"
  [[ "$ver" == "$PLATFORM_NOW" ]] \
    || refuse "платформа боя '${ver:-?}', ожидается $PLATFORM_NOW: $G9R_HINT"
  for key in "${PLATFORM_NEW_VARS[@]}"; do
    grep -q "$key" "$LIVE_DEPLOY/$PLATFORM_BASE_FILE" 2>/dev/null \
      || missing+=" $key"
  done
  [[ -z "$missing" ]] \
    || refuse "в копии платформы боя ($PLATFORM_BASE_FILE) нет переменных платформы" \
      "$PLATFORM_NOW:$missing: $G9R_HINT"
  missing=""
  [[ -n "$(docker ps -q --filter "name=^${CUTOVER_APP_CONTAINER}\$")" ]] \
    || refuse "контейнер $CUTOVER_APP_CONTAINER не запущен"
  live_ref="$(live_lock_ref "$LOCK_KEY_APP")"
  got="$(container_image_id "$CUTOVER_APP_CONTAINER")"
  want="$(ref_image_id "$live_ref")"
  [[ -n "$got" && "$got" == "$want" ]] \
    || refuse "запущенный $CUTOVER_APP_CONTAINER не на образе из lock боя" \
      "(${live_ref##*/}): $G9R_HINT"
  for key in "${KEEP_APP_KEYS[@]}"; do
    [[ -n "$(container_env_value "$CUTOVER_APP_CONTAINER" "$key")" ]] || missing+=" $key"
  done
  [[ -z "$missing" ]] || refuse "в окружении $CUTOVER_APP_CONTAINER нет:$missing: $G9R_HINT"
  DOCS_NAME="$(service_containers "$DOCUMENTS_SERVICE" | head -1)"
  [[ -n "$DOCS_NAME" ]] || refuse "в проекте нет контейнера documents"
  live_ref="$(live_lock_ref "$LOCK_KEY_DOCUMENTS")"
  got="$(container_image_id "$DOCS_NAME")"
  want="$(ref_image_id "$live_ref")"
  [[ -n "$got" && "$got" == "$want" ]] \
    || refuse "запущенный $DOCS_NAME не на образе из lock боя (${live_ref##*/}): $G9R_HINT"
  docs_flags_check "$DOCS_NAME"
  [[ -z "$FLAGS_BAD" ]] \
    || refuse "в окружении $DOCS_NAME нет флагов G8x или они иные ($FLAGS_REPORT): $G9R_HINT"
  check "патч G9r применён" ok "lock $live_ver, платформа $ver, образы как в lock," \
    "переменные $KEEP_APP_TITLE у app и флаги G8x у documents на месте"
}

# lock боя отличается от пакетного только ключами патча (версия и образ app; образ documents
# остаётся прежним); файлы пакета только из списка.
check_changes() {
  phase "состав изменений"
  local live_lock="$LIVE_DEPLOY/images.lock" key old new changed="" rel
  while IFS='=' read -r key new; do
    [[ "$key" =~ ^BAI_ ]] || continue
    old="$(lock_value "$live_lock" "$key" || true)"
    [[ "$old" == "$new" ]] || changed+=" $key"
  done <"$LOCK_SRC"
  while IFS='=' read -r key old; do
    [[ "$key" =~ ^BAI_ ]] || continue
    [[ -n "$(lock_value "$LOCK_SRC" "$key")" ]] || changed+=" $key(удалён)"
  done <"$live_lock"
  for key in $changed; do
    [[ "${key%%(*}" != "$LOCK_KEY_DOCUMENTS" ]] \
      || refuse "lock пакета меняет образ documents ($LOCK_KEY_DOCUMENTS): G9s катит только app"
    [[ " $PATCH_LOCK_KEYS " == *" ${key%%(*} "* ]] \
      || refuse "lock пакета меняет $key: патч вправе менять только: $PATCH_LOCK_KEYS"
  done
  printf '%s\n' ${changed:-} >"$RES/lock-changes.txt"
  [[ -n "$changed" ]] \
    || refuse "нечего применять: lock боя уже совпадает с пакетом (патч применён?)"
  [[ " $changed " == *" $LOCK_KEY_APP "* ]] \
    || refuse "lock пакета не меняет образ app ($LOCK_KEY_APP): патчу нечего катить"
  # Файлы пакета: только из списка; отличающиеся от боевых - в список замены.
  PATCH_FILES=()
  while IFS= read -r rel; do
    [[ " ${PATCH_FILE_ALLOW[*]} " == *" $rel "* ]] \
      || refuse "в пакете файл $rel вне списка замены (${PATCH_FILE_ALLOW[*]})"
    [[ -f "$LIVE_DEPLOY/$rel" ]] && cmp -s "$PKG_DEPLOY/$rel" "$LIVE_DEPLOY/$rel" && continue
    PATCH_FILES+=("$rel")
  done < <(cd "$PKG_DEPLOY" && find . -type f | sed 's|^\./||' | sort)
  printf '%s\n' ${PATCH_FILES[@]+"${PATCH_FILES[@]}"} >"$RES/file-changes.txt"
  check "состав изменений" ok "lock:$changed; файлов дерева кроме lock: ${#PATCH_FILES[@]}" \
    "(${PATCH_FILES[*]:-})"
}

check_battle_health() {
  phase "бой здоров до начала"
  local body bots
  [[ -n "$(docker ps -q --filter "name=^${CUTOVER_APP_CONTAINER}\$")" ]] \
    || refuse "контейнер $CUTOVER_APP_CONTAINER не запущен"
  body="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
  [[ "$body" == 200* ]] || refuse "/ready боя не 200: ${body:0:120}"
  bots="$(ready_bots "$body")"
  ((bots >= CUTOVER_EXPECT_BOTS)) \
    || refuse "ботов $bots, ожидается не меньше $CUTOVER_EXPECT_BOTS (--expected-bots)"
  check "бой здоров" ok "/ready 200, ботов $bots"
}

check_resources() {
  phase "ресурсы"
  local docker_root free avail
  docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  free="$(dir_free_mib "$docker_root")"
  avail="$(mem_available_mib)"
  ((free >= PATCH_MIN_DISK_MIB)) \
    || refuse "мало места в $docker_root: свободно ${free} МиБ, нужно ${PATCH_MIN_DISK_MIB}"
  ((avail >= PATCH_MIN_AVAILABLE_MIB)) \
    || refuse "мало памяти: доступно ${avail} МиБ, нужно ${PATCH_MIN_AVAILABLE_MIB}"
  check "ресурсы" ok "диск ${free} МиБ, память ${avail} МиБ"
}

# Образ app из lock пакета - локально по digest (documents не меняется: его образ уже на хосте).
ensure_images() {
  phase "образ app"
  local ref key
  if [[ -n "$IMAGES_TAR" ]]; then
    [[ -f "$IMAGES_TAR" ]] || refuse "нет архива образов $IMAGES_TAR"
    log "загружаю образы из $IMAGES_TAR"
    docker load -i "$IMAGES_TAR" >>"$LOG_FILE" 2>&1 || refuse "docker load не удался"
  fi
  for key in "$LOCK_KEY_APP"; do
    ref="$(lock_ref "$key")"
    [[ "$ref" == *@sha256:* ]] || refuse "образ $key '$ref' без digest"
    if ! docker image inspect "$ref" >/dev/null 2>&1; then
      log "образ ${ref##*/} не найден локально, docker pull"
      docker pull "$ref" >>"$LOG_FILE" 2>&1 \
        || refuse "образ ${ref##*/} не найден: docker login или --images-tar"
    fi
    check "образ ${key#BAI_IMAGE_}" ok "${ref##*/} на хосте"
  done
}

# Прежний образ app (откатный, G9r) на хосте: без него автооткат невозможен. Образ documents
# не меняется и откатного образа не требует.
check_rollback_images() {
  phase "откатный образ app"
  local ref key
  for key in "$LOCK_KEY_APP"; do
    ref="$(live_lock_ref "$key")"
    [[ -n "$ref" ]] || refuse "в lock боя нет $key"
    docker image inspect "$ref" >/dev/null 2>&1 \
      || refuse "прежнего образа ${key#BAI_IMAGE_} ${ref##*/} нет на хосте: откат был бы невозможен"
    check "откатный образ ${key#BAI_IMAGE_}" ok "${ref##*/} на хосте"
  done
}

# compose_json <корень дерева>: `compose config` дерева одним JSON в stdout (секреты подставлены:
# выводить нельзя, только сравнивать). Пусто - конфигурация не собралась.
compose_json() {
  (
    CUTOVER_NEW_DIR="$1"
    dc_new --profile tools config --format json 2>/dev/null
  ) || true
}

# effective_var_value <ИМЯ> <умолчание>: значение переменной, которое увидит app: из .env боя, затем
# secrets.env (позже - сильнее, как порядок --env-file), пусто или нет ключа - умолчание compose.
effective_var_value() {
  local file value="" got
  for file in "$LIVE_DEPLOY/$ENV_FILE_NAME" "$LIVE_DEPLOY/secrets.env"; do
    got="$(env_value "$file" "$1")"
    [[ -z "$got" ]] || value="$got"
  done
  printf '%s' "${value:-$2}"
}

# valid_new_value <ИМЯ> <значение>: значение из .env боя такое, какое app примет: хранение -
# true/false (и 1/0, on/off, yes/no), срок - целое DAYS_MIN..DAYS_MAX, предел - целое не меньше
# BYTES_MIN не длиннее BYTES_MAX_DIGITS знаков. Иное значение остановило бы или исказило app.
valid_new_value() {
  case "$1" in
    "$VAR_STORE") [[ " $STORE_ON_WORDS $STORE_OFF_WORDS " == *" ${2,,} "* ]] ;;
    "$VAR_DAYS") [[ "$2" =~ ^[0-9]{1,4}$ ]] && ((10#$2 >= DAYS_MIN && 10#$2 <= DAYS_MAX)) ;;
    "$VAR_BYTES")
      [[ "$2" =~ ^[0-9]{1,$BYTES_MAX_DIGITS}$ ]] && ((10#$2 >= BYTES_MIN)) ;;
    *) return 1 ;;
  esac
}

# compose_missing_vars <файл>: новые переменные, для которых в файле нет строки
# `ИМЯ: ${ИМЯ:-умолчание}` (печатает «ИМЯ:-умолчание» через пробел; пусто - все на месте).
compose_missing_vars() {
  local item name def missing=""
  for item in "${NEW_APP_VARS[@]}"; do
    name="${item%%=*}"
    def="${item#*=}"
    grep -qE "^[[:space:]]+$name: \\\$\{$name:-$def\}[[:space:]]*\$" "$1" 2>/dev/null \
      || missing+=" $name:-$def"
  done
  printf '%s' "${missing# }"
}

# config_delta <JSON боя до патча> <JSON после патча> <корень боя> <корень примерки>
# <ИМЯ=значение...>: сравнение конфигураций. Допустимое различие только образ app и новые
# переменные app (у них должно быть заданное значение); documents совпадает целиком, с образом.
# Корень примерки в её JSON заменяется на боевой: compose раскрывает относительные пути
# (контекст сборки `../..`, тома `../../db`, файлы окружения) от каталога файлов, а корень
# примерки отличается от боевого.
# Заменяется именно корень дерева, а не его подкаталог deploy: пути выше deploy тоже зависят от
# корня. Печатает
# строки «ПЕРЕМЕННАЯ <причина> <имя>» и «РАЗЛИЧИЕ <путь>» (только названия ключей, значения не
# печатаются); пусто - всё сходится. Код 2 - у конфигурации нет ожидаемой структуры.
config_delta() {
  python3 -I -c '
import json, sys

def paths(left: object, right: object, prefix: str) -> list[str]:
    """Пути (только ключи), по которым два значения различаются."""
    if isinstance(left, dict) and isinstance(right, dict):
        found = []
        for key in sorted(set(left) | set(right)):
            where = prefix + "." + str(key) if prefix else str(key)
            if key not in left or key not in right:
                found.append(where)
            else:
                found += paths(left[key], right[key], where)
        return found
    return [] if left == right else [prefix]

try:
    live = json.load(open(sys.argv[1], encoding="utf-8"))
    new = json.loads(open(sys.argv[2], encoding="utf-8").read().replace(sys.argv[4], sys.argv[3]))
    expect = dict(pair.split("=", 1) for pair in sys.argv[5:])
    app_live, app_new = live["services"]["app"], new["services"]["app"]
    live["services"]["documents"], new["services"]["documents"]
    env_live = app_live.get("environment") or {}
    env_new = app_new.get("environment") or {}
except (ValueError, KeyError, TypeError, AttributeError, OSError):
    sys.exit(2)
for name, want in expect.items():
    if name not in env_new:
        print("ПЕРЕМЕННАЯ нет-переменной " + name)
    elif str(env_new[name]).strip() != want:
        print("ПЕРЕМЕННАЯ значение-не-эффективное " + name)
    env_new.pop(name, None)
    env_live.pop(name, None)
for service in (app_live, app_new):
    service.pop("image", None)
for where in paths(live, new, ""):
    print("РАЗЛИЧИЕ " + where)
' "$@"
}

# Дерево примерки: копия боевого deploy + файлы пакета и lock, секреты ссылками на боевые файлы.
# Сравнивается `compose config` боя (снимок ДО патча) и примерки: новые переменные app равны
# эффективным значениям (из .env боя, иначе умолчание compose), а вся остальная конфигурация (app
# без образа и этих переменных, documents целиком вместе с образом, прочие сервисы, сети, тома)
# совпадает; пути сравниваются при одном корне (корень примерки заменяется на боевой).
stage_tree() {
  phase "примерка новых файлов (бой не меняется)"
  STAGE_DIR="$WORK/stage"
  local deploy="$STAGE_DIR/deploy" rel secret live_cfg new_cfg delta rc=0 line bad="" item name
  local def want missing report=""
  mkdir -p "$deploy"
  (cd "$LIVE_DEPLOY" && tar -c --exclude='./.env' --exclude='./secrets.env' \
    --exclude="./$MASK_TOKEN_FILE_NAME" .) | tar -x -C "$deploy"
  for secret in "$ENV_FILE_NAME" secrets.env "$MASK_TOKEN_FILE_NAME"; do
    [[ ! -e "$LIVE_DEPLOY/$secret" ]] || ln -sfn "$LIVE_DEPLOY/$secret" "$deploy/$secret"
  done
  for rel in ${PATCH_FILES[@]+"${PATCH_FILES[@]}"}; do
    mkdir -p "$(dirname "$deploy/$rel")"
    cp -p "$PKG_DEPLOY/$rel" "$deploy/$rel"
  done
  cp "$LOCK_SRC" "$deploy/images.lock"
  missing="$(compose_missing_vars "$deploy/$COMPOSE_PROJECT_FILE")"
  [[ -z "$missing" ]] \
    || refuse "в $COMPOSE_PROJECT_FILE пакета нет строк новых переменных app вида" \
      "ИМЯ: \${ИМЯ:-умолчание}: $missing (по умолчанию хранение должно быть включено)"
  EXPECT_VARS=()
  for item in "${NEW_APP_VARS[@]}"; do
    name="${item%%=*}"
    def="${item#*=}"
    want="$(effective_var_value "$name" "$def")"
    valid_new_value "$name" "$want" \
      || refuse "значение $name в .env боя '${want:0:$VALUE_SHOW_LEN}' недопустимо:" \
        "хранение - true или false, срок - целое $DAYS_MIN..$DAYS_MAX суток," \
        "предел - целое число байт не меньше $BYTES_MIN (до $BYTES_MAX_DIGITS знаков)"
    EXPECT_VARS+=("$name=$want")
    if [[ "$name" == "$VAR_STORE" && " $STORE_OFF_WORDS " == *" ${want,,} "* ]]; then
      report+="; $name выключено выключателем в .env боя (патч .env не меняет)"
    elif [[ "$name" == "$VAR_STORE" ]]; then
      report+="; $name включено (по умолчанию compose или значение .env)"
    else
      report+="; $name=$want"
    fi
  done
  live_cfg="$(compose_json "$LIVE_NEW_DIR")"
  [[ -n "$live_cfg" ]] || refuse "docker compose config боевого дерева не собрался: снимка нет"
  CUTOVER_NEW_DIR="$STAGE_DIR"
  dc_new --profile tools config --quiet >>"$LOG_FILE" 2>&1 \
    || { CUTOVER_NEW_DIR="$LIVE_NEW_DIR"; refuse "docker compose config не принял новые файлы"; }
  CUTOVER_NEW_DIR="$LIVE_NEW_DIR"
  check "конфигурация compose" ok "новые файлы и lock собираются"
  new_cfg="$(compose_json "$STAGE_DIR")"
  [[ -n "$new_cfg" ]] || refuse "docker compose config новых файлов не отдал JSON"
  delta="$(config_delta <(printf '%s' "$live_cfg") <(printf '%s' "$new_cfg") \
    "$LIVE_NEW_DIR" "$STAGE_DIR" "${EXPECT_VARS[@]}")" || rc=$?
  ((rc == 0)) \
    || refuse "в конфигурации compose нет сервиса app или documents (структура не разобрана)"
  while IFS= read -r line; do
    [[ -z "$line" ]] || bad+="; $line"
  done <<<"$delta"
  [[ -z "$bad" ]] || refuse "новая конфигурация compose не сходится со снимком боя до патча" \
    "(допустимо: образ app и новые переменные app с эффективным значением:" \
    "из .env боя, иначе умолчание compose): ${bad#; }"
  check "переменные хранения вложений в конфигурации" ok "значения как в .env боя, иначе" \
    "умолчание compose${report}"
  printf '%s\n' "${EXPECT_VARS[@]}" >"$RES/vars-effective.txt"
  check "прочая конфигурация" ok "совпадает со снимком боя до патча (образ app и новые" \
    "переменные app; documents без изменений)"
}

# ---------------------------------------------------------------------------------------------
# Том приёма (intake-data): архив файлов чата лежит в его подкаталоге chat-attachments
# ---------------------------------------------------------------------------------------------
# intake_root_of_app: корень тома приёма из окружения запущенного app (пусто - ключа нет).
intake_root_of_app() { container_env_value "$CUTOVER_APP_CONTAINER" "$INTAKE_ROOT_KEY"; }

# intake_mounted <корень>: в app по этому пути смонтирован том intake-data (имя тома заканчивается
# на INTAKE_VOLUME_SUFFIX). Печатаются только пути монтирования и имена томов, внутрь томов не
# заглядывает.
intake_mounted() {
  { docker inspect -f '{{range .Mounts}}{{.Destination}} {{.Name}}{{println}}{{end}}' \
    "$CUTOVER_APP_CONTAINER" 2>/dev/null || true; } \
    | awk -v root="$1" -v suffix="$INTAKE_VOLUME_SUFFIX" \
      '$1 == root && length($2) >= length(suffix) \
        && substr($2, length($2) - length(suffix) + 1) == suffix { found = 1 } \
      END { exit !found }'
}

# intake_probe <корень> <создавать: 0|1>: проба тома внутри app. Ответ - одна строка в INTAKE_REPLY
# («ok N» или «fail код»); любое иное содержимое вывода отбрасывается и не печатается.
INTAKE_REPLY=""
intake_probe() {
  local out line
  out="$(docker exec -e "PATCH_INTAKE_ROOT=$1" -e "PATCH_INTAKE_SUB=$INTAKE_SUBDIR" \
    -e "PATCH_INTAKE_CREATE=$2" "$CUTOVER_APP_CONTAINER" bun -e "$INTAKE_JS" 2>/dev/null \
    || true)"
  line="$(grep -E "$INTAKE_REPLY_RE" <<<"$out" | tail -n 1 || true)"
  INTAKE_REPLY="${line:-нет ответа}"
}

# Корень тома: абсолютный путь из безопасных знаков, без «..».
intake_root_valid() {
  [[ "$1" =~ $INTAKE_ROOT_RE && "$1" != *..* ]]
}

# До замены, бой не меняется: том приёма смонтирован в запущенном app и доступен ему на запись
# (подкаталог не создаётся: сначала нужно убедиться, что патч не навредит).
check_intake_before() {
  phase "том приёма в app (до замены)"
  local root
  root="$(intake_root_of_app)"
  intake_root_valid "$root" \
    || refuse "в окружении $CUTOVER_APP_CONTAINER нет $INTAKE_ROOT_KEY или он не путь:" \
      "том приёма не найден"
  intake_mounted "$root" \
    || refuse "в $CUTOVER_APP_CONTAINER по пути $root нет тома $INTAKE_VOLUME_SUFFIX"
  intake_probe "$root" 0
  [[ "$INTAKE_REPLY" == "ok 0" ]] \
    || refuse "том приёма $root недоступен на запись пользователю app: $INTAKE_REPLY"
  INTAKE_ROOT_BEFORE="$root"
  check "том приёма" ok "$root: том $INTAKE_VOLUME_SUFFIX смонтирован, запись пользователю app" \
    "доступна"
}
INTAKE_ROOT_BEFORE=""

# После замены: тот же корень; подкаталог chat-attachments создаётся (при выключенном хранении
# только проверяется корень), доступен на запись, чужих записей в нём нет.
verify_intake() {
  local root create=1 pair store_on="" foreign
  root="$(intake_root_of_app)"
  [[ "$root" == "$INTAKE_ROOT_BEFORE" ]] \
    || die "$EXIT_FAILED" "после замены $INTAKE_ROOT_KEY у app иной" \
      "('${root:0:$VALUE_SHOW_LEN}'), до замены был '$INTAKE_ROOT_BEFORE'"
  intake_mounted "$root" || die "$EXIT_FAILED" "после замены в app по пути $root нет тома" \
    "$INTAKE_VOLUME_SUFFIX"
  for pair in "${EXPECT_VARS[@]}"; do
    [[ "${pair%%=*}" != "$VAR_STORE" ]] || store_on="${pair#*=}"
  done
  [[ " $STORE_OFF_WORDS " != *" ${store_on,,} "* ]] || create=0
  intake_probe "$root" "$create"
  case "$INTAKE_REPLY" in
    "ok 0") ;;
    ok\ *)
      foreign="${INTAKE_REPLY#ok }"
      die "$EXIT_FAILED" "в $root/$INTAKE_SUBDIR записей не от пользователя app: $foreign" ;;
    *) die "$EXIT_FAILED" "том приёма $root: подкаталог $INTAKE_SUBDIR не создан или недоступен" \
      "на запись ($INTAKE_REPLY)" ;;
  esac
  if ((create)); then
    check "том приёма после замены" ok "$root/$INTAKE_SUBDIR создан, запись доступна, чужих" \
      "записей 0"
  else
    check "том приёма после замены" ok "$root доступен на запись; хранение выключено в .env боя:" \
      "подкаталог $INTAKE_SUBDIR не создавался"
  fi
}

# ---------------------------------------------------------------------------------------------
# 1-2. Бэкап и замена
# ---------------------------------------------------------------------------------------------
make_backup() {
  phase "бэкап файлов дерева"
  BACKUP_DIR="${CUTOVER_BACKUP_ROOT}/${BACKUP_PREFIX}-${RUN_ID}"
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  cp -a "$LIVE_DEPLOY" "$BACKUP_DIR/deploy" || refuse "не удалось скопировать $LIVE_DEPLOY"
  [[ "$(stat -c %a "$LIVE_DEPLOY/$ENV_FILE_NAME")" \
    == "$(stat -c %a "$BACKUP_DIR/deploy/$ENV_FILE_NAME")" ]] \
    || refuse "права .env в бэкапе не совпали с боевыми"
  {
    echo "# контейнеры проекта до патча: имя<TAB>образ (Config.Image)<TAB>id образа<TAB>StartedAt"
    local name
    while IFS= read -r name; do
      printf '%s\t%s\t%s\t%s\n' "$name" "$(docker inspect -f '{{.Config.Image}}' "$name")" \
        "$(docker inspect -f '{{.Image}}' "$name")" "$(container_started "$name")"
    done < <(project_containers)
  } >"$BACKUP_DIR/containers-before.tsv"
  state_set BACKUP_DIR "$BACKUP_DIR"
  state_set LIVE_DEPLOY "$LIVE_DEPLOY"
  state_set DOCUMENTS_NAME "$DOCS_NAME"
  check "бэкап" ok "$BACKUP_DIR (deploy, список контейнеров и образов)"
}

# Замена файлов: временный файл рядом и mv, чтобы compose не увидел наполовину записанный.
# Сначала compose.project.yml, затем images.lock; оба пути пишутся в state для отката.
apply_files() {
  phase "замена файлов дерева"
  local rel tmp
  state_set PATCH_STARTED 1
  for rel in ${PATCH_FILES[@]+"${PATCH_FILES[@]}"}; do
    tmp="$LIVE_DEPLOY/$rel.patch-new"
    mkdir -p "$(dirname "$LIVE_DEPLOY/$rel")"
    cp -p "$PKG_DEPLOY/$rel" "$tmp"
    mv -f "$tmp" "$LIVE_DEPLOY/$rel"
    state_set FILE_REPLACED "$rel"
  done
  cp "$LOCK_SRC" "$LIVE_DEPLOY/images.lock.patch-new"
  chmod 644 "$LIVE_DEPLOY/images.lock.patch-new"
  mv -f "$LIVE_DEPLOY/images.lock.patch-new" "$LIVE_DEPLOY/images.lock"
  state_set FILE_REPLACED images.lock
  check "замена файлов" ok "заменено файлов: $((${#PATCH_FILES[@]} + 1)) (включая images.lock)"
}

# Состояние documents до замены: он патчем не пересоздаётся, StartedAt обязан остаться прежним.
# Здоровье documents и /health 200 проверяются сразу, до начала изменений.
record_documents() {
  phase "documents до замены (не пересоздаётся)"
  wait_healthy "$DOCS_NAME" "$HEALTH_WAIT_S" \
    || refuse "$DOCS_NAME не healthy: патч G9s documents не трогает, но требует его здоровым"
  docs_health_wait "$READY_WAIT_S" \
    || refuse "/health documents не 200 за ${READY_WAIT_S} с: ${DOCS_HEALTH_BODY:0:160}"
  DOCS_STARTED_BEFORE="$(container_started "$DOCS_NAME")"
  check "сервис documents" ok "$DOCS_NAME healthy, /health 200, пересоздаваться не будет"
}

# Пересоздание ТОЛЬКО app, без зависимостей и без удаления сирот (documents не трогается).
recreate_app() {
  phase "пересоздание app"
  log "up -d --no-deps app"
  dc_new up -d --no-deps "$APP_SERVICE" >>"$LOG_FILE" 2>&1 \
    || die "$EXIT_FAILED" "compose up app не удался"
  wait_healthy "$CUTOVER_APP_CONTAINER" "$HEALTH_WAIT_S" \
    || die "$EXIT_FAILED" "$CUTOVER_APP_CONTAINER не стал healthy за ${HEALTH_WAIT_S} с"
  check "сервис app" ok "пересоздан, $CUTOVER_APP_CONTAINER работает"
}

# ---------------------------------------------------------------------------------------------
# 3. Проверки после замены
# ---------------------------------------------------------------------------------------------
# verify_image <контейнер> <ключ lock>: образ запущенного контейнера равен образу из lock пакета.
verify_image() {
  local name="$1" key="$2" ref want got
  ref="$(lock_ref "$key")"
  got="$(container_image_id "$name")"
  want="$(ref_image_id "$ref")"
  printf '%s\t%s\t%s\n' "$name" "$ref" \
    "$([[ "$got" == "$want" ]] && echo совпал || echo ОТЛИЧАЕТСЯ)" >>"$RES/images-running.tsv"
  [[ -n "$got" && "$got" == "$want" ]] \
    || die "$EXIT_FAILED" "образ запущенного $name не равен lock (${ref##*/})"
  check "образ ${key#BAI_IMAGE_} = images.lock" ok "digest $name совпал с lock (${ref##*/})"
}

# В окружении documents четыре флага G8x не потерялись (читаются только эти ключи).
verify_documents_env() {
  docs_flags_check "$DOCS_NAME"
  [[ -z "$FLAGS_BAD" ]] \
    || die "$EXIT_FAILED" "в окружении documents потеряны флаги G8x (${DOCS_FLAGS[*]}):" \
      "$FLAGS_REPORT"
  check "окружение documents" ok "$FLAGS_REPORT"
}

# Проба POST /docx/pages: ответ ровно тот, что даёт образ documents с ручкой страниц (G9p и новый:
# PAGES_PROBE_STATUS и PAGES_PROBE_ERROR). Образ старше G9p ручки не знает и отвечает 404. В
# журнал и вывод идут только статус и код ошибки (detail.error), тело ответа не печатается.
verify_pages_probe() {
  local out line code="" err=""
  out="$(docs_probe "$PAGES_ROUTE_JS" || true)"
  line="$(grep -v '^[[:space:]]*$' <<<"$out" | tail -n 1 || true)"
  read -r code err _ <<<"$line" || true
  [[ "$code" =~ ^[0-9]{3}$ ]] \
    || die "$EXIT_FAILED" "проба $PAGES_ROUTE_PATH не отвечает: ${line:0:120}"
  [[ "$code" == "$PAGES_PROBE_STATUS" && "$err" == "$PAGES_PROBE_ERROR" ]] \
    || die "$EXIT_FAILED" "проба $PAGES_ROUTE_PATH: ответ $code ${err:--}, ожидается" \
      "$PAGES_PROBE_STATUS $PAGES_PROBE_ERROR (documents не на образе с ручкой страниц?)"
  check "проба $PAGES_ROUTE_PATH" ok "documents ответил $code $err (ручка страниц есть)"
}

verify_ready() {
  local body bots="0" started=$SECONDS
  ready_wait "$CUTOVER_APP_CONTAINER" "$READY_WAIT_S" \
    || die "$EXIT_FAILED" "/ready не 200 за ${READY_WAIT_S} с: ${READY_BODY:0:160}"
  while ((SECONDS - started < READY_WAIT_S)); do
    body="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
    bots="$(ready_bots "$body")"
    ((bots >= CUTOVER_EXPECT_BOTS)) && break
    sleep "$POLL_S"
  done
  ((bots >= CUTOVER_EXPECT_BOTS)) \
    || die "$EXIT_FAILED" "ботов $bots, ожидается не меньше $CUTOVER_EXPECT_BOTS"
  check "/ready и боты" ok "200, ботов $bots"
}

# В окружении app после пересоздания: переменные G9r, G9q3, G9q2, G9q, G9p, G8z и G8w на месте
# (только наличие), новые переменные есть и равны эффективным значениям (из .env боя, иначе
# умолчание; значения читаются только у этих ключей).
verify_app_env() {
  local key missing="" got bad="" pair want
  for key in "${KEEP_APP_KEYS[@]}"; do
    [[ -n "$(container_env_value "$CUTOVER_APP_CONTAINER" "$key")" ]] || missing+=" $key"
  done
  [[ -z "$missing" ]] \
    || die "$EXIT_FAILED" \
      "в окружении app пропали переменные $KEEP_APP_TITLE:$missing"
  for pair in "${EXPECT_VARS[@]}"; do
    key="${pair%%=*}"
    want="${pair#*=}"
    got="$(container_env_value "$CUTOVER_APP_CONTAINER" "$key")"
    [[ -n "$got" ]] || die "$EXIT_FAILED" "в окружении app нет новой переменной $key"
    [[ "$got" == "$want" ]] || bad+=" $key=$got (ожидается $want)"
  done
  [[ -z "$bad" ]] \
    || die "$EXIT_FAILED" "в окружении app новые переменные не равны эффективным значениям:$bad"
  check "окружение app" ok "переменные $KEEP_APP_TITLE на месте;" \
    "новые переменные: ${EXPECT_VARS[*]}"
}

# documents при пересоздании app не перезапускался: StartedAt тот же, что был до замены.
verify_documents_stable() {
  local started
  started="$(container_started "$DOCS_NAME")"
  [[ -n "$DOCS_STARTED_BEFORE" && "$started" == "$DOCS_STARTED_BEFORE" ]] \
    || die "$EXIT_FAILED" "$DOCS_NAME перезапускался при пересоздании app:" \
      "StartedAt $DOCS_STARTED_BEFORE -> $started"
  check "documents стабилен" ok "после пересоздания app не перезапускался"
}

# Остальные контейнеры (кроме app и documents) патч не трогает: перезапуск - только предупреждение.
report_other_containers() {
  local name want started changed=""
  while IFS=$'\t' read -r name _ _ want; do
    [[ "$name" == \#* || -z "$name" ]] && continue
    [[ "$name" == "$CUTOVER_APP_CONTAINER" || "$name" == "$DOCS_NAME" ]] && continue
    started="$(container_started "$name")"
    [[ "$started" == "$want" ]] || changed+=" $name"
  done <"$BACKUP_DIR/containers-before.tsv"
  if [[ -z "$changed" ]]; then
    check "прочие контейнеры" ok "не перезапускались"
  else
    check "прочие контейнеры" warn "изменился StartedAt:$changed (патч их не трогал)"
  fi
}

verify_routes() {
  local out="$RES/routes-stack.txt" rc=0 summary
  cut_check_routes_stack "$out" || rc=$?
  cat "$out" >>"$LOG_FILE"
  summary="$(tail -1 "$out" | cut -c1-200)"
  ((rc == 0)) || die "$EXIT_FAILED" "проверка маршрутов стека не прошла (routes-stack.txt)"
  check "маршруты стека" ok "$summary"
}

# Выдержка: documents и app не перезапускаются (StartedAt и RestartCount те же), /ready 200 и
# /health documents 200.
soak() {
  local c started=$SECONDS left body now_started now_restarts
  local -A started_before=() restarts_before=()
  for c in "$DOCS_NAME" "$CUTOVER_APP_CONTAINER"; do
    started_before[$c]="$(container_started "$c")"
    restarts_before[$c]="$(container_restarts "$c")"
  done
  log "выдержка ${SOAK_S} с (проверка каждые ${SOAK_POLL_S} с)"
  while ((SECONDS - started < SOAK_S)); do
    left=$((SOAK_S - (SECONDS - started)))
    sleep "$((SOAK_POLL_S < left ? SOAK_POLL_S : left))"
    for c in "$DOCS_NAME" "$CUTOVER_APP_CONTAINER"; do
      now_started="$(container_started "$c")"
      now_restarts="$(container_restarts "$c")"
      [[ "$now_started" == "${started_before[$c]}" \
        && "$now_restarts" == "${restarts_before[$c]}" ]] \
        || die "$EXIT_FAILED" "во время выдержки $c перезапускался:" \
          "перезапусков ${restarts_before[$c]} -> $now_restarts"
    done
    body="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
    [[ "$body" == 200* ]] || die "$EXIT_FAILED" "во время выдержки /ready не 200: ${body:0:120}"
    body="$(docs_probe "$DOCS_HEALTH_JS" || true)"
    [[ "$body" == 200* ]] \
      || die "$EXIT_FAILED" "во время выдержки /health documents не 200: ${body:0:120}"
  done
  check "выдержка ${SOAK_S} с" ok "documents и app не перезапускались, /ready и /health 200"
}

verify_app() {
  phase "проверки app после замены"
  : >"$RES/images-running.tsv"
  verify_image "$CUTOVER_APP_CONTAINER" "$LOCK_KEY_APP"
  verify_image "$DOCS_NAME" "$LOCK_KEY_DOCUMENTS"
  verify_ready
  verify_app_env
  verify_intake
  verify_documents_env
  verify_documents_stable
  report_other_containers
  verify_routes
  verify_pages_probe
  soak
}

# ---------------------------------------------------------------------------------------------
# Откат
# ---------------------------------------------------------------------------------------------
# rollback_patch <каталог запуска патча>: compose.project.yml и images.lock из бэкапа, up -d
# --no-deps app на образ G9r (documents не трогается), проверки. 0 - бой как до патча и
# проверен; иначе 1.
ROLLBACK_FAILED=0
rb_check() { # rb_check <имя> <ok|fail> <описание>
  check "откат: $1" "$2" "$3"
  [[ "$2" != fail ]] || ROLLBACK_FAILED=$((ROLLBACK_FAILED + 1))
}
rollback_patch() {
  local run="$1" backup live rel body bots name want got
  local saved_state="$STATE_FILE" replaced=()
  STATE_FILE="$run/state.env"
  backup="$(state_get BACKUP_DIR)"
  live="$(state_get LIVE_DEPLOY)"
  STATE_FILE="$saved_state"
  phase "откат патча"
  if [[ -z "$backup" || ! -d "$backup/deploy" || -z "$live" ]]; then
    log "нет бэкапа в $run/state.env: откат невозможен"
    return 1
  fi
  # 1. Файлы дерева из бэкапа: все, что патч заменил (список в state), и lock.
  mapfile -t replaced < <(grep -E '^FILE_REPLACED=' "$run/state.env" | cut -d= -f2- | sort -u)
  for rel in ${replaced[@]+"${replaced[@]}"}; do
    [[ -n "$rel" && -e "$backup/deploy/$rel" ]] || continue
    cp -a "$backup/deploy/$rel" "$live/$rel.rb-new" && mv -f "$live/$rel.rb-new" "$live/$rel"
  done
  local bad=0
  for rel in images.lock ${replaced[@]+"${replaced[@]}"}; do
    [[ -n "$rel" && -e "$backup/deploy/$rel" ]] || continue
    cmp -s "$backup/deploy/$rel" "$live/$rel" || bad=$((bad + 1))
  done
  ((bad == 0)) \
    && rb_check "файлы дерева" ok "compose.project.yml и images.lock возвращены из бэкапа" \
    || rb_check "файлы дерева" fail "файлов не совпало с бэкапом: $bad"
  # 2. Только app, на образ G9r: без down, без --remove-orphans, documents не трогается.
  CUTOVER_NEW_DIR="$(dirname "$live")"
  dc_new up -d --no-deps "$APP_SERVICE" >>"$LOG_FILE" 2>&1 \
    && rb_check "поднят app" ok "up -d --no-deps app" \
    || rb_check "поднят app" fail "compose up не удался"
  # 3. Проверки: /ready и образы контейнеров как до патча.
  if ready_wait "$CUTOVER_APP_CONTAINER" "$READY_WAIT_S"; then
    body="$(ready_probe "$CUTOVER_APP_CONTAINER" || true)"
    bots="$(ready_bots "$body")"
    ((bots >= CUTOVER_EXPECT_BOTS)) \
      && rb_check "/ready" ok "200, ботов $bots" \
      || rb_check "/ready" fail "ботов $bots, ожидается не меньше $CUTOVER_EXPECT_BOTS"
  else
    rb_check "/ready" fail "не 200 за ${READY_WAIT_S} с: ${READY_BODY:0:120}"
  fi
  while IFS=$'\t' read -r name want _ _; do
    [[ "$name" == \#* || -z "$name" ]] && continue
    got="$(docker inspect -f '{{.Config.Image}}' "$name" 2>/dev/null || echo отсутствует)"
    [[ "$got" == "$want" ]] \
      && rb_check "образ $name" ok "как до патча" \
      || rb_check "образ $name" fail "сейчас $got, до патча $want"
  done <"$backup/containers-before.tsv"
  ((ROLLBACK_FAILED == 0)) || return 1
  log "ОТКАТ ПАТЧА ВЫПОЛНЕН: файлы дерева из бэкапа, app на образе G9r, documents не" \
    "трогался, проверки прошли"
  # Сохранённые файлы архива откатом не удаляются: они остаются в томе приёма (прежний образ
  # подкаталог не читает, платформенная чистка его не видит).
  log "файлы архива чата в $INTAKE_SUBDIR тома приёма откатом не удаляются"
  state_set ROLLBACK_RESULT OK
}

# ---------------------------------------------------------------------------------------------
main() {
  if ((ROLLBACK_MODE)); then
    log "patch.sh --rollback: откат по каталогу запуска $RUN_DIR_ORIG"
    rollback_patch "$RUN_DIR_ORIG" || exit "$EXIT_STUCK"
    return 0
  fi
  save_config
  log "patch.sh $RUN_ID: проект $CUTOVER_PROJECT, дерево $LIVE_NEW_DIR, каталог запуска $RUN_DIR"
  collect_secret_values
  check_sources
  check_signatures
  check_tree_present
  check_not_applied
  check_g9r_applied
  check_changes
  check_battle_health
  check_intake_before
  check_resources
  ensure_images
  stage_tree
  check_rollback_images
  if ((PREFLIGHT_ONLY)); then
    check "режим" ok "--preflight-only: бой не менялся"
    state_set RESULT "PREFLIGHT_OK"
    return 0
  fi
  record_documents
  make_backup
  apply_files
  recreate_app
  verify_app
  state_set RESULT OK
}
main
