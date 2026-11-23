"""Крупный docx с картинками и /docx/pages: отказ 413 штатный и без содержимого файла.

Живой случай (этап 9t): сотрудник прислал docx с таблицей цен и сотнями картинок, `POST
/docx/pages` ответил 413. Номера страниц - подсказка, поэтому клиент проекта молча обходится без
них (`tests/project/docx-pages-large.test.ts`); здесь закреплена сторона сервиса: предел входа
конвертации (`max_convert_input_bytes`) отказывает ДО запуска LibreOffice, ответ не содержит
ни имени, ни текста файла, а тот же файл в пределах лимита обрабатывается обычным путём.
Предел памяти и размера не повышается: конвертация тяжёлого docx - главный потребитель памяти
сервиса, поэтому 413 лучше медленной конвертации и нехватки памяти.
"""

from __future__ import annotations

import base64
import io
import random

import docx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from documents.config import Settings
from documents.limits import DocumentLimits
from pragmatika_documents import docx_pages
from pragmatika_documents.app import create_app

PAGES_URL = "/docx/pages"
HTTP_OK = 200
HTTP_TOO_LARGE = 413
IMAGE_COUNT = 212
IMAGE_SIDE = 48
SECRET_NAME = "стекло прайс СЕКРЕТ-КЛИЕНТ опт 2.docx"
PRICE_TEXTS = ("140р", "190 р.", "800 рублей")
HEADER = ("Фото", "Название", "Цена")


def make_price_docx_with_images() -> bytes:
    """Синтетика: таблица из 212 строк (картинка, название, цена текстом «140р», «190 р.»)."""
    rng = random.Random(7)
    document = docx.Document()
    table = document.add_table(rows=1, cols=len(HEADER))
    for col, title in enumerate(HEADER):
        table.cell(0, col).text = title
    for index in range(IMAGE_COUNT):
        row = table.add_row()
        noise = Image.new("RGB", (IMAGE_SIDE, IMAGE_SIDE))
        noise.putdata(
            [
                (rng.randrange(256), rng.randrange(256), rng.randrange(256))
                for _ in range(IMAGE_SIDE * IMAGE_SIDE)
            ]
        )
        png = io.BytesIO()
        noise.save(png, "PNG")
        png.seek(0)
        row.cells[0].paragraphs[0].add_run().add_picture(png)
        row.cells[1].text = f"Стекло {index}"
        row.cells[2].text = PRICE_TEXTS[index % len(PRICE_TEXTS)]
    buf = io.BytesIO()
    document.save(buf)
    return buf.getvalue()


def _client(tmp_path, limits: DocumentLimits) -> TestClient:  # noqa: ANN001
    """Приложение проекта с заданными лимитами."""
    root = tmp_path / "root"
    root.mkdir()
    return TestClient(create_app(Settings(documents_root=root, limits=limits)))


def _post(client: TestClient, data: bytes):  # noqa: ANN202
    """POST /docx/pages с JSON-телом и «секретным» именем файла."""
    body = {"file_name": SECRET_NAME, "content_base64": base64.b64encode(data).decode("ascii")}
    return client.post(PAGES_URL, json=body)


def test_oversize_docx_is_413_before_conversion(
    tmp_path, monkeypatch: pytest.MonkeyPatch  # noqa: ANN001
) -> None:
    """Файл крупнее предела входа: 413 без запуска конвертера, имени и текста в ответе нет."""
    data = make_price_docx_with_images()
    calls: list[str] = []

    def converter(payload: bytes, ext: str, limits: DocumentLimits) -> bytes:
        calls.append(ext)
        return b""

    monkeypatch.setattr(docx_pages, "default_converter", converter)
    client = _client(tmp_path, DocumentLimits(max_convert_input_bytes=len(data) - 1))
    resp = _post(client, data)
    assert resp.status_code == HTTP_TOO_LARGE
    assert calls == []
    assert "СЕКРЕТ" not in resp.text and "140" not in resp.text
    # Размер файла - постоянная причина: заголовок «временный отказ» не ставится
    assert resp.headers.get("X-Reject-Kind") is None


def test_docx_within_limit_is_processed(
    tmp_path, monkeypatch: pytest.MonkeyPatch  # noqa: ANN001
) -> None:
    """Тот же файл в пределах лимита идёт обычным путём: предел - единственная причина отказа."""
    data = make_price_docx_with_images()
    seen: list[int] = []

    def converter(payload: bytes, ext: str, limits: DocumentLimits) -> bytes:
        seen.append(len(payload))
        from reportlab.pdfgen import canvas

        buf = io.BytesIO()
        pdf = canvas.Canvas(buf)
        pdf.drawString(50, 800, "page")
        pdf.showPage()
        pdf.save()
        return buf.getvalue()

    monkeypatch.setattr(docx_pages, "default_converter", converter)
    client = _client(tmp_path, DocumentLimits(max_convert_input_bytes=len(data) + 1))
    resp = _post(client, data)
    assert resp.status_code == HTTP_OK
    assert resp.json()["page_count"] == 1
    assert seen == [len(data)]
