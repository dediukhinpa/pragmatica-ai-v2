#!/usr/bin/env bash
# Сборка патч-пакета G9s (платформа остаётся 1.1.10; меняется ОДИН образ проекта: app
# pragmatika-app 1.1.10-pragmatika.2 с хранением файлов, присланных ботам в чат, и файл
# compose.project.yml с тремя новыми переменными app; образ documents и платформа НЕ меняются):
# каталог, который переносят на боевой хост и запускают там `bash patch.sh` (см. OWNER-RUNBOOK.md).
# Ставится строго после патча G9r. Красная зона: запускает владелец.
#
# Использование:
#   bash tools/build-patch-9s-package.sh --out КАТАЛОГ --lock ФАЙЛ [--signatures ФАЙЛ]
#        [--prev-lock ФАЙЛ] [--cosign-pub ФАЙЛ] [--runbook ФАЙЛ] [--tgz ФАЙЛ] [--help]
#
# Состав (копии закоммиченного дерева, git show HEAD; незакоммиченное не попадает):
#   patch.sh, lib.sh, verify-signatures.sh   сценарий патча G9s и общие функции (deploy/patch-9s,
#                                            deploy/cutover)
#   enable-flags.sh                          необязательный шаг runbook: настройки хранения
#                                            (CHAT_ATTACHMENTS_STORE_ENABLED,
#                                            CHAT_ATTACHMENTS_RETENTION_DAYS,
#                                            CHAT_ATTACHMENTS_MAX_BYTES; по умолчанию хранение
#                                            включено; патч .env не меняет)
#   tools/check-routes.sh, route-flags.tsv, routes.tsv   проверка маршрутов стека (маршруты
#                                            берутся из готового routes.tsv, исходники проекта
#                                            и route-manifest.ts на хосте не нужны; в routes.tsv
#                                            обязан быть маршрут documents POST /docx/pages)
#   tools/chat-attachments-cli.sh            тонкая обёртка владельца для архива файлов чата
#                                            (если файла нет в HEAD, сборка его пропускает и
#                                            пишет об этом в вывод)
#   deploy/compose.project.yml               единственный файл дерева, который патч заменяет
#                                            (из HEAD; кроме него других файлов deploy/ нет:
#                                            платформа 1.1.10 на боевом хосте остаётся прежней)
#   images.lock, cosign.pub                  образы по digest и открытый ключ
#   signatures.txt                           подтверждение подписей (если дан --signatures; без
#                                            него на хосте нужен cosign)
#   OWNER-RUNBOOK.md                         инструкция владельцу (если дан --runbook)
#   MANIFEST.sha256                          контрольные суммы всех файлов пакета
# Образы в пакет не входят: их владелец получает отдельно (docker pull по digest из lock либо
# `bash patch.sh --images-tar ФАЙЛ`). Секретов, .env и ключей в пакет не кладётся: проверяется
# перед записью манифеста. Миграций (db) в патче нет. Проверки сборки: lock содержит
# BAI_IMAGE_APP, BAI_IMAGE_DOCUMENTS (и mask) по digest и BAI_VERSION=1.1.10-pragmatika.2; с
# --prev-lock (lock боя после G9r, этап 9r; его BAI_VERSION обязан быть 1.1.10-pragmatika.1) lock
# отличается от него ТОЛЬКО ключами BAI_VERSION и BAI_IMAGE_APP, образ app сменился, а образ
# documents ОБЯЗАН остаться прежним; подтверждение подписей (если дано) относится к ЭТОМУ lock
# (sha256), этому ключу и покрывает все его образы. В HEAD deploy/compose.project.yml обязан
# содержать три новые переменные app с умолчаниями (CHAT_ATTACHMENTS_STORE_ENABLED:
# ${CHAT_ATTACHMENTS_STORE_ENABLED:-true}, CHAT_ATTACHMENTS_RETENTION_DAYS: ...:-30 и
# CHAT_ATTACHMENTS_MAX_BYTES: ...:-3221225472; false в .env - выключатель; список NEW_APP_VARS в
# скрипте) и сохранять прежние переменные app с умолчанием true. Только проверки (в пакет не
# попадают): оба файла compose в HEAD (compose.project.yml и platform/compose.base.yml) содержат
# обе переменные поиска G8w (YANDEX_SEARCH_MAX_CONCURRENCY, YANDEX_SEARCH_MIN_INTERVAL_MS) и
# четыре флага documents от G8x (DOCUMENTS_EDIT_PPTX, DOCUMENTS_EDIT_PDF, DOCUMENTS_PPT_CONVERT,
# DOCUMENTS_EDIT_PDF_FALLBACK_FONT); compose.project.yml в HEAD - переменные G8z
# (SHORTLIST_PAGING_ENABLED, SUPPLIER_DISCOVERY_ENABLED), G9p (PRICE_EDIT_FIRST_ENABLED,
# DOCX_PAGES_ENABLED), G9q (PRICE_EDIT_DB_WRITE_ENABLED, PRICE_EDIT_TEXT_BLOCKS_ENABLED), G9q2
# (EMPTY_REPLY_GUARD_ENABLED) и G9q3 (PRICE_FILE_ONCE_PER_TURN_ENABLED,
# STEP_TEXT_SEPARATE_ENABLED) с умолчанием true; routes.tsv в HEAD - маршрут /docx/pages; копия
# платформы в HEAD (G9r): PLATFORM-VERSION - версия 1.1.10, сумма compose.base.yml равна строке
# PLATFORM-VERSION, в нём есть DOCUMENTS_EDIT_PDF_TEXT и B24_CALL_RECORDING_* (файлы платформы
# патч не заменяет и в пакет не кладёт). С --tgz пакет упаковывается в архив (режим 600, корень
# patch-package/; обычно stage-9s/patch-package.tgz).
#
# Коды выхода: 0 - готово; 1 - ошибка сборки; 2 - неверный вызов.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BAI_PROJECT_DIR:-$(cd "$HERE/.." && pwd)}"
EXIT_FAILED=1
EXIT_USAGE=2
SCRIPTS_PATCH=(patch.sh enable-flags.sh)
SCRIPTS_CUTOVER=(lib.sh verify-signatures.sh)
ROUTE_TOOLS=(check-routes.sh route-flags.tsv)
# Файлы дерева, которые патч вправе заменить (кроме images.lock в корне пакета).
# ДОЛЖНО совпадать с PATCH_FILE_ALLOW в patch.sh.
DEPLOY_FILES=(compose.project.yml)
# Новые переменные app ИМЯ=умолчание: обязаны быть в compose.project.yml из HEAD со строкой
# `ИМЯ: ${ИМЯ:-умолчание}` (хранение включено по умолчанию, false в .env - выключатель; срок 30
# суток, предел 3 ГиБ). При смене имени или умолчания править только этот список.
NEW_APP_VARS=(CHAT_ATTACHMENTS_STORE_ENABLED=true CHAT_ATTACHMENTS_RETENTION_DAYS=30
  CHAT_ATTACHMENTS_MAX_BYTES=3221225472)
# Переменные G8z, G9p, G9q, G9q2 и G9q3 (уже на бою) обязаны остаться в этом же файле с умолчанием
# true: пакет заменяет файл целиком.
OLD_APP_VARS=(SHORTLIST_PAGING_ENABLED SUPPLIER_DISCOVERY_ENABLED PRICE_EDIT_FIRST_ENABLED
  DOCX_PAGES_ENABLED PRICE_EDIT_DB_WRITE_ENABLED PRICE_EDIT_TEXT_BLOCKS_ENABLED
  EMPTY_REPLY_GUARD_ENABLED PRICE_FILE_ONCE_PER_TURN_ENABLED STEP_TEXT_SEPARATE_ENABLED)
OLD_APP_DEFAULT="true"
NEW_APP_FILE="compose.project.yml"
# Необязательный файл пакета: обёртка владельца для архива файлов чата. Нет в HEAD - пропускается.
OPTIONAL_TOOLS=(chat-attachments-cli.sh)
# Маршрут documents от G9p (documents у G9s не меняется, маршрут тот же): обязан быть в routes.tsv
# из HEAD.
PAGES_ROUTE_ROW=$'documents\tPOST\t/docx/pages\troute'
# Ключи lock, которыми новый lock вправе отличаться от lock боя после G9r (--prev-lock): версия и
# образ app (он обязан смениться). Образ documents меняться НЕ вправе (его нет в списке).
ALLOWED_LOCK_DIFF="BAI_VERSION BAI_IMAGE_APP"
REQUIRED_LOCK_DIFF="BAI_IMAGE_APP"
# Переменные, которые обязаны быть в файлах compose из HEAD (только проверка, в пакет файлы не
# попадают): поиск Яндекса (app, от G8w) и флаги documents (от G8x).
REQUIRED_VARS=(YANDEX_SEARCH_MAX_CONCURRENCY YANDEX_SEARCH_MIN_INTERVAL_MS
  DOCUMENTS_EDIT_PPTX DOCUMENTS_EDIT_PDF DOCUMENTS_PPT_CONVERT DOCUMENTS_EDIT_PDF_FALLBACK_FONT)
REQUIRED_VARS_FILES=(compose.project.yml platform/compose.base.yml)
# Версия платформы в HEAD (патч её не меняет; копия платформы в HEAD - результат G9r), версия lock
# боя после G9r (обязана быть у --prev-lock) и версия lock, которую ставит патч. Переменные
# платформы 1.1.10 обязаны быть в compose.base.yml (только проверка).
PLATFORM_VERSION_FILE="platform/PLATFORM-VERSION"
PLATFORM_BASE_FILE="platform/compose.base.yml"
PLATFORM_VERSION="1.1.10"
PLATFORM_NEW_VARS=(DOCUMENTS_EDIT_PDF_TEXT B24_CALL_RECORDING_MAX_BYTES
  B24_CALL_RECORDING_TIMEOUT_MS)
PREV_LOCK_VERSION="1.1.10-pragmatika.1"
TARGET_LOCK_VERSION="1.1.10-pragmatika.2"
FORBIDDEN_RE='(^|/)(\.env|\.env\..*|secrets\.env|.*\.key|.*\.pem|.*\.bak.*)$'
ALLOWED_RE='(^|/)\.env\.example$'
OUT=""
LOCK=""
SIGNATURES=""
PREV_LOCK=""
COSIGN_PUB="${BAI_SIGNING_PUBKEY:-$HOME/.config/bai-signing/cosign.pub}"
RUNBOOK=""
TGZ=""

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
log() { echo "[build-patch-9s-package] $(date -u +%T) $*"; }
fail() { echo "[build-patch-9s-package] ОШИБКА: $*" >&2; exit "$EXIT_FAILED"; }

while (($#)); do
  case "$1" in
    --out) OUT="${2:?--out КАТАЛОГ}"; shift ;;
    --lock) LOCK="${2:?--lock ФАЙЛ}"; shift ;;
    --signatures) SIGNATURES="${2:?--signatures ФАЙЛ}"; shift ;;
    --prev-lock) PREV_LOCK="${2:?--prev-lock ФАЙЛ}"; shift ;;
    --cosign-pub) COSIGN_PUB="${2:?}"; shift ;;
    --runbook) RUNBOOK="${2:?}"; shift ;;
    --tgz) TGZ="${2:?}"; shift ;;
    --help | -h) usage; exit 0 ;;
    *) echo "неизвестный аргумент: $1" >&2; usage >&2; exit "$EXIT_USAGE" ;;
  esac
  shift
done
[[ -n "$OUT" && -n "$LOCK" ]] || { usage >&2; exit "$EXIT_USAGE"; }
for f in "$LOCK" "$COSIGN_PUB" ${SIGNATURES:+"$SIGNATURES"} ${PREV_LOCK:+"$PREV_LOCK"}; do
  [[ -f "$f" ]] || { echo "нет файла $f" >&2; exit "$EXIT_USAGE"; }
done
[[ -z "$RUNBOOK" || -f "$RUNBOOK" ]] || { echo "нет файла $RUNBOOK" >&2; exit "$EXIT_USAGE"; }
if [[ -e "$OUT" ]] && [[ -n "$(ls -A "$OUT" 2>/dev/null)" ]]; then
  echo "каталог $OUT не пуст" >&2
  exit "$EXIT_USAGE"
fi

# Подтверждение подписей относится к этому lock, этому ключу и покрывает все образы lock.
if [[ -n "$SIGNATURES" ]]; then
  python3 -I - "$SIGNATURES" "$LOCK" "$COSIGN_PUB" <<'PY' \
    || fail "подтверждение подписей не подходит к lock"
import hashlib, re, sys
sig, lock, pub = sys.argv[1:4]
fields, images = {}, {}
for raw in open(sig, encoding="utf-8"):
    line = raw.rstrip("\n")
    if line.startswith("image\t"):
        parts = line.split("\t")
        images[parts[1]] = (parts[2], parts[3])
    elif "=" in line and not line.startswith("#"):
        key, value = line.split("=", 1)
        fields[key] = value
want = dict(
    line.split("=", 1) for line in open(lock, encoding="utf-8").read().splitlines()
    if re.match(r"^BAI_IMAGE_[A-Z0-9_]+=", line)
)
ok = (
    fields.get("result") == "OK"
    and fields.get("lock_sha256") == hashlib.sha256(open(lock, "rb").read()).hexdigest()
    and fields.get("pubkey_sha256") == hashlib.sha256(open(pub, "rb").read()).hexdigest()
    and set(images) == set(want)
    and all(images[k] == (v, "OK") for k, v in want.items())
)
sys.exit(0 if ok else 1)
PY
else
  log "ВНИМАНИЕ: --signatures не дан: signatures.txt в пакет не попадёт, на хосте нужен cosign"
fi
for key in BAI_IMAGE_MASK BAI_IMAGE_APP BAI_IMAGE_DOCUMENTS; do
  grep -qE "^$key=[^@[:space:]]+@sha256:[0-9a-f]{64}\$" "$LOCK" \
    || fail "в $LOCK нет $key (образ по digest): нужен lock платформы 1.1.10 после патча G9r"
done
grep -qx "BAI_VERSION=$TARGET_LOCK_VERSION" "$LOCK" \
  || fail "в $LOCK нет строки BAI_VERSION=$TARGET_LOCK_VERSION"
# Lock отличается от lock боя после G9r только версией и образом app (documents прежний).
if [[ -n "$PREV_LOCK" ]]; then
  grep -qx "BAI_VERSION=$PREV_LOCK_VERSION" "$PREV_LOCK" \
    || fail "в $PREV_LOCK нет строки BAI_VERSION=$PREV_LOCK_VERSION (lock боя после патча G9r)"
  diff_keys="$(python3 -I - "$PREV_LOCK" "$LOCK" <<'PY'
import sys

def read(path: str) -> dict[str, str]:
    pairs = (line.split("=", 1) for line in open(path, encoding="utf-8").read().splitlines()
             if line.startswith("BAI_") and "=" in line)
    return {key: value for key, value in pairs}

old, new = read(sys.argv[1]), read(sys.argv[2])
print(" ".join(sorted(k for k in set(old) | set(new) if old.get(k) != new.get(k))))
PY
)" || fail "не удалось сравнить $LOCK с $PREV_LOCK"
  for key in $diff_keys; do
    [[ " $ALLOWED_LOCK_DIFF " == *" $key "* ]] \
      || fail "$LOCK отличается от $PREV_LOCK по $key: разрешено только: $ALLOWED_LOCK_DIFF"
  done
  for key in $REQUIRED_LOCK_DIFF; do
    [[ " $diff_keys " == *" $key "* ]] \
      || fail "$LOCK не меняет $key относительно $PREV_LOCK: патч G9s катит образ app"
  done
fi

REVISION="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
if [[ -n "$(git -C "$ROOT" status --porcelain -- deploy tools 2>/dev/null)" ]]; then
  log "ВНИМАНИЕ: в deploy или tools есть незакоммиченные правки: в пакет они не попадут"
fi
mkdir -p "$OUT/tools"
show() { # show <путь в дереве> <куда>
  git -C "$ROOT" show "HEAD:$1" >"$2" || fail "в HEAD нет $1"
}
for f in "${SCRIPTS_PATCH[@]}"; do show "deploy/patch-9s/$f" "$OUT/$f"; done
for f in "${SCRIPTS_CUTOVER[@]}"; do show "deploy/cutover/$f" "$OUT/$f"; done
chmod +x "$OUT/patch.sh" "$OUT/enable-flags.sh" "$OUT/verify-signatures.sh"
for f in "${ROUTE_TOOLS[@]}"; do show "tools/$f" "$OUT/tools/$f"; done
chmod +x "$OUT/tools/check-routes.sh"
# Необязательные файлы tools/ (нет в HEAD - пропуск с пометкой в выводе).
for f in "${OPTIONAL_TOOLS[@]}"; do
  if git -C "$ROOT" cat-file -e "HEAD:tools/$f" 2>/dev/null; then
    show "tools/$f" "$OUT/tools/$f"
    chmod +x "$OUT/tools/$f"
    log "в пакет добавлен tools/$f"
  else
    log "ПРОПУЩЕНО: tools/$f нет в HEAD, в пакет не попадёт"
  fi
done
show deploy/cutover/routes.tsv "$OUT/routes.tsv"
grep -qxF "$PAGES_ROUTE_ROW" "$OUT/routes.tsv" \
  || fail "в HEAD:deploy/cutover/routes.tsv нет маршрута documents POST /docx/pages"
for f in ${DEPLOY_FILES[@]+"${DEPLOY_FILES[@]}"}; do
  mkdir -p "$OUT/deploy/$(dirname "$f")"
  show "deploy/$f" "$OUT/deploy/$f"
done
# Только проверки HEAD (в пакет не попадают): переменные G8w и флаги documents от G8x остались в
# compose, платформа 1.1.10 (состояние после G9r). Содержимое читается в переменную: grep -q на
# конвейере с git show мог бы оборвать его по SIGPIPE.
for f in "${REQUIRED_VARS_FILES[@]}"; do
  content="$(git -C "$ROOT" show "HEAD:deploy/$f")" || fail "в HEAD нет deploy/$f"
  for v in "${REQUIRED_VARS[@]}"; do
    # Имя целиком: DOCUMENTS_EDIT_PDF не должно находиться внутри DOCUMENTS_EDIT_PDF_FALLBACK_FONT.
    grep -qE "(^|[^A-Z0-9_])$v([^A-Z0-9_]|\$)" <<<"$content" \
      || fail "в HEAD:deploy/$f нет переменной $v" \
        "(G9s ставится поверх G8w, G8x, G8z, G9p, G9q, G9q2, G9q3 и G9r)"
  done
done
# Новые и прежние переменные app в файле, который кладётся в пакет: у новых свои умолчания, у
# прежних true.
content="$(git -C "$ROOT" show "HEAD:deploy/$NEW_APP_FILE")" \
  || fail "в HEAD нет deploy/$NEW_APP_FILE"
check_app_var() { # check_app_var <имя> <умолчание>
  grep -qE "^[[:space:]]+$1: \\$\\{$1:-$2\\}[[:space:]]*\$" <<<"$content" \
    || fail "в HEAD:deploy/$NEW_APP_FILE у $1 нет умолчания $2" \
      "(строка NAME: \${NAME:-$2})"
}
for item in "${NEW_APP_VARS[@]}"; do check_app_var "${item%%=*}" "${item#*=}"; done
for v in "${OLD_APP_VARS[@]}"; do check_app_var "$v" "$OLD_APP_DEFAULT"; done
version_line="PLATFORM_PACKAGES_VERSION=$PLATFORM_VERSION"
content="$(git -C "$ROOT" show "HEAD:deploy/$PLATFORM_VERSION_FILE")" \
  || fail "в HEAD нет deploy/$PLATFORM_VERSION_FILE"
grep -qx "$version_line" <<<"$content" \
  || fail "в HEAD:deploy/$PLATFORM_VERSION_FILE нет строки $version_line"
# Целостность копии платформы (состояние G9r): сумма compose.base.yml равна строке в
# PLATFORM-VERSION, новые переменные платформы 1.1.10 на месте. В пакет эти файлы не попадают.
base_content="$(git -C "$ROOT" show "HEAD:deploy/$PLATFORM_BASE_FILE")" \
  || fail "в HEAD нет deploy/$PLATFORM_BASE_FILE"
want_sum="$(awk '$1 == "sha256" && $3 == "compose.base.yml" { print $2 }' <<<"$content")"
have_sum="$(git -C "$ROOT" show "HEAD:deploy/$PLATFORM_BASE_FILE" | sha256sum | cut -d' ' -f1)"
[[ -n "$want_sum" && "$want_sum" == "$have_sum" ]] \
  || fail "в HEAD сумма deploy/$PLATFORM_BASE_FILE не сходится с $PLATFORM_VERSION_FILE"
for v in "${PLATFORM_NEW_VARS[@]}"; do
  grep -qE "(^|[^A-Z0-9_])$v([^A-Z0-9_]|\$)" <<<"$base_content" \
    || fail "в HEAD:deploy/$PLATFORM_BASE_FILE нет переменной $v (платформа $PLATFORM_VERSION)"
done
cp "$LOCK" "$OUT/images.lock"
[[ -z "$SIGNATURES" ]] || cp "$SIGNATURES" "$OUT/signatures.txt"
cp "$COSIGN_PUB" "$OUT/cosign.pub"
[[ -z "$RUNBOOK" ]] || cp "$RUNBOOK" "$OUT/OWNER-RUNBOOK.md"

bad="$(cd "$OUT" && find . -type f | sed 's|^\./||' \
  | grep -E "$FORBIDDEN_RE" | grep -vE "$ALLOWED_RE" || true)"
[[ -z "$bad" ]] || fail "в пакете запрещённые файлы: $(echo "$bad" | tr '\n' ' ')"
if grep -rIlE '^(-----BEGIN [A-Z ]*PRIVATE KEY-----|AGE-SECRET-KEY-)' "$OUT" >/dev/null 2>&1; then
  fail "в пакете найдено закрытое ключевое содержимое"
fi
# Права как у обычной распаковки: файлы читаются всеми (секретов в пакете нет), скрипты исполняются.
find "$OUT" -type d -exec chmod 755 {} +
find "$OUT" -type f ! -perm -u+x -exec chmod 644 {} +
[[ ! -e "$OUT/db" ]] || fail "в патч-пакете не должно быть db (миграций у патча нет)"
# Из файлов дерева в пакете ровно разрешённые (список совпадает с PATCH_FILE_ALLOW в patch.sh).
deploy_got="$(cd "$OUT" && { find deploy -type f 2>/dev/null || true; } | sed 's|^deploy/||' \
  | LC_ALL=C sort | tr '\n' ' ')"
deploy_want="$(printf '%s\n' "${DEPLOY_FILES[@]}" | LC_ALL=C sort | tr '\n' ' ')"
[[ "$deploy_got" == "$deploy_want" ]] \
  || fail "в пакете файлы deploy/ '$deploy_got', разрешено только '$deploy_want'"

log "MANIFEST.sha256"
(cd "$OUT" && find . -type f ! -name MANIFEST.sha256 | sort | sed 's|^\./||' \
  | xargs -d '\n' sha256sum >MANIFEST.sha256)
if [[ -n "$TGZ" ]]; then
  parent="$(dirname "$(readlink -f "$OUT")")"
  base="$(basename "$(readlink -f "$OUT")")"
  tar -C "$parent" --transform "s|^$base|patch-package|" -czf "$TGZ" "$base"
  chmod 600 "$TGZ"
  log "архив: $TGZ ($(du -h "$TGZ" | cut -f1))"
fi
log "готово: $OUT ($(find "$OUT" -type f | wc -l) файлов, ревизия проекта $REVISION)"
