"""Приложение документов проекта: платформенный `create_app` плюс маршруты `/docx/*`.

У платформенного `create_app` нет точки расширения для проектных маршрутов, а общая ручка
разбора тела (`file_route`: multipart, спул, очередь, выдача на общий том) живёт внутри него.
Поэтому на время вызова `create_app` подменяется конструктор `documents.api.FileTools`: он
создаёт тот же объект и запоминает его. После этого маршруты регистрируются на готовом
приложении тем же `file_route`. Если платформа поменяет внутреннее устройство и перехват не
сработает, сервис не стартует (`RuntimeError`), а не работает без маршрутов: проверка маршрутов
в preflight и контрактные тесты образа ловят это до выкатки. Платформенные файлы не копируются.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from fastapi import FastAPI

import documents.api as platform_api
from documents.config import Settings, load_settings
from documents.convert_cache import start_cache_sweeper
from documents.office_convert import purge_stale_convert_dirs
from documents.priority_gate import PriorityGate
from pragmatika_documents import pdf_images_fix
from pragmatika_documents.routes import FileRoute, register_docx_routes

logger = logging.getLogger(__name__)

# Подмена конструктора глобальна для модуля платформы: сборка приложений идёт под замком.
_BUILD_LOCK = threading.Lock()


class PlatformHookError(RuntimeError):
    """Платформенный `create_app` не отдал `file_route`: внутреннее устройство изменилось."""


def _build_platform_app(cfg: Settings) -> tuple[FastAPI, FileRoute]:
    """Строит платформенное приложение и перехватывает его общую ручку файлов."""
    captured: list[Any] = []
    original = platform_api.FileTools

    def capture(*args: Any, **kwargs: Any) -> Any:
        tools = original(*args, **kwargs)
        captured.append(tools)
        return tools

    with _BUILD_LOCK:
        platform_api.FileTools = capture  # type: ignore[misc,assignment]
        try:
            app = platform_api.create_app(cfg)
        finally:
            platform_api.FileTools = original  # type: ignore[misc]
    if len(captured) != 1 or not callable(getattr(captured[0], "file_route", None)):
        raise PlatformHookError("платформенный create_app не создал FileTools с file_route")
    return app, captured[0].file_route


def create_app(settings: Settings | None = None) -> FastAPI:
    """Создаёт приложение: все платформенные маршруты и проектные `/docx/*`."""
    cfg = settings or load_settings()
    # Временный обход до платформы 1.1.10 (этап 9r): сканы PDF из памяти без картинок страниц
    pdf_images_fix.apply()
    app, file_route = _build_platform_app(cfg)
    if not cfg.office_convert_endpoints:
        # Платформа чистит спул и запускает сметальщик кэша конвертации только при включённой
        # ручке `/convert/docx`; договорные маршруты конвертируют .doc/RTF в любом случае.
        purge_stale_convert_dirs()
        start_cache_sweeper(cfg.limits)
    # Договорные задания - в своём месте сверх слотов разбора (как в прежнем сервисе).
    register_docx_routes(app, cfg, file_route, PriorityGate(cfg.convert_concurrency))
    return app
