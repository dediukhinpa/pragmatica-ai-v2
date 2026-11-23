"""Репетиция G6 на платформе 1.1.3: сервис mask в базовом стеке, но в репетиции не запускается.

С 1.1.3 `mask` входит в базу без профиля: `BAI_IMAGE_MASK` (из images.lock) и `MASK_TOKEN`
обязательны (`:?`), без них не проходит даже `docker compose config`. Репетиция идёт в «лёгком»
режиме (postgres, pseudonymizer, model-stub, app), поэтому тест держит три связи:

* пакет сам задаёт то, чего требует compose: образ mask берётся из lock, `MASK_TOKEN` -
  случайный одноразовый секрет репетиции (боевой токен снимается по `_TOKEN$`);
* mask не стартует, не тянется (`docker pull`) и не входит в зависимости app: бюджет памяти
  лёгкого режима прежний;
* `compose config` проекта репетиции проходит с lock пакета и не проходит без mask или токена.

Проверки `docker compose config` пропускаются, если Docker Compose недоступен; демон не нужен.
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any

from compose_loader import (
    COMPOSE_TIMEOUT_SECONDS,
    PLACEHOLDER,
    REPO_DIR,
    docker_compose_available,
)

REHEARSAL_DIR = REPO_DIR / "deploy" / "rehearsal"
REHEARSE_SH = REHEARSAL_DIR / "rehearse.sh"
BUILD_SH = REPO_DIR / "tools" / "build-rehearsal-package.sh"
COMPOSE_FILE = REHEARSAL_DIR / "compose.yml"
DROP_FILE = REHEARSAL_DIR / "env-drop.txt"
# Сервисы лёгкого режима: только они создаются и запускаются репетицией.
LIGHT_SERVICES = {"postgres", "pseudonymizer", "model-stub", "app", "migrate"}
# Образы, которые репетиция проверяет и при отсутствии тянет (docker pull).
PULLED_IMAGE_KEYS = ("BAI_IMAGE_POSTGRES", "BAI_IMAGE_PSEUDONYMIZER", "BAI_IMAGE_APP")
MASK_IMAGE_KEY = "BAI_IMAGE_MASK"
MASK_TOKEN_NAME = "MASK_TOKEN"
# Заглушки образов в lock для проверки compose config (digest не настоящий).
LOCK_LINES = {
    "BAI_VERSION": "1.1.3",
    "BAI_IMAGE_POSTGRES": "registry.example/pg@sha256:" + "a" * 64,
    "BAI_IMAGE_PSEUDONYMIZER": "registry.example/ps@sha256:" + "b" * 64,
    "BAI_IMAGE_APP": "registry.example/app@sha256:" + "c" * 64,
    "BAI_IMAGE_MASK": "registry.example/mask@sha256:" + "d" * 64,
}
# Остальные образы базы: заглушки, чтобы config не падал на чужих `:?`.
OTHER_IMAGE_KEYS = (
    "BAI_IMAGE_DOCUMENTS",
    "BAI_IMAGE_EMBEDDINGS",
    "BAI_IMAGE_INDEXER",
    "BAI_IMAGE_GATEWAY_MTLS",
    "BAI_IMAGE_MIGRATE",
)


def run_compose_config(
    lock: dict[str, str], env: dict[str, str]
) -> subprocess.CompletedProcess[str]:
    """Запускает `docker compose config --format json` для compose репетиции.

    Args:
        lock: Строки временного images.lock (имя -> значение).
        env: Строки временного rehearsal.env (имя -> значение).

    Returns:
        Результат процесса; код возврата и вывод разбирает вызывающий.
    """
    with tempfile.TemporaryDirectory(prefix="pragmatika-rehearse-mask-") as tmp:
        tmp_dir = Path(tmp)
        lock_file = tmp_dir / "images.lock"
        env_file = tmp_dir / "rehearsal.env"
        lock_file.write_text("".join(f"{k}={v}\n" for k, v in lock.items()), encoding="utf-8")
        env_file.write_text("".join(f"{k}={v}\n" for k, v in env.items()), encoding="utf-8")
        command = [
            "docker", "compose", "-p", "pragmatika-rehearsal",
            "--env-file", str(lock_file), "--env-file", str(env_file),
            "-f", str(COMPOSE_FILE), "config", "--format", "json",
        ]
        return subprocess.run(
            command, capture_output=True, text=True, check=False,
            timeout=COMPOSE_TIMEOUT_SECONDS, cwd=REPO_DIR / "deploy",
        )


def rehearsal_env(with_mask_token: bool) -> dict[str, str]:
    """Окружение репетиции для config: обязательные имена получают заглушки."""
    from compose_loader import required_vars  # noqa: PLC0415 - нужен только здесь

    skip = {MASK_IMAGE_KEY, MASK_TOKEN_NAME} | set(LOCK_LINES)
    env = {name: PLACEHOLDER for name in sorted(required_vars()) if name not in skip}
    env["REHEARSAL_RUN_DIR"] = "/tmp/rehearsal-run"
    env["REHEARSAL_STUB_FILE"] = "/tmp/rehearsal-run/stub/model-stub.ts"
    for key in OTHER_IMAGE_KEYS:
        env.setdefault(key, f"registry.example/{key.lower()}@sha256:" + "e" * 64)
    if with_mask_token:
        env[MASK_TOKEN_NAME] = "rehearsal-one-time-token"
    return env


def full_lock() -> dict[str, str]:
    """Lock пакета 1.1.3: четыре образа лёгкого режима и mask, плюс заглушки остальных."""
    lock = dict(LOCK_LINES)
    for key in OTHER_IMAGE_KEYS:
        lock.setdefault(key, f"registry.example/{key.lower()}@sha256:" + "e" * 64)
    return lock


class RehearsalScriptMaskTest(unittest.TestCase):
    """Статические связи rehearse.sh и сборщика пакета с mask 1.1.3."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.script = REHEARSE_SH.read_text(encoding="utf-8")
        cls.build = BUILD_SH.read_text(encoding="utf-8")

    def test_mask_token_is_generated_and_overridden(self) -> None:
        """MASK_TOKEN задаётся замещением env-build: боевой токен снят по `_TOKEN$`."""
        self.assertRegex(self.script, r'--override "MASK_TOKEN=\$\w+"')

    def test_mask_token_is_registered_as_secret(self) -> None:
        """Значение токена попадает в список секретов (сканер утечек архива результатов)."""
        match = re.search(r'--override "MASK_TOKEN=\$(\w+)"', self.script)
        self.assertIsNotNone(match)
        assert match is not None  # для проверки типов
        listing = re.search(r"printf '[^']*' ([^>]*)>>\"\$SECRETS_LIST\"", self.script)
        self.assertIsNotNone(listing)
        assert listing is not None
        self.assertIn(f'"${match.group(1)}"', listing.group(1))

    def test_token_is_not_printed(self) -> None:
        """Токен не выводится: ни echo, ни log, ни check со значением (кроме списка секретов)."""
        joined = self.script.replace("\\\n", " ")
        for line in joined.splitlines():
            stripped = line.strip()
            if stripped.startswith("#") or "SECRETS_LIST" in stripped:
                continue
            if re.search(r"\b(echo|log|check|printf)\b.*\$\{?mask_token", stripped):
                self.fail(f"токен mask в выводе: {stripped}")

    def test_preflight_requires_mask_image_in_lock(self) -> None:
        """Предусловие отказывает, если в lock нет BAI_IMAGE_MASK (compose не соберётся)."""
        self.assertRegex(self.script, r'lock_value BAI_IMAGE_MASK\)" \]\] \\\n\s*\|\| refuse')

    def test_mask_image_is_not_pulled(self) -> None:
        """Список проверяемых и тянущихся образов - три образа лёгкого режима, без mask."""
        loop = re.search(r"for key in (BAI_IMAGE_\w+(?: BAI_IMAGE_\w+)*); do", self.script)
        self.assertIsNotNone(loop)
        assert loop is not None
        self.assertEqual(tuple(loop.group(1).split()), PULLED_IMAGE_KEYS)

    def test_script_starts_only_light_services(self) -> None:
        """Все `dc up` и `dc run` называют только сервисы лёгкого режима; mask - никогда."""
        code = "\n".join(
            ln for ln in self.script.splitlines() if not ln.lstrip().startswith("#")
        )
        pattern = r"dc (?:--profile \w+ )?up -d ([a-z -]+?)(?: >>|\)|$)"
        for match in re.finditer(pattern, code, re.M):
            for service in match.group(1).split():
                self.assertIn(service, LIGHT_SERVICES, match.group(0))
        self.assertNotRegex(code, r"dc [^\n]*\bmask\b")
        self.assertNotRegex(code, r"--profile \*|COMPOSE_PROFILES")

    def test_memory_threshold_does_not_count_mask(self) -> None:
        """Порог памяти лёгкого режима прежний: mask (1536m) в него не входит."""
        match = re.search(r"^DEFAULT_MIN_AVAILABLE_MIB=(\d+)", self.script, re.M)
        self.assertIsNotNone(match)
        assert match is not None
        self.assertEqual(int(match.group(1)), 4096)
        self.assertRegex(self.script, r"mask[^\n]*(не запуска|не входит)")

    def test_builder_requires_mask_in_lock(self) -> None:
        """Сборщик пакета отказывает на lock без BAI_IMAGE_MASK."""
        self.assertIn("BAI_IMAGE_MASK", self.build)

    def test_overlay_app_does_not_wait_for_mask(self) -> None:
        """В overlay app ждёт только postgres, pseudonymizer и model-stub."""
        text = (REHEARSAL_DIR / "compose.overlay.yml").read_text(encoding="utf-8")
        code = "\n".join(ln for ln in text.splitlines() if not ln.lstrip().startswith("#"))
        self.assertNotIn("mask", code)

    def test_drop_list_strips_battle_tokens(self) -> None:
        """Боевой MASK_TOKEN снимается списком снятых имён (замещение - в rehearse.sh)."""
        patterns = [
            ln for ln in DROP_FILE.read_text(encoding="utf-8").splitlines()
            if ln and not ln.startswith("#")
        ]
        self.assertTrue(any(re.search(p, MASK_TOKEN_NAME) for p in patterns))
        self.assertTrue(any(re.search(p, MASK_IMAGE_KEY) for p in patterns))


@unittest.skipUnless(docker_compose_available(), "нет docker compose")
class RehearsalComposeConfigTest(unittest.TestCase):
    """`docker compose config` проекта репетиции на платформе 1.1.3."""

    def test_config_passes_with_lock_and_token(self) -> None:
        """С lock пакета (mask в нём) и токеном config проходит."""
        result = run_compose_config(full_lock(), rehearsal_env(with_mask_token=True))
        self.assertEqual(result.returncode, 0, result.stderr[-600:])

    def test_config_fails_without_mask_token(self) -> None:
        """Без MASK_TOKEN compose отказывает (`:?`): пакет обязан задавать токен сам."""
        result = run_compose_config(full_lock(), rehearsal_env(with_mask_token=False))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(MASK_TOKEN_NAME, result.stderr)

    def test_config_fails_without_mask_image(self) -> None:
        """Без BAI_IMAGE_MASK в lock compose отказывает (`:?`)."""
        lock = full_lock()
        del lock[MASK_IMAGE_KEY]
        result = run_compose_config(lock, rehearsal_env(with_mask_token=True))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(MASK_IMAGE_KEY, result.stderr)

    def test_no_service_depends_on_mask(self) -> None:
        """Ни один сервис не зависит от mask: `up -d app` mask не поднимет."""
        result = run_compose_config(full_lock(), rehearsal_env(with_mask_token=True))
        self.assertEqual(result.returncode, 0, result.stderr[-600:])
        services: dict[str, Any] = json.loads(result.stdout)["services"]
        self.assertIn("mask", services)
        for name, service in services.items():
            deps = service.get("depends_on") or {}
            self.assertNotIn("mask", deps, name)

    def test_app_waits_only_for_light_services(self) -> None:
        """Зависимости app в репетиции: postgres, pseudonymizer, model-stub."""
        result = run_compose_config(full_lock(), rehearsal_env(with_mask_token=True))
        self.assertEqual(result.returncode, 0, result.stderr[-600:])
        app = json.loads(result.stdout)["services"]["app"]
        self.assertEqual(set(app["depends_on"]), {"postgres", "pseudonymizer", "model-stub"})

    def test_app_mask_defaults_follow_platform(self) -> None:
        """app: MASK_URL по умолчанию mask:8320, IMAGE_SEND_PHOTO=false (закреплено проектом)."""
        result = run_compose_config(full_lock(), rehearsal_env(with_mask_token=True))
        self.assertEqual(result.returncode, 0, result.stderr[-600:])
        env = json.loads(result.stdout)["services"]["app"]["environment"]
        self.assertEqual(env["MASK_URL"], "http://mask:8320")
        self.assertEqual(env["IMAGE_SEND_PHOTO"], "false")


if __name__ == "__main__":
    unittest.main()
