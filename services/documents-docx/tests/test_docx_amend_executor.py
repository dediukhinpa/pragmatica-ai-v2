"""Тесты реквизитов исполнителя (`party=executor`) и списка «не найдено» в POST /docx/amend.

`party=executor` вписывает значения в блок исполнителя/поставщика только в пустые места и
заполнители: существующий текст не затирается, поверх заполненного блока ничего не
добавляется. Отчёт перечисляет, чего найти не удалось (`not_found` + `notes`).
Договоры синтетические (`make_contract_fixtures.title_contract`), названия вымышленные.
"""

from __future__ import annotations

import base64
import io
from typing import Any

import docx
import pytest
from fastapi.testclient import TestClient

from documents.limits import DocumentLimits
from make_contract_fixtures import BLANK_CUSTOMER, FILLED_EXECUTOR, SIGNATURE_LINE, title_contract
from pragmatika_documents import docx_amend
from pragmatika_documents.docx_amend import (
    AmendError,
    NumberEdit,
    OwnRequisites,
    amend_counterparty_contract,
)

LIMITS = DocumentLimits()
SUPPLIER = "ООО «Тюльпан»"
SUPPLIER_LINES = (
    SUPPLIER,
    "ИНН 3333333333 КПП 444444444",
    "Р/с 40702810999999999999",
    "в АО «Тест-Банк»",
    "Юридический адрес: 620026, г. Тестов, ул. Образцовая, д. 2",
)
SUPPLIER_OWN = OwnRequisites(SUPPLIER, SUPPLIER_LINES)
OUR_NAME = "ООО «Наш-Заказчик»"
OUR_OWN = OwnRequisites(
    OUR_NAME, (OUR_NAME, "ИНН 7701001238 КПП 770101001", "Р/с 40702810712345678901")
)
BLANK_EXECUTOR = ("Исполнитель:", "", "ИНН ________ КПП ________", "Р/с ____________")
PREAMBLE_EXECUTOR_FIRST = (
    "___________, именуемое в дальнейшем «Исполнитель», и ООО «Альфа», "
    "именуемое в дальнейшем «Заказчик», заключили договор."
)


def amend(data: bytes, own: OwnRequisites | None, **kwargs: Any) -> tuple[Any, Any]:
    result = amend_counterparty_contract(data, own, LIMITS, **kwargs)
    return docx.Document(io.BytesIO(result.content)), result.report


def cell(document: Any, col: int) -> list[str]:
    return [p.text for p in document.tables[0].cell(0, col).paragraphs]


def all_lines(document: Any) -> list[str]:
    lines = [p.text for p in document.paragraphs]
    for table in document.tables:
        for row in table.rows:
            for item in row.cells:
                lines.extend(p.text for p in item.paragraphs)
    return lines


def refusal(data: bytes, own: OwnRequisites | None, **kwargs: Any) -> str:
    with pytest.raises(AmendError) as raised:
        amend_counterparty_contract(data, own, LIMITS, **kwargs)
    return raised.value.code


# ---------------------------------------------------------------- пустой блок исполнителя


def test_empty_executor_block_is_filled_and_customer_block_untouched() -> None:
    source = title_contract(executor=(*BLANK_EXECUTOR, SIGNATURE_LINE))
    document, report = amend(source, SUPPLIER_OWN, party="executor")
    executor = cell(document, 0)
    assert executor[0] == "Исполнитель:"
    assert executor[1] == SUPPLIER
    assert "ИНН 3333333333 КПП 444444444" in executor
    assert "Р/с 40702810999999999999" in executor
    assert "в АО «Тест-Банк»" in executor
    assert executor[-1] == SIGNATURE_LINE
    # Блок заказчика (с заполнителями) остался как был.
    assert cell(document, 1) == [*BLANK_CUSTOMER, SIGNATURE_LINE]
    assert report.party == "executor"
    assert report.party_block_filled and not report.customer_block_filled
    assert report.placeholders_filled >= 1 and report.lines_added >= 1


def test_default_party_is_customer_and_leaves_the_executor_block_alone() -> None:
    source = title_contract(executor=(*BLANK_EXECUTOR, SIGNATURE_LINE))
    document, report = amend(source, OUR_OWN)
    assert cell(document, 0) == [*BLANK_EXECUTOR, SIGNATURE_LINE]
    assert "7701001238" in "\n".join(cell(document, 1))
    assert report.party == "customer" and report.customer_block_filled


def test_executor_requisites_in_a_block_with_only_the_heading() -> None:
    source = title_contract(executor=("Поставщик:", SIGNATURE_LINE))
    document, _ = amend(source, SUPPLIER_OWN, party="executor")
    block = cell(document, 0)
    assert block[0] == "Поставщик:" and block[1] == SUPPLIER and block[-1] == SIGNATURE_LINE
    assert len(block) == 2 + len(SUPPLIER_LINES)


# ---------------------------------------------------------------- существующий текст не трогается


def test_partly_filled_executor_block_gets_only_labelled_placeholders() -> None:
    executor = (
        "Исполнитель:",
        "ООО «Ромашка»",
        "ИНН ________ КПП ________",
        "Р/с ________",
        "Факс ________",
        "",
        "Адрес: г. Образцовый",
        SIGNATURE_LINE,
    )
    source = title_contract(executor=executor)
    document, report = amend(source, SUPPLIER_OWN, party="executor")
    assert cell(document, 0) == [
        "Исполнитель:",
        "ООО «Ромашка»",
        "ИНН 3333333333 КПП 444444444",
        "Р/с 40702810999999999999",
        "Факс ________",
        "",
        "Адрес: г. Образцовый",
        SIGNATURE_LINE,
    ]
    assert report.placeholders_filled == 3
    assert report.lines_added == 0
    assert report.unfilled_placeholders == 1
    assert any("незаполненные поля" in note for note in report.notes)
    # Блок найден и подпись есть; не найдена только преамбула (в фикстуре её нет).
    assert report.not_found == ["preamble"]


def test_filled_executor_block_is_left_untouched_with_a_note() -> None:
    source = title_contract(executor=(*FILLED_EXECUTOR, SIGNATURE_LINE))
    document, report = amend(source, SUPPLIER_OWN, party="executor")
    assert cell(document, 0) == [*FILLED_EXECUTOR, SIGNATURE_LINE]
    assert report.placeholders_filled == 0 and report.lines_added == 0
    assert not report.party_block_filled
    assert "placeholders" in report.not_found
    assert any("уже заполнен" in note for note in report.notes)
    original = docx.Document(io.BytesIO(source))
    assert all_lines(document) == all_lines(original)


def test_blank_line_inside_a_filled_block_is_not_filled() -> None:
    executor = ("Исполнитель:", "ООО «Ромашка»", "", "ИНН 1111111111", SIGNATURE_LINE)
    document, report = amend(title_contract(executor=executor), SUPPLIER_OWN, party="executor")
    assert cell(document, 0) == list(executor)
    assert report.placeholders_filled == 0 and "placeholders" in report.not_found


def test_empty_signature_block_is_not_filled_when_the_real_block_is_filled() -> None:
    """Подпись под отдельным заголовком «Исполнитель:» не принимается за пустой блок реквизитов."""
    source = title_contract(
        executor=(*FILLED_EXECUTOR, SIGNATURE_LINE),
        after=("Исполнитель:", SIGNATURE_LINE),
    )
    document, report = amend(source, SUPPLIER_OWN, party="executor")
    body = [p.text for p in document.paragraphs]
    assert body[-2:] == ["Исполнитель:", SIGNATURE_LINE]
    assert report.lines_added == 0 and report.placeholders_filled == 0


def test_executor_block_not_found_is_reported_without_refusal() -> None:
    source = title_contract(executor=None)
    document, report = amend(source, SUPPLIER_OWN, party="executor")
    assert "party_block" in report.not_found
    assert cell(document, 0) == [*BLANK_CUSTOMER, SIGNATURE_LINE]
    assert any("исполнителя" in note for note in report.notes)


def test_executor_placeholders_we_cannot_fill_do_not_refuse_the_file() -> None:
    """У заказчика такие поля дают отказ; у исполнителя - только счёт в отчёте."""
    source = title_contract(executor=("Исполнитель:", "ООО «Ромашка»", "Факс ________"))
    _, report = amend(source, SUPPLIER_OWN, party="executor")
    assert report.unfilled_placeholders == 1


# ---------------------------------------------------------------- преамбула исполнителя


def test_preamble_placeholder_of_the_executor_is_filled() -> None:
    source = title_contract(preamble=PREAMBLE_EXECUTOR_FIRST, executor=None)
    document, report = amend(source, SUPPLIER_OWN, party="executor")
    expected = f"{SUPPLIER}, именуемое в дальнейшем «Исполнитель»"
    assert document.paragraphs[1].text.startswith(expected)
    assert report.preamble_filled
    assert "preamble" not in report.not_found


def test_preamble_placeholder_after_and_is_filled_for_the_executor() -> None:
    text = (
        "ООО «Альфа», именуемое в дальнейшем «Заказчик», и ___________, именуемое в "
        "дальнейшем «Исполнитель», заключили договор."
    )
    document, report = amend(title_contract(preamble=text), SUPPLIER_OWN, party="executor")
    assert f"и {SUPPLIER}, именуемое в дальнейшем «Исполнитель»" in document.paragraphs[1].text
    assert report.preamble_filled


def test_customer_placeholder_in_preamble_is_not_filled_for_the_executor() -> None:
    text = (
        "ООО «Ромашка», именуемое в дальнейшем «Исполнитель», и ___________, именуемое в "
        "дальнейшем «Заказчик», заключили договор."
    )
    document, report = amend(title_contract(preamble=text), SUPPLIER_OWN, party="executor")
    assert document.paragraphs[1].text == text
    assert not report.preamble_filled
    assert "preamble" in report.not_found


def test_executor_placeholder_is_not_filled_by_the_customer_mode() -> None:
    document, report = amend(title_contract(preamble=PREAMBLE_EXECUTOR_FIRST), OUR_OWN)
    assert document.paragraphs[1].text == PREAMBLE_EXECUTOR_FIRST
    assert not report.preamble_filled


# ---------------------------------------------------------------- «не найдено» в отчёте


def test_not_found_lists_missing_preamble_and_signature_line_for_the_customer() -> None:
    source = title_contract(customer=("Заказчик:", "", "ИНН ________ КПП ________"))
    _, report = amend(source, OUR_OWN)
    assert set(report.not_found) == {"preamble", "signature_line"}
    assert len(report.notes) == 2
    assert all(any("а" <= ch.lower() <= "я" for ch in note) for note in report.notes)


def test_not_found_is_empty_when_everything_was_found() -> None:
    preamble = (
        "ООО «Ромашка», именуемое «Исполнитель», и ___________, именуемое «Заказчик», "
        "заключили договор."
    )
    _, report = amend(title_contract(preamble=preamble), OUR_OWN)
    assert report.not_found == []
    assert report.notes == []


def test_not_found_combines_number_and_other_codes() -> None:
    source = title_contract(("ДОГОВОР ПОСТАВКИ",), customer=("Заказчик:", "", "ИНН ________"))
    _, report = amend(source, OUR_OWN, number_edit=NumberEdit("append", "5"))
    assert report.not_found == ["number", "preamble", "signature_line"]
    assert len(report.notes) == 3


def test_executor_and_number_edit_together() -> None:
    source = title_contract(
        executor=(*BLANK_EXECUTOR, SIGNATURE_LINE), preamble=PREAMBLE_EXECUTOR_FIRST
    )
    document, report = amend(
        source, SUPPLIER_OWN, party="executor", number_edit=NumberEdit("append", "17/10")
    )
    assert document.paragraphs[0].text == "ДОГОВОР ПОСТАВКИ № 103/11-26 / 17/10 от 05.11.2026"
    assert report.number_status == "appended" and report.preamble_filled
    assert cell(document, 0)[1] == SUPPLIER
    assert report.not_found == []


# ---------------------------------------------------------------- защита


def test_text_of_the_executor_changed_by_mistake_is_caught(monkeypatch: pytest.MonkeyPatch) -> None:
    original = docx_amend._place_lines

    def greedy(block: Any, own: Any, used: Any, report: Any) -> Any:
        result = original(block, own, used, report)
        victim = next(
            t for t in block.heading.getparent().iter(docx_amend.W_T) if t.text == SIGNATURE_LINE
        )
        victim.text = "Подпись изменена"
        return result

    monkeypatch.setattr(docx_amend, "_place_lines", greedy)
    source = title_contract(executor=(*BLANK_EXECUTOR, SIGNATURE_LINE))
    assert refusal(source, SUPPLIER_OWN, party="executor") == "verification_failed"


def test_unknown_party_is_a_bad_request() -> None:
    assert refusal(title_contract(), OUR_OWN, party="buyer") == "bad_request"


# ---------------------------------------------------------------- HTTP


def test_route_executor_and_report_fields(client: TestClient) -> None:
    data = title_contract(executor=(*BLANK_EXECUTOR, SIGNATURE_LINE))
    response = client.post(
        "/docx/amend",
        json={
            "file_name": "Договор.docx",
            "content_base64": base64.b64encode(data).decode("ascii"),
            "party": "executor",
            "own_requisites": {"name": SUPPLIER, "lines": list(SUPPLIER_LINES)},
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["party"] == "executor"
    assert body["party_block_filled"] is True
    assert body["customer_block_filled"] is False
    assert body["not_found"] == ["preamble"]
    assert len(body["notes"]) == 1
    assert not any(key.startswith("number") for key in body)
    result = docx.Document(io.BytesIO(base64.b64decode(body["content_base64"])))
    assert SUPPLIER in cell(result, 0)
