#!/usr/bin/env bash
# Синхронизация агентов Прагматики из старого репозитория в v2.
# Использование: tools/sync-agents.sh <коммит старого репо>
# Читает ТОЛЬКО git-объекты старого репо (SRC_REPO), рабочее дерево не трогает. Генерирует
# src/agents, src/kit, tests/agents, tests/kit и файлы из SYNC_EXTRA; список с контрольными
# суммами - tools/sync-manifest.tsv. Повторный запуск на том же коммите изменений не даёт.
# Файлы src/agents/** руками не править: правила - в sync_agents.py, relocate.py, overrides/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SRC_REPO="${SRC_REPO:-$HOME/pragmatika-purchasing}"
REF="${1:?коммит старого репо}"

# Файлы проекта вне core/ и shared/, на которые ссылаются тесты агентов (путь в старом репо).
SYNC_EXTRA=(docs/templates/supplier-template.xlsx)

echo "sync-agents: ref=$REF repo=$REPO"
COMMIT="$(git -C "$SRC_REPO" rev-parse --verify "$REF^{commit}")"
if ! git -C "$SRC_REPO" merge-base --is-ancestor "$COMMIT" origin/prod 2>/dev/null; then
  echo "sync-agents: ВНИМАНИЕ: $COMMIT не входит в origin/prod старого репо" >&2
fi
[ -d "$REPO/node_modules/@business-ai/core" ] || { echo "нет node_modules: bun install" >&2; exit 1; }

SCRATCH="${SYNC_SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/sync-agents.XXXXXX")}"
[ "${KEEP_SCRATCH:-0}" = "1" ] || trap 'rm -rf "${SCRATCH:?}"' EXIT

# 1. Деревья core/ и shared/ старого репо и нужные файлы - из git-объектов.
mkdir -p "$SCRATCH/src"
git -C "$SRC_REPO" archive "$COMMIT" core/src core/tests shared "${SYNC_EXTRA[@]}" \
  | tar -x -C "$SCRATCH/src"

# 2. Вид платформы: исходники установленных пакетов в раскладке packages/<имя>/src.
PLAT="$SCRATCH/plat"
for pkg in core adapters testing; do
  mkdir -p "$PLAT/packages/$pkg"
  cp -r "$REPO/node_modules/@business-ai/$pkg/src" "$PLAT/packages/$pkg/src"
done
PLATFORM_VERSION="$(python3 -I -c \
  'import json,sys;print(json.load(open(sys.argv[1]))["version"])' \
  "$REPO/node_modules/@business-ai/core/package.json")"

# 3. Копирование и переписывание импортов (раскладка старого репо).
L1="$SCRATCH/l1"
python3 -I "$HERE/sync_agents.py" --src "$SCRATCH/src" --platform "$PLAT" --out "$L1" \
  --owned "$HERE/owned-symbols.txt" --renames "$HERE/renames.txt"
for pair in "${SYNC_EXTRA[@]}"; do
  mkdir -p "$L1/$(dirname "$pair")"
  cp "$SCRATCH/src/$pair" "$L1/$pair"
done
# Снимок шорт-листа, который читают тесты агентов: core/tests/fixtures -> tests/fixtures.
mkdir -p "$L1/tests/fixtures"
cp "$SCRATCH/src/core/tests/fixtures/shortlist-cards-10.json" "$L1/tests/fixtures/"

# 4. Патчи проекта (унифицированный diff относительно сгенерированного дерева, patch -p0).
PATCHED=0
for p in "$HERE"/overrides/*.patch; do
  [ -e "$p" ] || continue
  patch -s -p0 --batch --no-backup-if-mismatch -d "$L1" < "$p"
  PATCHED=$((PATCHED + 1))
done
echo "sync-agents: применено патчей проекта: $PATCHED"

# 5. Раскладка v2 и запись в репозиторий.
python3 -I "$HERE/relocate.py" --tree "$L1" --out "$SCRATCH/v2"
python3 -I "$HERE/sync_manifest.py" --tree "$SCRATCH/v2" --repo "$REPO" --src "$COMMIT" \
  --platform "$PLATFORM_VERSION" --patches "$PATCHED"
mkdir -p "$REPO/tmp"
cp "$L1/GAPS.tsv" "$REPO/tmp/sync-gaps.tsv"
cp "$L1/UNRESOLVED.tsv" "$REPO/tmp/sync-unresolved.tsv"
cp "$L1/BARE-DEPS.txt" "$REPO/tmp/sync-bare-deps.txt"
echo "sync-agents: готово, отчёт: tmp/sync-report.md, пробелы платформы: tmp/sync-gaps.tsv"
