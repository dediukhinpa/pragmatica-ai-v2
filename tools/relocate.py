#!/usr/bin/env python3
"""Перенос сгенерированного дерева в раскладку v2 с пересчётом относительных импортов.

Вход: каталог в раскладке старого репо (`src/application/agents/**`, `src/domain/**`,
`tests/application/agents/**`, `tests/**`), в котором уже применены патчи проекта.
Выход: то же содержимое в раскладке v2:

    src/application/agents/**   -> src/agents/**
    src/<прочее>                -> src/kit/<прочее>
    tests/application/agents/** -> tests/agents/**
    tests/<прочее>              -> tests/kit/<прочее>

Файлы вне `src/` и `tests/` (шаблоны, снимки) остаются на месте. Все относительные
спецификаторы (`from`, побочные и динамические импорты, `mock.module`) пересчитываются от новых
положений файла и цели. Строки вида `import.meta.dir` / `new URL(..., import.meta.url)` с
тоже пересчитываются (цель - файл или каталог дерева).
"""
from __future__ import annotations

import argparse
import logging
import re
import shutil
from pathlib import Path, PurePosixPath

LOG = logging.getLogger("relocate")

AGENTS_SRC = "src/application/agents/"
AGENTS_TESTS = "tests/application/agents/"
# Спецификатор в кавычках, начинающийся с `./` или `../` (после from / import / require / mock.module).
SPEC_RE = re.compile(
    r"""(?P<head>(?:from\s*|import\s*\(\s*|import\s+|require\(\s*|mock\.module\(\s*))"""
    r"""(?P<q>['"])(?P<spec>\.{1,2}(?:/[^'"\n]*)?)(?P=q)"""
)
RESOLVE_SUFFIXES = ("", ".ts", ".tsx", ".json", "/index.ts")
# Предел длины строки проекта: однострочный импорт длиннее переносится по имени в строке.
MAX_LINE = 100
LONG_IMPORT_RE = re.compile(
    r"^(?P<kw>import|export)(?P<type> type)? \{ (?P<names>.+?) \} from (?P<rest>['\"].+;)$"
)
# Импорты файлов проекта вне сгенерированного дерева (`src/*.ts` v2): спецификатор в патче уже
# записан в раскладке v2 и переносу не подлежит. Ключ - (файл в старой раскладке, спецификатор).
PROJECT_SPECS = {
    ("src/application/agents/shared/common-tools.owned.ts", "../../legacy-tool-texts"),
}
# Пути-литералы относительно файла теста: `join(import.meta.dir, '../x')` и
# `new URL('../x', import.meta.url)`. Цель - файл или каталог в любом месте дерева.
PATH_LITERAL_RES = (
    re.compile(r"""(?P<head>import\.meta\.dir\s*,\s*)(?P<q>['"])(?P<spec>\.{1,2}/[^'"\n]*)(?P=q)"""),
    re.compile(r"""(?P<head>new URL\(\s*)(?P<q>['"])(?P<spec>\.{1,2}/[^'"\n]*)(?P=q)"""),
)


def new_path(old: str) -> str:
    """Путь файла в раскладке старого репо -> путь в раскладке v2."""
    if old.startswith(AGENTS_SRC):
        return "src/agents/" + old[len(AGENTS_SRC):]
    if old.startswith("src/"):
        return "src/kit/" + old[len("src/"):]
    if old.startswith(AGENTS_TESTS):
        return "tests/agents/" + old[len(AGENTS_TESTS):]
    if old.startswith("tests/"):
        return "tests/kit/" + old[len("tests/"):]
    return old


def norm(path: str) -> str:
    out: list[str] = []
    for seg in path.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if out:
                out.pop()
            continue
        out.append(seg)
    return "/".join(out)


def resolve(files: set[str], base: str, spec: str) -> str | None:
    joined = norm(str(PurePosixPath(base).parent / spec))
    for suffix in RESOLVE_SUFFIXES:
        if joined + suffix in files:
            return joined + suffix
    return None


def relative(src_file: str, target: str, spec: str) -> str:
    """Относительный спецификатор от нового положения файла к новой цели (с тем же суффиксом)."""
    keep_ext = spec.endswith((".ts", ".tsx", ".json"))
    t = target
    if not keep_ext:
        for ext in (".tsx", ".ts"):
            if t.endswith(ext):
                t = t[: -len(ext)]
                break
        if t.endswith("/index") and spec.endswith("/") is False and not spec.endswith("index"):
            t = t[: -len("/index")]
    a = PurePosixPath(src_file).parent.as_posix().split("/")
    b = t.split("/")
    i = 0
    while i < len(a) and i < len(b) - 1 and a[i] == b[i]:
        i += 1
    ups = len(a) - i
    return ("../" * ups if ups else "./") + "/".join(b[i:])


def wrap_long_imports(text: str) -> str:
    """Перенести однострочные импорты длиннее MAX_LINE (скрипт собирает их в одну строку)."""
    out: list[str] = []
    for line in text.split("\n"):
        m = LONG_IMPORT_RE.match(line) if len(line) > MAX_LINE else None
        if m is None:
            out.append(line)
            continue
        names = [n.strip() for n in m.group("names").split(",") if n.strip()]
        body = "\n".join(f"  {n}," for n in names)
        out.append(f"{m.group('kw')}{m.group('type') or ''} {{\n{body}\n}} from {m.group('rest')}")
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tree", type=Path, required=True, help="дерево в старой раскладке")
    ap.add_argument("--out", type=Path, required=True, help="куда писать дерево v2")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    files = {p.relative_to(args.tree).as_posix() for p in args.tree.rglob("*") if p.is_file()}
    # Служебные отчёты sync_agents.py в проект не попадают.
    files -= {"GAPS.tsv", "UNRESOLVED.tsv", "BARE-DEPS.txt"}
    if args.out.exists():
        shutil.rmtree(args.out)
    unresolved = 0
    for old in sorted(files):
        dest = args.out / new_path(old)
        dest.parent.mkdir(parents=True, exist_ok=True)
        src = args.tree / old
        if not old.endswith((".ts", ".tsx")):
            shutil.copyfile(src, dest)
            continue
        text = src.read_text(encoding="utf-8")

        def fix(m: re.Match[str]) -> str:
            nonlocal unresolved
            spec = m.group("spec")
            target = resolve(files, old, spec)
            if target is None and (old, spec) in PROJECT_SPECS:
                return m.group(0)
            if target is None:
                unresolved += 1
                LOG.warning("не найден: %s -> %s", old, spec)
                return m.group(0)
            new_spec = relative(new_path(old), new_path(target), spec)
            return f"{m.group('head')}{m.group('q')}{new_spec}{m.group('q')}"

        def fix_path(m: re.Match[str]) -> str:
            spec = m.group("spec")
            target = norm(str(PurePosixPath(old).parent / spec))
            new_target = new_path(target)
            new_dir = PurePosixPath(new_path(old)).parent.as_posix().split("/")
            parts = new_target.split("/")
            i = 0
            while i < len(new_dir) and i < len(parts) - 1 and new_dir[i] == parts[i]:
                i += 1
            rel = "../" * (len(new_dir) - i) + "/".join(parts[i:])
            if not rel.startswith("."):
                rel = "./" + rel
            return f"{m.group('head')}{m.group('q')}{rel}{m.group('q')}"

        text = SPEC_RE.sub(fix, text)
        for rx in PATH_LITERAL_RES:
            text = rx.sub(fix_path, text)
        dest.write_text(wrap_long_imports(text), encoding="utf-8")
    LOG.info("перенесено файлов: %d, неразобранных относительных импортов: %d",
             len(files), unresolved)


if __name__ == "__main__":
    main()
