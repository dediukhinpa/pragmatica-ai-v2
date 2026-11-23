"""Сравнение дампов схемы PostgreSQL по объектам (вспомогательный модуль check-migrations.sh).

Дамп `pg_dump --schema-only` режется на блоки по заголовкам вида
`-- Name: <имя>; Type: <тип>; Schema: <схема>; Owner: -`. Ключ объекта - `<ТИП> <имя>`.
Сравнение идёт по тексту блока без пустых строк по краям, поэтому порядок блоков в дампе и
лишние пустые строки расхождением не считаются.

Команды (аргумент `python3 -I tools/check_migrations_schema.py <команда> ...`):
  normalize <вход> <выход>              убрать недетерминированное (версии, токен \\restrict)
  stats <дамп>                          число объектов по типам и sha256 нормализованного текста
  compare <A> <B> [--allowed ФАЙЛ] [--diff-out ФАЙЛ]
                                        различия объектов; с --allowed набор различий обязан
                                        совпасть с файлом (объект<TAB>причина), иначе код 1
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import logging
import re
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

LOG = logging.getLogger("check_migrations_schema")

# Строки дампа, зависящие от версии клиента и случайного токена.
_VOLATILE_RE = re.compile(r"^(-- Dumped (from|by) |\\(un)?restrict )")
# Заголовок блока объекта в дампе.
_HEADER_RE = re.compile(r"^-- Name: (?P<name>.*); Type: (?P<type>[^;]*); Schema: [^;]*; Owner: .*$")
# Ключ вступления дампа (SET-строки до первого объекта).
PREAMBLE_KEY = "PREAMBLE -"

EXIT_OK = 0
EXIT_DIFF = 1
EXIT_USAGE = 2


@dataclass(frozen=True)
class Difference:
    """Одно расхождение между двумя дампами.

    Attributes:
        key: ключ объекта `<ТИП> <имя>`.
        kind: `only-a`, `only-b` или `changed`.
    """

    key: str
    kind: str


def normalize(text: str) -> str:
    """Убирает из дампа версии клиента/сервера и токен `\\restrict`.

    Args:
        text: текст дампа.

    Returns:
        Текст без недетерминированных строк.
    """
    kept = [line for line in text.splitlines() if not _VOLATILE_RE.match(line)]
    return "\n".join(kept) + "\n"


def split_blocks(text: str) -> dict[str, str]:
    """Режет дамп на блоки объектов.

    Args:
        text: нормализованный дамп.

    Returns:
        Словарь `ключ объекта -> текст блока без пустых строк по краям`. Если ключ повторился,
        к нему добавляется суффикс `#2`, `#3`.
    """
    blocks: dict[str, list[str]] = {}
    current = PREAMBLE_KEY
    blocks[current] = []
    lines = text.splitlines()
    for index, line in enumerate(lines):
        match = _HEADER_RE.match(line)
        if match and index > 0 and lines[index - 1] == "--":
            # Строка `--` перед заголовком принадлежит новому блоку, а не предыдущему.
            if blocks[current] and blocks[current][-1] == "--":
                blocks[current].pop()
            key = f"{match.group('type').upper()} {match.group('name')}"
            suffix = 1
            unique = key
            while unique in blocks:
                suffix += 1
                unique = f"{key}#{suffix}"
            current = unique
            blocks[current] = ["--"]
        blocks[current].append(line)
    return {key: "\n".join(body).strip("\n") for key, body in blocks.items()}


def compare_texts(left: str, right: str) -> list[Difference]:
    """Сравнивает два нормализованных дампа по объектам.

    Args:
        left: дамп A.
        right: дамп B.

    Returns:
        Отсортированный список расхождений.
    """
    blocks_a = split_blocks(left)
    blocks_b = split_blocks(right)
    result: list[Difference] = []
    for key in sorted(set(blocks_a) | set(blocks_b)):
        if key not in blocks_b:
            result.append(Difference(key, "only-a"))
        elif key not in blocks_a:
            result.append(Difference(key, "only-b"))
        elif blocks_a[key] != blocks_b[key]:
            result.append(Difference(key, "changed"))
    return result


def render_diff(left: str, right: str, differences: list[Difference]) -> str:
    """Готовит читаемый отчёт о расхождениях (unified diff по каждому блоку).

    Args:
        left: дамп A.
        right: дамп B.
        differences: результат `compare_texts`.

    Returns:
        Текст отчёта.
    """
    blocks_a = split_blocks(left)
    blocks_b = split_blocks(right)
    parts: list[str] = []
    for item in differences:
        parts.append(f"##### {item.kind}: {item.key}")
        diff = difflib.unified_diff(
            blocks_a.get(item.key, "").splitlines(),
            blocks_b.get(item.key, "").splitlines(),
            fromfile="A",
            tofile="B",
            lineterm="",
            n=1,
        )
        parts.extend(diff)
        parts.append("")
    return "\n".join(parts) + "\n"


def stats(text: str) -> tuple[Counter[str], str]:
    """Считает объекты по типам и хэш нормализованного дампа.

    Args:
        text: нормализованный дамп.

    Returns:
        Пара (счётчик типов, sha256 текста).
    """
    counter: Counter[str] = Counter()
    for key in split_blocks(text):
        if key != PREAMBLE_KEY:
            counter[key.split(" ", 1)[0]] += 1
    return counter, hashlib.sha256(text.encode("utf-8")).hexdigest()


def read_allowed(path: Path) -> dict[str, str]:
    """Читает файл допустимых различий: `объект<TAB>причина`, `#` и пустые строки пропускаются.

    Args:
        path: путь к файлу.

    Returns:
        Словарь `ключ объекта -> причина`.

    Raises:
        ValueError: у строки нет причины или ключ повторяется.
    """
    allowed: dict[str, str] = {}
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw.strip() or raw.startswith("#"):
            continue
        key, sep, reason = raw.partition("\t")
        if not sep or not reason.strip():
            raise ValueError(f"{path}:{number}: нужна строка 'объект<TAB>причина'")
        if key in allowed:
            raise ValueError(f"{path}:{number}: объект повторяется: {key}")
        allowed[key] = reason.strip()
    return allowed


def _cmd_normalize(args: argparse.Namespace) -> int:
    Path(args.output).write_text(
        normalize(Path(args.input).read_text(encoding="utf-8")), encoding="utf-8"
    )
    return EXIT_OK


def _cmd_stats(args: argparse.Namespace) -> int:
    counter, digest = stats(normalize(Path(args.dump).read_text(encoding="utf-8")))
    sys.stdout.write(f"sha256 {digest}\n")
    sys.stdout.write(f"объектов {sum(counter.values())}\n")
    for kind, count in sorted(counter.items()):
        sys.stdout.write(f"  {kind}: {count}\n")
    return EXIT_OK


def _cmd_compare(args: argparse.Namespace) -> int:
    left = normalize(Path(args.a).read_text(encoding="utf-8"))
    right = normalize(Path(args.b).read_text(encoding="utf-8"))
    differences = compare_texts(left, right)
    if args.diff_out:
        Path(args.diff_out).write_text(render_diff(left, right, differences), encoding="utf-8")
    actual = {item.key for item in differences}
    for item in differences:
        sys.stdout.write(f"{item.kind}\t{item.key}\n")
    if args.allowed is None:
        sys.stdout.write(f"различий: {len(differences)}\n")
        return EXIT_OK if not differences else EXIT_DIFF
    allowed = read_allowed(Path(args.allowed))
    unexpected = sorted(actual - set(allowed))
    missing = sorted(set(allowed) - actual)
    for key in unexpected:
        sys.stdout.write(f"НЕ РАЗРЕШЕНО\t{key}\n")
    for key in missing:
        sys.stdout.write(f"РАЗРЕШЕНО, НО РАСХОЖДЕНИЯ НЕТ\t{key}\n")
    sys.stdout.write(f"различий: {len(differences)}; разрешено: {len(allowed)}\n")
    return EXIT_OK if not unexpected and not missing else EXIT_DIFF


def main(argv: list[str]) -> int:
    """Точка входа командной строки.

    Args:
        argv: аргументы без имени программы.

    Returns:
        Код выхода.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    norm = sub.add_parser("normalize")
    norm.add_argument("input")
    norm.add_argument("output")
    norm.set_defaults(func=_cmd_normalize)
    st = sub.add_parser("stats")
    st.add_argument("dump")
    st.set_defaults(func=_cmd_stats)
    cmp_ = sub.add_parser("compare")
    cmp_.add_argument("a")
    cmp_.add_argument("b")
    cmp_.add_argument("--allowed")
    cmp_.add_argument("--diff-out")
    cmp_.set_defaults(func=_cmd_compare)
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except (OSError, ValueError) as error:
        LOG.error("%s", error)
        return EXIT_USAGE


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    raise SystemExit(main(sys.argv[1:]))
