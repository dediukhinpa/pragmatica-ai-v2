"""Обратная миграция db/app/rollback/026_down.sql: статические проверки и стенд на PostgreSQL.

Статические проверки идут всегда (без Docker): файл на месте, вне потока раннера, зеркален 026,
идемпотентен, возвращает функции дословно из прежнего репозитория (если его git-объекты есть).
Стенд (tools/prove-rollback-026.sh, фаза db) требует docker, psql и вход этапа 7 (сид), иначе
пропускается; он доказывает на живом PostgreSQL: схема, данные и schema_migrations после
`026_down` равны состоянию до v2, а без отката (красная схема) прежний код ломается.
Прогон прежнего кода (targeted/full/e2e) в pytest не входит: это ручные фазы того же скрипта.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
APP_DIR = REPO / "db" / "app"
DOWN_SQL = APP_DIR / "rollback" / "026_down.sql"
UP_SQL = APP_DIR / "026_knowledge_scope_compat.sql"
RUNNER = REPO / "deploy" / "platform" / "db" / "migrate.sh"
STAND = REPO / "tools" / "prove-rollback-026.sh"

SRC_REPO = Path(os.environ.get("SRC_REPO", str(Path.home() / "pragmatika-purchasing")))
SRC_COMMIT = os.environ.get("SRC_COMMIT", "5ea7f2d308beb476fb8b6fe05e095587c9ee4f40")
OLD_020 = "db/migrations/020_knowledge_fts_query_suppliers_hnsw.sql"
BAI_HOME = Path(os.environ.get("BAI_HOME", str(Path.home() / "reports" / "business-ai-modular")))
SEED_SQL = BAI_HOME / "stage-7" / "synth" / "seed" / "seed-db.sql"

MAX_LINE = 100
# Коды выхода стенда: 2 - ошибка окружения, 3 - нет ресурсов (для pytest это пропуск).
EXIT_ENV = 2
EXIT_RESOURCES = 3
STAND_TIMEOUT_SECONDS = 1500
# Функции, которые 026 пересоздаёт, а откат обязан вернуть в редакцию прежнего репозитория.
RESTORED_FUNCTIONS = ("knowledge_fts_query", "hybrid_search", "hybrid_search_suppliers")


def strip_sql_comments(text: str) -> str:
    """Убирает строки-комментарии `--` (в телах функций они тоже есть)."""
    return "\n".join(
        line for line in text.splitlines() if not line.lstrip().startswith("--")
    )


def function_blocks(text: str) -> dict[str, str]:
    """Возвращает тексты `CREATE OR REPLACE FUNCTION ... $fn$;` по именам функций."""
    blocks: dict[str, str] = {}
    lines = text.split("\n")
    start: int | None = None
    name = ""
    for index, line in enumerate(lines):
        match = re.match(r"CREATE OR REPLACE FUNCTION (\w+)", line)
        if match:
            start, name = index, match.group(1)
        if line == "$fn$;" and start is not None:
            blocks[name] = "\n".join(lines[start : index + 1])
            start = None
    return blocks


def old_repo_020() -> str | None:
    """Текст миграции 020 прежнего репозитория из git-объектов или None, если их нет."""
    if shutil.which("git") is None or not SRC_REPO.is_dir():
        return None
    result = subprocess.run(
        ["git", "-C", str(SRC_REPO), "show", f"{SRC_COMMIT}:{OLD_020}"],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout if result.returncode == 0 else None


class RollbackFileStaticTest(unittest.TestCase):
    """Файл отката: вне потока, зеркален 026, идемпотентен."""

    def setUp(self) -> None:
        self.text = DOWN_SQL.read_text(encoding="utf-8")
        self.code = strip_sql_comments(self.text)

    def test_file_exists_outside_stream(self) -> None:
        """Файл лежит в подкаталоге rollback/, раннер читает только db/app/*.sql."""
        self.assertTrue(DOWN_SQL.is_file())
        self.assertEqual(DOWN_SQL.parent.name, "rollback")
        top_level = {path.name for path in APP_DIR.glob("*.sql")}
        self.assertNotIn("026_down.sql", top_level)
        runner = RUNNER.read_text(encoding="utf-8")
        # Сбор версий потока не рекурсивный: один уровень `*.sql` в каталоге потока.
        self.assertIn('for file in "$dir"/*.sql; do', runner)
        self.assertNotIn("find ", runner.split("collect_stream()", 1)[1].split("}", 1)[0])
        legacy_map = (APP_DIR / "legacy-map.tsv").read_text(encoding="utf-8")
        self.assertNotIn("rollback", legacy_map)
        self.assertNotIn("026_down", legacy_map)

    def test_no_transaction_control(self) -> None:
        """BEGIN/COMMIT не пишутся: транзакцию открывает psql --single-transaction."""
        # `BEGIN` без `;` - начало блока plpgsql, это допустимо.
        self.assertIsNone(
            re.search(r"(?im)^\s*(BEGIN|COMMIT|ROLLBACK|END|START TRANSACTION)\s*;", self.code)
        )

    def test_line_length(self) -> None:
        """Строки не длиннее 100 знаков."""
        for number, line in enumerate(self.text.splitlines(), start=1):
            self.assertLessEqual(len(line), MAX_LINE, f"строка {number}")

    def test_header_explains_why_and_when(self) -> None:
        """Шапка на русском: зачем, когда (rollback.sh, до старта старых контейнеров)."""
        head = " ".join(
            line.removeprefix("--").strip()
            for line in self.text.split("SELECT pg_advisory_xact_lock", 1)[0].splitlines()
        )
        for needle in ("rollback.sh", "ДО старта старых контейнеров", "Зачем", "Когда запускается"):
            self.assertIn(needle, head)

    def test_inverse_of_up_migration(self) -> None:
        """Операторы отката зеркальны операторам 026."""
        self.assertIn("RENAME COLUMN supplier_id TO scope", UP_SQL.read_text(encoding="utf-8"))
        self.assertIn("ALTER TABLE knowledge_chunks RENAME COLUMN scope TO supplier_id", self.code)
        self.assertIn(
            "ALTER INDEX IF EXISTS knowledge_chunks_scope_idx RENAME TO "
            "knowledge_chunks_supplier_idx",
            self.code,
        )
        self.assertRegex(self.code, r"DROP FUNCTION IF EXISTS hybrid_search\(")
        # Платформенный параметр filter_scope в коде отката не остаётся, прежний возвращён.
        self.assertNotIn("filter_scope", self.code)
        self.assertNotIn("c.scope", self.code)
        self.assertIn("filter_supplier text DEFAULT NULL", self.code)
        self.assertIn("c.supplier_id", self.code)

    def test_all_three_functions_restored(self) -> None:
        """026 меняет три функции, откат возвращает все три (в т.ч. hybrid_search_suppliers)."""
        up_blocks = function_blocks(UP_SQL.read_text(encoding="utf-8"))
        down_blocks = function_blocks(self.text)
        for name in RESTORED_FUNCTIONS:
            self.assertIn(name, up_blocks, f"026 не пересоздаёт {name}")
            self.assertIn(name, down_blocks, f"откат не возвращает {name}")
        # knowledge_fts_query нужен hybrid_search_messages (030): не удаляется, а заменяется.
        self.assertNotRegex(self.code, r"DROP FUNCTION[^;]*knowledge_fts_query")
        self.assertIn("LANGUAGE sql IMMUTABLE PARALLEL SAFE", down_blocks["knowledge_fts_query"])

    def test_idempotent_conditions(self) -> None:
        """Шаги схемы идут только при наличии scope и отсутствии supplier_id."""
        self.assertRegex(
            self.code,
            r"IF EXISTS \([^;]*column_name = 'scope'\)\s+AND NOT EXISTS \([^;]*"
            r"column_name = 'supplier_id'\)\s+THEN",
        )
        self.assertIn("to_regclass('schema_migrations') IS NULL", self.code)

    def test_ledger_cleanup_by_prefixes(self) -> None:
        """Из учёта удаляются записи с префиксами потоков и только они."""
        self.assertRegex(
            self.code,
            r"DELETE FROM schema_migrations\s+WHERE version LIKE 'platform/%' "
            r"OR version LIKE 'app/%';",
        )
        # Защита от базы, поднятой раннером v2 с нуля: без прежних записей откат невозможен.
        self.assertIn("RAISE EXCEPTION", self.code)
        # Общая блокировка раннеров и предел ожидания блокировки.
        self.assertIn("pg_advisory_xact_lock(48151623)", self.code)
        self.assertIn("SET LOCAL lock_timeout", self.code)
        self.assertIn("48151623", RUNNER.read_text(encoding="utf-8"))

    def test_functions_verbatim_from_old_repo(self) -> None:
        """Тела трёх функций - дословно из 020 прежнего репозитория (git-объекты FREEZE_SRC)."""
        old = old_repo_020()
        if old is None:
            self.skipTest("нет git-объектов прежнего репозитория")
        old_blocks = function_blocks(old)
        down_blocks = function_blocks(self.text)
        for name in RESTORED_FUNCTIONS:
            self.assertEqual(down_blocks[name], old_blocks[name], name)


def docker_ready() -> bool:
    """Docker и psql доступны, демон отвечает."""
    if shutil.which("docker") is None or shutil.which("psql") is None:
        return False
    probe = subprocess.run(["docker", "info"], capture_output=True, check=False, timeout=60)
    return probe.returncode == 0


@unittest.skipIf(os.environ.get("SKIP_DOCKER_TESTS") == "1", "SKIP_DOCKER_TESTS=1")
class RollbackStandTest(unittest.TestCase):
    """Стенд tools/prove-rollback-026.sh, фаза db: красный без отката, зелёный с ним."""

    def test_stand_db_phase(self) -> None:
        """Схема, данные и учёт после отката равны состоянию до v2; без отката код ломается."""
        if not docker_ready():
            self.skipTest("нет docker/psql")
        if not SEED_SQL.is_file():
            self.skipTest(f"нет синтетического сида: {SEED_SQL}")
        if old_repo_020() is None:
            self.skipTest("нет git-объектов прежнего репозитория")
        with tempfile.TemporaryDirectory(prefix="rb026-") as work:
            env = {**os.environ, "WORK": work}
            result = subprocess.run(
                ["bash", str(STAND), "db"],
                env=env,
                capture_output=True,
                text=True,
                check=False,
                timeout=STAND_TIMEOUT_SECONDS,
            )
            if result.returncode in (EXIT_ENV, EXIT_RESOURCES):
                self.skipTest(f"окружение стенда не готово (rc={result.returncode})")
            self.assertEqual(result.returncode, 0, result.stdout[-3000:] + result.stderr[-1000:])
            snap = Path(work) / "snap"
            red = (snap / "probes-red.txt").read_text(encoding="utf-8")
            green = (snap / "probes-green.txt").read_text(encoding="utf-8")
            control = (snap / "probes-control.txt").read_text(encoding="utf-8")
            # Красная схема (после v2 без отката): запись и чтение supplier_id падают.
            self.assertIn('column "supplier_id"', red)
            self.assertIn("ОШИБКА", red)
            # Зелёная (после отката) неотличима от контрольной (до v2).
            self.assertNotIn("ОШИБКА", green)
            self.assertEqual(control, green)
            self.assertNotIn("FAIL", (Path(work) / "RESULT.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
