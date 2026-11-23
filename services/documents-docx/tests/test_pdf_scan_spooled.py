"""Скан PDF из памяти: загрузка в /parse не должна терять картинки страниц (этап 9t)."""

from __future__ import annotations

import io

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

# Размер синтетического «скана» в пикселях
SCAN_SIZE = (400, 300)


def make_scan_pdf() -> bytes:
    """PDF из одной растровой страницы без текстового слоя (синтетика, как скан счёта)."""
    image = Image.new("RGB", SCAN_SIZE, "white")
    ImageDraw.Draw(image).text((20, 20), "INN 0000000000 BIK 000000000", fill="black")
    buf = io.BytesIO()
    image.save(buf, "PDF")
    return buf.getvalue()


def test_parse_scan_pdf_returns_page_image(client: TestClient) -> None:
    """Маленький скан приходит в память (спул): страница всё равно отдаётся картинкой."""
    response = client.post(
        "/parse",
        data={"extract_images": "true"},
        files={"file": ("scan.pdf", make_scan_pdf(), "application/pdf")},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["images"], body.get("warnings")
    assert body["images"][0]["rendered"] is True


def test_parse_scan_pdf_without_flag_has_no_images(client: TestClient) -> None:
    """Без extract_images картинки не извлекаются (прежнее поведение)."""
    response = client.post(
        "/parse",
        files={"file": ("scan.pdf", make_scan_pdf(), "application/pdf")},
    )
    assert response.status_code == 200, response.text
    assert not response.json().get("images")
