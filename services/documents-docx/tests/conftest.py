"""Фикстуры: приложение документов проекта (платформенный create_app + маршруты /docx/*)."""

from __future__ import annotations

import io
import os
import sys
from pathlib import Path

import docx
import openpyxl
import pytest
from fastapi.testclient import TestClient

from documents.config import Settings
from pragmatika_documents.app import create_app

# Тесты лежат рядом друг с другом без пакета: общие построители договоров импортируются по имени
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Вендоренная labops-pii (платформа) нужна и дочерним процессам: передаём через env
_VENDOR_DIR = os.environ.get("BAI_VENDOR_PII_DIR", "")
if _VENDOR_DIR:
    os.environ["PYTHONPATH"] = os.pathsep.join(
        filter(None, [_VENDOR_DIR, os.environ.get("PYTHONPATH", "")])
    )


def make_docx(text: str = "Договор") -> bytes:
    """Минимальный docx из одного абзаца (синтетика)."""
    document = docx.Document()
    document.add_paragraph(text)
    buf = io.BytesIO()
    document.save(buf)
    return buf.getvalue()


@pytest.fixture
def docs_root(tmp_path: Path) -> Path:
    """Корень документов для настроек сервиса."""
    root = tmp_path / "root"
    root.mkdir()
    return root


@pytest.fixture
def client(docs_root: Path) -> TestClient:
    """Клиент приложения проекта."""
    return TestClient(create_app(Settings(documents_root=docs_root)))


@pytest.fixture
def xlsx_bytes() -> bytes:
    """Маленькая книга xlsx: нужна, чтобы занять слот разбора платформы (синтетика)."""
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.append(["Наименование", "Цена"])
    sheet.append(["Болт М8", 10])
    buf = io.BytesIO()
    book.save(buf)
    return buf.getvalue()
