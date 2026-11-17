"""Дополнение присланного договора контрагента нашими данными для POST /docx/amend.

Сотрудник присылает договор поставщика и просит добавить наши реквизиты, не трогая данные
исполнителя. Раньше агент собирал договор по нашему шаблону, а присланный документ использовал
лишь как источник отдельных полей: реквизиты и номер исполнителя терялись. Здесь документ
исполнителя остаётся как есть, а правка только дополняет его:

- НОМЕР ДОГОВОРА НЕ МЕНЯЕТСЯ НИКОГДА (решение владельца 08.11.2026): ни дописывания «/ наш номер»,
  ни замены заполнителя на месте номера. Номер - данные поставщика; параметра «наш номер» в
  запросе нет. После правки код сверяет, что все номера («№ ...») исходника на месте;
- сторона заказчика: наши реквизиты вписываются в блок «Заказчик»/«Покупатель» (ячейка таблицы
  реквизитов, ячейка под ячейкой-заголовком или абзацы под заголовком; строки, разделённые
  мягким переносом, разбираются как отдельные) - в пустые строки и в заполнители вида
  `ИНН ______`, `Адрес: ______`; то, что не вошло в заполнители, добавляется абзацами под
  заголовком блока. Остались заполнители, для которых у нас нет значения, -
  `customer_placeholders_unfilled`, файл не выдаётся;
- преамбула: заполнитель после «и»/«с одной стороны» и перед «в лице»/«именуемое «Заказчик»»
  заменяется нашим наименованием (заполнитель «на основании ____» не трогается).

Ничего из текста исполнителя не удаляется и не заменяется. Это проверяет код после правки
(`verify_text_preserved`): каждый абзац исходника должен остаться в результате, допустимы только
вставки наших значений и замена заполнителей (подчёркивания, точки); иначе `AmendError`
`verification_failed`, файл не выдаётся. Сверка линейна по числу абзацев, длина сверяемого
фрагмента ограничена, а разбор и сверка идут под общим дедлайном документа. Содержимое
документов и значения в лог не попадают.

Правится копия в памяти: части пакета, которые не затронуты, остаются прежними (как в правке
цен), форматирование абзацев и ячеек сохраняется. Форматы .doc и RTF приводятся к docx раньше
(`office_convert`), так что сверка идёт по сконвертированному исходнику.
"""

from __future__ import annotations

import copy
import difflib
import io
import logging
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

import docx
from docx.oxml.ns import qn
from lxml import etree

from documents.format_sniff import actual_extension, sniff_kind
from documents.limits import Deadline, DocumentLimits, check_archive
from documents.models import CorruptDocumentError
from pragmatika_documents.limits import contract_limits

logger = logging.getLogger(__name__)

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

# Роли сторон. Заказчик - наша сторона; остальные нужны, чтобы блок не залез в чужой.
CUSTOMER_ROLES = ("заказчик", "покупатель")
EXECUTOR_ROLES = ("исполнитель", "поставщик", "подрядчик", "продавец")
# Сколько первых абзацев документа просматривается в поисках номера и преамбулы.
HEAD_PARAGRAPHS = 40
# Предел абзацев блока реквизитов вне таблицы: дальше уже другой раздел договора.
MAX_BLOCK_PARAGRAPHS = 25
# Предел площади сверки одного абзаца (символы до x символы после) после отбрасывания общих
# начала и конца: SequenceMatcher квадратичен, а правки к одному абзацу всегда локальны.
VERIFY_MAX_CELLS = 4_000_000
# Длина метки в строке «метка + заполнитель» («Адрес: ____», «ИНН/КПП ____»).
LABEL_MAX_CHARS = 30
# Предел длины значений запроса: защита от огромного тела.
MAX_LINE_CHARS = 500
MAX_LINES = 40

# Коды отказов (машинные: по ним агент объясняет сотруднику, что сделано и что нет).
ERR_BAD_REQUEST = "bad_request"
ERR_NOTHING_TO_DO = "nothing_to_do"
ERR_BLOCK_NOT_FOUND = "customer_block_not_found"
ERR_BLOCK_FILLED = "customer_block_filled"
ERR_PLACEHOLDERS_LEFT = "customer_placeholders_unfilled"
ERR_VERIFICATION = "verification_failed"
ERR_UNSUPPORTED = "unsupported_format"

W_P = qn("w:p")
W_T = qn("w:t")
W_TC = qn("w:tc")
W_TR = qn("w:tr")
W_BR = qn("w:br")
W_TYPE = qn("w:type")
W_SECT_PR = qn("w:sectPr")
W_TC_PR = qn("w:tcPr")
W_GRID_SPAN = qn("w:gridSpan")
W_VAL = qn("w:val")
W_R = qn("w:r")
W_RPR = qn("w:rPr")
W_PPR = qn("w:pPr")
W_B = qn("w:b")
W_BCS = qn("w:bCs")
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"


# Заполнитель: подчёркивания, многоточия, длинные ряды точек.
PLACEHOLDER_CHARS = r"_…‥"
PLACEHOLDER_RUN = re.compile(rf"[{PLACEHOLDER_CHARS}]{{2,}}|\.{{5,}}")
PLACEHOLDER_ONLY = re.compile(rf"^[\s{PLACEHOLDER_CHARS}.\-–—/\\]*$")
# Что сверка разрешает убрать из текста: пробелы, подчёркивания, многоточия, ряды точек и
# тире. Одиночные «-», «/», «.» из текста исполнителя сюда не входят: их потеря - порча номера.
REMOVABLE_TEXT = re.compile(rf"^(?:[\s{PLACEHOLDER_CHARS}]|[-–—.]{{3,}})*$")
# Строка подписи: должность подписанта, печать, «/ФИО/»: реквизитами не является.
SIGNATURE_LINE = re.compile(
    r"директор|подпис|м\.\s?п\.?|руководител|[{p}]\s*/|/\s*[{p}]".format(p=PLACEHOLDER_CHARS),
    re.IGNORECASE,
)
HEADING = re.compile(
    r"^\s*(?P<role>{roles})\s*:?\s*(?P<rest>.*)$".format(
        roles="|".join(CUSTOMER_ROLES + EXECUTOR_ROLES)
    ),
    re.IGNORECASE | re.DOTALL,
)

# Номер в тексте: «№ 103/11-26», «№103», «N 5». Токен до пробела и знаков препинания. Нужен
# только для сверки: номера исходника после правки должны остаться на месте.
NUMBER_PATTERN = re.compile(r"(?:№|N\s?o\.?)\s*(?P<token>[^\s,;«»\"()]+)", re.IGNORECASE)
# Номер вместе с продолжением через « / »: так выглядел бы дописанный к нему наш номер.
NUMBER_WITH_TAIL = re.compile(
    NUMBER_PATTERN.pattern + r"(?:\s+/\s+[^\s,;«»\"()]+)*", re.IGNORECASE
)

# Метки реквизитов: ключ, шаблон метки и признак «значение - число». Адрес, телефон, почта и
# банк - значение до конца строки. `inn_kpp` - метка «ИНН/КПП» с одним значением «ИНН/КПП».
LABELS: tuple[tuple[str, str, bool], ...] = (
    ("inn_kpp", r"ИНН\s*/\s*КПП", False),
    ("inn", r"ИНН", True),
    ("kpp", r"КПП", True),
    ("ogrn", r"ОГРН(?:ИП)?", True),
    ("bik", r"БИК", True),
    ("rs", r"(?:Р\s*/\s*с(?:ч[её]т)?|Расч[её]тный\s+сч[её]т|р/сч[её]т)\.?", True),
    ("ks", r"(?:К\s*/\s*с(?:ч[её]т)?|Корр(?:еспондентский)?\.?\s*сч[её]т)\.?", True),
    ("addr", r"(?:Юридический\s+|Юр\.?\s*|Почтовый\s+|Фактический\s+)?Адрес", False),
    ("tel", r"тел(?:ефон)?\.?", False),
    ("email", r"(?:e-?mail|эл\.?\s*почта|электронная\s+почта)", False),
    ("bank", r"Банк", False),
)
LABEL_ALTERNATION = "|".join(f"(?P<{key}>{pattern})" for key, pattern, _ in LABELS)
NUMERIC_ALTERNATION = "|".join(
    f"(?P<{key}>{pattern})" for key, pattern, numeric in LABELS if numeric
)
REST_ALTERNATION = "|".join(
    f"(?P<{key}>{pattern})" for key, pattern, numeric in LABELS if not numeric
)
# Метка с числовым значением («ИНН 7701001238») и метка со значением до конца строки (адрес).
# Перед меткой не слово и не «/»: «КПП» в «ИНН/КПП 123/456» относится к паре, а не к числу.
LABEL_VALUE_NUMERIC = re.compile(
    rf"(?<![\w/])(?P<label>{NUMERIC_ALTERNATION})\s*[:№]?\s*(?P<value>\d+)", re.IGNORECASE
)
LABEL_VALUE_REST = re.compile(
    rf"^\s*(?P<label>{REST_ALTERNATION})\s*[:№]?\s*(?P<value>.+)$", re.IGNORECASE
)
# Банк в строках реквизитов печатается без метки: «в АО «Банк»».
BANK_LINE = re.compile(r"^\s*в\s+(?P<value>.+)$")
EMAIL_LINE = re.compile(r"^\s*(?P<value>[^\s@]+@[^\s@]+\.[^\s@]+)\s*$")
# Метка и заполнитель за ней: «ИНН ________», «Адрес: ________», «E-mail: ____». Метка - слово
# и несколько знаков без цифр, подчёркиваний и двоеточия; после сегмента допустимы пробелы,
# запятая, точка с запятой. Строка из таких сегментов целиком - строка-заполнитель.
LABEL_SEGMENT = re.compile(
    rf"\s*(?P<label>[^\W\d_][^\d{PLACEHOLDER_CHARS}:\n]{{0,{LABEL_MAX_CHARS}}}?)\s*[:№]?\s*"
    rf"(?P<ph>[{PLACEHOLDER_CHARS}]{{2,}}|\.{{5,}})[\s,;]*"
)

# Заполнитель наименования в преамбуле: после «и»/«с одной стороны», перед «в лице» или
# «именуемое». Заполнители «в лице ___» и «на основании ___» наименованием не заполняются.
_PARTY_ALTERNATION = "|".join(CUSTOMER_ROLES + EXECUTOR_ROLES)
PREAMBLE_NAME = re.compile(
    rf"(?:(?<!\w)и|одной\s+стороны\s*,?(?:\s*и)?)\s*"
    rf"(?P<ph>[{PLACEHOLDER_CHARS}]{{3,}}|\.{{5,}})(?=\s*,?\s*(?:в\s+лице|именуем))",
    re.IGNORECASE,
)
PARTY_ROLE_QUOTE = re.compile(
    rf"[«\"“„]\s*(?P<role>{_PARTY_ALTERNATION})\s*[»\"”]", re.IGNORECASE
)


class AmendError(Exception):
    """Дополнение невозможно или не прошло проверку; `code` - машинный код отказа."""

    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code


@dataclass(frozen=True)
class OwnRequisites:
    """Наши данные для стороны заказчика: наименование и строки реквизитов как они печатаются."""

    name: str
    lines: tuple[str, ...]


@dataclass
class AmendReport:
    """Что сделано: без значений, только факты (они уходят в журнал и сотруднику)."""

    preamble_filled: bool = False
    customer_block_filled: bool = False
    placeholders_filled: int = 0
    lines_added: int = 0
    unfilled_placeholders: int = 0
    notes: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AmendResult:
    """Результат дополнения."""

    content: bytes
    mime_type: str
    report: AmendReport


@dataclass(frozen=True)
class PartyBlock:
    """Блок стороны, прочитанный из документа (для источника наших реквизитов)."""

    name: str
    lines: tuple[str, ...]


# ---------------------------------------------------------------- работа с абзацами


def _owner(node: Any) -> Any:
    """Ближайший абзац `w:p`, внутри которого лежит узел."""
    current = node.getparent()
    while current is not None and current.tag != W_P:
        current = current.getparent()
    return current


def _is_soft_break(node: Any, paragraph: Any) -> bool:
    """Мягкий перенос строки (Shift+Enter) прямо в run абзаца; разрывы страниц не в счёт."""
    if node.tag != W_BR or node.get(W_TYPE) not in (None, "textWrapping"):
        return False
    run = node.getparent()
    return run is not None and run.tag == W_R and run.getparent() is paragraph


def _items(paragraph: Any) -> list[Any]:
    """Узлы `w:t` и мягкие переносы самого абзаца (без вложенных абзацев) в порядке документа."""
    return [
        node
        for node in paragraph.iter(W_T, W_BR)
        if (node.tag == W_T and _owner(node) is paragraph) or _is_soft_break(node, paragraph)
    ]


def _text_nodes(paragraph: Any) -> list[Any]:
    """Узлы `w:t` самого абзаца (без вложенных абзацев надписей), в порядке документа."""
    return [node for node in _items(paragraph) if node.tag == W_T]


def _text(paragraph: Any) -> str:
    """Текст абзаца; мягкий перенос - символ «\\n» (так же его отдаёт python-docx)."""
    return "".join("\n" if node.tag == W_BR else (node.text or "") for node in _items(paragraph))


def _lines_of(paragraph: Any) -> list[str]:
    """Строки абзаца: по мягким переносам."""
    return _text(paragraph).split("\n")


def _set(node: Any, text: str) -> None:
    node.text = text
    node.set(XML_SPACE, "preserve")


def _replace_span(paragraph: Any, start: int, end: int, new: str) -> None:
    """Заменяет символы [start, end) текста абзаца на `new`, сохраняя форматирование run."""
    position = 0
    first = True
    for node in _items(paragraph):
        if node.tag == W_BR:
            position += 1
            continue
        text = node.text or ""
        begin, finish = position, position + len(text)
        position = finish
        if finish <= start or begin >= end:
            continue
        low, high = max(start, begin) - begin, min(end, finish) - begin
        _set(node, text[:low] + (new if first else "") + text[high:])
        first = False


def _set_whole_text(paragraph: Any, text: str) -> None:
    """Целиком задаёт текст абзаца: первый run хранит его, остальные текстовые узлы очищаются.

    Применяется только к строкам, где был лишь заполнитель или пробелы: текста исполнителя в
    них нет.
    """
    nodes = _text_nodes(paragraph)
    if not nodes:
        run = etree.SubElement(paragraph, W_R)
        node = etree.SubElement(run, W_T)
        _set(node, text)
        return
    _set(nodes[0], text)
    for node in nodes[1:]:
        _set(node, "")


def _new_paragraph_like(model: Any, text: str, *, plain: bool) -> Any:
    """Новый абзац с форматированием образца и заданным текстом.

    Копируются свойства абзаца и свойства первого run с текстом; `plain` снимает полужирный
    (образец - заголовок блока). Служебные идентификаторы абзаца не копируются: повтор
    `w14:paraId` Word считает ошибкой.
    """
    paragraph = etree.Element(W_P, nsmap=model.nsmap)
    properties = model.find(W_PPR)
    if properties is not None:
        paragraph.append(copy.deepcopy(properties))
    run = etree.SubElement(paragraph, W_R)
    source = next((r for r in model.iter(W_R) if r.find(W_T) is not None), None)
    run_properties = None if source is None else source.find(W_RPR)
    if run_properties is not None:
        clone = copy.deepcopy(run_properties)
        if plain:
            for tag in (W_B, W_BCS):
                for bold in clone.findall(tag):
                    clone.remove(bold)
        run.append(clone)
    _set(etree.SubElement(run, W_T), text)
    return paragraph


def _split_soft_breaks(paragraph: Any) -> list[Any]:
    """Разрезает абзац по мягким переносам на отдельные абзацы (по строке в каждом).

    Блок реквизитов нередко набран одним абзацем со строками через Shift+Enter; строки такого
    блока заполняются и дополняются как отдельные абзацы. Текст не меняется: сверка читает
    мягкий перенос как границу строки. Свойства абзаца копируются в каждый новый, разрыв
    раздела (`w:sectPr`) остаётся только у последнего.
    """
    breaks = [node for node in paragraph.iter(W_BR) if _is_soft_break(node, paragraph)]
    if not breaks:
        return [paragraph]
    properties = paragraph.find(W_PPR)
    section = None if properties is None else properties.find(W_SECT_PR)
    if section is not None:
        properties.remove(section)
    segments: list[list[Any]] = [[]]
    for child in list(paragraph):
        if child.tag == W_PPR:
            continue
        if child.tag != W_R or not any(node.getparent() is child for node in breaks):
            segments[-1].append(child)
            continue
        run_properties = child.find(W_RPR)

        def fresh_run() -> Any:
            run = etree.Element(W_R, nsmap=child.nsmap)
            if run_properties is not None:
                run.append(copy.deepcopy(run_properties))
            return run

        current = fresh_run()
        for item in list(child):
            if item.tag == W_RPR:
                continue
            if item in breaks:
                segments[-1].append(current)
                segments.append([])
                current = fresh_run()
            else:
                current.append(item)
        segments[-1].append(current)
    for child in list(paragraph):
        if child.tag != W_PPR:
            paragraph.remove(child)
    for child in segments[0]:
        paragraph.append(child)
    result = [paragraph]
    anchor = paragraph
    for index, segment in enumerate(segments[1:], start=1):
        created = etree.Element(W_P, nsmap=paragraph.nsmap)
        if properties is not None:
            created.append(copy.deepcopy(properties))
        if section is not None and index == len(segments) - 1:
            created_properties = created.find(W_PPR)
            if created_properties is not None:
                created_properties.append(section)
        for child in segment:
            created.append(child)
        anchor.addnext(created)
        anchor = created
        result.append(created)
    return result


def _body_paragraphs(body: Any) -> list[Any]:
    return list(body.iter(W_P))


# ---------------------------------------------------------------- блок заказчика


@dataclass
class _Block:
    """Блок стороны: заголовок и абзацы под ним.

    `below`: заголовок стоит в ячейке-шапке, а содержимое (реквизиты) - в ячейке под ней, в
    следующей строке таблицы; тогда `content` - абзацы той ячейки.
    """

    heading: Any
    content: list[Any]
    position: int
    below: bool = False

    def lines(self) -> list[str]:
        """Строки под заголовком: хвост абзаца заголовка и все строки абзацев содержимого."""
        result = [] if self.below else _lines_of(self.heading)[1:]
        for paragraph in self.content:
            result.extend(_lines_of(paragraph))
        return result

    def kinds(self) -> list[str]:
        return [_line_kind(line) for line in self.lines()]


def _label_segments(text: str) -> list[re.Match[str]] | None:
    """Строка целиком из сегментов «метка + заполнитель»; иначе None."""
    found: list[re.Match[str]] = []
    position = 0
    while position < len(text):
        match = LABEL_SEGMENT.match(text, position)
        if match is None:
            rest = text[position:].strip(" \t,;")
            return found if found and rest == "" else None
        found.append(match)
        position = match.end()
    return found or None


def _line_kind(text: str) -> str:
    """blank / placeholder / labelled / signature / other.

    `labelled` - короткая метка и заполнитель за ней («ИНН ____», «Адрес: ____»): место под
    значение, а не готовый текст. Строка из пробелов и табуляции - пустая.
    """
    if text.strip() == "":
        return "blank"
    if SIGNATURE_LINE.search(text):
        return "signature"
    if PLACEHOLDER_ONLY.match(text):
        return "placeholder"
    if _label_segments(text) is not None:
        return "labelled"
    return "other"


def _heading_role(line: str) -> tuple[str, str] | None:
    match = HEADING.match(line)
    if match is None:
        return None
    return match.group("role").casefold(), match.group("rest").strip()


def _heading_rest_empty(rest: str) -> bool:
    """После названия роли ничего нет (двоеточие, пробелы или заполнитель)."""
    return rest == "" or PLACEHOLDER_ONLY.match(rest) is not None


def _grid_span(cell: Any) -> int:
    properties = cell.find(W_TC_PR)
    span = None if properties is None else properties.find(W_GRID_SPAN)
    try:
        return max(1, int(span.get(W_VAL))) if span is not None else 1
    except (TypeError, ValueError):
        return 1


def _cell_below(cell: Any) -> Any | None:
    """Ячейка того же столбца в следующей строке таблицы (по сетке с учётом объединения)."""
    row = cell.getparent()
    if row is None or row.tag != W_TR:
        return None
    column = 0
    for sibling in row:
        if sibling is cell:
            break
        if sibling.tag == W_TC:
            column += _grid_span(sibling)
    following = row.getnext()
    while following is not None and following.tag != W_TR:
        following = following.getnext()
    if following is None:
        return None
    position = 0
    for candidate in following:
        if candidate.tag != W_TC:
            continue
        if position == column:
            return candidate
        position += _grid_span(candidate)
        if position > column:
            return None
    return None


def _candidate_blocks(body: Any, role_filter: tuple[str, ...]) -> list[_Block]:
    """Блоки стороны с заданной ролью: ячейки таблиц и абзацы под отдельным заголовком."""
    order = {node: index for index, node in enumerate(body.iter())}
    blocks: list[_Block] = []
    for cell in body.iter(W_TC):
        paragraphs = [child for child in cell if child.tag == W_P][: MAX_BLOCK_PARAGRAPHS * 4]
        filled = [p for p in paragraphs if _text(p).strip() != ""]
        if not filled:
            continue
        parsed = _heading_role(_lines_of(filled[0])[0])
        if parsed is None or parsed[0] not in role_filter or not _heading_rest_empty(parsed[1]):
            continue
        start = paragraphs.index(filled[0])
        block = _Block(filled[0], paragraphs[start + 1 :], order[filled[0]])
        if all(line.strip() == "" for line in block.lines()):
            # Ячейка-шапка («Поставщик | Покупатель»): реквизиты лежат в ячейке под ней.
            below = _cell_below(cell)
            below_paragraphs = [] if below is None else [c for c in below if c.tag == W_P]
            if below_paragraphs:
                block = _Block(
                    filled[0], below_paragraphs[:MAX_BLOCK_PARAGRAPHS], block.position, below=True
                )
        blocks.append(block)
    for paragraph in body:
        if paragraph.tag != W_P:
            continue
        parsed = _heading_role(_lines_of(paragraph)[0])
        if parsed is None or parsed[0] not in role_filter or parsed[1] != "":
            continue
        content: list[Any] = []
        sibling = paragraph.getnext()
        while sibling is not None and sibling.tag == W_P and len(content) < MAX_BLOCK_PARAGRAPHS:
            sibling_role = _heading_role(_lines_of(sibling)[0])
            if sibling_role is not None and sibling_role[1] == "":
                break
            content.append(sibling)
            sibling = sibling.getnext()
        blocks.append(_Block(paragraph, content, order[paragraph]))
    return sorted(blocks, key=lambda block: block.position)


def _materialize(block: _Block) -> None:
    """Разрезает по мягким переносам абзацы выбранного блока (остальные блоки не трогаются)."""
    if block.below:
        content = [piece for p in block.content for piece in _split_soft_breaks(p)]
        block.content = content
        return
    pieces = [piece for p in [block.heading, *block.content] for piece in _split_soft_breaks(p)]
    block.heading, block.content = pieces[0], pieces[1:]


def _fillable(block: _Block) -> bool:
    """Блок можно заполнить: в нём нет готового текста, только пустоты, заполнители, подпись."""
    return "other" not in block.kinds()


def _slot_score(block: _Block) -> int:
    """Чем больше мест под реквизиты, тем вероятнее это блок реквизитов, а не подпись."""
    kinds = block.kinds()
    return kinds.count("labelled") * 2 + kinds.count("placeholder") + kinds.count("blank")


def _rest_field(line: str) -> tuple[str, str] | None:
    """Значение «до конца строки»: адрес, телефон, почта, банк (с меткой или без)."""
    rest = LABEL_VALUE_REST.search(line)
    if rest is not None:
        return _label_key(rest), rest.group("value").strip()
    bank = BANK_LINE.match(line)
    if bank is not None:
        return "bank", bank.group("value").strip()
    mail = EMAIL_LINE.match(line)
    if mail is not None:
        return "email", mail.group("value")
    return None


def _our_fields(lines: tuple[str, ...]) -> dict[str, str]:
    """Значения реквизитов по меткам из наших строк (первое вхождение метки)."""
    fields: dict[str, str] = {}
    for line in lines:
        for match in LABEL_VALUE_NUMERIC.finditer(line):
            fields.setdefault(_label_key(match), match.group("value"))
        rest = _rest_field(line)
        if rest is not None:
            fields.setdefault(rest[0], rest[1])
    pair = fields.get("inn_kpp")
    if pair is not None and ("inn" not in fields or "kpp" not in fields):
        inn, _, kpp = (part.strip() for part in pair.partition("/"))
        if inn and kpp:
            fields.setdefault("inn", inn)
            fields.setdefault("kpp", kpp)
    elif pair is None and "inn" in fields and "kpp" in fields:
        fields["inn_kpp"] = f"{fields['inn']}/{fields['kpp']}"
    return fields


def _label_key(match: re.Match[str]) -> str:
    groups = match.groupdict()
    for key, _, _ in LABELS:
        if groups.get(key) is not None:
            return key
    raise ValueError("метка без ключа")


def _key_for_label(label: str) -> str | None:
    """Ключ реквизита по тексту метки; неизвестная метка (факс, должность) - None."""
    cleaned = label.strip(" \t:№")
    for key, pattern, _ in LABELS:
        if re.fullmatch(pattern, cleaned, re.IGNORECASE):
            return key
    return None


def _remaining_lines(lines: tuple[str, ...], used: set[str]) -> list[str]:
    """Наши строки без значений, уже вписанных в заполнители; остаток метки сохраняется."""
    remaining: list[str] = []
    for line in lines:
        pieces: list[str] = []
        cursor = 0
        for match in LABEL_VALUE_NUMERIC.finditer(line):
            key = _label_key(match)
            pieces.append(line[cursor : match.start()])
            cursor = match.end()
            if key not in used:
                pieces.append(match.group(0))
        pieces.append(line[cursor:])
        rest = _rest_field(line)
        if rest is not None and rest[0] in used:
            continue
        text = " ".join(piece.strip() for piece in pieces if piece.strip())
        if text:
            remaining.append(text)
    return remaining


def _fill_labelled(paragraph: Any, fields: dict[str, str], used: set[str]) -> int:
    """Вписывает значения в заполнители «ИНН ____» одного абзаца; возвращает число замен."""
    text = _text(paragraph)
    replaced = 0
    for match in reversed(_label_segments(text) or []):
        key = _key_for_label(match.group("label"))
        value = None if key is None else fields.get(key)
        if key is None or value is None or key in used:
            continue
        _replace_span(paragraph, match.start("ph"), match.end("ph"), value)
        used.add(key)
        if key == "inn_kpp":
            used.update(("inn", "kpp"))
        replaced += 1
    return replaced


def _insert_before_content(block: _Block, created: Any) -> None:
    """Вставляет абзац сразу под заголовком (в ячейке под шапкой - перед первым абзацем)."""
    if block.below and block.content:
        block.content[0].addprevious(created)
    else:
        block.heading.addnext(created)


def _fill_customer_block(body: Any, own: OwnRequisites, report: AmendReport) -> set[str]:
    """Вписывает наши реквизиты в блок заказчика; возвращает вставленные строки."""
    blocks = _candidate_blocks(body, CUSTOMER_ROLES)
    if not blocks:
        raise AmendError(ERR_BLOCK_NOT_FOUND, "блок «Заказчик» не найден")
    free = [block for block in blocks if _fillable(block)]
    if not free:
        raise AmendError(ERR_BLOCK_FILLED, "в блоке «Заказчик» уже есть данные")
    block = max(free, key=lambda item: (_slot_score(item), -item.position))
    _materialize(block)
    fields = _our_fields(own.lines)
    used: set[str] = set()
    inserted: set[str] = set()
    labelled = [p for p in block.content if _line_kind(_text(p)) == "labelled"]
    for paragraph in labelled:
        report.placeholders_filled += _fill_labelled(paragraph, fields, used)
    if {"inn", "kpp"} <= used:
        used.add("inn_kpp")
    # Заполнитель с меткой, для которой у нас нет значения (факс, e-mail), остался бы в
    # договоре пустым местом: такой файл сотруднику не отдаётся, реквизиты вписывают вручную.
    if any(PLACEHOLDER_RUN.search(_text(p)) for p in labelled):
        raise AmendError(ERR_PLACEHOLDERS_LEFT, "в блоке «Заказчик» остались пустые поля")
    remaining = _remaining_lines(own.lines, used)
    name = own.name.strip()
    # Наименование - первая строка блока; в строках реквизитов оно обычно уже есть.
    if not remaining or remaining[0].strip() != name:
        remaining.insert(0, name)
    remaining = [line for line in remaining if line.strip() != ""]
    model = next(
        (p for p in block.content if _line_kind(_text(p)) in ("labelled", "other")),
        block.content[0] if block.content else block.heading,
    )
    plain = model is block.heading
    # Пустые строки сразу под заголовком (до первого текста) занимают первые наши строки.
    consumed = False
    for paragraph in block.content:
        kind = _line_kind(_text(paragraph))
        if kind not in ("blank", "placeholder") or not remaining:
            break
        line = remaining.pop(0)
        _set_whole_text(paragraph, line)
        inserted.add(line)
        report.placeholders_filled += 1
        consumed = True
    # Мест под наименование нет, а под заголовком сразу строки («ИНН ____»): наименование
    # встаёт первой строкой блока, а не после реквизитов.
    anchor: Any = None if block.below else block.heading
    if not consumed and remaining and remaining[0].strip() == name:
        top = remaining.pop(0)
        created = _new_paragraph_like(model, top, plain=plain)
        _insert_before_content(block, created)
        anchor = created
        inserted.add(top)
        report.lines_added += 1
    # Остаток - абзацы после последней строки реквизитов, до строк подписи.
    for paragraph in block.content:
        kind = _line_kind(_text(paragraph))
        if kind == "signature":
            break
        if kind != "blank":
            anchor = paragraph
    for line in remaining:
        created = _new_paragraph_like(model, line, plain=plain)
        if anchor is None:
            _insert_before_content(block, created)
        else:
            anchor.addnext(created)
        anchor = created
        inserted.add(line)
        report.lines_added += 1
    inserted.update(fields.values())
    report.customer_block_filled = True
    return inserted


def _fill_preamble(body: Any, name: str, report: AmendReport) -> set[str]:
    """Наименование заказчика на месте заполнителя в преамбуле («и ___, именуемое «Заказчик»»).

    Заполнитель должен стоять после «и»/«с одной стороны» и перед «в лице»/«именуемое», а
    ближайшая роль в кавычках за ним - заказчик: «на основании ____» не трогается.
    """
    for paragraph in _body_paragraphs(body)[:HEAD_PARAGRAPHS]:
        text = _text(paragraph)
        for match in PREAMBLE_NAME.finditer(text):
            role = PARTY_ROLE_QUOTE.search(text, match.end("ph"))
            if role is None or role.group("role").casefold() not in CUSTOMER_ROLES:
                continue
            _replace_span(paragraph, match.start("ph"), match.end("ph"), name)
            report.preamble_filled = True
            return {name}
    return set()


# ---------------------------------------------------------------- сверка


def _paragraph_texts(body: Any) -> list[str]:
    """Непустые строки документа: абзацы, а внутри абзаца - строки по мягким переносам."""
    texts = [line for p in body.iter(W_P) for line in _lines_of(p)]
    return [t for t in texts if t.strip() != ""]


def _common_edges(old: str, new: str) -> tuple[int, int]:
    """Длина общего начала и общего конца (не пересекаются) двух строк."""
    limit = min(len(old), len(new))
    head = 0
    while head < limit and old[head] == new[head]:
        head += 1
    tail = 0
    while tail < limit - head and old[len(old) - 1 - tail] == new[len(new) - 1 - tail]:
        tail += 1
    return head, tail


def _is_our_value(added: str, values: frozenset[str]) -> bool:
    """Вставка - ровно одно наше значение."""
    return added in values


def _only_additions(old: str, new: str, values: frozenset[str]) -> bool:
    """`old` сохранён в `new`: убраны только заполнители, вставлены только наши значения.

    Пробелы не сравниваются (значения тоже без пробелов): иначе пробел внутри заполнителя
    «_ _ _» совпал бы с пробелом в значении и разрезал бы вставку на куски. Общие начало и конец
    отбрасываются, остаток сверяется по символам (площадь ограничена `VERIFY_MAX_CELLS`).
    Убранный кусок - заполнитель; вставленный - целиком одно из наших значений, а не его часть
    и не склейка нескольких.
    """
    old, new = re.sub(r"\s+", "", old), re.sub(r"\s+", "", new)
    if old == new:
        return True
    head, tail = _common_edges(old, new)
    middle_old, middle_new = old[head : len(old) - tail], new[head : len(new) - tail]
    if len(middle_old) * len(middle_new) > VERIFY_MAX_CELLS:
        return False
    matcher = difflib.SequenceMatcher(None, middle_old, middle_new, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        if not REMOVABLE_TEXT.match(middle_old[i1:i2]):
            return False
        added = middle_new[j1:j2]
        if added and not _is_our_value(added, values):
            return False
    return True


def verify_text_preserved(
    before: list[str],
    after: list[str],
    added: set[str],
    deadline: Deadline | None = None,
) -> None:
    """Проверяет, что текст исполнителя не изменился: только вставки наших значений.

    Сопоставление абзацев линейное, одним проходом: правка сохраняет порядок абзацев, поэтому
    очередной абзац исходника равен очередному абзацу результата, либо дополнен нашим
    значением, либо перед ним стоит вставленная нами строка.

    Args:
        before: Тексты абзацев исходного документа.
        after: Тексты абзацев результата.
        added: Строки и значения, которые разрешено вставить (наши данные).
        deadline: Общий дедлайн документа; None - без ограничения по времени.

    Raises:
        AmendError: `verification_failed`, если абзац исходника пропал или изменился иначе, чем
            вставкой нашего значения либо заменой заполнителя.
        DocumentTooLargeError: Вышло время документа.
    """
    values = frozenset(item for item in (re.sub(r"\s+", "", a) for a in added) if item)
    i = j = 0
    while i < len(before) or j < len(after):
        if deadline is not None:
            deadline.tick()
        if i < len(before) and j < len(after):
            if before[i] == after[j] or _only_additions(before[i], after[j], values):
                i += 1
                j += 1
            elif re.sub(r"\s+", "", after[j]) in values:
                j += 1
            else:
                raise AmendError(ERR_VERIFICATION, "текст исполнителя изменён или пропал")
        elif j < len(after):
            if re.sub(r"\s+", "", after[j]) not in values:
                raise AmendError(ERR_VERIFICATION, "добавлен посторонний абзац")
            j += 1
        else:
            raise AmendError(ERR_VERIFICATION, "абзац исполнителя пропал")
    if deadline is not None:
        deadline.check()


# ---------------------------------------------------------------- вход


def _open(data: bytes, limits: DocumentLimits, deadline: Deadline) -> Any:
    suffix = ".docx"
    if actual_extension(data, suffix, limits) != ".docx" or sniff_kind(data) != "zip":
        raise AmendError(ERR_UNSUPPORTED, "формат не правится на месте")
    # Договорные ручки разбирают docx python-docx целиком: у них свои, более узкие пределы
    # разметки и узлов (`for_contract`), под которые рассчитана память (правило в limits.py).
    check_archive(data, contract_limits(limits), count_nodes=True, deadline=deadline)
    deadline.check()
    try:
        return docx.Document(io.BytesIO(data))
    except Exception as exc:  # noqa: BLE001
        logger.warning("docx не открывается: %s", type(exc).__name__)
        raise CorruptDocumentError("docx не читается") from exc


def validate_own(own: OwnRequisites) -> None:
    """Проверяет наши данные: не пустые и в пределах размеров."""
    if not own.name.strip():
        raise AmendError(ERR_BAD_REQUEST, "нет наименования")
    if len(own.lines) > MAX_LINES or any(len(line) > MAX_LINE_CHARS for line in own.lines):
        raise AmendError(ERR_BAD_REQUEST, "слишком длинные реквизиты")


def verify_numbers_preserved(before: list[str], after: list[str]) -> None:
    """Все номера («№ ...») исходника на месте, побайтно: номер поставщика не меняется.

    Вторая, независимая от построчной сверки страховка (решение владельца 08.11.2026): даже если
    правка по ошибке затронула бы номер договора, файл не выдаётся. В результате допустимы
    лишние номера (наши строки могли бы содержать «№»), но каждый номер исходника - обязателен.

    Raises:
        AmendError: `verification_failed`, если номер исходника пропал или изменился.
    """
    left = Counter(m.group(0) for t in before for m in NUMBER_WITH_TAIL.finditer(t))
    right = Counter(m.group(0) for t in after for m in NUMBER_WITH_TAIL.finditer(t))
    if left - right:
        raise AmendError(ERR_VERIFICATION, "номер исполнителя изменён")


def amend_counterparty_contract(
    data: bytes,
    own: OwnRequisites | None,
    limits: DocumentLimits,
) -> AmendResult:
    """Дополняет договор исполнителя нашими реквизитами в сторону заказчика.

    Номер договора не меняется ни при каких условиях.

    Args:
        data: Байты присланного docx (не изменяются); .doc и RTF к этому моменту уже
            сконвертированы (`office_convert`).
        own: Наши реквизиты для стороны заказчика.
        limits: Лимиты разбора контейнеров.

    Raises:
        AmendError: Нет блока заказчика, блок уже заполнен, остались пустые поля, не прошла
            сверка текста и номеров.
        CorruptDocumentError / DocumentTooLargeError: Файл не читается / слишком большой или
            вышло время документа.
    """
    if own is None:
        raise AmendError(ERR_NOTHING_TO_DO, "нечего добавлять")
    validate_own(own)
    deadline = Deadline(limits.max_ooxml_seconds)
    document = _open(data, limits, deadline)
    body = document.element.body
    before = _paragraph_texts(body)
    report = AmendReport()
    added: set[str] = set()
    added |= _fill_preamble(body, own.name.strip(), report)
    added |= _fill_customer_block(body, own, report)
    after = _paragraph_texts(body)
    verify_text_preserved(before, after, added, deadline)
    verify_numbers_preserved(before, after)
    buffer = io.BytesIO()
    document.save(buffer)
    logger.info(
        "дополнение договора: блок заказчика %s, строк добавлено %d",
        report.customer_block_filled,
        report.lines_added,
    )
    return AmendResult(buffer.getvalue(), DOCX_MIME, report)


def read_party_block(data: bytes, role: str, limits: DocumentLimits) -> PartyBlock:
    """Читает блок стороны («Заказчик») из документа, например из нашего шаблона договора.

    Строки после заголовка до строки подписи; первая строка - наименование. Нужен как источник
    наших реквизитов: в шаблоне договора они напечатаны в блоке «Заказчик».

    Raises:
        AmendError: Блок не найден или пуст.
    """
    roles = (role.casefold(),)
    document = _open(data, limits, Deadline(limits.max_ooxml_seconds))
    blocks = _candidate_blocks(document.element.body, roles)
    for block in blocks:
        lines: list[str] = []
        for raw in block.lines():
            text = raw.strip()
            if SIGNATURE_LINE.search(text):
                break
            if text:
                lines.append(text)
        if lines:
            return PartyBlock(lines[0], tuple(lines))
    raise AmendError(ERR_BLOCK_NOT_FOUND, "блок стороны не найден")


__all__ = [
    "AmendError",
    "AmendReport",
    "AmendResult",
    "OwnRequisites",
    "PartyBlock",
    "amend_counterparty_contract",
    "read_party_block",
    "verify_numbers_preserved",
    "verify_text_preserved",
]
