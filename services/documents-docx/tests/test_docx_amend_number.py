"""Тесты правки номера договора в POST /docx/amend (параметр `number_edit`, решение 19.11.2026).

По умолчанию номер не меняется (это проверяют старые тесты); здесь - явная просьба: допись
(`append`, в том числе составной номер) и замена (`replace`), форматирование run, неоднозначный и
не найденный номер, отказы на плохой тексте и защита сверки от любых других правок.
Все договоры синтетические (`make_contract_fixtures.title_contract`).
"""

from __future__ import annotations

import base64
import io
from typing import Any

import docx
import pytest
from fastapi.testclient import TestClient

from documents.limits import DocumentLimits
from make_contract_fixtures import title_contract
from pragmatika_documents import docx_amend
from pragmatika_documents.docx_amend import (
    AmendError,
    NumberEdit,
    OwnRequisites,
    amend_counterparty_contract,
)

LIMITS = DocumentLimits()
OUR_NAME = "ООО «Наш-Заказчик»"
OWN = OwnRequisites(
    OUR_NAME, (OUR_NAME, "ИНН 7701001238 КПП 770101001", "Р/с 40702810712345678901")
)
APPEND = NumberEdit("append", "17/10")
PREAMBLE = (
    "ООО «Ромашка», именуемое в дальнейшем «Исполнитель», и ___________, "
    "именуемое в дальнейшем «Заказчик», заключили договор."
)
OUR_TAIL = " / 17/10"


def run_amend(
    data: bytes, edit: NumberEdit | None, own: OwnRequisites | None = OWN
) -> tuple[Any, Any]:
    """Правит договор напрямую и возвращает (документ результата, отчёт)."""
    result = amend_counterparty_contract(data, own, LIMITS, number_edit=edit)
    return docx.Document(io.BytesIO(result.content)), result.report


def title_of(document: Any, index: int = 0) -> Any:
    return document.paragraphs[index]


def run_formats(paragraph: Any) -> list[str]:
    """XML свойств каждого run абзаца: по нему видно, что форматирование не тронуто."""
    return [run._r.rPr.xml if run._r.rPr is not None else "" for run in paragraph.runs]


def refusal(data: bytes, edit: NumberEdit | None, own: OwnRequisites | None = OWN) -> str:
    with pytest.raises(AmendError) as raised:
        amend_counterparty_contract(data, own, LIMITS, number_edit=edit)
    return raised.value.code


# ---------------------------------------------------------------- append


def test_append_inside_one_run_keeps_runs_and_formatting() -> None:
    source = title_contract(("ДОГОВОР № 103/11-26 от 05.11.2026",))
    document, report = run_amend(source, APPEND)
    assert title_of(document).text == f"ДОГОВОР № 103/11-26{OUR_TAIL} от 05.11.2026"
    assert report.number_status == "appended"
    assert report.number_before == "103/11-26"
    assert report.number_after == f"103/11-26{OUR_TAIL}"
    original = title_of(docx.Document(io.BytesIO(source)))
    assert run_formats(title_of(document)) == run_formats(original)
    assert len(title_of(document).runs) == len(original.runs) == 1


def test_append_when_number_is_split_across_runs() -> None:
    runs = ("ДОГОВОР №", " 103/", "11-26 от 05.11.2026")
    source = title_contract(runs)
    document, report = run_amend(source, APPEND)
    title = title_of(document)
    assert title.text == f"ДОГОВОР № 103/11-26{OUR_TAIL} от 05.11.2026"
    # Допись легла в run, где стоит последний знак номера; число run и их форматирование прежние.
    texts = [run.text for run in title.runs]
    assert texts == ["ДОГОВОР №", " 103/", f"11-26{OUR_TAIL} от 05.11.2026"]
    assert run_formats(title) == run_formats(title_of(docx.Document(io.BytesIO(source))))
    assert report.number_status == "appended"


def test_append_at_run_boundary_inherits_number_formatting() -> None:
    """Номер оканчивается ровно на границе run: допись наследует форматирование номера."""
    runs = ("ДОГОВОР № ", "103/11-26", " от 05.11.2026")
    source = title_contract(runs)
    document, _ = run_amend(source, APPEND)
    title = title_of(document)
    texts = [run.text for run in title.runs]
    assert texts == ["ДОГОВОР № ", f"103/11-26{OUR_TAIL}", " от 05.11.2026"]
    assert title.runs[1].bold is False and title.runs[0].bold is True
    assert run_formats(title) == run_formats(title_of(docx.Document(io.BytesIO(source))))


@pytest.mark.parametrize(
    ("heading", "expected_before"),
    [
        ("ДОГОВОР ПОСТАВКИ № 103/11-26 от 05.11.2026", "103/11-26"),
        ("Договор поставки N А-15 от 05.11.2026", "А-15"),
        ("ДОГОВОР No 5/26 от 05.11.2026", "5/26"),
        ("ДОГОВОР №103/11-26 от 05.11.2026", "103/11-26"),
        ("Договор поставки А-15 от 05.11.2026", "А-15"),
        ("ДОГОВОР 103/11-26", "103/11-26"),
        ("Договор поставки № А-15.", "А-15"),
    ],
)
def test_append_for_different_title_shapes(heading: str, expected_before: str) -> None:
    document, report = run_amend(title_contract((heading,)), APPEND)
    assert report.number_status == "appended"
    assert report.number_before == expected_before
    assert f"{expected_before}{OUR_TAIL}" in title_of(document).text
    assert title_of(document).text.replace(OUR_TAIL, "", 1) == heading


def test_append_number_on_its_own_line_under_the_title() -> None:
    source = title_contract(("ДОГОВОР ПОСТАВКИ",), after=("№ 103/11-26",))
    document, report = run_amend(source, APPEND)
    assert title_of(document).text == "ДОГОВОР ПОСТАВКИ"
    assert title_of(document, 1).text == f"№ 103/11-26{OUR_TAIL}"
    assert report.number_status == "appended"


def test_append_to_composite_number_and_custom_separator() -> None:
    source = title_contract((f"ДОГОВОР № 103/11-26{OUR_TAIL} от 05.11.2026",))
    document, report = run_amend(source, NumberEdit("append", "5", " - "))
    assert title_of(document).text == f"ДОГОВОР № 103/11-26{OUR_TAIL} - 5 от 05.11.2026"
    assert report.number_before == f"103/11-26{OUR_TAIL}"


def test_append_is_idempotent() -> None:
    source = title_contract((f"ДОГОВОР № 103/11-26{OUR_TAIL} от 05.11.2026",))
    document, report = run_amend(source, APPEND)
    assert title_of(document).text == f"ДОГОВОР № 103/11-26{OUR_TAIL} от 05.11.2026"
    assert report.number_status == "unchanged"


def test_append_with_empty_separator_is_allowed() -> None:
    document, _ = run_amend(title_contract(("ДОГОВОР № 103",)), NumberEdit("append", "/А", ""))
    assert title_of(document).text == "ДОГОВОР № 103/А"


def test_same_number_repeated_in_the_title_is_edited_everywhere() -> None:
    source = title_contract(("ДОГОВОР № 103/11-26",), after=("Договор № 103/11-26 (далее)",))
    document, report = run_amend(source, APPEND)
    assert title_of(document, 0).text == f"ДОГОВОР № 103/11-26{OUR_TAIL}"
    assert title_of(document, 1).text == f"Договор № 103/11-26{OUR_TAIL} (далее)"
    assert report.number_status == "appended"


def test_references_in_the_text_are_not_numbers_of_the_contract() -> None:
    source = title_contract(
        ("ДОГОВОР № 3",),
        after=(
            "директор действует на основании доверенности № 15",
            "Приложение № 1 к Договору № 5",
        ),
    )
    document, report = run_amend(source, APPEND)
    assert [p.text for p in document.paragraphs[:3]] == [
        f"ДОГОВОР № 3{OUR_TAIL}",
        "директор действует на основании доверенности № 15",
        "Приложение № 1 к Договору № 5",
    ]
    assert report.number_status == "appended"


def test_soft_break_after_the_number_stays() -> None:
    document, _ = run_amend(title_contract(("ДОГОВОР № 103/11-26\nот 05.11.2026",)), APPEND)
    assert title_of(document).text == f"ДОГОВОР № 103/11-26{OUR_TAIL}\nот 05.11.2026"


def test_number_inside_a_simple_field_is_edited_in_place() -> None:
    """Номер в результате простого поля (`w:fldSimple`) правится в том же run."""
    from lxml import etree

    ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    source_doc = docx.Document()
    stub = source_doc.add_paragraph()
    stub._p.addnext(
        etree.fromstring(
            f'<w:p xmlns:w="{ns}"><w:r><w:t xml:space="preserve">ДОГОВОР № </w:t></w:r>'
            '<w:fldSimple w:instr="SEQ n"><w:r><w:rPr><w:b/></w:rPr><w:t>103/11-26</w:t></w:r>'
            '</w:fldSimple><w:r><w:t xml:space="preserve"> от 05.11.2026</w:t></w:r></w:p>'
        )
    )
    stub._p.getparent().remove(stub._p)
    buffer = io.BytesIO()
    source_doc.save(buffer)
    document, report = run_amend(buffer.getvalue(), APPEND, own=None)
    # python-docx не читает текст внутри w:fldSimple, поэтому читаем тем же кодом, что и сервис.
    assert docx_amend._text(title_of(document)._p) == f"ДОГОВОР № 103/11-26{OUR_TAIL} от 05.11.2026"
    assert report.number_status == "appended"


# ---------------------------------------------------------------- replace


def test_replace_in_one_run_keeps_formatting() -> None:
    source = title_contract(("Договор поставки № А-15 от 05.11.2026",))
    document, report = run_amend(source, NumberEdit("replace", "Б-7/26"))
    assert title_of(document).text == "Договор поставки № Б-7/26 от 05.11.2026"
    assert report.number_status == "replaced"
    assert (report.number_before, report.number_after) == ("А-15", "Б-7/26")
    original = title_of(docx.Document(io.BytesIO(source)))
    assert run_formats(title_of(document)) == run_formats(original)


def test_replace_number_split_across_runs() -> None:
    runs = ("ДОГОВОР № 1", "03/11", "-26 от 05.11.2026")
    source = title_contract(runs)
    document, _ = run_amend(source, NumberEdit("replace", "Б-7"))
    title = title_of(document)
    assert title.text == "ДОГОВОР № Б-7 от 05.11.2026"
    assert len(title.runs) == 3
    assert run_formats(title) == run_formats(title_of(docx.Document(io.BytesIO(source))))


def test_replace_composite_number_as_a_whole() -> None:
    source = title_contract((f"ДОГОВОР № 103/11-26{OUR_TAIL} от 05.11.2026",))
    document, report = run_amend(source, NumberEdit("replace", "5"))
    assert title_of(document).text == "ДОГОВОР № 5 от 05.11.2026"
    assert report.number_before == f"103/11-26{OUR_TAIL}"


def test_replace_with_the_same_number_is_unchanged() -> None:
    source = title_contract(("ДОГОВОР № 5 от 05.11.2026",))
    document, report = run_amend(source, NumberEdit("replace", "5"))
    assert title_of(document).text == "ДОГОВОР № 5 от 05.11.2026"
    assert report.number_status == "unchanged"


def test_replace_fills_a_placeholder_number_but_append_does_not() -> None:
    source = title_contract(("ДОГОВОР № ______ от 05.11.2026",))
    document, report = run_amend(source, NumberEdit("replace", "17/10"))
    assert title_of(document).text == "ДОГОВОР № 17/10 от 05.11.2026"
    assert report.number_status == "replaced"
    document, report = run_amend(source, APPEND)
    assert title_of(document).text == "ДОГОВОР № ______ от 05.11.2026"
    assert report.number_status == "not_found"
    assert "number" in report.not_found


# ---------------------------------------------------------------- ambiguous / not_found


def test_ambiguous_number_is_not_edited_but_requisites_are() -> None:
    source = title_contract(("ДОГОВОР № 5",), after=("Договор № 6 заключён",))
    document, report = run_amend(source, APPEND)
    assert title_of(document, 0).text == "ДОГОВОР № 5"
    assert title_of(document, 1).text == "Договор № 6 заключён"
    assert report.number_status == "ambiguous"
    assert report.number_before is None and report.number_after is None
    assert "number" in report.not_found
    assert report.customer_block_filled
    assert any("несколько" in note for note in report.notes)


def test_number_not_found_keeps_everything_and_reports_it() -> None:
    source = title_contract(
        ("ДОГОВОР ПОСТАВКИ от 05.11.2026",), after=("по доверенности № 15 директор",)
    )
    document, report = run_amend(source, NumberEdit("replace", "17/10"))
    assert title_of(document, 0).text == "ДОГОВОР ПОСТАВКИ от 05.11.2026"
    assert title_of(document, 1).text == "по доверенности № 15 директор"
    assert report.number_status == "not_found"
    assert "number" in report.not_found
    assert report.customer_block_filled
    assert any("Номер договора" in note for note in report.notes)


def test_number_far_from_the_title_is_not_a_contract_number() -> None:
    filler = tuple(f"Пункт {i} текста" for i in range(docx_amend.TITLE_SCAN_PARAGRAPHS + 2))
    source = title_contract(("ДОГОВОР ПОСТАВКИ",), after=(*filler, "Договор № 5 далее"))
    _, report = run_amend(source, APPEND)
    assert report.number_status == "not_found"


@pytest.mark.parametrize(
    "heading", ["Договор поставки от 05.11.2026", "ДОГОВОР 2026", "Договор от 5 ноября"]
)
def test_date_or_year_is_not_taken_for_a_number(heading: str) -> None:
    _, report = run_amend(title_contract((heading,)), APPEND)
    assert report.number_status == "not_found"


# ---------------------------------------------------------------- без запроса номера


def test_without_number_edit_there_are_no_number_fields_and_number_is_kept() -> None:
    source = title_contract()
    document, report = run_amend(source, None)
    assert title_of(document).text == "ДОГОВОР ПОСТАВКИ № 103/11-26 от 05.11.2026"
    assert report.number_status is None
    assert not any(key.startswith("number") for key in report.as_dict())


def test_number_only_call_without_requisites_is_allowed() -> None:
    document, report = run_amend(title_contract(), APPEND, own=None)
    assert title_of(document).text == f"ДОГОВОР ПОСТАВКИ № 103/11-26{OUR_TAIL} от 05.11.2026"
    assert not report.customer_block_filled
    assert report.not_found == []
    table_text = "\n".join(p.text for p in document.tables[0].cell(0, 1).paragraphs)
    assert "7701001238" not in table_text


def test_nothing_to_do_without_requisites_and_number_edit() -> None:
    assert refusal(title_contract(), None, own=None) == "nothing_to_do"


# ---------------------------------------------------------------- проверка текста и отказы


@pytest.mark.parametrize(
    "edit",
    [
        NumberEdit("append", ""),
        NumberEdit("append", "   "),
        NumberEdit("replace", "1\n2"),
        NumberEdit("replace", "1\r2"),
        NumberEdit("replace", "1\x002"),
        NumberEdit("append", "1 2"),
        NumberEdit("append", "1​2"),
        NumberEdit("replace", "x" * 61),
        NumberEdit("append", "5", "\n"),
        NumberEdit("append", "5", "-" * 11),
        NumberEdit("swap", "5"),
    ],
)
def test_bad_number_text_is_refused(edit: NumberEdit) -> None:
    assert refusal(title_contract(), edit) == "bad_request"


def test_text_of_exactly_sixty_characters_is_accepted() -> None:
    text = "7" * 60
    document, _ = run_amend(title_contract(), NumberEdit("replace", text))
    assert f"№ {text} от" in title_of(document).text


def test_other_edit_next_to_the_number_edit_is_caught(monkeypatch: pytest.MonkeyPatch) -> None:
    """Сверка допускает ровно запрошенную правку: любая иная в тот же проход - отказ."""
    original = docx_amend._execute_number_edit

    def greedy(plan: Any, edit: NumberEdit) -> None:
        original(plan, edit)
        # Заодно трогаем текст исполнителя в другом абзаце.
        body = plan.edits[0][0].paragraph.getparent()
        victim = next(t for t in body.iter(docx_amend.W_T) if t.text == "ООО «Ромашка»")
        victim.text = "ООО «Изменено»"

    monkeypatch.setattr(docx_amend, "_execute_number_edit", greedy)
    assert refusal(title_contract(), APPEND) == "verification_failed"


def test_wrong_number_text_in_the_result_is_caught(monkeypatch: pytest.MonkeyPatch) -> None:
    """Код вписал не то, что просили: результат не отдаётся."""
    monkeypatch.setattr(docx_amend, "_insert_at", lambda paragraph, position, new: None)
    assert refusal(title_contract(), APPEND) == "verification_failed"


def test_verify_accepts_only_the_expected_number_edit() -> None:
    before = ["ДОГОВОР № 103/11-26 / 17/10 от 05.11.2026", "Исполнитель: ООО «Ромашка»"]
    docx_amend.verify_text_preserved(before, list(before), set())
    with pytest.raises(AmendError):
        docx_amend.verify_text_preserved(
            before, ["ДОГОВОР № 103/11-26 / 17/11 от 05.11.2026", before[1]], set()
        )
    with pytest.raises(AmendError):
        lost_tail = ["ДОГОВОР № 103/11-26 от 05.11.2026", before[1]]
        docx_amend.verify_numbers_preserved(before, lost_tail)


# ---------------------------------------------------------------- HTTP


def post(client: TestClient, data: bytes, **body: Any) -> Any:
    payload = {
        "file_name": "Договор.docx",
        "content_base64": base64.b64encode(data).decode("ascii"),
        **body,
    }
    return client.post("/docx/amend", json=payload)


def own_json() -> dict[str, Any]:
    return {"name": OUR_NAME, "lines": list(OWN.lines)}


def test_route_returns_number_fields(client: TestClient) -> None:
    response = post(
        client,
        title_contract(preamble=PREAMBLE),
        own_requisites=own_json(),
        number_edit={"mode": "append", "text": "17/10"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["number_status"] == "appended"
    assert body["number_before"] == "103/11-26"
    assert body["number_after"] == f"103/11-26{OUR_TAIL}"
    assert body["not_found"] == []
    result = docx.Document(io.BytesIO(base64.b64decode(body["content_base64"])))
    assert result.paragraphs[0].text.startswith(f"ДОГОВОР ПОСТАВКИ № 103/11-26{OUR_TAIL}")


def test_route_custom_separator_and_replace(client: TestClient) -> None:
    response = post(
        client,
        title_contract(),
        number_edit={"mode": "replace", "text": "Б-1", "separator": "|"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["number_status"] == "replaced"
    assert "customer_block_filled" in response.json()


@pytest.mark.parametrize(
    "edit",
    [
        {"mode": "append", "text": ""},
        {"mode": "append", "text": "a\nb"},
        {"mode": "x", "text": "5"},
    ],
)
def test_route_refuses_bad_number_edit_in_the_usual_style(
    client: TestClient, edit: dict[str, str]
) -> None:
    response = post(client, title_contract(), own_requisites=own_json(), number_edit=edit)
    assert response.status_code == 422
    assert response.json()["detail"] == {"error": "bad_request"}


def test_route_refuses_unknown_party(client: TestClient) -> None:
    response = post(client, title_contract(), own_requisites=own_json(), party="buyer")
    assert response.status_code == 422
    assert response.json()["detail"] == {"error": "bad_request"}


def test_route_without_number_edit_keeps_old_response_shape(client: TestClient) -> None:
    response = post(client, title_contract(), own_requisites=own_json(), our_number="7/10")
    body = response.json()
    assert response.status_code == 200
    assert not any(key.startswith("number") for key in body)
    assert body["party"] == "customer"
    assert isinstance(body["not_found"], list)
