"""Подстановка подписанта НАШЕЙ стороны в шаблон договора для POST /docx/replace-signatory.

Шаблоны договоров лежат на шаре заказчика, и подписант нашего юрлица напечатан в них текстом
(пять мест: «в лице генерального директора Фамилия Имя Отчество, действующего...», строка подписи
блока «Заказчик», преамбула приложения «в лице ... Фамилия И.О.», строка у приложения и
«____/И.О. Фамилия»). Владелец решил менять подписанта кодом при сборке, шаблоны не править.

Прежнего подписанта не знает ни код, ни настройка: он определяется по самому шаблону, по
якорям, где подписант назван фамилией:

- «в лице <должность> <ФИО> , действующ...» (ФИО полностью или «Фамилия И.О.», родительный);
- «Генеральный директор / Директор <Фамилия И.О.>» (строка подписи, именительный).

Затем по найденной фамилии и инициалам находятся формы «И.О. Фамилия». Якоря требуют настоящей
фамилии с заглавной буквы, поэтому метки шаблона (`{seller_representative}`) и пустые строки
стороны поставщика не совпадают. Что не разобрано однозначно, не правится (отказ):

- `signatory_not_found`: в шаблоне нет ни одного якоря подписанта;
- `signatory_inconsistent`: найденные формы принадлежат разным людям (фамилия или инициалы);
- `signatory_left`: после замены фамилия прежнего подписанта осталась в тексте.

Значения (ФИО) в журнал и в ошибки не попадают. Форматирование run сохраняется. Совпадающая
запись (в шаблоне уже нужный подписант) - замен нет, файл возвращается как есть.
"""

from __future__ import annotations

import io
import logging
import re
from dataclasses import dataclass
from typing import Any

from pragmatika_documents.docx_amend import (
    DOCX_MIME,
    AmendError,
    _body_paragraphs,
    _open,
    _paragraph_texts,
    _replace_span,
    _text,
    verify_numbers_preserved,
)
from documents.limits import Deadline, DocumentLimits

logger = logging.getLogger(__name__)

ERR_SIGNATORY_NOT_FOUND = "signatory_not_found"
ERR_SIGNATORY_INCONSISTENT = "signatory_inconsistent"
ERR_SIGNATORY_LEFT = "signatory_left"
ERR_BAD_FORMS = "bad_request"

#: Самое короткое общее начало фамилий разных падежей («Чижов»/«Чижова»): меньше - другой человек
MIN_STEM_CHARS = 3
#: Сколько последних букв фамилии отбрасывается при сравнении падежей и родов
STEM_TAIL_CHARS = 2

_CAP = r"[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?"
_INIT = r"[А-ЯЁ]\.\s?[А-ЯЁ]\."
_FULL = rf"{_CAP}\s+{_CAP}\s+{_CAP}"
_SHORT = rf"{_CAP}\s+{_INIT}"
_REV = rf"{_INIT}\s*{_CAP}"

#: «в лице генерального директора Иванова Ивана Ивановича, действующего»
_GENITIVE_ANCHOR = re.compile(
    rf"в\s+лице\s+(?:[а-яё]+\s+){{1,4}}(?P<name>{_FULL}|{_SHORT})\s*,?\s*действующ"
)
#: «Генеральный директор<табуляции>Иванов И.И.»; в тексте абзаца табуляций нет, поэтому `\s*`
_SIGNATURE_ANCHOR = re.compile(rf"(?:[Гг]енеральный\s+директор|[Дд]иректор)[\s_/]*(?P<name>{_SHORT})")
_REVERSED = re.compile(rf"(?P<name>{_REV})")
_WORD = re.compile(r"[А-ЯЁа-яё][А-ЯЁа-яё-]*")
_INITIALS = re.compile(r"[А-ЯЁ]")


@dataclass(frozen=True)
class SignatoryForms:
    """Новый подписант в нужных формах (строит ядро по записи БД и склонению сервиса)."""

    nominative_short: str  # «Образцова А.С.»
    nominative_reversed: str  # «А.С. Образцова»
    genitive_full: str  # «Образцовой Анны Сергеевны»
    genitive_short: str  # «Образцовой А.С.»


@dataclass
class SignatoryReport:
    """Что сделано: только числа."""

    found: int = 0
    replaced: int = 0
    unchanged: bool = False


@dataclass(frozen=True)
class SignatoryResult:
    """Итог подстановки; при `report.unchanged` содержимое - исходные байты."""

    content: bytes
    mime_type: str
    report: SignatoryReport


@dataclass(frozen=True)
class _Hit:
    paragraph: Any
    start: int
    end: int
    kind: str  # gen_full | gen_short | nom_short | nom_rev
    surname: str
    initials: str


def _surname_and_initials(name: str) -> tuple[str, str]:
    """Фамилия и инициалы из «Фамилия Имя Отчество», «Фамилия И.О.» или «И.О. Фамилия»."""
    words = _WORD.findall(name)
    capitalised = [w for w in words if len(w) > 1]
    initials = "".join(_INITIALS.findall("".join(w for w in words if len(w) == 1)))
    if re.match(r"[А-ЯЁ]\.", name.strip()):
        return capitalised[0], initials
    if len(capitalised) >= 3:
        return capitalised[0], "".join(w[0] for w in capitalised[1:3])
    return capitalised[0], initials


def _same_person(left: tuple[str, str], right: tuple[str, str]) -> bool:
    """Фамилии совпадают с точностью до падежа и рода, инициалы равны."""
    if left[1] != right[1]:
        return False
    a, b = left[0].casefold(), right[0].casefold()
    common = 0
    for x, y in zip(a, b, strict=False):
        if x != y:
            break
        common += 1
    return common >= max(MIN_STEM_CHARS, min(len(a), len(b)) - STEM_TAIL_CHARS)


def _norm(text: str) -> str:
    return re.sub(r"\s+", "", text)


def _anchors(paragraphs: list[Any]) -> list[_Hit]:
    hits: list[_Hit] = []
    for paragraph in paragraphs:
        text = _text(paragraph)
        for match in _GENITIVE_ANCHOR.finditer(text):
            name = match.group("name")
            kind = "gen_short" if re.search(_INIT, name) else "gen_full"
            surname, initials = _surname_and_initials(name)
            hits.append(_Hit(paragraph, match.start("name"), match.end("name"), kind, surname, initials))
        for match in _SIGNATURE_ANCHOR.finditer(text):
            name = match.group("name")
            surname, initials = _surname_and_initials(name)
            hits.append(
                _Hit(paragraph, match.start("name"), match.end("name"), "nom_short", surname, initials)
            )
    return hits


def _reversed_hits(paragraphs: list[Any], known: tuple[str, str]) -> list[_Hit]:
    """Формы «И.О. Фамилия» того же человека (чужих людей с другой фамилией не трогаем)."""
    hits: list[_Hit] = []
    for paragraph in paragraphs:
        text = _text(paragraph)
        for match in _REVERSED.finditer(text):
            surname, initials = _surname_and_initials(match.group("name"))
            if _same_person((surname, initials), known):
                hits.append(
                    _Hit(
                        paragraph, match.start("name"), match.end("name"), "nom_rev", surname, initials
                    )
                )
    return hits


def _validate_forms(forms: SignatoryForms) -> None:
    values = (
        forms.nominative_short,
        forms.nominative_reversed,
        forms.genitive_full,
        forms.genitive_short,
    )
    if any(not value.strip() or len(value) > 200 for value in values):
        raise AmendError(ERR_BAD_FORMS, "формы подписанта пусты или слишком длинны")


def replace_signatory(
    data: bytes, forms: SignatoryForms, limits: DocumentLimits
) -> SignatoryResult:
    """Подставляет подписанта нашей стороны вместо напечатанного в шаблоне.

    Raises:
        AmendError: `signatory_not_found`, `signatory_inconsistent`, `signatory_left`,
            `verification_failed` (изменились номера документа) или `bad_request`.
    """
    _validate_forms(forms)
    deadline = Deadline(limits.max_ooxml_seconds)
    document = _open(data, limits, deadline)
    body = document.element.body
    paragraphs = _body_paragraphs(body)
    anchors = _anchors(paragraphs)
    if not anchors:
        raise AmendError(ERR_SIGNATORY_NOT_FOUND, "подписант в шаблоне не найден")
    reference = (anchors[0].surname, anchors[0].initials)
    if any(not _same_person((hit.surname, hit.initials), reference) for hit in anchors):
        raise AmendError(ERR_SIGNATORY_INCONSISTENT, "в шаблоне названы разные подписанты")
    hits = anchors + _reversed_hits(paragraphs, reference)
    target = {
        "gen_full": forms.genitive_full,
        "gen_short": forms.genitive_short,
        "nom_short": forms.nominative_short,
        "nom_rev": forms.nominative_reversed,
    }
    report = SignatoryReport(found=len(hits))
    before = _paragraph_texts(body)
    changes = [
        hit
        for hit in hits
        if _norm(_text(hit.paragraph)[hit.start : hit.end]) != _norm(target[hit.kind])
    ]
    # Справа налево внутри абзаца: смещения левых вхождений не сдвигаются от замены правых.
    for hit in sorted(changes, key=lambda item: (id(item.paragraph), -item.start)):
        _replace_span(hit.paragraph, hit.start, hit.end, target[hit.kind])
        report.replaced += 1
    if not changes:
        report.unchanged = True
        return SignatoryResult(data, DOCX_MIME, report)
    _check_nothing_left(body, reference, forms)
    verify_numbers_preserved(before, _paragraph_texts(body))
    buffer = io.BytesIO()
    document.save(buffer)
    logger.info("подписант нашей стороны: найдено %d, заменено %d", report.found, report.replaced)
    return SignatoryResult(buffer.getvalue(), DOCX_MIME, report)


def _check_nothing_left(body: Any, old: tuple[str, str], forms: SignatoryForms) -> None:
    """Фамилия прежнего подписанта (любой падеж) не осталась в тексте после замены."""
    new_surname = _surname_and_initials(forms.nominative_short)
    if _same_person((old[0], new_surname[1]), new_surname):
        # Та же фамилия у нового подписанта: остаток не отличить от нужного.
        return
    stem = old[0].casefold()[: max(MIN_STEM_CHARS, len(old[0]) - STEM_TAIL_CHARS)]
    for text in _paragraph_texts(body):
        if any(word.casefold().startswith(stem) for word in _WORD.findall(text)):
            raise AmendError(ERR_SIGNATORY_LEFT, "прежний подписант остался в документе")


__all__ = [
    "ERR_SIGNATORY_INCONSISTENT",
    "ERR_SIGNATORY_LEFT",
    "ERR_SIGNATORY_NOT_FOUND",
    "SignatoryForms",
    "SignatoryReport",
    "SignatoryResult",
    "replace_signatory",
]
