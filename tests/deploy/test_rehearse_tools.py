"""Тесты помощников репетиции: deploy/rehearsal/rehearse_tools.py."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
REHEARSAL = REPO / "deploy" / "rehearsal"
TOOLS = REHEARSAL / "rehearse_tools.py"
SECRET_FILE_MODE = 0o600
# Предел подстановки обязательных переменных при сверке с `docker compose config`.
MAX_DUMMY_VARS = 40


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

    def peaks(self, base: Path, samples: str, anon: str = "", events: str = "",
              cgroup: str = "") -> tuple[int, list[str]]:
        """Запуск mem-peaks на лимитах 2 ГиБ у app и db; возвращает код и строки таблицы."""
        gib = 1024**3
        (base / "s.txt").write_text(samples)
        (base / "l.tsv").write_text(f"app\t{gib * 2}\ndb\t{gib * 3}\n")
        (base / "a.tsv").write_text(anon)
        (base / "e.tsv").write_text(events)
        (base / "c.tsv").write_text(cgroup)
        out = base / "o.tsv"
        result = run_tool("mem-peaks", "--samples", str(base / "s.txt"),
                          "--limits", str(base / "l.tsv"), "--cgroup", str(base / "c.tsv"),
                          "--anon", str(base / "a.tsv"), "--events", str(base / "e.tsv"),
                          "--out", str(out))
        return result.returncode, out.read_text().splitlines()

    def test_stats_estimate_without_cgroup(self) -> None:
        """Без memory.stat anon оценивается по docker stats; пик не ниже 90 % лимита - провал."""
        with tempfile.TemporaryDirectory() as tmp:
            code, rows = self.peaks(Path(tmp), "app 100MiB\napp 196.6MiB\ndb 2.9GiB\n")
            self.assertEqual(1, code)
            self.assertTrue(rows[1].startswith("app\t196\t196\t0\t2048\t9.6"), rows[1])
            self.assertIn("stats", rows[1])

    def test_page_cache_at_limit_is_not_a_failure(self) -> None:
        """Попытка 1: memory.peak упёрся в лимит, а anon мал - память в порядке (кэш не OOM)."""
        gib = 1024**3
        mib = 1024**2
        with tempfile.TemporaryDirectory() as tmp:
            code, rows = self.peaks(
                Path(tmp), "db 100MiB\n",
                anon=f"db\t{600 * mib}\t{2 * gib}\ndb\t{500 * mib}\t{gib}\n",
                cgroup=f"db\t{3 * gib}\n",
            )
            self.assertEqual(0, code, rows)
            cols = rows[1].split("\t")
            self.assertEqual(["db", "3072", "600", "2048", "3072", "19.5", "0", "cgroup"], cols)
            self.assertIn("пик_anon_МиБ", rows[0])
            self.assertIn("пик_file_МиБ", rows[0])

    def test_anon_near_limit_fails(self) -> None:
        """anon не ниже 90 % лимита - провал, даже без OOM-убийств."""
        gib = 1024**3
        with tempfile.TemporaryDirectory() as tmp:
            code, _ = self.peaks(Path(tmp), "db 1MiB\n", anon=f"db\t{int(2.8 * gib)}\t0\n")
            self.assertEqual(1, code)

    def test_oom_kill_fails_even_with_low_anon(self) -> None:
        """oom_kill в memory.events или флаг OOMKilled Docker - провал."""
        mib = 1024**2
        with tempfile.TemporaryDirectory() as tmp:
            code, rows = self.peaks(Path(tmp), "db 1MiB\n", anon=f"db\t{100 * mib}\t0\n",
                                    events="db\t1\t0\t0\n")
            self.assertEqual(1, code)
            self.assertTrue(rows[1].split("\t")[6] == "1")
            code, _ = self.peaks(Path(tmp), "db 1MiB\n", anon=f"db\t{100 * mib}\t0\n",
                                 events="db\t0\t1\t2\n")
            self.assertEqual(1, code)

    def test_nothing_measured_fails(self) -> None:
        """Нет ни одного замера - провал («не измерен»), а не тихий успех."""
        with tempfile.TemporaryDirectory() as tmp:
            code, _ = self.peaks(Path(tmp), "")
            self.assertEqual(1, code)

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


SECRET_ROW = "SECRET-ROW-VALUE-9931"


class RestoreLogTest(unittest.TestCase):
    """Диагностика pg_restore в результатах: ошибки есть, данных нет."""

    LOG = "\n".join([
        "pg_restore: error: could not execute query: ERROR:  role \"battle_ro\" does not exist",
        "Command was: GRANT SELECT ON TABLE public.t TO battle_ro;",
        f"pg_restore: error: COPY failed for table \"t\": ERROR:  invalid input syntax for "
        f"type integer: \"{SECRET_ROW}\"",
        f"CONTEXT:  COPY t, line 5: \"{SECRET_ROW}\"",
        f"{SECRET_ROW}\tother-column\t42",
        f"DETAIL:  Failing row contains ({SECRET_ROW}, 1).",
        "Command was: INSERT INTO t VALUES ('" + SECRET_ROW + "');",
        "ERROR:  duplicate key value violates unique constraint \"t_pkey\"",
        "ERROR:  " + "x" * 500,
        "LOG:  checkpoint complete",
        "pg_restore: warning: errors ignored on restore: 2",
    ]) + "\n"

    def convert(self, text: str) -> str:
        """Прогон restore-log и чтение результата."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "in.log").write_text(text)
            result = run_tool("restore-log", "--log", str(base / "in.log"),
                              "--out", str(base / "out.txt"))
            self.assertEqual(0, result.returncode, result.stderr)
            return (base / "out.txt").read_text()

    def test_error_lines_kept_and_data_dropped(self) -> None:
        """ERROR/FATAL/pg_restore: остаются, строки COPY, CONTEXT, DETAIL, INSERT - нет."""
        out = self.convert(self.LOG)
        self.assertIn('role "battle_ro" does not exist', out)
        self.assertIn("Command was: GRANT SELECT ON TABLE public.t TO battle_ro;", out)
        self.assertIn("errors ignored on restore: 2", out)
        self.assertIn('violates unique constraint "t_pkey"', out)
        self.assertNotIn(SECRET_ROW, out)
        self.assertNotIn("other-column", out)
        self.assertNotIn("checkpoint", out)
        self.assertNotIn("INSERT", out)

    def test_value_in_message_is_hidden_and_lines_truncated(self) -> None:
        """Значение в сообщении «invalid input syntax» скрыто; строка не длиннее 300 знаков."""
        out = self.convert(self.LOG)
        self.assertIn("invalid input syntax for type integer: <скрыто>", out)
        lines = out.splitlines()
        self.assertTrue(all(len(ln) <= 300 for ln in lines), max(len(ln) for ln in lines))

    def test_missing_log_gives_empty_report(self) -> None:
        """Нет журнала - файл результата всё равно создаётся, с нулевым счётчиком."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            result = run_tool("restore-log", "--log", str(base / "нет.log"),
                              "--out", str(base / "out.txt"))
            self.assertEqual(0, result.returncode)
            self.assertIn("диагностических: 0", (base / "out.txt").read_text())

    def test_only_last_lines_are_kept(self) -> None:
        """Длинный журнал режется до последних 200 диагностических строк."""
        text = "".join(f"ERROR:  e{i}\n" for i in range(500))
        out = self.convert(text)
        self.assertIn("e499", out)
        self.assertNotIn("e299\n", out)
        self.assertEqual(201, len(out.splitlines()))


class TocSummaryTest(unittest.TestCase):
    """Сводка оглавления дампа: типы и числа, без имён объектов."""

    def test_counts_by_type_without_names(self) -> None:
        """ACL и данные считаются по типам; имён таблиц и ролей в сводке нет."""
        toc = "\n".join([
            ";", "; Archive created at 2026-11-13 10:00:00 UTC", "; Dumped from database "
            "version: 16.4", "; Dumped by pg_dump version: 16.4", "; TOC Entries: 5",
            "1; 1259 100 TABLE public secret_table owner_x",
            "2; 0 100 TABLE DATA public secret_table owner_x",
            "3; 0 0 ACL public TABLE secret_table owner_x",
            "4; 0 0 ACL public TABLE other_table owner_x",
            "5; 2606 7 FK CONSTRAINT public other_table fk_x owner_x",
        ]) + "\n"
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "toc.txt").write_text(toc)
            result = run_tool("toc-summary", "--list-file", str(base / "toc.txt"),
                              "--out", str(base / "out.tsv"))
            self.assertEqual(0, result.returncode, result.stderr)
            out = (base / "out.tsv").read_text()
        self.assertIn("ACL\t2", out)
        self.assertIn("TABLE\t1", out)
        self.assertIn("TABLE DATA\t1", out)
        self.assertIn("FK CONSTRAINT\t1", out)
        self.assertIn("Dumped by pg_dump version: 16.4", out)
        for name in ("secret_table", "other_table", "owner_x"):
            self.assertNotIn(name, out)


class RolesSqlTest(unittest.TestCase):
    """SQL создания ролей боя: NOLOGIN, без паролей, имена экранированы."""

    def make(self, names: list[str]) -> str:
        """Прогон roles-sql."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "n.txt").write_text("\n".join(names) + "\n")
            result = run_tool("roles-sql", "--names-file", str(base / "n.txt"),
                              "--out", str(base / "o.sql"))
            self.assertEqual(0, result.returncode, result.stderr)
            return (base / "o.sql").read_text()

    def test_roles_are_nologin_without_password(self) -> None:
        """Каждая роль: проверка существования, NOLOGIN, ни PASSWORD, ни LOGIN, ни SUPERUSER."""
        sql = self.make(["pragmatika", "battle_ro"])
        self.assertEqual(2, sql.count("CREATE ROLE"))
        self.assertEqual(2, sql.count("NOLOGIN"))
        self.assertIn("NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'battle_ro')", sql)
        for forbidden in ("PASSWORD", " LOGIN;", "SUPERUSER"):
            self.assertNotIn(forbidden, sql)

    def test_system_roles_skipped_and_names_escaped(self) -> None:
        """pg_* пропускаются; кавычки в имени удваиваются, чужой SQL не исполнится."""
        sql = self.make(["pg_monitor", 'we"ird', "o'brien", "x$rehearsal_role$; DROP TABLE t"])
        self.assertNotIn("pg_monitor", sql)
        self.assertIn('CREATE ROLE "we""ird" NOLOGIN', sql)
        self.assertIn("rolname = 'o''brien'", sql)
        self.assertNotIn("DROP TABLE", sql)
        self.assertEqual(2, sql.count("CREATE ROLE"))


class VolumesDiffTest(unittest.TestCase):
    """Тома боя против томов compose v2 со всеми профилями."""

    COMPOSE = (
        "services:\n  app:\n    volumes:\n      - spool:/s\n"
        "  speech:\n    profiles: [speech]\n    volumes:\n      - speech-spool:/t\n"
        "volumes:\n  # комментарий\n  spool:\n  speech-spool:\n  alloy-data:\n"
        "  tmp-socket:\n    driver: local\n    name: explicit_sock\n"
        "x-other:\n  volumes:\n    - not-a-volume\n"
    )

    def diff(self, battle: str) -> subprocess.CompletedProcess[str]:
        """Прогон volumes-diff по тестовому compose."""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "c.yml"
            path.write_text(self.COMPOSE)
            return run_tool("volumes-diff", "--battle", battle, "--compose-files", str(path))

    def test_profile_service_volumes_are_not_lost(self) -> None:
        """Тома профильных сервисов (speech, telemetry) не считаются потерянными."""
        result = self.diff("spool speech-spool alloy-data explicit_sock")
        self.assertEqual(0, result.returncode, result.stdout)
        self.assertEqual("", result.stdout.strip())

    def test_really_lost_volume_fails(self) -> None:
        """Том боя, которого нет в compose, - провал; имя печатается."""
        result = self.diff("spool speech-spool ghost-data")
        self.assertEqual(1, result.returncode)
        self.assertEqual("ghost-data", result.stdout.strip())
        self.assertNotIn("not-a-volume", result.stdout)

    @unittest.skipUnless(shutil.which("docker"), "нет docker")
    def test_static_names_equal_compose_with_all_profiles(self) -> None:
        """Объявленные тома совпадают с `docker compose --profile '*' config --volumes`."""
        base = REPO / "deploy"
        files = [base / "platform" / "compose.base.yml", base / "compose.project.yml"]
        declared = set(
            run_tool("volumes-diff", "--battle", "", "--compose-files",
                     *[str(f) for f in files], "--out", "/dev/stdout").stdout.split()
        )
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / "dummy.env"
            env_file.write_text("")
            output = ""
            for _ in range(MAX_DUMMY_VARS):
                proc = subprocess.run(
                    ["docker", "compose", "-p", "t",
                     "--env-file", str(base / "images.lock.example"),
                     "--env-file", str(base / "compat.env"), "--env-file", str(env_file),
                     "-f", str(base / "compose.yml"), "--profile", "*", "config", "--volumes"],
                    capture_output=True, text=True, check=False,
                )
                missing = re.search(r"variable ([A-Z_0-9]+) is missing", proc.stderr)
                if proc.returncode == 0:
                    output = proc.stdout
                    break
                if missing is None:
                    self.skipTest(f"compose config не собрался: {proc.stderr[:120]}")
                with env_file.open("a") as handle:
                    handle.write(f"{missing.group(1)}=x\n")
            else:
                self.skipTest("слишком много обязательных переменных")
        self.assertTrue({"alloy-data", "speech-spool"} <= declared)
        self.assertEqual(set(output.split()), declared)


class RetiredEnvTest(unittest.TestCase):
    """Снятые переменные боя не считаются потерянными."""

    def test_retired_names_are_listed_not_unknown(self) -> None:
        """Имена из env-retired.txt уходят из unknown_to_v2 в retired_known."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "b.env").write_text(
                "A_ONE=1\nB_TWO=2\nPRICES_UNVERIFIED_SENDER_POLICY=mark\n"
                "SITE_PUBLISH_ENABLED=1\n")
            (base / "c.yml").write_text("${A_ONE}\n")
            out = base / "n.json"
            result = run_tool(
                "env-names", "--battle-env", str(base / "b.env"),
                "--compose-files", str(base / "c.yml"),
                "--retired-file", str(REHEARSAL / "env-retired.txt"), "--out", str(out),
            )
            self.assertEqual(0, result.returncode, result.stderr)
            data = json.loads(out.read_text())
            self.assertEqual(["B_TWO"], data["unknown_to_v2"])
            self.assertEqual(["PRICES_UNVERIFIED_SENDER_POLICY", "SITE_PUBLISH_ENABLED"],
                             data["retired_known"])


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
