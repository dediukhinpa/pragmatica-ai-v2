"""Миграции проекта едут в образе `app`: Dockerfile, .dockerignore, порядок потоков."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

import compose_loader as loader

DOCKER_DIR = loader.DEPLOY_DIR / "docker"
DOCKERFILE = DOCKER_DIR / "project-app.Dockerfile"
DOCKERIGNORE = DOCKER_DIR / "project-app.Dockerfile.dockerignore"
MIGRATIONS_DIR = loader.REPO_DIR / "db" / "app"
STREAM_ORDER = MIGRATIONS_DIR / "stream-order.tsv"
# Путь миграций проекта в образе: его читает `bai update` (BAI_APP_MIGRATIONS_IMAGE_PATH).
IMAGE_MIGRATIONS_PATH = "/app/project/db/app"
# Строка stream-order: проектная миграция, TAB, платформенная.
ORDER_LINE_RE = re.compile(r"^(app/\S+)\t(platform/\S+)$")


class AppImageMigrationsTest(unittest.TestCase):
    """Образ `app` несёт миграции и порядок потоков."""

    def test_dockerfile_copies_migrations(self) -> None:
        """Dockerfile копирует db/app в каталог, который читает bai update."""
        lines = [
            line.strip()
            for line in DOCKERFILE.read_text(encoding="utf-8").splitlines()
            if not line.lstrip().startswith("#")
        ]
        self.assertIn(f"COPY db/app {IMAGE_MIGRATIONS_PATH}", lines)

    def test_dockerignore_lets_migrations_in(self) -> None:
        """Контекст сборки пропускает db/app (иначе COPY упадёт или будет пустым)."""
        rules = DOCKERIGNORE.read_text(encoding="utf-8").splitlines()
        for rule in ("!db/", "!db/app/", "!db/app/**"):
            self.assertIn(rule, rules)

    def test_stream_order_lines_resolve(self) -> None:
        """Левая часть stream-order - существующая миграция проекта; строка ровно одна."""
        pairs = []
        for line in STREAM_ORDER.read_text(encoding="utf-8").splitlines():
            if not line.strip() or line.startswith("#"):
                continue
            match = ORDER_LINE_RE.match(line)
            self.assertIsNotNone(match, f"плохая строка: {line!r}")
            assert match is not None
            pairs.append((match.group(1), match.group(2)))
        self.assertEqual(
            [("app/026_knowledge_scope_compat", "platform/021")], pairs
        )
        name = pairs[0][0].removeprefix("app/")
        self.assertTrue(Path(MIGRATIONS_DIR / f"{name}.sql").is_file())


if __name__ == "__main__":
    unittest.main()
