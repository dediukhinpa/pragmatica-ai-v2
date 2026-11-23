"""Тесты подстановки подписанта нашей стороны (POST /docx/replace-signatory).

Шаблон строится программно (синтетика): пять мест с подписантом, часть с табуляциями и фамилией,
разбитой на несколько run; сторона поставщика содержит метку шаблона.
"""

from __future__ import annotations

import base64
import io
from typing import Any

import docx
import pytest
from fastapi.testclient import TestClient

from documents.config import Settings
from pragmatika_documents.docx_signatory import (
    ERR_SIGNATORY_INCONSISTENT,
    ERR_SIGNATORY_LEFT,
    ERR_SIGNATORY_NOT_FOUND,
    SignatoryForms,
    replace_signatory,
)
from pragmatika_documents.docx_amend import AmendError

OLD_SURNAME = "Тестов"
FORMS = SignatoryForms(
    nominative_short="Образцова А.С.",
    nominative_reversed="А.С. Образцова",
    genitive_full="Образцовой Анны Сергеевны",
    genitive_short="Образцовой А.С.",
)


def _template(
    extra: list[str] | None = None,
    *,
    gen_full: str = "Тестова Ивана Петровича",
    gen_short: str = "Тестова И.П.",
    nom_short: str = "Тестов И.П.",
    reversed_: str = "И.П. Тестов",
) -> bytes:
    document = docx.Document()
    document.add_paragraph(
        "Общество, именуемое «Заказчик», в лице генерального директора "
        f"{gen_full}, действующего на основании Устава, и {{seller_name}}, "
        "в лице {seller_position} {seller_representative}, заключили договор."
    )
    signature = document.add_paragraph()
    signature.add_run("Генеральный директор")
    signature.add_run().add_tab()
    # фамилия разбита на два run, между ФИО и М.П. табуляции
    signature.add_run(nom_short[:3])
    signature.add_run(nom_short[3:])
    signature.add_run().add_tab()
    signature.add_run("М.П.")
    document.add_paragraph(
        f"Приложение: Заказчик в лице генерального директора {gen_short}, действующего на "
        "основании Устава."
    )
    document.add_paragraph(f"Генеральный директор ______/{nom_short}")
    document.add_paragraph(f"______/{reversed_}")
    for line in extra or []:
        document.add_paragraph(line)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def _texts(content: bytes) -> list[str]:
    return [p.text for p in docx.Document(io.BytesIO(content)).paragraphs]


def _cfg_limits() -> Any:
    return Settings().limits


def test_all_five_forms_replaced() -> None:
    result = replace_signatory(_template(), FORMS, _cfg_limits())
    text = "\n".join(_texts(result.content))
    assert OLD_SURNAME not in text and "Тестова" not in text
    assert "в лице генерального директора Образцовой Анны Сергеевны, действующего" in text
    assert "Образцова А.С." in text  # строка подписи
    assert "директора Образцовой А.С., действующего" in text
    assert "Генеральный директор ______/Образцова А.С." in text
    assert "______/А.С. Образцова" in text
    assert result.report.replaced == 5
    # метка шаблона стороны поставщика не тронута
    assert "{seller_representative}" in text


def test_matching_signatory_is_noop_and_bytes_identical() -> None:
    source = _template(
        gen_full=FORMS.genitive_full,
        gen_short=FORMS.genitive_short,
        nom_short=FORMS.nominative_short,
        reversed_=FORMS.nominative_reversed,
    )
    result = replace_signatory(source, FORMS, _cfg_limits())
    assert result.report.found == 5
    assert result.report.unchanged is True
    assert result.content == source


def test_not_found_without_anchors() -> None:
    document = docx.Document()
    document.add_paragraph("Договор без подписанта.")
    buffer = io.BytesIO()
    document.save(buffer)
    with pytest.raises(AmendError) as raised:
        replace_signatory(buffer.getvalue(), FORMS, _cfg_limits())
    assert raised.value.code == ERR_SIGNATORY_NOT_FOUND


def test_inconsistent_people_refused() -> None:
    source = _template(["Генеральный директор Другов А.Б."])
    with pytest.raises(AmendError) as raised:
        replace_signatory(source, FORMS, _cfg_limits())
    assert raised.value.code == ERR_SIGNATORY_INCONSISTENT


def test_old_signatory_left_refused() -> None:
    source = _template(["Копия: Тестову И.П. направить уведомление."])
    with pytest.raises(AmendError) as raised:
        replace_signatory(source, FORMS, _cfg_limits())
    assert raised.value.code == ERR_SIGNATORY_LEFT


def test_endpoint_roundtrip_and_refusal(client: TestClient) -> None:
    payload = {
        "content_base64": base64.b64encode(_template()).decode(),
        "nominative_short": FORMS.nominative_short,
        "nominative_reversed": FORMS.nominative_reversed,
        "genitive_full": FORMS.genitive_full,
        "genitive_short": FORMS.genitive_short,
    }
    resp = client.post("/docx/replace-signatory", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["replaced"] == 5 and body["unchanged"] is False
    assert "Образцовой Анны Сергеевны" in "\n".join(
        _texts(base64.b64decode(body["content_base64"]))
    )
    empty = docx.Document()
    empty.add_paragraph("Без подписанта")
    buffer = io.BytesIO()
    empty.save(buffer)
    payload["content_base64"] = base64.b64encode(buffer.getvalue()).decode()
    refused = client.post("/docx/replace-signatory", json=payload)
    assert refused.status_code == 422
    assert refused.json()["detail"]["error"] == ERR_SIGNATORY_NOT_FOUND
    assert "Образц" not in refused.text
