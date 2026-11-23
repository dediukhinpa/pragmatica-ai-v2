"""Тесты tools/check_migrations_schema.py (без PostgreSQL)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_migrations_schema as schema  # noqa: E402

DUMP_HEAD = """-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

\\restrict AbCd

SET client_encoding = 'UTF8';

"""


def block(kind: str, name: str, body: str) -> str:
    """Собирает блок объекта в формате pg_dump."""
    return f"--\n-- Name: {name}; Type: {kind}; Schema: public; Owner: -\n--\n\n{body}\n\n"


BASE = DUMP_HEAD + block("TABLE", "t1", "CREATE TABLE t1 (a int);") + block(
    "INDEX", "t1_idx", "CREATE INDEX t1_idx ON t1 (a);"
)


class SchemaCompareTest(unittest.TestCase):
    """Проверки нормализации, разбиения и сравнения."""

    def test_normalize_drops_volatile_lines(self) -> None:
        text = schema.normalize(BASE)
        self.assertNotIn("Dumped", text)
        self.assertNotIn("restrict", text)

    def test_split_blocks_keys(self) -> None:
        keys = set(schema.split_blocks(schema.normalize(BASE)))
        self.assertEqual({schema.PREAMBLE_KEY, "TABLE t1", "INDEX t1_idx"}, keys)

    def test_equal_dumps_have_no_differences(self) -> None:
        other = BASE.replace("\n\n\n", "\n\n").replace("restrict AbCd", "restrict ZzZz")
        self.assertEqual([], schema.compare_texts(schema.normalize(BASE), schema.normalize(other)))

    def test_block_order_does_not_matter(self) -> None:
        swapped = DUMP_HEAD + block("INDEX", "t1_idx", "CREATE INDEX t1_idx ON t1 (a);") + block(
            "TABLE", "t1", "CREATE TABLE t1 (a int);"
        )
        self.assertEqual(
            [], schema.compare_texts(schema.normalize(BASE), schema.normalize(swapped))
        )

    def test_changed_added_removed(self) -> None:
        changed = BASE.replace("a int", "a bigint") + block("VIEW", "v1", "CREATE VIEW v1;")
        changed = changed.replace(block("INDEX", "t1_idx", "CREATE INDEX t1_idx ON t1 (a);"), "")
        result = {
            (item.kind, item.key)
            for item in schema.compare_texts(schema.normalize(BASE), schema.normalize(changed))
        }
        self.assertEqual(
            {("changed", "TABLE t1"), ("only-a", "INDEX t1_idx"), ("only-b", "VIEW v1")}, result
        )

    def test_stats_counts_types(self) -> None:
        counter, digest = schema.stats(schema.normalize(BASE))
        self.assertEqual({"TABLE": 1, "INDEX": 1}, dict(counter))
        self.assertEqual(64, len(digest))

    def test_allowed_file_parsing_and_cli_exit_codes(self) -> None:
        changed = BASE.replace("a int", "a bigint")
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            (tmp / "a.sql").write_text(BASE, encoding="utf-8")
            (tmp / "b.sql").write_text(changed, encoding="utf-8")
            (tmp / "ok.txt").write_text("# c\nTABLE t1\tтип столбца\n", encoding="utf-8")
            (tmp / "extra.txt").write_text("TABLE t1\tx\nTABLE zz\ty\n", encoding="utf-8")
            (tmp / "bad.txt").write_text("TABLE t1\n", encoding="utf-8")
            a, b = str(tmp / "a.sql"), str(tmp / "b.sql")
            self.assertEqual(1, schema.main(["compare", a, b]))
            self.assertEqual(0, schema.main(["compare", a, a]))
            self.assertEqual(0, schema.main(["compare", a, b, "--allowed", str(tmp / "ok.txt")]))
            self.assertEqual(
                1, schema.main(["compare", a, b, "--allowed", str(tmp / "extra.txt")])
            )
            self.assertEqual(
                2, schema.main(["compare", a, b, "--allowed", str(tmp / "bad.txt")])
            )


if __name__ == "__main__":
    unittest.main()
