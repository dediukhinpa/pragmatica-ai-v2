"""Пределы разметки договорных ручек `/docx/*` (этап 238): свои, уже общих, отказ 413.

Договор правит python-docx целиком в памяти, поэтому у ручек свои пределы размера разметки и
числа узлов (`pragmatika_documents.limits.contract_limits`). Файлы строятся программно (синтетика): заполнитель
вставляется в тело перед `sectPr`.
"""

from __future__ import annotations

import base64
import io
import random
import zipfile

import pytest
from fastapi.testclient import TestClient

from pragmatika_documents.docx_amend import OwnRequisites, amend_counterparty_contract, read_party_block
from pragmatika_documents.limits import (
    CONTRACT_MAX_XML_BYTES,
    CONTRACT_MAX_XML_NODES,
    MIB,
    contract_limits,
)
from documents.limits import (
    REASON_NODES,
    REASON_XML,
    DocumentLimits,
    DocumentTooLargeError,
)
from test_docx_amend import OUR_LINES, OUR_NAME, make_contract

NODES_PER_FILLER_PARAGRAPH = 3  # w:p, w:r, w:t
WORDS = 4000
SEED = 7


def _with_filler(paragraphs: int, text_chars: int) -> bytes:
    """Договор с `paragraphs` абзацами-заполнителями; текст случайный (отношение сжатия живое)."""
    rnd = random.Random(SEED)
    words = ["".join(rnd.choices("абвгдежзик", k=rnd.randint(3, 9))) for _ in range(WORDS)]
    parts = [
        "<w:p><w:r><w:t>" + " ".join(rnd.choices(words, k=max(1, text_chars // 7))) + "</w:t></w:r>"
        "</w:p>"
        for _ in range(paragraphs)
    ]
    source = zipfile.ZipFile(io.BytesIO(make_contract()))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for info in source.infolist():
            data = source.read(info.filename)
            if info.filename == "word/document.xml":
                head, marker, tail = data.decode("utf-8").rpartition("<w:sectPr")
                data = (head + "".join(parts) + marker + tail).encode("utf-8")
            archive.writestr(info.filename, data)
    return out.getvalue()


def test_contract_defaults_are_narrower_than_general_defaults() -> None:
    general = DocumentLimits()
    assert CONTRACT_MAX_XML_BYTES < general.max_xml_bytes
    assert CONTRACT_MAX_XML_NODES < general.max_xml_nodes


def test_realistic_long_contract_passes() -> None:
    """Договор на сотни страниц (6,5 МиБ разметки, ~240 тыс. узлов по замеру) укладывается."""
    # 60 тыс. абзацев x 3 узла + узлы стилей шаблона python-docx (47 тыс.) = ~227 тыс. узлов
    data = _with_filler(60_000, 30)
    block = read_party_block(data, "Заказчик", DocumentLimits())
    assert block.lines


def test_too_many_nodes_is_refused_with_nodes_reason() -> None:
    """Узлов больше договорного предела (300 тыс.) - отказ `nodes`, хотя общий предел 2 млн."""
    paragraphs = CONTRACT_MAX_XML_NODES // NODES_PER_FILLER_PARAGRAPH + 1000
    data = _with_filler(paragraphs, 10)
    with pytest.raises(DocumentTooLargeError) as caught:
        read_party_block(data, "Заказчик", DocumentLimits())
    assert caught.value.reason == REASON_NODES
    # те же узлы общий предел пропускает: договор на нём строже
    with pytest.raises(DocumentTooLargeError):
        amend_counterparty_contract(
            data, OwnRequisites(OUR_NAME, tuple(OUR_LINES)), DocumentLimits()
        )


def test_too_much_markup_is_refused_with_xml_reason() -> None:
    """Разметки больше 8 МиБ при небольшом числе узлов - отказ `xml`."""
    paragraphs = 50_000
    data = _with_filler(paragraphs, 190)
    markup = sum(
        i.file_size for i in zipfile.ZipFile(io.BytesIO(data)).infolist()
        if i.filename.endswith(".xml")
    )
    assert markup > CONTRACT_MAX_XML_BYTES
    assert markup < DocumentLimits().max_xml_bytes
    with pytest.raises(DocumentTooLargeError) as caught:
        read_party_block(data, "Заказчик", DocumentLimits())
    assert caught.value.reason == REASON_XML


def test_route_answers_413_over_contract_limit(client: TestClient) -> None:
    """Все три ручки отвечают 413, а не падают по памяти: понятный отказ как у прочих пределов."""
    data = _with_filler(CONTRACT_MAX_XML_NODES // NODES_PER_FILLER_PARAGRAPH + 1000, 10)
    content = base64.b64encode(data).decode("ascii")
    for path, body in (
        ("/docx/party-block", {"content_base64": content, "role": "Заказчик"}),
        ("/docx/amend", {
            "file_name": "Договор.docx", "content_base64": content,
            "own_requisites": {"name": OUR_NAME, "lines": OUR_LINES},
        }),
        ("/docx/classify", {
            "file_name": "Договор.docx", "content_base64": content,
            "own_inns": ["7701001238"], "own_names": [OUR_NAME],
        }),
    ):
        response = client.post(path, json=body)
        assert response.status_code == 413, (path, response.text)


def test_template_tree_is_released_before_the_next_template(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Дерево каждого шаблона освобождается сразу (замер на пределах: 464 против 157 МиБ с явной сборкой)."""
    from pragmatika_documents import contract_kind

    calls: list[int] = []
    monkeypatch.setattr(contract_kind, "release_memory", lambda: calls.append(1))
    contract_kind._fingerprint_cache.clear()
    templates = [_with_filler(50 + n, 80) for n in range(3)]
    contract_kind.classify_contract(
        make_contract(), templates, ["7701001238"], [OUR_NAME], DocumentLimits()
    )
    assert len(calls) == len(templates)
    contract_kind._fingerprint_cache.clear()
