"""Тексты страниц документа по фактической раскладке (`POST /docx/pages`).

Номер страницы в docx/.doc/.rtf зависит от вёрстки, а не от разметки файла: его знает только
редактор. Поэтому документ рендерится LibreOffice в PDF, а из PDF берётся текст каждой страницы.
Сопоставление абзацев со страницами делает вызывающий код по этим текстам; здесь только
рендер и извлечение. Платформа не меняется: используется её `_convert` с новой целью
(`pdf:writer_pdf_Export`), общая изоляция процесса, лимиты и кэш отказов.
"""

from __future__ import annotations

import io
import logging
import zipfile
from collections.abc import Callable
from dataclasses import dataclass

import pdfplumber

from documents.convert_cache import convert_cached
from documents.format_sniff import KIND_OLE, KIND_RTF, KIND_ZIP, sniff_kind
from documents.limits import DocumentLimits
from documents.office_convert import (
    ERR_CONVERSION_FAILED,
    ERR_UNSUPPORTED,
    ConvertTarget,
    ConversionError,
    _cacheable_failure,
    _cached_failure,
    _check_convert_input,
    _convert,
    _is_word_ole,
)

logger = logging.getLogger(__name__)

# Фильтр записи PDF из Writer (текстовые документы; .doc и RTF LibreOffice открывает в Writer).
PDF_FILTER = "pdf:writer_pdf_Export"
PDF_EXTENSION = ".pdf"
PDF_TARGET = ConvertTarget(PDF_FILTER, PDF_EXTENSION)

# Пределы ответа: страниц не больше, текста на страницу не больше; сверх - `truncated`.
MAX_PAGES = 500
MAX_PAGE_CHARS = 20000

DOCX_EXTENSION = ".docx"
DOC_EXTENSION = ".doc"
RTF_EXTENSION = ".rtf"
# Часть архива, по которой docx отличается от других OOXML (xlsx, pptx)
DOCX_MAIN_PART = "word/document.xml"

# Конвертер: (байты исходного файла, расширение исходника, лимиты) -> байты PDF
Converter = Callable[[bytes, str, DocumentLimits], bytes]


@dataclass(frozen=True)
class PageText:
    """Страница документа.

    Attributes:
        number: Номер страницы, с 1.
        text: Текст страницы из PDF; у пустой страницы - пустая строка.
    """

    number: int
    text: str


@dataclass(frozen=True)
class PagesResult:
    """Тексты страниц документа.

    Attributes:
        page_count: Сколько страниц в документе на самом деле (даже если часть не отдана).
        pages: Страницы по порядку, не больше предела.
        truncated: Часть страниц не отдана или текст страницы обрезан по пределу.
    """

    page_count: int
    pages: tuple[PageText, ...]
    truncated: bool

    def as_dict(self) -> dict[str, object]:
        """Ответ маршрута: `page_count`, `pages[{number, text}]`, `truncated`."""
        return {
            "page_count": self.page_count,
            "pages": [{"number": page.number, "text": page.text} for page in self.pages],
            "truncated": self.truncated,
        }


def convert_to_pdf(data: bytes, source_extension: str, limits: DocumentLimits) -> bytes:
    """Настоящая конвертация в PDF: отдельный процесс LibreOffice с платформенными потолками.

    Args:
        data: Байты исходного файла.
        source_extension: `.docx`, `.doc` или `.rtf` (имя входа во временном каталоге).
        limits: Лимиты размера входа, времени и памяти конвертации.

    Returns:
        Байты PDF.
    """
    return _convert(data, source_extension, limits, PDF_TARGET)


def default_converter(data: bytes, source_extension: str, limits: DocumentLimits) -> bytes:
    """Конвертер по умолчанию: `convert_to_pdf` через платформенный кэш конвертации.

    Повтор того же файла берёт PDF с диска; детерминированный отказ файла запоминается
    (кэш отказов), сбои среды (таймаут, нехватка места) не кэшируются. Цель `.pdf` входит в ключ
    кэша, поэтому результат не путается с docx того же файла.
    """
    return convert_cached(
        data,
        source_extension,
        limits,
        convert_to_pdf,
        _cacheable_failure,
        _cached_failure,
        target_extension=PDF_EXTENSION,
    )


def _is_docx(data: bytes) -> bool:
    """Архив содержит основную часть Word; битый архив - `ConversionError`."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            return DOCX_MAIN_PART in archive.namelist()
    except (zipfile.BadZipFile, OSError) as exc:
        raise ConversionError(ERR_CONVERSION_FAILED, "архив не читается") from exc


def _source_extension(data: bytes, limits: DocumentLimits) -> str:
    """Расширение исходника по содержимому (не по имени); иной формат - `unsupported_format`."""
    kind = sniff_kind(data)
    if kind == KIND_ZIP:
        if not _is_docx(data):
            raise ConversionError(ERR_UNSUPPORTED, "не документ Word")
        return DOCX_EXTENSION
    if kind == KIND_RTF:
        return RTF_EXTENSION
    if kind == KIND_OLE and _is_word_ole(data, limits):
        return DOC_EXTENSION
    raise ConversionError(ERR_UNSUPPORTED, "формат не поддерживается")


def render_pdf(
    data: bytes, limits: DocumentLimits, converter: Converter | None = None
) -> bytes:
    """Рендерит документ (docx, .doc, RTF) в PDF.

    Args:
        data: Байты присланного документа.
        limits: Лимиты конвертации.
        converter: Конвертер в PDF; по умолчанию `default_converter` (в тестах - фейк).

    Returns:
        Байты PDF.

    Raises:
        ConversionError: Формат не поддерживается (`unsupported_format`), архив повреждён,
            LibreOffice недоступен или не справился.
        DocumentTooLargeError: Файл крупнее предела или конвертация не уложилась во время.
    """
    extension = _source_extension(data, limits)
    # Размер проверяем до конвертера и кэша: попадание в кэш не обходит пределы входа.
    _check_convert_input(data, limits)
    convert = converter or default_converter
    return convert(data, extension, limits)


def extract_pages(
    pdf: bytes, max_pages: int | None = None, max_chars: int | None = None
) -> PagesResult:
    """Текст каждой страницы PDF по порядку, в пределах числа страниц и знаков на страницу.

    Args:
        pdf: Байты PDF.
        max_pages: Сколько страниц отдать (по умолчанию `MAX_PAGES`).
        max_chars: Сколько знаков текста на страницу (по умолчанию `MAX_PAGE_CHARS`).

    Returns:
        Тексты страниц; `page_count` - число страниц в PDF целиком.

    Raises:
        ConversionError: `conversion_failed`, если PDF не читается (текст ошибки без содержимого).
    """
    page_limit = MAX_PAGES if max_pages is None else max_pages
    char_limit = MAX_PAGE_CHARS if max_chars is None else max_chars
    pages: list[PageText] = []
    truncated = False
    try:
        with pdfplumber.open(io.BytesIO(pdf)) as document:
            total = len(document.pages)
            for index, page in enumerate(document.pages):
                if index >= page_limit:
                    truncated = True
                    break
                text = page.extract_text() or ""
                if len(text) > char_limit:
                    text = text[:char_limit]
                    truncated = True
                pages.append(PageText(index + 1, text))
                # Разобранное содержимое страницы не копим: на 500 страницах это память.
                page.flush_cache()
    except ConversionError:
        raise
    except Exception as exc:  # noqa: BLE001 - pdfminer бросает разные исключения на битом PDF
        logger.warning("текст страниц: PDF не читается (%s)", type(exc).__name__)
        raise ConversionError(ERR_CONVERSION_FAILED, "PDF не читается") from exc
    return PagesResult(total, tuple(pages), truncated)


def document_pages(
    data: bytes, limits: DocumentLimits, converter: Converter | None = None
) -> PagesResult:
    """Рендер документа в PDF и тексты его страниц (то, что делает маршрут)."""
    return extract_pages(render_pdf(data, limits, converter))
