"""Пределы и константы договорных ручек `/docx/*`.

Раньше жили в платформенном `documents.limits` прежнего сервиса; в платформе 1.1.x их нет,
поэтому значения (замеренные тогда же) хранятся здесь, а платформенные `DocumentLimits`
остаются как есть.
"""

from __future__ import annotations

from dataclasses import replace

from documents.limits import DocumentLimits

MIB = 1024 * 1024

# Договорные ручки правят docx через python-docx: дерево разметки целиком в памяти. У них свои
# пределы разметки, ниже общих: договор - десятки страниц текста и таблиц, а не прайс. Замер
# (синтетика на python-docx): договор на 300 разделов с таблицами (около 450 страниц) - 6,7 МиБ
# разметки и 237 тыс. узлов; пустой шаблон python-docx уже даёт 47 тыс. узлов и 0,8 МиБ.
CONTRACT_MAX_XML_BYTES = 8 * MIB
CONTRACT_MAX_XML_NODES = 300_000

# Метка в свойстве «Категория» документов, собранных нашим шаблоном (`DOCUMENTS_RENDER_CATEGORY`
# боевого сервиса): по ней `/docx/classify` узнаёт собственный шаблон. Должна совпадать со
# значением, которое ставит `/render` платформы.
OWN_DOCUMENT_MARKER = "pragmatika-own-document"

# Договорные задания идут в своём месте сверх слотов разбора; число берётся из платформенной
# настройки конвертации (она читает и прежнее имя `DOCUMENTS_CONTRACT_CONCURRENCY`).
DEFAULT_CONTRACT_CONCURRENCY = 1


def contract_limits(limits: DocumentLimits) -> DocumentLimits:
    """Лимиты договорных ручек: разметка и узлы не выше договорных пределов.

    Берётся меньшее из общего и договорного значения: если владелец опустил общий предел ниже
    договорного, договор не получает больше, чем остальные документы.

    Args:
        limits: Общие лимиты сервиса.

    Returns:
        Копия лимитов с суженными пределами разметки.
    """
    return replace(
        limits,
        max_xml_bytes=min(limits.max_xml_bytes, CONTRACT_MAX_XML_BYTES),
        max_xml_nodes=min(limits.max_xml_nodes, CONTRACT_MAX_XML_NODES),
    )
