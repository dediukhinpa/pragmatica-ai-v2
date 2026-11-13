"""Монтирования overlay репетиции: каждый каталог запуска готовится и получает владельца.

Отказ попытки 3 G6: app не читал ACCESS_POLICY_FILE, потому что копия правил в каталоге запуска
бралась не оттуда, где лежит файл на бою. Тест держит связь «монтирование overlay -> каталог
запуска, который готовит rehearse.sh -> владелец, который ставит rehearse-files.sh», чтобы новое
монтирование не осталось пустым или закрытым для процесса контейнера.
"""

from __future__ import annotations

import unittest
from typing import Any

import yaml

from compose_loader import REPO_DIR, ComposeYamlLoader

REHEARSAL_DIR = REPO_DIR / "deploy" / "rehearsal"
OVERLAY_FILE = REHEARSAL_DIR / "compose.overlay.yml"
REHEARSE_SH = REHEARSAL_DIR / "rehearse.sh"
RUN_DIR_PREFIX = "${REHEARSAL_RUN_DIR:?}/"
# Источник, который берётся не из каталога запуска (файл заглушки шлюза копируется туда же).
STUB_SOURCE = "${REHEARSAL_STUB_FILE:?}"


def overlay_binds() -> list[tuple[str, str, str]]:
    """Bind-монтирования overlay: (сервис, источник, цель в контейнере)."""
    data: dict[str, Any] = yaml.load(  # noqa: S506 - загрузчик на SafeLoader
        OVERLAY_FILE.read_text(encoding="utf-8"), Loader=ComposeYamlLoader
    )
    result: list[tuple[str, str, str]] = []
    for name, service in data["services"].items():
        for volume in service.get("volumes", []) or []:
            if isinstance(volume, dict) and volume.get("type") == "bind":
                result.append((name, str(volume["source"]), str(volume["target"])))
    return result


class RehearsalMountsTest(unittest.TestCase):
    """Каждое bind-монтирование overlay имеет подготовленный каталог и владельца."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.script = REHEARSE_SH.read_text(encoding="utf-8")
        cls.binds = overlay_binds()

    def test_overlay_has_binds(self) -> None:
        """Разбор нашёл монтирования app, pseudonymizer и model-stub."""
        services = {name for name, _, _ in self.binds}
        self.assertTrue({"app", "pseudonymizer", "model-stub"} <= services, services)

    def test_sources_come_from_run_dir(self) -> None:
        """Источник - каталог запуска или файл заглушки: путей боя в overlay нет."""
        for service, source, target in self.binds:
            with self.subTest(service=service, target=target):
                self.assertTrue(
                    source.startswith(RUN_DIR_PREFIX) or source == STUB_SOURCE, source
                )

    def test_every_run_dir_source_is_created_and_owned(self) -> None:
        """Источник из каталога запуска создаётся в prepare_inputs и получает владельца."""
        body = self.script[self.script.index("prepare_inputs() {") :]
        body = body[: body.index("Почта: настоящий файл")]
        own = self.script[self.script.index("own_inputs() {") :]
        own = own[: own.index("prepare_inputs() {")]
        for service, source, target in self.binds:
            if not source.startswith(RUN_DIR_PREFIX):
                continue
            rel = source[len(RUN_DIR_PREFIX) :]
            with self.subTest(service=service, source=rel, target=target):
                self.assertIn(rel.split("/")[-1], body, f"{rel} не создаётся в prepare_inputs")
                self.assertIn(rel, own, f"{rel} не получает владельца в own_inputs")

    def test_stub_file_is_copied_to_run_dir(self) -> None:
        """Файл заглушки шлюза копируется в каталог запуска и читается uid образа."""
        self.assertIn('--override "REHEARSAL_STUB_FILE=$RUN_DIR/stub/model-stub.ts"', self.script)
        self.assertNotIn('REHEARSAL_STUB_FILE=$REH_DIR', self.script)

    def test_host_dirs_come_from_battle_env(self) -> None:
        """Каталоги боя берутся из *_HOST_DIR боевого .env, а не из /etc/pragmatika/access."""
        for name in (
            "ACCESS_POLICY_HOST_DIR",
            "TEMPLATES_HOST_DIR",
            "MAIL_HOST_DIR",
            "DOCUMENTS_HOST_DIR",
            "LOCAL_HOST_DIR",
        ):
            with self.subTest(name=name):
                self.assertIn(name, self.script)
        self.assertNotIn('cp -a "$BATTLE_ETC_DIR/access', self.script)

    def test_pseudonymizer_checks_do_not_use_app(self) -> None:
        """/health псевдонимизатора и маскирование идут не через exec в app."""
        self.assertNotRegex(self.script, r"dc exec -T[^\n]*\bapp\b")


if __name__ == "__main__":
    unittest.main()
