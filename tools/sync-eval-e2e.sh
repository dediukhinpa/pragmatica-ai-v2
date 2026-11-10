#!/usr/bin/env bash
# Синхронизация eval и e2e Прагматики из старого репозитория в v2.
# Использование: tools/sync-eval-e2e.sh <коммит старого репо>
# Читает ТОЛЬКО git-объекты старого репо (SRC_REPO), рабочее дерево не трогает. Порождает
# eval/{cases,recordings,reports,environments,synthetic,scripts,state.ts,constants.ts}, tests/eval
# и e2e/{tests,lib,fixtures,load}; список с контрольными суммами - tools/sync-eval-e2e-manifest.tsv.
# Повторный запуск на том же коммите изменений не даёт. Порождённые файлы руками не править:
# правила - в sync_eval_e2e.py, файлах tools/*-eval*.txt и патчах tools/overrides-eval/.
# Файлы ядра (src/kit, src/agents) порождает tools/sync-agents.sh: запускайте его раньше.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SRC_REPO="${SRC_REPO:-$HOME/pragmatika-purchasing}"
REF="${1:?коммит старого репо}"

echo "sync-eval-e2e: ref=$REF repo=$REPO"
COMMIT="$(git -C "$SRC_REPO" rev-parse --verify "$REF^{commit}")"
if ! git -C "$SRC_REPO" merge-base --is-ancestor "$COMMIT" origin/prod 2>/dev/null; then
  echo "sync-eval-e2e: ВНИМАНИЕ: $COMMIT не входит в origin/prod старого репо" >&2
fi
for pkg in core adapters testing eval; do
  [ -d "$REPO/node_modules/@business-ai/$pkg" ] || {
    echo "нет node_modules/@business-ai/$pkg: bun install" >&2
    exit 1
  }
done
[ -f "$HERE/sync-manifest.tsv" ] || {
  echo "нет tools/sync-manifest.tsv: сначала tools/sync-agents.sh" >&2
  exit 1
}

SCRATCH="${SYNC_SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/sync-eval-e2e.XXXXXX")}"
[ "${KEEP_SCRATCH:-0}" = "1" ] || trap 'rm -rf "${SCRATCH:?}"' EXIT

# 1. Деревья старого репо - из git-объектов.
mkdir -p "$SCRATCH/src"
git -C "$SRC_REPO" archive "$COMMIT" core/src core/tests eval e2e | tar -x -C "$SCRATCH/src"

# 2. Вид платформы: исходники установленных пакетов в раскладке packages/<имя>/src.
PLAT="$SCRATCH/plat"
for pkg in core adapters testing eval; do
  mkdir -p "$PLAT/packages/$pkg"
  cp -r "$REPO/node_modules/@business-ai/$pkg/src" "$PLAT/packages/$pkg/src"
done
PLATFORM_VERSION="$(python3 -I -c \
  'import json,sys;print(json.load(open(sys.argv[1]))["version"])' \
  "$REPO/node_modules/@business-ai/core/package.json")"

# 3. Копирование и переписывание импортов (раскладка v2 на выходе).
GEN="$SCRATCH/gen"
mkdir -p "$REPO/tmp"
python3 -I "$HERE/sync_eval_e2e.py" generate --src "$SCRATCH/src" --platform "$PLAT" \
  --out "$GEN" --files "$HERE/sync-eval-e2e-files.txt" \
  --owned "$HERE/owned-symbols.txt" "$HERE/owned-symbols-eval.txt" \
  --renames "$HERE/renames-eval.txt" --routes "$HERE/routes-eval.txt" \
  --kit-manifest "$HERE/sync-manifest.tsv" --reports "$REPO/tmp"

# 4. Патчи проекта (унифицированный diff относительно сгенерированного дерева, patch -p0).
PATCHED=0
for p in "$HERE"/overrides-eval/*.patch; do
  [ -e "$p" ] || continue
  patch -s -p0 --batch --no-backup-if-mismatch -d "$GEN" < "$p"
  PATCHED=$((PATCHED + 1))
done
echo "sync-eval-e2e: применено патчей проекта: $PATCHED"

# 4а. Пересъёмка синтетических записей под агентов v2. Запросы к модели строятся из промптов
# платформы (они отличаются от промптов старого репозитория), поэтому отпечатки запросов и
# оценки токенов в записях из SRC устарели: раннер платформы помечает такие записи «устарела».
# Записи синтетические (ответы даёт сценарий), модель не вызывается. Скрипты берутся из уже
# записанного дерева репозитория; при самой первой синхронизации их ещё нет - запустите повторно.
REGEN_LOG="$REPO/tmp/sync-eval-e2e-regen.log"
REGEN_DONE=0
if [ "${REGEN_RECORDINGS:-1}" = "1" ]; then
  for script in make-synthetic-recordings make-handoff-recordings; do
    if [ -f "$REPO/eval/scripts/$script.ts" ]; then
      (cd "$REPO" && EVAL_DATA_ROOT="$GEN/eval" bun "eval/scripts/$script.ts") \
        > "$REGEN_LOG.$script" 2>&1 || {
        echo "sync-eval-e2e: пересъёмка $script не удалась, см. $REGEN_LOG.$script" >&2
        exit 1
      }
      REGEN_DONE=$((REGEN_DONE + 1))
    else
      echo "sync-eval-e2e: нет eval/scripts/$script.ts, пересъёмку пропускаю" >&2
      echo "sync-eval-e2e: запустите синхронизацию ещё раз" >&2
    fi
  done
fi
echo "sync-eval-e2e: пересъёмка записей: скриптов выполнено $REGEN_DONE из 2"

# 5. Запись в репозиторий и манифест.
python3 -I "$HERE/sync_eval_e2e.py" apply --tree "$GEN" --repo "$REPO" --src "$COMMIT" \
  --platform "$PLATFORM_VERSION" --patches "$PATCHED"
echo "sync-eval-e2e: готово, отчёт: tmp/sync-eval-e2e-report.md"
