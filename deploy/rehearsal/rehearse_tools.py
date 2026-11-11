#!/usr/bin/env python3
"""Помощники rehearse.sh: сборка .env репетиции, сверка имён, пики памяти, проверка утечек.

Запуск: `python3 -I rehearse_tools.py <команда> ...`. Ни одна команда не печатает ЗНАЧЕНИЯ
переменных окружения и секретов: только имена, числа и пути. Значения читаются из файлов и
пишутся только в файл `--out` (права 600).

Команды:
  env-build     собрать .env репетиции из боевых .env и secrets.env
  env-names     сверить имена боевого окружения с именами, которые знает compose v2
  mem-peaks     пики памяти контейнеров против лимитов
  leak-scan     найти значения секретов в файлах результата
  summarize     сводка проверок (checks.tsv) в Markdown
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from pathlib import Path

LOG = logging.getLogger("rehearse_tools")

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2
SECRET_FILE_MODE = 0o600
BYTES_IN_MIB = 1024 * 1024
# Имя переменной окружения: заглавные буквы, цифры и подчёркивание.
NAME_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")
# Ссылка на переменную в compose: ${NAME}, ${NAME:-x}, ${NAME:?x}.
COMPOSE_REF_RE = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)")
# Короткие значения (меньше этого числа знаков) в проверке утечек не ищутся: ложные срабатывания.
MIN_SECRET_LENGTH = 8


def parse_value(raw: str) -> str:
    """Разбирает значение строки KEY=VALUE так же, как compose и боевой lib.sh.

    Значение в кавычках берётся без кавычек; у значения без кавычек отрезается хвост
    «  # комментарий» и крайние пробелы.
    """
    raw = raw.lstrip()
    if raw[:1] in ("'", '"') and raw[0] in raw[1:]:
        quote = raw[0]
        return raw[1:].split(quote, 1)[0]
    if raw.startswith("#"):
        return ""
    return re.split(r"\s#", raw, maxsplit=1)[0].strip()


def read_env_file(path: Path) -> dict[str, str]:
    """Читает файл KEY=VALUE без выполнения; последнее вхождение побеждает."""
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if "=" not in line:
            continue
        key, raw = line.split("=", 1)
        key = key.strip()
        if NAME_RE.match(key):
            values[key] = parse_value(raw)
    return values


def compose_known_names(files: list[Path]) -> set[str]:
    """Имена, на которые ссылаются файлы compose и compat.env (`${NAME...}`)."""
    names: set[str] = set()
    for path in files:
        if path.is_file():
            names.update(COMPOSE_REF_RE.findall(path.read_text(encoding="utf-8")))
    return names


def read_patterns(path: Path) -> list[re.Pattern[str]]:
    """Читает файл регулярных выражений (по одному в строке, # - комментарий)."""
    patterns: list[re.Pattern[str]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            patterns.append(re.compile(line))
    return patterns


def single_quote(value: str) -> str | None:
    """Значение в одинарных кавычках (compose не подставляет `$` внутри); None - нельзя."""
    if "'" in value or "\n" in value or "\r" in value:
        return None
    return f"'{value}'"


def cmd_env_build(args: argparse.Namespace) -> int:
    """Собирает .env репетиции: известные compose v2 имена боя минус каналы и секреты."""
    battle = read_env_file(Path(args.battle_env))
    secrets = read_env_file(Path(args.secrets)) if args.secrets else {}
    known = compose_known_names([Path(p) for p in args.compose_files])
    drop = read_patterns(Path(args.drop_file))
    explicit = set(args.take_secret or [])
    merged = {**battle, **secrets}
    kept: dict[str, str] = {}
    dropped: list[str] = []
    skipped_quote: list[str] = []
    for name, value in sorted(merged.items()):
        if name in explicit:
            allowed = True
        else:
            allowed = name in known and not any(p.search(name) for p in drop)
        if not allowed or value == "":
            dropped.append(name)
            continue
        quoted = single_quote(value)
        if quoted is None:
            skipped_quote.append(name)
            continue
        kept[name] = quoted
    missing = sorted(n for n in explicit if n not in merged or merged[n] == "")
    lines = [f"{name}={quoted}" for name, quoted in kept.items()]
    for override in args.override or []:
        name, _, value = override.partition("=")
        quoted = single_quote(value)
        if not NAME_RE.match(name) or quoted is None:
            LOG.error("недопустимая замена: %s", name)
            return EXIT_USAGE
        lines = [ln for ln in lines if not ln.startswith(f"{name}=")]
        lines.append(f"{name}={quoted}")
    out = Path(args.out)
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, SECRET_FILE_MODE)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    report = {
        "battle_names": len(merged),
        "forwarded": sorted(kept),
        "dropped": dropped,
        "not_quotable": skipped_quote,
        "missing_required": missing,
    }
    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n")
    LOG.info(
        "env-build: имён в бою %d, передано %d, отброшено %d, не найдено обязательных %d",
        len(merged), len(kept), len(dropped), len(missing),
    )
    return EXIT_FAIL if missing else EXIT_OK


def cmd_env_names(args: argparse.Namespace) -> int:
    """Имена боя, которых не знает compose v2 (при выкатке они не дойдут до контейнеров)."""
    battle = read_env_file(Path(args.battle_env))
    secrets = read_env_file(Path(args.secrets)) if args.secrets else {}
    names = sorted({*battle, *secrets})
    known = compose_known_names([Path(p) for p in args.compose_files])
    host_only = read_patterns(Path(args.host_only_file)) if args.host_only_file else []
    unknown = [n for n in names if n not in known and not any(p.search(n) for p in host_only)]
    expected: list[str] = []
    if args.expected_names:
        expected = [
            ln.strip()
            for ln in Path(args.expected_names).read_text(encoding="utf-8").splitlines()
            if ln.strip() and not ln.startswith("#")
        ]
    result = {
        "battle_names": len(names),
        "unknown_to_v2": unknown,
        "expected_from_archive": len(expected),
        "not_in_archive": sorted(set(names) - set(expected)) if expected else [],
        "only_in_archive": sorted(set(expected) - set(names)) if expected else [],
    }
    Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n")
    LOG.info("env-names: имён %d, неизвестных compose v2 %d", len(names), len(unknown))
    return EXIT_OK


def parse_size(text: str) -> int:
    """Размер из вывода `docker stats` («196.6MiB», «1.812GiB», «64kB») в байтах."""
    match = re.match(r"^([0-9.]+)\s*([A-Za-z]*)$", text.strip())
    if match is None:
        return 0
    units = {"b": 1, "kb": 1000, "kib": 1024, "mb": 1000**2, "mib": 1024**2,
             "gb": 1000**3, "gib": 1024**3}
    return int(float(match.group(1)) * units.get(match.group(2).lower(), 1))


def cmd_mem_peaks(args: argparse.Namespace) -> int:
    """Пик памяти по контейнерам (образцы + cgroup memory.peak) против лимита."""
    peaks: dict[str, int] = {}
    for line in Path(args.samples).read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) >= 2:
            peaks[parts[0]] = max(peaks.get(parts[0], 0), parse_size(parts[1]))
    cgroup: dict[str, int] = {}
    if args.cgroup:
        for line in Path(args.cgroup).read_text(encoding="utf-8").splitlines():
            name, _, value = line.partition("\t")
            if value.strip().isdigit():
                cgroup[name] = int(value)
    limits: dict[str, int] = {}
    for line in Path(args.limits).read_text(encoding="utf-8").splitlines():
        name, _, value = line.partition("\t")
        if value.strip().isdigit():
            limits[name] = int(value)
    rows = ["контейнер\tпик_МиБ\tлимит_МиБ\tдоля_лимита_%\tисточник"]
    status = EXIT_OK
    for name in sorted(set(peaks) | set(cgroup)):
        peak, source = (cgroup[name], "cgroup") if name in cgroup else (peaks[name], "stats")
        limit = limits.get(name, 0)
        share = round(100 * peak / limit, 1) if limit else 0.0
        rows.append(f"{name}\t{peak // BYTES_IN_MIB}\t{limit // BYTES_IN_MIB}\t{share}\t{source}")
        if limit and peak >= limit:
            status = EXIT_FAIL
    Path(args.out).write_text("\n".join(rows) + "\n", encoding="utf-8")
    return status


def cmd_leak_scan(args: argparse.Namespace) -> int:
    """Ищет значения секретов в файлах каталога; печатает только имена файлов."""
    secrets = [
        ln.rstrip("\n").encode()
        for ln in Path(args.secrets_file).read_text(encoding="utf-8").splitlines()
        if len(ln) >= MIN_SECRET_LENGTH
    ]
    leaked: list[str] = []
    for path in sorted(Path(args.dir).rglob("*")):
        if not path.is_file():
            continue
        data = path.read_bytes()
        if any(secret in data for secret in secrets):
            leaked.append(str(path.relative_to(args.dir)))
    for name in leaked:
        LOG.error("значение секрета найдено в файле результата: %s", name)
    return EXIT_FAIL if leaked else EXIT_OK


def cmd_summarize(args: argparse.Namespace) -> int:
    """Сводка проверок: TSV «имя<TAB>статус<TAB>описание» в Markdown."""
    rows = [ln.split("\t", 2) for ln in Path(args.checks).read_text(encoding="utf-8").splitlines()]
    rows = [r + [""] * (3 - len(r)) for r in rows if r and r[0]]
    counts = {s: sum(1 for r in rows if r[1] == s) for s in ("ok", "warn", "fail")}
    out = [
        "# Итог репетиции",
        "",
        f"Проверок: ok {counts['ok']}, предупреждений {counts['warn']}, "
        f"провалов {counts['fail']}.",
        "",
        "| Проверка | Статус | Подробности |",
        "|---|---|---|",
    ]
    out += [f"| {r[0]} | {r[1]} | {r[2]} |" for r in rows]
    Path(args.out).write_text("\n".join(out) + "\n", encoding="utf-8")
    return EXIT_FAIL if counts["fail"] else EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    """Разбор аргументов командной строки."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("env-build")
    build.add_argument("--battle-env", required=True)
    build.add_argument("--secrets")
    build.add_argument("--compose-files", nargs="+", required=True)
    build.add_argument("--drop-file", required=True)
    build.add_argument("--take-secret", action="append")
    build.add_argument("--override", action="append")
    build.add_argument("--out", required=True)
    build.add_argument("--report", required=True)
    build.set_defaults(func=cmd_env_build)
    names = sub.add_parser("env-names")
    names.add_argument("--battle-env", required=True)
    names.add_argument("--secrets")
    names.add_argument("--compose-files", nargs="+", required=True)
    names.add_argument("--host-only-file")
    names.add_argument("--expected-names")
    names.add_argument("--out", required=True)
    names.set_defaults(func=cmd_env_names)
    peaks = sub.add_parser("mem-peaks")
    peaks.add_argument("--samples", required=True)
    peaks.add_argument("--limits", required=True)
    peaks.add_argument("--cgroup")
    peaks.add_argument("--out", required=True)
    peaks.set_defaults(func=cmd_mem_peaks)
    leak = sub.add_parser("leak-scan")
    leak.add_argument("--dir", required=True)
    leak.add_argument("--secrets-file", required=True)
    leak.set_defaults(func=cmd_leak_scan)
    summary = sub.add_parser("summarize")
    summary.add_argument("--checks", required=True)
    summary.add_argument("--out", required=True)
    summary.set_defaults(func=cmd_summarize)
    return parser


def main(argv: list[str]) -> int:
    """Точка входа."""
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stderr)
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
