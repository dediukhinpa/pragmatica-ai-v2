#!/usr/bin/env bash
# Сквозной прогон проекта Прагматика: сценарии лежат здесь, сервисы и сам запуск - в дереве
# платформы (BAI_PLATFORM_DIR, по умолчанию ~/wt-bai-modular).
#
# Платформенный e2e/run.sh считает корень от своего расположения и запускает тесты из своего
# каталога, поэтому напрямую тесты другого репозитория он не берёт. Платформу не правим: здесь
# собирается временное «зеркало» дерева платформы из символических ссылок, в котором каталог
# e2e/ составлен из платформенных файлов и сценариев проекта, и запускается платформенный
# run.sh из этого зеркала. Ссылки разворачиваются в настоящие пути, поэтому импорты сценариев
# (`@business-ai/*`, `../../src`) разрешаются в дереве проекта.
#
# Использование: e2e/run.sh [аргументы bun test, например имя файла сценария]
# Переменные: BAI_PLATFORM_DIR, E2E_TMP_BASE, E2E_KEEP=1, E2E_LOCK_FILE (flock на время
# прогона), E2E_FARM_ONLY=<каталог> (только собрать зеркало и выйти - для самопроверки),
# E2E_SKIP_RESOURCE_CHECK=1, а также порты и таймауты платформенного run.sh (E2E_*_PORT и др.).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$HERE/.." && pwd)"
PLATFORM_DIR="${BAI_PLATFORM_DIR:-$HOME/wt-bai-modular}"

# Порты сквозного прогона проекта (локальный диапазон 20600-20649, только 127.0.0.1).
PORT_PG=20600
PORT_PSEUDO=20610
PORT_DOCS=20611
PORT_EMBED=20612
PORT_GUARD=20613
PORT_LLM=20614
PORT_VISION=20615
# Порог ресурсов хоста: сервисы и Postgres тяжёлые, при нехватке прогон не начинаем.
MIN_DISK_GIB="${E2E_MIN_DISK_GIB:-8}"
MIN_RAM_MIB="${E2E_MIN_RAM_MIB:-3072}"
MIB_PER_GIB=1024
# Каталоги и файлы платформы, которые нужны её run.sh (корень зеркала).
PLATFORM_ROOT_LINKS=(services gateway vendor db)
PROJECT_E2E_LINKS=(tests lib load bunfig.toml register-project.ts)
# Каталоги проекта в корне зеркала: сценарии берут шаблоны документов из E2E_ROOT/docs.
PROJECT_ROOT_LINKS=(docs)

log() { echo "[e2e-project] $*"; }
die() { echo "ОШИБКА: $*" >&2; exit 1; }

check_resources() {
  [[ "${E2E_SKIP_RESOURCE_CHECK:-0}" == "1" ]] && return 0
  local ram_mib disk_kib disk_gib
  ram_mib="$(free -m | awk '/^Mem:/ {print $7}')"
  disk_kib="$(df -Pk / | awk 'NR==2 {print $4}')"
  disk_gib=$((disk_kib / MIB_PER_GIB / MIB_PER_GIB))
  log "Ресурсы: свободная память ${ram_mib} МиБ, диск ${disk_gib} ГиБ"
  if (( ram_mib < MIN_RAM_MIB || disk_gib < MIN_DISK_GIB )); then
    die "мало ресурсов (нужно: память >= ${MIN_RAM_MIB} МиБ, диск >= ${MIN_DISK_GIB} ГиБ)"
  fi
}

# Склейка фикстур: сначала проект (прайсы, шаблоны), затем платформа (база знаний). Платформенный
# run.sh вызывает e2e/fixtures/make_fixtures.py с одним аргументом - каталогом files.
write_fixtures_wrapper() {
  local dest="$1"
  cat >"$dest" <<'PY'
"""Склейка фикстур зеркала: проект (прайсы, шаблоны), затем платформа (база знаний)."""

from __future__ import annotations

import runpy
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PARTS = ("make_project_fixtures.py", "make_platform_fixtures.py")


def main() -> None:
    """Запустить оба скрипта с тем же аргументом (каталог files)."""
    for name in PARTS:
        runpy.run_path(str(HERE / name), run_name="__main__")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("нужен один аргумент: каталог files")
    main()
PY
}

build_farm() {
  local farm="$1" name
  [[ -f "$PLATFORM_DIR/e2e/run.sh" ]] || die "нет $PLATFORM_DIR/e2e/run.sh (BAI_PLATFORM_DIR)"
  mkdir -p "$farm/e2e/fixtures"
  for name in "${PLATFORM_ROOT_LINKS[@]}"; do
    [[ -e "$PLATFORM_DIR/$name" ]] || die "в платформе нет $name"
    ln -s "$PLATFORM_DIR/$name" "$farm/$name"
  done
  for name in "${PROJECT_ROOT_LINKS[@]}"; do
    [[ -e "$PROJECT_DIR/$name" ]] || die "в проекте нет $name"
    ln -s "$PROJECT_DIR/$name" "$farm/$name"
  done
  ln -s "$PLATFORM_DIR/e2e/run.sh" "$farm/e2e/run.sh"
  for name in "${PROJECT_E2E_LINKS[@]}"; do
    [[ -e "$HERE/$name" ]] || die "в проекте нет e2e/$name"
    ln -s "$HERE/$name" "$farm/e2e/$name"
  done
  # Фикстуры: файлы платформы и проекта рядом; одноимённый make_fixtures.py - склейка.
  local file base
  for file in "$PLATFORM_DIR"/e2e/fixtures/*; do
    [[ -f "$file" ]] || continue
    base="$(basename "$file")"
    if [[ "$base" == "make_fixtures.py" ]]; then base="make_platform_fixtures.py"; fi
    ln -s "$file" "$farm/e2e/fixtures/$base"
  done
  for file in "$HERE"/fixtures/*; do
    [[ -f "$file" ]] || continue
    base="$(basename "$file")"
    if [[ "$base" == "make_fixtures.py" ]]; then base="make_project_fixtures.py"; fi
    [[ ! -e "$farm/e2e/fixtures/$base" ]] || die "фикстура $base есть и у платформы, и у проекта"
    ln -s "$file" "$farm/e2e/fixtures/$base"
  done
  write_fixtures_wrapper "$farm/e2e/fixtures/make_fixtures.py"
}

if [[ -n "${E2E_FARM_ONLY:-}" ]]; then
  build_farm "$E2E_FARM_ONLY"
  log "Зеркало собрано: $E2E_FARM_ONLY"
  exit 0
fi

if [[ -n "${E2E_LOCK_FILE:-}" && -z "${E2E_LOCK_HELD:-}" ]]; then
  # Один тяжёлый прогон на хосте: ждём общий замок и перезапускаем себя уже под ним.
  export E2E_LOCK_HELD=1
  exec flock "$E2E_LOCK_FILE" bash "${BASH_SOURCE[0]}" "$@"
fi

check_resources
BASE_TMP="${E2E_TMP_BASE:-${TMPDIR:-/tmp}}"
FARM="$(mktemp -d "$BASE_TMP/bai-e2e-project.XXXXXX")"
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  rm -rf "${FARM:?}"
  exit "$code"
}
trap cleanup EXIT INT TERM
build_farm "$FARM"

# Порты по умолчанию - из диапазона проекта; явные E2E_*_PORT имеют приоритет.
export E2E_PG_PORT="${E2E_PG_PORT:-$PORT_PG}"
export E2E_PSEUDO_PORT="${E2E_PSEUDO_PORT:-$PORT_PSEUDO}"
export E2E_DOCS_PORT="${E2E_DOCS_PORT:-$PORT_DOCS}"
export E2E_EMBED_PORT="${E2E_EMBED_PORT:-$PORT_EMBED}"
export E2E_GUARD_PORT="${E2E_GUARD_PORT:-$PORT_GUARD}"
export E2E_LLM_PORT="${E2E_LLM_PORT:-$PORT_LLM}"
export E2E_VISION_PORT="${E2E_VISION_PORT:-$PORT_VISION}"
# Корень проекта (фикстуры, шаблоны документов) и миграции потока app: платформенный
# db/migrate.sh применит их после своих.
export E2E_PROJECT_ROOT="$PROJECT_DIR"
export APP_MIGRATIONS_DIR="$PROJECT_DIR/db/app"
if [[ -f "$PROJECT_DIR/db/legacy-map.tsv" ]]; then
  export APP_LEGACY_MAP="$PROJECT_DIR/db/legacy-map.tsv"
fi

log "Платформа: $PLATFORM_DIR, проект: $PROJECT_DIR"
set +e
bash "$FARM/e2e/run.sh" "$@"
code=$?
set -e
exit "$code"
