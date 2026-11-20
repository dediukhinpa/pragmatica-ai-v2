#!/usr/bin/env bash
# Сборка патч-пакета G8y (платформа остаётся 1.1.6; меняются только образы pragmatika-app и
# pragmatika-documents 1.1.6-pragmatika.2): каталог, который переносят на боевой хост и запускают
# там `bash patch.sh` (см. OWNER-RUNBOOK.md). Ставится строго после патча G8x. Красная зона:
# запускает владелец.
#
# Использование:
#   bash tools/build-patch-8y-package.sh --out КАТАЛОГ --lock ФАЙЛ [--signatures ФАЙЛ]
#        [--cosign-pub ФАЙЛ] [--runbook ФАЙЛ] [--tgz ФАЙЛ] [--help]
#
# Состав (копии закоммиченного дерева, git show HEAD; незакоммиченное не попадает):
#   patch.sh, lib.sh, verify-signatures.sh   сценарий патча G8y и общие функции (deploy/patch-8y,
#                                            deploy/cutover)
#   tools/check-routes.sh, route-flags.tsv, routes.tsv   проверка маршрутов стека (маршруты
#                                            берутся из готового routes.tsv, исходники проекта
#                                            и route-manifest.ts на хосте не нужны)
#   images.lock, cosign.pub                  образы по digest и открытый ключ
#   signatures.txt                           подтверждение подписей (если дан --signatures; без
#                                            него на хосте нужен cosign)
#   OWNER-RUNBOOK.md                         инструкция владельцу (если дан --runbook)
#   MANIFEST.sha256                          контрольные суммы всех файлов пакета
# Файлов дерева (deploy/*) в пакете НЕТ: патч заменяет только images.lock. Секретов, .env и ключей
# в пакет не кладётся: проверяется перед записью манифеста. Миграций (db) в патче нет.
# Проверки сборки: lock содержит BAI_IMAGE_APP, BAI_IMAGE_DOCUMENTS (и mask) по digest и
# BAI_VERSION=1.1.6-pragmatika.2; подтверждение подписей (если дано) относится к ЭТОМУ lock
# (sha256), этому ключу и покрывает все его образы. Только проверки (в пакет не кладутся): файлы
# compose в HEAD обязаны содержать обе переменные поиска G8w (YANDEX_SEARCH_MAX_CONCURRENCY,
# YANDEX_SEARCH_MIN_INTERVAL_MS) и четыре флага documents от G8x (DOCUMENTS_EDIT_PPTX,
# DOCUMENTS_EDIT_PDF, DOCUMENTS_PPT_CONVERT, DOCUMENTS_EDIT_PDF_FALLBACK_FONT), а PLATFORM-VERSION
# в HEAD - версию 1.1.6. С --tgz пакет упаковывается в архив (режим 600, корень patch-package/;
# обычно stage-8y/patch-package.tgz).
#
# Коды выхода: 0 - готово; 1 - ошибка сборки; 2 - неверный вызов.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BAI_PROJECT_DIR:-$(cd "$HERE/.." && pwd)}"
EXIT_FAILED=1
EXIT_USAGE=2
SCRIPTS_PATCH=(patch.sh)
SCRIPTS_CUTOVER=(lib.sh verify-signatures.sh)
ROUTE_TOOLS=(check-routes.sh route-flags.tsv)
# Файлы дерева, которые патч вправе заменить: у G8y их нет (меняется только images.lock).
# ДОЛЖНО совпадать с PATCH_FILE_ALLOW в patch.sh.
DEPLOY_FILES=()
# Переменные, которые обязаны быть в файлах compose из HEAD (только проверка, в пакет файлы не
# попадают): поиск Яндекса (app, от G8w) и флаги documents (от G8x).
REQUIRED_VARS=(YANDEX_SEARCH_MAX_CONCURRENCY YANDEX_SEARCH_MIN_INTERVAL_MS
  DOCUMENTS_EDIT_PPTX DOCUMENTS_EDIT_PDF DOCUMENTS_PPT_CONVERT DOCUMENTS_EDIT_PDF_FALLBACK_FONT)
REQUIRED_VARS_FILES=(compose.project.yml platform/compose.base.yml)
# Версия платформы в HEAD (патч её не меняет) и версия lock, которую ставит патч.
PLATFORM_VERSION_FILE="platform/PLATFORM-VERSION"
PLATFORM_VERSION="1.1.6"
TARGET_LOCK_VERSION="1.1.6-pragmatika.2"
FORBIDDEN_RE='(^|/)(\.env|\.env\..*|secrets\.env|.*\.key|.*\.pem|.*\.bak.*)$'
ALLOWED_RE='(^|/)\.env\.example$'
OUT=""
LOCK=""
SIGNATURES=""
COSIGN_PUB="${BAI_SIGNING_PUBKEY:-$HOME/.config/bai-signing/cosign.pub}"
RUNBOOK=""
TGZ=""

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
log() { echo "[build-patch-8y-package] $(date -u +%T) $*"; }
fail() { echo "[build-patch-8y-package] ОШИБКА: $*" >&2; exit "$EXIT_FAILED"; }

while (($#)); do
  case "$1" in
    --out) OUT="${2:?--out КАТАЛОГ}"; shift ;;
    --lock) LOCK="${2:?--lock ФАЙЛ}"; shift ;;
    --signatures) SIGNATURES="${2:?--signatures ФАЙЛ}"; shift ;;
    --cosign-pub) COSIGN_PUB="${2:?}"; shift ;;
    --runbook) RUNBOOK="${2:?}"; shift ;;
    --tgz) TGZ="${2:?}"; shift ;;
    --help | -h) usage; exit 0 ;;
    *) echo "неизвестный аргумент: $1" >&2; usage >&2; exit "$EXIT_USAGE" ;;
  esac
  shift
done
[[ -n "$OUT" && -n "$LOCK" ]] || { usage >&2; exit "$EXIT_USAGE"; }
for f in "$LOCK" "$COSIGN_PUB" ${SIGNATURES:+"$SIGNATURES"}; do
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
    || fail "в $LOCK нет $key (образ по digest): нужен lock платформы 1.1.6 после патча G8x"
done
grep -qx "BAI_VERSION=$TARGET_LOCK_VERSION" "$LOCK" \
  || fail "в $LOCK нет строки BAI_VERSION=$TARGET_LOCK_VERSION"

REVISION="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
if [[ -n "$(git -C "$ROOT" status --porcelain -- deploy tools 2>/dev/null)" ]]; then
  log "ВНИМАНИЕ: в deploy или tools есть незакоммиченные правки: в пакет они не попадут"
fi
mkdir -p "$OUT/tools"
show() { # show <путь в дереве> <куда>
  git -C "$ROOT" show "HEAD:$1" >"$2" || fail "в HEAD нет $1"
}
for f in "${SCRIPTS_PATCH[@]}"; do show "deploy/patch-8y/$f" "$OUT/$f"; done
for f in "${SCRIPTS_CUTOVER[@]}"; do show "deploy/cutover/$f" "$OUT/$f"; done
chmod +x "$OUT/patch.sh" "$OUT/verify-signatures.sh"
for f in "${ROUTE_TOOLS[@]}"; do show "tools/$f" "$OUT/tools/$f"; done
chmod +x "$OUT/tools/check-routes.sh"
show deploy/cutover/routes.tsv "$OUT/routes.tsv"
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
      || fail "в HEAD:deploy/$f нет переменной $v (G8y ставится поверх G8w и G8x)"
  done
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
[[ ! -e "$OUT/deploy" ]] || fail "в патч-пакете G8y не должно быть deploy/ (заменяется только lock)"

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
