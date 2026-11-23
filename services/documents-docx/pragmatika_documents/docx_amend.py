"""Дополнение присланного договора контрагента нашими данными для POST /docx/amend.

Сотрудник присылает договор поставщика и просит добавить наши реквизиты, не трогая данные
исполнителя. Раньше агент собирал договор по нашему шаблону, а присланный документ использовал
лишь как источник отдельных полей: реквизиты и номер исполнителя терялись. Здесь документ
исполнителя остаётся как есть, а правка только дополняет его.

Номер договора. По умолчанию он НЕ МЕНЯЕТСЯ (решение владельца 08.11.2026). С 19.11.2026
номер правится только по явной просьбе: параметр запроса `number_edit`
(`{"mode": "append"|"replace", "text": "...", "separator": " / "}`):

- `append` дописывает `separator + text` к существующему номеру (допись, не замена; составной
  номер «103/11-26 / 17/10»), `replace` заменяет номер на `text`. Правка идёт внутри
  существующего run, абзац не пересобирается, форматирование сохраняется;
- номер ищется в заголовке договора и в первых абзацах («ДОГОВОР № 103/11-26», «Договор поставки
  № А-15 от ...», «№»/«N»/«No» и без символа, номер в нескольких run). Не найден или в заголовке
  несколько РАЗНЫХ номеров - номер не правится, в отчёте `number_status` = `not_found` /
  `ambiguous`, остальное дополнение выполняется как обычно;
- отчёт: `number_status` (`unchanged` | `appended` | `replaced` | `not_found` | `ambiguous`),
  `number_before`, `number_after` (номера договора - не ПДн). Без `number_edit` этих полей в
  ответе нет, номер не тронут;
- сверка «текст исполнителя не изменился» допускает ровно эту правку и только её (ожидаемый
  текст строится из запроса), любая иная правка - `verification_failed`. Текст правки - до 60
  знаков без переводов строк и управляющих символов; пустой текст - отказ `bad_request`.

Сторона (`party`). `customer` (по умолчанию, прежнее поведение): наши реквизиты вписываются в
блок «Заказчик»/«Покупатель» (ячейка таблицы реквизитов, ячейка под ячейкой-заголовком или
абзацы под заголовком; строки, разделённые мягким переносом, разбираются как отдельные) - в
пустые строки и в заполнители вида `ИНН ______`, `Адрес: ______`; то, что не вошло в
заполнители, добавляется абзацами под заголовком блока. Остались заполнители, для которых у нас
нет значения, - `customer_placeholders_unfilled`, файл не выдаётся. Преамбула: заполнитель после
«и»/«с одной стороны» и перед «в лице»/«именуемое «Заказчик»» заменяется нашим наименованием
(заполнитель «на основании ____» не трогается).

`executor` (зеркально, для реквизитов исполнителя/поставщика, которые прислал сотрудник):
значения вписываются в блок «Исполнитель»/«Поставщик» ТОЛЬКО в пустые места и заполнители
(пустые строки, «___», «ИНН ____»); существующий непустой текст не затирается никогда и поверх
заполненного блока ничего не добавляется. Нечего заполнять - `placeholders_filled` = 0 и нота.
В отличие от заказчика, незаполненные поля не дают отказа: они считаются в
`unfilled_placeholders` и описываются в `notes`.

Что не найдено. Отчёт всегда содержит `not_found` - машинные коды того, что найти не удалось
(`preamble`, `party_block`, `number`, `signature_line`, `placeholders`), а в `notes` по каждому
коду - читаемая нота по-русски: по ним агент честно говорит сотруднику, что не заполнено.
Полная схема запроса и ответа - `CONTRACT-8y.md` рядом с пакетом.

Ничего из текста исполнителя не удаляется и не заменяется. Это проверяет код после правки
(`verify_text_preserved`): каждый абзац исходника должен остаться в результате, допустимы только
вставки наших значений, замена заполнителей (подчёркивания, точки) и запрошенная правка номера;
иначе `AmendError` `verification_failed`, файл не выдаётся. Сверка линейна по числу абзацев,
длина сверяемого фрагмента ограничена, а разбор и сверка идут под общим дедлайном документа.
Содержимое документов и значения в лог не попадают.

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
import unicodedata
from collections import Counter
from dataclasses import asdict, dataclass, field
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

# Стороны, в которые вписываются реквизиты (параметр запроса `party`).
PARTY_CUSTOMER = "customer"
PARTY_EXECUTOR = "executor"
PARTIES = (PARTY_CUSTOMER, PARTY_EXECUTOR)
# Правка номера договора (параметр запроса `number_edit`).
NUMBER_MODE_APPEND = "append"
NUMBER_MODE_REPLACE = "replace"
NUMBER_MODES = (NUMBER_MODE_APPEND, NUMBER_MODE_REPLACE)
DEFAULT_NUMBER_SEPARATOR = " / "
MAX_NUMBER_TEXT_CHARS = 60
MAX_NUMBER_SEPARATOR_CHARS = 10
# Сколько первых непустых абзацев просматривается в поисках номера: заголовок договора стоит
# в самом начале, дальше идут ссылки на другие документы («к Договору № 5»).
TITLE_SCAN_PARAGRAPHS = 12
# Сколько слов после слова «Договор» просматривается в поисках номера без символа «№».
SYMBOLLESS_MAX_WORDS = 6
# Категории Unicode, запрещённые в тексте правки номера: управляющие, форматирующие,
# разделители строк и абзацев.
FORBIDDEN_TEXT_CATEGORIES = frozenset({"Cc", "Cf", "Zl", "Zp"})

# Статусы правки номера в отчёте.
NUMBER_UNCHANGED = "unchanged"
NUMBER_APPENDED = "appended"
NUMBER_REPLACED = "replaced"
NUMBER_NOT_FOUND = "not_found"
NUMBER_AMBIGUOUS = "ambiguous"

# Машинные коды «не найдено» в отчёте.
NF_PREAMBLE = "preamble"
NF_PARTY_BLOCK = "party_block"
NF_NUMBER = "number"
NF_SIGNATURE_LINE = "signature_line"
NF_PLACEHOLDERS = "placeholders"

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

# Номер договора в заголовке. Токен - до пробела и знаков препинания; составной номер -
# несколько токенов через « / » («103/11-26 / 17/10»). Символ: «№», «N», «No», «N°».
NUMBER_TOKEN = r"[^\s,;«»\"()]+"
NUMBER_SYMBOL = r"(?:№|(?<![^\W\d_])(?-i:N)(?:o|º|°)?\.?)"
TITLE_NUMBER = re.compile(
    rf"{NUMBER_SYMBOL}\s*(?P<num>{NUMBER_TOKEN}(?:\s+/\s+{NUMBER_TOKEN})*)", re.IGNORECASE
)
# Абзац, состоящий только из номера («№ 103/11-26», «№ 5 от 05.11.2026»): строка под заголовком.
NUMBER_ONLY = re.compile(
    rf"^\s*{NUMBER_SYMBOL}\s*{NUMBER_TOKEN}(?:\s+/\s+{NUMBER_TOKEN})*(?:\s+от\s.*)?\s*$",
    re.IGNORECASE | re.DOTALL,
)
# Абзац заголовка: начинается со слова «Договор», «Контракт», «Соглашение».
TITLE_START = re.compile(
    r"^\W*(?:(?:проект|типовой)\s+)?(?:договор|контракт|соглашение)", re.IGNORECASE
)
# Дата или год: не номер, даже если стоит сразу после слова «Договор».
DATE_OR_YEAR = re.compile(r"\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{4}")
# Символы в конце номера, не входящие в него: «№ А-15.» - номер «А-15».
NUMBER_TRAILING = ".:-–—"

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
# Преамбула исполнителя: заполнитель наименования нередко стоит в самом начале абзаца
# («___, именуемое «Исполнитель», и ...») или после «между»; остальные условия те же.
PREAMBLE_NAME_ANY = re.compile(
    rf"(?:^\s*|(?<!\w)и\s*|одной\s+стороны\s*,?(?:\s*и)?\s*|(?<!\w)между\s+)"
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


@dataclass(frozen=True)
class NumberEdit:
    """Просьба сотрудника поправить номер договора: допись или замена.

    Attributes:
        mode: `append` (дописать `separator + text` к номеру) или `replace` (заменить номер).
        text: Новый текст: допись или номер целиком; до 60 знаков, без переводов строк.
        separator: Разделитель для `append`; по умолчанию « / ».
    """

    mode: str
    text: str
    separator: str = DEFAULT_NUMBER_SEPARATOR


@dataclass
class AmendReport:
    """Что сделано и что не найдено: факты без значений (кроме номера договора - не ПДн).

    `number_*` заполняются только при запросе правки номера (`number_edit`); без неё номер не
    тронут, а полей в ответе нет (`as_dict`).
    """

    party: str = PARTY_CUSTOMER
    preamble_filled: bool = False
    customer_block_filled: bool = False
    party_block_filled: bool = False
    placeholders_filled: int = 0
    lines_added: int = 0
    unfilled_placeholders: int = 0
    not_found: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    number_status: str | None = None
    number_before: str | None = None
    number_after: str | None = None

    def missing(self, code: str, note: str) -> None:
        """Записывает, чего не найдено: машинный код (без повтора) и читаемую ноту."""
        if code not in self.not_found:
            self.not_found.append(code)
        self.notes.append(note)

    def as_dict(self) -> dict[str, Any]:
        """Поля ответа: `number_*` есть только если правка номера запрашивалась."""
        data = asdict(self)
        if self.number_status is None:
            for key in ("number_status", "number_before", "number_after"):
                del data[key]
        return data


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


def _insert_at(paragraph: Any, position: int, new: str) -> None:
    """Вставляет `new` в текст абзаца перед символом `position`, внутри существующего run.

    Берётся run, в котором стоит символ перед позицией (последний символ номера): допись
    наследует его форматирование, новые run не создаются.
    """
    offset = 0
    target: Any = None
    target_begin = 0
    for node in _items(paragraph):
        if node.tag == W_BR:
            offset += 1
            continue
        length = len(node.text or "")
        if target is None and offset < position <= offset + length:
            target, target_begin = node, offset
        offset += length
    if target is None:
        raise AmendError(ERR_VERIFICATION, "место правки не найдено")
    text = target.text or ""
    cut = position - target_begin
    _set(target, text[:cut] + new + text[cut:])


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
    if "signature" not in block.kinds():
        report.missing(
            NF_SIGNATURE_LINE,
            "В блоке «Заказчик» не найдена строка подписи: место подписи проверьте вручную.",
        )
    fields = _our_fields(own.lines)
    used: set[str] = set()
    labelled = [p for p in block.content if _line_kind(_text(p)) == "labelled"]
    for paragraph in labelled:
        report.placeholders_filled += _fill_labelled(paragraph, fields, used)
    if {"inn", "kpp"} <= used:
        used.add("inn_kpp")
    # Заполнитель с меткой, для которой у нас нет значения (факс, e-mail), остался бы в
    # договоре пустым местом: такой файл сотруднику не отдаётся, реквизиты вписывают вручную.
    if any(PLACEHOLDER_RUN.search(_text(p)) for p in labelled):
        raise AmendError(ERR_PLACEHOLDERS_LEFT, "в блоке «Заказчик» остались пустые поля")
    inserted = _place_lines(block, own, used, report)
    inserted.update(fields.values())
    report.customer_block_filled = True
    report.party_block_filled = True
    return inserted


def _place_lines(
    block: _Block, own: OwnRequisites, used: set[str], report: AmendReport
) -> set[str]:
    """Наши строки в пустой блок: в пустые строки под заголовком, остаток - абзацами ниже.

    Наименование - первая строка блока. Строки подписи остаются после реквизитов.

    Returns:
        Вставленные строки (для сверки текста).
    """
    inserted: set[str] = set()
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
    return inserted


def _fill_executor_block(body: Any, own: OwnRequisites, report: AmendReport) -> set[str]:
    """Вписывает значения в блок исполнителя ТОЛЬКО в пустые места и заполнители.

    Существующий непустой текст не трогается никогда. Если в документе есть заполненный блок
    исполнителя, туда вписываются лишь значения в заполнители с метками («ИНН ____»); пустые
    блоки при этом считаются блоками подписи и не дополняются строками. Когда заполненных блоков
    нет, пустой блок заполняется как у заказчика (наименование и строки под заголовком).
    Незаполненные поля отказа не вызывают: они считаются и описываются в отчёте.

    Returns:
        Вставленные значения и строки (для сверки текста).
    """
    blocks = _candidate_blocks(body, EXECUTOR_ROLES)
    if not blocks:
        report.missing(NF_PARTY_BLOCK, "Блок исполнителя (поставщика) в документе не найден.")
        return set()
    any_filled = any("other" in block.kinds() for block in blocks)
    if any_filled:
        eligible = [block for block in blocks if "labelled" in block.kinds()]
    else:
        eligible = blocks
    if not eligible:
        report.missing(
            NF_PLACEHOLDERS,
            "В блоке исполнителя нет пустых мест и заполнителей: он уже заполнен, "
            "ничего не добавлено и не изменено.",
        )
        return set()
    block = max(eligible, key=lambda item: (_slot_score(item), -item.position))
    _materialize(block)
    if "signature" not in block.kinds():
        report.missing(
            NF_SIGNATURE_LINE,
            "В блоке исполнителя не найдена строка подписи: место подписи проверьте вручную.",
        )
    fields = _our_fields(own.lines)
    used: set[str] = set()
    labelled = [p for p in block.content if _line_kind(_text(p)) == "labelled"]
    filled = 0
    for paragraph in labelled:
        filled += _fill_labelled(paragraph, fields, used)
    report.placeholders_filled += filled
    if {"inn", "kpp"} <= used:
        used.add("inn_kpp")
    left = sum(len(PLACEHOLDER_RUN.findall(_text(p))) for p in labelled)
    if left:
        report.unfilled_placeholders += left
        report.notes.append(
            f"В блоке исполнителя остались незаполненные поля с метками: {left}; "
            "для них нет значения, поля оставлены как есть."
        )
    if any_filled:
        inserted: set[str] = set()
        if not filled:
            report.missing(
                NF_PLACEHOLDERS,
                "В блоке исполнителя нет полей, подходящих под присланные реквизиты: "
                "ничего не добавлено и не изменено.",
            )
        else:
            report.notes.append(
                "Блок исполнителя уже заполнен: вписаны только значения в пустые поля с метками."
            )
    else:
        inserted = _place_lines(block, own, used, report)
    # Допустимы только вставки значений, реально вписанных по меткам (а не всех наших).
    inserted.update(fields[key] for key in used if key in fields)
    report.party_block_filled = report.placeholders_filled > 0 or report.lines_added > 0
    return inserted


def _fill_preamble(
    body: Any,
    name: str,
    report: AmendReport,
    roles: tuple[str, ...] = CUSTOMER_ROLES,
    pattern: re.Pattern[str] = PREAMBLE_NAME,
) -> set[str]:
    """Наименование стороны на месте заполнителя в преамбуле («и ___, именуемое «Заказчик»»).

    Заполнитель должен стоять после «и»/«с одной стороны» (у исполнителя ещё и в начале абзаца
    или после «между») и перед «в лице»/«именуемое», а ближайшая роль в кавычках за ним - роль
    нужной стороны: «на основании ____» не трогается. Не найден - в отчёте `preamble`.
    """
    for paragraph in _body_paragraphs(body)[:HEAD_PARAGRAPHS]:
        text = _text(paragraph)
        for match in pattern.finditer(text):
            role = PARTY_ROLE_QUOTE.search(text, match.end("ph"))
            if role is None or role.group("role").casefold() not in roles:
                continue
            _replace_span(paragraph, match.start("ph"), match.end("ph"), name)
            report.preamble_filled = True
            return {name}
    side = "Заказчик" if roles == CUSTOMER_ROLES else "Исполнитель"
    report.missing(
        NF_PREAMBLE,
        f"Заполнитель наименования стороны «{side}» в преамбуле не найден: "
        "преамбулу проверьте вручную.",
    )
    return set()


# ---------------------------------------------------------------- номер договора


@dataclass(frozen=True)
class _NumberHit:
    """Найденный номер: абзац и границы номера в тексте абзаца."""

    paragraph: Any
    start: int
    end: int
    text: str


@dataclass
class _NumberPlan:
    """Что сделать с номером: правки по абзацам (справа налево) и ожидаемый текст абзацев."""

    edits: list[tuple[_NumberHit, str]] = field(default_factory=list)
    overrides: dict[Any, str] = field(default_factory=dict)


def validate_number_edit(edit: NumberEdit) -> NumberEdit:
    """Проверяет просьбу о правке номера и возвращает её в нормальном виде (текст без краёв).

    Raises:
        AmendError: `bad_request` - неизвестный режим, пустой или слишком длинный текст,
            перевод строки или управляющий символ в тексте и разделителе.
    """
    if edit.mode not in NUMBER_MODES:
        raise AmendError(ERR_BAD_REQUEST, "неизвестный режим правки номера")
    text = edit.text.strip()
    if not text:
        raise AmendError(ERR_BAD_REQUEST, "пустой текст правки номера")
    if len(text) > MAX_NUMBER_TEXT_CHARS or len(edit.separator) > MAX_NUMBER_SEPARATOR_CHARS:
        raise AmendError(ERR_BAD_REQUEST, "слишком длинный текст правки номера")
    for value in (text, edit.separator):
        if any(unicodedata.category(char) in FORBIDDEN_TEXT_CATEGORIES for char in value):
            raise AmendError(ERR_BAD_REQUEST, "в тексте правки номера недопустимые символы")
    return NumberEdit(edit.mode, text, edit.separator)


def _trim_number(token: str) -> str:
    """Номер без хвостовых знаков («А-15.» -> «А-15»); ряд подчёркиваний остаётся как есть."""
    if PLACEHOLDER_RUN.fullmatch(token):
        return token
    return token.rstrip(NUMBER_TRAILING)


def _is_placeholder_number(number: str) -> bool:
    return PLACEHOLDER_RUN.fullmatch(number) is not None


def _symbol_hits(paragraph: Any, text: str) -> list[_NumberHit]:
    """Номера с символом «№»/«N»/«No» в тексте абзаца: нужна цифра или заполнитель."""
    hits: list[_NumberHit] = []
    for match in TITLE_NUMBER.finditer(text):
        number = _trim_number(match.group("num"))
        if not number or not (any(c.isdigit() for c in number) or _is_placeholder_number(number)):
            continue
        start = match.start("num")
        hits.append(_NumberHit(paragraph, start, start + len(number), number))
    return hits


def _symbolless_hit(paragraph: Any, text: str) -> _NumberHit | None:
    """Номер без символа: «Договор поставки А-15 от ...» - первое слово с цифрой после названия.

    Слова названия (только буквы) пропускаются; «от» (дата) и дата или год вместо номера -
    номера нет.
    """
    title = TITLE_START.match(text)
    if title is None:
        return None
    for index, word in enumerate(re.finditer(r"\S+", text[title.end() :])):
        if index >= SYMBOLLESS_MAX_WORDS:
            return None
        stripped = word.group(0).rstrip(".,;:")
        if stripped.casefold() == "от":
            return None
        if not any(char.isdigit() for char in stripped):
            continue
        if DATE_OR_YEAR.fullmatch(stripped) or re.fullmatch(NUMBER_TOKEN, stripped) is None:
            return None
        start = title.end() + word.start()
        return _NumberHit(paragraph, start, start + len(stripped), stripped)
    return None


def _find_numbers(body: Any) -> list[_NumberHit]:
    """Номера договора в заголовке: абзацы среди первых непустых, похожие на заголовок.

    Заголовок - абзац, начинающийся со слова «Договор»/«Контракт»/«Соглашение», либо абзац из
    одного номера («№ 103/11-26»). Ссылки в тексте («к Договору № 5», «доверенность № 15»)
    сюда не попадают. Номера без символа ищутся, только если с символом нет ни одного.
    """
    candidates: list[tuple[Any, str]] = []
    for paragraph in body.iter(W_P):
        text = _text(paragraph)
        if text.strip():
            candidates.append((paragraph, text))
        if len(candidates) >= TITLE_SCAN_PARAGRAPHS:
            break
    hits: list[_NumberHit] = []
    for paragraph, text in candidates:
        if TITLE_START.match(text) is not None or NUMBER_ONLY.match(text) is not None:
            hits.extend(_symbol_hits(paragraph, text))
    if hits:
        return hits
    for paragraph, text in candidates:
        found = _symbolless_hit(paragraph, text)
        if found is not None:
            hits.append(found)
    return hits


def _normalized(number: str) -> str:
    return re.sub(r"\s+", " ", number).strip()


def _plan_number_edit(body: Any, edit: NumberEdit, report: AmendReport) -> _NumberPlan:
    """Находит номер, решает что менять и записывает итог в отчёт (XML ещё не правится)."""
    plan = _NumberPlan()
    hits = _find_numbers(body)
    distinct = {_normalized(hit.text) for hit in hits}
    if not hits:
        report.number_status = NUMBER_NOT_FOUND
        report.missing(NF_NUMBER, "Номер договора в заголовке не найден: номер не менялся.")
        return plan
    if len(distinct) > 1:
        report.number_status = NUMBER_AMBIGUOUS
        report.missing(
            NF_NUMBER,
            "В заголовке несколько разных номеров: какой править, неясно, номер не менялся.",
        )
        return plan
    before = _normalized(hits[0].text)
    report.number_before = before
    suffix = edit.separator + edit.text
    if edit.mode == NUMBER_MODE_APPEND:
        if _is_placeholder_number(before):
            report.number_status = NUMBER_NOT_FOUND
            report.number_before = None
            report.missing(
                NF_NUMBER,
                "На месте номера договора только прочерк: дописывать не к чему, номер не менялся.",
            )
            return plan
        after = before + suffix
        unchanged = _normalized(before).endswith(_normalized(suffix))
    else:
        after = edit.text
        unchanged = before == after
    if unchanged:
        report.number_status = NUMBER_UNCHANGED
        report.number_after = before
        report.notes.append("Номер договора уже такой, как просили: правка не потребовалась.")
        return plan
    # Справа налево: правка позади не сдвигает позиции впереди.
    for hit in sorted(hits, key=lambda item: (item.start, item.end), reverse=True):
        plan.edits.append((hit, suffix if edit.mode == NUMBER_MODE_APPEND else edit.text))
        current = plan.overrides.get(hit.paragraph, _text(hit.paragraph))
        if edit.mode == NUMBER_MODE_APPEND:
            plan.overrides[hit.paragraph] = current[: hit.end] + suffix + current[hit.end :]
        else:
            plan.overrides[hit.paragraph] = current[: hit.start] + edit.text + current[hit.end :]
    report.number_status = (
        NUMBER_APPENDED if edit.mode == NUMBER_MODE_APPEND else NUMBER_REPLACED
    )
    report.number_after = after
    return plan


def _execute_number_edit(plan: _NumberPlan, edit: NumberEdit) -> None:
    """Правит номер на месте, внутри существующих run; затем сверяет текст абзацев с ожидаемым.

    Raises:
        AmendError: `verification_failed`, если текст абзаца после правки не равен ожидаемому.
    """
    for hit, value in plan.edits:
        if edit.mode == NUMBER_MODE_APPEND:
            _insert_at(hit.paragraph, hit.end, value)
        else:
            _replace_span(hit.paragraph, hit.start, hit.end, value)
    for paragraph, expected in plan.overrides.items():
        if _text(paragraph) != expected:
            raise AmendError(ERR_VERIFICATION, "правка номера выполнена не так, как запрошено")


# ---------------------------------------------------------------- сверка


def _paragraph_texts(body: Any, overrides: dict[Any, str] | None = None) -> list[str]:
    """Непустые строки документа: абзацы, а внутри абзаца - строки по мягким переносам.

    `overrides` - ожидаемый текст отдельных абзацев (правка номера), по узлу абзаца: так сверка
    получает «исходник с запрошенной правкой» и допускает именно её.
    """
    texts = [
        line
        for p in body.iter(W_P)
        for line in (overrides[p] if overrides and p in overrides else _text(p)).split("\n")
    ]
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
    *,
    party: str = PARTY_CUSTOMER,
    number_edit: NumberEdit | None = None,
) -> AmendResult:
    """Дополняет договор исполнителя нашими реквизитами и, по просьбе, правит номер.

    Номер договора меняется только при `number_edit`; без него он побайтно тот же.

    Args:
        data: Байты присланного docx (не изменяются); .doc и RTF к этому моменту уже
            сконвертированы (`office_convert`).
        own: Реквизиты для вписывания в сторону `party`; None - реквизитов нет (допустимо,
            если запрошена правка номера).
        limits: Лимиты разбора контейнеров.
        party: `customer` (по умолчанию) или `executor`: в чей блок вписываются реквизиты.
        number_edit: Просьба поправить номер договора (допись или замена); None - номер не
            меняется.

    Raises:
        AmendError: Нечего делать, неверные параметры, нет блока заказчика, блок уже заполнен,
            остались пустые поля, не прошла сверка текста и номеров.
        CorruptDocumentError / DocumentTooLargeError: Файл не читается / слишком большой или
            вышло время документа.
    """
    if own is None and number_edit is None:
        raise AmendError(ERR_NOTHING_TO_DO, "нечего добавлять")
    if party not in PARTIES:
        raise AmendError(ERR_BAD_REQUEST, "неизвестная сторона")
    if own is not None:
        validate_own(own)
    if number_edit is not None:
        number_edit = validate_number_edit(number_edit)
    deadline = Deadline(limits.max_ooxml_seconds)
    document = _open(data, limits, deadline)
    body = document.element.body
    report = AmendReport(party=party)
    plan = _NumberPlan()
    if number_edit is not None:
        plan = _plan_number_edit(body, number_edit, report)
    # Исходник с запрошенной правкой номера: ровно её сверка допускает, остальное - нет.
    before = _paragraph_texts(body, plan.overrides)
    if number_edit is not None:
        _execute_number_edit(plan, number_edit)
    added: set[str] = set()
    if own is not None:
        name = own.name.strip()
        if party == PARTY_CUSTOMER:
            added |= _fill_preamble(body, name, report)
            added |= _fill_customer_block(body, own, report)
        else:
            added |= _fill_preamble(body, name, report, EXECUTOR_ROLES, PREAMBLE_NAME_ANY)
            added |= _fill_executor_block(body, own, report)
    after = _paragraph_texts(body)
    verify_text_preserved(before, after, added, deadline)
    verify_numbers_preserved(before, after)
    buffer = io.BytesIO()
    document.save(buffer)
    logger.info(
        "дополнение договора: сторона %s, блок заполнен %s, строк добавлено %d, номер %s",
        party,
        report.party_block_filled,
        report.lines_added,
        report.number_status or "не запрашивался",
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
    "NumberEdit",
    "OwnRequisites",
    "PartyBlock",
    "amend_counterparty_contract",
    "read_party_block",
    "validate_number_edit",
    "verify_numbers_preserved",
    "verify_text_preserved",
]
