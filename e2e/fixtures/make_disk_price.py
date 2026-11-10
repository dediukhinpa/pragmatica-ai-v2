"""Прайс xlsx для сценария первичного импорта с диска.

Запуск: python make_disk_price.py <файл.xlsx> <json-спецификация>. Спецификация:
{"header": ["строка шапки", ...], "rows": [["артикул", "название", цена, "валюта"], ...]}.
Строки шапки идут первыми, затем пустая строка и заголовок таблицы.

Ячейка может быть формулой с кэшированным значением, как у Excel:
{"f": "800/3", "v": "266.666666666667"} - формула и значение, которое Excel сохранил в файле.
"""

from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path

from openpyxl import Workbook

TABLE_HEADER = ["Артикул", "Наименование", "Цена", "Валюта"]
SHEET_XML = "xl/worksheets/sheet1.xml"
# openpyxl пишет формулу без кэша: `<c r="C7"><f>800/3</f><v></v></c>` или `<v />`.
FORMULA_CELL_RE = re.compile(r'(<c r="([A-Z]+\d+)"[^>]*>)<f>([^<]*)</f>(?:<v\s*/>|<v></v>)')


def cache_formulas(target: Path, cached: dict[str, str]) -> None:
    """Дописывает в книгу кэш формул: openpyxl сам его не пишет, а Excel сохраняет всегда."""
    if not cached:
        return
    tmp = target.with_suffix(".tmp")
    with zipfile.ZipFile(target) as src, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename == SHEET_XML:
                xml = data.decode("utf-8")
                xml = FORMULA_CELL_RE.sub(
                    lambda m: f"{m[1]}<f>{m[3]}</f><v>{cached[m[2]]}</v>"
                    if m[2] in cached
                    else m[0],
                    xml,
                )
                data = xml.encode("utf-8")
            dst.writestr(item, data)
    tmp.replace(target)


def main(target: Path, spec: dict[str, list]) -> None:
    """Записывает книгу с шапкой, пустой строкой, заголовком таблицы и позициями."""
    book = Workbook()
    sheet = book.active
    sheet.title = "Прайс"
    for line in spec["header"]:
        sheet.append([line])
    sheet.append([])
    sheet.append(TABLE_HEADER)
    cached: dict[str, str] = {}
    for row in spec["rows"]:
        plain = []
        for cell in row:
            if isinstance(cell, dict):
                plain.append(f"={cell['f']}")
                # Адрес ячейки известен только после добавления строки.
                cached[f"{chr(ord('A') + len(plain) - 1)}{sheet.max_row + 1}"] = cell["v"]
            else:
                plain.append(cell)
        sheet.append(plain)
    target.parent.mkdir(parents=True, exist_ok=True)
    book.save(target)
    cache_formulas(target, cached)


if __name__ == "__main__":
    main(Path(sys.argv[1]), json.loads(sys.argv[2]))
