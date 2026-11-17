"""Точка входа: `python -m pragmatika_documents` (вместо платформенного `python -m documents`)."""

from __future__ import annotations

import logging
import sys

import uvicorn

from documents.config import load_settings
from documents.config_dir import ConfigFileError
from documents.jsonlog import configure_logging

# Код выхода при ошибке файла в /config (EX_CONFIG из sysexits.h), как у платформы.
EXIT_CONFIG_ERROR = 78


def main() -> int:
    """Запускает сервис документов проекта."""
    configure_logging(logging.INFO)
    try:
        # Импорт читает файлы из /config (валюты, значения шаблона): ошибка формата должна дать
        # понятное сообщение, а не трейс импорта.
        from pragmatika_documents.app import create_app

        settings = load_settings()
    except ConfigFileError as exc:
        logging.getLogger("pragmatika_documents").error(f"ошибка настройки /config: {exc}")
        return EXIT_CONFIG_ERROR
    # log_config=None и access_log=False: логирует JSON-middleware платформы, как в `documents`
    uvicorn.run(
        create_app(settings),
        host=settings.host,
        port=settings.port,
        log_level="info",
        log_config=None,
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
