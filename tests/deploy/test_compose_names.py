"""Имена, лимиты памяти, профили и сети compose v2 равны боевому эталону."""

from __future__ import annotations

import os
import unittest
from pathlib import Path
from typing import Any

import baseline_data as base
import compose_loader as loader

# Множители единиц памяти compose.
MEM_UNITS = {"b": 1, "k": 1024, "m": 1024**2, "g": 1024**3}
SKIP_NO_DOCKER = "docker compose недоступен: подробная проверка пропущена"


def mem_to_bytes(value: str) -> int:
    """Переводит запись вида `4312m`, `4g` или число байт в байты."""
    text = value.strip().lower()
    if text[-1] in MEM_UNITS and not text[-1].isdigit():
        return int(text[:-1]) * MEM_UNITS[text[-1]]
    return int(text)


def service_facts(service: dict[str, Any]) -> tuple[int | None, set[str], set[str]]:
    """Возвращает лимит памяти в байтах, профили и сети сервиса."""
    raw = service.get("mem_limit")
    limit = int(raw) if raw is not None else None
    return limit, set(service.get("profiles") or []), set((service.get("networks") or {}).keys())


class ComposeNamesTest(unittest.TestCase):
    """Имена верхнего уровня (работает и без Docker)."""

    def test_service_volume_network_names(self) -> None:
        """Сервисы, тома и сети совпадают с эталоном."""
        names = loader.top_level_names()
        self.assertEqual(set(base.SERVICES), names["services"])
        self.assertEqual(set(base.VOLUMES), names["volumes"])
        self.assertEqual(set(base.NETWORKS), names["networks"])

    def test_prod_volumes_are_subset(self) -> None:
        """Тома из снимка боя входят в список томов проекта."""
        self.assertLessEqual(set(base.PROD_VOLUMES_SNAPSHOT), set(base.VOLUMES))


class ComposeResolvedTest(unittest.TestCase):
    """Проверки собранной конфигурации (нужен `docker compose config`)."""

    resolved: dict[str, Any]

    @classmethod
    def setUpClass(cls) -> None:
        resolved = loader.resolved_compose()
        if resolved is None:
            raise unittest.SkipTest(SKIP_NO_DOCKER)
        cls.resolved = resolved

    def test_project_name(self) -> None:
        """Имя проекта задаёт префикс томов и сетей боя."""
        self.assertEqual(base.PROJECT_NAME, self.resolved["name"])
        for key in ("volumes", "networks"):
            for name, item in self.resolved[key].items():
                self.assertEqual(f"{base.PROJECT_NAME}_{name}", item.get("name"), name)

    def test_services_facts(self) -> None:
        """Лимит памяти, профили и сети каждого сервиса равны эталону."""
        for name, facts in base.SERVICES.items():
            with self.subTest(service=name):
                limit, profiles, networks = service_facts(self.resolved["services"][name])
                expected = None if facts.mem_limit == "-" else mem_to_bytes(facts.mem_limit)
                self.assertEqual(expected, limit)
                self.assertEqual(set(facts.profiles), profiles)
                self.assertEqual(set(facts.networks), networks)

    def test_networks_internal(self) -> None:
        """Признак internal сетей равен эталону."""
        for name, internal in base.NETWORKS.items():
            with self.subTest(network=name):
                self.assertEqual(internal, bool(self.resolved["networks"][name].get("internal")))


class ExternalBaselineTest(unittest.TestCase):
    """Сверка встроенного эталона с файлами stage-0 (если заданы BASELINE_DIR или PROD_DIR)."""

    def test_services_tsv_matches_builtin(self) -> None:
        """Список сервисов блока deploy в services.tsv равен встроенному."""
        directory = os.environ.get("BASELINE_DIR")
        if not directory:
            self.skipTest("BASELINE_DIR не задан: сверка с внешним эталоном пропущена")
        path = Path(directory) / "config" / "services.tsv"
        if not path.is_file():
            self.skipTest(f"нет файла {path.name} в BASELINE_DIR")
        text = path.read_text(encoding="utf-8")
        missing = [name for name in base.SERVICES if name not in text]
        self.assertEqual([], missing)

    def test_prod_env_names_match(self) -> None:
        """Список имён переменных боя равен env_names.txt (если PROD_DIR задан)."""
        directory = os.environ.get("PROD_DIR")
        if not directory:
            self.skipTest("PROD_DIR не задан: сверка с env_names.txt пропущена")
        path = Path(directory) / "env_names.txt"
        if not path.is_file():
            self.skipTest("нет env_names.txt в PROD_DIR")
        names = {line.strip() for line in path.read_text(encoding="utf-8").splitlines()}
        names.discard("")
        self.assertEqual(names, set(base.PROD_ENV_NAMES))


if __name__ == "__main__":
    unittest.main()
