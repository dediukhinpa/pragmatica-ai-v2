"""Обход дефекта платформы: скан PDF из памяти не отдаёт картинки страниц.

Загрузка в `/parse` приходит в `SpooledTemporaryFile`. Платформенный `local_file` берёт его
дескриптор и отдаёт дочернему процессу путь `/proc/self/fd/N`, а этот путь ведёт на уже
удалённый временный файл (`/tmp/#123 (deleted)`). `pypdfium2` сначала разрешает путь до
настоящего (`resolve()`), и проверка `is_file()` падает с `FileNotFoundError`: ответ процесса
`failed`, `images=[]`, `needs_ocr=true`. Файл с именем на диске работает.

Здесь `local_file` в модуле `documents.pdf_images` заменяется обёрткой: если путь по
дескриптору не разрешается в существующий файл, содержимое копируется во временный файл с
настоящим именем (как платформенная ветка для `BytesIO`). Файл с именем на диске идёт прежней
дорогой. Платформенные файлы не правятся.

Временный обход до платформы 1.1.10 (этап 9r): там `local_file` чинится сам, и вызов
`apply()` из `create_app` вместе с этим модулем удаляется.
"""

from __future__ import annotations

import contextlib
import logging
import os
import shutil
import tempfile
from collections.abc import Callable, Iterator
from typing import Any, BinaryIO

import documents.pdf_images as platform_pdf_images
from documents.source import LocalFile

logger = logging.getLogger(__name__)

# Порция копирования содержимого во временный файл (как в платформенном `source`)
COPY_CHUNK_BYTES = 64 * 1024
TEMP_PREFIX = "documents-"
# Признак, что обёртка уже стоит (повторный `apply()` ничего не делает)
WRAPPED_MARK = "_pragmatika_named_copy"


def _path_resolves(fp: BinaryIO) -> bool | None:
    """Разрешается ли путь по дескриптору файла в существующий файл на диске.

    Returns:
        True/False для файла с дескриптором; None, если дескриптора нет (`BytesIO` и т. п.):
        такой источник платформа сама копирует во временный файл.
    """
    try:
        descriptor = fp.fileno()
    except (AttributeError, OSError, ValueError):
        return None
    return os.path.isfile(os.path.realpath(f"/proc/self/fd/{descriptor}"))


def _wrap(original: Callable[[BinaryIO], Any]) -> Callable[[BinaryIO], Any]:
    """Оборачивает платформенный `local_file` копией во временный файл для удалённых файлов."""

    @contextlib.contextmanager
    def named_local_file(fp: BinaryIO) -> Iterator[LocalFile]:
        if _path_resolves(fp) is not False:
            with original(fp) as target:
                yield target
            return
        fp.seek(0)
        with tempfile.NamedTemporaryFile(prefix=TEMP_PREFIX) as copy:
            shutil.copyfileobj(fp, copy, COPY_CHUNK_BYTES)
            copy.flush()
            yield LocalFile(copy.name)

    setattr(named_local_file, WRAPPED_MARK, True)
    return named_local_file


def apply() -> None:
    """Включает обход в платформенном модуле `documents.pdf_images` (повторный вызов безопасен)."""
    current = platform_pdf_images.local_file
    if getattr(current, WRAPPED_MARK, False):
        return
    platform_pdf_images.local_file = _wrap(current)  # type: ignore[assignment]
    logger.info("pdf_images: включён обход удалённого спула (до платформы 1.1.10)")
