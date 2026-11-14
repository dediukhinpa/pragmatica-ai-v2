#!/usr/bin/env bash
# Сборка пакета переключения боя на v2: каталог, который переносят на pragmatika-ru и запускают
# там `bash cutover.sh` (см. README.md и CHECKLIST.md пакета). Красная зона: запускает владелец.
#
# Использование:
#   bash tools/build-cutover-package.sh --out КАТАЛОГ --lock ФАЙЛ --schema-expected ФАЙЛ
#        [--cosign-pub ФАЙЛ] [--freeze-src КОММИТ] [--bai ФАЙЛ] [--help]
#
# Состав пакета (копии закоммиченного дерева, git archive HEAD; незакоммиченное не попадает):
#   cutover.sh, rollback.sh, lib.sh      сценарий переключения и отката (deploy/cutover/)
#   verify-signatures.sh                 подтверждение подписей (запускает владелец на Fornex)
#   units-old-tree.sh                    только чтение: юниты со старым деревом
#   CHECKLIST.md, README.md              инструкции владельцу
#   expected-host-dirs.txt               пути хоста боя по выводу владельца
#   images.lock, cosign.pub              образы по digest и открытый ключ подписей
#   schema-expected.sql                  нормализованная схема чистой БД v2
#   expected-pending.txt                 миграции, которые должны ожидать на схеме боя
#   FREEZE_SRC                           коммит старого репозитория (заморозка G5)
#   tools/check_migrations_schema.py     сравнение схем
#   stack/deploy, stack/db               compose, миграции (с rollback/026_down.sql), платформа
#   bai                                  (необязательно) CLI платформы: только для `bai status`
#   MANIFEST.sha256                      контрольные суммы всех файлов пакета
# Секретов, .env и ключей в пакет не кладётся: проверяется перед записью манифеста.
#
# Коды выхода: 0 - готово; 1 - ошибка сборки; 2 - неверный вызов.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BAI_PROJECT_DIR:-$(cd "$HERE/.." && pwd)}"
EXIT_FAILED=1
EXIT_USAGE=2
STACK_PATHS=(deploy db)
# Файлы пакета из deploy/cutover/ (скрипты исполняемые).
SCRIPTS=(cutover.sh rollback.sh lib.sh verify-signatures.sh units-old-tree.sh)
DOCS=(CHECKLIST.md README.md expected-host-dirs.txt)
FORBIDDEN_RE='(^|/)(\.env|\.env\..*|secrets\.env|.*\.key|.*\.pem|.*\.bak.*)$'
ALLOWED_RE='(^|/)\.env\.example$'
SHA_RE='^[0-9a-f]{40}$'

OUT=""
LOCK=""
SCHEMA_EXPECTED=""
COSIGN_PUB="${BAI_SIGNING_PUBKEY:-$HOME/.config/bai-signing/cosign.pub}"
FREEZE_SRC=""
BAI_FILE=""

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
log() { echo "[build-cutover-package] $(date -u +%T) $*"; }
fail() { echo "[build-cutover-package] ОШИБКА: $*" >&2; exit "$EXIT_FAILED"; }

while (($#)); do
  case "$1" in
    --out) OUT="${2:?--out КАТАЛОГ}"; shift ;;
    --lock) LOCK="${2:?--lock ФАЙЛ}"; shift ;;
    --schema-expected) SCHEMA_EXPECTED="${2:?}"; shift ;;
    --cosign-pub) COSIGN_PUB="${2:?}"; shift ;;
    --freeze-src) FREEZE_SRC="${2:?}"; shift ;;
    --bai) BAI_FILE="${2:?}"; shift ;;
    --help | -h) usage; exit 0 ;;
    *) echo "неизвестный аргумент: $1" >&2; usage >&2; exit "$EXIT_USAGE" ;;
  esac
  shift
done
[[ -n "$OUT" && -n "$LOCK" && -n "$SCHEMA_EXPECTED" ]] || { usage >&2; exit "$EXIT_USAGE"; }
[[ -f "$LOCK" ]] || { echo "нет lock-файла $LOCK" >&2; exit "$EXIT_USAGE"; }
[[ -f "$SCHEMA_EXPECTED" ]] || { echo "нет файла $SCHEMA_EXPECTED" >&2; exit "$EXIT_USAGE"; }
[[ -f "$COSIGN_PUB" ]] || { echo "нет открытого ключа $COSIGN_PUB" >&2; exit "$EXIT_USAGE"; }
[[ -z "$BAI_FILE" || -f "$BAI_FILE" ]] || { echo "нет файла $BAI_FILE" >&2; exit "$EXIT_USAGE"; }
if [[ -e "$OUT" ]] && [[ -n "$(ls -A "$OUT" 2>/dev/null)" ]]; then
  echo "каталог $OUT не пуст" >&2
  exit "$EXIT_USAGE"
fi

# Коммит старого репозитория: из tools/last-sync.md (запись последней синхронизации этапа 7).
if [[ -z "$FREEZE_SRC" ]]; then
  FREEZE_SRC="$(sed -n 's/^- Коммит старого репозитория: `\([0-9a-f]\{40\}\)`.*/\1/p' \
    "$ROOT/tools/last-sync.md" 2>/dev/null | head -1)"
fi
[[ "$FREEZE_SRC" =~ $SHA_RE ]] \
  || fail "не определён FREEZE_SRC (нужен --freeze-src или tools/last-sync.md)"

REVISION="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
if [[ -n "$(git -C "$ROOT" status --porcelain -- "${STACK_PATHS[@]}" tools 2>/dev/null)" ]]; then
  log "ВНИМАНИЕ: в deploy, db или tools есть незакоммиченные правки: в пакет они не попадут"
fi

mkdir -p "$OUT/stack" "$OUT/tools"
log "копия закоммиченного дерева (${STACK_PATHS[*]}) @ $REVISION"
git -C "$ROOT" archive --format=tar HEAD "${STACK_PATHS[@]}" | tar -x -C "$OUT/stack"
rm -f "$OUT/stack/deploy/images.lock"
# Скрипты пакета лежат в корне пакета, их копия в stack не нужна (и не должна расходиться).
rm -rf "${OUT:?}/stack/deploy/cutover"
for f in "${SCRIPTS[@]}"; do
  git -C "$ROOT" show "HEAD:deploy/cutover/$f" >"$OUT/$f" || fail "в HEAD нет deploy/cutover/$f"
  chmod +x "$OUT/$f"
done
for f in "${DOCS[@]}"; do
  git -C "$ROOT" show "HEAD:deploy/cutover/$f" >"$OUT/$f" || fail "в HEAD нет deploy/cutover/$f"
done
git -C "$ROOT" show "HEAD:db/app/rollback/026_down.sql" >/dev/null 2>&1 \
  || fail "в HEAD нет db/app/rollback/026_down.sql: откат БД невозможен"
git -C "$ROOT" show HEAD:tools/check_migrations_schema.py >"$OUT/tools/check_migrations_schema.py"
git -C "$ROOT" show HEAD:deploy/rehearsal/expected-pending.txt >"$OUT/expected-pending.txt"
cp "$LOCK" "$OUT/images.lock"
cp "$COSIGN_PUB" "$OUT/cosign.pub"
cp "$SCHEMA_EXPECTED" "$OUT/schema-expected.sql"
printf '%s\n' "$FREEZE_SRC" >"$OUT/FREEZE_SRC"
if [[ -n "$BAI_FILE" ]]; then cp "$BAI_FILE" "$OUT/bai"; chmod +x "$OUT/bai"; fi

bad="$(cd "$OUT" && find . -type f | sed 's|^\./||' \
  | grep -E "$FORBIDDEN_RE" | grep -vE "$ALLOWED_RE" || true)"
[[ -z "$bad" ]] || fail "в пакете запрещённые файлы: $(echo "$bad" | tr '\n' ' ')"
if grep -rIlE '(PRIVATE KEY|BEGIN AGE|AGE-SECRET-KEY)' "$OUT" >/dev/null 2>&1; then
  fail "в пакете найдено закрытое ключевое содержимое"
fi

log "MANIFEST.sha256"
(cd "$OUT" && find . -type f ! -name MANIFEST.sha256 | sort | sed 's|^\./||' \
  | xargs -d '\n' sha256sum >MANIFEST.sha256)
log "готово: $OUT ($(find "$OUT" -type f | wc -l) файлов, ревизия проекта $REVISION)"
