"""Дымовая проверка сборки договора по HTTP на синтетических docx (патч G8, без данных заказчика).

Запускается ВНУТРИ образа documents (там есть python-docx) в сетевом пространстве запущенного
контейнера documents: `python smoke_contract.py http://127.0.0.1:8310`. Документы строятся здесь
же программно, значения вымышленные. Проверяются четыре проектных маршрута цепочкой, как её
вызывает app: amend (наши реквизиты в сторону заказчика) -> party-block (блок читается обратно) ->
replace-signatory (подписант нашей стороны) -> classify (чужой договор распознан).

Печатает по строке на шаг (`OK <шаг>` или `FAIL <шаг>: <причина без данных>`), последняя строка -
`result=OK` либо `result=FAIL`. Код выхода: 0 - все шаги прошли, 1 - есть провал.
"""

from __future__ import annotations

import base64
import io
import json
import sys
import urllib.error
import urllib.request
import zipfile
from typing import Any

import docx

TIMEOUT_S = 60
HTTP_OK = 200
DOCX_MAGIC = b"PK"
OWN_NAME = "ООО «Смоук-Заказчик»"
OWN_INN = "7701009990"
OWN_LINES = [OWN_NAME, f"ИНН {OWN_INN} КПП 770101001", "Р/счет 40702810700000000001"]
SIGNATURE = "Генеральный директор ________ / ______ / М.П."
NEW_SIGNATORY = {
    "nominative_short": "Образцов А.С.",
    "nominative_reversed": "А.С. Образцов",
    "genitive_full": "Образцова Андрея Сергеевича",
    "genitive_short": "Образцова А.С.",
}


def _save(document: Any) -> bytes:
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def executor_contract() -> bytes:
    """Договор исполнителя с пустым блоком заказчика (как у поставщика)."""
    document = docx.Document()
    document.add_paragraph("ДОГОВОР № 1/СМОУК-26 от 05.11.2026")
    document.add_paragraph(
        "ООО «Исполнитель-Смоук», именуемое «Исполнитель», и ___________________, "
        "именуемое «Заказчик», заключили договор."
    )
    table = document.add_table(rows=1, cols=2)
    left, right = table.cell(0, 0), table.cell(0, 1)
    left.paragraphs[0].text = "Исполнитель:"
    for line in ("ООО «Исполнитель-Смоук»", "ИНН 7702002220", SIGNATURE):
        left.add_paragraph(line)
    right.paragraphs[0].text = "Заказчик:"
    for line in ("", "ИНН ________ КПП ________", "Р/с ____________", "", SIGNATURE):
        right.add_paragraph(line)
    return _save(document)


def signatory_template() -> bytes:
    """Наш шаблон договора с напечатанным подписантом (якоря «в лице ... действующего»)."""
    document = docx.Document()
    document.add_paragraph(
        "Общество, именуемое «Заказчик», в лице генерального директора Тестова Ивана "
        "Петровича, действующего на основании Устава, заключило договор."
    )
    document.add_paragraph("Генеральный директор ______/Тестов И.П.")
    document.add_paragraph("______/И.П. Тестов")
    return _save(document)


def own_template() -> bytes:
    """Наш шаблон с метками: по нему сервис отличает чужой договор от собранного нами."""
    document = docx.Document()
    document.add_paragraph("ДОГОВОР ПОСТАВКИ № {{contract_number}}")
    document.add_paragraph(
        "{{supplier_name}}, именуемое «Поставщик», и " + OWN_NAME + ", именуемое «Покупатель», "
        "заключили настоящий договор."
    )
    for index in range(1, 11):
        document.add_paragraph(
            f"{index}. Покупатель обязуется принять и оплатить товар в порядке, установленном "
            f"пунктом {index} настоящего договора, в сроки, согласованные сторонами."
        )
    table = document.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "Поставщик:\n{{supplier_name}}\nИНН {{supplier_inn}}"
    table.cell(0, 1).text = f"Покупатель:\n{OWN_NAME}\nИНН {OWN_INN}"
    return _save(document)


def post(base: str, route: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """POST JSON; возвращает (код, тело-словарь). Тело ошибки без данных документа."""
    request = urllib.request.Request(
        base + route,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read())
        except ValueError:
            return exc.code, {}


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def is_docx(content_base64: str) -> bool:
    raw = base64.b64decode(content_base64)
    return raw[:2] == DOCX_MAGIC and zipfile.is_zipfile(io.BytesIO(raw))


def run(base: str) -> list[tuple[str, str]]:
    """Шаги цепочки: список (шаг, пустая строка при успехе либо причина)."""
    results: list[tuple[str, str]] = []

    def step(name: str, problem: str) -> None:
        results.append((name, problem))

    status, amended = post(
        base,
        "/docx/amend",
        {
            "file_name": "Договор.docx",
            "content_base64": b64(executor_contract()),
            "own_requisites": {"name": OWN_NAME, "lines": OWN_LINES},
        },
    )
    amend_ok = status == HTTP_OK and is_docx(amended.get("content_base64", ""))
    step("amend", "" if amend_ok else f"код {status}, docx не получен")
    step(
        "amend: блок заказчика заполнен",
        "" if amended.get("customer_block_filled") is True else "customer_block_filled не true",
    )
    if amend_ok:
        status, block = post(
            base,
            "/docx/party-block",
            {"content_base64": amended["content_base64"], "role": "Заказчик"},
        )
        step(
            "party-block читает блок обратно",
            "" if status == HTTP_OK and block.get("name") == OWN_NAME else f"код {status}",
        )
    else:
        step("party-block читает блок обратно", "пропущен: amend не прошёл")
    status, replaced = post(
        base,
        "/docx/replace-signatory",
        {"content_base64": b64(signatory_template()), **NEW_SIGNATORY},
    )
    ok = status == HTTP_OK and replaced.get("replaced", 0) > 0
    step("replace-signatory", "" if ok else f"код {status}, подписант не заменён")
    status, verdict = post(
        base,
        "/docx/classify",
        {
            "file_name": "Договор.docx",
            "content_base64": b64(executor_contract()),
            "templates_base64": [b64(own_template())],
            "own_inns": [OWN_INN],
            "own_names": [OWN_NAME],
        },
    )
    ok = status == HTTP_OK and verdict.get("verdict") == "supplier"
    step("classify: чужой договор", "" if ok else f"код {status}, вердикт {verdict.get('verdict')}")
    return results


def main() -> int:
    base = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:8310"
    failed = 0
    for name, problem in run(base):
        if problem:
            failed += 1
            print(f"FAIL {name}: {problem}")
        else:
            print(f"OK {name}")
    print("result=OK" if failed == 0 else "result=FAIL")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
