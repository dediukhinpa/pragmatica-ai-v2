"""Признак «договор поставщика» кодом (POST /docx/classify и `classify_contract`).

Договор поставщика = файл НЕ порождён нашими шаблонами И сторона исполнителя заполнена. Все
документы строятся программно (синтетика): наш «шаблон» с метками `{{...}}`, его сборка через
`render_docx` (ставит метку в свойство «Категория»), договор поставщика со своим текстом.
"""

from __future__ import annotations

import base64
import io
from typing import Any, Callable

import docx
import pytest
from fastapi.testclient import TestClient

from pragmatika_documents.contract_kind import (
    REASON_EXECUTOR_EMPTY,
    REASON_EXECUTOR_INN,
    REASON_EXECUTOR_PREAMBLE,
    REASON_EXECUTOR_TEXT,
    REASON_OUR_DATA_IN_EXECUTOR,
    REASON_OWN_MARKER,
    REASON_TEMPLATE_MATCH,
    REASON_TEMPLATE_PARTIAL,
    REASON_TEMPLATES_NOT_COMPARABLE,
    REASON_TEMPLATES_UNAVAILABLE,
    VERDICT_OUR_SIDE_EXECUTOR,
    VERDICT_OWN_TEMPLATE,
    VERDICT_SUPPLIER,
    VERDICT_UNCLEAR,
    classify_contract,
)
from documents.limits import DocumentLimits
from documents.render import render_docx
from pragmatika_documents.limits import OWN_DOCUMENT_MARKER

LIMITS = DocumentLimits()
OUR_INN = "7701001238"
OUR_NAME = "ООО «Наш-Заказчик»"
SUPPLIER_INN = "1111111111"
SIGNATURE = "Генеральный директор ________ / ______ / М.П."

# Неизменный юридический текст нашего шаблона: достаточно длинные и разные абзацы.
OWN_CLAUSES = [
    f"{index}. Покупатель обязуется принять и оплатить товар в порядке, установленном пунктом "
    f"{index} настоящего договора, в сроки, согласованные сторонами в спецификации."
    for index in range(1, 11)
]


def _save(document: Any) -> bytes:
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def our_template() -> bytes:
    """Наш шаблон: заголовок и реквизиты с метками, неизменные пункты договора."""
    document = docx.Document()
    document.add_paragraph("ДОГОВОР ПОСТАВКИ № {{contract_number}}")
    document.add_paragraph(
        "{{supplier_name}}, именуемое в дальнейшем «Поставщик», и ООО «Наш-Заказчик», "
        "именуемое в дальнейшем «Покупатель», заключили настоящий договор."
    )
    for clause in OWN_CLAUSES:
        document.add_paragraph(clause)
    table = document.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "Поставщик:\n{{supplier_name}}\nИНН {{supplier_inn}}"
    table.cell(0, 1).text = f"Покупатель:\n{OUR_NAME}\nИНН {OUR_INN}"
    return _save(document)


def rendered_by_us(marker: bool = True) -> bytes:
    """Документ, собранный по нашему шаблону; без метки - как собирали до её появления."""
    result = render_docx(
        our_template(),
        {"contract_number": "5", "supplier_name": "ООО «Поставщик-Тест»",
         "supplier_inn": SUPPLIER_INN},
        None,
        LIMITS,
        category=OWN_DOCUMENT_MARKER,
    ).content
    if marker:
        return result
    document = docx.Document(io.BytesIO(result))
    document.core_properties.category = ""
    return _save(document)


def supplier_contract(
    executor: list[str] | None = None,
    customer: list[str] | None = None,
    preamble: str | None = None,
) -> bytes:
    """Договор в форме поставщика: свои формулировки, таблица реквизитов сторон."""
    document = docx.Document()
    document.add_paragraph("ДОГОВОР № 1/ТЕСТ-26 от 05.11.2026")
    document.add_paragraph(
        preamble
        or "ООО «Исполнитель-Тест», именуемое в дальнейшем «Исполнитель», и "
        "___________________, именуемое в дальнейшем «Заказчик», заключили договор."
    )
    document.add_paragraph("1. Исполнитель обязуется передать товар, Заказчик обязуется оплатить.")
    table = document.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "\n".join(
        executor
        if executor is not None
        else ["Исполнитель:", "ООО «Исполнитель-Тест»", f"ИНН {SUPPLIER_INN} КПП 222222222",
              SIGNATURE]
    )
    table.cell(0, 1).text = "\n".join(
        customer or ["Заказчик:", "", "ИНН ________ КПП ________", SIGNATURE]
    )
    return _save(document)


def classify(
    data: bytes,
    templates: list[bytes] | None = None,
    inns: tuple[str, ...] = (OUR_INN,),
    names: tuple[str, ...] = (OUR_NAME,),
):
    return classify_contract(data, templates if templates is not None else [our_template()],
                             list(inns), list(names), LIMITS)


# ---------------------------------------------------------------- наш шаблон: однозначно


def test_document_built_by_us_carries_the_marker() -> None:
    document = docx.Document(io.BytesIO(rendered_by_us()))
    assert document.core_properties.category == OWN_DOCUMENT_MARKER


def test_marker_makes_it_our_template_even_without_templates_to_compare() -> None:
    kind = classify(rendered_by_us(), templates=[])
    assert (kind.verdict, kind.reasons) == (VERDICT_OWN_TEMPLATE, (REASON_OWN_MARKER,))


def test_marker_survives_a_resave_in_an_editor() -> None:
    """Правка и пересохранение (python-docx читает и пишет пакет заново) метку не теряют."""
    resaved = _save(docx.Document(io.BytesIO(rendered_by_us())))
    assert classify(resaved, templates=[]).verdict == VERDICT_OWN_TEMPLATE


def test_old_document_without_marker_is_recognised_by_template_text() -> None:
    kind = classify(rendered_by_us(marker=False))
    assert (kind.verdict, kind.reasons) == (VERDICT_OWN_TEMPLATE, (REASON_TEMPLATE_MATCH,))


def test_blank_template_itself_is_our_template() -> None:
    assert classify(our_template()).verdict == VERDICT_OWN_TEMPLATE


# ---------------------------------------------------------------- договор поставщика: однозначно


def test_supplier_contract_with_filled_executor_is_a_supplier_contract() -> None:
    kind = classify(supplier_contract())
    assert kind.verdict == VERDICT_SUPPLIER
    assert REASON_EXECUTOR_INN in kind.reasons
    assert REASON_EXECUTOR_TEXT in kind.reasons
    assert REASON_EXECUTOR_PREAMBLE in kind.reasons


@pytest.mark.parametrize(
    ("executor", "preamble", "expected"),
    [
        # Только ИНН в блоке исполнителя.
        (["Исполнитель:", "ИНН 1111111111", SIGNATURE], "Договор без названия сторон.",
         REASON_EXECUTOR_INN),
        # Только название в блоке исполнителя.
        (["Исполнитель:", "ООО «Исполнитель-Тест»", SIGNATURE], "Договор без названия сторон.",
         REASON_EXECUTOR_TEXT),
        # Только название в преамбуле, блок исполнителя пуст (заполнители).
        (["Исполнитель:", "ИНН ________", SIGNATURE],
         "ООО «Исполнитель-Тест», в лице директора, именуемое в дальнейшем «Исполнитель»",
         REASON_EXECUTOR_PREAMBLE),
        # Роль «Поставщик» вместо «Исполнитель».
        (["Поставщик:", "ООО «Исполнитель-Тест»", SIGNATURE], "Договор без названия сторон.",
         REASON_EXECUTOR_TEXT),
    ],
)
def test_each_filled_executor_evidence_alone_is_enough(
    executor: list[str], preamble: str, expected: str
) -> None:
    kind = classify(supplier_contract(executor=executor, preamble=preamble))
    assert kind.verdict == VERDICT_SUPPLIER
    assert expected in kind.reasons


# ---------------------------------------------------------------- неоднозначно: спросить


def test_executor_not_filled_is_unclear() -> None:
    data = supplier_contract(
        executor=["Исполнитель:", "ИНН ________ КПП ________", SIGNATURE],
        preamble="___________, именуемое в дальнейшем «Исполнитель», и ООО, «Заказчик».",
    )
    kind = classify(data)
    assert (kind.verdict, kind.reasons) == (VERDICT_UNCLEAR, (REASON_EXECUTOR_EMPTY,))


def test_no_templates_to_compare_with_is_unclear_not_supplier() -> None:
    """Сравнить не с чем (шара недоступна): «не наш шаблон» не доказано, код спрашивает."""
    kind = classify(supplier_contract(), templates=[])
    assert kind.verdict == VERDICT_UNCLEAR
    assert kind.reasons[0] == REASON_TEMPLATES_UNAVAILABLE


def test_broken_template_does_not_block_the_others() -> None:
    kind = classify(supplier_contract(), templates=[b"not a docx", our_template()])
    assert kind.verdict == VERDICT_SUPPLIER


def test_only_broken_templates_leave_it_unclear() -> None:
    kind = classify(supplier_contract(), templates=[b"not a docx"])
    assert kind.verdict == VERDICT_UNCLEAR


def test_partial_match_with_our_template_is_unclear() -> None:
    """Часть нашего текста в чужом по виду договоре (правленая копия шаблона) - вопрос."""
    document = docx.Document()
    document.add_paragraph("ДОГОВОР № 1/ТЕСТ-26 от 05.11.2026")
    document.add_paragraph("ООО «Исполнитель-Тест», именуемое в дальнейшем «Исполнитель».")
    for clause in OWN_CLAUSES[:4]:  # 4 из 10 неизменных пунктов + таблица
        document.add_paragraph(clause)
    table = document.add_table(rows=1, cols=1)
    table.cell(0, 0).text = f"Исполнитель:\nООО «Исполнитель-Тест»\nИНН {SUPPLIER_INN}"
    kind = classify(_save(document))
    assert kind.verdict == VERDICT_UNCLEAR
    assert kind.reasons[0] == REASON_TEMPLATE_PARTIAL


def test_our_data_in_executor_block_means_our_side_is_executor() -> None:
    data = supplier_contract(
        executor=["Исполнитель:", OUR_NAME, f"ИНН {OUR_INN}", SIGNATURE],
        customer=["Заказчик:", "ООО «Чужой-Покупатель»", "ИНН 3333333333", SIGNATURE],
    )
    kind = classify(data)
    assert (kind.verdict, kind.reasons) == (
        VERDICT_OUR_SIDE_EXECUTOR,
        (REASON_OUR_DATA_IN_EXECUTOR,),
    )


# Наша сторона-исполнитель, записанная не дословно (находка 1 ревью этапа 232).
OUR_PREAMBLE_TAIL = "именуемое в дальнейшем «Исполнитель», заключили договор."


@pytest.mark.parametrize(
    "preamble",
    [
        # Наше наименование вторым после запятой: имя захватывается как «и ООО «...»».
        f"ООО «Клиент», именуемое в дальнейшем «Заказчик», и ООО «Наш-Заказчик», "
        f"{OUR_PREAMBLE_TAIL}",
        f"ООО «Клиент», именуемое «Заказчик», с другой стороны, и ООО «Наш-Заказчик», "
        f"{OUR_PREAMBLE_TAIL}",
        # Полная форма наименования вместо краткой.
        "Общество с ограниченной ответственностью «Наш-Заказчик», " + OUR_PREAMBLE_TAIL,
        # Без формы и кавычек.
        "Наш Заказчик, " + OUR_PREAMBLE_TAIL,
    ],
)
def test_our_side_executor_is_found_in_the_preamble_in_any_spelling(preamble: str) -> None:
    data = supplier_contract(
        executor=["Исполнитель:", "ИНН ________", SIGNATURE], preamble=preamble
    )
    assert classify(data).verdict == VERDICT_OUR_SIDE_EXECUTOR


@pytest.mark.parametrize(
    "lines",
    [
        # Наименование с дополнением в скобках.
        ["Исполнитель:", "ООО «Наш-Заказчик» (Наш-Заказчик)", SIGNATURE],
        # Полная форма наименования.
        ["Исполнитель:", "Общество с ограниченной ответственностью «Наш-Заказчик»", SIGNATURE],
        # ИНН с пробелами и дефисами внутри числа, без названия.
        ["Исполнитель:", "ИНН 7701 001 238", SIGNATURE],
        ["Исполнитель:", "ИНН 7701-001-238", SIGNATURE],
        ["Исполнитель:", "ИНН/КПП 7701001238/770101001", SIGNATURE],
        # ИНН слился с КПП через пробел.
        ["Исполнитель:", "ИНН 7701001238 770101001", SIGNATURE],
        # Число без метки, в строке одно.
        ["Исполнитель:", "7701 001 238", SIGNATURE],
        # Название и чужой ИНН в одной строке: название наше.
        ["Исполнитель:", "ООО «Наш-Заказчик», ИНН 5555555555", SIGNATURE],
    ],
)
def test_our_side_executor_is_found_in_the_block_in_any_spelling(lines: list[str]) -> None:
    kind = classify(supplier_contract(executor=lines))
    assert (kind.verdict, kind.reasons) == (
        VERDICT_OUR_SIDE_EXECUTOR,
        (REASON_OUR_DATA_IN_EXECUTOR,),
    )


@pytest.mark.parametrize(
    "line",
    [
        # Слово «Наш» внутри другого слова нашей стороной не считается.
        "ООО «Нашествие»",
        # Чужой ИНН с пробелами остаётся ИНН поставщика.
        "ИНН 1111 111 111",
        # Наш ИНН внутри длинного номера (счёта) - не наш ИНН.
        "Р/с 407028107701001238444",
    ],
)
def test_lookalikes_are_not_taken_for_our_side(line: str) -> None:
    kind = classify(supplier_contract(executor=["Исполнитель:", line, SIGNATURE]))
    assert kind.verdict == VERDICT_SUPPLIER


def test_templates_too_short_to_compare_are_not_reported_as_unavailable() -> None:
    """Шаблон прочитан, но неизменного текста мало: причина не «шаблоны не прочитаны»."""
    short = docx.Document()
    short.add_paragraph("ДОГОВОР № {{contract_number}}")
    short.add_paragraph(OWN_CLAUSES[0])
    kind = classify(supplier_contract(), templates=[_save(short)])
    assert kind.verdict == VERDICT_UNCLEAR
    assert kind.reasons[0] == REASON_TEMPLATES_NOT_COMPARABLE
    assert REASON_TEMPLATES_UNAVAILABLE not in kind.reasons


def test_our_inn_in_customer_block_does_not_hide_a_supplier_contract() -> None:
    data = supplier_contract(customer=["Заказчик:", OUR_NAME, f"ИНН {OUR_INN}", SIGNATURE])
    assert classify(data).verdict == VERDICT_SUPPLIER


def test_unsupported_container_is_refused() -> None:
    from pragmatika_documents.docx_amend import AmendError

    with pytest.raises(AmendError) as raised:
        classify(b"%PDF-1.4 not a docx")
    assert raised.value.code == "unsupported_format"


# ---------------------------------------------------------------- маршрут


def _post(client: TestClient, data: bytes, **body: Any) -> Any:
    payload = {
        "file_name": "Договор.docx",
        "content_base64": base64.b64encode(data).decode("ascii"),
        "own_inns": [OUR_INN],
        "own_names": [OUR_NAME],
        "templates_base64": [base64.b64encode(our_template()).decode("ascii")],
        **body,
    }
    return client.post("/docx/classify", json=payload)


def test_route_returns_verdict_and_reason_codes_only(client: TestClient) -> None:
    response = _post(client, supplier_contract())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["verdict"] == VERDICT_SUPPLIER
    assert body["converted_from"] is None
    # В ответе нет ни названий, ни ИНН документа.
    assert SUPPLIER_INN not in response.text and "Исполнитель-Тест" not in response.text


def test_route_for_our_document(client: TestClient) -> None:
    assert _post(client, rendered_by_us()).json()["verdict"] == VERDICT_OWN_TEMPLATE


def test_route_limits_the_number_of_templates(client: TestClient) -> None:
    many = [base64.b64encode(our_template()).decode("ascii")] * 9
    assert _post(client, supplier_contract(), templates_base64=many).status_code == 422


def test_route_refuses_non_docx(client: TestClient) -> None:
    response = _post(client, b"plain text, not a document")
    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "unsupported_format"
