#!/usr/bin/env python3
"""Генерация eval и e2e проекта из старого репозитория (коммит SRC, только git-объекты).

Использует движок `sync_agents.py` (разбор импортов по символам, замена на пакеты платформы),
но результат раскладывает по каталогам проекта:

    eval/cases, recordings, reports        -> те же пути (данные без правок)
    eval/prices.example.json               -> eval/tariffs.example.json (имя файла платформы)
    eval/src/environments/*                -> eval/environments/*
    eval/src/synthetic/*                   -> eval/synthetic/*
    eval/src/<файл>.owned.ts (оверлеи)     -> eval/state.ts, eval/constants.ts, ...
    eval/tests/*                           -> tests/eval/*
    e2e/**                                 -> e2e/**

Что берётся, решает файл выбора (`--files`): шаблоны путей старого репо, `!` - исключение.
Проектные символы из файлов, у которых есть двойник в платформе, вырезаются в оверлеи
(`--owned`). Маршруты символов на ручные файлы - ROUTES. Остальное, что нельзя переписать
механически, правят патчи (`tools/overrides-eval/*.patch`) и текстовые правила TEXT_RULES.
Файлы ядра (src/kit, src/agents), которые нужны eval и e2e, порождает sync-agents: здесь они
только проверяются по его манифесту, недостающие попадают в `MISSING-KIT.tsv`.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import logging
import re
import shutil
import sys
from collections import Counter
from pathlib import Path, PurePosixPath

LOG = logging.getLogger("sync_eval_e2e")
HERE = Path(__file__).resolve().parent


def _load(name: str):  # type: ignore[no-untyped-def]
    """Подключить соседний модуль tools/<name>.py (каталог не пакет)."""
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


sync = _load("sync_agents")
reloc = _load("relocate")

# --- Раскладка: старый путь -> путь в v2 ---------------------------------------------------
# Ручные файлы v2, на которые ссылаются маршруты: псевдо-путь старой раскладки -> путь v2.
HAND_WRITTEN: dict[str, str] = {
    "eval/__hand__/index.ts": "eval/index.ts",
    "eval/__hand__/cases.ts": "eval/cases.ts",
    "eval/__hand__/paths.ts": "eval/paths.ts",
    "eval/__hand__/synthetic.ts": "eval/synthetic/index.ts",
    "e2e/__hand__/project-env.ts": "e2e/lib/project-env.ts",
}
# Оверлеи проектных символов из файлов с платформенным двойником.
OVERLAY_PATHS: dict[str, str] = {
    "eval/src/case-schema.owned.ts": "eval/state.ts",
    "eval/src/constants.owned.ts": "eval/constants.ts",
    "eval/src/environments/common.owned.ts": "eval/environments/common.ts",
}
RENAMED_DATA: dict[str, str] = {"eval/prices.example.json": "eval/tariffs.example.json"}
AGENTS_SRC = "core/src/application/agents/"
AGENTS_TESTS = "core/tests/application/agents/"


def new_path(old: str) -> str:
    """Путь файла в раскладке старого репо -> путь в раскладке v2."""
    if old in HAND_WRITTEN:
        return HAND_WRITTEN[old]
    if old in OVERLAY_PATHS:
        return OVERLAY_PATHS[old]
    if old in RENAMED_DATA:
        return RENAMED_DATA[old]
    if old.startswith(AGENTS_SRC):
        return "src/agents/" + old[len(AGENTS_SRC):]
    if old.startswith("core/src/"):
        return "src/kit/" + old[len("core/src/"):]
    if old.startswith(AGENTS_TESTS):
        return "tests/agents/" + old[len(AGENTS_TESTS):]
    if old.startswith("core/tests/"):
        return "tests/kit/" + old[len("core/tests/"):]
    if old.startswith("eval/src/environments/"):
        return "eval/environments/" + old[len("eval/src/environments/"):]
    if old.startswith("eval/src/synthetic/"):
        return "eval/synthetic/" + old[len("eval/src/synthetic/"):]
    if old.startswith("eval/tests/"):
        return "tests/eval/" + old[len("eval/tests/"):]
    return old


def is_core(path: str) -> bool:
    return path.startswith("core/")


# --- Маршруты символов ----------------------------------------------------------------------
# (файл старого репо, символ) -> куда направить импорт: пакет (`@...`) или псевдо-путь ручного
# файла. Маршруты нужны там, где платформенный двойник файла есть, а нужный символ - проектный
# или живёт в другом пакете платформы.
ROUTES: dict[tuple[str, str], list[tuple[str, str | None]]] = {}


def find_route(leaf: str, name: str, importer: str) -> str | None:
    """Маршрут символа для импортирующего файла (учитывается необязательный шаблон файла)."""
    for key in ((leaf, name), (leaf, "*")):
        for dest, glob in ROUTES.get(key, []):
            if glob is None or _glob_match(importer, glob):
                return dest
    return None


def load_routes(path: Path) -> None:
    """Файл маршрутов: `файл<TAB>символ<TAB>назначение`, `#` - комментарий."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        leaf, name, dest, *scope = line.split()
        ROUTES.setdefault((leaf, name), []).append((dest, scope[0] if scope else None))


# --- Текстовые правила после переписывания --------------------------------------------------
# (шаблон пути v2, регулярное выражение, замена, обязательно ли срабатывание)
TEXT_RULES: list[tuple[str, str, str, bool]] = [
    # Окружение платформы не знает `proposal` (метрика выбора менеджера - пробел платформы), а
    # флаг «реплика после завершённого хода» называется иначе.
    (r"eval/environments/*.ts", r"(?m)^ *proposal: async \(\) => null,\n", "", False),
    (r"eval/environments/order-calc.ts", r"(?m)^ *proposal,\n", "", True),
    (r"eval/environments/*.ts", r"\bcontinueAfterCompleted: true",
     "followUpsAfterCompletedTurn: true", False),
    # Скрипты пересъёмки: раннер платформы требует зарегистрированный проект до загрузки кейсов.
    (r"eval/scripts/make-*.ts", r"(?s)\A(/\*\*.*?\*/\n)",
     "\\1import { registerPragmatikaEval } from '../index';\n\n"
     "// Раннер платформы читает схемы кейсов из зарегистрированного проекта.\n"
     "registerPragmatikaEval();\n", True),
    # Пакет zod у проекта один, а не из node_modules старого ядра.
    (r"e2e/**/*.ts", r"'(?:\.\./)+core/node_modules/zod'", "'zod'", False),
    # Служба e2e собирается так же, как `main.ts` платформы: плановые задачи, обработчики чата и
    # жизненный цикл идут из манифеста проекта (иначе нет мониторинга, кнопок и файлов проекта).
    (r"e2e/**/*.ts",
     r"(?ms)\A(?=.*\bcreateService\()(.*?^import [^\n]*from '((?:\.\./lib/)|\./)project-env';\n)",
     "\\1import { projectServiceOptions } from '\\2project-env';\n", False),
    (r"e2e/**/*.ts", r"(?m)^( *)(workerIntervalMs: )",
     "\\1...projectServiceOptions(config),\n\\1\\2", False),
    # Схема v2: столбец привязки фрагментов называется scope (миграция app/026), а версии
    # миграций записаны с потоком (карта старых версий - db/app/legacy-map.tsv).
    (r"e2e/tests/q-supplier-cards.test.ts", r"content, source, supplier_id\) '",
     "content, source, scope) '", True),
    (r"e2e/tests/q-supplier-cards.test.ts", r"version = '018_supplier_cards'",
     "version = 'app/007_supplier_cards'", True),
    # Профиля LABOPS_PII_PROFILE у библиотеки маскирования платформы нет (с ним она не стартует):
    # настройки второго pseudonymizer (с маскированием юрлица) задаются явно, ключ и токен API
    # приходят из окружения прогона.
    (r"e2e/**/*.ts", r"( *)LABOPS_PII_PROFILE: 'pragmatika',\n",
     "\\1PSEUDONYMIZER_STORE: 'sqlite',\n\\1PSEUDONYMIZER_KEY_SCHEME: 'v2',\n"
     "\\1PSEUDONYMIZER_RETENTION_DAYS: '90',\n\\1PSEUDONYMIZER_ADDRESS_MASK: 'on',\n", False),
    # Фикстуры и шаблоны проекта лежат в репозитории проекта, а сервисы и venv - в дереве
    # платформы: E2E_ROOT указывает на платформу, E2E_PROJECT_ROOT - на проект.
    (r"e2e/**/*.ts", r"requireEnv\('E2E_ROOT'\)\}/e2e/fixtures/",
     "requireEnv('E2E_PROJECT_ROOT')}/e2e/fixtures/", False),
    (r"e2e/**/*.ts", r"requireEnv\('E2E_ROOT'\)\}/docs/templates/",
     "requireEnv('E2E_PROJECT_ROOT')}/docs/templates/", False),
    (r"e2e/**/*.ts", r"requireEnv\('E2E_ROOT'\)\}/\$\{SUPPLIER_TEMPLATE_RELATIVE\}",
     "requireEnv('E2E_PROJECT_ROOT')}/${SUPPLIER_TEMPLATE_RELATIVE}", False),
    (r"e2e/**/*.ts", r"\$\{process\.env\['E2E_ROOT'\] \?\? ''\}/\$\{SUPPLIER_TEMPLATE_RELATIVE\}",
     "${process.env['E2E_PROJECT_ROOT'] ?? ''}/${SUPPLIER_TEMPLATE_RELATIVE}", False),
]


def _glob_match(path: str, pattern: str) -> bool:
    """fnmatch, где `**` - любое число каталогов (включая ноль)."""
    regex = re.escape(pattern).replace(r"\*\*/", "(?:.*/)?").replace(r"\*\*", ".*")
    regex = regex.replace(r"\*", "[^/]*").replace(r"\?", "[^/]")
    return re.fullmatch(regex, path) is not None


class EvalSyncer(sync.Syncer):
    """Движок sync-agents с маршрутами на пакеты eval и testing/e2e."""

    EVAL_PKG = "@business-ai/eval"
    E2E_PKG = "@business-ai/testing/e2e"
    # Файлы e2e/lib, у которых в платформе есть однофамилец, но с другим содержанием (другие
    # боты, флаги, методы сотрудника): проект держит свою копию, а не импорт из пакета.
    PROJECT_OWNED = {
        "e2e/lib/bitrix24-world.ts",
        "e2e/lib/employee.ts",
    }
    # Файлы старого eval, у которых в платформе другое имя.
    PLATFORM_ALIAS = {
        "eval/src/model-prices.ts": "packages/eval/src/model-tariffs.ts",
    }

    def __init__(self, *args, kit_files: set[str], **kwargs):  # type: ignore[no-untyped-def]
        super().__init__(*args, **kwargs)
        self.kit_files = kit_files
        self.kit_needed: set[str] = set()
        self.outputs: dict[str, str] = {}
        for pseudo in HAND_WRITTEN:
            self.src.files.add(pseudo)
            self.src.virtual[pseudo] = ""

    # --- двойники в платформе ---
    def platform_file(self, path: str) -> str | None:
        if path in self.PLATFORM_ALIAS:
            return self.PLATFORM_ALIAS[path]
        if path in self.PROJECT_OWNED:
            return None
        if path.startswith("e2e/lib/"):
            cand = "packages/testing/src/e2e/" + path[len("e2e/lib/"):]
            return cand if cand in self.plat.files else None
        if path.startswith("eval/src/"):
            cand = "packages/eval/src/" + path[len("eval/src/"):]
            return cand if cand in self.plat.files else None
        return super().platform_file(path)

    def pkg_of(self, plat_path: str) -> str:
        if plat_path.startswith("packages/eval/"):
            return self.EVAL_PKG
        if plat_path.startswith("packages/testing/src/e2e/"):
            return self.E2E_PKG
        return super().pkg_of(plat_path)

    def public_table(self, spec: str) -> dict[str, str]:
        if spec not in self._public:
            entries = {
                self.EVAL_PKG: "packages/eval/src/index.ts",
                self.E2E_PKG: "packages/testing/src/e2e/index.ts",
            }
            if spec in entries:
                self._public[spec] = self.plat_sym.table(entries[spec])
                return self._public[spec]
        return super().public_table(spec)

    # --- маршруты ---
    def dest_for_symbol(self, rel: str, leaf: str, name: str) -> str:
        route = find_route(leaf, name, rel)
        if route is not None:
            if route.startswith("@"):
                return route
            return self.relative(rel, route)
        return super().dest_for_symbol(rel, leaf, name)

    def module_spec(self, rel: str, target: str, symbols: list[str] | None) -> str:
        route = find_route(target, "*", rel)
        if route is not None:
            return route if route.startswith("@") else self.relative(rel, route)
        return super().module_spec(rel, target, symbols)

    # --- замыкание только по eval/e2e: файлы ядра проверяются, но не переписываются ---
    def run_eval(self, roots: list[str]) -> None:
        for path in roots:
            self.want(path)
        done: set[str] = set()
        while self.queue:
            path = self.queue.pop()
            if path in done:
                continue
            done.add(path)
            if is_core(path):
                self.kit_needed.add(path)
                continue
            if path in HAND_WRITTEN:
                continue
            if not path.endswith((".ts", ".tsx")):
                continue
            self.outputs[path] = self.rewrite(path)


def read_list(path: Path) -> list[str]:
    out: list[str] = []
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                out.append(line)
    return out


def kit_manifest_paths(manifest: Path) -> set[str]:
    """Пути файлов ядра, которые sync-agents уже породил (раскладка v2)."""
    paths: set[str] = set()
    for line in manifest.read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#"):
            paths.add(line.split("\t")[0])
    return paths


def move_manager_choice(data: bytes) -> bytes:
    """Метка выбора менеджера: из корня кейса в `state` (схема кейса платформы строгая).

    В старом eval метку читал раннер (`expectedManagerChoice` в корне кейса). Раннер платформы
    её не знает, а корень кейса проверяет строго, поэтому метка переезжает в состояние агента
    «Поиск поставщика»: данные сохранены, проверку `manager_choice` платформа не считает.
    """
    case = json.loads(data.decode("utf-8"))
    if "expectedManagerChoice" not in case:
        return data
    case["state"]["expectedManagerChoice"] = case.pop("expectedManagerChoice")
    return (json.dumps(case, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def relocate_text(text: str, old: str, files: set[str]) -> tuple[str, int]:
    """Пересчитать относительные спецификаторы файла из старой раскладки в раскладку v2."""
    unresolved = 0

    def fix(m: re.Match[str]) -> str:
        nonlocal unresolved
        spec = m.group("spec")
        target = reloc.resolve(files, old, spec)
        if target is None:
            unresolved += 1
            LOG.warning("не найден: %s -> %s", old, spec)
            return m.group(0)
        new_spec = reloc.relative(new_path(old), new_path(target), spec)
        return f"{m.group('head')}{m.group('q')}{new_spec}{m.group('q')}"

    def fix_path(m: re.Match[str]) -> str:
        spec = m.group("spec")
        target = reloc.norm(str(PurePosixPath(old).parent / spec))
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

    text = reloc.SPEC_RE.sub(fix, text)
    for rx in reloc.PATH_LITERAL_RES:
        text = rx.sub(fix_path, text)
    return reloc.wrap_long_imports(text), unresolved


def cmd_generate(argv: list[str]) -> None:
    ap = argparse.ArgumentParser(prog="generate", description=__doc__)
    ap.add_argument("--src", type=Path, required=True, help="распакованное дерево старого репо")
    ap.add_argument("--platform", type=Path, required=True, help="вид платформы (packages/*)")
    ap.add_argument("--out", type=Path, required=True, help="куда писать дерево v2")
    ap.add_argument("--files", type=Path, required=True, help="файл выбора")
    ap.add_argument("--owned", type=Path, nargs="+", required=True)
    ap.add_argument("--renames", type=Path, required=True)
    ap.add_argument("--routes", type=Path, required=True)
    ap.add_argument("--kit-manifest", type=Path, required=True)
    ap.add_argument("--reports", type=Path, required=True, help="каталог отчётов (tmp/)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    src = sync.Tree(args.src)
    src.load()
    # Данные и прочие файлы, которые нужны выбору, но не .ts.
    all_files = sorted(
        p.relative_to(args.src).as_posix() for p in args.src.rglob("*") if p.is_file()
    )
    patterns = read_list(args.files)
    include = [p for p in patterns if not p.startswith("!")]
    exclude = [p[1:] for p in patterns if p.startswith("!")]
    selected = [
        f for f in all_files
        if any(_glob_match(f, p) for p in include) and not any(_glob_match(f, p) for p in exclude)
    ]
    ts_roots = [f for f in selected if f.endswith((".ts", ".tsx"))]
    data_files = [f for f in selected if not f.endswith((".ts", ".tsx"))]

    owned = {name for path in args.owned for name in read_list(path)}
    renames: dict[str, str] = {}
    for line in read_list(args.renames):
        old, new = line.split()
        renames[old] = new
    load_routes(args.routes)

    if args.out.exists():
        shutil.rmtree(args.out)
    args.out.mkdir(parents=True)

    syncer = EvalSyncer(
        src, args.platform, args.out, owned, HERE, renames, [],
        kit_files=kit_manifest_paths(args.kit_manifest),
    )
    syncer.run_eval(ts_roots)

    files_old = set(src.files) | set(syncer.outputs)
    unresolved = 0
    texts: dict[str, str] = {}
    for old, text in sorted(syncer.outputs.items()):
        # Оверлеи и копии: тот же порядок, что у sync-agents - сначала переписывание импортов.
        new_text, bad = relocate_text(text, old, files_old)
        unresolved += bad
        texts[new_path(old)] = new_text
    for rel in list(texts):
        for glob, regex, repl, required in TEXT_RULES:
            if not _glob_match(rel, glob):
                continue
            texts[rel], count = re.subn(regex, repl, texts[rel])
            if required and count == 0:
                raise SystemExit(f"правило {regex!r} не сработало в {rel}: правила устарели")
    for rel, text in texts.items():
        dest = args.out / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(text, encoding="utf-8")
    for old in data_files:
        dest = args.out / new_path(old)
        dest.parent.mkdir(parents=True, exist_ok=True)
        data = (args.src / old).read_bytes()
        if old.startswith("eval/cases/") and old.endswith(".json"):
            data = move_manager_choice(data)
        dest.write_bytes(data)

    # Файлы ядра, нужные eval и e2e, должны быть порождены sync-agents.
    missing = sorted(
        (old, new_path(old)) for old in syncer.kit_needed
        if new_path(old) not in syncer.kit_files
    )
    args.reports.mkdir(parents=True, exist_ok=True)
    with (args.reports / "sync-eval-e2e-missing-kit.tsv").open("w", encoding="utf-8") as fh:
        fh.write("файл старого репо\tожидаемый путь v2\n")
        for old, new in missing:
            fh.write(f"{old}\t{new}\n")
    with (args.reports / "sync-eval-e2e-gaps.tsv").open("w", encoding="utf-8") as fh:
        fh.write("символ\tфайл Прагматики\tфайл платформы\tпричина\n")
        for row in sorted(set(syncer.gaps)):
            fh.write("\t".join(row) + "\n")
    with (args.reports / "sync-eval-e2e-unresolved.tsv").open("w", encoding="utf-8") as fh:
        fh.write("файл\tспецификатор\tпричина\n")
        for row in sorted(set(syncer.unresolved)):
            fh.write("\t".join(row) + "\n")
    LOG.info("файлов с переписыванием: %d, данных: %d", len(texts), len(data_files))
    LOG.info("пробелов платформы (символы): %d", len(set(syncer.gaps)))
    LOG.info("неразобранных импортов: %d", len(set(syncer.unresolved)) + unresolved)
    LOG.info("не хватает файлов ядра (sync-agents): %d", len(missing))
    # Недостающие файлы ядра и неразобранные импорты не останавливают порождение: отчёты
    # смотрит тот, кто запускает синхронизацию; патчи могли бы их закрыть.


MANIFEST = "tools/sync-eval-e2e-manifest.tsv"
SUMMARY = "tools/last-sync-eval-e2e.md"
REPORT = "tmp/sync-eval-e2e-report.md"
LIST_LIMIT = 200


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _read_manifest(path: Path) -> tuple[str, dict[str, str]]:
    src = ""
    rows: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith("# src="):
                src = line[len("# src="):]
            elif line and not line.startswith("#"):
                name, digest = line.split("\t")
                rows[name] = digest
    return src, rows


def _listing(title: str, names: list[str]) -> list[str]:
    out = [f"### {title}: {len(names)}", ""]
    out += [f"- `{name}`" for name in names[:LIST_LIMIT]]
    if len(names) > LIST_LIMIT:
        out.append(f"- ... ещё {len(names) - LIST_LIMIT}")
    return out + [""]


def cmd_apply(argv: list[str]) -> None:
    """Записать сгенерированное дерево в репозиторий и обновить манифест."""
    ap = argparse.ArgumentParser(prog="apply")
    ap.add_argument("--tree", type=Path, required=True)
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--src", required=True)
    ap.add_argument("--platform", required=True)
    ap.add_argument("--patches", type=int, default=0)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    prev_src, prev = _read_manifest(args.repo / MANIFEST)
    new = {
        p.relative_to(args.tree).as_posix(): _sha256(p)
        for p in sorted(args.tree.rglob("*")) if p.is_file()
    }
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
    # Файл, отсутствующий в репозитории при неизменной сумме (удалён руками), восстанавливается.
    for name in sorted(set(new) - set(added) - set(changed)):
        dest = args.repo / name
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes((args.tree / name).read_bytes())

    lines = [f"# src={args.src}"] + [f"{n}\t{d}" for n, d in sorted(new.items())]
    (args.repo / MANIFEST).write_text("\n".join(lines) + "\n", encoding="utf-8")
    roots = Counter("/".join(n.split("/")[:2]) for n in new)
    summary = [
        "# Последняя синхронизация eval и e2e",
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
        "# Отчёт синхронизации eval и e2e (не коммитится)",
        "",
        f"- Прошлый коммит: `{prev_src or 'нет'}` -> новый `{args.src}`",
        f"- Файлов: было {len(prev)}, стало {len(new)}",
        "",
    ]
    if not (added or removed or changed):
        report.append("Изменений относительно прошлой синхронизации нет.")
    else:
        report += _listing("Добавлено", added)
        report += _listing("Изменено", changed)
        report += _listing("Удалено", removed)
    out = args.repo / REPORT
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(report) + "\n", encoding="utf-8")
    LOG.info("sync-eval-e2e: добавлено %d, изменено %d, удалено %d, всего %d",
             len(added), len(changed), len(removed), len(new))


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in ("generate", "apply"):
        raise SystemExit("использование: sync_eval_e2e.py generate|apply ...")
    {"generate": cmd_generate, "apply": cmd_apply}[sys.argv[1]](sys.argv[2:])


if __name__ == "__main__":
    main()
