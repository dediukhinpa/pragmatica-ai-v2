"""Тесты POST /docx/amend и /docx/party-block: дополнение договора исполнителя нашими данными.

Номер договора поставщика не меняется никогда (решение владельца 08.11.2026): параметра «наш
номер» нет, а номер в документе после правки побайтно тот же.

Договор исполнителя строится программно (синтетика): номер в заголовке разбит на run, преамбула
с заполнителем заказчика, таблица реквизитов сторон, строки подписи.
"""

from __future__ import annotations

import base64
import io
from typing import Any

import docx
import pytest
from fastapi.testclient import TestClient

from pragmatika_documents.docx_amend import (
    AmendError,
    verify_numbers_preserved,
    verify_text_preserved,
)

EXECUTOR_NUMBER = "1/ТЕСТ-26"
EXECUTOR_LINES = [
    "ООО «Исполнитель-Тест»",
    "ИНН 1111111111 КПП 222222222",
    "Р/с 40702810000000000001",
    "в АО «Тест-Банк»",
    "БИК 044525000",
]
OUR_NAME = "ООО «Наш-Заказчик»"
OUR_LINES = [
    OUR_NAME,
    "ИНН 7701001238 КПП 770101001",
    "Р/счет 40702810712345678901",
    "в Тест-Банк ПАО",
    "К/счет 30101810100000000001",
    "БИК 049900001",
    "Юридический адрес: 620026, г. Екатеринбург, ул. Тестовая, д. 1",
    "тел. (343) 000-00-00",
]
SIGNATURE = "Генеральный директор ________ / ______ / М.П."


def _cell_lines(cell: Any, lines: list[str]) -> None:
    cell.paragraphs[0].text = lines[0]
    for line in lines[1:]:
        cell.add_paragraph(line)


def make_contract(customer_lines: list[str] | None = None) -> bytes:
    """Договор исполнителя: номер, преамбула, таблица реквизитов с пустым блоком заказчика."""
    document = docx.Document()
    heading = document.add_paragraph()
    heading.add_run("ДОГОВОР №")
    heading.add_run(" 1/ТЕСТ-")
    heading.add_run("26 от 05.11.2026")
    document.add_paragraph(
        "ООО «Исполнитель-Тест», именуемое в дальнейшем «Исполнитель», и "
        "___________________, именуемое в дальнейшем «Заказчик», заключили договор."
    )
    document.add_paragraph("1. Исполнитель обязуется передать товар, Заказчик обязуется оплатить.")
    table = document.add_table(rows=1, cols=2)
    _cell_lines(table.cell(0, 0), ["Исполнитель:", *EXECUTOR_LINES, SIGNATURE])
    customer = customer_lines or [
        "Заказчик:",
        "",
        "ИНН ________ КПП ________",
        "Р/с ____________",
        "БИК _______",
        "",
        SIGNATURE,
    ]
    _cell_lines(table.cell(0, 1), customer)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def _post(client: TestClient, data: bytes, **body: Any) -> Any:
    payload = {
        "file_name": "Договор.docx",
        "content_base64": base64.b64encode(data).decode("ascii"),
        **body,
    }
    return client.post("/docx/amend", json=payload)


def _own() -> dict[str, Any]:
    return {"name": OUR_NAME, "lines": OUR_LINES}


def _document(resp: Any) -> docx.document.Document:
    assert resp.status_code == 200, resp.text
    return docx.Document(io.BytesIO(base64.b64decode(resp.json()["content_base64"])))


def _all_text(document: Any) -> str:
    parts = [p.text for p in document.paragraphs]
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                parts.extend(p.text for p in cell.paragraphs)
    return "\n".join(parts)


def _cell_text(document: Any, col: int) -> list[str]:
    return [p.text for p in document.tables[0].cell(0, col).paragraphs]


def test_executor_requisites_and_number_kept_ours_added(client: TestClient) -> None:
    resp = _post(client, make_contract(), own_requisites=_own())
    document = _document(resp)
    text = _all_text(document)
    # Номер исполнителя на месте и не дополнен нашим.
    assert document.paragraphs[0].text == f"ДОГОВОР № {EXECUTOR_NUMBER} от 05.11.2026"
    # Реквизиты исполнителя целы.
    executor = _cell_text(document, 0)
    assert executor[0] == "Исполнитель:"
    assert executor[1:6] == EXECUTOR_LINES
    # Наши реквизиты вписаны в сторону заказчика, а не в сторону исполнителя.
    customer = "\n".join(_cell_text(document, 1))
    assert customer.startswith("Заказчик:")
    for needle in ("7701001238", "770101001", "40702810712345678901", "049900001", OUR_NAME):
        assert needle in customer
        assert needle not in "\n".join(executor)
    assert "30101810100000000001" in customer
    assert "620026" in customer
    # Подпись заказчика осталась после реквизитов, преамбула получила наше наименование.
    assert customer.rstrip().endswith("М.П.")
    assert f"{OUR_NAME}, именуемое в дальнейшем «Заказчик»" in text
    assert "___________________" not in text


def test_customer_block_is_filled_in_place_and_in_order(client: TestClient) -> None:
    document = _document(_post(client, make_contract(), own_requisites=_own()))
    # Заполнители «ИНН ___» получили значения, остальные строки легли ниже, до подписи.
    assert _cell_text(document, 1) == [
        "Заказчик:",
        OUR_NAME,
        "ИНН 7701001238 КПП 770101001",
        "Р/с 40702810712345678901",
        "БИК 049900001",
        "в Тест-Банк ПАО",
        "К/счет 30101810100000000001",
        "Юридический адрес: 620026, г. Екатеринбург, ул. Тестовая, д. 1",
        "тел. (343) 000-00-00",
        "",
        SIGNATURE,
    ]


def test_report_flags(client: TestClient) -> None:
    resp = _post(client, make_contract(), own_requisites=_own())
    body = resp.json()
    assert not any(key.startswith("number") for key in body)
    assert body["converted_from"] is None
    assert body["customer_block_filled"] is True
    assert body["preamble_filled"] is True
    assert body["lines_added"] >= 1
    assert body["file_name"].endswith(".docx")


def test_requisites_only_keeps_number(client: TestClient) -> None:
    document = _document(_post(client, make_contract(), own_requisites=_own()))
    assert document.paragraphs[0].text == "ДОГОВОР № 1/ТЕСТ-26 от 05.11.2026"
    assert "7701001238" in "\n".join(_cell_text(document, 1))


def test_number_is_byte_identical_after_amend(client: TestClient) -> None:
    """Номер в документе после правки побайтно тот же: заголовок целиком, run за run."""
    source = make_contract()
    out = base64.b64decode(_post(client, source, own_requisites=_own()).json()["content_base64"])
    before = docx.Document(io.BytesIO(source)).paragraphs[0]
    after = docx.Document(io.BytesIO(out)).paragraphs[0]
    assert after.text.encode("utf-8") == before.text.encode("utf-8")
    assert [run.text for run in after.runs] == [run.text for run in before.runs]


def test_placeholder_number_is_left_as_is(client: TestClient) -> None:
    """Прочерк на месте номера исполнителя тоже не заменяется нашим: номер не наш."""
    document = docx.Document()
    document.add_paragraph("ДОГОВОР № ______ от 05.11.2026")
    document.add_paragraph("Заказчик:")
    document.add_paragraph("")
    buffer = io.BytesIO()
    document.save(buffer)
    out = _document(_post(client, buffer.getvalue(), own_requisites=_own()))
    assert out.paragraphs[0].text == "ДОГОВОР № ______ от 05.11.2026"


def test_old_call_with_our_number_is_ignored_and_logged(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    """Старый вызов с `our_number` не падает, номер не меняется, значения в журнале нет."""
    with caplog.at_level("WARNING"):
        resp = _post(client, make_contract(), our_number="7/10", own_requisites=_own())
    document = _document(resp)
    assert document.paragraphs[0].text == f"ДОГОВОР № {EXECUTOR_NUMBER} от 05.11.2026"
    assert "our_number" in caplog.text
    assert "7/10" not in caplog.text


def test_number_only_call_is_nothing_to_do(client: TestClient) -> None:
    """Без реквизитов делать нечего: «номер» больше не повод для правки."""
    resp = _post(client, make_contract(), our_number="7/10")
    assert resp.status_code == 422
    assert resp.json()["detail"]["error"] == "nothing_to_do"


def test_verify_numbers_catches_changed_or_lost_number() -> None:
    before = ["ДОГОВОР № 1/ТЕСТ-26 от 05.11.2026"]
    verify_numbers_preserved(before, ["ДОГОВОР № 1/ТЕСТ-26 от 05.11.2026", "ИНН 1"])
    with pytest.raises(AmendError) as raised:
        verify_numbers_preserved(before, ["ДОГОВОР № 1/ТЕСТ-26 / 7/10 от 05.11.2026"])
    assert raised.value.code == "verification_failed"
    with pytest.raises(AmendError):
        verify_numbers_preserved(before, ["ДОГОВОР от 05.11.2026"])


def test_customer_block_only_heading_gets_lines_after_it(client: TestClient) -> None:
    source = make_contract(["Заказчик:", SIGNATURE])
    customer = _cell_text(_document(_post(client, source, own_requisites=_own())), 1)
    assert customer[0] == "Заказчик:"
    assert customer[1] == OUR_NAME
    assert customer[-1] == SIGNATURE
    assert len(customer) == 2 + len(OUR_LINES)


def test_filled_customer_block_is_refused_and_nothing_written(client: TestClient) -> None:
    source = make_contract(["Заказчик:", "ООО «Чужой»", "ИНН 9999999999"])
    resp = _post(client, source, own_requisites=_own())
    assert resp.status_code == 422
    assert resp.json()["detail"]["error"] == "customer_block_filled"


def test_missing_customer_block_is_refused(client: TestClient) -> None:
    document = docx.Document()
    document.add_paragraph("ДОГОВОР № 5 от 05.11.2026")
    document.add_paragraph("Текст без реквизитов сторон.")
    buffer = io.BytesIO()
    document.save(buffer)
    resp = _post(client, buffer.getvalue(), own_requisites=_own())
    assert resp.status_code == 422
    assert resp.json()["detail"]["error"] == "customer_block_not_found"


def test_nothing_to_do_and_unsupported_format(client: TestClient) -> None:
    assert _post(client, make_contract()).json()["detail"]["error"] == "nothing_to_do"
    resp = _post(client, b"%PDF-1.4 not a docx", own_requisites=_own())
    assert resp.status_code == 422
    assert resp.json()["detail"]["error"] == "unsupported_format"


def test_untouched_parts_of_archive_stay_byte_identical(client: TestClient) -> None:
    import zipfile

    source = make_contract()
    out = base64.b64decode(
        _post(client, source, own_requisites=_own()).json()["content_base64"]
    )
    with zipfile.ZipFile(io.BytesIO(source)) as before, zipfile.ZipFile(io.BytesIO(out)) as after:
        assert set(before.namelist()) == set(after.namelist())
        for name in ("word/styles.xml", "word/settings.xml", "[Content_Types].xml"):
            assert before.read(name) == after.read(name)


def test_party_block_reads_customer_from_template(client: TestClient) -> None:
    template = make_contract(["Заказчик:", *OUR_LINES, "", SIGNATURE])
    resp = client.post(
        "/docx/party-block",
        json={"content_base64": base64.b64encode(template).decode("ascii"), "role": "Заказчик"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == OUR_NAME
    assert body["lines"] == OUR_LINES


def test_party_block_missing(client: TestClient) -> None:
    document = docx.Document()
    document.add_paragraph("Просто текст")
    buffer = io.BytesIO()
    document.save(buffer)
    resp = client.post(
        "/docx/party-block",
        json={
            "content_base64": base64.b64encode(buffer.getvalue()).decode("ascii"),
            "role": "Заказчик",
        },
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]["error"] == "customer_block_not_found"


# ---------------------------------------------------------------- сверка текста исполнителя

BEFORE = ["ДОГОВОР № 1/ТЕСТ-26", "Исполнитель: ООО «Исполнитель-Тест»", "ИНН ________"]


def test_verify_accepts_additions_and_placeholder_replacement() -> None:
    after = [
        "ДОГОВОР № 1/ТЕСТ-26",
        "Исполнитель: ООО «Исполнитель-Тест»",
        "ИНН 7701001238",
        OUR_NAME,
    ]
    verify_text_preserved(BEFORE, after, {"7701001238", OUR_NAME})


def test_verify_catches_deleted_executor_paragraph() -> None:
    after = [BEFORE[0], BEFORE[2]]
    with pytest.raises(AmendError) as raised:
        verify_text_preserved(BEFORE, after, {"7/10"})
    assert raised.value.code == "verification_failed"


def test_verify_catches_replaced_executor_number() -> None:
    after = ["ДОГОВОР № 7/10", BEFORE[1], BEFORE[2]]
    with pytest.raises(AmendError) as raised:
        verify_text_preserved(BEFORE, after, {"7/10"})
    assert raised.value.code == "verification_failed"


def test_verify_catches_executor_text_cut_inside_paragraph() -> None:
    after = [BEFORE[0], "Исполнитель:", BEFORE[2]]
    with pytest.raises(AmendError):
        verify_text_preserved(BEFORE, after, set())


def test_verify_catches_foreign_inserted_paragraph() -> None:
    after = [*BEFORE, "Посторонний абзац"]
    with pytest.raises(AmendError):
        verify_text_preserved(BEFORE, after, {OUR_NAME})
