"""Доработки дополнения договора по ревью этапа 227: сценарии, на которых правка была неверной.

Договоры строятся программно (синтетика). Каждый тест здесь был красным до правки
`docx_amend.py` и описывает одну находку ревью.
"""

from __future__ import annotations

import base64
import dataclasses
import io
import re
import time
from typing import Any, Callable

import docx
import pytest
from fastapi.testclient import TestClient

from pragmatika_documents.docx_amend import (
    AmendError,
    OwnRequisites,
    amend_counterparty_contract,
    verify_text_preserved,
)
from documents.limits import DocumentLimits
from documents.models import DocumentTooLargeError

OUR_NAME = "ООО «Наш-Заказчик»"
OUR_LINES = (
    OUR_NAME,
    "ИНН 7701001238 КПП 770101001",
    "Р/счет 40702810712345678901",
    "в Тест-Банк ПАО",
    "БИК 049900001",
    "Юридический адрес: 620026, г. Екатеринбург, ул. Тестовая, д. 1",
    "тел. (343) 000-00-00",
)
OWN = OwnRequisites(OUR_NAME, OUR_LINES)
LIMITS = DocumentLimits()
TITLE = "ДОГОВОР ПОСТАВКИ № 103/11-26"


def build(make: Callable[[Any], None]) -> bytes:
    document = docx.Document()
    make(document)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def fill_cell(cell: Any, lines: list[str]) -> None:
    cell.paragraphs[0].text = lines[0]
    for line in lines[1:]:
        cell.add_paragraph(line)


def one_row(document: Any, executor: list[str], customer: list[str]) -> Any:
    table = document.add_table(rows=1, cols=2)
    fill_cell(table.cell(0, 0), executor)
    fill_cell(table.cell(0, 1), customer)
    return table


def amend(data: bytes, own: OwnRequisites | None = OWN) -> tuple[Any, Any]:
    result = amend_counterparty_contract(data, own, LIMITS)
    return docx.Document(io.BytesIO(result.content)), result.report


def refusal(data: bytes, own: OwnRequisites | None = OWN) -> str:
    with pytest.raises(AmendError) as raised:
        amend_counterparty_contract(data, own, LIMITS)
    return raised.value.code


def cell_lines(document: Any, row: int, col: int) -> list[str]:
    cell = document.tables[0].cell(row, col)
    return [line for p in cell.paragraphs for line in p.text.split("\n")]


# ---------------------------------------------------------------- 1-2. номер не меняется


def test_numbers_of_every_kind_stay_byte_identical() -> None:
    """Номер договора, доверенности и приложения: ни один не тронут (номер не наш)."""

    def make(d: Any) -> None:
        d.add_paragraph("ДОГОВОР ПОСТАВКИ")
        d.add_paragraph("№ 103/11-26")
        d.add_paragraph("директор действует на основании доверенности № 15")
        d.add_paragraph("Приложение № 1 к Договору № 5")
        one_row(d, ["Поставщик:", "ООО «Альфа»"], ["Покупатель:", ""])

    source = build(make)
    document, _ = amend(source)
    before = [p.text for p in docx.Document(io.BytesIO(source)).paragraphs]
    after = [p.text for p in document.paragraphs]
    assert after == before


def test_title_with_the_same_tail_or_with_our_number_already_in_it_is_untouched() -> None:
    for title in (TITLE, f"{TITLE} / 26", "ДОГОВОР № 1026"):
        document, _ = amend(build(lambda d, t=title: (d.add_paragraph(t), one_row(
            d, ["Поставщик:", "ООО «Альфа»"], ["Покупатель:", ""]
        ))))
        assert document.paragraphs[0].text == title


def test_response_has_no_number_fields(client: TestClient) -> None:
    data = build(lambda d: (d.add_paragraph(TITLE), one_row(
        d, ["Поставщик:", "ООО «Альфа»"], ["Покупатель:", ""]
    )))
    response = client.post(
        "/docx/amend",
        json={
            "file_name": "Д.docx",
            "content_base64": base64.b64encode(data).decode("ascii"),
            "own_requisites": {"name": OUR_NAME, "lines": list(OUR_LINES)},
        },
    )
    assert response.status_code == 200
    assert not any(key.startswith("number") for key in response.json())


# ---------------------------------------------------------------- 3. реквизиты во второй строке


def two_row(header: tuple[str, str], executor: list[str], customer: list[str]) -> bytes:
    def make(d: Any) -> None:
        d.add_paragraph(TITLE)
        table = d.add_table(rows=2, cols=2)
        table.cell(0, 0).text, table.cell(0, 1).text = header
        fill_cell(table.cell(1, 0), executor)
        fill_cell(table.cell(1, 1), customer)

    return build(make)


def test_header_row_then_requisites_row_fills_the_cell_below() -> None:
    data = two_row(
        ("Поставщик", "Покупатель"),
        ["ООО «Альфа»", "ИНН 1111111111"],
        ["ИНН ________", "КПП ________", "Р/с ________"],
    )
    document, _ = amend(data)
    assert document.tables[0].cell(0, 1).text == "Покупатель"
    lines = cell_lines(document, 1, 1)
    assert lines[0] == OUR_NAME
    assert "ИНН 7701001238" in lines and "КПП 770101001" in lines
    assert "Р/с 40702810712345678901" in lines
    assert cell_lines(document, 1, 0) == ["ООО «Альфа»", "ИНН 1111111111"]


def test_header_row_with_empty_cell_below_gets_lines_into_that_cell() -> None:
    data = two_row(("Поставщик:", "Покупатель:"), ["ООО «Альфа»"], [""])
    document, _ = amend(data)
    assert document.tables[0].cell(0, 1).text == "Покупатель:"
    assert cell_lines(document, 1, 1)[0] == OUR_NAME
    assert "ИНН 7701001238 КПП 770101001" in cell_lines(document, 1, 1)


def test_placeholders_we_cannot_fill_refuse_the_file() -> None:
    data = two_row(
        ("Поставщик", "Покупатель"), ["ООО «Альфа»"], ["ИНН ________", "Факс ________"]
    )
    assert refusal(data) == "customer_placeholders_unfilled"


# ---------------------------------------------------------------- 4. преамбула


PREAMBLE_TEXT = (
    "ООО «Альфа», именуемое в дальнейшем «Поставщик», в лице директора Иванова, с одной "
    "стороны, и ______________ в лице ______________, действующего на основании "
    "____________, именуемое в дальнейшем «Покупатель», с другой стороны"
)


def test_preamble_fills_the_party_name_not_the_basis() -> None:
    def make(d: Any) -> None:
        d.add_paragraph(TITLE)
        d.add_paragraph(PREAMBLE_TEXT)
        one_row(d, ["Поставщик:", "ООО «Альфа»"], ["Покупатель:", ""])

    document, report = amend(build(make))
    text = document.paragraphs[1].text
    assert f"с одной стороны, и {OUR_NAME} в лице ______________" in text
    assert "действующего на основании ____________," in text
    assert report.preamble_filled


def test_preamble_without_placeholder_after_and_is_left_alone() -> None:
    def make(d: Any) -> None:
        d.add_paragraph(TITLE)
        d.add_paragraph(
            "ООО «Альфа» и ООО «Бета», действующего на основании ____________, "
            "именуемое «Покупатель»"
        )
        one_row(d, ["Поставщик:", "ООО «Альфа»"], ["Покупатель:", ""])

    document, report = amend(build(make))
    assert "на основании ____________," in document.paragraphs[1].text
    assert not report.preamble_filled


# ---------------------------------------------------------------- 6. метка + заполнитель


def test_label_with_placeholder_is_a_slot_not_a_filled_block() -> None:
    def make(d: Any) -> None:
        d.add_paragraph(TITLE)
        one_row(
            d,
            ["Поставщик:", "ООО «Альфа»"],
            ["Покупатель:", "ИНН/КПП ________", "Адрес: ________", "Банк: ________"],
        )

    document, _ = amend(build(make))
    lines = cell_lines(document, 0, 1)
    assert "ИНН/КПП 7701001238/770101001" in lines
    assert any(line.startswith("Адрес: 620026") for line in lines)
    assert "Банк: Тест-Банк ПАО" in lines
    assert not any("____" in line for line in lines)


def test_label_with_placeholder_without_our_value_has_its_own_refusal_code() -> None:
    def make(d: Any) -> None:
        d.add_paragraph(TITLE)
        one_row(
            d, ["Поставщик:", "ООО «Альфа»"], ["Покупатель:", "ИНН ________", "E-mail: ________"]
        )

    assert refusal(build(make)) == "customer_placeholders_unfilled"


def test_tab_and_underscore_lines_are_placeholders() -> None:
    def make(d: Any) -> None:
        d.add_paragraph(TITLE)
        one_row(
            d,
            ["Поставщик:", "ООО «Альфа»"],
            ["Покупатель:", "\t\t", "_ _ _ _", "ИНН\t________"],
        )

    document, _ = amend(build(make))
    lines = [line.strip() for line in cell_lines(document, 0, 1)]
    assert lines[1] == OUR_NAME
    assert "ИНН7701001238" in " ".join(re.sub(r"\s+", "", line) for line in lines)


def test_real_text_in_the_block_still_refuses_as_filled() -> None:
    def make(d: Any) -> None:
        d.add_paragraph(TITLE)
        one_row(d, ["Поставщик:", "ООО «Альфа»"], ["Покупатель:", "ООО «Чужое»"])

    assert refusal(build(make)) == "customer_block_filled"


# ---------------------------------------------------------------- 10. мягкий перенос


def test_soft_line_breaks_in_requisites_paragraph_are_separate_lines() -> None:
    def make(d: Any) -> None:
        d.add_paragraph(TITLE)
        table = d.add_table(rows=1, cols=2)
        table.cell(0, 0).text = "Поставщик:\nООО «Альфа»\nИНН 1111111111"
        table.cell(0, 1).text = "Покупатель:\n\nИНН ________\nКПП ________"

    document, _ = amend(build(make))
    assert cell_lines(document, 0, 0) == ["Поставщик:", "ООО «Альфа»", "ИНН 1111111111"]
    lines = [line for line in cell_lines(document, 0, 1) if line.strip()]
    assert lines[0] == "Покупатель:"
    assert lines[1] == OUR_NAME
    assert "ИНН 7701001238" in lines and "КПП 770101001" in lines


def test_soft_break_after_the_number_stays_as_it_was() -> None:
    def make(d: Any) -> None:
        d.add_paragraph("ДОГОВОР № 103/11-26\nот 05.11.2026")
        one_row(d, ["Поставщик:", "ООО «Альфа»"], ["Покупатель:", ""])

    document, _ = amend(build(make))
    assert document.paragraphs[0].text == "ДОГОВОР № 103/11-26\nот 05.11.2026"


# ---------------------------------------------------------------- 12. сверка


def test_verify_rejects_deleting_a_dash_or_slash_of_the_executor_number() -> None:
    before = ["ДОГОВОР № 1/ТЕСТ-26"]
    for broken in ("ДОГОВОР № 1/ТЕСТ26", "ДОГОВОР № 1ТЕСТ-26", "ДОГОВОР № 1/ТЕСТ-26."):
        with pytest.raises(AmendError):
            verify_text_preserved(before, [broken], {"7/10"})
    with pytest.raises(AmendError):
        verify_text_preserved(["Дата 05.11.2026"], ["Дата 05112026"], set())


def test_verify_rejects_part_or_glue_of_our_values() -> None:
    before = ["ДОГОВОР № 1/ТЕСТ-26", "ИНН ________"]
    with pytest.raises(AmendError):  # кусок нашего номера
        verify_text_preserved(before, ["ДОГОВОР № 1/ТЕСТ-26 / 7/1", before[1]], {"7/10"})
    with pytest.raises(AmendError):  # склейка двух разных значений
        verify_text_preserved(
            before, [before[0], "ИНН 7701001238770101001"], {"7701001238", "770101001"}
        )
    with pytest.raises(AmendError):  # кусок, пересекающий границу значений
        verify_text_preserved(before, [before[0], "ИНН 1238770"], {"7701001238", "770101001"})


def test_verify_accepts_placeholder_replaced_by_value() -> None:
    verify_text_preserved(
        ["ДОГОВОР № 1/ТЕСТ-26", "ИНН ________ КПП ________"],
        ["ДОГОВОР № 1/ТЕСТ-26", "ИНН 7701001238 КПП 770101001"],
        {"7701001238", "770101001"},
    )


# ---------------------------------------------------------------- 13. время и квадратичный случай


def test_verification_of_a_huge_document_is_fast() -> None:
    lines = ["Пункт договора без изменений"] * 20_000
    before = [TITLE, *lines, "ИНН ________"]
    after = [TITLE, *lines, "ИНН 7701001238"]
    started = time.monotonic()
    verify_text_preserved(before, after, {"7701001238"})
    assert time.monotonic() - started < 2.0


def test_verification_of_a_huge_changed_paragraph_is_bounded() -> None:
    old = "аб" * 4_000 + " ________ " + "ба" * 4_000
    new = "ба" * 4_000 + " 7701001238 " + "аб" * 4_000
    started = time.monotonic()
    with pytest.raises(AmendError):
        verify_text_preserved([old], [new], {"7701001238"})
    assert time.monotonic() - started < 2.0


def test_archive_check_honours_the_deadline() -> None:
    expired = dataclasses.replace(DocumentLimits(), max_ooxml_seconds=-1.0)
    data = build(lambda d: d.add_paragraph(TITLE))
    with pytest.raises(DocumentTooLargeError):
        amend_counterparty_contract(data, OWN, expired)


# ---------------------------------------------------------------- прочее


def test_refusal_code_for_unfilled_placeholders_reaches_the_client(client: TestClient) -> None:
    data = two_row(("Поставщик", "Покупатель"), ["ООО «Альфа»"], ["Факс ________"])
    response = client.post(
        "/docx/amend",
        json={
            "file_name": "Д.docx",
            "content_base64": base64.b64encode(data).decode("ascii"),
            "own_requisites": {"name": OUR_NAME, "lines": list(OUR_LINES)},
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "customer_placeholders_unfilled"


def test_party_block_reads_soft_break_cell_and_cell_below_header() -> None:
    from pragmatika_documents.docx_amend import read_party_block

    soft = build(
        lambda d: setattr(
            d.add_table(rows=1, cols=1).cell(0, 0),
            "text",
            "Заказчик:\nООО «Наш»\nИНН 7701001238\nГенеральный директор ____ /____/",
        )
    )
    block = read_party_block(soft, "Заказчик", LIMITS)
    assert block.lines == ("ООО «Наш»", "ИНН 7701001238")
    below = two_row(("Исполнитель", "Заказчик"), ["ООО «Чужое»"], ["ООО «Наш»", "ИНН 7701001238"])
    assert read_party_block(below, "Заказчик", LIMITS).lines == ("ООО «Наш»", "ИНН 7701001238")


def test_section_break_stays_on_the_last_paragraph_after_split() -> None:
    from lxml import etree

    from pragmatika_documents.docx_amend import _split_soft_breaks, _text

    namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    body = etree.fromstring(
        f'<w:body xmlns:w="{namespace}"><w:p><w:pPr><w:jc w:val="left"/><w:sectPr/></w:pPr>'
        "<w:r><w:rPr><w:b/></w:rPr><w:t>первая</w:t><w:br/><w:t>вторая</w:t></w:r>"
        '<w:r><w:br w:type="page"/><w:t>после страницы</w:t></w:r></w:p></w:body>'
    )
    pieces = _split_soft_breaks(body[0])
    assert [_text(piece) for piece in pieces] == ["первая", "вторая" + "после страницы"]
    assert [len(piece.findall(f".//{{{namespace}}}sectPr")) for piece in pieces] == [0, 1]
    assert all(piece.find(f".//{{{namespace}}}b") is not None for piece in pieces[:1])
