#!/usr/bin/env bash
# Сборка пакета репетиции переезда: каталог, который переносят на РФ-сервер и запускают там
# `bash rehearse.sh` (см. README.md пакета).
#
# Использование:
#   bash tools/build-rehearsal-package.sh --out КАТАЛОГ --lock ФАЙЛ [--schema-expected ФАЙЛ]
#        [--expected-env-names ФАЙЛ] [--expected-pending ФАЙЛ] [--cosign-pub ФАЙЛ] [--help]
#
# Состав пакета (копии закоммиченного дерева, git archive HEAD; незакоммиченное не попадает):
#   rehearse.sh, README.md        сценарий и инструкция (deploy/rehearsal/)
#   images.lock                   образы по digest (платформа 1.0.x + app проекта)
#   cosign.pub                    открытый ключ проверки подписей образов
#   schema-expected.sql           нормализованная схема чистой БД v2 (для сравнения)
#   expected-pending.txt          какие миграции должны ожидать на схеме боя
#   expected-env-names.txt        имена боевого окружения по архиву сбора (необязательно)
#   tools/check_migrations_schema.py   сравнение схем
#   stack/deploy, stack/db        compose, миграции, платформенная копия (без секретов)
#   MANIFEST.sha256               контрольные суммы всех файлов пакета
# Секретов, .env и ключей в пакет не кладётся: проверяется перед записью манифеста.
#
# Коды выхода: 0 - готово; 1 - ошибка сборки; 2 - неверный вызов.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BAI_PROJECT_DIR:-$(cd "$HERE/.." && pwd)}"
EXIT_FAILED=1
EXIT_USAGE=2
# Что берётся из дерева проекта (git archive) в stack/.
STACK_PATHS=(deploy db)
# Файлы, которым нельзя быть в пакете (секреты и боевые копии).
FORBIDDEN_RE='(^|/)(\.env|\.env\..*|secrets\.env|.*\.key|.*\.pem|.*\.bak.*)$'
# Исключения: образец окружения без значений.
ALLOWED_RE='(^|/)\.env\.example$'

OUT=""
LOCK=""
SCHEMA_EXPECTED=""
ENV_NAMES=""
PENDING=""
COSIGN_PUB="${BAI_SIGNING_PUBKEY:-$HOME/.config/bai-signing/cosign.pub}"

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
log() { echo "[build-rehearsal-package] $(date -u +%T) $*"; }
fail() { echo "[build-rehearsal-package] ОШИБКА: $*" >&2; exit "$EXIT_FAILED"; }

while (($#)); do
  case "$1" in
    --out) OUT="${2:?--out КАТАЛОГ}"; shift ;;
    --lock) LOCK="${2:?--lock ФАЙЛ}"; shift ;;
    --schema-expected) SCHEMA_EXPECTED="${2:?}"; shift ;;
    --expected-env-names) ENV_NAMES="${2:?}"; shift ;;
    --expected-pending) PENDING="${2:?}"; shift ;;
    --cosign-pub) COSIGN_PUB="${2:?}"; shift ;;
    --help | -h) usage; exit 0 ;;
    *) echo "неизвестный аргумент: $1" >&2; usage >&2; exit "$EXIT_USAGE" ;;
  esac
  shift
done
[[ -n "$OUT" && -n "$LOCK" ]] || { usage >&2; exit "$EXIT_USAGE"; }
[[ -f "$LOCK" ]] || { echo "нет lock-файла $LOCK" >&2; exit "$EXIT_USAGE"; }
[[ -f "$SCHEMA_EXPECTED" ]] || { echo "нужен --schema-expected ФАЙЛ" >&2; exit "$EXIT_USAGE"; }
[[ -f "$COSIGN_PUB" ]] || { echo "нет открытого ключа $COSIGN_PUB" >&2; exit "$EXIT_USAGE"; }
[[ -z "$ENV_NAMES" || -f "$ENV_NAMES" ]] || { echo "нет файла $ENV_NAMES" >&2; exit "$EXIT_USAGE"; }
[[ -z "$PENDING" || -f "$PENDING" ]] || { echo "нет файла $PENDING" >&2; exit "$EXIT_USAGE"; }
# Каталог пакета должен быть пустым или новым: чужие файлы не смешиваем.
if [[ -e "$OUT" ]] && [[ -n "$(ls -A "$OUT" 2>/dev/null)" ]]; then
  echo "каталог $OUT не пуст" >&2
  exit "$EXIT_USAGE"
fi

REVISION="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
if [[ -n "$(git -C "$ROOT" status --porcelain -- "${STACK_PATHS[@]}" tools 2>/dev/null)" ]]; then
  log "ВНИМАНИЕ: в deploy, db или tools есть незакоммиченные правки: в пакет они не попадут"
fi

mkdir -p "$OUT/stack" "$OUT/tools"
log "копия закоммиченного дерева (${STACK_PATHS[*]}) @ $REVISION"
git -C "$ROOT" archive --format=tar HEAD "${STACK_PATHS[@]}" | tar -x -C "$OUT/stack"
# Образцы и тесты платформы в пакете не нужны; бэкапы и боевые файлы - тем более.
rm -f "$OUT/stack/deploy/images.lock"

cp "$ROOT/deploy/rehearsal/rehearse.sh" "$OUT/rehearse.sh"
cp "$ROOT/deploy/rehearsal/README.md" "$OUT/README.md"
cp "$ROOT/tools/check_migrations_schema.py" "$OUT/tools/check_migrations_schema.py"
cp "$LOCK" "$OUT/images.lock"
cp "$COSIGN_PUB" "$OUT/cosign.pub"
cp "$SCHEMA_EXPECTED" "$OUT/schema-expected.sql"
if [[ -n "$PENDING" ]]; then
  cp "$PENDING" "$OUT/expected-pending.txt"
else
  cp "$ROOT/deploy/rehearsal/expected-pending.txt" "$OUT/expected-pending.txt"
fi
[[ -z "$ENV_NAMES" ]] || cp "$ENV_NAMES" "$OUT/expected-env-names.txt"
chmod +x "$OUT/rehearse.sh"

# Проверка на запрещённое содержимое: секреты, ключи, боевые копии.
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
