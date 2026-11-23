"""Сборка compose v2 для тестов без Docker-демона и без побочных эффектов.

Основной путь: `docker compose config --format json` (разбор и подстановка переменных, образы не
тянутся, контейнеры не создаются). Обязательные переменные (`${VAR:?}`) получают заглушки в
временном env-файле. Если `docker compose` недоступен, остаётся запасной разбор YAML: имена
сервисов, томов и сетей и список переменных; подробные проверки (лимиты, тома, окружение) тогда
пропускаются с понятным сообщением.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

REPO_DIR = Path(__file__).resolve().parents[2]
DEPLOY_DIR = REPO_DIR / "deploy"
COMPOSE_FILE = DEPLOY_DIR / "compose.yml"
PROJECT_COMPOSE_FILE = DEPLOY_DIR / "compose.project.yml"
BASE_COMPOSE_FILE = DEPLOY_DIR / "platform" / "compose.base.yml"
ENV_EXAMPLE_FILE = DEPLOY_DIR / ".env.example"

# Заглушка для обязательных переменных: реальных значений в тестах нет.
PLACEHOLDER = "placeholder"
# Предел времени одной команды compose, секунд.
COMPOSE_TIMEOUT_SECONDS = 120
# `${NAME:?` и `${NAME:-${NAME2:?` — обязательные переменные.
REQUIRED_RE = re.compile(r"\$\{([A-Za-z0-9_]+):\?")
# Любая ссылка на переменную: ${NAME}, ${NAME:-x}, $NAME; «$$» (экранирование) пропускается.
VAR_RE = re.compile(r"(?<!\$)\$\{?([A-Z_][A-Z0-9_]*)")
# Объявление в образце: `NAME=` или закомментированное `#NAME=`.
ENV_DECL_RE = re.compile(r"^#?([A-Z_][A-Z0-9_]*)=", re.MULTILINE)


class ComposeYamlLoader(yaml.SafeLoader):
    """Загрузчик YAML, который принимает теги compose (`!override`, `!reset`) как обычные."""


def _ignore_tag(loader: yaml.SafeLoader, suffix: str, node: yaml.Node) -> Any:
    """Строит значение узла, отбрасывая тег."""
    if isinstance(node, yaml.MappingNode):
        return loader.construct_mapping(node, deep=True)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node, deep=True)
    return loader.construct_scalar(node)


ComposeYamlLoader.add_multi_constructor("!", _ignore_tag)


def strip_comments(text: str) -> str:
    """Убирает комментарии compose, чтобы примеры в них не считались переменными."""
    return "\n".join(
        line.split("  #")[0] for line in text.splitlines() if not line.lstrip().startswith("#")
    )


def compose_texts() -> list[str]:
    """Тексты файлов compose (главный, база, дополнения проекта) без комментариев."""
    return [
        strip_comments(path.read_text(encoding="utf-8"))
        for path in (COMPOSE_FILE, BASE_COMPOSE_FILE, PROJECT_COMPOSE_FILE)
    ]


def referenced_vars() -> set[str]:
    """Имена переменных, на которые ссылаются файлы compose."""
    names: set[str] = set()
    for text in compose_texts():
        names.update(VAR_RE.findall(text))
    return names


def required_vars() -> set[str]:
    """Обязательные переменные compose (`${NAME:?...}`)."""
    names: set[str] = set()
    for text in compose_texts():
        names.update(REQUIRED_RE.findall(text))
    return names


def declared_in_example() -> set[str]:
    """Имена, объявленные в deploy/.env.example (активно или закомментированно)."""
    return set(ENV_DECL_RE.findall(ENV_EXAMPLE_FILE.read_text(encoding="utf-8")))


def docker_compose_available() -> bool:
    """Есть ли `docker compose` (версия 2.20+ нужна для `include`)."""
    if shutil.which("docker") is None:
        return False
    try:
        result = subprocess.run(
            ["docker", "compose", "version", "--short"],
            capture_output=True,
            text=True,
            timeout=COMPOSE_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


@lru_cache(maxsize=1)
def resolved_compose() -> dict[str, Any] | None:
    """Результат `docker compose config` для compose v2 или None, если Docker недоступен.

    Образец .env и заглушки обязательных переменных подаются через --env-file; ни образы, ни
    контейнеры, ни тома при этом не создаются.
    """
    if not docker_compose_available():
        return None
    with tempfile.TemporaryDirectory(prefix="pragmatika-compose-") as tmp:
        stub = Path(tmp) / "stub.env"
        lines = [f"{name}={PLACEHOLDER}" for name in sorted(required_vars())]
        stub.write_text("\n".join(lines) + "\n", encoding="utf-8")
        command = [
            "docker", "compose",
            "--env-file", str(ENV_EXAMPLE_FILE),
            "--env-file", str(stub),
            "-f", str(COMPOSE_FILE),
            "--profile", "*",
            "config", "--format", "json",
        ]
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=COMPOSE_TIMEOUT_SECONDS,
            check=False,
            cwd=DEPLOY_DIR,
        )
    if result.returncode != 0:
        raise RuntimeError(f"docker compose config завершился с ошибкой: {result.stderr[-500:]}")
    parsed = json.loads(result.stdout)
    if not isinstance(parsed, dict):
        raise RuntimeError("docker compose config вернул не объект")
    return parsed


@lru_cache(maxsize=1)
def yaml_names() -> dict[str, set[str]]:
    """Запасной разбор: ключи сервисов, томов и сетей из базы и дополнений проекта."""
    names: dict[str, set[str]] = {"services": set(), "volumes": set(), "networks": set()}
    for path in (BASE_COMPOSE_FILE, PROJECT_COMPOSE_FILE):
        data = yaml.load(  # noqa: S506 - свой наследник SafeLoader
            path.read_text(encoding="utf-8"), Loader=ComposeYamlLoader
        ) or {}
        for key in names:
            section = data.get(key)
            if isinstance(section, dict):
                names[key].update(str(item) for item in section)
    return names


def top_level_names() -> dict[str, set[str]]:
    """Имена сервисов, томов и сетей: из `docker compose config`, иначе из YAML."""
    resolved = resolved_compose()
    if resolved is None:
        return yaml_names()
    return {
        key: set((resolved.get(key) or {}).keys()) for key in ("services", "volumes", "networks")
    }
