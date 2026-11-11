"""Тесты помощников репетиции: deploy/rehearsal/rehearse_tools.py."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
REHEARSAL = REPO / "deploy" / "rehearsal"
TOOLS = REHEARSAL / "rehearse_tools.py"
SECRET_FILE_MODE = 0o600


def run_tool(*args: str) -> subprocess.CompletedProcess[str]:
    """Запускает rehearse_tools.py в изолированном режиме."""
    return subprocess.run(
        [sys.executable, "-I", str(TOOLS), *args], capture_output=True, text=True, check=False
    )


class EnvBuildTest(unittest.TestCase):
    """Сборка .env репетиции: каналы и секреты не переносятся, значения не печатаются."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        (self.dir / "battle.env").write_text(
            "\n".join(
                [
                    "PRICES_MODEL=model-a",
                    "OWN_COMPANY_NAMES='Тест Ко'  # комментарий",
                    "BITRIX24_WEBHOOK_URL=https://secret.example.test/hook",
                    "MAIL_MAILBOXES_FILE=/etc/pragmatika/mail/mailboxes.json",
                    "MAIL_TAG_SALT_PREFIX=pragmatika",
                    "LITELLM_API_KEY=zzz-secret-litellm",
                    "BACKUP_AGE_RECIPIENT=age1public",
                    "UNKNOWN_TO_COMPOSE=1",
                    "DOCUMENTS_HOST_DIR=/srv/pragmatika/documents",
                    "WITH_QUOTE=it's",
                    "WITH_DOLLAR=a$b",
                    "EMPTY_ONE=",
                ]
            )
            + "\n"
        )
        (self.dir / "secrets.env").write_text("PSEUDONYMIZER_KEY=key-value-123456\n")
        (self.dir / "compose.yml").write_text(
            "x: ${PRICES_MODEL:?} ${OWN_COMPANY_NAMES} ${BITRIX24_WEBHOOK_URL:-}\n"
            "y: ${MAIL_MAILBOXES_FILE:-} ${MAIL_TAG_SALT_PREFIX:-p} ${LITELLM_API_KEY}\n"
            "z: ${DOCUMENTS_HOST_DIR:-/x} ${WITH_QUOTE:-} ${WITH_DOLLAR:-} ${EMPTY_ONE:-}\n"
            "w: ${PSEUDONYMIZER_KEY:?}\n"
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def build(self, *extra: str) -> subprocess.CompletedProcess[str]:
        """Запуск env-build с типовыми аргументами."""
        return run_tool(
            "env-build", "--battle-env", str(self.dir / "battle.env"),
            "--secrets", str(self.dir / "secrets.env"),
            "--compose-files", str(self.dir / "compose.yml"),
            "--drop-file", str(REHEARSAL / "env-drop.txt"),
            "--take-secret", "PSEUDONYMIZER_KEY",
            "--out", str(self.dir / "out.env"), "--report", str(self.dir / "report.json"),
            *extra,
        )

    def test_channels_and_secrets_are_dropped(self) -> None:
        """BITRIX24_*, MAIL_* (кроме префикса соли), *_KEY, пути хоста не переносятся."""
        result = self.build()
        self.assertEqual(0, result.returncode, result.stderr)
        report = json.loads((self.dir / "report.json").read_text())
        self.assertEqual(
            ["MAIL_TAG_SALT_PREFIX", "OWN_COMPANY_NAMES", "PRICES_MODEL", "PSEUDONYMIZER_KEY",
             "WITH_DOLLAR"],
            report["forwarded"],
        )
        for gone in ("BITRIX24_WEBHOOK_URL", "MAIL_MAILBOXES_FILE", "LITELLM_API_KEY",
                     "DOCUMENTS_HOST_DIR", "UNKNOWN_TO_COMPOSE"):
            self.assertNotIn(gone, report["forwarded"])

    def test_values_are_single_quoted_and_file_is_private(self) -> None:
        """Значения в одинарных кавычках (compose не подставляет $), права 600."""
        self.build()
        out = self.dir / "out.env"
        self.assertEqual(SECRET_FILE_MODE, out.stat().st_mode & 0o777)
        text = out.read_text()
        self.assertIn("OWN_COMPANY_NAMES='Тест Ко'", text)
        self.assertIn("PRICES_MODEL='model-a'", text)
        self.assertIn("WITH_DOLLAR='a$b'", text)

    def test_unquotable_value_is_reported_not_written(self) -> None:
        """Значение с апострофом не записывается, а попадает в отчёт."""
        self.build()
        report = json.loads((self.dir / "report.json").read_text())
        self.assertIn("WITH_QUOTE", report["not_quotable"])
        self.assertNotIn("WITH_QUOTE", (self.dir / "out.env").read_text())

    def test_override_wins_and_missing_secret_fails(self) -> None:
        """Явная замена перекрывает перенесённое; нет обязательного секрета - код 1."""
        self.build("--override", "PRICES_MODEL=stub-model")
        text = (self.dir / "out.env").read_text()
        self.assertEqual(1, text.count("PRICES_MODEL="))
        self.assertIn("PRICES_MODEL='stub-model'", text)
        (self.dir / "secrets.env").write_text("")
        self.assertEqual(1, self.build().returncode)

    def test_no_values_in_stdout_or_stderr(self) -> None:
        """Ни значения секрета, ни адрес канала не попадают в вывод команды."""
        result = self.build()
        combined = result.stdout + result.stderr
        for value in ("key-value-123456", "secret.example.test", "zzz-secret-litellm"):
            self.assertNotIn(value, combined)


class EnvNamesTest(unittest.TestCase):
    """Сверка имён боя с compose v2."""

    def test_unknown_names_and_host_only(self) -> None:
        """Имена вне compose v2 перечислены, кроме задуманных для скриптов хоста."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "b.env").write_text("A_ONE=1\nB_TWO=2\nBACKUP_X=3\nDATA_DIR=/d\n")
            (base / "c.yml").write_text("${A_ONE}\n")
            out = base / "n.json"
            result = run_tool(
                "env-names", "--battle-env", str(base / "b.env"),
                "--compose-files", str(base / "c.yml"),
                "--host-only-file", str(REHEARSAL / "env-host-only.txt"), "--out", str(out),
            )
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertEqual(["B_TWO"], json.loads(out.read_text())["unknown_to_v2"])


class MemAndLeakTest(unittest.TestCase):
    """Пики памяти и проверка утечек."""

    def test_peaks_against_limits(self) -> None:
        """Пик из образцов сравнивается с лимитом; пик не меньше лимита - провал."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "s.txt").write_text("app 100MiB\napp 196.6MiB\ndb 2GiB\n")
            (base / "l.tsv").write_text(f"app\t{1024**3 * 2}\ndb\t{1024**3 * 2}\n")
            out = base / "o.tsv"
            result = run_tool("mem-peaks", "--samples", str(base / "s.txt"),
                              "--limits", str(base / "l.tsv"), "--out", str(out))
            self.assertEqual(1, result.returncode)
            rows = out.read_text().splitlines()
            self.assertTrue(rows[1].startswith("app\t196\t2048\t9.6"))

    def test_leak_scan_finds_value_and_ignores_short(self) -> None:
        """Найденное значение секрета - провал; короткие строки не ищутся."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "res").mkdir()
            (base / "res" / "log.txt").write_text("шаг ok, ключ abcdefgh12345 лишний\n")
            (base / "sec.txt").write_text("abcdefgh12345\nshort\n")
            args = ("leak-scan", "--dir", str(base / "res"),
                    "--secrets-file", str(base / "sec.txt"))
            self.assertEqual(1, run_tool(*args).returncode)
            (base / "res" / "log.txt").write_text("шаг ok short\n")
            self.assertEqual(0, run_tool(*args).returncode)


class SummarizeTest(unittest.TestCase):
    """Сводка проверок."""

    def test_summary_counts_and_exit(self) -> None:
        """Провал даёт код 1, сводка содержит числа."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "c.tsv").write_text("a\tok\tвсё\nb\tfail\tплохо\nc\twarn\tсмотри\n")
            result = run_tool("summarize", "--checks", str(base / "c.tsv"),
                              "--out", str(base / "s.md"))
            self.assertEqual(1, result.returncode)
            self.assertIn("ok 1, предупреждений 1, провалов 1", (base / "s.md").read_text())


if __name__ == "__main__":
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    unittest.main()
