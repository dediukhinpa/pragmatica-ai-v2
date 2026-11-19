"""Пишет синтетические docx для контрактного теста адаптера v2: `make_contract_fixtures.py <каталог>`.

Файлы строятся программно (синтетика, без данных заказчика) теми же построителями, что и тесты
маршрутов. Запуск не требует pytest: нужны python-docx и пакет `pragmatika_documents` в пути.
"""

from __future__ import annotations

import io
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import docx
from docx.shared import Pt

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_contract_kind import OUR_INN, OUR_NAME, our_template, supplier_contract  # noqa: E402
from test_docx_amend import OUR_LINES, make_contract  # noqa: E402
from test_docx_signatory import _template as signatory_template  # noqa: E402


def _rtf_escape(text: str) -> str:
    """Экранирует текст для RTF: не ASCII - в виде `\\uN?` (знаковое 16-битное число)."""
    parts: list[str] = []
    for char in text:
        code = ord(char)
        if char in "\\{}":
            parts.append("\\" + char)
        elif code < 128:
            parts.append(char)
        else:
            parts.append(f"\\u{code - 65536 if code > 32767 else code}?")
    return "".join(parts)


def rtf_contract() -> bytes:
    """Договор в RTF с пустым блоком заказчика (проверка конвертации LibreOffice)."""
    lines = [
        "ДОГОВОР № 1/ТЕСТ-26 от 05.11.2026",
        "ООО «Исполнитель-Тест», именуемое «Исполнитель», и "
        "___________________, именуемое «Заказчик», заключили договор.",
        "Заказчик:",
        "",
        "ИНН ________ КПП ________",
        "Р/с ____________",
        "БИК _______",
    ]
    body = "".join(f"\\pard {_rtf_escape(line)}\\par\n" for line in lines)
    head = "{\\rtf1\\ansi\\ansicpg1251\\deff0\\uc1{\\fonttbl{\\f0 Arial;}}\n"
    return (head + body + "}").encode("ascii")


DEFAULT_TITLE_RUNS = ("ДОГОВОР ПОСТАВКИ № ", "103/11-26", " от 05.11.2026")
BLANK_CUSTOMER = ("Заказчик:", "", "ИНН ________ КПП ________", "Р/с ____________")
FILLED_EXECUTOR = (
    "Исполнитель:",
    "ООО «Ромашка»",
    "ИНН 1111111111 КПП 222222222",
    "Р/с 40702810000000000001",
)
SIGNATURE_LINE = "Генеральный директор ________ / ______ / М.П."


def _fill_cell(cell: Any, lines: Sequence[str]) -> None:
    cell.paragraphs[0].text = lines[0]
    for line in lines[1:]:
        cell.add_paragraph(line)


def title_contract(
    runs: Sequence[str] = DEFAULT_TITLE_RUNS,
    *,
    before: Sequence[str] = (),
    after: Sequence[str] = (),
    preamble: str | None = None,
    executor: Sequence[str] | None = (*FILLED_EXECUTOR, SIGNATURE_LINE),
    customer: Sequence[str] | None = (*BLANK_CUSTOMER, SIGNATURE_LINE),
) -> bytes:
    """Договор для проверок номера и сторон: заголовок из заданных run и таблица реквизитов.

    Каждый run заголовка форматирован по-своему (шрифт, размер, полужирный через один, курсив
    у последнего): так проверяется, что правка номера не пересобирает абзац. Строки `before`
    идут до заголовка, `after` - после преамбулы. Вымышленные названия, без данных заказчика.

    Args:
        runs: Тексты run абзаца-заголовка.
        before: Абзацы до заголовка.
        after: Абзацы между преамбулой и таблицей.
        preamble: Текст преамбулы; None - без неё.
        executor: Строки блока исполнителя в ячейке таблицы; None - блока нет.
        customer: Строки блока заказчика; None - блока нет.
    """
    document = docx.Document()
    for text in before:
        document.add_paragraph(text)
    title = document.add_paragraph()
    for index, text in enumerate(runs):
        run = title.add_run(text)
        run.bold = index % 2 == 0
        run.italic = index == len(runs) - 1 and len(runs) > 1
        run.font.name = "Arial"
        run.font.size = Pt(12 + index)
    if preamble is not None:
        document.add_paragraph(preamble)
    for text in after:
        document.add_paragraph(text)
    cols = [lines for lines in (executor, customer) if lines is not None]
    if cols:
        table = document.add_table(rows=1, cols=len(cols))
        for index, lines in enumerate(cols):
            _fill_cell(table.cell(0, index), lines)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


# Имя файла -> байты. Имена зашиты в контрактный тест адаптера.
FIXTURES = {
    "contract.docx": make_contract,
    "signatory-template.docx": signatory_template,
    "own-template.docx": our_template,
    "supplier.docx": supplier_contract,
    "contract.rtf": rtf_contract,
    "contract-numbered.docx": title_contract,
}
# Параметры для теста вынесены в JSON, чтобы тест не знал внутренностей построителей.
META = {"ownName": OUR_NAME, "ownInn": OUR_INN, "ownLines": OUR_LINES}


def main(argv: list[str]) -> int:
    """Пишет фикстуры и meta.json в каталог из argv[1]."""
    import json

    if len(argv) != 2:
        print("использование: make_contract_fixtures.py <каталог>", file=sys.stderr)
        return 2
    target = Path(argv[1])
    target.mkdir(parents=True, exist_ok=True)
    for name, build in FIXTURES.items():
        (target / name).write_bytes(build())
    (target / "meta.json").write_text(json.dumps(META, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
