#!/usr/bin/env bash
# Патч G9w: платформа 1.1.11 -> 1.1.12 (labops-pii 1.3.0) и образы проекта 1.1.12-pragmatika.1
# (КРАСНАЯ ЗОНА: запускает только владелец на боевом хосте). Меняются ЧЕТЫРЕ образа: pseudonymizer,
# mask, documents и app. Из файлов дерева заменяются ТОЛЬКО images.lock и
# platform/PLATFORM-VERSION. compose.yml, compat.env, compose.project.yml и
# platform/compose.base.yml этим этапом не менялись: патч сверяет боевые файлы с эталоном пакета
# (reference/) и ничего из них не заменяет. .env, секреты, БД и миграции не меняются, новых
# переменных нет. Ставится СТРОГО ПОСЛЕ патча G9q4 (app и documents 1.1.11-pragmatika.1).
#
# Использование:
#   bash patch.sh [--preflight-only] [--signatures-verified ФАЙЛ] [--images-tar ФАЙЛ]
#                 [--config ФАЙЛ] [--out-dir КАТАЛОГ] [--soak-seconds N] [--expected-bots N]
#   bash patch.sh --rollback [--run-dir КАТАЛОГ]   откат применённого патча вручную
#   bash patch.sh --restore-pseudonymizer-volume [--run-dir КАТАЛОГ]
#       вернуть том псевдонимизатора из бэкапа этого патча (ЗАПИСИ ПОСЛЕ БЭКАПА ТЕРЯЮТСЯ; обычный
#       откат том не трогает). Можно вместе с --rollback: сначала откат, затем том.
#   bash patch.sh --help
#
# Образы на хост заранее: у боя нет входа в реестр, патч НИЧЕГО не скачивает. На Fornex:
# `bash transfer-images-9w.sh --host root@<бой>` (из пакета) либо
# `bash transfer-images-9w.sh --images-tar ФАЙЛ` и здесь `--images-tar ФАЙЛ`.
#
# Что делает (бой = compose-проект `pragmatika`, дерево /opt/pragmatika-v2/deploy):
#   0. Предусловия, бой не меняется: целостность пакета, подписи всех образов lock, в пакете из
#      файлов deploy/ только platform/PLATFORM-VERSION, патч ещё не применён, бой на G9q4 (lock
#      1.1.11-pragmatika.1, платформа 1.1.11, app и documents ЗАПУЩЕНЫ на закреплённых digest
#      G9q4), pseudonymizer запущен на образе lock боя и healthy, том псевдонимизатора подключён,
#      боевые файлы compose равны эталону пакета, lock пакета меняет только версию, четыре образа и
#      основы app и documents, список контрольных сумм платформы не изменился, переменные прошлых
#      патчей на месте, /ready 200 и боты, диск и память, все четыре новых образа на хосте по
#      digest, откатные образы на месте, конфигурация compose после замены отличается от боевой
#      только образами четырёх сервисов и аргументом сборки BAI_APP_BASE. Любое нарушение - код 3.
#      Сервис mask: запущен - пересоздаётся; контейнера нет или он остановлен - НЕ запускается
#      (патч состав стека не меняет, новый образ будет взят при следующем запуске); иное
#      состояние (перезапуск по кругу, пауза) - отказ.
#   1. Бэкап: весь каталог deploy (права сохраняются), список контейнеров и образов; затем
#      pseudonymizer останавливается и том pseudonymizer-data архивируется (600), архив
#      проверяется: распаковка и PRAGMA integrity_check. Пока сервис стоит, app не отправляет
#      текст в модель (сбой псевдонимизации - отказ хода).
#   2. Замена images.lock и platform/PLATFORM-VERSION; по очереди `up -d --no-deps`:
#      pseudonymizer -> mask -> documents -> app (без down, без --remove-orphans, без
#      --force-recreate), после каждого - ожидание здоровья и проверки.
#   3. Проверки: образы = lock (по digest); labops-pii 1.3.0 в pseudonymizer и синтетическая пара
#      «фамилия имя» маскируется и восстанавливается в служебном треде patch-9w-probe (пишет строку
#      в боевое хранилище, срок хранения обычный, 90 суток); переменные PSEUDONYMIZER_*, PII_*,
#      MEDIA_MASKER_* равны прежним (сравниваются по хэшам, значения не печатаются); флаги прошлых
#      патчей равны прежним; пробы documents отвечают как до патча; /ready и боты; маршруты стека;
#      выдержка (по умолчанию 2 минуты: пересозданные сервисы не перезапускаются).
#   Любой сбой после начала изменений -> автооткат: images.lock и PLATFORM-VERSION из бэкапа,
#   `up -d --no-deps` в обратном порядке (app, documents, mask, pseudonymizer), проверка /ready.
#   Том псевдонимизатора при откате НЕ восстанавливается: записи новой версии читаются прежней
#   (проверено на стенде).
# Результат: ~/patch9w-<время>.tgz (журнал и проверки; без секретов и данных) - вернуть
# разработчику.
#
# Коды выхода: 0 - выполнено и проверено; 1 - сбой, откат выполнен (бой как до патча); 2 -
# неверный вызов; 3 - отказ по предусловиям, бой не тронут; 4 - сбой, откат или восстановление
# тома тоже не удались (ручное вмешательство: OWNER-RUNBOOK.md, журнал).
set -euo pipefail
umask 077

# Переменные оболочки сильнее .env и compose: переменная, экспортированная в сеансе владельца,
# подменила бы значения боя. Сбрасываются все, что читают четыре заменяемых сервиса.
SHELL_UNSET_RE='^(PSEUDONYMIZER_|PII_|MEDIA_MASKER_|DOCUMENTS_|BAI_IMAGE_|MASK_|CHAT_|B24_'
SHELL_UNSET_RE+='|PRICE|YANDEX_|VISION_|IMAGE_)|^(BAI_VERSION|BAI_APP_BASE|SHORTLIST_PAGING_ENABLED'
SHELL_UNSET_RE+='|SUPPLIER_DISCOVERY_ENABLED|DOCX_PAGES_ENABLED|STEP_TEXT_SEPARATE_ENABLED'
SHELL_UNSET_RE+='|EMPTY_REPLY_GUARD_ENABLED)$'
while IFS= read -r exported; do
  [[ ! "$exported" =~ $SHELL_UNSET_RE ]] || unset "$exported"
done < <(compgen -e)

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
  PKG_REFERENCE="$HERE/reference/deploy"
  LOCK_SRC="$HERE/images.lock"
else
  PKG="$(cd "$HERE/../.." && pwd)" # дерево проекта (стенды и тесты)
  LIB="$HERE/../cutover/lib.sh"
  ROUTES_TOOLS_DIR="$PKG/tools"
  ROUTES_MANIFEST="$PKG/deploy/cutover/routes.tsv"
  PKG_DEPLOY="${PATCH9W_PKG_DEPLOY:-$PKG/deploy}"
  PKG_REFERENCE="${PATCH9W_PKG_REFERENCE:-$PKG/deploy}"
  LOCK_SRC="${PATCH9W_LOCK:-$PKG/deploy/images.lock}"
fi
# shellcheck source=../cutover/lib.sh
source "$LIB"
COSIGN_PUB="${PATCH9W_COSIGN_PUB:-$PKG/cosign.pub}"
[[ -f "$COSIGN_PUB" ]] || COSIGN_PUB="$PKG/deploy/cosign.pub"

PLATFORM_VERSION_FILE="platform/PLATFORM-VERSION"
PLATFORM_VERSION_KEY="PLATFORM_PACKAGES_VERSION"
PLATFORM_BASE_NAME="compose.base.yml"
PLATFORM_FROM="1.1.11"
PLATFORM_TO="1.1.12"
LOCK_VERSION_FROM="1.1.11-pragmatika.1"
LOCK_VERSION_TO="1.1.12-pragmatika.1"
# Боевое состояние после G9q4: образы app и documents (digest из images.lock этапа 9v).
FROM_APP_DIGEST="sha256:7fc173b46a41dbbd572aaf10d05f28ae828a5eaab0d2924428c342d39bcdbea8"
FROM_DOCS_DIGEST="sha256:69319c5553caf23ddc42a75d503c68117b9d545b235d25f26ed0adba521ed064"
G9Q4_HINT="патч G9w ставится только поверх G9q4 (app и documents ${LOCK_VERSION_FROM},"
G9Q4_HINT+=" платформа ${PLATFORM_FROM})"
# Файлы дерева, которые патч вправе заменить (кроме images.lock в корне пакета), и эталоны,
# которые он только сверяет с боем. ДОЛЖНЫ совпадать со списками в
# tools/build-patch-9w-package.sh.
PATCH_FILE_ALLOW=(platform/PLATFORM-VERSION)
REFERENCE_FILES=(compose.yml compat.env compose.project.yml platform/compose.base.yml)
# Ключи lock, которые патч вправе менять, и те, что обязаны смениться.
PATCH_LOCK_KEYS="BAI_VERSION BAI_IMAGE_APP BAI_IMAGE_APP_BASE BAI_IMAGE_DOCUMENTS"
PATCH_LOCK_KEYS+=" BAI_IMAGE_DOCUMENTS_BASE BAI_IMAGE_PSEUDONYMIZER BAI_IMAGE_MASK"
LOCK_KEY_APP="BAI_IMAGE_APP"
LOCK_KEY_APP_BASE="BAI_IMAGE_APP_BASE"
LOCK_KEY_VERSION="BAI_VERSION"
BUILD_ARG_APP_BASE="BAI_APP_BASE"
# Сервисы в порядке замены; откат идёт в обратном порядке.
APPLY_ORDER=(pseudonymizer mask documents app)
ROLLBACK_ORDER=(app documents mask pseudonymizer)
declare -A SERVICE_LOCK_KEY=([pseudonymizer]=BAI_IMAGE_PSEUDONYMIZER [mask]=BAI_IMAGE_MASK
  [documents]=BAI_IMAGE_DOCUMENTS [app]=BAI_IMAGE_APP)
# Переменные app от прошлых патчей (флаги и числа, не секреты): до и после замены равны.
G9S_APP_KEYS=(CHAT_ATTACHMENTS_STORE_ENABLED CHAT_ATTACHMENTS_RETENTION_DAYS
  CHAT_ATTACHMENTS_MAX_BYTES)
KEEP_APP_KEYS=("${G9S_APP_KEYS[@]}" PRICE_FILE_ONCE_PER_TURN_ENABLED STEP_TEXT_SEPARATE_ENABLED
  EMPTY_REPLY_GUARD_ENABLED PRICE_EDIT_DB_WRITE_ENABLED
  PRICE_EDIT_TEXT_BLOCKS_ENABLED PRICE_EDIT_FIRST_ENABLED DOCX_PAGES_ENABLED
  SHORTLIST_PAGING_ENABLED SUPPLIER_DISCOVERY_ENABLED
  YANDEX_SEARCH_MAX_CONCURRENCY YANDEX_SEARCH_MIN_INTERVAL_MS
  B24_CALL_RECORDING_MAX_BYTES B24_CALL_RECORDING_TIMEOUT_MS
  PRICES_SCAN_FLOW_ENABLED VISION_TEXT_FIRST)
# Переменные documents: четыре флага G8x (обязаны быть) и DOCUMENTS_EDIT_PDF_TEXT (может быть
# пустой); значения до и после равны.
DOCS_KEYS=(DOCUMENTS_EDIT_PPTX DOCUMENTS_EDIT_PDF DOCUMENTS_PPT_CONVERT
  DOCUMENTS_EDIT_PDF_FALLBACK_FONT)
DOCS_OPTIONAL_KEYS=(DOCUMENTS_EDIT_PDF_TEXT)
# Имена переменных псевдонимизатора и mask (у всех четырёх сервисов): сверяются по хэшам значений.
PII_ENV_RE='^(PSEUDONYMIZER_|MEDIA_MASKER_|PII_)'
PII_SECRET_NAME="PII_ALLOWED_WORDS"
PSEUDO_VOLUME_MOUNT="/data"
PSEUDO_DB_NAME="pseudonymizer.sqlite3"
VOLUME_ARCHIVE="pseudonymizer-data.tgz"
# Запас диска под бэкап тома: архив, распакованная копия проверки и копия перед восстановлением.
VOLUME_SPACE_FACTOR=3
STOP_TIMEOUT_S=60
# Проверка синтетической пары в служебном треде. Значения выдуманы; в журнал идут только факты.
PROBE_THREAD="patch-9w-probe"
PII_VERSION_TO="1.3.0"
PII_PROBE_OK="version=$PII_VERSION_TO masked=yes restored=yes"
PII_PROBE_PY='
import json, os, time, urllib.error, urllib.request
import labops_pii

# Пары «фамилия имя» без отчества: версия 1.1.4 их не находит, 1.3.0 находит.
SAMPLES = (("Позвоните Смирнов Кирилл завтра.", "Смирнов"),
           ("Позвоните Иванов Сергей завтра.", "Иванов"))
BUSY, ATTEMPTS, PAUSE_S, TIMEOUT_S = 503, 5, 2, 30


def call(route, text):
    request = urllib.request.Request(
        "http://127.0.0.1:" + os.environ.get("PSEUDONYMIZER_PORT", "8300") + route,
        data=json.dumps({"thread_id": os.environ["PROBE_THREAD"], "text": text}).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + os.environ["PSEUDONYMIZER_API_TOKEN"]})
    for attempt in range(ATTEMPTS):
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_S) as reply:
                return json.load(reply)["text"]
        except urllib.error.HTTPError as error:
            if error.code != BUSY or attempt == ATTEMPTS - 1:
                raise
            time.sleep(PAUSE_S)


masked_ok, restored_ok = "no", "no"
try:
    for original, surname in SAMPLES:
        masked = call("/pseudonymize", original)
        if "[PERSON_" in masked and surname not in masked:
            masked_ok = "yes"
            restored_ok = "yes" if call("/restore", masked) == original else "no"
            break
    print("version=%s masked=%s restored=%s" % (labops_pii.__version__, masked_ok, restored_ok))
except Exception as error:
    print("version=%s error=%s %s" % (labops_pii.__version__, type(error).__name__,
                                      getattr(error, "code", "")))
'
# Проверка архива тома: распаковка в слой одноразового контейнера, integrity_check и счётчики.
ARCHIVE_CHECK_PY='
import os, sqlite3, sys, tarfile, tempfile
target = tempfile.mkdtemp()
with tarfile.open("/bk/" + os.environ["ARCHIVE_NAME"], "r:gz") as archive:
    archive.extractall(target, filter="data")
path = os.path.join(target, os.environ["DB_NAME"])
if not os.path.isfile(path):
    sys.exit("нет файла хранилища в архиве")
db = sqlite3.connect(path)
verdict = [row[0] for row in db.execute("PRAGMA integrity_check")]
if verdict != ["ok"]:
    sys.exit("integrity_check не ok")
rows = db.execute("SELECT COUNT(*) FROM replacements").fetchone()[0]
threads = db.execute("SELECT COUNT(DISTINCT thread_id) FROM replacements").fetchone()[0]
print("integrity=ok rows=%d threads=%d" % (rows, threads))
'
DOCUMENTS_SERVICE="documents"
APP_SERVICE="app"
# Адрес documents в окружении app (по нему идут и пробы), если ключ в окружении не найден.
DOCUMENTS_URL_KEY="DOCUMENTS_URL"
DOCUMENTS_URL_DEFAULT="http://documents:8310"
DOCS_HEALTH_JS="try {
  const base = process.env.PATCH_DOCS_URL ?? '$DOCUMENTS_URL_DEFAULT';
  const r = await fetch(base + '/health');
  console.log(r.status + ' ' + (await r.text()));
  process.exit(r.ok ? 0 : 1);
} catch (e) { console.log('documents недоступен: ' + e.message); process.exit(1); }"
# Проба POST /docx/pages с некорректным телом: файл не разбирается; ответ образа - 422
# bad_request. В журнал идут только статус и код ошибки.
PAGES_ROUTE_PATH="/docx/pages"
PAGES_PROBE_BODY='{"file_name":"probe.docx","content_base64":"%%%"}'
PAGES_PROBE_WANT="${PATCH9W_PAGES_PROBE:-422 bad_request}"
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
# Проба POST /parse с locations=true на крошечном синтетическом PDF, который строится внутри
# пробы. В журнал идут только статус, формат, число страниц и мест («200 pdf 1 1»). Ожидаемый
# ответ после замены - тот же, что у прежнего образа до замены (выключатели оператора учтены).
PARSE_ROUTE_PATH="/parse"
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
SOAK_POLL_S=${PATCH9W_SOAK_POLL_S:-15}
PREFLIGHT_WAIT_S=${PATCH9W_PREFLIGHT_WAIT_S:-30}
DEPLOYED_MARK=".cutover-deployed"
BACKUP_PREFIX="pragmatika-patch9w"
ARCHIVE_PREFIX="patch9w"
RUN_PREFIX="patch-9w"
ENV_FILE_NAME=".env"
# Запасы: свободный диск (МиБ; образы уже на хосте), добавка при --images-tar (во сколько раз
# больше размера архива), доступная память (МиБ).
PATCH_MIN_DISK_MIB="${PATCH9W_MIN_DISK_MIB:-2048}"
PATCH_MIN_AVAILABLE_MIB="${PATCH9W_MIN_AVAILABLE_MIB:-1024}"
TAR_SPACE_FACTOR=3

# ---------------------------------------------------------------------------------------------
# Аргументы и настройка
# ---------------------------------------------------------------------------------------------
SIGNATURES_FILE=""
IMAGES_TAR=""
CONFIG_FILE=""
SOAK_S="$DEFAULT_SOAK_S"
PREFLIGHT_ONLY=0
ROLLBACK_MODE=0
RESTORE_VOLUME_MODE=0
RUN_DIR_ARG=""
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
    --restore-pseudonymizer-volume) RESTORE_VOLUME_MODE=1 ;;
    --run-dir) RUN_DIR_ARG="${2:?--run-dir КАТАЛОГ}"; shift ;;
    --help | -h) usage; exit "$EXIT_OK" ;;
    *) echo "неизвестный аргумент: $1" >&2; usage >&2; exit "$EXIT_USAGE" ;;
  esac
  shift
done
[[ "$SOAK_S" =~ ^[0-9]+$ ]] || { echo "--soak-seconds: нужно число" >&2; exit "$EXIT_USAGE"; }
[[ -z "$EXPECT_BOTS_ARG" || "$EXPECT_BOTS_ARG" =~ ^[0-9]+$ ]] \
  || { echo "--expected-bots: нужно число" >&2; exit "$EXIT_USAGE"; }
MANUAL_MODE=$((ROLLBACK_MODE || RESTORE_VOLUME_MODE))
if ((PREFLIGHT_ONLY && MANUAL_MODE)); then
  echo "--preflight-only несовместим с --rollback и --restore-pseudonymizer-volume" >&2
  exit "$EXIT_USAGE"
fi
[[ -n "$SIGNATURES_FILE" || ! -f "$HERE/signatures.txt" ]] || SIGNATURES_FILE="$HERE/signatures.txt"

[[ -z "$CONFIG_FILE" ]] || cut_load_config "$CONFIG_FILE" || exit "$EXIT_USAGE"
if ((MANUAL_MODE)); then
  # Ручные режимы: настройка берётся из каталога запуска патча (patch.conf), если он есть.
  CUTOVER_HOME="${CUTOVER_HOME:-$HOME/.pragmatika-cutover}"
  RUN_DIR_ARG="${RUN_DIR_ARG:-$CUTOVER_HOME/$RUN_PREFIX-latest}"
  [[ -d "$RUN_DIR_ARG" ]] || { echo "нет каталога запуска: $RUN_DIR_ARG" >&2; exit "$EXIT_USAGE"; }
  [[ ! -f "$RUN_DIR_ARG/patch.conf" ]] || cut_load_config "$RUN_DIR_ARG/patch.conf"
fi
[[ -z "$EXPECT_BOTS_ARG" ]] || CUTOVER_EXPECT_BOTS="$EXPECT_BOTS_ARG"
cut_defaults

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$CUTOVER_HOME"
if ((MANUAL_MODE)); then
  RUN_DIR_ORIG="$(cd "$RUN_DIR_ARG" && pwd)"
  if ((ROLLBACK_MODE)); then
    cut_init_run "$CUTOVER_HOME/$RUN_PREFIX-rollback-$RUN_ID"
  else
    cut_init_run "$CUTOVER_HOME/$RUN_PREFIX-restore-$RUN_ID"
  fi
else
  cut_init_run "$CUTOVER_HOME/$RUN_PREFIX-$RUN_ID"
fi
ARCHIVE_PATH=""
ROLLED_BACK=0
LIVE_NEW_DIR="$CUTOVER_NEW_DIR"
LIVE_DEPLOY="$LIVE_NEW_DIR/deploy"
# Имена контейнеров четырёх сервисов (из предусловий) и StartedAt сразу после пересоздания.
declare -A SERVICE_NAME=() STARTED_NEW=()
# 1 - mask запущен до патча и пересоздаётся; 0 - не запускается.
MASK_RUNNING=0
# Ответы проб documents до замены.
PAGES_BEFORE=""
PARSE_BEFORE=""

die() { # die <код> <сообщение...>
  local code="$1"
  shift
  log "ОШИБКА: $*"
  state_set RESULT "FAILED: $*"
  exit "$code"
}

# refuse <сообщение>: отказ по предусловиям, бой не тронут. После начала изменений - сбой хода
# (код 1): on_exit выполнит откат.
refuse() {
  check "предусловия" fail "$*"
  if [[ "$(state_get PATCH_STARTED)" == 1 ]]; then die "$EXIT_FAILED" "$*"; fi
  die "$EXIT_REFUSED" "отказ: $*"
}

# Настройка запуска для ручных режимов (без секретов: пути и числа).
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
# Значения секретов боя в список маскирования журнала; список слов-исключений ПДн тоже.
collect_secret_values() {
  local secrets_dir file
  secrets_dir="${CUTOVER_SECRETS_DIR:-$(env_value "$CUTOVER_ENV_FILE" SECRETS_DIR)}"
  secrets_dir="${secrets_dir:-/etc/pragmatika/secrets}"
  for file in "$CUTOVER_ENV_FILE" "$LIVE_DEPLOY/.env" "$LIVE_DEPLOY/secrets.env" \
    "$secrets_dir/secrets.env" "$LIVE_DEPLOY/$MASK_TOKEN_FILE_NAME"; do
    [[ -f "$file" ]] || continue
    python3 -I - "$file" "$MIN_SECRET_LEN" "$PII_SECRET_NAME" >>"$SECRETS_LIST" <<'PY'
import re, sys
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    if "=" not in line or line.lstrip().startswith("#"):
        continue
    name, raw = line.split("=", 1)
    if name.strip() != sys.argv[3] and not re.search(r"(KEY|TOKEN|PASSWORD|SECRET)", name):
        continue
    raw = raw.strip()
    if raw[:1] in "'\"" and raw[-1:] == raw[:1]:
        raw = raw[1:-1]
    if len(raw) >= int(sys.argv[2]):
        print(raw)
PY
  done
}

# Архив результатов ~/patch9w-<время>.tgz; значение секрета в нём - архив удаляется.
finish_results() {
  local files
  cp "$STATE_FILE" "$RES/state.env" 2>/dev/null || true
  ARCHIVE_PATH="$CUTOVER_OUT_DIR/$ARCHIVE_PREFIX-$RUN_ID.tgz"
  tar -C "$RUN_DIR" -czf "$ARCHIVE_PATH" results 2>/dev/null || { ARCHIVE_PATH=""; return 0; }
  if [[ -s "$SECRETS_LIST" ]] && files="$(mktemp -d "$WORK/leak.XXXXXX")"; then
    tar -C "$files" -xzf "$ARCHIVE_PATH"
    if grep -rIqF -f <(awk 'length($0) >= '"$MIN_SECRET_LEN" "$SECRETS_LIST") "$files"; then
      rm -f -- "${ARCHIVE_PATH:?}"
      ARCHIVE_PATH=""
      echo "ОШИБКА: в архиве результатов найдено значение секрета, архив удалён" >&2
    fi
  fi
}

on_exit() {
  local rc=$?
  trap - EXIT
  # Повторный сигнал не должен обрывать откат.
  trap '' INT TERM HUP
  set +e
  # Сигнал мог прийти внутри команды с перенаправлением в журнал: вывод возвращается на терминал.
  # Обрыв сеанса (HUP): терминала больше нет, вывод в него только мешал бы откату.
  if ((rc == EXIT_HUP)); then exec >/dev/null 2>&1; else exec 1>&3 2>&4; fi
  if ((rc != EXIT_OK && rc != EXIT_REFUSED && rc != EXIT_USAGE)); then
    if ((MANUAL_MODE)); then
      [[ "$(state_get MANUAL_STARTED)" != 1 ]] || rc="$EXIT_STUCK"
    elif [[ "$(state_get PATCH_STARTED)" == 1 && "$ROLLED_BACK" != 1 ]]; then
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
EXIT_HUP=129
exec 3>&1 4>&2
trap on_exit EXIT
trap 'exit 130' INT TERM
trap 'exit 129' HUP

# ---------------------------------------------------------------------------------------------
# Вспомогательное
# ---------------------------------------------------------------------------------------------
dir_free_mib() { df -Pm "$1" 2>/dev/null | awk 'NR == 2 { print $4 }'; }
mem_available_mib() { awk '/^MemAvailable:/ { print int($2 / '"$KIB_PER_MIB"') }' /proc/meminfo; }
# existing_dir <путь>: ближайший существующий каталог (для df по ещё не созданному).
existing_dir() {
  local dir="$1"
  while [[ ! -d "$dir" ]]; do dir="$(dirname "$dir")"; done
  printf '%s' "$dir"
}

# service_containers <сервис>: имена контейнеров сервиса compose-проекта (включая остановленные).
service_containers() {
  docker ps -a --filter "label=com.docker.compose.project=$CUTOVER_PROJECT" \
    --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | sort
}

lock_ref() { lock_value "$LOCK_SRC" "$1" || true; }
live_lock_ref() { lock_value "$LIVE_DEPLOY/images.lock" "$1" || true; }

container_env_value() { # container_env_value <контейнер> <ИМЯ>: значение ОДНОЙ переменной
  { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null || true; } \
    | sed -n "s/^$2=//p" | head -1
}
container_env_has() { # container_env_has <контейнер> <ИМЯ>: переменная есть (пусть и пустая)
  { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null || true; } \
    | grep -q "^$2="
}
# pii_env_digest <контейнер>: строки «ИМЯ<TAB>sha256 значения» для переменных псевдонимизатора и
# mask. Значения идут только по конвейеру и нигде не сохраняются.
pii_env_digest() {
  docker inspect -f '{{json .Config.Env}}' "$1" 2>/dev/null | python3 -I -c '
import hashlib, json, re, sys
found = {}
for item in json.load(sys.stdin) or []:
    name, _, value = item.partition("=")
    if re.match(sys.argv[1], name):
        found[name] = hashlib.sha256(value.encode("utf-8", "surrogateescape")).hexdigest()
for name in sorted(found):
    print(name + "\t" + found[name])
' "$PII_ENV_RE"
}

container_started() { docker inspect -f '{{.State.StartedAt}}' "$1" 2>/dev/null || true; }
container_restarts() { docker inspect -f '{{.RestartCount}}' "$1" 2>/dev/null || echo "?"; }
container_image_id() { docker inspect -f '{{.Image}}' "$1" 2>/dev/null || true; }
container_status() { docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null || echo отсутствует; }
container_health() { docker inspect -f "$HEALTH_FORMAT" "$1" 2>/dev/null || echo отсутствует; }
ref_image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || echo "?"; }
app_bun_image() { container_image_id "${SERVICE_NAME[app]}"; }

# docs_probe <JS>: одноразовый контейнер в сети app (образ с bun берётся у самого app).
docs_probe() {
  local image url
  image="$(app_bun_image)"
  [[ -n "$image" ]] || { echo "нет контейнера app"; return 1; }
  url="$(container_env_value "${SERVICE_NAME[app]}" "$DOCUMENTS_URL_KEY")"
  docker run --rm --network "container:${SERVICE_NAME[app]}" --memory "$ONESHOT_MEM" \
    -e "PATCH_DOCS_URL=${url:-$DOCUMENTS_URL_DEFAULT}" -e "PATCH_PAGES_BODY=$PAGES_PROBE_BODY" \
    --entrypoint bun "$image" -e "$1" 2>&1
}
# probe_line <JS>: последняя непустая строка ответа пробы.
probe_line() {
  local out
  out="$(docs_probe "$1" || true)"
  grep -v '^[[:space:]]*$' <<<"$out" | tail -n 1 || true
}

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

# wait_service <сервис> <секунд>: здоровье сервиса (mask - ответ его /health, documents - ещё и
# /health из сети app).
wait_service() {
  local svc="$1" limit="$2" name="${SERVICE_NAME[$1]}"
  # Коды возврата явные: функция вызывается и из обработчика выхода (откат), где `return` без
  # значения отдаёт статус команды, прервавшей скрипт.
  if [[ "$svc" == mask ]]; then
    cut_wait_mask_ready "$name" "$(app_bun_image)" "$limit" || return 1
    return 0
  fi
  wait_healthy "$name" "$limit" || return 1
  [[ "$svc" != documents ]] || docs_health_wait "$limit"
}

# volume_run <образ> <программа sh> [аргументы docker run]: одноразовый контейнер без сети.
volume_run() {
  local image="$1" script="$2"
  shift 2
  docker run --rm --network none --user 0:0 "$@" --entrypoint sh "$image" -c "$script"
}

# check_archive <образ> <каталог> <имя архива>: печатает «integrity=ok rows=N threads=M».
check_archive() {
  docker run --rm --network none --user 0:0 -v "$2:/bk:ro" -e "ARCHIVE_NAME=$3" \
    -e "DB_NAME=$PSEUDO_DB_NAME" --entrypoint python "$1" -c "$ARCHIVE_CHECK_PY"
}

# archive_volume <образ> <каталог> <имя архива>: архив тома (600, владелец - запускающий).
archive_volume() {
  volume_run "$1" "tar -czf /out/$3 -C $PSEUDO_VOLUME_MOUNT . \
&& chown $(id -u):$(id -g) /out/$3 && chmod 600 /out/$3" \
    -v "$CUTOVER_PSEUDO_VOLUME:$PSEUDO_VOLUME_MOUNT:ro" -v "$2:/out"
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
  local svc rel
  for svc in "${APPLY_ORDER[@]}"; do
    [[ -n "$(lock_ref "${SERVICE_LOCK_KEY[$svc]}")" ]] \
      || refuse "в images.lock пакета нет ${SERVICE_LOCK_KEY[$svc]}"
  done
  [[ -n "$(lock_ref "$LOCK_KEY_APP_BASE")" ]] \
    || refuse "в images.lock пакета нет $LOCK_KEY_APP_BASE (основа сборки app)"
  [[ "$(lock_ref "$LOCK_KEY_VERSION")" == "$LOCK_VERSION_TO" ]] \
    || refuse "BAI_VERSION lock пакета '$(lock_ref "$LOCK_KEY_VERSION")'," \
      "ожидается $LOCK_VERSION_TO"
  # Проверки состава - для пакета (в дереве проекта лежит всё). Из файлов дерева в пакете только
  # разрешённые, эталоны - только перечисленные, каталога db нет.
  if [[ "$PKG_DEPLOY" == "$HERE/deploy" ]]; then
    [[ ! -e "$HERE/db" && ! -e "$HERE/stack/db" && ! -e "$PKG_DEPLOY/db" ]] \
      || refuse "в патче есть каталог db: патч не должен менять БД и миграции"
    check_dir_files "$PKG_DEPLOY" deploy "${PATCH_FILE_ALLOW[@]}"
    check_dir_files "$PKG_REFERENCE" reference/deploy "${REFERENCE_FILES[@]}"
  fi
  for rel in "${PATCH_FILE_ALLOW[@]}"; do
    [[ -f "$PKG_DEPLOY/$rel" ]] || refuse "в пакете нет deploy/$rel (копия платформы $PLATFORM_TO)"
  done
  for rel in "${REFERENCE_FILES[@]}"; do
    [[ -f "$PKG_REFERENCE/$rel" ]] || refuse "в пакете нет эталона reference/deploy/$rel"
  done
  check_platform_copy
  [[ -f "$ROUTES_MANIFEST" && -f "$ROUTES_TOOLS_DIR/check-routes.sh" \
    && -f "$ROUTES_TOOLS_DIR/route-flags.tsv" ]] \
    || refuse "в пакете нет инструментов проверки (tools/, routes.tsv)"
  check "состав пакета" ok "lock ${LOCK_VERSION_TO}, платформа $PLATFORM_TO, из файлов deploy" \
    "только ${PATCH_FILE_ALLOW[*]}, эталоны compose на месте"
}

# check_dir_files <каталог> <название> <разрешённые...>: в каталоге пакета нет других файлов.
check_dir_files() {
  local dir="$1" title="$2" rel
  shift 2
  [[ -d "$dir" ]] || return 0
  while IFS= read -r rel; do
    [[ " $* " == *" $rel "* ]] \
      || refuse "в пакете файл $title/$rel: разрешены только $*"
  done < <(cd "$dir" && find . -mindepth 1 ! -type d | sed 's|^\./||' | sort)
}

platform_version() { # platform_version <файл>: значение версии платформы (пусто, если нет)
  [[ -f "$1" ]] || return 0
  sed -n "s/^$PLATFORM_VERSION_KEY=//p" "$1" | head -1
}
platform_sums() { # platform_sums <файл>: строки контрольных сумм копии платформы
  grep -E '^sha256 ' "$1" 2>/dev/null | sort || true
}

# Копия платформы пакета: версия целевая, сумма эталона compose.base.yml сходится со строкой.
check_platform_copy() {
  local ver want got
  ver="$(platform_version "$PKG_DEPLOY/$PLATFORM_VERSION_FILE")"
  [[ "$ver" == "$PLATFORM_TO" ]] \
    || refuse "PLATFORM-VERSION пакета '${ver:-?}', ожидается $PLATFORM_TO"
  want="$(awk -v n="$PLATFORM_BASE_NAME" '$1 == "sha256" && $3 == n { print $2 }' \
    "$PKG_DEPLOY/$PLATFORM_VERSION_FILE" | head -1)"
  got="$(sha256sum "$PKG_REFERENCE/platform/$PLATFORM_BASE_NAME" | cut -d' ' -f1)"
  [[ -n "$want" && "$got" == "$want" ]] \
    || refuse "сумма эталона $PLATFORM_BASE_NAME не сходится со строкой PLATFORM-VERSION пакета"
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

check_tree_present() {
  phase "боевое дерево"
  [[ -f "$LIVE_DEPLOY/compose.yml" && -f "$LIVE_DEPLOY/images.lock" \
    && -f "$LIVE_DEPLOY/$ENV_FILE_NAME" ]] \
    || refuse "в $LIVE_DEPLOY нет compose.yml, images.lock или .env: это не дерево v2"
  [[ -f "$LIVE_DEPLOY/$DEPLOYED_MARK" ]] \
    || refuse "в $LIVE_DEPLOY нет $DEPLOYED_MARK: дерево создано не cutover.sh"
  check "боевое дерево" ok "$LIVE_DEPLOY создано выкаткой пакета"
}

check_not_applied() {
  phase "патч G9w ещё не применён"
  local live_ver live_platform
  live_ver="$(live_lock_ref "$LOCK_KEY_VERSION")"
  live_platform="$(platform_version "$LIVE_DEPLOY/$PLATFORM_VERSION_FILE")"
  if cmp -s "$LIVE_DEPLOY/images.lock" "$LOCK_SRC" || [[ "$live_ver" == "$LOCK_VERSION_TO" ]] \
    || [[ "$live_platform" == "$PLATFORM_TO" ]]; then
    refuse "патч G9w уже применён (lock боя ${live_ver:-?}, платформа боя ${live_platform:-?}," \
      "версия пакета $LOCK_VERSION_TO): повторный запуск ничего не меняет"
  fi
  check "патч G9w ещё не применён" ok "lock боя ${live_ver:-?} отличается от пакета"
}

# require_container <сервис>: ровно один контейнер сервиса; имя в SERVICE_NAME.
require_container() {
  local svc="$1" names
  names="$(service_containers "$svc")"
  [[ -n "$names" ]] || refuse "в проекте $CUTOVER_PROJECT нет контейнера $svc: $G9Q4_HINT"
  [[ "$(wc -l <<<"$names")" -eq 1 ]] || refuse "у сервиса $svc несколько контейнеров"
  SERVICE_NAME[$svc]="$names"
}

# require_running <сервис>: контейнер запущен на образе из lock боя.
require_running() {
  local svc="$1" name ref got
  require_container "$svc"
  name="${SERVICE_NAME[$svc]}"
  [[ "$(container_status "$name")" == running ]] || refuse "контейнер $name не запущен"
  ref="$(live_lock_ref "${SERVICE_LOCK_KEY[$svc]}")"
  got="$(container_image_id "$name")"
  [[ -n "$ref" && -n "$got" && "$got" == "$(ref_image_id "$ref")" ]] \
    || refuse "запущенный $name не на образе из lock боя (${ref##*/}): $G9Q4_HINT"
}

# Бой на G9q4: lock и платформа боя, закреплённые digest app и documents, они же запущены.
check_g9q4_state() {
  phase "боевое состояние G9q4"
  local ver svc ref want
  ver="$(live_lock_ref "$LOCK_KEY_VERSION")"
  [[ "$ver" == "$LOCK_VERSION_FROM" ]] \
    || refuse "BAI_VERSION lock боя '${ver:-?}', ожидается $LOCK_VERSION_FROM: $G9Q4_HINT"
  ver="$(platform_version "$LIVE_DEPLOY/$PLATFORM_VERSION_FILE")"
  [[ "$ver" == "$PLATFORM_FROM" ]] \
    || refuse "платформа боя '${ver:-?}', ожидается $PLATFORM_FROM: $G9Q4_HINT"
  for svc in app documents; do
    want="$FROM_APP_DIGEST"
    [[ "$svc" == app ]] || want="$FROM_DOCS_DIGEST"
    ref="$(live_lock_ref "${SERVICE_LOCK_KEY[$svc]}")"
    [[ "${ref##*@}" == "$want" ]] \
      || refuse "в lock боя образ $svc не от G9q4 (нужен ${want:0:19}...): $G9Q4_HINT"
    require_running "$svc"
  done
  require_running pseudonymizer
  [[ "$(container_health "${SERVICE_NAME[pseudonymizer]}")" == healthy ]] \
    || refuse "${SERVICE_NAME[pseudonymizer]} не healthy: менять нездоровый стек нельзя"
  local volume
  volume="$(docker inspect -f \
    "{{range .Mounts}}{{if eq .Destination \"$PSEUDO_VOLUME_MOUNT\"}}{{.Name}}{{end}}{{end}}" \
    "${SERVICE_NAME[pseudonymizer]}" 2>/dev/null || true)"
  [[ "$volume" == "$CUTOVER_PSEUDO_VOLUME" ]] \
    || refuse "том ${PSEUDO_VOLUME_MOUNT} псевдонимизатора '${volume:-?}', ожидается" \
      "$CUTOVER_PSEUDO_VOLUME: бэкап снял бы не те данные"
  check_mask_state
  check "боевое состояние G9q4" ok "lock $LOCK_VERSION_FROM, платформа $PLATFORM_FROM, app и" \
    "documents на digest G9q4, pseudonymizer healthy, том $CUTOVER_PSEUDO_VOLUME"
}

# mask: запущен - пересоздаётся; нет контейнера или остановлен - не трогается; иное - отказ.
check_mask_state() {
  local names state
  names="$(service_containers mask)"
  MASK_RUNNING=0
  if [[ -z "$names" ]]; then
    check "сервис mask" warn "контейнера нет: патч его не запускает (новый образ будет взят" \
      "при следующем запуске)"
    return 0
  fi
  [[ "$(wc -l <<<"$names")" -eq 1 ]] || refuse "у сервиса mask несколько контейнеров"
  SERVICE_NAME[mask]="$names"
  state="$(container_status "$names")"
  case "$state" in
    running)
      require_running mask
      cut_wait_mask_ready "$names" "$(app_bun_image)" "$PREFLIGHT_WAIT_S" \
        || refuse "mask запущен, но /health не 200"
      MASK_RUNNING=1
      check "сервис mask" ok "запущен, /health 200: будет пересоздан" ;;
    exited | created)
      check "сервис mask" warn "остановлен ($state): патч его не запускает и не пересоздаёт" ;;
    *) refuse "mask в состоянии '$state': сначала разберитесь с сервисом" ;;
  esac
}

# Значения переменных прошлых патчей у запущенных app и documents и хэши переменных
# псевдонимизатора и mask у всех пересоздаваемых сервисов.
capture_environment() {
  phase "переменные до замены"
  local key missing="" name svc
  name="${SERVICE_NAME[app]}"
  : >"$WORK/app-values-before.tsv"
  for key in "${KEEP_APP_KEYS[@]}"; do
    if [[ -n "$(container_env_value "$name" "$key")" ]]; then
      printf '%s\t%s\n' "$key" "$(container_env_value "$name" "$key")" \
        >>"$WORK/app-values-before.tsv"
    else
      missing+=" $key"
    fi
  done
  [[ -z "$missing" ]] || refuse "в окружении $name нет:$missing: $G9Q4_HINT"
  cp "$WORK/app-values-before.tsv" "$RES/app-values-before.tsv"
  name="${SERVICE_NAME[documents]}"
  : >"$WORK/docs-values-before.tsv"
  for key in "${DOCS_KEYS[@]}"; do
    [[ -n "$(container_env_value "$name" "$key")" ]] || missing+=" $key"
  done
  [[ -z "$missing" ]] || refuse "в окружении $name нет:$missing: $G9Q4_HINT"
  for key in "${DOCS_KEYS[@]}" "${DOCS_OPTIONAL_KEYS[@]}"; do
    container_env_has "$name" "$key" || continue
    printf '%s\t%s\n' "$key" "$(container_env_value "$name" "$key")" \
      >>"$WORK/docs-values-before.tsv"
  done
  cp "$WORK/docs-values-before.tsv" "$RES/docs-values-before.tsv"
  for svc in "${APPLY_ORDER[@]}"; do
    [[ "$svc" != mask ]] || ((MASK_RUNNING)) || continue
    pii_env_digest "${SERVICE_NAME[$svc]}" >"$WORK/pii-env-$svc.before" \
      || refuse "не прочитано окружение ${SERVICE_NAME[$svc]}"
  done
  [[ -s "$WORK/pii-env-pseudonymizer.before" ]] \
    || refuse "у pseudonymizer не прочитаны переменные PSEUDONYMIZER_*"
  check "переменные до замены" ok "флаги прошлых патчей на месте; переменные псевдонимизатора и" \
    "mask запомнены (по хэшам)"
}

# lock боя отличается от пакетного только ключами патча; четыре образа обязаны смениться.
check_changes() {
  phase "состав изменений"
  local live_lock="$LIVE_DEPLOY/images.lock" key old new changed="" svc
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
    [[ " $PATCH_LOCK_KEYS " == *" $key "* ]] \
      || refuse "lock пакета меняет $key: патч вправе менять только: $PATCH_LOCK_KEYS"
  done
  for svc in "${APPLY_ORDER[@]}"; do
    [[ " $changed " == *" ${SERVICE_LOCK_KEY[$svc]} "* ]] \
      || refuse "lock пакета не меняет образ $svc (${SERVICE_LOCK_KEY[$svc]})"
  done
  printf '%s\n' $changed >"$RES/lock-changes.txt"
  check "состав изменений" ok "lock:$changed; файлы дерева кроме lock: ${PATCH_FILE_ALLOW[*]}"
}

# Боевые файлы compose равны эталону пакета, платформа 1.1.12 не меняет файлов копии.
check_reference() {
  phase "боевые файлы compose"
  local rel bad=""
  for rel in "${REFERENCE_FILES[@]}"; do
    cmp -s "$PKG_REFERENCE/$rel" "$LIVE_DEPLOY/$rel" || bad+=" $rel"
  done
  [[ -z "$bad" ]] \
    || refuse "боевые файлы отличаются от эталона пакета:$bad (патч их не заменяет)"
  [[ "$(platform_sums "$PKG_DEPLOY/$PLATFORM_VERSION_FILE")" \
    == "$(platform_sums "$LIVE_DEPLOY/$PLATFORM_VERSION_FILE")" ]] \
    || refuse "суммы файлов копии платформы $PLATFORM_TO отличаются от боевой $PLATFORM_FROM:" \
      "патч эти файлы не заменяет"
  check "боевые файлы compose" ok "${REFERENCE_FILES[*]} равны эталону; файлы копии платформы" \
    "$PLATFORM_FROM и $PLATFORM_TO одинаковы"
}

check_battle_health() {
  phase "бой здоров до начала"
  local body bots
  body="$(ready_probe "${SERVICE_NAME[app]}" || true)"
  [[ "$body" == 200* ]] || refuse "/ready боя не 200: ${body:0:120}"
  bots="$(ready_bots "$body")"
  ((bots >= CUTOVER_EXPECT_BOTS)) \
    || refuse "ботов $bots, ожидается не меньше $CUTOVER_EXPECT_BOTS (--expected-bots)"
  [[ "$(container_health "${SERVICE_NAME[documents]}")" == healthy ]] \
    || refuse "${SERVICE_NAME[documents]} не healthy"
  PAGES_BEFORE="$(probe_line "$PAGES_ROUTE_JS")"
  [[ "$PAGES_BEFORE" == "$PAGES_PROBE_WANT" ]] \
    || refuse "проба $PAGES_ROUTE_PATH до замены: '${PAGES_BEFORE:0:80}'," \
      "ожидается '$PAGES_PROBE_WANT'"
  PARSE_BEFORE="$(probe_line "$PARSE_ROUTE_JS")"
  [[ "$PARSE_BEFORE" == "200 "* ]] \
    || refuse "проба $PARSE_ROUTE_PATH до замены: '${PARSE_BEFORE:0:80}', ожидается статус 200"
  check "бой здоров" ok "/ready 200, ботов $bots; пробы documents: $PAGES_BEFORE;" \
    "$PARSE_BEFORE"
}

check_resources() {
  phase "ресурсы"
  local docker_root free avail need size_kib volume_mib backup_free tar_mib=0
  docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  free="$(dir_free_mib "$(existing_dir "$docker_root")")"
  avail="$(mem_available_mib)"
  need="$PATCH_MIN_DISK_MIB"
  if [[ -n "$IMAGES_TAR" ]]; then
    [[ -f "$IMAGES_TAR" ]] || refuse "нет архива образов $IMAGES_TAR"
    tar_mib=$(($(stat -c %s "$IMAGES_TAR") / MIB + 1))
    need=$((need + tar_mib * TAR_SPACE_FACTOR))
  fi
  ((free >= need)) \
    || refuse "мало места в $docker_root: свободно ${free} МиБ, нужно ${need}"
  ((avail >= PATCH_MIN_AVAILABLE_MIB)) \
    || refuse "мало памяти: доступно ${avail} МиБ, нужно ${PATCH_MIN_AVAILABLE_MIB}"
  size_kib="$(volume_run "$(live_lock_ref BAI_IMAGE_PSEUDONYMIZER)" \
    "du -sk $PSEUDO_VOLUME_MOUNT" -v "$CUTOVER_PSEUDO_VOLUME:$PSEUDO_VOLUME_MOUNT:ro" \
    2>>"$LOG_FILE" | awk 'NR == 1 { print $1 }')" || size_kib=""
  [[ "$size_kib" =~ ^[0-9]+$ ]] || refuse "не измерен том $CUTOVER_PSEUDO_VOLUME"
  volume_mib=$((size_kib / KIB_PER_MIB + 1))
  backup_free="$(dir_free_mib "$(existing_dir "$CUTOVER_BACKUP_ROOT")")"
  need=$((volume_mib * VOLUME_SPACE_FACTOR + PATCH_MIN_DISK_MIB / 4))
  ((backup_free >= need)) \
    || refuse "мало места под бэкап в $CUTOVER_BACKUP_ROOT: свободно ${backup_free} МиБ," \
      "нужно ${need} (том ${volume_mib} МиБ)"
  check "ресурсы" ok "диск ${free} МиБ, память ${avail} МиБ, том псевдонимизатора" \
    "${volume_mib} МиБ"
}

# Все четыре новых образа лежат на хосте по digest. Патч ничего не скачивает.
ensure_images() {
  phase "новые образы"
  local ref svc missing=""
  if [[ -n "$IMAGES_TAR" ]]; then
    log "загружаю образы из $IMAGES_TAR"
    docker load -i "$IMAGES_TAR" >>"$LOG_FILE" 2>&1 || refuse "docker load не удался"
  fi
  for svc in "${APPLY_ORDER[@]}"; do
    ref="$(lock_ref "${SERVICE_LOCK_KEY[$svc]}")"
    [[ "$ref" == *@sha256:* ]] || refuse "образ $svc '$ref' без digest"
    if docker image inspect "$ref" >/dev/null 2>&1; then
      check "образ $svc" ok "${ref##*/} на хосте"
    else
      check "образ $svc" fail "${ref##*/} на хосте нет"
      missing+=" $svc"
    fi
  done
  [[ -z "$missing" ]] \
    || refuse "нет образов на хосте:$missing. Перенесите их с Fornex:" \
      "bash transfer-images-9w.sh --host <root@хост> (из пакета), либо" \
      "transfer-images-9w.sh --images-tar ФАЙЛ и здесь --images-tar ФАЙЛ"
}

check_rollback_images() {
  phase "откатные образы"
  local ref svc
  for svc in "${APPLY_ORDER[@]}"; do
    [[ "$svc" != mask ]] || ((MASK_RUNNING)) || continue
    ref="$(live_lock_ref "${SERVICE_LOCK_KEY[$svc]}")"
    [[ -n "$ref" ]] || refuse "в lock боя нет ${SERVICE_LOCK_KEY[$svc]}"
    docker image inspect "$ref" >/dev/null 2>&1 \
      || refuse "прежнего образа $svc ${ref##*/} нет на хосте: откат был бы невозможен"
    check "откатный образ $svc" ok "${ref##*/} на хосте"
  done
}

compose_json() { # compose_json <корень дерева>: `compose config` одним JSON (не печатать)
  (
    CUTOVER_NEW_DIR="$1"
    dc_new --profile tools config --format json 2>/dev/null
  ) || true
}

# config_delta <JSON боя> <JSON примерки> <корень боя> <корень примерки> <ожидания...>:
# I:<сервис>=<ссылка> (образ сервиса в новой конфигурации) и B:<аргумент>=<значение> (аргумент
# сборки app). Прочих различий быть не должно. Печатает «ФЛАГ ...» и «РАЗЛИЧИЕ <путь>» (только
# названия ключей); код 2 - нет ожидаемой структуры.
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
    for item in sys.argv[5:]:
        scope, pair = item.split(":", 1)
        name, want = pair.split("=", 1)
        if scope == "I":
            old_service, new_service = live["services"][name], new["services"][name]
            if str(new_service.get("image")) != want:
                print("ФЛАГ образ-не-из-lock " + name)
            old_service.pop("image", None)
            new_service.pop("image", None)
        else:
            for tree, expected in ((live, None), (new, want)):
                args = (tree["services"]["app"].get("build") or {}).get("args")
                if isinstance(args, dict) and name in args:
                    if expected is not None and str(args[name]) != expected:
                        print("ФЛАГ основа-не-из-lock " + name)
                    args.pop(name)
except (ValueError, KeyError, TypeError, AttributeError, OSError):
    sys.exit(2)
for where in paths(live, new, ""):
    print("РАЗЛИЧИЕ " + where)
' "$@"
}

# Примерка: копия боевого deploy + файлы пакета и lock, секреты ссылками на боевые файлы.
stage_tree() {
  phase "примерка новых файлов (бой не меняется)"
  local stage="$WORK/stage" rel secret live_cfg new_cfg delta rc=0 line bad="" svc
  local deploy="$stage/deploy" expect=()
  mkdir -p "$deploy"
  (cd "$LIVE_DEPLOY" && tar -c --exclude='./.env' --exclude='./secrets.env' \
    --exclude="./$MASK_TOKEN_FILE_NAME" .) | tar -x -C "$deploy"
  for secret in "$ENV_FILE_NAME" secrets.env "$MASK_TOKEN_FILE_NAME"; do
    [[ ! -e "$LIVE_DEPLOY/$secret" ]] || ln -sfn "$LIVE_DEPLOY/$secret" "$deploy/$secret"
  done
  for rel in "${PATCH_FILE_ALLOW[@]}"; do
    cp "$PKG_DEPLOY/$rel" "$deploy/$rel"
  done
  cp "$LOCK_SRC" "$deploy/images.lock"
  for svc in "${APPLY_ORDER[@]}"; do
    expect+=("I:$svc=$(lock_ref "${SERVICE_LOCK_KEY[$svc]}")")
  done
  expect+=("B:$BUILD_ARG_APP_BASE=$(lock_ref "$LOCK_KEY_APP_BASE")")
  live_cfg="$(compose_json "$LIVE_NEW_DIR")"
  [[ -n "$live_cfg" ]] || refuse "docker compose config боевого дерева не собрался: снимка нет"
  new_cfg="$(compose_json "$stage")"
  [[ -n "$new_cfg" ]] || refuse "docker compose config не принял новые файлы и lock"
  delta="$(config_delta <(printf '%s' "$live_cfg") <(printf '%s' "$new_cfg") \
    "$LIVE_NEW_DIR" "$stage" "${expect[@]}")" || rc=$?
  ((rc == 0)) \
    || refuse "в конфигурации compose нет одного из сервисов ${APPLY_ORDER[*]}"
  while IFS= read -r line; do
    [[ -z "$line" ]] || bad+="; $line"
  done <<<"$delta"
  [[ -z "$bad" ]] || refuse "новая конфигурация compose не сходится со снимком боя (допустимо:" \
    "образы ${APPLY_ORDER[*]} из lock пакета и $BUILD_ARG_APP_BASE): ${bad#; }"
  check "конфигурация compose" ok "отличается от боевой только образами ${APPLY_ORDER[*]} и" \
    "$BUILD_ARG_APP_BASE"
}

# ---------------------------------------------------------------------------------------------
# 1. Бэкап
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
        "$(container_image_id "$name")" "$(container_started "$name")"
    done < <(project_containers)
  } >"$BACKUP_DIR/containers-before.tsv"
  cp "$WORK"/pii-env-*.before "$RUN_DIR/"
  state_set BACKUP_DIR "$BACKUP_DIR"
  state_set LIVE_DEPLOY "$LIVE_DEPLOY"
  state_set MASK_RUNNING "$MASK_RUNNING"
  local svc
  for svc in "${!SERVICE_NAME[@]}"; do state_set "NAME_$svc" "${SERVICE_NAME[$svc]}"; done
  # Ссылка latest указывает только на запуск, у которого есть бэкап.
  ln -sfn "$RUN_DIR" "$CUTOVER_HOME/$RUN_PREFIX-latest"
  check "бэкап файлов" ok "$BACKUP_DIR (deploy, список контейнеров и образов)"
}

# Том псевдонимизатора: сервис останавливается (согласованная копия, записи после неё не
# появляются), том архивируется и архив проверяется. Пока сервис стоит, app не отправляет текст
# в модель: сбой псевдонимизации - отказ хода.
backup_volume() {
  phase "бэкап тома псевдонимизатора"
  local image report
  image="$(live_lock_ref BAI_IMAGE_PSEUDONYMIZER)"
  state_set PATCH_STARTED 1
  state_set PSEUDO_STOPPED_AT "$(date -u +%FT%TZ)"
  log "stop pseudonymizer"
  dc_new stop -t "$STOP_TIMEOUT_S" pseudonymizer >>"$LOG_FILE" 2>&1 \
    || die "$EXIT_FAILED" "compose stop pseudonymizer не удался"
  [[ "$(container_status "${SERVICE_NAME[pseudonymizer]}")" != running ]] \
    || die "$EXIT_FAILED" "pseudonymizer не остановился"
  archive_volume "$image" "$BACKUP_DIR" "$VOLUME_ARCHIVE" >>"$LOG_FILE" 2>&1 \
    || die "$EXIT_FAILED" "не снят архив тома $CUTOVER_PSEUDO_VOLUME"
  tar -tzf "$BACKUP_DIR/$VOLUME_ARCHIVE" >/dev/null 2>>"$LOG_FILE" \
    || die "$EXIT_FAILED" "архив тома не читается"
  [[ "$(stat -c %a "$BACKUP_DIR/$VOLUME_ARCHIVE")" == 600 ]] \
    || die "$EXIT_FAILED" "права архива тома не 600"
  report="$(check_archive "$image" "$BACKUP_DIR" "$VOLUME_ARCHIVE" 2>>"$LOG_FILE" | tail -n 1)" \
    || report=""
  [[ "$report" == "integrity=ok rows="* ]] \
    || die "$EXIT_FAILED" "архив тома не прошёл проверку хранилища"
  (cd "$BACKUP_DIR" && sha256sum "$VOLUME_ARCHIVE" >"$VOLUME_ARCHIVE.sha256")
  state_set VOLUME_BACKUP_REPORT "$report"
  check "архив тома pseudonymizer-data" ok \
    "$(du -h "$BACKUP_DIR/$VOLUME_ARCHIVE" | cut -f1), права 600, $report"
}

# ---------------------------------------------------------------------------------------------
# 2. Замена
# ---------------------------------------------------------------------------------------------
apply_files() {
  phase "замена файлов дерева"
  local rel live tmp src
  for rel in images.lock "${PATCH_FILE_ALLOW[@]}"; do
    live="$LIVE_DEPLOY/$rel"
    tmp="$live.patch-new"
    src="$PKG_DEPLOY/$rel"
    [[ "$rel" != images.lock ]] || src="$LOCK_SRC"
    cp "$src" "$tmp"
    # Права и владелец остаются как у прежнего боевого файла.
    chmod --reference="$live" "$tmp"
    chown --reference="$live" "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$live"
    state_set FILE_REPLACED "$rel"
  done
  cmp -s "$LOCK_SRC" "$LIVE_DEPLOY/images.lock" \
    && cmp -s "$PKG_DEPLOY/$PLATFORM_VERSION_FILE" "$LIVE_DEPLOY/$PLATFORM_VERSION_FILE" \
    || die "$EXIT_FAILED" "после замены файлы боя не равны пакетным"
  check "замена файлов" ok "заменены images.lock и ${PATCH_FILE_ALLOW[*]}"
}

verify_image() { # verify_image <сервис>: образ запущенного контейнера равен образу lock пакета
  local svc="$1" name ref got want
  name="${SERVICE_NAME[$svc]}"
  ref="$(lock_ref "${SERVICE_LOCK_KEY[$svc]}")"
  got="$(container_image_id "$name")"
  want="$(ref_image_id "$ref")"
  printf '%s\t%s\t%s\n' "$name" "$ref" \
    "$([[ "$got" == "$want" ]] && echo совпал || echo ОТЛИЧАЕТСЯ)" >>"$RES/images-running.tsv"
  [[ -n "$got" && "$got" == "$want" ]] \
    || die "$EXIT_FAILED" "образ запущенного $name не равен lock (${ref##*/})"
  check "образ $svc = images.lock" ok "digest $name совпал с lock (${ref##*/})"
}

verify_pii_env() { # verify_pii_env <сервис>: переменные псевдонимизатора и mask прежние
  local svc="$1" diff_names
  pii_env_digest "${SERVICE_NAME[$svc]}" >"$WORK/pii-env-$svc.after" \
    || die "$EXIT_FAILED" "не прочитано окружение ${SERVICE_NAME[$svc]}"
  diff_names="$({ diff "$WORK/pii-env-$svc.before" "$WORK/pii-env-$svc.after" || true; } \
    | awk '/^[<>]/ { print $2 }' | sort -u | tr '\n' ' ')"
  [[ -z "$diff_names" ]] \
    || die "$EXIT_FAILED" "в окружении $svc изменились переменные: $diff_names"
  check "переменные ПДн $svc" ok \
    "$(wc -l <"$WORK/pii-env-$svc.after") переменных равны прежним (по хэшам)"
}

# recreate <сервис>: только он, без зависимостей и без удаления сирот; здоровье и образ.
recreate() {
  local svc="$1"
  phase "пересоздание $svc"
  log "up -d --no-deps $svc"
  dc_new up -d --no-deps "$svc" >>"$LOG_FILE" 2>&1 \
    || die "$EXIT_FAILED" "compose up $svc не удался"
  wait_service "$svc" "$HEALTH_WAIT_S" \
    || die "$EXIT_FAILED" "${SERVICE_NAME[$svc]} не стал здоровым за ${HEALTH_WAIT_S} с"
  STARTED_NEW[$svc]="$(container_started "${SERVICE_NAME[$svc]}")"
  check "сервис $svc" ok "пересоздан, ${SERVICE_NAME[$svc]} здоров"
  verify_image "$svc"
  verify_pii_env "$svc"
}

# labops-pii 1.3.0: версия в контейнере и синтетическая пара «фамилия имя». Наружу только факты.
verify_pii_probe() {
  local line
  line="$(docker exec -e "PROBE_THREAD=$PROBE_THREAD" "${SERVICE_NAME[pseudonymizer]}" \
    python -c "$PII_PROBE_PY" 2>>"$LOG_FILE" | tail -n 1)" || line=""
  [[ "$line" == "$PII_PROBE_OK" ]] \
    || die "$EXIT_FAILED" "проба labops-pii: '${line:0:80}', ожидается '$PII_PROBE_OK'"
  check "проба labops-pii" ok "$line (тред $PROBE_THREAD: пара «фамилия имя» замаскирована и" \
    "восстановлена; строка пробы остаётся в хранилище до срока ретенции)"
}

verify_documents() {
  phase "проверки documents"
  local key want line bad=""
  while IFS=$'\t' read -r key want; do
    [[ "$(container_env_value "${SERVICE_NAME[documents]}" "$key")" == "$want" ]] \
      && container_env_has "${SERVICE_NAME[documents]}" "$key" || bad+=" $key"
  done <"$WORK/docs-values-before.tsv"
  [[ -z "$bad" ]] || die "$EXIT_FAILED" "в окружении documents изменились флаги:$bad"
  check "окружение documents" ok "флаги G8x и правки PDF равны прежним"
  line="$(probe_line "$PAGES_ROUTE_JS")"
  [[ "$line" == "$PAGES_PROBE_WANT" ]] \
    || die "$EXIT_FAILED" "проба $PAGES_ROUTE_PATH: '${line:0:80}'," \
      "ожидается '$PAGES_PROBE_WANT'"
  check "проба $PAGES_ROUTE_PATH" ok "documents ответил $line"
  line="$(probe_line "$PARSE_ROUTE_JS")"
  [[ "$line" == "$PARSE_BEFORE" ]] \
    || die "$EXIT_FAILED" "проба $PARSE_ROUTE_PATH: '${line:0:80}', до замены" \
      "'$PARSE_BEFORE'"
  check "проба $PARSE_ROUTE_PATH" ok "documents ответил $line (как до замены)"
}

verify_ready() {
  local body bots="0" started=$SECONDS
  ready_wait "${SERVICE_NAME[app]}" "$READY_WAIT_S" \
    || die "$EXIT_FAILED" "/ready не 200 за ${READY_WAIT_S} с: ${READY_BODY:0:160}"
  while :; do
    body="$(ready_probe "${SERVICE_NAME[app]}" || true)"
    bots="$(ready_bots "$body")"
    ((bots < CUTOVER_EXPECT_BOTS && SECONDS - started < READY_WAIT_S)) || break
    sleep "$POLL_S"
  done
  ((bots >= CUTOVER_EXPECT_BOTS)) \
    || die "$EXIT_FAILED" "ботов $bots, ожидается не меньше $CUTOVER_EXPECT_BOTS"
  check "/ready и боты" ok "200, ботов $bots"
}

verify_app_env() {
  local key want got missing="" bad=""
  while IFS=$'\t' read -r key want; do
    got="$(container_env_value "${SERVICE_NAME[app]}" "$key")"
    if [[ -z "$got" ]]; then missing+=" $key"; elif [[ "$got" != "$want" ]]; then bad+=" $key"; fi
  done <"$WORK/app-values-before.tsv"
  [[ -z "$missing" ]] || die "$EXIT_FAILED" "в окружении app пропали переменные:$missing"
  [[ -z "$bad" ]] || die "$EXIT_FAILED" "в окружении app изменились значения переменных:$bad"
  check "окружение app" ok "переменные прошлых патчей на месте и прежние"
}

# Пересозданные сервисы не перезапускались, пока пересоздавались следующие.
verify_stable() {
  local svc started
  for svc in "${APPLY_ORDER[@]}"; do
    [[ -n "${STARTED_NEW[$svc]:-}" ]] || continue
    started="$(container_started "${SERVICE_NAME[$svc]}")"
    [[ "$started" == "${STARTED_NEW[$svc]}" ]] \
      || die "$EXIT_FAILED" "${SERVICE_NAME[$svc]} перезапускался после пересоздания"
  done
  check "стабильность сервисов" ok "после пересоздания не перезапускались"
}

report_other_containers() {
  local name want started changed="" svc skip
  while IFS=$'\t' read -r name _ _ want; do
    [[ "$name" == \#* || -z "$name" ]] && continue
    skip=0
    for svc in "${!STARTED_NEW[@]}"; do [[ "$name" != "${SERVICE_NAME[$svc]}" ]] || skip=1; done
    ((skip == 0)) || continue
    started="$(container_started "$name")"
    [[ "$started" == "$want" ]] || changed+=" $name"
  done <"$BACKUP_DIR/containers-before.tsv"
  if [[ -z "$changed" ]]; then
    check "прочие контейнеры" ok "не перезапускались"
  else
    check "прочие контейнеры" warn "изменился StartedAt:$changed (патч их не трогал)"
  fi
}

# Маршруты стека; не запущенный mask пропускается явно.
verify_routes() {
  local out="$RES/routes-stack.txt" rc=0 summary svc list=""
  if ((MASK_RUNNING == 0)); then
    for svc in "${ROUTES_STACK_SERVICES[@]}"; do
      [[ "$svc" == mask ]] && continue
      [[ -z "${CUTOVER_SERVICES:-}" || " $CUTOVER_SERVICES " == *" $svc "* ]] && list+=" $svc"
    done
    CUTOVER_SERVICES="${list# } $APP_SERVICE" cut_check_routes_stack "$out" || rc=$?
  else
    cut_check_routes_stack "$out" || rc=$?
  fi
  cat "$out" >>"$LOG_FILE"
  summary="$(tail -1 "$out" | cut -c1-200)"
  ((rc == 0)) || die "$EXIT_FAILED" "проверка маршрутов стека не прошла (routes-stack.txt)"
  check "маршруты стека" ok "$summary"
}

soak() {
  local svc name started=$SECONDS left body
  local -A started_before=() restarts_before=()
  for svc in "${!STARTED_NEW[@]}"; do
    name="${SERVICE_NAME[$svc]}"
    started_before[$svc]="$(container_started "$name")"
    restarts_before[$svc]="$(container_restarts "$name")"
  done
  log "выдержка ${SOAK_S} с (проверка каждые ${SOAK_POLL_S} с)"
  # Хотя бы одна проверка выполняется всегда.
  while :; do
    left=$((SOAK_S - (SECONDS - started)))
    ((left > 0)) || left=0
    sleep "$((SOAK_POLL_S < left ? SOAK_POLL_S : left))"
    for svc in "${!STARTED_NEW[@]}"; do
      name="${SERVICE_NAME[$svc]}"
      [[ "$(container_started "$name")" == "${started_before[$svc]}" \
        && "$(container_restarts "$name")" == "${restarts_before[$svc]}" ]] \
        || die "$EXIT_FAILED" "во время выдержки $name перезапускался"
    done
    body="$(ready_probe "${SERVICE_NAME[app]}" || true)"
    [[ "$body" == 200* ]] || die "$EXIT_FAILED" "во время выдержки /ready не 200: ${body:0:120}"
    body="$(docs_probe "$DOCS_HEALTH_JS" || true)"
    [[ "$body" == 200* ]] \
      || die "$EXIT_FAILED" "во время выдержки /health documents не 200: ${body:0:120}"
    body="$(container_health "${SERVICE_NAME[pseudonymizer]}")"
    [[ "$body" == healthy ]] \
      || die "$EXIT_FAILED" "во время выдержки pseudonymizer не healthy: $body"
    ((MASK_RUNNING == 0)) \
      || cut_wait_mask_ready "${SERVICE_NAME[mask]}" "$(app_bun_image)" "$POLL_S" \
      || die "$EXIT_FAILED" "во время выдержки /health mask не 200"
    ((SECONDS - started < SOAK_S)) || break
  done
  check "выдержка ${SOAK_S} с" ok "пересозданные сервисы не перезапускались и отвечают"
}

apply_services() {
  : >"$RES/images-running.tsv"
  recreate pseudonymizer
  verify_pii_probe
  if ((MASK_RUNNING)); then
    recreate mask
  else
    check "сервис mask" warn "не запускался и не пересоздавался; в lock новый образ"
  fi
  recreate documents
  verify_documents
  recreate app
  phase "проверки после замены"
  verify_ready
  verify_app_env
  verify_stable
  report_other_containers
  verify_routes
  verify_documents
  soak
}

# ---------------------------------------------------------------------------------------------
# Откат
# ---------------------------------------------------------------------------------------------
ROLLBACK_FAILED=0
rb_check() { # rb_check <имя> <ok|fail> <описание>
  check "откат: $1" "$2" "$3"
  [[ "$2" != fail ]] || ROLLBACK_FAILED=$((ROLLBACK_FAILED + 1))
}

# run_state <каталог запуска> <ключ>: значение из state.env запуска патча.
run_state() {
  local saved="$STATE_FILE" value
  STATE_FILE="$1/state.env"
  value="$(state_get "$2")"
  STATE_FILE="$saved"
  printf '%s' "$value"
}

# load_run <каталог запуска>: бэкап, боевое дерево, имена контейнеров и состояние mask.
load_run() {
  local run="$1" svc name
  BACKUP_DIR="$(run_state "$run" BACKUP_DIR)"
  LIVE_DEPLOY="$(run_state "$run" LIVE_DEPLOY)"
  MASK_RUNNING="$(run_state "$run" MASK_RUNNING)"
  MASK_RUNNING="${MASK_RUNNING:-0}"
  for svc in "${APPLY_ORDER[@]}"; do
    name="$(run_state "$run" "NAME_$svc")"
    [[ -z "$name" ]] || SERVICE_NAME[$svc]="$name"
  done
  [[ -n "$BACKUP_DIR" && -d "$BACKUP_DIR/deploy" && -n "$LIVE_DEPLOY" ]]
}

# rollback_patch <каталог запуска>: images.lock и PLATFORM-VERSION из бэкапа, up -d --no-deps в
# обратном порядке, проверки. Том псевдонимизатора не восстанавливается. 0 - бой как до патча.
rollback_patch() {
  local run="$1" rel svc body bots name want got bad=0
  phase "откат патча"
  if ! load_run "$run"; then
    log "нет бэкапа в $run/state.env: откат невозможен"
    return 1
  fi
  CUTOVER_NEW_DIR="$(dirname "$LIVE_DEPLOY")"
  for rel in images.lock "${PATCH_FILE_ALLOW[@]}"; do
    if ! cmp -s "$BACKUP_DIR/deploy/$rel" "$LIVE_DEPLOY/$rel"; then
      cp -a "$BACKUP_DIR/deploy/$rel" "$LIVE_DEPLOY/$rel.rb-new" \
        && mv -f "$LIVE_DEPLOY/$rel.rb-new" "$LIVE_DEPLOY/$rel"
    fi
    cmp -s "$BACKUP_DIR/deploy/$rel" "$LIVE_DEPLOY/$rel" || bad=$((bad + 1))
  done
  if ((bad)); then
    rb_check "файлы дерева" fail "файлов не совпало с бэкапом: $bad"
    return 1
  fi
  rb_check "файлы дерева" ok "images.lock и ${PATCH_FILE_ALLOW[*]} равны бэкапу"
  for svc in "${ROLLBACK_ORDER[@]}"; do
    if [[ "$svc" == mask ]] && ((MASK_RUNNING == 0)); then continue; fi
    if dc_new up -d --no-deps "$svc" >>"$LOG_FILE" 2>&1; then
      rb_check "поднят $svc" ok "up -d --no-deps $svc"
    else
      rb_check "поднят $svc" fail "compose up не удался"
      continue
    fi
  done
  # Здоровье проверяется после всех up: app и documents зависят друг от друга по сети.
  for svc in "${APPLY_ORDER[@]}"; do
    if [[ "$svc" == mask ]] && ((MASK_RUNNING == 0)); then continue; fi
    if wait_service "$svc" "$HEALTH_WAIT_S"; then
      rb_check "$svc работает" ok "${SERVICE_NAME[$svc]}"
    else
      rb_check "$svc работает" fail "${SERVICE_NAME[$svc]} нездоров за ${HEALTH_WAIT_S} с"
    fi
  done
  if ready_wait "${SERVICE_NAME[app]}" "$READY_WAIT_S"; then
    body="$(ready_probe "${SERVICE_NAME[app]}" || true)"
    bots="$(ready_bots "$body")"
    if ((bots >= CUTOVER_EXPECT_BOTS)); then
      rb_check "/ready" ok "200, ботов $bots"
    else
      rb_check "/ready" fail "ботов $bots, ожидается не меньше $CUTOVER_EXPECT_BOTS"
    fi
  else
    rb_check "/ready" fail "не 200 за ${READY_WAIT_S} с: ${READY_BODY:0:120}"
  fi
  while IFS=$'\t' read -r name want _ _; do
    [[ "$name" == \#* || -z "$name" ]] && continue
    got="$(docker inspect -f '{{.Config.Image}}' "$name" 2>/dev/null || echo отсутствует)"
    if [[ "$got" == "$want" ]]; then
      rb_check "образ $name" ok "как до патча"
    else
      rb_check "образ $name" fail "сейчас $got, до патча $want"
    fi
  done <"$BACKUP_DIR/containers-before.tsv"
  ((ROLLBACK_FAILED == 0)) || return 1
  log "ОТКАТ ПАТЧА ВЫПОЛНЕН: файлы дерева из бэкапа, сервисы на образах G9q4, проверки прошли." \
    "Том псевдонимизатора не менялся."
  state_set ROLLBACK_RESULT OK
}

# Ручные режимы: каталог запуска относится к этому патчу и бою на версии из пары патча.
check_manual_target() {
  phase "проверка каталога запуска"
  local live_ver backup_ver
  load_run "$RUN_DIR_ORIG" || refuse "в $RUN_DIR_ORIG нет бэкапа патча G9w"
  CUTOVER_NEW_DIR="$(dirname "$LIVE_DEPLOY")"
  live_ver="$(live_lock_ref "$LOCK_KEY_VERSION")"
  [[ "$live_ver" == "$LOCK_VERSION_TO" || "$live_ver" == "$LOCK_VERSION_FROM" ]] \
    || refuse "lock боя '${live_ver:-?}' не от этого патча (после G9w ставили что-то ещё?)"
  backup_ver="$(lock_value "$BACKUP_DIR/deploy/images.lock" "$LOCK_KEY_VERSION" || true)"
  [[ "$backup_ver" == "$LOCK_VERSION_FROM" ]] \
    || refuse "lock бэкапа '${backup_ver:-?}', ожидается $LOCK_VERSION_FROM"
  check "каталог запуска" ok "бэкап $BACKUP_DIR, lock боя $live_ver"
}

# Проверки бэкапа тома: выполняются ДО любых изменений (и до отката в совместном режиме).
VOLUME_BACKUP_SEEN=""
check_volume_backup() {
  phase "проверка бэкапа тома"
  local image
  [[ -n "${SERVICE_NAME[pseudonymizer]:-}" ]] \
    || refuse "в состоянии запуска нет имени контейнера pseudonymizer"
  [[ -f "$BACKUP_DIR/$VOLUME_ARCHIVE" && -f "$BACKUP_DIR/$VOLUME_ARCHIVE.sha256" ]] \
    || refuse "нет архива тома или его суммы в $BACKUP_DIR"
  (cd "$BACKUP_DIR" && sha256sum -c --quiet "$VOLUME_ARCHIVE.sha256") >>"$LOG_FILE" 2>&1 \
    || refuse "сумма архива тома не сходится"
  image="$(live_lock_ref BAI_IMAGE_PSEUDONYMIZER)"
  docker image inspect "$image" >/dev/null 2>&1 || refuse "нет образа pseudonymizer из lock боя"
  VOLUME_BACKUP_SEEN="$(check_archive "$image" "$BACKUP_DIR" "$VOLUME_ARCHIVE" \
    2>>"$LOG_FILE" | tail -n 1)" || VOLUME_BACKUP_SEEN=""
  [[ "$VOLUME_BACKUP_SEEN" == "integrity=ok rows="* ]] \
    || refuse "архив тома не прошёл проверку хранилища"
  check "бэкап тома" ok "$BACKUP_DIR/$VOLUME_ARCHIVE: $VOLUME_BACKUP_SEEN"
}

# Восстановление тома из бэкапа патча. Перед очисткой тома снимается и проверяется копия
# текущего содержимого; записи, сделанные после бэкапа, из тома пропадают.
restore_volume() {
  phase "восстановление тома псевдонимизатора из бэкапа"
  local image safety="pseudonymizer-data-before-restore-$RUN_ID.tgz" now name
  local report="$VOLUME_BACKUP_SEEN"
  name="${SERVICE_NAME[pseudonymizer]}"
  image="$(live_lock_ref BAI_IMAGE_PSEUDONYMIZER)"
  docker image inspect "$image" >/dev/null 2>&1 \
    || die "$EXIT_STUCK" "нет образа pseudonymizer из lock боя"
  state_set MANUAL_STARTED 1
  log "stop pseudonymizer"
  dc_new stop -t "$STOP_TIMEOUT_S" pseudonymizer >>"$LOG_FILE" 2>&1 \
    || die "$EXIT_STUCK" "compose stop pseudonymizer не удался"
  [[ "$(container_status "$name")" != running ]] \
    || die "$EXIT_STUCK" "pseudonymizer не остановился"
  if ! archive_volume "$image" "$BACKUP_DIR" "$safety" >>"$LOG_FILE" 2>&1; then
    dc_new up -d --no-deps pseudonymizer >>"$LOG_FILE" 2>&1 || true
    die "$EXIT_STUCK" "не снята копия текущего тома: том не менялся, pseudonymizer запускается"
  fi
  now="$(check_archive "$image" "$BACKUP_DIR" "$safety" 2>>"$LOG_FILE" | tail -n 1)" || now=""
  check "копия тома до восстановления" ok "$BACKUP_DIR/$safety (${now:-проверка не прошла})"
  check "записи тома" warn "сейчас: ${now:-?}; в бэкапе: $report. Записи после бэкапа" \
    "из тома пропадут (копия сохранена)"
  volume_run "$image" "find $PSEUDO_VOLUME_MOUNT -mindepth 1 -delete \
&& tar -xzpf /bk/$VOLUME_ARCHIVE -C $PSEUDO_VOLUME_MOUNT" \
    -v "$CUTOVER_PSEUDO_VOLUME:$PSEUDO_VOLUME_MOUNT" -v "$BACKUP_DIR:/bk:ro" \
    >>"$LOG_FILE" 2>&1 \
    || die "$EXIT_STUCK" "том не восстановлен: pseudonymizer остановлен, копии в $BACKUP_DIR"
  dc_new up -d --no-deps pseudonymizer >>"$LOG_FILE" 2>&1 \
    || die "$EXIT_STUCK" "compose up pseudonymizer не удался"
  wait_healthy "$name" "$HEALTH_WAIT_S" \
    || die "$EXIT_STUCK" "$name не стал healthy за ${HEALTH_WAIT_S} с"
  check "том восстановлен" ok "из $BACKUP_DIR/$VOLUME_ARCHIVE ($report), $name healthy"
}

# ---------------------------------------------------------------------------------------------
main() {
  if ((MANUAL_MODE)); then
    collect_secret_values
    check_manual_target
    ((RESTORE_VOLUME_MODE == 0)) || check_volume_backup
    if ((ROLLBACK_MODE)); then
      log "patch.sh --rollback: откат по каталогу запуска $RUN_DIR_ORIG"
      state_set MANUAL_STARTED 1
      rollback_patch "$RUN_DIR_ORIG" || exit "$EXIT_STUCK"
    fi
    ((RESTORE_VOLUME_MODE == 0)) || restore_volume
    state_set RESULT OK
    return 0
  fi
  save_config
  log "patch.sh $RUN_ID: проект $CUTOVER_PROJECT, дерево $LIVE_NEW_DIR, каталог запуска $RUN_DIR"
  collect_secret_values
  check_sources
  check_signatures
  check_tree_present
  check_not_applied
  check_g9q4_state
  capture_environment
  check_changes
  check_reference
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
  backup_volume
  apply_files
  apply_services
  state_set RESULT OK
}
main
