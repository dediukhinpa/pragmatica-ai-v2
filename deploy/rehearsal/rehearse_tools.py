#!/usr/bin/env python3
"""Помощники rehearse.sh: сборка .env репетиции, сверка имён, пики памяти, проверка утечек.

Запуск: `python3 -I rehearse_tools.py <команда> ...`. Ни одна команда не печатает ЗНАЧЕНИЯ
переменных окружения и секретов: только имена, числа и пути. Значения читаются из файлов и
пишутся только в файл `--out` (права 600).

Команды:
  env-build     собрать .env репетиции из боевых .env и secrets.env
  env-names     сверить имена боевого окружения с именами, которые знает compose v2
  mem-peaks     пики памяти контейнеров против лимитов (anon+shmem, страничный кэш отдельно)
  restore-log   строки ERROR/FATAL/pg_restore: из журнала pg_restore без данных
  toc-summary   число объектов дампа по типам из `pg_restore -l` (имён объектов нет)
  roles-sql     SQL создания ролей боя (NOLOGIN, без паролей) в Postgres репетиции
  volumes-diff  тома боя против всех томов, объявленных compose v2 (со всеми профилями)
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
# Журнал pg_restore: длина строки и число строк в результатах.
MAX_LOG_LINE = 300
MAX_LOG_LINES = 200
# Строки журнала pg_restore/postgres, нужные для диагноза.
DIAG_LINE_RE = re.compile(r"(\bERROR\b|\bFATAL\b|\bPANIC\b|^pg_restore:|terminated by signal)")
# Сообщения, в которые postgres подставляет значение данных: кавычки в них закрываются.
DATA_VALUE_RE = re.compile(
    r"(invalid input syntax|invalid byte sequence|invalid value|malformed|could not convert|"
    r"Failing row|out of range for type)", re.I
)
QUOTED_RE = re.compile(r"\"[^\"]*\"|'[^']*'|\([^)]*\)")
HIDDEN = "<скрыто>"
# Доля лимита памяти по anon, с которой проверка памяти проваливается.
ANON_FAIL_SHARE = 0.9
# Столбцы образца memory.stat: anon, shmem, file.
MEM_STAT_COLUMNS = 3
# Типы записей оглавления pg_restore -l (длинные раньше коротких).
TOC_TYPES = (
    "TABLE DATA", "SEQUENCE SET", "SEQUENCE OWNED BY", "FK CONSTRAINT", "DEFAULT ACL",
    "MATERIALIZED VIEW DATA", "MATERIALIZED VIEW", "EVENT TRIGGER", "TEXT SEARCH CONFIGURATION",
    "TEXT SEARCH DICTIONARY", "FOREIGN TABLE", "BLOB DATA", "LARGE OBJECT", "CONSTRAINT",
    "ACL", "AGGREGATE", "COMMENT", "DATABASE", "DEFAULT", "DOMAIN", "EXTENSION", "FUNCTION",
    "INDEX", "PROCEDURE", "PUBLICATION", "RULE", "SCHEMA", "SEQUENCE", "STATISTICS",
    "TABLE", "TRIGGER", "TYPE", "VIEW", "OPERATOR", "COLLATION", "CAST", "POLICY",
    "ROW SECURITY", "SECURITY LABEL",
)
ROLE_TAG = "$rehearsal_role$"


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
    retired = read_patterns(Path(args.retired_file)) if args.retired_file else []
    unknown_all = [n for n in names if n not in known and not any(p.search(n) for p in host_only)]
    # Снятые переменные: код проекта их не читает, потеря при выкатке поведение не меняет.
    retired_known = [n for n in unknown_all if any(p.search(n) for p in retired)]
    unknown = [n for n in unknown_all if n not in retired_known]
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
        "retired_known": retired_known,
        "expected_from_archive": len(expected),
        "not_in_archive": sorted(set(names) - set(expected)) if expected else [],
        "only_in_archive": sorted(set(expected) - set(names)) if expected else [],
    }
    Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n")
    LOG.info("env-names: имён %d, неизвестных compose v2 %d, снятых известных %d",
             len(names), len(unknown), len(retired_known))
    return EXIT_OK


def parse_size(text: str) -> int:
    """Размер из вывода `docker stats` («196.6MiB», «1.812GiB», «64kB») в байтах."""
    match = re.match(r"^([0-9.]+)\s*([A-Za-z]*)$", text.strip())
    if match is None:
        return 0
    units = {"b": 1, "kb": 1000, "kib": 1024, "mb": 1000**2, "mib": 1024**2,
             "gb": 1000**3, "gib": 1024**3}
    return int(float(match.group(1)) * units.get(match.group(2).lower(), 1))


def read_tsv_ints(path: str | None, columns: int) -> dict[str, list[int]]:
    """Читает TSV «имя<TAB>число...»; для имени берёт максимум по каждому столбцу."""
    result: dict[str, list[int]] = {}
    if not path or not Path(path).is_file():
        return result
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        parts = line.split("\t")
        if len(parts) < columns + 1 or not all(x.strip().isdigit() for x in parts[1:columns + 1]):
            continue
        values = [int(x) for x in parts[1:columns + 1]]
        old = result.get(parts[0], [0] * columns)
        result[parts[0]] = [max(a, b) for a, b in zip(old, values)]
    return result


def read_memory_stat_samples(path: str | None) -> dict[str, list[int]]:
    """Образцы memory.stat «имя<TAB>anon<TAB>shmem<TAB>file»: для имени
    [пик anon, пик shmem, пик file, пик anon+shmem в одном образце]."""
    result: dict[str, list[int]] = {}
    if not path or not Path(path).is_file():
        return result
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        parts = line.split("\t")
        if len(parts) < MEM_STAT_COLUMNS + 1 or not all(
            x.strip().isdigit() for x in parts[1:MEM_STAT_COLUMNS + 1]
        ):
            continue
        anon, shmem, cache = (int(x) for x in parts[1:MEM_STAT_COLUMNS + 1])
        old = result.get(parts[0], [0, 0, 0, 0])
        result[parts[0]] = [max(old[0], anon), max(old[1], shmem), max(old[2], cache),
                            max(old[3], anon + shmem)]
    return result


def cmd_mem_peaks(args: argparse.Namespace) -> int:
    """Пики памяти контейнеров против лимита.

    Проверка идёт по памяти, которую ядро не вытеснит: anon (память процессов) плюс shmem
    (общая память, у Postgres это shared_buffers; в cgroup v2 она не входит в anon). Страничный
    кэш (file) ядро вытесняет само, а memory.peak его включает и сам по себе OOM не означает,
    поэтому в таблице он отдельным столбцом и в проверке не участвует. Провал: невытесняемая
    память не ниже ANON_FAIL_SHARE лимита или было OOM-убийство.
    """
    stats: dict[str, int] = {}
    for line in Path(args.samples).read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) >= 2:
            stats[parts[0]] = max(stats.get(parts[0], 0), parse_size(parts[1]))
    cgroup = read_tsv_ints(args.cgroup, 1)
    stat = read_memory_stat_samples(args.anon)
    events = read_tsv_ints(args.events, 3)  # oom_kill, OOMKilled, RestartCount
    limits = read_tsv_ints(args.limits, 1)
    rows = ["контейнер\tпик_всего_МиБ\tпик_anon_МиБ\tпик_shmem_МиБ\tпик_file_МиБ"
            "\tпик_anon+shmem_МиБ\tлимит_МиБ\tдоля_anon+shmem_%\toom_kill\tисточник"]
    status = EXIT_OK
    for name in sorted(set(stats) | set(cgroup) | set(stat)):
        total = cgroup[name][0] if name in cgroup else stats.get(name, 0)
        if name in stat:
            anon, shmem, cache, held = stat[name]
            source = "cgroup"
        else:  # без memory.stat: «docker stats» (без неактивного кэша) как оценка
            anon, shmem, cache, held = stats.get(name, 0), 0, 0, stats.get(name, 0)
            source = "stats"
        limit = limits.get(name, [0])[0]
        share = round(100 * held / limit, 1) if limit else 0.0
        oom = events.get(name, [0, 0, 0])
        oom_total = oom[0] + oom[1]
        mib = [x // BYTES_IN_MIB for x in (total, anon, shmem, cache, held, limit)]
        rows.append("\t".join(str(x) for x in (name, *mib, share, oom_total, source)))
        if (limit and held >= ANON_FAIL_SHARE * limit) or oom_total:
            status = EXIT_FAIL
    if len(rows) == 1:  # ничего не измерено
        status = EXIT_FAIL
    Path(args.out).write_text("\n".join(rows) + "\n", encoding="utf-8")
    return status


def scrub_diag_line(line: str) -> str | None:
    """Строка журнала для диагноза или None. Строки данных COPY (с табуляцией) не берутся;
    в сообщениях, куда postgres подставляет значение, кавычки и скобки скрываются."""
    line = line.rstrip("\r\n")
    if "\t" in line:
        return None
    is_command = line.startswith("Command was:") and not line.startswith("Command was: INSERT")
    if not (DIAG_LINE_RE.search(line) or is_command):
        return None
    found = DATA_VALUE_RE.search(line)
    if found:  # имена до сообщения (таблица, роль) остаются, значение после него скрывается
        line = line[:found.start()] + QUOTED_RE.sub(HIDDEN, line[found.start():])
    return line[:MAX_LOG_LINE]


def cmd_restore_log(args: argparse.Namespace) -> int:
    """Диагностические строки журнала (pg_restore или postgres) без данных."""
    path = Path(args.log)
    text = path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""
    lines = text.splitlines()
    picked = [x for x in (scrub_diag_line(ln) for ln in lines) if x is not None]
    out = [f"# строк в журнале: {len(lines)}, диагностических: {len(picked)}"
           f" (показано последних {min(len(picked), MAX_LOG_LINES)})"]
    out += picked[-MAX_LOG_LINES:]
    Path(args.out).write_text("\n".join(out) + "\n", encoding="utf-8")
    return EXIT_OK


def cmd_toc_summary(args: argparse.Namespace) -> int:
    """Число объектов дампа по типам из `pg_restore -l`: имён объектов в выводе нет."""
    counts: dict[str, int] = {}
    versions: list[str] = []
    entry = re.compile(r"^\d+; \d+ \d+ (.*)$")
    for line in Path(args.list_file).read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith(";"):
            if re.match(r"^; (Dumped (from|by)|TOC Entries)", line):
                versions.append(line[:MAX_LOG_LINE])
            continue
        match = entry.match(line)
        if match is None:
            continue
        rest = match.group(1)
        kind = next((t for t in TOC_TYPES if rest == t or rest.startswith(t + " ")), "OTHER")
        counts[kind] = counts.get(kind, 0) + 1
    out = [f"# {v.lstrip('; ')}" for v in versions] + ["тип\tчисло"]
    out += [f"{k}\t{counts[k]}" for k in sorted(counts)]
    Path(args.out).write_text("\n".join(out) + "\n", encoding="utf-8")
    return EXIT_OK


def cmd_roles_sql(args: argparse.Namespace) -> int:
    """SQL создания ролей боя (NOLOGIN, без паролей и без членства), существующие пропускаются."""
    stmts: list[str] = []
    skipped = 0
    for raw in Path(args.names_file).read_text(encoding="utf-8").splitlines():
        name = raw.strip("\r\n")
        if not name or name.startswith("pg_") or ROLE_TAG in name or "\x00" in name:
            skipped += bool(name)
            continue
        ident = '"' + name.replace('"', '""') + '"'
        literal = "'" + name.replace("'", "''") + "'"
        stmts.append(
            f"DO {ROLE_TAG} BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = {literal})"
            f" THEN CREATE ROLE {ident} NOLOGIN; END IF; END {ROLE_TAG};"
        )
    Path(args.out).write_text("\n".join(stmts) + ("\n" if stmts else ""), encoding="utf-8")
    LOG.info("roles-sql: ролей %d, пропущено %d", len(stmts), skipped)
    return EXIT_OK


def compose_volume_names(files: list[Path]) -> set[str]:
    """Тома, объявленные в compose-файлах верхним ключом `volumes:` (профили не важны:
    объявление не зависит от того, какие сервисы запущены). Явное `name:` тома тоже учитывается."""
    names: set[str] = set()
    for path in files:
        if not path.is_file():
            continue
        in_block = False
        for raw in path.read_text(encoding="utf-8").splitlines():
            if re.match(r"^volumes:\s*(#.*)?$", raw):
                in_block = True
                continue
            if not in_block:
                continue
            if raw and not raw[0].isspace() and not raw.startswith("#"):
                in_block = False
                continue
            top = re.match(r"^  ([A-Za-z0-9_][A-Za-z0-9_.-]*):", raw)
            explicit = re.match(r"^    name:\s*(\S+)", raw)
            if top:
                names.add(top.group(1))
            elif explicit:
                names.add(explicit.group(1).strip("'\""))
    return names


def cmd_volumes_diff(args: argparse.Namespace) -> int:
    """Тома боя, которых нет среди томов compose v2 (всех, со всеми профилями)."""
    declared = compose_volume_names([Path(p) for p in args.compose_files])
    battle = [n for n in args.battle.split() if n]
    missing = sorted(n for n in battle if n not in declared)
    if args.out:
        Path(args.out).write_text("\n".join(sorted(declared)) + "\n", encoding="utf-8")
    print(" ".join(missing))
    return EXIT_FAIL if missing else EXIT_OK


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
    names.add_argument("--retired-file")
    names.add_argument("--out", required=True)
    names.set_defaults(func=cmd_env_names)
    peaks = sub.add_parser("mem-peaks")
    peaks.add_argument("--samples", required=True)
    peaks.add_argument("--limits", required=True)
    peaks.add_argument("--cgroup")
    peaks.add_argument("--anon")
    peaks.add_argument("--events")
    peaks.add_argument("--out", required=True)
    peaks.set_defaults(func=cmd_mem_peaks)
    rlog = sub.add_parser("restore-log")
    rlog.add_argument("--log", required=True)
    rlog.add_argument("--out", required=True)
    rlog.set_defaults(func=cmd_restore_log)
    toc = sub.add_parser("toc-summary")
    toc.add_argument("--list-file", required=True)
    toc.add_argument("--out", required=True)
    toc.set_defaults(func=cmd_toc_summary)
    roles = sub.add_parser("roles-sql")
    roles.add_argument("--names-file", required=True)
    roles.add_argument("--out", required=True)
    roles.set_defaults(func=cmd_roles_sql)
    vols = sub.add_parser("volumes-diff")
    vols.add_argument("--battle", required=True)
    vols.add_argument("--compose-files", nargs="+", required=True)
    vols.add_argument("--out")
    vols.set_defaults(func=cmd_volumes_diff)
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
