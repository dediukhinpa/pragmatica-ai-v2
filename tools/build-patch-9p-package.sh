#!/usr/bin/env bash
# Сборка патч-пакета G9p (платформа остаётся 1.1.6; меняются ДВА образа проекта: documents
# pragmatika-documents с ручкой POST /docx/pages и app pragmatika-app, оба 1.1.6-pragmatika.4, и
# файл compose.project.yml с двумя новыми переменными app): каталог, который переносят на боевой
# хост и запускают там `bash patch.sh` (см. OWNER-RUNBOOK.md). Ставится строго после патча G8z.
# Красная зона: запускает владелец.
#
# Использование:
#   bash tools/build-patch-9p-package.sh --out КАТАЛОГ --lock ФАЙЛ [--signatures ФАЙЛ]
#        [--prev-lock ФАЙЛ] [--cosign-pub ФАЙЛ] [--runbook ФАЙЛ] [--tgz ФАЙЛ] [--help]
#
# Состав (копии закоммиченного дерева, git show HEAD; незакоммиченное не попадает):
#   patch.sh, lib.sh, verify-signatures.sh   сценарий патча G9p и общие функции (deploy/patch-9p,
#                                            deploy/cutover)
#   enable-flags.sh                          необязательный шаг runbook: выключатель флагов
#                                            PRICE_EDIT_FIRST_ENABLED и DOCX_PAGES_ENABLED (по
#                                            умолчанию обе функции включены; патч .env не
#                                            меняет)
#   tools/check-routes.sh, route-flags.tsv, routes.tsv   проверка маршрутов стека (маршруты
#                                            берутся из готового routes.tsv, исходники проекта
#                                            и route-manifest.ts на хосте не нужны; в routes.tsv
#                                            обязан быть маршрут documents POST /docx/pages)
#   deploy/compose.project.yml               единственный файл дерева, который патч заменяет
#                                            (из HEAD; кроме него других файлов deploy/ нет)
#   images.lock, cosign.pub                  образы по digest и открытый ключ
#   signatures.txt                           подтверждение подписей (если дан --signatures; без
#                                            него на хосте нужен cosign)
#   OWNER-RUNBOOK.md                         инструкция владельцу (если дан --runbook)
#   MANIFEST.sha256                          контрольные суммы всех файлов пакета
# Образы в пакет не входят: их владелец получает отдельно (docker pull по digest из lock либо
# `bash patch.sh --images-tar ФАЙЛ`). Секретов, .env и ключей в пакет не кладётся: проверяется
# перед записью манифеста. Миграций (db) в патче нет. Проверки сборки: lock содержит
# BAI_IMAGE_APP, BAI_IMAGE_DOCUMENTS (и mask) по digest и BAI_VERSION=1.1.6-pragmatika.4; с
# --prev-lock (lock боя после G8z, этап 8z) lock отличается от него ТОЛЬКО ключами BAI_VERSION,
# BAI_IMAGE_APP и BAI_IMAGE_DOCUMENTS, а образы app и documents оба сменились; подтверждение
# подписей (если дано) относится к ЭТОМУ lock (sha256), этому ключу и покрывает все его образы. В
# HEAD deploy/compose.project.yml обязан содержать обе новые переменные app с умолчанием true
# (PRICE_EDIT_FIRST_ENABLED: ${PRICE_EDIT_FIRST_ENABLED:-true}, то же для DOCX_PAGES_ENABLED;
# false - выключатель в .env). Только проверки (в пакет не попадают): оба файла compose в HEAD
# (compose.project.yml и platform/compose.base.yml) содержат обе переменные поиска G8w
# (YANDEX_SEARCH_MAX_CONCURRENCY, YANDEX_SEARCH_MIN_INTERVAL_MS) и четыре флага documents от G8x
# (DOCUMENTS_EDIT_PPTX, DOCUMENTS_EDIT_PDF, DOCUMENTS_PPT_CONVERT,
# DOCUMENTS_EDIT_PDF_FALLBACK_FONT), compose.project.yml в HEAD - обе переменные G8z
# (SHORTLIST_PAGING_ENABLED, SUPPLIER_DISCOVERY_ENABLED) с умолчанием true, routes.tsv в HEAD -
# маршрут /docx/pages, а PLATFORM-VERSION в HEAD - версию 1.1.6. С --tgz пакет упаковывается в
# архив (режим 600, корень patch-package/; обычно stage-9p/patch-package.tgz).
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
# Новые переменные app: обязаны быть в compose.project.yml из HEAD с умолчанием true (функции
# включены по умолчанию, false в .env - выключатель). Переменные G8z (уже на бою) обязаны остаться
# в этом же файле с тем же умолчанием: пакет заменяет файл целиком.
NEW_APP_VARS=(PRICE_EDIT_FIRST_ENABLED DOCX_PAGES_ENABLED)
G8Z_APP_VARS=(SHORTLIST_PAGING_ENABLED SUPPLIER_DISCOVERY_ENABLED)
NEW_APP_DEFAULT="true"
NEW_APP_FILE="compose.project.yml"
# Маршрут documents, который появляется с этим патчем: обязан быть в routes.tsv из HEAD.
PAGES_ROUTE_ROW=$'documents\tPOST\t/docx/pages\troute'
# Ключи lock, которыми новый lock вправе отличаться от lock боя после G8z (--prev-lock): версия и
# оба образа проекта (оба обязаны смениться).
ALLOWED_LOCK_DIFF="BAI_VERSION BAI_IMAGE_APP BAI_IMAGE_DOCUMENTS"
REQUIRED_LOCK_DIFF="BAI_IMAGE_APP BAI_IMAGE_DOCUMENTS"
# Переменные, которые обязаны быть в файлах compose из HEAD (только проверка, в пакет файлы не
# попадают): поиск Яндекса (app, от G8w) и флаги documents (от G8x).
REQUIRED_VARS=(YANDEX_SEARCH_MAX_CONCURRENCY YANDEX_SEARCH_MIN_INTERVAL_MS
  DOCUMENTS_EDIT_PPTX DOCUMENTS_EDIT_PDF DOCUMENTS_PPT_CONVERT DOCUMENTS_EDIT_PDF_FALLBACK_FONT)
REQUIRED_VARS_FILES=(compose.project.yml platform/compose.base.yml)
# Версия платформы в HEAD (патч её не меняет) и версия lock, которую ставит патч.
PLATFORM_VERSION_FILE="platform/PLATFORM-VERSION"
PLATFORM_VERSION="1.1.6"
TARGET_LOCK_VERSION="1.1.6-pragmatika.4"
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
log() { echo "[build-patch-9p-package] $(date -u +%T) $*"; }
fail() { echo "[build-patch-9p-package] ОШИБКА: $*" >&2; exit "$EXIT_FAILED"; }

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
    || fail "в $LOCK нет $key (образ по digest): нужен lock платформы 1.1.6 после патча G8z"
done
grep -qx "BAI_VERSION=$TARGET_LOCK_VERSION" "$LOCK" \
  || fail "в $LOCK нет строки BAI_VERSION=$TARGET_LOCK_VERSION"
# Lock отличается от lock боя после G8z только версией и образами app и documents.
if [[ -n "$PREV_LOCK" ]]; then
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
      || fail "$LOCK не меняет $key относительно $PREV_LOCK: патч G9p катит оба образа"
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
for f in "${SCRIPTS_PATCH[@]}"; do show "deploy/patch-9p/$f" "$OUT/$f"; done
for f in "${SCRIPTS_CUTOVER[@]}"; do show "deploy/cutover/$f" "$OUT/$f"; done
chmod +x "$OUT/patch.sh" "$OUT/enable-flags.sh" "$OUT/verify-signatures.sh"
for f in "${ROUTE_TOOLS[@]}"; do show "tools/$f" "$OUT/tools/$f"; done
chmod +x "$OUT/tools/check-routes.sh"
show deploy/cutover/routes.tsv "$OUT/routes.tsv"
grep -qxF "$PAGES_ROUTE_ROW" "$OUT/routes.tsv" \
  || fail "в HEAD:deploy/cutover/routes.tsv нет маршрута documents POST /docx/pages"
for f in ${DEPLOY_FILES[@]+"${DEPLOY_FILES[@]}"}; do
  mkdir -p "$OUT/deploy/$(dirname "$f")"
  show "deploy/$f" "$OUT/deploy/$f"
done
# Только проверки HEAD (в пакет не попадают): переменные G8w и флаги documents от G8x остались в
# compose, платформа 1.1.6. Содержимое читается в переменную: grep -q на конвейере с git show
# мог бы оборвать его по SIGPIPE.
for f in "${REQUIRED_VARS_FILES[@]}"; do
  content="$(git -C "$ROOT" show "HEAD:deploy/$f")" || fail "в HEAD нет deploy/$f"
  for v in "${REQUIRED_VARS[@]}"; do
    # Имя целиком: DOCUMENTS_EDIT_PDF не должно находиться внутри DOCUMENTS_EDIT_PDF_FALLBACK_FONT.
    grep -qE "(^|[^A-Z0-9_])$v([^A-Z0-9_]|\$)" <<<"$content" \
      || fail "в HEAD:deploy/$f нет переменной $v (G9p ставится поверх G8w, G8x и G8z)"
  done
done
# Новые переменные app в файле, который кладётся в пакет: обе с умолчанием true.
content="$(git -C "$ROOT" show "HEAD:deploy/$NEW_APP_FILE")" \
  || fail "в HEAD нет deploy/$NEW_APP_FILE"
for v in "${NEW_APP_VARS[@]}" "${G8Z_APP_VARS[@]}"; do
  grep -qE "^[[:space:]]+$v: \\$\\{$v:-$NEW_APP_DEFAULT\\}[[:space:]]*\$" <<<"$content" \
    || fail "в HEAD:deploy/$NEW_APP_FILE у $v нет умолчания $NEW_APP_DEFAULT" \
      "(строка NAME: \${NAME:-$NEW_APP_DEFAULT})"
done
version_line="PLATFORM_PACKAGES_VERSION=$PLATFORM_VERSION"
content="$(git -C "$ROOT" show "HEAD:deploy/$PLATFORM_VERSION_FILE")" \
  || fail "в HEAD нет deploy/$PLATFORM_VERSION_FILE"
grep -qx "$version_line" <<<"$content" \
  || fail "в HEAD:deploy/$PLATFORM_VERSION_FILE нет строки $version_line"
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
