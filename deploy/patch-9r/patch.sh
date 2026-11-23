#!/usr/bin/env bash
# Патч G9r: платформа 1.1.6 -> 1.1.10 и ДВА образа проекта documents и app 1.1.10-pragmatika.1
# (КРАСНАЯ ЗОНА: запускает только владелец на боевом хосте). Новое в documents: правка цен в PDF
# вне таблиц с линиями (цена в тексте, колонки без линий; ручки /parse с locations=true и
# /edit-cells со страницей и номером места; флаг DOCUMENTS_EDIT_PDF_TEXT, по умолчанию платформы
# ВКЛЮЧЁН и действует вместе с DOCUMENTS_EDIT_PDF). Новое в app: выбор места в PDF по этим
# данным (под прежним PRICE_EDIT_TEXT_BLOCKS_ENABLED) и две переменные записи видеозвонка
# Bitrix24 (B24_CALL_RECORDING_MAX_BYTES, B24_CALL_RECORDING_TIMEOUT_MS; платформа 1.1.8-1.1.10,
# значения по умолчанию в compose.base.yml). Из файлов дерева заменяются images.lock и КОПИЯ
# платформы (platform/compose.base.yml, platform/PLATFORM-VERSION), compose.project.yml в этом
# патче не меняется (допускается в пакете, но заменяется, только если отличается от боевого).
# Патч .env не меняет: явный `DOCUMENTS_EDIT_PDF_TEXT=false` (или 0, off, no) в .env боя
# остаётся выключателем (патч пишет это в журнал и результат). Миграций БД нет. Ставится СТРОГО
# ПОСЛЕ патча G9q3: lock боя 1.1.6-pragmatika.7, платформа 1.1.6, app и documents работают на
# образах из lock боя.
#
# Использование:
#   bash patch.sh [--preflight-only] [--signatures-verified ФАЙЛ] [--images-tar ФАЙЛ]
#                 [--config ФАЙЛ] [--out-dir КАТАЛОГ] [--soak-seconds N] [--expected-bots N]
#   bash patch.sh --rollback [--run-dir КАТАЛОГ]   откат применённого патча вручную
#   bash patch.sh --help
#
# Что делает (бой = compose-проект `pragmatika`, дерево /opt/pragmatika-v2/deploy; из файлов дерева
# заменяются ТОЛЬКО images.lock, platform/compose.base.yml, platform/PLATFORM-VERSION и (если он
# отличается) compose.project.yml; остальные файлы compose, БД, миграции, alloy, nginx, mask,
# pseudonymizer, тома и секреты патч НЕ трогает):
#   0. Предусловия, бой не меняется: целостность пакета (MANIFEST.sha256), подписи ВСЕХ образов
#      lock (cosign на хосте либо --signatures-verified: вывод verify-signatures.sh; по умолчанию
#      signatures.txt рядом с пакетом; молча пропускать нельзя), в пакете из файлов deploy/
#      только compose.project.yml, platform/compose.base.yml и platform/PLATFORM-VERSION (любой
#      другой файл и миграции - отказ), обе платформенные копии обязаны быть: версия 1.1.10,
#      сумма compose.base.yml сходится со строкой PLATFORM-VERSION, в ней есть новые переменные
#      платформы; патч ещё не применён (lock боя не равен lock пакета, версия не
#      1.1.10-pragmatika.1 и платформа боя не 1.1.10, иначе отказ: повторный запуск ничего не
#      меняет), патч G9q3 применён (BAI_VERSION lock боя 1.1.6-pragmatika.7, платформа боя 1.1.6,
#      запущенные app и documents работают на образах из lock боя, в окружении app есть
#      переменные G9q2, G9q, G9p, G8z и поиска G8w, в окружении documents четыре флага G8x; иначе
#      отказ с подсказкой «сначала примените патч G9q3»), lock пакета отличается от боевого ТОЛЬКО
#      ключами BAI_VERSION, BAI_IMAGE_APP, BAI_IMAGE_DOCUMENTS (оба образа обязаны смениться) и
#      теми, что поменяла платформа: BAI_IMAGE_APP_BASE, BAI_IMAGE_DOCUMENTS_BASE,
#      BAI_IMAGE_SPEECH (образ speech не запускается: профиль speech на бою выключен), бой здоров
#      (/ready 200, ботов не меньше ожидаемого), свободны диск и память, образы app и documents
#      на хосте (docker load или pull по digest), прежние (откатные) образы app и documents на
#      хосте есть. Значения новых переменных из .env боя допустимы (B24_CALL_RECORDING_*: целое
#      в пределах платформы; DOCUMENTS_EDIT_PDF_TEXT: 1/0, true/false, on/off, yes/no или
#      пусто, иное documents не принял бы). Примерка: compose с новыми файлами и боевым .env
#      собирается, а его конфигурация отличается от снимка боя до патча ТОЛЬКО образами app и
#      documents, основой сборки app (аргумент BAI_APP_BASE равен значению lock пакета), двумя
#      новыми переменными app (значение из .env боя, иначе по умолчанию платформы) и новой
#      переменной documents (значение из .env боя, иначе пусто). Любое нарушение - код 3, бой не
#      тронут. С --preflight-only на этом всё.
#   1. Бэкап файлов дерева (весь каталог deploy, права сохраняются, .env 600) и снимок
#      контейнеров и образов: ~/backups/pragmatika-patch9r-<время>.
#   2. Замена файлов из пакета и images.lock, затем по очереди `up -d --no-deps documents` (ждать
#      healthy и /health 200, проверки documents) и `up -d --no-deps app` (без down, без
#      --remove-orphans, без --force-recreate; простой documents и app около 30 с каждый).
#   3. Проверки: образы documents и app = lock (по digest); в окружении documents четыре флага G8x
#      на месте (читаются только эти ключи, остальное окружение и секреты не печатаются) и
#      DOCUMENTS_EDIT_PDF_TEXT равен эффективному значению; проба POST /docx/pages с заведомо
#      некорректным телом (образ отвечает 422 bad_request); проба POST /parse с locations=true на
#      крошечном PDF, который строится внутри пробы (в журнал идут только статус, формат, число
#      страниц и мест: «200 pdf 1 1»; при явном выключателе в .env ожидается ответ без locations);
#      /ready app 200 и ботов не меньше ожидаемого; в окружении app значения переменных G9q2, G9q,
#      G9p, G8z и G8w не изменились, обе новые переменные равны эффективным; копия платформы в
#      дереве боя равна пакетной; маршруты стека не 404/405 (tools/check-routes.sh); выдержка (по
#      умолчанию 2 минуты: documents и app не перезапускаются).
#   Любой сбой после начала изменений -> автоматический откат: все заменённые файлы и images.lock
#   возвращаются из бэкапа, `up -d --no-deps` documents и app на образы G9q3 (documents
#   1.1.6-pragmatika.6, app 1.1.6-pragmatika.7), проверяется /ready.
# Результат: ~/patch9r-<время>.tgz (журнал, проверки; без секретов и данных) - вернуть
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
  PKG_DEPLOY="${PATCH9R_PKG_DEPLOY:-$PKG/deploy}" # каталог deploy пакета: файлы дерева патча
  LOCK_SRC="${PATCH9R_LOCK:-$PKG/deploy/images.lock}"
fi
# shellcheck source=../cutover/lib.sh
source "$LIB"
COSIGN_PUB="${PATCH9R_COSIGN_PUB:-$PKG/cosign.pub}"
[[ -f "$COSIGN_PUB" ]] || COSIGN_PUB="$PKG/deploy/cosign.pub"

# Файлы дерева, которые патч вправе заменить (пути относительно deploy/), кроме images.lock (он
# лежит в корне пакета). Чужой файл в пакете (в том числе deploy/images.lock) - отказ. Обе копии
# платформы обязательны; compose.project.yml в пакете допустим, но заменяется только если он
# отличается от боевого (на этом этапе проектный compose не менялся).
# ДОЛЖНО совпадать с DEPLOY_FILES в tools/build-patch-9r-package.sh.
PATCH_FILE_ALLOW=(compose.project.yml platform/compose.base.yml platform/PLATFORM-VERSION)
PLATFORM_FILES=(platform/compose.base.yml platform/PLATFORM-VERSION)
COMPOSE_PROJECT_FILE="compose.project.yml"
PLATFORM_BASE_FILE="platform/compose.base.yml"
PLATFORM_BASE_NAME="compose.base.yml"
# Ключи lock, которые патч вправе менять: образы проекта app и documents, версия lock и те, что
# изменила платформа 1.1.6 -> 1.1.10 (по digest из выпусков: основа app, основа documents, speech).
# Любой другой (alloy, postgres, mask, nginx...) - отказ.
PATCH_LOCK_KEYS="BAI_VERSION BAI_IMAGE_APP BAI_IMAGE_APP_BASE BAI_IMAGE_DOCUMENTS"
PATCH_LOCK_KEYS+=" BAI_IMAGE_DOCUMENTS_BASE BAI_IMAGE_SPEECH"
LOCK_KEY_APP="BAI_IMAGE_APP"
LOCK_KEY_APP_BASE="BAI_IMAGE_APP_BASE"
LOCK_KEY_DOCUMENTS="BAI_IMAGE_DOCUMENTS"
LOCK_KEY_VERSION="BAI_VERSION"
# Аргумент сборки app в compose.project.yml: основа образа app берётся из lock.
BUILD_ARG_APP_BASE="BAI_APP_BASE"
DOCUMENTS_SERVICE="documents"
APP_SERVICE="app"
# Версия lock: боевая до патча (её ставит G9q3) и целевая в пакете; платформа 1.1.6 -> 1.1.10.
LOCK_VERSION_FROM="1.1.6-pragmatika.7"
LOCK_VERSION_TO="1.1.10-pragmatika.1"
PLATFORM_VERSION_FILE="platform/PLATFORM-VERSION"
PLATFORM_VERSION_KEY="PLATFORM_PACKAGES_VERSION"
PLATFORM_FROM="1.1.6"
PLATFORM_TO="1.1.10"
G9Q_HINT="сначала примените патч G9q3 (платформа ${PLATFORM_FROM}, lock ${LOCK_VERSION_FROM})"
# Новые переменные платформы в копии compose.base.yml пакета: по ним видно, что это копия 1.1.10.
PLATFORM_NEW_VARS=(DOCUMENTS_EDIT_PDF_TEXT B24_CALL_RECORDING_MAX_BYTES
  B24_CALL_RECORDING_TIMEOUT_MS)
# Новые переменные app от платформы 1.1.10 (ИМЯ=значение по умолчанию compose.base.yml). Эффективное
# значение = значение из .env (затем secrets.env), иначе умолчание; до и после замены app
# сверяется именно оно. Допустимые значения (как у платформы): целое, не меньше минимума и не
# больше максимума.
NEW_APP_VARS=(B24_CALL_RECORDING_MAX_BYTES=104857600 B24_CALL_RECORDING_TIMEOUT_MS=600000)
B24_MAX_BYTES_KEY="B24_CALL_RECORDING_MAX_BYTES"
B24_TIMEOUT_KEY="B24_CALL_RECORDING_TIMEOUT_MS"
B24_MAX_BYTES_MIN=1
B24_MAX_BYTES_MAX=1073741824
B24_TIMEOUT_MIN_MS=10000
B24_TIMEOUT_MAX_MS=3600000
# Новая переменная documents: правка чисел PDF вне таблиц с линиями. В compose.base.yml по
# умолчанию пустая (documents читает пустое как «включено»), значения 1/0, true/false, on/off,
# yes/no; опечатка останавливает старт documents, поэтому проверяется заранее.
PDF_TEXT_KEY="DOCUMENTS_EDIT_PDF_TEXT"
PDF_TEXT_TRUE_WORDS="1 true on yes"
PDF_TEXT_FALSE_WORDS="0 false off no"
# Переменные app от патчей G9q2, G9q, G9p, G8z и G8w: признак, что они применены, и то, что
# при замене app не должно потеряться и измениться (значения читаются у ЭТИХ ключей: флаги и
# числа, не секреты). Значение до замены запоминается с запущенного app, после замены оно
# обязано совпасть.
KEEP_APP_KEYS=(EMPTY_REPLY_GUARD_ENABLED PRICE_EDIT_DB_WRITE_ENABLED
  PRICE_EDIT_TEXT_BLOCKS_ENABLED PRICE_EDIT_FIRST_ENABLED DOCX_PAGES_ENABLED
  SHORTLIST_PAGING_ENABLED SUPPLIER_DISCOVERY_ENABLED
  YANDEX_SEARCH_MAX_CONCURRENCY YANDEX_SEARCH_MIN_INTERVAL_MS)
# Флаги G9q2 (защита от пустого ответа) и G9q в compose.project.yml по умолчанию включены
# (`:-true`): после патча файл не должен потерять эти строки (если пакет его заменяет).
G9Q_APP_FLAGS=(EMPTY_REPLY_GUARD_ENABLED PRICE_EDIT_DB_WRITE_ENABLED
  PRICE_EDIT_TEXT_BLOCKS_ENABLED)
FLAG_DEFAULT_VALUE="true"
# Значение из окружения запуска сильнее .env и compose: сброс, чтобы эффективное значение
# определялось только файлами дерева (переменная, экспортированная в оболочке владельца, иначе
# подменила бы и значение, и выключатель).
unset "${KEEP_APP_KEYS[@]}" B24_CALL_RECORDING_MAX_BYTES B24_CALL_RECORDING_TIMEOUT_MS \
  DOCUMENTS_EDIT_PDF_TEXT
# Значения переменных app до замены (ИМЯ=значение, заполняются в check_g9q_applied) и ожидаемые
# значения новых переменных app (ИМЯ=значение, заполняются в check_new_settings).
PRE_APP_VALUES=()
EXPECT_APP_NEW=()
# Эффективное значение DOCUMENTS_EDIT_PDF_TEXT (в нижнем регистре, пусто = умолчание платформы) и
# признак «правка PDF вне таблиц включена» (0 - явный выключатель в .env боя).
PDF_TEXT_EFFECTIVE=""
PDF_TEXT_ON=1
# Флаги documents от патча G8x (ИМЯ=значение): признак «G8x применён» и то, что не должно
# потеряться при пересоздании documents. Больше никакие переменные documents не читаются
# (кроме DOCUMENTS_EDIT_PDF_TEXT).
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
# разбирается, LibreOffice не запускается, спул не занимается. documents у G9r отвечает так же,
# как образ G9p (422 с detail.error=bad_request, CONTRACT-9p.md); образ старше ручки не знает: 404.
# Ожидаемые статус и код ошибки переопределяются окружением (PATCH9R_PAGES_PROBE_STATUS,
# PATCH9R_PAGES_PROBE_ERROR). В журнал идут ТОЛЬКО статус и код ошибки, тело ответа не
# печатается: код ошибки выводится лишь если он похож на идентификатор.
PAGES_ROUTE_PATH="/docx/pages"
PAGES_PROBE_BODY='{"file_name":"probe.docx","content_base64":"%%%"}'
PAGES_PROBE_STATUS="${PATCH9R_PAGES_PROBE_STATUS:-422}"
PAGES_PROBE_ERROR="${PATCH9R_PAGES_PROBE_ERROR:-bad_request}"
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
# Проба POST /parse с locations=true на крошечном синтетическом PDF (одна страница, строка
# «Price 1 250,00 total»; PDF строится внутри пробы без внешних зависимостей, данных заказчика
# нет). Образ G9r (правка вне таблиц включена) отдаёт locations: формат pdf, одна страница, одно
# место; при явном выключателе в .env или у образа старше (G9p) поля locations нет. В журнал
# идут ТОЛЬКО статус, формат, число страниц и мест («200 pdf 1 1» или «200 - - -»): ни текста
# мест, ни тела ответа. Ожидаемые строки переопределяются окружением (PATCH9R_PARSE_PROBE_ON,
# PATCH9R_PARSE_PROBE_OFF).
PARSE_ROUTE_PATH="/parse"
PARSE_PROBE_ON="${PATCH9R_PARSE_PROBE_ON:-200 pdf 1 1}"
PARSE_PROBE_OFF="${PATCH9R_PARSE_PROBE_OFF:-200 - - -}"
PARSE_ROUTE_JS="try {
  const base = process.env.PATCH_DOCS_URL ?? '$DOCUMENTS_URL_DEFAULT';
  const stream = 'BT /F1 12 Tf 100 700 Td (Price 1 250,00 total) Tj ET';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += (i + 1) + ' 0 obj\n' + body + '\nendobj\n';
  });
  const xref = pdf.length;
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  offsets.forEach((o) => { pdf += String(o).padStart(10, '0') + ' 00000 n \n'; });
  pdf += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref +
    '\n%%EOF\n';
  const form = new FormData();
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'probe.pdf');
  form.append('locations', 'true');
  const r = await fetch(base + '$PARSE_ROUTE_PATH', { method: 'POST', body: form });
  let seen = '- - -';
  try {
    const loc = (await r.json())?.locations;
    if (typeof loc === 'object' && loc !== null) {
      const format = typeof loc.format === 'string' && /^[a-z]{1,8}\$/.test(loc.format)
        ? loc.format : '-';
      const pages = Number.isInteger(loc.pages) ? loc.pages : '-';
      const spots = Array.isArray(loc.spots) ? loc.spots.length : '-';
      seen = format + ' ' + pages + ' ' + spots;
    }
  } catch (e) { seen = '- - -'; }
  console.log(r.status + ' ' + seen);
} catch (e) { console.log('documents недоступен: ' + e.message); process.exit(1); }"
DEFAULT_SOAK_S=120
SOAK_POLL_S=${PATCH9R_SOAK_POLL_S:-15}
DEPLOYED_MARK=".cutover-deployed"
BACKUP_PREFIX="pragmatika-patch9r"
ARCHIVE_PREFIX="patch9r"
RUN_PREFIX="patch-9r"
# Права .env в бэкапе должны совпасть с боевыми (600).
ENV_FILE_NAME=".env"
# Запасы: свободный диск под новые образы documents (с LibreOffice) и app (МиБ), доступная память
# (МиБ).
PATCH_MIN_DISK_MIB="${PATCH9R_MIN_DISK_MIB:-8192}"
PATCH_MIN_AVAILABLE_MIB="${PATCH9R_MIN_AVAILABLE_MIB:-1024}"
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
# Контейнер documents (имя берётся при проверке предусловий) и его StartedAt сразу после
# пересоздания (пересоздание app не должно его перезапускать).
DOCS_NAME=""
DOCS_STARTED_NEW=""

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

# Архив результатов ~/patch9r-<время>.tgz; значение секрета в нём - архив удаляется.
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
  [[ -n "$(lock_ref "$LOCK_KEY_APP_BASE")" ]] \
    || refuse "в images.lock пакета нет $LOCK_KEY_APP_BASE (основа сборки app)"
  [[ "$(lock_ref "$LOCK_KEY_VERSION")" == "$LOCK_VERSION_TO" ]] \
    || refuse "BAI_VERSION lock пакета '$(lock_ref "$LOCK_KEY_VERSION")'," \
      "ожидается $LOCK_VERSION_TO"
  [[ ! -e "$PKG/db" && ! -e "$HERE/stack/db" && ! -e "${PKG_DEPLOY:-/nonexistent}/db" ]] \
    || refuse "в патче есть каталог db: патч не должен менять БД и миграции"
  # Файлы дерева у G9r: compose.project.yml (необязательно), копия платформы (обязательна) и
  # images.lock из корня пакета. Любой другой файл deploy/ в пакете (в том числе
  # deploy/images.lock) - отказ.
  local rel
  if [[ -d "$PKG_DEPLOY" ]]; then
    while IFS= read -r rel; do
      [[ " ${PATCH_FILE_ALLOW[*]} " == *" $rel "* ]] \
        || refuse "в пакете файл deploy/$rel: патч G9r заменяет только ${PATCH_FILE_ALLOW[*]}" \
          "и images.lock"
    done < <(cd "$PKG_DEPLOY" && find . -mindepth 1 ! -type d | sed 's|^\./||' | sort)
  fi
  for rel in "${PLATFORM_FILES[@]}"; do
    [[ -f "$PKG_DEPLOY/$rel" ]] \
      || refuse "в пакете нет deploy/$rel (копия платформы $PLATFORM_TO)"
  done
  check_platform_copy
  [[ -f "$ROUTES_MANIFEST" && -f "$ROUTES_TOOLS_DIR/check-routes.sh" \
    && -f "$ROUTES_TOOLS_DIR/route-flags.tsv" ]] \
    || refuse "в пакете нет инструментов проверки (tools/, routes.tsv)"
  check "состав пакета" ok "lock ${LOCK_VERSION_TO}, инструменты проверки на месте," \
    "копия платформы $PLATFORM_TO цела, из файлов deploy только ${PATCH_FILE_ALLOW[*]}"
}

# Копия платформы в пакете: версия $PLATFORM_TO, сумма compose.base.yml сходится со строкой
# PLATFORM-VERSION (файл не правили руками), в ней есть новые переменные платформы.
check_platform_copy() {
  local ver want got var
  ver="$(platform_version "$PKG_DEPLOY/$PLATFORM_VERSION_FILE")"
  [[ "$ver" == "$PLATFORM_TO" ]] \
    || refuse "PLATFORM-VERSION пакета '${ver:-?}', ожидается $PLATFORM_TO"
  want="$(awk -v n="$PLATFORM_BASE_NAME" '$1 == "sha256" && $3 == n { print $2 }' \
    "$PKG_DEPLOY/$PLATFORM_VERSION_FILE" | head -1)"
  got="$(sha256sum "$PKG_DEPLOY/$PLATFORM_BASE_FILE" | cut -d' ' -f1)"
  [[ -n "$want" && "$got" == "$want" ]] \
    || refuse "сумма $PLATFORM_BASE_FILE пакета не сходится со строкой PLATFORM-VERSION:" \
      "копия платформы повреждена или изменена"
  for var in "${PLATFORM_NEW_VARS[@]}"; do
    grep -q "$var" "$PKG_DEPLOY/$PLATFORM_BASE_FILE" \
      || refuse "в $PLATFORM_BASE_FILE пакета нет $var: это не копия платформы $PLATFORM_TO"
  done
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

# Патч G9r ещё не применён: lock боя не равен lock пакета, версия не целевая и платформа боя не
# $PLATFORM_TO. Повторный запуск того же патча - отказ без изменений.
check_not_applied() {
  phase "патч G9r ещё не применён"
  local live_ver live_platform
  live_ver="$(live_lock_ref "$LOCK_KEY_VERSION")"
  live_platform="$(platform_version "$LIVE_DEPLOY/$PLATFORM_VERSION_FILE")"
  if cmp -s "$LIVE_DEPLOY/images.lock" "$LOCK_SRC" || [[ "$live_ver" == "$LOCK_VERSION_TO" ]] \
    || [[ "$live_platform" == "$PLATFORM_TO" ]]; then
    refuse "патч G9r уже применён (lock боя ${live_ver:-?}, платформа боя ${live_platform:-?}," \
      "версия пакета $LOCK_VERSION_TO): повторный запуск ничего не меняет"
  fi
  check "патч G9r ещё не применён" ok "lock боя ${live_ver:-?} отличается от пакета"
}

# Патч G9q3 применён: lock боя 1.1.6-pragmatika.7, платформа боя 1.1.6, app и documents работают на
# образах из lock боя, у app переменные G9q2, G9q, G9p, G8z и поиска G8w (значения запоминаются,
# после замены они обязаны совпасть), у documents четыре флага G8x.
check_g9q_applied() {
  phase "патч G9q3 применён"
  local ver live_ver key live_ref got want missing=""
  live_ver="$(live_lock_ref "$LOCK_KEY_VERSION")"
  [[ "$live_ver" == "$LOCK_VERSION_FROM" ]] \
    || refuse "BAI_VERSION lock боя '${live_ver:-?}', ожидается $LOCK_VERSION_FROM: $G9Q_HINT"
  ver="$(platform_version "$LIVE_DEPLOY/$PLATFORM_VERSION_FILE")"
  [[ "$ver" == "$PLATFORM_FROM" ]] \
    || refuse "платформа боя '${ver:-?}', ожидается $PLATFORM_FROM: $G9Q_HINT"
  [[ -n "$(docker ps -q --filter "name=^${CUTOVER_APP_CONTAINER}\$")" ]] \
    || refuse "контейнер $CUTOVER_APP_CONTAINER не запущен"
  live_ref="$(live_lock_ref "$LOCK_KEY_APP")"
  got="$(container_image_id "$CUTOVER_APP_CONTAINER")"
  want="$(ref_image_id "$live_ref")"
  [[ -n "$got" && "$got" == "$want" ]] \
    || refuse "запущенный $CUTOVER_APP_CONTAINER не на образе из lock боя" \
      "(${live_ref##*/}): $G9Q_HINT"
  PRE_APP_VALUES=()
  for key in "${KEEP_APP_KEYS[@]}"; do
    got="$(container_env_value "$CUTOVER_APP_CONTAINER" "$key")"
    if [[ -n "$got" ]]; then PRE_APP_VALUES+=("$key=$got"); else missing+=" $key"; fi
  done
  [[ -z "$missing" ]] || refuse "в окружении $CUTOVER_APP_CONTAINER нет:$missing: $G9Q_HINT"
  printf '%s\n' "${PRE_APP_VALUES[@]}" >"$RES/app-values-before.txt"
  DOCS_NAME="$(service_containers "$DOCUMENTS_SERVICE" | head -1)"
  [[ -n "$DOCS_NAME" ]] || refuse "в проекте нет контейнера documents"
  live_ref="$(live_lock_ref "$LOCK_KEY_DOCUMENTS")"
  got="$(container_image_id "$DOCS_NAME")"
  want="$(ref_image_id "$live_ref")"
  [[ -n "$got" && "$got" == "$want" ]] \
    || refuse "запущенный $DOCS_NAME не на образе из lock боя (${live_ref##*/}): $G9Q_HINT"
  docs_flags_check "$DOCS_NAME"
  [[ -z "$FLAGS_BAD" ]] \
    || refuse "в окружении $DOCS_NAME нет флагов G8x или они иные ($FLAGS_REPORT): $G9Q_HINT"
  check "патч G9q3 применён" ok "lock $live_ver, платформа $ver, образы как в lock," \
    "переменные G9q2, G9q, G9p, G8z и G8w у app и флаги G8x у documents на месте"
}

# lock боя отличается от пакетного только ключами патча (версия, образы app и documents, основы и
# speech от платформы); файлы пакета только из списка, обе копии платформы отличаются от боевых.
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
    [[ " $PATCH_LOCK_KEYS " == *" ${key%%(*} "* ]] \
      || refuse "lock пакета меняет $key: патч вправе менять только: $PATCH_LOCK_KEYS"
  done
  printf '%s\n' ${changed:-} >"$RES/lock-changes.txt"
  [[ -n "$changed" ]] \
    || refuse "нечего применять: lock боя уже совпадает с пакетом (патч применён?)"
  [[ " $changed " == *" $LOCK_KEY_APP "* ]] \
    || refuse "lock пакета не меняет образ app ($LOCK_KEY_APP): патчу нечего катить"
  [[ " $changed " == *" $LOCK_KEY_DOCUMENTS "* ]] \
    || refuse "lock пакета не меняет образ documents ($LOCK_KEY_DOCUMENTS): в нём правка PDF"
  # Файлы пакета: только из списка; отличающиеся от боевых - в список замены.
  PATCH_FILES=()
  while IFS= read -r rel; do
    [[ " ${PATCH_FILE_ALLOW[*]} " == *" $rel "* ]] \
      || refuse "в пакете файл $rel вне списка замены (${PATCH_FILE_ALLOW[*]})"
    [[ -f "$LIVE_DEPLOY/$rel" ]] && cmp -s "$PKG_DEPLOY/$rel" "$LIVE_DEPLOY/$rel" && continue
    PATCH_FILES+=("$rel")
  done < <(cd "$PKG_DEPLOY" && find . -type f | sed 's|^\./||' | sort)
  for rel in "${PLATFORM_FILES[@]}"; do
    [[ " ${PATCH_FILES[*]:-} " == *" $rel "* ]] \
      || refuse "$rel боя уже равен пакетному: неожиданное состояние, патч не применяется"
  done
  printf '%s\n' ${PATCH_FILES[@]+"${PATCH_FILES[@]}"} >"$RES/file-changes.txt"
  check "состав изменений" ok "lock:$changed; файлов дерева кроме lock: ${#PATCH_FILES[@]}" \
    "(${PATCH_FILES[*]:-})"
}

# effective_env_value <ИМЯ> <умолчание>: значение, которое увидит compose: из .env боя, затем
# secrets.env (позже - сильнее, как порядок --env-file), пусто или нет ключа - умолчание.
effective_env_value() {
  local file value="" got
  for file in "$LIVE_DEPLOY/$ENV_FILE_NAME" "$LIVE_DEPLOY/secrets.env"; do
    got="$(env_value "$file" "$1")"
    [[ -z "$got" ]] || value="$got"
  done
  printf '%s' "${value:-$2}"
}

# Новые переменные платформы: эффективные значения (из .env боя, иначе умолчание платформы) и их
# допустимость. Значение вне допустимого - отказ в предусловиях (иначе app или documents не
# запустились бы, а откат стоил бы простоя). Явный выключатель PDF вне таблиц не отказ.
check_new_settings() {
  phase "новые переменные платформы $PLATFORM_TO"
  local item key default want min max word
  EXPECT_APP_NEW=()
  for item in "${NEW_APP_VARS[@]}"; do
    key="${item%%=*}"
    default="${item#*=}"
    want="$(effective_env_value "$key" "$default")"
    if [[ "$key" == "$B24_MAX_BYTES_KEY" ]]; then
      min="$B24_MAX_BYTES_MIN"
      max="$B24_MAX_BYTES_MAX"
    else
      min="$B24_TIMEOUT_MIN_MS"
      max="$B24_TIMEOUT_MAX_MS"
    fi
    if [[ ! "$want" =~ ^[0-9]{1,12}$ ]] || ((10#$want < min || 10#$want > max)); then
      refuse "значение $key в .env боя не подходит платформе: нужно целое от $min до $max"
    fi
    EXPECT_APP_NEW+=("$key=$want")
  done
  word="$(effective_env_value "$PDF_TEXT_KEY" "")"
  word="${word,,}"
  PDF_TEXT_EFFECTIVE="$word"
  PDF_TEXT_ON=1
  if [[ -n "$word" ]]; then
    if [[ ! "$word" =~ ^[a-z0-9]+$ ]]; then
      refuse "значение $PDF_TEXT_KEY в .env боя documents не принял бы: нужно" \
        "$PDF_TEXT_TRUE_WORDS, $PDF_TEXT_FALSE_WORDS или пусто"
    elif [[ " $PDF_TEXT_TRUE_WORDS " == *" $word "* ]]; then
      PDF_TEXT_ON=1
    elif [[ " $PDF_TEXT_FALSE_WORDS " == *" $word "* ]]; then
      PDF_TEXT_ON=0
    else
      refuse "значение $PDF_TEXT_KEY в .env боя documents не принял бы: нужно" \
        "$PDF_TEXT_TRUE_WORDS, $PDF_TEXT_FALSE_WORDS или пусто"
    fi
  fi
  {
    printf '%s\n' "${EXPECT_APP_NEW[@]}"
    echo "$PDF_TEXT_KEY=${PDF_TEXT_EFFECTIVE:-<пусто: по умолчанию платформы включено>}"
  } >"$RES/new-settings-effective.txt"
  if ((PDF_TEXT_ON)); then
    check "правка PDF вне таблиц" ok "$PDF_TEXT_KEY включён (по умолчанию платформы или .env)"
  else
    check "правка PDF вне таблиц" ok "$PDF_TEXT_KEY выключен выключателем в .env боя" \
      "(патч .env не меняет; PDF правится только в таблицах с линиями)"
  fi
  check "новые переменные app" ok "${EXPECT_APP_NEW[*]}"
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

# Образы app и documents из lock пакета - локально по digest.
ensure_images() {
  phase "образы documents и app"
  local ref key
  if [[ -n "$IMAGES_TAR" ]]; then
    [[ -f "$IMAGES_TAR" ]] || refuse "нет архива образов $IMAGES_TAR"
    log "загружаю образы из $IMAGES_TAR"
    docker load -i "$IMAGES_TAR" >>"$LOG_FILE" 2>&1 || refuse "docker load не удался"
  fi
  for key in "$LOCK_KEY_DOCUMENTS" "$LOCK_KEY_APP"; do
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

# Прежние образы documents и app (откатные, G9q3) на хосте: без них автооткат невозможен.
check_rollback_images() {
  phase "откатные образы documents и app"
  local ref key
  for key in "$LOCK_KEY_DOCUMENTS" "$LOCK_KEY_APP"; do
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

# config_delta <JSON боя до патча> <JSON после патча> <корень боя> <корень примерки> [<область>:
# <ИМЯ>=<значение>...]: сравнение конфигураций. Допустимое различие только: образы app и
# documents; новые переменные app (область A: должны быть и равняться значению); новая переменная
# documents (область D: значение или пусто, если compose пустое не выводит); основа сборки app
# (область B: аргумент сборки app в новой конфигурации равен значению lock). Корень примерки в её
# JSON заменяется на боевой: compose раскрывает относительные пути (контекст сборки `../..`, тома
# `../../db`, файлы окружения) от каталога файлов, а корень примерки отличается от боевого.
# Заменяется именно корень дерева, а не его подкаталог deploy: пути выше deploy тоже зависят от
# корня. Печатает строки «ФЛАГ <причина> <имя>» и «РАЗЛИЧИЕ <путь>» (только названия ключей,
# значения не печатаются); пусто - всё сходится. Код 2 - у конфигурации нет ожидаемой структуры.
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
    app_live, app_new = live["services"]["app"], new["services"]["app"]
    docs_live, docs_new = live["services"]["documents"], new["services"]["documents"]
    env_live = app_live.get("environment") or {}
    env_new = app_new.get("environment") or {}
    denv_live = docs_live.get("environment") or {}
    denv_new = docs_new.get("environment") or {}
    expect: dict[str, dict[str, str]] = {}
    for item in sys.argv[5:]:
        scope, pair = item.split(":", 1)
        name, value = pair.split("=", 1)
        expect.setdefault(scope, {})[name] = value
except (ValueError, KeyError, TypeError, AttributeError, OSError):
    sys.exit(2)
for name, want in expect.get("A", {}).items():
    if name not in env_new:
        print("ФЛАГ нет-переменной " + name)
    elif str(env_new[name]).strip() != want:
        print("ФЛАГ значение-не-эффективное " + name)
    env_new.pop(name, None)
    env_live.pop(name, None)
for name, want in expect.get("D", {}).items():
    got = denv_new.get(name)
    if got is None and want != "":
        print("ФЛАГ нет-переменной " + name)
    elif got is not None and str(got).strip().lower() != want.lower():
        print("ФЛАГ значение-не-эффективное " + name)
    denv_new.pop(name, None)
    denv_live.pop(name, None)
for name, want in expect.get("B", {}).items():
    for service, ref in ((app_live, None), (app_new, want)):
        args = (service.get("build") or {}).get("args")
        if isinstance(args, dict) and name in args:
            if ref is not None and str(args[name]) != ref:
                print("ФЛАГ основа-не-из-lock " + name)
            args.pop(name)
for service in (app_live, app_new, docs_live, docs_new):
    service.pop("image", None)
for where in paths(live, new, ""):
    print("РАЗЛИЧИЕ " + where)
' "$@"
}

# Дерево примерки: копия боевого deploy + файлы пакета и lock, секреты ссылками на боевые файлы.
# Сравнивается `compose config` боя (снимок ДО патча) и примерки: допустимо только различие
# образов app и documents, основы сборки app и трёх новых переменных платформы (две у app, одна у
# documents) с эффективными значениями; вся остальная конфигурация (app, documents, прочие
# сервисы, сети, тома) совпадает; пути сравниваются при одном корне (корень примерки заменяется
# на боевой). Профиль speech на бою выключен: его сервис в конфигурации не участвует (включённый
# профиль даст различие и отказ).
stage_tree() {
  phase "примерка новых файлов (бой не меняется)"
  STAGE_DIR="$WORK/stage"
  local deploy="$STAGE_DIR/deploy" rel secret live_cfg new_cfg delta rc=0 line bad="" flag
  local -a expect=()
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
  for flag in "${G9Q_APP_FLAGS[@]}"; do
    grep -qE "^[[:space:]]+$flag: \\\$\{$flag:-$FLAG_DEFAULT_VALUE\}[[:space:]]*\$" \
      "$deploy/$COMPOSE_PROJECT_FILE" \
      || refuse "в $COMPOSE_PROJECT_FILE нет строки $flag: \${$flag:-$FLAG_DEFAULT_VALUE}" \
        "(флаги G9q по умолчанию включены)"
  done
  for flag in "${EXPECT_APP_NEW[@]}"; do expect+=("A:$flag"); done
  expect+=("D:$PDF_TEXT_KEY=$PDF_TEXT_EFFECTIVE")
  expect+=("B:$BUILD_ARG_APP_BASE=$(lock_ref "$LOCK_KEY_APP_BASE")")
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
    "$LIVE_NEW_DIR" "$STAGE_DIR" "${expect[@]}")" || rc=$?
  ((rc == 0)) \
    || refuse "в конфигурации compose нет сервиса app или documents (структура не разобрана)"
  while IFS= read -r line; do
    [[ -z "$line" ]] || bad+="; $line"
  done <<<"$delta"
  [[ -z "$bad" ]] || refuse "новая конфигурация compose не сходится со снимком боя до патча" \
    "(допустимо: образы app и documents, основа сборки app из lock, переменные" \
    "$B24_MAX_BYTES_KEY, $B24_TIMEOUT_KEY и $PDF_TEXT_KEY с эффективными значениями):" \
    "${bad#; }"
  check "новые переменные в конфигурации" ok "значения как в .env боя, иначе умолчание платформы"
  check "прочая конфигурация" ok "совпадает со снимком боя до патча (образы app и documents," \
    "основа сборки app и три новые переменные)"
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
  for rel in "${PLATFORM_FILES[@]}"; do
    cmp -s "$PKG_DEPLOY/$rel" "$LIVE_DEPLOY/$rel" \
      || die "$EXIT_FAILED" "после замены $rel боя не равен пакетному"
  done
  check "замена файлов" ok "заменено файлов: $((${#PATCH_FILES[@]} + 1)) (включая images.lock);" \
    "копия платформы $PLATFORM_TO равна пакетной"
}
# Пересоздание ТОЛЬКО documents, без зависимостей и без удаления сирот; ждём healthy и /health 200.
recreate_documents() {
  phase "пересоздание documents"
  log "up -d --no-deps documents"
  dc_new up -d --no-deps "$DOCUMENTS_SERVICE" >>"$LOG_FILE" 2>&1 \
    || die "$EXIT_FAILED" "compose up documents не удался"
  wait_healthy "$DOCS_NAME" "$HEALTH_WAIT_S" \
    || die "$EXIT_FAILED" "$DOCS_NAME не стал healthy за ${HEALTH_WAIT_S} с"
  docs_health_wait "$READY_WAIT_S" \
    || die "$EXIT_FAILED" "/health documents не 200 за ${READY_WAIT_S} с: ${DOCS_HEALTH_BODY:0:160}"
  DOCS_STARTED_NEW="$(container_started "$DOCS_NAME")"
  check "сервис documents" ok "пересоздан, $DOCS_NAME healthy, /health 200"
}

# Пересоздание ТОЛЬКО app, без зависимостей и без удаления сирот (documents уже на новом образе).
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

# В окружении documents четыре флага G8x не потерялись (читаются только эти ключи) и
# DOCUMENTS_EDIT_PDF_TEXT равен эффективному значению (из .env боя, иначе пусто).
verify_documents_env() {
  local got
  docs_flags_check "$DOCS_NAME"
  [[ -z "$FLAGS_BAD" ]] \
    || die "$EXIT_FAILED" "в окружении documents потеряны флаги G8x (${DOCS_FLAGS[*]}):" \
      "$FLAGS_REPORT"
  got="$(container_env_value "$DOCS_NAME" "$PDF_TEXT_KEY")"
  [[ "${got,,}" == "$PDF_TEXT_EFFECTIVE" ]] \
    || die "$EXIT_FAILED" "в окружении documents $PDF_TEXT_KEY='${got:-<пусто>}'," \
      "ожидается '${PDF_TEXT_EFFECTIVE:-<пусто>}' (значение из .env боя или пусто)"
  check "окружение documents" ok "$FLAGS_REPORT $PDF_TEXT_KEY=${got:-<пусто: по умолчанию вкл>}"
}

# Проба POST /docx/pages: ответ ровно тот, что даёт новый образ documents (PAGES_PROBE_STATUS и
# PAGES_PROBE_ERROR). Образ старше G9r ручки не знает и отвечает 404. В журнал и вывод идут только
# статус и код ошибки (detail.error), тело ответа не печатается.
verify_pages_probe() {
  local out line code="" err=""
  out="$(docs_probe "$PAGES_ROUTE_JS" || true)"
  line="$(grep -v '^[[:space:]]*$' <<<"$out" | tail -n 1 || true)"
  read -r code err _ <<<"$line" || true
  [[ "$code" =~ ^[0-9]{3}$ ]] \
    || die "$EXIT_FAILED" "проба $PAGES_ROUTE_PATH не отвечает: ${line:0:120}"
  [[ "$code" == "$PAGES_PROBE_STATUS" && "$err" == "$PAGES_PROBE_ERROR" ]] \
    || die "$EXIT_FAILED" "проба $PAGES_ROUTE_PATH: ответ $code ${err:--}, ожидается" \
      "$PAGES_PROBE_STATUS $PAGES_PROBE_ERROR (documents не на образе G9r?)"
  check "проба $PAGES_ROUTE_PATH" ok "documents ответил $code $err (ручка страниц есть)"
}

# Проба POST /parse с locations=true на крошечном синтетическом PDF: образ G9r с включённой правкой
# вне таблиц отдаёт locations (формат, страницы, места); при явном выключателе в .env locations
# нет. Образ G9q3 и старше locations для PDF не отдаёт. В журнал и вывод идут только статус,
# формат и числа (PARSE_PROBE_ON или PARSE_PROBE_OFF), тело ответа не печатается.
verify_parse_probe() {
  local out line want
  out="$(docs_probe "$PARSE_ROUTE_JS" || true)"
  line="$(grep -v '^[[:space:]]*$' <<<"$out" | tail -n 1 || true)"
  if ((PDF_TEXT_ON)); then want="$PARSE_PROBE_ON"; else want="$PARSE_PROBE_OFF"; fi
  [[ "$line" =~ ^[0-9]{3}\  ]] \
    || die "$EXIT_FAILED" "проба $PARSE_ROUTE_PATH не отвечает: ${line:0:120}"
  [[ "$line" == "$want" ]] \
    || die "$EXIT_FAILED" "проба $PARSE_ROUTE_PATH: ответ '${line:0:60}', ожидается '$want'" \
      "(documents не на образе G9r или выключатель $PDF_TEXT_KEY иной?)"
  check "проба $PARSE_ROUTE_PATH" ok "documents ответил $line"
}

# Проверки documents целиком: до пересоздания app (при сбое откат дешёвый, app ещё не тронут).
verify_documents() {
  phase "проверки documents"
  : >"$RES/images-running.tsv"
  verify_image "$DOCS_NAME" "$LOCK_KEY_DOCUMENTS"
  verify_documents_env
  verify_pages_probe
  verify_parse_probe
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

# В окружении app после пересоздания: переменные G9q2, G9q, G9p, G8z и G8w на месте и со значениями,
# какие были у запущенного app до замены (читаются значения только этих ключей: флаги и числа), а
# обе новые переменные платформы есть и равны эффективным значениям (из .env боя, иначе умолчание).
verify_app_env() {
  local key missing="" got bad="" pair want
  for pair in "${PRE_APP_VALUES[@]}"; do
    key="${pair%%=*}"
    want="${pair#*=}"
    got="$(container_env_value "$CUTOVER_APP_CONTAINER" "$key")"
    if [[ -z "$got" ]]; then missing+=" $key"; elif [[ "$got" != "$want" ]]; then bad+=" $key"; fi
  done
  [[ -z "$missing" ]] \
    || die "$EXIT_FAILED" "в окружении app пропали переменные G9q2, G9q, G9p, G8z или G8w:$missing"
  [[ -z "$bad" ]] \
    || die "$EXIT_FAILED" "в окружении app изменились значения переменных G9q2, G9q, G9p, G8z" \
      "или G8w:$bad"
  bad=""
  for pair in "${EXPECT_APP_NEW[@]}"; do
    key="${pair%%=*}"
    want="${pair#*=}"
    got="$(container_env_value "$CUTOVER_APP_CONTAINER" "$key")"
    [[ -n "$got" ]] || die "$EXIT_FAILED" "в окружении app нет новой переменной $key"
    [[ "$got" == "$want" ]] || bad+=" $key=$got (ожидается $want)"
  done
  [[ -z "$bad" ]] \
    || die "$EXIT_FAILED" "в окружении app новые переменные не равны эффективным значениям:$bad"
  check "окружение app" ok "переменные G9q2, G9q, G9p, G8z и G8w на месте и прежние;" \
    "новые переменные: ${EXPECT_APP_NEW[*]}"
}

# documents после пересоздания app не перезапускался: StartedAt тот же, что сразу после его up.
verify_documents_stable() {
  local started
  started="$(container_started "$DOCS_NAME")"
  [[ -n "$DOCS_STARTED_NEW" && "$started" == "$DOCS_STARTED_NEW" ]] \
    || die "$EXIT_FAILED" "$DOCS_NAME перезапускался при пересоздании app:" \
      "StartedAt $DOCS_STARTED_NEW -> $started"
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
  verify_image "$CUTOVER_APP_CONTAINER" "$LOCK_KEY_APP"
  verify_ready
  verify_app_env
  verify_documents_env
  verify_documents_stable
  report_other_containers
  verify_routes
  verify_pages_probe
  verify_parse_probe
  soak
}

# ---------------------------------------------------------------------------------------------
# Откат
# ---------------------------------------------------------------------------------------------
# rollback_patch <каталог запуска патча>: все заменённые файлы (копия платформы, при замене -
# compose.project.yml) и images.lock из бэкапа, up -d --no-deps documents и app на образы G9q3,
# проверки. 0 - бой как до патча и проверен; иначе 1.
ROLLBACK_FAILED=0
rb_check() { # rb_check <имя> <ok|fail> <описание>
  check "откат: $1" "$2" "$3"
  [[ "$2" != fail ]] || ROLLBACK_FAILED=$((ROLLBACK_FAILED + 1))
}
rollback_patch() {
  local run="$1" backup live rel body bots name want got docs_name
  local saved_state="$STATE_FILE" replaced=()
  STATE_FILE="$run/state.env"
  backup="$(state_get BACKUP_DIR)"
  live="$(state_get LIVE_DEPLOY)"
  docs_name="$(state_get DOCUMENTS_NAME)"
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
    && rb_check "файлы дерева" ok "заменённые файлы и images.lock возвращены из бэкапа" \
    || rb_check "файлы дерева" fail "файлов не совпало с бэкапом: $bad"
  # 2. Только documents и app, на образы G9q3: без down, без --remove-orphans.
  CUTOVER_NEW_DIR="$(dirname "$live")"
  dc_new up -d --no-deps "$DOCUMENTS_SERVICE" >>"$LOG_FILE" 2>&1 \
    && rb_check "поднят documents" ok "up -d --no-deps documents" \
    || rb_check "поднят documents" fail "compose up не удался"
  if [[ -n "$docs_name" ]]; then
    wait_healthy "$docs_name" "$HEALTH_WAIT_S" \
      && rb_check "documents работает" ok "$docs_name" \
      || rb_check "documents работает" fail "$docs_name не стал healthy за ${HEALTH_WAIT_S} с"
  fi
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
  log "ОТКАТ ПАТЧА ВЫПОЛНЕН: файлы дерева из бэкапа, documents и app на образах G9q3," \
    "проверки прошли"
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
  check_g9q_applied
  check_changes
  check_new_settings
  check_battle_health
  check_resources
  ensure_images
  stage_tree
  check_rollback_images
  if ((PREFLIGHT_ONLY)); then
    check "режим" ok "--preflight-only: бой не менялся"
    state_set RESULT "PREFLIGHT_OK"
    return 0
  fi
  make_backup
  apply_files
  recreate_documents
  verify_documents
  recreate_app
  verify_app
  state_set RESULT OK
}
main
