#!/usr/bin/env python3
"""Применить сгенерированное дерево к репозиторию v2 и вести манифест синхронизации.

Манифест `tools/sync-manifest.tsv`: первая строка `# src=<коммит>`, дальше `путь<TAB>sha256`
по каждому сгенерированному файлу. Ручные правки таких файлов ловит тест
`tests/sync-guard.test.ts`. Скрипт:
  * удаляет файлы, которые были в прошлом манифесте, а теперь не порождаются;
  * записывает порождённые файлы (только изменившиеся);
  * пишет `tools/last-sync.md` (детерминированная сводка: тот же коммит и правила - тот же
    файл) и `tmp/sync-report.md` (что изменилось относительно прошлой синхронизации).
"""
from __future__ import annotations

import argparse
import hashlib
import logging
from collections import Counter
from pathlib import Path

LOG = logging.getLogger("sync_manifest")
MANIFEST = "tools/sync-manifest.tsv"
SUMMARY = "tools/last-sync.md"
REPORT = "tmp/sync-report.md"
LIST_LIMIT = 200


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_manifest(path: Path) -> tuple[str, dict[str, str]]:
    src = ""
    rows: dict[str, str] = {}
    if not path.exists():
        return src, rows
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("# src="):
            src = line[len("# src="):]
        elif line and not line.startswith("#"):
            name, digest = line.split("\t")
            rows[name] = digest
    return src, rows


def listing(title: str, names: list[str]) -> list[str]:
    out = [f"### {title}: {len(names)}", ""]
    for name in names[:LIST_LIMIT]:
        out.append(f"- `{name}`")
    if len(names) > LIST_LIMIT:
        out.append(f"- ... ещё {len(names) - LIST_LIMIT}")
    out.append("")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tree", type=Path, required=True, help="сгенерированное дерево v2")
    ap.add_argument("--repo", type=Path, required=True, help="корень репозитория v2")
    ap.add_argument("--src", required=True, help="коммит старого репо")
    ap.add_argument("--platform", required=True, help="версия пакетов платформы")
    ap.add_argument("--patches", type=int, default=0, help="число применённых патчей")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    prev_src, prev = read_manifest(args.repo / MANIFEST)
    new: dict[str, str] = {}
    for path in sorted(p for p in args.tree.rglob("*") if p.is_file()):
        new[path.relative_to(args.tree).as_posix()] = sha256(path)

    removed = sorted(set(prev) - set(new))
    added = sorted(set(new) - set(prev))
    changed = sorted(n for n in set(new) & set(prev) if new[n] != prev[n])
    for name in removed:
        target = args.repo / name
        if target.exists():
            target.unlink()
    for name in added + changed:
        dest = args.repo / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes((args.tree / name).read_bytes())

    lines = [f"# src={args.src}"] + [f"{n}\t{d}" for n, d in sorted(new.items())]
    (args.repo / MANIFEST).write_text("\n".join(lines) + "\n", encoding="utf-8")

    roots = Counter("/".join(n.split("/")[:2]) for n in new)
    summary = [
        "# Последняя синхронизация агентов",
        "",
        f"- Коммит старого репозитория: `{args.src}`",
        f"- Пакеты платформы: `{args.platform}`",
        f"- Патчей проекта применено: {args.patches}",
        f"- Сгенерировано файлов: {len(new)}",
        "",
        "| Каталог | Файлов |",
        "|---|---|",
    ] + [f"| `{root}` | {count} |" for root, count in sorted(roots.items())]
    (args.repo / SUMMARY).write_text("\n".join(summary) + "\n", encoding="utf-8")

    report = [
        "# Отчёт синхронизации (не коммитится)",
        "",
        f"- Прошлый коммит: `{prev_src or 'нет'}` -> новый `{args.src}`",
        f"- Файлов: было {len(prev)}, стало {len(new)}",
        "",
    ]
    if not (added or removed or changed):
        report.append("Изменений относительно прошлой синхронизации нет.")
    else:
        report += listing("Добавлено", added)
        report += listing("Изменено", changed)
        report += listing("Удалено", removed)
    out = args.repo / REPORT
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(report) + "\n", encoding="utf-8")
    LOG.info("sync: добавлено %d, изменено %d, удалено %d, всего %d",
             len(added), len(changed), len(removed), len(new))


if __name__ == "__main__":
    main()
