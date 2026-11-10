"""Прайс xlsx сложной формы: несколько листов, объединённые ячейки (этап 111, e2e скриптов).

Запуск: python make_form_price.py <файл.xlsx> <json-спецификация>. Спецификация:
{"sheets": [{"title": "Лист", "rows": [[ячейка, ...], ...], "merges": ["B3:B4", ...]}]}.
Строки пишутся на лист как есть; объединения применяются после записи (значение остаётся в
левой верхней ячейке, как у Excel). Данные только синтетические.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from openpyxl import Workbook


def main(target: Path, spec: dict[str, list]) -> None:
    """Записывает книгу: по листу на каждый элемент спецификации."""
    book = Workbook()
    book.remove(book.active)
    for sheet_spec in spec["sheets"]:
        sheet = book.create_sheet(sheet_spec["title"])
        for row in sheet_spec["rows"]:
            sheet.append(row)
        for merged in sheet_spec.get("merges", []):
            sheet.merge_cells(merged)
    target.parent.mkdir(parents=True, exist_ok=True)
    book.save(target)


if __name__ == "__main__":
    main(Path(sys.argv[1]), json.loads(sys.argv[2]))
