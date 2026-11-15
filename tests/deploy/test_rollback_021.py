"""Обратная миграция db/app/rollback/021_down.sql: статические проверки и стенд на PostgreSQL.

Статические проверки идут всегда (без Docker): файл на месте, вне потока раннера, зеркален
платформенной 021 (jobs.daily_at, jobs.time_zone, jobs_daily_schedule_check), снимает серии
часов дня до удаления столбцов, идемпотентен, чистит в учёте только запись 021.
Стенд (tools/prove-rollback.sh, фаза db) требует docker, psql и вход этапа 7 (сид), иначе
пропускается; он доказывает на живом PostgreSQL: после 021_down и 026_down схема, данные и
schema_migrations равны состоянию до v2, серии часов дня снимаются, остальное не трогается,
а прежний код на красной схеме (без отката) закрывает серию как разовую.
Прогон прежнего кода (targeted/probe/full/e2e) в pytest не входит: это ручные фазы скрипта.
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
DOWN_SQL = APP_DIR / "rollback" / "021_down.sql"
UP_SQL = REPO / "deploy" / "platform" / "db" / "platform" / "021_jobs_daily_schedule.sql"
RUNNER = REPO / "deploy" / "platform" / "db" / "migrate.sh"
STREAM_ORDER = APP_DIR / "stream-order.tsv"
STAND = REPO / "tools" / "prove-rollback.sh"

SRC_REPO = Path(os.environ.get("SRC_REPO", str(Path.home() / "pragmatika-purchasing")))
SRC_COMMIT = os.environ.get("SRC_COMMIT", "5ea7f2d308beb476fb8b6fe05e095587c9ee4f40")
BAI_HOME = Path(os.environ.get("BAI_HOME", str(Path.home() / "reports" / "business-ai-modular")))
SEED_SQL = BAI_HOME / "stage-7" / "synth" / "seed" / "seed-db.sql"

MAX_LINE = 100
# Коды выхода стенда: 2 - ошибка окружения, 3 - нет ресурсов (для pytest это пропуск).
EXIT_ENV = 2
EXIT_RESOURCES = 3
STAND_TIMEOUT_SECONDS = 1800
PLATFORM_VERSION = "platform/021_jobs_daily_schedule"
LEGACY_NAME = "021_jobs_daily_schedule"
ADDED_COLUMNS = ("daily_at", "time_zone")
CHECK_NAME = "jobs_daily_schedule_check"
SERIES_DELETE = "DELETE FROM jobs WHERE daily_at IS NOT NULL"


def strip_sql_comments(text: str) -> str:
    """Убирает строки-комментарии `--`."""
    return "\n".join(
        line for line in text.splitlines() if not line.lstrip().startswith("--")
    )


def old_repo_migration_names() -> list[str] | None:
    """Имена миграций прежнего репозитория из git-объектов или None, если их нет."""
    if shutil.which("git") is None or not SRC_REPO.is_dir():
        return None
    result = subprocess.run(
        ["git", "-C", str(SRC_REPO), "ls-tree", "--name-only", SRC_COMMIT, "db/migrations/"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    return [Path(line).stem for line in result.stdout.splitlines() if line.endswith(".sql")]


class RollbackFileStaticTest(unittest.TestCase):
    """Файл отката 021: вне потока, зеркален платформенной 021, идемпотентен."""

    def setUp(self) -> None:
        self.text = DOWN_SQL.read_text(encoding="utf-8")
        self.code = strip_sql_comments(self.text)
        self.up = UP_SQL.read_text(encoding="utf-8")

    def test_file_exists_outside_stream(self) -> None:
        """Файл лежит в подкаталоге rollback/, раннер читает только db/app/*.sql."""
        self.assertTrue(DOWN_SQL.is_file())
        self.assertEqual(DOWN_SQL.parent.name, "rollback")
        top_level = {path.name for path in APP_DIR.glob("*.sql")}
        self.assertNotIn("021_down.sql", top_level)
        runner = RUNNER.read_text(encoding="utf-8")
        self.assertIn('for file in "$dir"/*.sql; do', runner)
        self.assertNotIn("find ", runner.split("collect_stream()", 1)[1].split("}", 1)[0])
        legacy_map = (APP_DIR / "legacy-map.tsv").read_text(encoding="utf-8")
        self.assertNotIn("021_down", legacy_map)

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
        """Шапка на русском: зачем, когда (rollback.sh, до старта старых контейнеров, порядок)."""
        head = " ".join(
            line.removeprefix("--").strip()
            for line in self.text.split("SELECT pg_advisory_xact_lock", 1)[0].splitlines()
        )
        needles = (
            "rollback.sh",
            "ДО старта старых контейнеров",
            "Зачем",
            "Когда запускается",
            "сначала 021_down, затем 026_down",
            "daily_at IS NOT NULL",
        )
        for needle in needles:
            self.assertIn(needle, head)

    def test_inverse_of_up_migration(self) -> None:
        """Операторы отката зеркальны операторам платформенной 021."""
        for column in ADDED_COLUMNS:
            self.assertIn(f"ADD COLUMN IF NOT EXISTS {column} text", self.up)
            self.assertIn(f"DROP COLUMN IF EXISTS {column}", self.code)
        self.assertIn(f"ADD CONSTRAINT {CHECK_NAME}", self.up)
        self.assertIn(f"DROP CONSTRAINT IF EXISTS {CHECK_NAME}", self.code)
        # Таблицы может не быть (откат на пустой базе): IF EXISTS и у самой таблицы.
        self.assertGreaterEqual(self.code.count("ALTER TABLE IF EXISTS jobs"), 3)
        # Откат ничего не создаёт и не меняет строки, кроме удаления серий.
        self.assertNotRegex(self.code, r"(?i)\bADD COLUMN\b|\bCREATE\b|\bUPDATE jobs\b")

    def test_series_removed_before_columns_dropped(self) -> None:
        """Серии часов дня снимаются ДО удаления столбцов; CHECK снимается до столбцов."""
        delete_at = self.code.index(SERIES_DELETE)
        check_at = self.code.index(f"DROP CONSTRAINT IF EXISTS {CHECK_NAME}")
        columns_at = min(self.code.index(f"DROP COLUMN IF EXISTS {c}") for c in ADDED_COLUMNS)
        self.assertLess(delete_at, check_at)
        self.assertLess(check_at, columns_at)
        # Строки без часов дня (разовые, по интервалу) не удаляются: условие только по daily_at.
        self.assertEqual(self.code.count("DELETE FROM jobs"), 1)
        self.assertNotRegex(self.code, r"(?i)TRUNCATE|DELETE FROM jobs;")

    def test_idempotent_conditions(self) -> None:
        """DELETE идёт только при наличии столбца daily_at; число снятых серий сообщается."""
        self.assertRegex(
            self.code,
            r"IF EXISTS \([^;]*table_name = 'jobs' AND column_name = 'daily_at'\)\s+THEN\s+"
            + re.escape(SERIES_DELETE),
        )
        self.assertIn("GET DIAGNOSTICS removed = ROW_COUNT", self.code)
        self.assertIn("снято серий часов дня", self.code)
        self.assertIn("to_regclass('schema_migrations') IS NULL", self.code)

    def test_ledger_cleanup_only_021(self) -> None:
        """Из учёта удаляется запись 021 (с префиксом и прежнего вида) и ничего больше."""
        self.assertEqual(f"platform/{UP_SQL.stem}", PLATFORM_VERSION)
        self.assertRegex(
            self.code,
            r"DELETE FROM schema_migrations\s+WHERE version IN \("
            rf"'{re.escape(PLATFORM_VERSION)}', '{re.escape(LEGACY_NAME)}'\);",
        )
        # Записи 026 снимает 026_down.sql; здесь шаблонов по префиксу в DELETE нет.
        delete = self.code.split("DELETE FROM schema_migrations", 1)[1]
        self.assertNotIn("LIKE", delete.split(";", 1)[0])

    def test_guard_before_any_change(self) -> None:
        """База, поднятая раннером v2 с нуля, останавливает скрипт ДО любых изменений."""
        guard_at = self.code.index("RAISE EXCEPTION")
        self.assertLess(guard_at, self.code.index(SERIES_DELETE))
        self.assertLess(guard_at, self.code.index("DROP COLUMN"))
        self.assertIn("откат невозможен", self.code)
        self.assertRegex(
            self.code,
            r"WHERE version LIKE 'platform/%' OR version LIKE 'app/%'\)\s+AND NOT EXISTS "
            r"\(SELECT 1 FROM schema_migrations\s+WHERE version NOT LIKE 'platform/%' "
            r"AND version NOT LIKE 'app/%'\)",
        )

    def test_lock_matches_runner(self) -> None:
        """Общая блокировка раннеров и предел ожидания блокировки."""
        self.assertIn("pg_advisory_xact_lock(48151623)", self.code)
        self.assertIn("SET LOCAL lock_timeout", self.code)
        self.assertIn("48151623", RUNNER.read_text(encoding="utf-8"))

    def test_up_migration_matches_expectations(self) -> None:
        """Платформенная 021 - та, что откатывает файл: имя и версия в учёте."""
        self.assertEqual(UP_SQL.name, "021_jobs_daily_schedule.sql")
        self.assertIn(SERIES_DELETE, self.up)  # шапка 021 называет тот же DELETE

    def test_stream_order_puts_026_before_021(self) -> None:
        """Порядок потоков: app/026 раньше platform/021; откат идёт в обратном порядке."""
        order = STREAM_ORDER.read_text(encoding="utf-8")
        self.assertIn("app/026_knowledge_scope_compat\tplatform/021", order)

    def test_legacy_name_is_not_an_old_repo_migration(self) -> None:
        """Прежнее имя 021_jobs_daily_schedule не принадлежит миграциям FREEZE_SRC."""
        names = old_repo_migration_names()
        if names is None:
            self.skipTest("нет git-объектов прежнего репозитория")
        self.assertIn("021_metrics_cache_tokens", names)
        self.assertNotIn(LEGACY_NAME, names)


def docker_ready() -> bool:
    """Docker и psql доступны, демон отвечает."""
    if shutil.which("docker") is None or shutil.which("psql") is None:
        return False
    probe = subprocess.run(["docker", "info"], capture_output=True, check=False, timeout=60)
    return probe.returncode == 0


@unittest.skipIf(os.environ.get("SKIP_DOCKER_TESTS") == "1", "SKIP_DOCKER_TESTS=1")
class RollbackStandTest(unittest.TestCase):
    """Стенд tools/prove-rollback.sh, фаза db: красный без отката, зелёный с ним."""

    def test_stand_db_phase(self) -> None:
        """Схема, данные и учёт после обеих down равны состоянию до v2; серии снимаются."""
        if not docker_ready():
            self.skipTest("нет docker/psql")
        if not SEED_SQL.is_file():
            self.skipTest(f"нет синтетического сида: {SEED_SQL}")
        if old_repo_migration_names() is None:
            self.skipTest("нет git-объектов прежнего репозитория")
        with tempfile.TemporaryDirectory(prefix="rb021-") as work:
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
            # Красная схема (после v2 без 021_down): прежний claim/finish закрывает серию.
            self.assertIn("rb021-daily-1|rb021.daily|done|true", red)
            # Зелёная (после обеих down) неотличима от контрольной (до v2), серий нет.
            self.assertNotIn("rb021-daily", green)
            self.assertNotIn("ОШИБКА", green)
            self.assertEqual(control, green)
            self.assertNotIn("FAIL", (Path(work) / "RESULT.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
