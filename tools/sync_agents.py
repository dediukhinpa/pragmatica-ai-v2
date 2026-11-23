#!/usr/bin/env python3
"""Прототип sync-agents: черновой проект из агентов Прагматики на пакетах платформы.

Читает дерево `core/` старого репо (распакованное из git-объектов), копирует агентов и тесты,
а все относительные импорты переписывает так:
  * цель есть в платформе (business-ai)  -> `@business-ai/core|adapters|testing`;
  * цели в платформе нет (предметное)    -> файл копируется в проект вместе с замыканием.
Импорт через barrel (`../../domain`) разбирается по символам до файла-определения.

Пишет `GAPS.tsv` (символ или файл, который нужен проекту, а платформа не отдаёт) и
`UNRESOLVED.tsv` (импорты, которые скрипт не смог разобрать).
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import logging
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

LOG = logging.getLogger("sync_agents")

EXT = (".ts", ".tsx")
# Что копируем «как есть» в корень замыкания: агенты и тесты агентов.
AGENT_SRC_PREFIX = "core/src/application/agents/"
AGENT_TEST_PREFIX = "core/tests/application/agents/"
SRC_ROOT = "core/src/"
TEST_ROOT = "core/tests/"

IMPORT_RE = re.compile(
    r"""(?P<head>(?:import|export)\s+(?P<kind>type\s+)?(?P<clause>[^;'"]*?)\s*from\s*)
        (?P<q>['"])(?P<spec>\.{1,2}/[^'"]*|\.{1,2})(?P=q)""",
    re.X | re.S,
)
SIDE_IMPORT_RE = re.compile(r"""(?P<head>import\s*)(?P<q>['"])(?P<spec>\.{1,2}/[^'"]*)(?P=q)""")
DYN_RE = re.compile(
    r"""(?P<head>(?:import|mock\.module|require)\(\s*)(?P<q>['"])(?P<spec>\.{1,2}/[^'"]*)(?P=q)"""
)
EXPORT_DECL_RE = re.compile(
    r"^export\s+(?:declare\s+)?(?:abstract\s+)?"
    r"(?:const|let|var|(?:async\s+)?function\s*\*?|class|interface|type|enum)\s+(\w+)",
    re.M,
)
EXPORT_LIST_RE = re.compile(
    r"^export\s+(type\s+)?\{(?P<names>[^}]*)\}(?:\s*from\s*['\"](?P<spec>[^'\"]+)['\"])?",
    re.M | re.S,
)
EXPORT_STAR_RE = re.compile(r"^export\s+\*\s+from\s*['\"](?P<spec>[^'\"]+)['\"]", re.M)
BARE_RE = re.compile(r"""from\s*['"]([^./'"][^'"]*)['"]""")


@dataclass
class Tree:
    """Дерево исходников (старого репо или платформы) с индексом экспортов."""

    root: Path
    files: set[str] = field(default_factory=set)
    virtual: dict[str, str] = field(default_factory=dict)
    exports_cache: dict[str, dict[str, tuple[str, str] | None]] = field(default_factory=dict)

    def load(self) -> None:
        for p in self.root.rglob("*"):
            if p.is_file() and p.suffix in EXT and "node_modules" not in p.parts:
                self.files.add(p.relative_to(self.root).as_posix())

    def read(self, rel: str) -> str:
        if rel in self.virtual:
            return self.virtual[rel]
        return (self.root / rel).read_text(encoding="utf-8")

    def resolve(self, base_file: str, spec: str) -> str | None:
        """Относительный спецификатор -> путь файла в дереве (или None)."""
        parts = (Path(base_file).parent / spec).as_posix()
        norm = _normpath(parts)
        for cand in (norm, norm + ".ts", norm + ".tsx", norm + "/index.ts"):
            if cand in self.files:
                return cand
        return None


def _normpath(path: str) -> str:
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


class SymbolIndex:
    """Где определён каждый экспортируемый символ (с разворотом barrel)."""

    def __init__(self, tree: Tree, prefix: str = "") -> None:
        self.tree = tree
        self.prefix = prefix
        self._memo: dict[str, dict[str, str]] = {}
        self._busy: set[str] = set()

    def table(self, rel: str) -> dict[str, str]:
        """имя -> файл, где символ определён по-настоящему."""
        if rel in self._memo:
            return self._memo[rel]
        if rel in self._busy:
            return {}
        self._busy.add(rel)
        text = self.tree.read(rel)
        out: dict[str, str] = {}
        for m in EXPORT_DECL_RE.finditer(text):
            out[m.group(1)] = rel
        for m in EXPORT_LIST_RE.finditer(text):
            spec = m.group("spec")
            target = self.tree.resolve(rel, spec) if spec and spec.startswith(".") else None
            sub = self.table(target) if target else {}
            for raw in m.group("names").split(","):
                raw = raw.strip()
                if not raw:
                    continue
                raw = re.sub(r"^type\s+", "", raw)
                name, _, alias = raw.partition(" as ")
                name, alias = name.strip(), alias.strip()
                exported = alias or name
                if target:
                    out[exported] = sub.get(name, target)
                else:
                    out[exported] = rel
        for m in EXPORT_STAR_RE.finditer(text):
            target = self.tree.resolve(rel, m.group("spec"))
            if target:
                for k, v in self.table(target).items():
                    out.setdefault(k, v)
        self._busy.discard(rel)
        self._memo[rel] = out
        return out


def platform_counterpart(path: str) -> tuple[str, str] | None:
    """Путь Прагматики -> (пакет, путь внутри пакета платформы), без проверки существования."""
    if path.startswith("core/src/adapters/"):
        return "adapters", "src/" + path[len("core/src/adapters/"):]
    if path.startswith(SRC_ROOT):
        return "core", "src/" + path[len(SRC_ROOT):]
    if path.startswith("core/tests/support/"):
        return "testing", "src/support/" + path[len("core/tests/support/"):]
    return None


def split_clause(clause: str) -> tuple[str | None, list[tuple[str, bool, str | None]], str | None]:
    """Разобрать `Default, { type A, B as C }` или `* as ns`.

    Возвращает (default, [(имя, это_type, псевдоним)], namespace).
    """
    clause = clause.strip()
    default: str | None = None
    ns: str | None = None
    names: list[tuple[str, bool, str | None]] = []
    mns = re.match(r"\*\s+as\s+(\w+)$", clause)
    if mns:
        return None, [], mns.group(1)
    mb = re.search(r"\{(.*)\}", clause, re.S)
    head = clause[: mb.start()] if mb else clause
    head = head.strip().rstrip(",").strip()
    if head:
        default = head
    if mb:
        for raw in mb.group(1).split(","):
            raw = raw.strip()
            if not raw:
                continue
            is_type = raw.startswith("type ")
            raw = re.sub(r"^type\s+", "", raw)
            name, _, alias = raw.partition(" as ")
            names.append((name.strip(), is_type, alias.strip() or None))
    return default, names, ns


class Syncer:
    """Строит черновой проект."""

    def __init__(self, src: Tree, plat_root: Path, out: Path, owned: set[str],
                 tools_dir: Path, renames: dict[str, str] | None = None,
                 seeds: list[str] | None = None) -> None:
        self.owned = owned
        self.seeds = seeds or []
        self.renames = renames or {}
        self.tools_dir = tools_dir
        self.overlays: dict[str, str] = {}
        self.src = src
        self.plat_root = plat_root
        self.out = out
        self.sym = SymbolIndex(src)
        self.plat = Tree(plat_root)
        self.plat.load()
        self.plat_sym = SymbolIndex(self.plat)
        self.copy: set[str] = set()
        self.queue: list[str] = []
        self.gaps: list[tuple[str, str, str, str]] = []
        self.unresolved: list[tuple[str, str, str]] = []
        self.bare: set[str] = set()
        self.platform_used: dict[str, set[str]] = {}
        self._public: dict[str, dict[str, str]] = {}
        self.shims: dict[str, str] = {}

    # --- классификация файлов старого репо ---
    def platform_file(self, path: str) -> str | None:
        """Путь файла в платформе, если у файла Прагматики есть платформенный двойник."""
        cp = platform_counterpart(path)
        if not cp:
            return None
        pkg, rel = cp
        full = f"packages/{pkg}/{rel}"
        return full if full in self.plat.files else None

    def pkg_of(self, plat_path: str) -> str:
        pkg = plat_path.split("/")[1]
        if pkg == "core" and plat_path.startswith("packages/core/src/app/") \
                and not plat_path.startswith("packages/core/src/app/project/"):
            return "@business-ai/core/compose"
        return {"core": "@business-ai/core", "adapters": "@business-ai/adapters",
                "testing": "@business-ai/testing"}[pkg]

    def public_table(self, spec: str) -> dict[str, str]:
        """Что публично отдаёт пакет платформы (по его входному файлу)."""
        if spec not in self._public:
            entry = {
                "@business-ai/core": "packages/core/src/index.ts",
                "@business-ai/core/compose": "packages/core/src/compose.ts",
                "@business-ai/adapters": "packages/adapters/src/index.ts",
                "@business-ai/testing": "packages/testing/src/index.ts",
            }[spec]
            self._public[spec] = self.plat_sym.table(entry)
        return self._public[spec]

    def want(self, path: str) -> None:
        if path not in self.copy:
            self.copy.add(path)
            self.queue.append(path)

    # --- переписывание одного файла ---
    def rewrite(self, rel: str) -> str:
        text = self.src.read(rel)

        def fix_clause(m: re.Match[str]) -> str:
            spec = m.group("spec")
            target = self.src.resolve(rel, spec)
            if target is None:
                self.unresolved.append((rel, spec, "не найден в дереве старого репо"))
                return m.group(0)
            return self.rewrite_import(rel, m, target)

        text = IMPORT_RE.sub(fix_clause, text)
        text = SIDE_IMPORT_RE.sub(lambda m: self._whole(rel, m), text)
        text = DYN_RE.sub(lambda m: self._whole(rel, m), text)
        for m in BARE_RE.finditer(text):
            self.bare.add(m.group(1))
        return text

    def _whole(self, rel: str, m: re.Match[str]) -> str:
        """Импорт без списка имён (побочный, динамический, mock.module)."""
        target = self.src.resolve(rel, m.group("spec"))
        if target is None:
            self.unresolved.append((rel, m.group("spec"), "не найден"))
            return m.group(0)
        dest = self.module_spec(rel, target, symbols=None)
        return f"{m.group('head')}{m.group('q')}{dest}{m.group('q')}"

    def module_spec(self, rel: str, target: str, symbols: list[str] | None) -> str:
        pf = self.platform_file(target)
        if pf and not self._project_owned(target):
            if target.endswith("/index.ts") and self.barrel_has_project(target, set()):
                virt = target[: -len("index.ts")] + "index.shim.ts"
                self.shims[target] = virt
                return self.relative(rel, virt)
            return self.pkg_of(pf)
        self.want(target)
        return self.relative(rel, target)

    def barrel_has_project(self, barrel: str, seen: set[str]) -> bool:
        """В barrel есть проектные файлы или проектные символы платформенных файлов."""
        if barrel in seen:
            return False
        seen.add(barrel)
        text = self.src.read(barrel)
        specs = [m.group("spec") for m in EXPORT_STAR_RE.finditer(text)]
        specs += [m.group("spec") for m in EXPORT_LIST_RE.finditer(text) if m.group("spec")]
        for spec in specs:
            if not spec.startswith("."):
                continue
            leaf = self.src.resolve(barrel, spec)
            if leaf is None:
                continue
            if not self.platform_file(leaf) or self._project_owned(leaf):
                return True
            if self.owned_in_leaf(leaf):
                return True
            if leaf.endswith("/index.ts") and self.barrel_has_project(leaf, seen):
                return True
        return False

    def owned_in_leaf(self, leaf: str) -> list[str]:
        table = self.sym.table(leaf)
        return sorted(n for n in self.owned if table.get(n) == leaf)

    def _project_owned(self, target: str) -> bool:
        return target.startswith(AGENT_SRC_PREFIX) and not self.platform_file(target)

    def relative(self, rel: str, target: str) -> str:
        a = Path(rel).parent.as_posix().split("/")
        b = target.removesuffix(".ts").removesuffix(".tsx")
        b = b.removesuffix("/index")
        bparts = b.split("/")
        i = 0
        while i < len(a) and i < len(bparts) - 1 and a[i] == bparts[i]:
            i += 1
        ups = len(a) - i
        prefix = "../" * ups if ups else "./"
        return prefix + "/".join(bparts[i:])

    def rewrite_import(self, rel: str, m: re.Match[str], target: str) -> str:
        head = m.group("head")
        q = m.group("q")
        clause = m.group("clause")
        kind = m.group("kind") or ""
        is_export = head.lstrip().startswith("export")
        default, names, ns = split_clause(clause)
        # export * from / export { } from
        if clause.strip() == "*" or ns or default or not names:
            dest = self.module_spec(rel, target, None)
            first = f"{head}{q}{dest}{q}"
            if clause.strip() == "*" and is_export and dest.startswith("@") \
                    and self.owned_in_leaf(target):
                extra = self.overlay_for(rel, target)
                return f"{first};\nexport * from {q}{extra}{q}"
            return first
        # Список имён: делим по файлам-определениям.
        table = self.sym.table(target)
        groups: dict[str, list[tuple[str, bool, str | None]]] = {}
        for name, is_type, alias in names:
            leaf = table.get(name)
            if leaf is None:
                self.unresolved.append((rel, name, f"символ не найден в {target}"))
                leaf = target
            dest = self.dest_for_symbol(rel, leaf, name)
            exp, ali = name, alias
            if dest.startswith("@") and name in self.renames:
                exp, ali = self.renames[name], alias or name
            groups.setdefault(dest, []).append((exp, is_type, ali))
        lines: list[str] = []
        kw = "export" if is_export else "import"
        for dest, items in groups.items():
            body = ", ".join(
                (("type " if t and not kind else "") + n + (f" as {a}" if a else ""))
                for n, t, a in items
            )
            lines.append(f"{kw} {kind}{{ {body} }} from {q}{dest}{q}")
        return ";\n".join(lines)

    def dest_for_symbol(self, rel: str, leaf: str, name: str) -> str:
        pf = self.platform_file(leaf)
        if pf and not self._project_owned(leaf):
            if name in self.owned:
                return self.overlay_for(rel, leaf)
            pkg = self.pkg_of(pf)
            new = self.renames.get(name, name)
            if new not in self.public_table(pkg):
                have = self.plat_sym.table(pf)
                why = ("в файле платформы есть, из пакета не экспортируется" if new in have
                       else "символа нет в файле платформы")
                self.gaps.append((name, leaf, pf, why))
            self.platform_used.setdefault(pkg, set()).add(name)
            return pkg
        self.want(leaf)
        return self.relative(rel, leaf)

    def overlay_for(self, rel: str, leaf: str) -> str:
        """Оверлей проектных символов из платформенного по имени файла Прагматики."""
        virt = re.sub(r"\.tsx?$", "", leaf) + ".owned.ts"
        if virt not in self.src.virtual:
            table = self.sym.table(leaf)
            names = sorted(n for n in self.owned if table.get(n) == leaf)
            pf = self.platform_file(leaf) or ""
            payload = {
                "text": self.src.read(leaf),
                "names": names,
                "platformExports": sorted(self.plat_sym.table(pf)) if pf else [],
                "selfSpec": "./" + Path(leaf).stem,
            }
            res = subprocess.run(
                ["bun", "run", str(self.tools_dir / "extract_owned.ts")],
                input=json.dumps(payload), capture_output=True, text=True, check=True,
                cwd=str(self.tools_dir))
            self.src.virtual[virt] = res.stdout
            self.src.files.add(virt)
            self.overlays[virt] = leaf
        self.want(virt)
        return self.relative(rel, virt)

    def seed(self, extra_tests: bool = True) -> None:
        for f in sorted(self.src.files):
            if f.startswith(AGENT_SRC_PREFIX) and not self.platform_file(f):
                if f.endswith("/shared/index.ts") or f == AGENT_SRC_PREFIX + "index.ts":
                    continue  # barrel разбирается по символам
                self.want(f)
            elif f.startswith(AGENT_TEST_PREFIX):
                mirror = AGENT_SRC_PREFIX + f[len(AGENT_TEST_PREFIX):]
                mirror = re.sub(r"\.test\.tsx?$", ".ts", mirror)
                if "/shared/" in f and self.platform_file(mirror):
                    continue  # тест платформенного модуля: он в платформе
                self.want(f)

    def seed_extra(self) -> None:
        """Дополнительные засевы проекта (`tools/sync-seeds.txt`).

        Строка файла - шаблон пути старого репо (`fnmatch`); строка с `!` в начале исключает.
        Файлы, у которых есть платформенный двойник, не копируются: их даёт пакет платформы.
        Всё остальное идёт тем же замыканием, что и агенты.
        """
        include = [p for p in self.seeds if not p.startswith("!")]
        exclude = [p[1:] for p in self.seeds if p.startswith("!")]
        for f in sorted(self.src.files):
            if not any(fnmatch.fnmatchcase(f, pat) for pat in include):
                continue
            if any(fnmatch.fnmatchcase(f, pat) for pat in exclude):
                continue
            if self.platform_file(f) and not self._project_owned(f):
                continue
            self.want(f)

    def run(self) -> None:
        self.seed()
        self.seed_extra()
        done: set[str] = set()
        while self.queue:
            f = self.queue.pop()
            if f in done:
                continue
            done.add(f)
            new = self.rewrite(f)
            dest = self.out / ("src/" + f[len(SRC_ROOT):] if f.startswith(SRC_ROOT)
                               else "tests/" + f[len(TEST_ROOT):])
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(new, encoding="utf-8")
        self.write_shims()

    def write_shims(self) -> None:
        """Barrel для динамических и namespace-импортов: платформа + уже скопированное проектное."""
        for barrel, virt in sorted(self.shims.items()):
            lines = ["// Сгенерировано sync-agents: платформенные имена + проектные файлы."]
            pkg_names: dict[str, list[str]] = {}
            local: dict[str, list[str]] = {}
            for name, leaf in sorted(self.sym.table(barrel).items()):
                pf = self.platform_file(leaf)
                if name in self.owned and pf:
                    ov = leaf.removesuffix(".ts") + ".owned.ts"
                    if ov in self.copy:
                        local.setdefault(self.relative(virt, ov), []).append(name)
                elif pf and not self._project_owned(leaf):
                    pkg = self.pkg_of(pf)
                    new = self.renames.get(name, name)
                    if new in self.public_table(pkg):
                        pkg_names.setdefault(pkg, []).append(
                            name if new == name else f"{new} as {name}")
                elif leaf in self.copy:
                    local.setdefault(self.relative(virt, leaf), []).append(name)
            for spec, names in sorted(pkg_names.items()):
                lines.append(f"export {{ {', '.join(names)} }} from '{spec}';")
            for spec, names in sorted(local.items()):
                lines.append(f"export {{ {', '.join(names)} }} from '{spec}';")
            dest = self.out / ("src/" + virt[len(SRC_ROOT):])
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", type=Path, required=True, help="распакованное дерево старого репо")
    ap.add_argument("--platform", type=Path, required=True, help="worktree business-ai")
    ap.add_argument("--out", type=Path, required=True, help="каталог чернового проекта")
    ap.add_argument("--renames", type=Path, default=None,
                    help="файл переименований: `старое<TAB>новое` (нейтральные имена платформы)")
    ap.add_argument("--seeds", type=Path, default=None,
                    help="файл засевов: шаблоны путей старого репо, `!` - исключение")
    ap.add_argument("--owned", type=Path, default=None,
                    help="файл со списком проектных символов (по одному в строке, # - комментарий)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    src = Tree(args.src)
    src.load()
    if args.out.exists():
        shutil.rmtree(args.out)
    args.out.mkdir(parents=True)
    owned: set[str] = set()
    if args.owned:
        for ln in args.owned.read_text(encoding="utf-8").splitlines():
            ln = ln.split("#", 1)[0].strip()
            if ln:
                owned.add(ln)
    renames: dict[str, str] = {}
    if args.renames:
        for ln in args.renames.read_text(encoding="utf-8").splitlines():
            ln = ln.split("#", 1)[0].strip()
            if ln:
                old, new = ln.split()
                renames[old] = new
    seeds: list[str] = []
    if args.seeds:
        for ln in args.seeds.read_text(encoding="utf-8").splitlines():
            ln = ln.split("#", 1)[0].strip()
            if ln:
                seeds.append(ln)
    sy = Syncer(src, args.platform, args.out, owned, Path(__file__).resolve().parent, renames,
                seeds)
    sy.run()
    with (args.out / "GAPS.tsv").open("w", encoding="utf-8") as fh:
        fh.write("символ\tфайл Прагматики\tфайл платформы\tпричина\n")
        for row in sorted(set(sy.gaps)):
            fh.write("\t".join(row) + "\n")
    with (args.out / "UNRESOLVED.tsv").open("w", encoding="utf-8") as fh:
        fh.write("файл\tспецификатор\tпричина\n")
        for row in sorted(set(sy.unresolved)):
            fh.write("\t".join(row) + "\n")
    (args.out / "BARE-DEPS.txt").write_text("\n".join(sorted(sy.bare)) + "\n", encoding="utf-8")
    LOG.info("оверлеев проектных символов: %d", len(sy.overlays))
    LOG.info("скопировано файлов: %d", len(sy.copy))
    LOG.info("пробелов платформы (символы): %d", len(set(sy.gaps)))
    LOG.info("неразобранных импортов: %d", len(set(sy.unresolved)))


if __name__ == "__main__":
    main()
