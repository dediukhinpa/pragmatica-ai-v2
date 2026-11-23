"""Признак «договор поставщика» кодом, а не суждением модели, для POST /docx/classify.

Режим «дополнить договор поставщика» (`docx_amend`) вписывает наши реквизиты в сторону заказчика и
ничего не трогает у исполнителя. Включать его можно только для договора поставщика. Раньше это
решала модель по просьбе сотрудника; теперь решает код по самому файлу (решение владельца
08.11.2026):

    договор поставщика = файл НЕ порождён нашими шаблонами
                         И сторона исполнителя в нём уже заполнена.

Файл порождён нашими шаблонами, если выполнено одно из:
1. в свойстве «Категория» стоит метка, которую ставит `render_docx` в собранные нами документы
   (`OWN_DOCUMENT_MARKER`); Word и LibreOffice сохраняют её при пересохранении;
2. большая часть неизменного текста одного из шаблонов реестра есть в файле (покрытие не ниже
   `OWN_COVERAGE`): так опознаются документы, собранные до появления метки, и сам пустой шаблон.
   Шаблоны ядро читает с шары и присылает в запросе (сервис их не монтирует).

Сторона исполнителя заполнена, если есть хотя бы одно из:
- в блоке «Исполнитель»/«Поставщик»/... есть ИНН (10 или 12 цифр) или готовая строка текста
  (не заполнитель и не подпись): наименование, адрес, банк;
- в преамбуле перед «именуемое «Исполнитель»» стоит наименование, а не заполнитель.

Наши ИНН и наименования (записи юрлиц из БД) нужны, чтобы не принять нашу сторону за
поставщика: если в блоке исполнителя стоят НАШИ данные, наша сторона - исполнитель (вердикт
`our_side_executor`, режим не подходит). Наименование ищется вхождением целых слов после
нормализации (кавычки, регистр, «ё», организационно-правовая форма убраны), ИНН - по цифрам
после метки «ИНН» (пробелы и дефисы внутри числа не мешают).

Вердикты:
- `supplier`: не наш шаблон, исполнитель заполнен. Режим включается.
- `own_template`: файл порождён нашими шаблонами. Режим не включается, вопрос не нужен.
- `our_side_executor`: наши данные в блоке исполнителя. Режим не включается.
- `unclear`: признак неоднозначен (шаблоны недоступны или не годятся для сравнения;
  сходство с шаблоном частичное; исполнитель не заполнен). Режим не включается, агент
  спрашивает сотрудника.

Значения документа в ответ и лог не попадают: только вердикт и коды причин.
"""

from __future__ import annotations

import hashlib
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from pragmatika_documents.docx_amend import (
    EXECUTOR_ROLES,
    HEAD_PARAGRAPHS,
    PLACEHOLDER_ONLY,
    PLACEHOLDER_RUN,
    _body_paragraphs,
    _candidate_blocks,
    _line_kind,
    _open,
    _paragraph_texts,
    _text,
    AmendError,
)
from documents.limits import Deadline, DocumentLimits
from documents.memory import release_memory
from documents.models import CorruptDocumentError
from pragmatika_documents.limits import OWN_DOCUMENT_MARKER

logger = logging.getLogger(__name__)

VERDICT_SUPPLIER = "supplier"
VERDICT_OWN_TEMPLATE = "own_template"
VERDICT_OUR_SIDE_EXECUTOR = "our_side_executor"
VERDICT_UNCLEAR = "unclear"

# Коды причин (машинные: агент и журнал, без значений).
REASON_OWN_MARKER = "own_marker"
REASON_TEMPLATE_MATCH = "template_match"
REASON_TEMPLATE_PARTIAL = "template_partial_match"
REASON_TEMPLATES_UNAVAILABLE = "templates_unavailable"
# Шаблоны прочитаны, но ни один не годится для сравнения (мало неизменного текста): это не
# «шаблоны недоступны», сотруднику так и говорится.
REASON_TEMPLATES_NOT_COMPARABLE = "templates_not_comparable"
REASON_EXECUTOR_INN = "executor_inn"
REASON_EXECUTOR_TEXT = "executor_text"
REASON_EXECUTOR_PREAMBLE = "executor_preamble_name"
REASON_EXECUTOR_EMPTY = "executor_not_filled"
REASON_OUR_DATA_IN_EXECUTOR = "our_data_in_executor_block"

# Доля неизменного текста шаблона, найденная в файле: от неё файл считается нашим / сходным.
# Собранный по шаблону документ содержит почти весь неизменный текст (замер на синтетике - 1,0),
# договор поставщика - ноль-единицы процентов общих формулировок. Пороги с большим зазором;
# подстроить по реальным образцам можно только владельцу (в отчёте помечено как вопрос).
OWN_COVERAGE = 0.6
PARTIAL_COVERAGE = 0.25
# Абзацы короче не считаются отпечатком: «1.», «Стороны», номера пунктов совпадают у всех.
MIN_FINGERPRINT_CHARS = 40
# Шаблон с меньшим числом неизменных абзацев для сравнения не годится (почти весь текст - метки).
MIN_TEMPLATE_PARAGRAPHS = 5
# Сколько отпечатков шаблонов хранится в памяти процесса (ключ - sha256 содержимого).
FINGERPRINT_CACHE_SIZE = 16
# Предел числа шаблонов в запросе и наших ИНН/наименований: защита от огромного тела.
MAX_TEMPLATES = 8
MAX_OWN_VALUES = 20
MAX_OWN_VALUE_CHARS = 300

# Число после метки «ИНН»: цифры могут быть разбиты пробелами и дефисами («6685 157 522»);
# число обрывается на первой букве, «/» или другой метке.
INN_AFTER_LABEL = re.compile(
    r"ИНН\s*(?:/\s*КПП)?\s*[:№]?\s*(?P<number>\d(?:[\d \t\u00a0\-\u2010-\u2015]*\d)?)"
)
INN_LENGTHS = (10, 12)
TEMPLATE_PLACEHOLDER = re.compile(r"\{\{")
ROLE_PATTERN = "|".join(EXECUTOR_ROLES)
# Наименование перед «, именуемое в дальнейшем «Исполнитель»» (с «в лице ...» между или без).
PREAMBLE_EXECUTOR = re.compile(
    rf"(?P<name>[^,;]{{3,200}}?)\s*,?\s*(?:в\s+лице[^«\"“„]{{0,200}}?,?\s*)?"
    rf"(?:действующ\w+[^«\"“„]{{0,100}}?,?\s*)?именуем\w+\s+(?:в\s+дальнейшем\s+)?"
    rf"[«\"“„]\s*(?:{ROLE_PATTERN})\s*[»\"”]",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ContractKind:
    """Итог классификации: вердикт и коды причин (значений документа нет)."""

    verdict: str
    reasons: tuple[str, ...]


def _normalize(text: str) -> str:
    """Для сравнения: регистр, «ё», пробелы."""
    return re.sub(r"\s+", " ", text.casefold().replace("ё", "е")).strip()


def _digits(text: str) -> str:
    return re.sub(r"\D+", "", text)


# Организационно-правовые формы: при сравнении наименований отбрасываются (полная и краткая
# записи одной организации различаются именно ими). Длинные формы раньше коротких.
LEGAL_FORMS = (
    "общество с ограниченной ответственностью",
    "публичное акционерное общество",
    "непубличное акционерное общество",
    "закрытое акционерное общество",
    "открытое акционерное общество",
    "акционерное общество",
    "индивидуальный предприниматель",
    "ооо",
    "пао",
    "нао",
    "зао",
    "оао",
    "ао",
    "ип",
)
LEGAL_FORMS_RE = re.compile(
    r"(?<!\w)(?:" + "|".join(re.escape(form) for form in LEGAL_FORMS) + r")(?!\w)"
)
# Короче этого наименование без формы для сравнения вхождением не годится: слишком много
# случайных совпадений с обычными словами.
MIN_OWN_NAME_CHARS = 3
# Ведущее «и» (и «с другой стороны») перед наименованием в преамбуле: это не часть названия.
PREAMBLE_LEAD = re.compile(
    r"^(?:(?:с\s+)?(?:одной|другой)\s+стороны\s*,?\s*)?и\s+", re.IGNORECASE
)


def _party_words(text: str) -> str:
    """Наименование словами: регистр, «ё», кавычки, знаки и ОПФ убраны, слова через пробел."""
    folded = re.sub(r"[^\w]+", " ", text.casefold().replace("ё", "е"))
    return re.sub(r"\s+", " ", LEGAL_FORMS_RE.sub(" ", folded)).strip()


def _contains_name(text: str, own_names: frozenset[str]) -> bool:
    """Наше наименование входит в строку целыми словами (после нормализации)."""
    haystack = f" {_party_words(text)} "
    return any(f" {name} " in haystack for name in own_names)


def _inns_in(line: str) -> tuple[str, ...]:
    """Числа после меток «ИНН» в строке: только цифры, пробелы и дефисы внутри убраны."""
    return tuple(_digits(found.group("number")) for found in INN_AFTER_LABEL.finditer(line))


_fingerprint_cache: dict[str, frozenset[str]] = {}


def _static_paragraphs(texts: Sequence[str]) -> frozenset[str]:
    """Нормализованные неизменные абзацы шаблона: без меток `{{...}}` и заполнителей."""
    result = set()
    for text in texts:
        if TEMPLATE_PLACEHOLDER.search(text) or PLACEHOLDER_RUN.search(text):
            continue
        normalized = _normalize(text)
        if len(normalized) >= MIN_FINGERPRINT_CHARS:
            result.add(normalized)
    return frozenset(result)


def _template_fingerprint(
    data: bytes, limits: DocumentLimits, deadline: Deadline
) -> frozenset[str]:
    """Отпечаток шаблона (по содержимому, с кэшем): неизменные абзацы тела."""
    key = hashlib.sha256(data).hexdigest()
    cached = _fingerprint_cache.get(key)
    if cached is not None:
        return cached
    document = _open(data, limits, deadline)
    fingerprint = _static_paragraphs(_paragraph_texts(document.element.body))
    # Дерево шаблона больше не нужно, а python-docx держит его в циклических ссылках: без явной
    # сборки до восьми шаблонов запроса копились бы в памяти одновременно с договором
    # (замер на пределах: +464 МиБ против +157 МиБ со сборкой).
    del document
    release_memory()
    if len(_fingerprint_cache) >= FINGERPRINT_CACHE_SIZE:
        _fingerprint_cache.pop(next(iter(_fingerprint_cache)))
    _fingerprint_cache[key] = fingerprint
    return fingerprint


def _coverage(file_paragraphs: frozenset[str], fingerprint: frozenset[str]) -> float:
    """Доля неизменных абзацев шаблона, найденная в файле."""
    return len(fingerprint & file_paragraphs) / len(fingerprint)


def _best_coverage(
    file_texts: Sequence[str],
    templates: Sequence[bytes],
    limits: DocumentLimits,
    deadline: Deadline,
) -> tuple[float | None, str]:
    """Лучшее покрытие по шаблонам и причина, если сравнить не с чем (покрытие None).

    Причина: `templates_unavailable` - шаблонов нет или ни один не открылся;
    `templates_not_comparable` - шаблоны открылись, но у каждого мало неизменного текста.
    """
    file_paragraphs = frozenset(_normalize(text) for text in file_texts)
    best: float | None = None
    opened = False
    for data in templates:
        try:
            fingerprint = _template_fingerprint(data, limits, deadline)
        except (AmendError, CorruptDocumentError):
            # Шаблон не открывается как docx: сравнивать с ним нечем, остальные шаблоны годятся.
            logger.warning("шаблон для сравнения не открылся")
            continue
        opened = True
        if len(fingerprint) < MIN_TEMPLATE_PARAGRAPHS:
            continue
        value = _coverage(file_paragraphs, fingerprint)
        best = value if best is None else max(best, value)
    return best, (REASON_TEMPLATES_NOT_COMPARABLE if opened else REASON_TEMPLATES_UNAVAILABLE)


@dataclass(frozen=True)
class _Executor:
    """Что найдено в стороне исполнителя (без значений)."""

    reasons: tuple[str, ...]
    ours: bool


def _executor_side(
    body: Any, own_inns: frozenset[str], own_names: frozenset[str]
) -> _Executor:
    """Заполнена ли сторона исполнителя и не наши ли это данные."""
    reasons: list[str] = []
    ours = False
    for block in _candidate_blocks(body, EXECUTOR_ROLES):
        for line in block.lines():
            kind = _line_kind(line)
            if kind in ("blank", "placeholder", "labelled", "signature"):
                continue
            numbers = _inns_in(line)
            # Наш ИНН: число после метки или строка, целиком состоящая из числа.
            # Число после метки может слиться с КПП («ИНН 123... 456...»), поэтому по префиксу.
            if _contains_name(line, own_names) or any(
                number.startswith(inn) for number in (*numbers, _digits(line)) for inn in own_inns
            ):
                ours = True
            elif any(len(number) >= min(INN_LENGTHS) for number in numbers):
                reasons.append(REASON_EXECUTOR_INN)
            else:
                reasons.append(REASON_EXECUTOR_TEXT)
    for paragraph in _body_paragraphs(body)[:HEAD_PARAGRAPHS]:
        for match in PREAMBLE_EXECUTOR.finditer(_text(paragraph)):
            name = PREAMBLE_LEAD.sub("", match.group("name").strip()).strip(" «»\"“„")
            if not re.search(r"[^\W\d_]", name) or PLACEHOLDER_ONLY.match(name):
                continue
            if _contains_name(name, own_names):
                ours = True
            else:
                reasons.append(REASON_EXECUTOR_PREAMBLE)
    return _Executor(tuple(dict.fromkeys(reasons)), ours)


def _own_marker(document: Any) -> bool:
    return OWN_DOCUMENT_MARKER in (document.core_properties.category or "")


def classify_contract(
    data: bytes,
    templates: Sequence[bytes],
    own_inns: Sequence[str],
    own_names: Sequence[str],
    limits: DocumentLimits,
) -> ContractKind:
    """Определяет, договор ли это поставщика; см. модульный докстринг.

    Args:
        data: Байты присланного docx (.doc и RTF уже сконвертированы).
        templates: Байты наших шаблонов договоров (реестр), прочитанные ядром; пусто - сравнить
            не с чем, и без метки вердикт `unclear`.
        own_inns: ИНН наших юрлиц (записи БД): по цифрам.
        own_names: Наименования наших юрлиц.
        limits: Лимиты разбора контейнеров.

    Raises:
        CorruptDocumentError / DocumentTooLargeError: Файл (или шаблон) не читается / слишком
            большой или вышло время документа.
        documents.docx_amend.AmendError: Формат не docx (`unsupported_format`).
    """
    deadline = Deadline(limits.max_ooxml_seconds)
    document = _open(data, limits, deadline)
    body = document.element.body
    if _own_marker(document):
        return ContractKind(VERDICT_OWN_TEMPLATE, (REASON_OWN_MARKER,))
    coverage, no_coverage_reason = _best_coverage(
        _paragraph_texts(body), templates, limits, deadline
    )
    if coverage is not None and coverage >= OWN_COVERAGE:
        return ContractKind(VERDICT_OWN_TEMPLATE, (REASON_TEMPLATE_MATCH,))
    inns = frozenset(_digits(item) for item in own_inns if _digits(item))
    names = frozenset(
        words for words in (_party_words(item) for item in own_names)
        if len(words) >= MIN_OWN_NAME_CHARS
    )
    executor = _executor_side(body, inns, names)
    if executor.ours:
        return ContractKind(VERDICT_OUR_SIDE_EXECUTOR, (REASON_OUR_DATA_IN_EXECUTOR,))
    if coverage is None:
        return ContractKind(VERDICT_UNCLEAR, (no_coverage_reason, *executor.reasons))
    if coverage >= PARTIAL_COVERAGE:
        return ContractKind(VERDICT_UNCLEAR, (REASON_TEMPLATE_PARTIAL, *executor.reasons))
    if not executor.reasons:
        return ContractKind(VERDICT_UNCLEAR, (REASON_EXECUTOR_EMPTY,))
    return ContractKind(VERDICT_SUPPLIER, executor.reasons)


__all__ = [
    "ContractKind",
    "MAX_OWN_VALUES",
    "MAX_OWN_VALUE_CHARS",
    "MAX_TEMPLATES",
    "VERDICT_OUR_SIDE_EXECUTOR",
    "VERDICT_OWN_TEMPLATE",
    "VERDICT_SUPPLIER",
    "VERDICT_UNCLEAR",
    "classify_contract",
]
