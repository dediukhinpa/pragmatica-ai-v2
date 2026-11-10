"""Тестовые файлы для сквозного прогона: прайс xlsx, шаблоны docx, база знаний.

Запуск: python make_fixtures.py <каталог files>. Создаёт подкаталоги prices/, templates/, kb/.
Персональные данные здесь намеренные: тест проверяет, что они не доходят до модели.
"""

from __future__ import annotations

import sys
from pathlib import Path

from docx import Document
from openpyxl import Workbook

# ПДн менеджера и поставщика (те же значения, что ждёт тест в e2e/lib/pii.ts).
MANAGER_FULL_NAME = "Иванов Пётр Сергеевич"
MANAGER_SHORT_NAME = "Иванов П.С."
MANAGER_PHONE = "+7 (902) 123-45-67"
SUPPLIER_EMAIL = "p.ivanov@metalloprokat-example.ru"

PRICE_ROWS: list[tuple[str, str, float, str]] = [
    ("AR-001", "Арматура А500С d12", 62500.5, "руб"),
    ("AR-002", "Арматура А500С d16", 61800.0, "руб"),
    ("LS-010", "Лист стальной 3 мм", 71200.0, "руб"),
    ("TR-020", "Труба профильная 40x40", 68900.25, "руб"),
    ("UG-030", "Уголок равнополочный 50", 64300.0, "руб"),
]


def make_price_xlsx(path: Path) -> None:
    """Прайс с контактами в шапке и в колонтитулах."""
    wb = Workbook()
    ws = wb.active
    ws.title = "Прайс"
    ws.append(["Прайс-лист ООО Металлопрокат"])
    ws.append([f"Менеджер: {MANAGER_FULL_NAME}, тел. {MANAGER_PHONE}"])
    ws.append([f"E-mail для заказов: {SUPPLIER_EMAIL}"])
    ws.append([])
    ws.append(["Артикул", "Наименование", "Цена", "Валюта"])
    for row in PRICE_ROWS:
        ws.append(list(row))
    ws.oddHeader.center.text = f"Менеджер {MANAGER_SHORT_NAME} {MANAGER_PHONE}"
    ws.oddFooter.center.text = f"Заказы: {SUPPLIER_EMAIL}"
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)


def make_offer_template(path: Path) -> None:
    """Шаблон коммерческого предложения с плейсхолдерами и табличной строкой."""
    doc = Document()
    doc.add_paragraph("Коммерческое предложение № {{number}}")
    doc.add_paragraph("Дата {{issuedAt}}")
    doc.add_paragraph("Покупатель: {{buyer}}")
    doc.add_paragraph("Продавец: {{seller}}")
    table = doc.add_table(rows=2, cols=5)
    for cell, text in zip(
        table.rows[0].cells, ["№", "Наименование", "Кол-во", "Цена", "Сумма"], strict=True
    ):
        cell.text = text
    placeholders = [
        "{{items._n}}",
        "{{items.name}}",
        "{{items.quantity}}",
        "{{items.unitPrice}}",
        "{{items.sum}}",
    ]
    for cell, text in zip(table.rows[1].cells, placeholders, strict=True):
        cell.text = text
    doc.add_paragraph("Итого: {{total}} {{currency}}")
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(path)


def make_contract_template(path: Path) -> None:
    """Шаблон-«приманка»: другой вид документа, агент не должен его выбрать."""
    doc = Document()
    doc.add_paragraph("Договор поставки № {{number}} между {{buyer}} и {{seller}}")
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(path)


def make_knowledge(root: Path) -> None:
    """Файлы базы знаний: docx с уникальными словами для проверки полнотекстового поиска."""
    root.mkdir(parents=True, exist_ok=True)
    doc = Document()
    doc.add_heading("Регламент приёмки арматуры", level=1)
    doc.add_paragraph(
        "Приёмка арматуры на складе выполняется по сертификату качества. "
        "Партия без сертификата возвращается поставщику. Уникальноеслово: хризолит."
    )
    doc.save(root / "reglament_priemki.docx")
    doc = Document()
    doc.add_heading("Условия доставки", level=1)
    doc.add_paragraph(
        "Доставка металлопроката автотранспортом осуществляется в течение пяти рабочих дней. "
        "Разгрузка силами покупателя. Особая пометка: ляпис."
    )
    doc.save(root / "dostavka.docx")


def main() -> None:
    """Создаёт все фикстуры в каталоге из аргумента."""
    root = Path(sys.argv[1])
    make_price_xlsx(root / "prices" / "Прайс поставщика.xlsx")
    make_offer_template(root / "templates" / "Коммерческое предложение шаблон.docx")
    make_contract_template(root / "templates" / "Договор поставки шаблон.docx")
    make_knowledge(root / "kb")


if __name__ == "__main__":
    main()
