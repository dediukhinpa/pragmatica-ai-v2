"""Закреплённая копия платформы в deploy/platform: контрольные суммы и версия."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import unittest
from pathlib import Path

import compose_loader as loader

PLATFORM_DIR = loader.DEPLOY_DIR / "platform"
VERSION_FILE = PLATFORM_DIR / "PLATFORM-VERSION"
PACKAGE_JSON = loader.REPO_DIR / "package.json"
SHA_LINE_RE = re.compile(r"^sha256 ([0-9a-f]{64})  (\S+)$")
PACKAGE_SCOPE = "@business-ai/"
# Предел времени git-запроса, секунд.
GIT_TIMEOUT_SECONDS = 60


def parse_version_file() -> tuple[dict[str, str], dict[str, str]]:
    """Возвращает пары KEY=значение и словарь путь -> sha256 из PLATFORM-VERSION."""
    pairs: dict[str, str] = {}
    sums: dict[str, str] = {}
    for line in VERSION_FILE.read_text(encoding="utf-8").splitlines():
        sha = SHA_LINE_RE.match(line)
        if sha:
            sums[sha.group(2)] = sha.group(1)
        elif "=" in line and not line.startswith("#"):
            key, value = line.split("=", 1)
            pairs[key] = value
    return pairs, sums


def file_sha256(path: Path) -> str:
    """Контрольная сумма файла."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


class PlatformPinTest(unittest.TestCase):
    """Копия платформы не отличается от закреплённой."""

    def test_checksums_match(self) -> None:
        """Каждый файл копии совпадает с суммой из PLATFORM-VERSION, лишних файлов нет."""
        _, sums = parse_version_file()
        self.assertTrue(sums, "в PLATFORM-VERSION нет строк sha256")
        actual = {
            str(p.relative_to(PLATFORM_DIR)): file_sha256(p)
            for p in PLATFORM_DIR.rglob("*")
            if p.is_file() and p != VERSION_FILE and "__pycache__" not in p.parts
        }
        self.assertEqual(sums, actual)

    def test_version_matches_package_json(self) -> None:
        """Версия платформы равна пину всех пакетов @business-ai/* в package.json."""
        pairs, _ = parse_version_file()
        package = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
        deps: dict[str, str] = {
            **package.get("dependencies", {}),
            **package.get("devDependencies", {}),
        }
        pinned = {v for k, v in deps.items() if k.startswith(PACKAGE_SCOPE)}
        self.assertEqual({pairs["PLATFORM_PACKAGES_VERSION"]}, pinned)

    def test_commit_is_full_sha(self) -> None:
        """Коммит платформы записан полным хэшем, а короткая версия — его префикс."""
        pairs, _ = parse_version_file()
        commit = pairs["PLATFORM_COMMIT"]
        self.assertRegex(commit, r"^[0-9a-f]{40}$")
        self.assertTrue(pairs["PLATFORM_PACKAGES_VERSION"].endswith(commit[:8]))

    def test_matches_git_when_available(self) -> None:
        """Если задан BAI_REPO_DIR, файлы копии равны содержимому коммита платформы."""
        repo = os.environ.get("BAI_REPO_DIR")
        if not repo:
            self.skipTest("BAI_REPO_DIR не задан: сверка с репозиторием платформы пропущена")
        pairs, sums = parse_version_file()
        for rel, expected in sums.items():
            with self.subTest(file=rel):
                source = self._source_path(rel)
                result = subprocess.run(
                    ["git", "-C", repo, "show", f"{pairs['PLATFORM_COMMIT']}:{source}"],
                    capture_output=True,
                    timeout=GIT_TIMEOUT_SECONDS,
                    check=False,
                )
                self.assertEqual(0, result.returncode)
                self.assertEqual(expected, hashlib.sha256(result.stdout).hexdigest())

    @staticmethod
    def _source_path(rel: str) -> str:
        """Путь файла в репозитории платформы по пути внутри deploy/platform."""
        if rel == "compose.base.yml":
            return "deploy/compose.base.yml"
        if rel.startswith(("nginx/", "alloy/")):
            return f"deploy/{rel}"
        return rel  # db/migrate.sh и db/platform/*


if __name__ == "__main__":
    unittest.main()
