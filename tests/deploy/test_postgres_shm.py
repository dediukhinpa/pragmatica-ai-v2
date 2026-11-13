"""Инвариант /dev/shm Postgres: shm_size с запасом над maintenance_work_mem.

Параллельная сборка индекса HNSW кладёт граф в динамическую общую память (/dev/shm контейнера)
размером около maintenance_work_mem. Если shm_size меньше, `CREATE INDEX` падает с «could not
resize shared memory segment ... No space left on device» (попытка 2 G6: shm 256mb против
maintenance_work_mem 512MB). Числа берутся из тех же файлов compose, что использует запуск, и в
тесте не дублируются.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path
from typing import Any

import yaml

from compose_loader import (
    BASE_COMPOSE_FILE,
    PROJECT_COMPOSE_FILE,
    REPO_DIR,
    ComposeYamlLoader,
)

OVERLAY_FILE = REPO_DIR / "deploy" / "rehearsal" / "compose.overlay.yml"
# Запас shm над maintenance_work_mem: то же правило, что в комментарии базы (R3-MEM-2).
SHM_RESERVE_FACTOR = 1.25
# Доля mem_limit, которую занимают shared_buffers и shm вместе; остаток - процессы и кэш.
MAX_SHARED_MEMORY_SHARE = 0.75
BYTES_PER_UNIT = {
    "b": 1,
    "k": 1024,
    "kb": 1024,
    "m": 1024**2,
    "mb": 1024**2,
    "g": 1024**3,
    "gb": 1024**3,
}
SIZE_RE = re.compile(r"^(\d+)\s*([a-z]*)$", re.IGNORECASE)
DEFAULT_RE = re.compile(r"^\$\{[A-Za-z0-9_]+:-([^}]*)\}$")


def parse_size(value: str | int) -> int:
    """Размер в байтах из значения compose или Postgres: `1g`, `512MB`, `1536mb`, `768MB`."""
    match = SIZE_RE.match(str(value).strip())
    if match is None:
        raise ValueError(f"не размер: {value!r}")
    unit = match.group(2).lower() or "b"
    return int(match.group(1)) * BYTES_PER_UNIT[unit]


def resolve_default(value: str | int) -> str | int:
    """`${REHEARSAL_PG_SHM:-1g}` -> `1g`: умолчание, как у запуска без переопределений."""
    match = DEFAULT_RE.match(str(value))
    return match.group(1) if match else value


def load_postgres(path: Path) -> dict[str, Any]:
    """Описание сервиса postgres из файла compose."""
    data = yaml.load(path.read_text(encoding="utf-8"), Loader=ComposeYamlLoader)
    return dict(data["services"]["postgres"])


def server_settings(service: dict[str, Any]) -> dict[str, str]:
    """Пары `ключ=значение` из `-c` в command сервиса, подстановки заменены умолчаниями."""
    command = [str(item) for item in service.get("command", [])]
    settings: dict[str, str] = {}
    for index, item in enumerate(command):
        if item == "-c" and index + 1 < len(command):
            key, _, value = command[index + 1].partition("=")
            settings[key] = str(resolve_default(value))
    return settings


def effective(*services: dict[str, Any]) -> dict[str, Any]:
    """Свёртка слоёв compose: поздний слой заменяет поля раннего (как `include` + override)."""
    merged: dict[str, Any] = {}
    for service in services:
        merged.update(service)
    return merged


def sizes(service: dict[str, Any]) -> dict[str, int]:
    """shm_size, mem_limit, shared_buffers и maintenance_work_mem сервиса, байты."""
    settings = server_settings(service)
    return {
        "shm_size": parse_size(resolve_default(service["shm_size"])),
        "mem_limit": parse_size(resolve_default(service["mem_limit"])),
        "shared_buffers": parse_size(settings["shared_buffers"]),
        "maintenance_work_mem": parse_size(settings["maintenance_work_mem"]),
    }


class PostgresShmInvariantTest(unittest.TestCase):
    """shm_size >= запас x maintenance_work_mem и shared_buffers + shm умещаются в mem_limit."""

    def layers(self) -> dict[str, dict[str, int]]:
        """Размеры по слоям: база, боевой v2 (база + проект), репетиция (overlay с умолчаниями)."""
        base = load_postgres(BASE_COMPOSE_FILE)
        project = load_postgres(PROJECT_COMPOSE_FILE)
        overlay = load_postgres(OVERLAY_FILE)
        return {
            "база": sizes(base),
            "боевой v2": sizes(effective(base, project)),
            "репетиция": sizes(overlay),
        }

    def test_shm_covers_maintenance_work_mem(self) -> None:
        for name, value in self.layers().items():
            with self.subTest(layer=name):
                need = value["maintenance_work_mem"] * SHM_RESERVE_FACTOR
                self.assertGreaterEqual(
                    value["shm_size"],
                    need,
                    f"{name}: shm_size {value['shm_size']} < {SHM_RESERVE_FACTOR} x "
                    f"maintenance_work_mem {value['maintenance_work_mem']} (сборка HNSW упадёт)",
                )

    def test_shared_buffers_and_shm_fit_mem_limit(self) -> None:
        for name, value in self.layers().items():
            with self.subTest(layer=name):
                held = value["shared_buffers"] + value["shm_size"]
                self.assertLessEqual(
                    held,
                    value["mem_limit"] * MAX_SHARED_MEMORY_SHARE,
                    f"{name}: shared_buffers + shm_size = {held} не умещаются в mem_limit "
                    f"{value['mem_limit']}",
                )

    def test_rehearsal_shm_is_overridable_with_safe_default(self) -> None:
        raw = str(load_postgres(OVERLAY_FILE)["shm_size"])
        self.assertIn("REHEARSAL_PG_SHM", raw)
        self.assertEqual(parse_size(resolve_default(raw)), BYTES_PER_UNIT["g"])

    def test_parse_size_units(self) -> None:
        self.assertEqual(parse_size("1g"), 1024**3)
        self.assertEqual(parse_size("512MB"), 512 * 1024**2)
        self.assertEqual(parse_size("1536mb"), 1536 * 1024**2)
        with self.assertRaises(ValueError):
            parse_size("много")

    def test_old_rehearsal_value_is_rejected(self) -> None:
        """Красная проверка самого инварианта: значения попытки 2 (256mb при 512MB) не проходят."""
        old = {"shm_size": parse_size("256mb"), "maintenance_work_mem": parse_size("512MB")}
        self.assertLess(old["shm_size"], old["maintenance_work_mem"] * SHM_RESERVE_FACTOR)


if __name__ == "__main__":
    unittest.main()
