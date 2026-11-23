"""Пути хоста и контейнера: контракт с действующим сервером сохранён."""

from __future__ import annotations

import unittest
from typing import Any

import baseline_data as base
import compose_loader as loader

# Ожидаемые контейнерные пути app (куда смонтированы данные и конфиг).
APP_TARGETS = (
    "/srv/documents",
    "/srv/templates",
    "/var/lib/pragmatika/intake",
    "/var/lib/pragmatika/spool",
    "/var/lib/pragmatika/exchange",
    "/run/sandbox",
    "/etc/pragmatika/access",
    "/etc/pragmatika/mail",
    "/opt/pragmatika/local",
)
# Каталог платформенных ресурсов, которые compose берёт из закреплённой копии.
PLATFORM_DIR = "deploy/platform"


class ComposePathsTest(unittest.TestCase):
    """Пути в compose.project.yml (текст) и в собранной конфигурации."""

    def test_host_paths_in_project_compose(self) -> None:
        """Каждый боевой префикс хоста упомянут в compose.project.yml."""
        text = loader.PROJECT_COMPOSE_FILE.read_text(encoding="utf-8")
        for path in base.HOST_PATHS:
            with self.subTest(path=path):
                self.assertIn(path, text)

    def test_no_agentplatform_host_paths(self) -> None:
        """Платформенные пути /etc/agentplatform и /srv/agentplatform не попадают на хост."""
        text = loader.PROJECT_COMPOSE_FILE.read_text(encoding="utf-8")
        for bad in ("/etc/agentplatform", "/srv/agentplatform", "/opt/agentplatform"):
            with self.subTest(path=bad):
                self.assertNotIn(bad, text)

    def test_app_container_paths(self) -> None:
        """Контейнерные пути app совпадают с боевыми."""
        resolved = loader.resolved_compose()
        if resolved is None:
            self.skipTest("docker compose недоступен: проверка монтирований пропущена")
        volumes: list[dict[str, Any]] = resolved["services"]["app"]["volumes"]
        targets = {item["target"] for item in volumes}
        self.assertEqual(set(APP_TARGETS), targets)

    def test_app_local_mount_readonly(self) -> None:
        """Каталог /opt/pragmatika/local смонтирован только для чтения."""
        resolved = loader.resolved_compose()
        if resolved is None:
            self.skipTest("docker compose недоступен: проверка монтирований пропущена")
        mounts = {item["target"]: item for item in resolved["services"]["app"]["volumes"]}
        self.assertTrue(mounts["/opt/pragmatika/local"].get("read_only"))

    def test_platform_assets_in_pinned_copy(self) -> None:
        """Файлы nginx, alloy и миграций платформы лежат в deploy/platform."""
        for rel in (
            "compose.base.yml",
            "nginx/mtls-proxy.conf.template",
            "alloy/config.alloy",
            "db/migrate.sh",
        ):
            with self.subTest(file=rel):
                self.assertTrue((loader.DEPLOY_DIR / "platform" / rel).is_file(), PLATFORM_DIR)

    def test_migrate_mounts_app_migrations(self) -> None:
        """migrate видит миграции проекта и таблицу соответствия имён."""
        resolved = loader.resolved_compose()
        if resolved is None:
            self.skipTest("docker compose недоступен: проверка монтирований пропущена")
        targets = {item["target"] for item in resolved["services"]["migrate"]["volumes"]}
        self.assertLessEqual({"/db", "/app-migrations", "/app-legacy-map.tsv"}, targets)


if __name__ == "__main__":
    unittest.main()
