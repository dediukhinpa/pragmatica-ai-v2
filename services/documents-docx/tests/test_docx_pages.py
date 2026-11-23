"""Тесты POST /docx/pages: тексты страниц по фактической раскладке документа.

Настоящего LibreOffice на хосте тестов нет, поэтому конвертер подменяется фейком: он читает
синтетический docx (python-docx), делит его на страницы по разрывам страниц и собирает PDF
через reportlab с теми же страницами. Один тест гоняет настоящий soffice и пропускается, если
его нет (его прогоняют в образе).
"""

from __future__ import annotations

import base64
import io
import shutil
from pathlib import Path

import docx
import openpyxl
import pytest
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph
from fastapi.testclient import TestClient
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from documents.limits import DocumentLimits
from documents.models import DocumentTooLargeError
from documents.office_convert import (
    ERR_CONVERSION_FAILED,
    ERR_SPOOL_UNAVAILABLE,
    ERR_UNSUPPORTED,
    ConversionError,
)
from pragmatika_documents import docx_pages
from pragmatika_documents.docx_pages import (
    MAX_PAGE_CHARS,
    MAX_PAGES,
    extract_pages,
    render_pdf,
)
from pragmatika_documents.routes import DOCX_ROUTES, ROUTE_PAGES

PAGES_URL = "/docx/pages"
PAGE_TOP = A4[1] - 60
LINE_STEP = 14
FONT_SIZE = 10
RTF_SAMPLE = b"{\\rtf1\\ansi Agreement 1}"
SECRET = "SECRET-CONTENT-77"
CYRILLIC_FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
)
HTTP_OK = 200
HTTP_UNPROCESSABLE = 422
HTTP_TOO_LARGE = 413
HTTP_UNAVAILABLE = 503


def _docx_bytes(document: docx.document.Document) -> bytes:
    """Сохраняет документ python-docx в байты."""
    buf = io.BytesIO()
    document.save(buf)
    return buf.getvalue()


def make_paged_docx(pages: list[list[str]], table_on: int | None = None) -> bytes:
    """Синтетический docx: абзацы страниц и разрыв страницы между ними.

    Args:
        pages: Абзацы каждой страницы; пустой список - пустая страница.
        table_on: Номер страницы (с 1), куда добавляется таблица 2x2 с текстом ячеек.
    """
    document = docx.Document()
    for index, paragraphs in enumerate(pages, start=1):
        for text in paragraphs:
            document.add_paragraph(text)
        if table_on == index:
            table = document.add_table(rows=2, cols=2)
            for row, cells in enumerate((("T-a1", "T-b1"), ("T-a2", "T-b2"))):
                for col, value in enumerate(cells):
                    table.cell(row, col).text = value
        if index < len(pages):
            document.add_page_break()
    return _docx_bytes(document)


def _blocks_to_pages(data: bytes) -> list[list[str]]:
    """Строки документа по страницам: новая страница начинается после разрыва страницы."""
    document = docx.Document(io.BytesIO(data))
    pages: list[list[str]] = [[]]
    for child in document.element.body.iterchildren():
        if child.tag == qn("w:p"):
            paragraph = Paragraph(child, document)
            if paragraph.text:
                pages[-1].append(paragraph.text)
            if child.xpath('.//w:br[@w:type="page"]'):
                pages.append([])
        elif child.tag == qn("w:tbl"):
            for row in Table(child, document).rows:
                pages[-1].append(" ".join(cell.text for cell in row.cells))
    return pages


def _register_font() -> str:
    """Шрифт для PDF фейка: DejaVu (кириллица), если он есть, иначе Helvetica."""
    for candidate in CYRILLIC_FONT_CANDIDATES:
        if Path(candidate).is_file():
            pdfmetrics.registerFont(TTFont("TestSans", candidate))
            return "TestSans"
    return "Helvetica"


def make_pdf(pages: list[list[str]], font: str = "Helvetica") -> bytes:
    """PDF с заданными строками на каждой странице (пустой список - пустая страница)."""
    buf = io.BytesIO()
    pdf = canvas.Canvas(buf, pagesize=A4)
    for lines in pages:
        pdf.setFont(font, FONT_SIZE)
        for row, line in enumerate(lines):
            pdf.drawString(50, PAGE_TOP - row * LINE_STEP, line)
        pdf.showPage()
    pdf.save()
    return buf.getvalue()


def fake_converter(data: bytes, source_extension: str, limits: DocumentLimits) -> bytes:
    """Фейк LibreOffice: PDF с теми же страницами, что у docx (разрывы страниц - границы)."""
    return make_pdf(_blocks_to_pages(data))


@pytest.fixture
def fake_office(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Подменяет конвертер сервиса фейком; список копит расширения, с которыми его звали."""
    seen: list[str] = []

    def converter(data: bytes, source_extension: str, limits: DocumentLimits) -> bytes:
        seen.append(source_extension)
        return fake_converter(data, source_extension, limits)

    monkeypatch.setattr(docx_pages, "default_converter", converter)
    return seen


def _post_json(client: TestClient, data: bytes, name: str = "a.docx"):  # noqa: ANN202
    """POST /docx/pages с JSON-телом."""
    body = {"file_name": name, "content_base64": base64.b64encode(data).decode("ascii")}
    return client.post(PAGES_URL, json=body)


# --- извлечение текста по страницам ------------------------------------------------------------


def test_pages_text_in_order_with_table() -> None:
    """40 абзацев на четырёх страницах и таблица: номера с 1, текст и порядок сохранены."""
    pages = [[f"Para {page}-{i:02d}" for i in range(10)] for page in range(1, 5)]
    data = make_paged_docx(pages, table_on=2)
    result = extract_pages(fake_converter(data, ".docx", DocumentLimits()))
    assert result.page_count == len(pages)
    assert not result.truncated
    assert [page.number for page in result.pages] == [1, 2, 3, 4]
    for number, page in enumerate(result.pages, start=1):
        assert f"Para {number}-00" in page.text
        assert f"Para {number}-09" in page.text
        assert page.text.index(f"Para {number}-00") < page.text.index(f"Para {number}-09")
    assert "T-a1 T-b1" in result.pages[1].text and "T-a2 T-b2" in result.pages[1].text
    assert "T-a1" not in result.pages[0].text and "T-a1" not in result.pages[2].text
    # абзацы страницы 2 стоят выше таблицы: порядок внутри страницы сохранён
    assert result.pages[1].text.index("Para 2-09") < result.pages[1].text.index("T-a1")


def test_empty_page_has_empty_text() -> None:
    """Пустая страница в середине даёт пустой text, а номера идут подряд."""
    pdf = make_pdf([["First"], [], ["Third"]])
    result = extract_pages(pdf)
    assert [page.number for page in result.pages] == [1, 2, 3]
    assert result.pages[1].text == ""
    assert "First" in result.pages[0].text and "Third" in result.pages[2].text


def test_cyrillic_text_survives() -> None:
    """Русский текст страницы приходит как есть (если на хосте есть шрифт с кириллицей)."""
    font = _register_font()
    if font == "Helvetica":
        pytest.skip("нет шрифта с кириллицей для фейкового PDF")
    result = extract_pages(make_pdf([["Первая страница"], ["Вторая страница"]], font))
    assert "Первая страница" in result.pages[0].text
    assert "Вторая страница" in result.pages[1].text


def test_truncated_by_page_count() -> None:
    """Страницы сверх предела не отдаются, page_count остаётся настоящим."""
    result = extract_pages(make_pdf([[f"P{i}"] for i in range(1, 6)]), max_pages=3)
    assert result.truncated
    assert result.page_count == 5
    assert [page.number for page in result.pages] == [1, 2, 3]


def test_truncated_by_page_chars() -> None:
    """Текст страницы длиннее предела режется, ответ помечается truncated."""
    long_line = "x" * 120
    result = extract_pages(make_pdf([[long_line], ["short"]]), max_chars=50)
    assert result.truncated
    assert len(result.pages[0].text) == 50
    assert result.pages[1].text == "short"


def test_not_truncated_exactly_at_limits() -> None:
    """Ровно предельные страницы и знаки - ещё не усечение."""
    result = extract_pages(make_pdf([["x" * 40], ["y"]]), max_pages=2, max_chars=40)
    assert not result.truncated
    assert result.page_count == 2
    assert len(result.pages[0].text) == 40


def test_default_limits_are_the_contract_numbers() -> None:
    """Пределы контракта: 500 страниц, 20000 знаков на страницу."""
    assert MAX_PAGES == 500
    assert MAX_PAGE_CHARS == 20000


def test_not_a_pdf_is_conversion_failed() -> None:
    """Вместо PDF пришло что-то иное: отказ conversion_failed без содержимого в тексте."""
    with pytest.raises(ConversionError) as caught:
        extract_pages(SECRET.encode())
    assert caught.value.code == ERR_CONVERSION_FAILED
    assert SECRET not in str(caught.value)


# --- определение формата и вызов конвертера ----------------------------------------------------


def test_render_pdf_passes_docx_extension() -> None:
    """docx идёт в конвертер как .docx; результат - его PDF."""
    seen: list[str] = []

    def converter(data: bytes, ext: str, limits: DocumentLimits) -> bytes:
        seen.append(ext)
        return b"%PDF-fake"

    out = render_pdf(make_paged_docx([["A"]]), DocumentLimits(), converter)
    assert out == b"%PDF-fake" and seen == [".docx"]


def test_render_pdf_passes_rtf_extension() -> None:
    """RTF идёт в конвертер как .rtf."""
    seen: list[str] = []

    def converter(data: bytes, ext: str, limits: DocumentLimits) -> bytes:
        seen.append(ext)
        return b"%PDF-fake"

    render_pdf(RTF_SAMPLE, DocumentLimits(), converter)
    assert seen == [".rtf"]


def _xlsx() -> bytes:
    """Маленькая книга xlsx (zip, но не docx)."""
    book = openpyxl.Workbook()
    book.active.append(["a", 1])
    buf = io.BytesIO()
    book.save(buf)
    return buf.getvalue()


def test_render_pdf_rejects_other_formats() -> None:
    """xlsx, произвольные байты и битый zip отклоняются до запуска конвертера."""
    calls: list[str] = []

    def converter(data: bytes, ext: str, limits: DocumentLimits) -> bytes:
        calls.append(ext)
        return b""

    for data, code in (
        (_xlsx(), ERR_UNSUPPORTED),
        (SECRET.encode(), ERR_UNSUPPORTED),
        (b"PK\x03\x04" + SECRET.encode(), ERR_CONVERSION_FAILED),
    ):
        with pytest.raises(ConversionError) as caught:
            render_pdf(data, DocumentLimits(), converter)
        assert caught.value.code == code
        assert SECRET not in str(caught.value)
    assert calls == []


def test_render_pdf_checks_input_size() -> None:
    """Слишком большой вход - 413-исключение платформы до конвертации."""
    limits = DocumentLimits(max_convert_input_bytes=10)
    with pytest.raises(DocumentTooLargeError):
        render_pdf(make_paged_docx([["A"]]), limits, lambda *_: b"")


# --- маршрут -----------------------------------------------------------------------------------


def test_route_is_registered() -> None:
    """Маршрут входит в DOCX_ROUTES и отвечает (не 404/405)."""
    assert ROUTE_PAGES == PAGES_URL and PAGES_URL in DOCX_ROUTES


def test_route_json_success(client: TestClient, fake_office: list[str]) -> None:
    """JSON-вход: номера, тексты, page_count, truncated=false."""
    data = make_paged_docx([["Alpha"], ["Beta"], ["Gamma"]])
    resp = _post_json(client, data)
    assert resp.status_code == HTTP_OK
    body = resp.json()
    assert set(body) == {"page_count", "pages", "truncated"}
    assert body["page_count"] == 3 and body["truncated"] is False
    assert [page["number"] for page in body["pages"]] == [1, 2, 3]
    assert "Beta" in body["pages"][1]["text"]
    assert fake_office == [".docx"]


def test_route_multipart_success(client: TestClient, fake_office: list[str]) -> None:
    """Multipart-вход (`file` + `params`) даёт тот же ответ, что JSON."""
    data = make_paged_docx([["Alpha"], ["Beta"]])
    resp = client.post(
        PAGES_URL,
        files={"file": ("a.docx", data)},
        data={"params": '{"file_name": "a.docx"}'},
    )
    assert resp.status_code == HTTP_OK
    assert resp.json() == _post_json(client, data).json()


def test_route_rtf_input(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """RTF принимается, в конвертер уходит с расширением .rtf."""
    seen: list[str] = []

    def rtf_converter(data: bytes, ext: str, limits: DocumentLimits) -> bytes:
        seen.append(ext)
        return make_pdf([["Rtf page"]])

    monkeypatch.setattr(docx_pages, "default_converter", rtf_converter)
    resp = _post_json(client, RTF_SAMPLE, "a.rtf")
    assert resp.status_code == HTTP_OK
    assert resp.json()["pages"][0]["text"] == "Rtf page"
    assert seen == [".rtf"]


def test_route_rejects_xlsx(client: TestClient, fake_office: list[str]) -> None:
    """Не документ Word: 422 unsupported_format, конвертер не вызывался."""
    resp = _post_json(client, _xlsx(), "a.docx")
    assert resp.status_code == HTTP_UNPROCESSABLE
    assert resp.json() == {"detail": {"error": ERR_UNSUPPORTED}}
    assert fake_office == []


def test_route_rejects_garbage(client: TestClient, fake_office: list[str]) -> None:
    """Произвольные байты: 422 без содержимого файла в ответе."""
    resp = _post_json(client, SECRET.encode())
    assert resp.status_code == HTTP_UNPROCESSABLE
    assert resp.json() == {"detail": {"error": ERR_UNSUPPORTED}}
    assert SECRET not in resp.text


def test_route_rejects_broken_zip(client: TestClient, fake_office: list[str]) -> None:
    """Битый docx (zip без каталога): 422 conversion_failed."""
    resp = _post_json(client, b"PK\x03\x04" + SECRET.encode())
    assert resp.status_code == HTTP_UNPROCESSABLE
    assert resp.json() == {"detail": {"error": ERR_CONVERSION_FAILED}}
    assert SECRET not in resp.text


def test_route_rejects_bad_base64(client: TestClient, fake_office: list[str]) -> None:
    """Не base64: 422 bad_request."""
    resp = client.post(PAGES_URL, json={"file_name": "a.docx", "content_base64": "%%%"})
    assert resp.status_code == HTTP_UNPROCESSABLE
    assert resp.json() == {"detail": {"error": "bad_request"}}


def test_route_conversion_error_has_code_only(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ошибка конвертации: 422 с кодом, текст исключения (со значениями) наружу не уходит."""

    def failing(data: bytes, ext: str, limits: DocumentLimits) -> bytes:
        raise ConversionError(ERR_CONVERSION_FAILED, f"не открылся {SECRET}")

    monkeypatch.setattr(docx_pages, "default_converter", failing)
    resp = _post_json(client, make_paged_docx([["A"]]))
    assert resp.status_code == HTTP_UNPROCESSABLE
    assert resp.json() == {"detail": {"error": ERR_CONVERSION_FAILED}}
    assert SECRET not in resp.text


def test_route_spool_unavailable_is_503(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Нехватка места на спуле - 503, а не 422."""

    def failing(data: bytes, ext: str, limits: DocumentLimits) -> bytes:
        raise ConversionError(ERR_SPOOL_UNAVAILABLE)

    monkeypatch.setattr(docx_pages, "default_converter", failing)
    resp = _post_json(client, make_paged_docx([["A"]]))
    assert resp.status_code == HTTP_UNAVAILABLE
    assert resp.json() == {"detail": {"error": ERR_SPOOL_UNAVAILABLE}}


def test_route_timeout_is_413(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Конвертация не уложилась во время - 413 по лимитам, как у соседних ручек."""

    def slow(data: bytes, ext: str, limits: DocumentLimits) -> bytes:
        raise DocumentTooLargeError("convert_timeout")

    monkeypatch.setattr(docx_pages, "default_converter", slow)
    resp = _post_json(client, make_paged_docx([["A"]]))
    assert resp.status_code == HTTP_TOO_LARGE


def test_route_truncation_flag(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Предел страниц сервиса отражается в ответе: усечение и настоящий page_count."""
    monkeypatch.setattr(docx_pages, "MAX_PAGES", 2)
    monkeypatch.setattr(docx_pages, "default_converter", fake_converter)
    resp = _post_json(client, make_paged_docx([["A"], ["B"], ["C"]]))
    assert resp.status_code == HTTP_OK
    body = resp.json()
    assert body["truncated"] is True and body["page_count"] == 3
    assert [page["number"] for page in body["pages"]] == [1, 2]


# --- настоящий LibreOffice (в образе) ----------------------------------------------------------


@pytest.mark.skipif(shutil.which("soffice") is None, reason="LibreOffice (soffice) не установлен")
def test_real_soffice_page_numbers(client: TestClient) -> None:
    """Разрыв страницы между абзацами: «Первая страница» на странице 1, «Вторая» - на 2."""
    document = docx.Document()
    document.add_paragraph("Первая страница")
    document.add_page_break()
    document.add_paragraph("Вторая страница")
    resp = _post_json(client, _docx_bytes(document))
    assert resp.status_code == HTTP_OK
    body = resp.json()
    assert body["page_count"] == 2 and body["truncated"] is False
    assert [page["number"] for page in body["pages"]] == [1, 2]
    assert "Первая страница" in body["pages"][0]["text"]
    assert "Вторая страница" in body["pages"][1]["text"]
    assert "Вторая страница" not in body["pages"][0]["text"]
