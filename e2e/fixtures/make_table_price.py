"""Прайс xlsx из произвольной таблицы (этап 106: варианты, группы, тиражи).

Запуск: python make_table_price.py <файл.xlsx> <json-спецификация>. Спецификация:
{"rows": [[ячейка, ...], ...]} - строки пишутся на лист как есть, первой идёт шапка таблицы.
Данные только синтетические.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from openpyxl import Workbook


def main(target: Path, spec: dict[str, list]) -> None:
    """Записывает книгу с одним листом «Прайс» из строк спецификации."""
    book = Workbook()
    sheet = book.active
    sheet.title = "Прайс"
    for row in spec["rows"]:
        sheet.append(row)
    target.parent.mkdir(parents=True, exist_ok=True)
    book.save(target)


if __name__ == "__main__":
    main(Path(sys.argv[1]), json.loads(sys.argv[2]))
