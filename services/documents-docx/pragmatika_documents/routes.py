"""Маршруты `/docx/*`: дополнение договора, блок стороны, подписант, вид договора.

Перенесены из прежнего сервиса документов Прагматики без изменения поведения: те же входы
(JSON с base64 и multipart `file` + `params`), те же ответы и коды отказов. Общий разбор тела,
очередь и выдача результата (в том числе на общий том) даёт платформенный `file_route`; здесь
только модели параметров, сами операции и отображение ошибок в HTTP.
"""

from __future__ import annotations

import base64
import logging
from collections.abc import Awaitable, Callable
from typing import Any, BinaryIO

from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from documents.api import (
    DETAIL_CORRUPT,
    DETAIL_TOO_LARGE,
    HEADER_REJECT_KIND,
    HTTP_TOO_LARGE,
    HTTP_UNAVAILABLE,
    HTTP_UNPROCESSABLE,
    REJECT_KIND_TRANSIENT,
    TRANSIENT_REASONS,
)
from documents.config import Settings
from documents.export import safe_file_name
from documents.file_routes import RESULT_CONTENT_KEY
from documents.models import CorruptDocumentError, DocumentTooLargeError
from documents.office_convert import ERR_SPOOL_UNAVAILABLE, ConversionError, prepare_docx
from documents.priority_gate import PriorityGate
from documents.source import Source, read_all
from pragmatika_documents.contract_kind import (
    MAX_OWN_VALUE_CHARS,
    MAX_OWN_VALUES,
    MAX_TEMPLATES,
    classify_contract,
)
from pragmatika_documents.docx_amend import (
    DEFAULT_NUMBER_SEPARATOR,
    DOCX_MIME,
    PARTY_CUSTOMER,
    AmendError,
    NumberEdit,
    OwnRequisites,
    amend_counterparty_contract,
    read_party_block,
    validate_number_edit,
)
from pragmatika_documents.docx_pages import document_pages
from pragmatika_documents.docx_signatory import SignatoryForms, replace_signatory

logger = logging.getLogger(__name__)

# Сигнатура платформенного `file_route` (см. `documents.api.FileTools`).
FileRoute = Callable[..., Awaitable[Response]]

ROUTE_AMEND = "/docx/amend"
ROUTE_PARTY_BLOCK = "/docx/party-block"
ROUTE_REPLACE_SIGNATORY = "/docx/replace-signatory"
ROUTE_CLASSIFY = "/docx/classify"
ROUTE_PAGES = "/docx/pages"
# Все маршруты пакета: по ним проверка маршрутов и тесты отличают проектные ручки.
DOCX_ROUTES = (
    ROUTE_AMEND,
    ROUTE_PARTY_BLOCK,
    ROUTE_REPLACE_SIGNATORY,
    ROUTE_CLASSIFY,
    ROUTE_PAGES,
)
ERR_BAD_REQUEST = "bad_request"
MAX_SIGNATORY_FORM_CHARS = 200


class OwnRequisitesModel(BaseModel):
    """Наши данные для стороны заказчика: наименование и строки реквизитов."""

    name: str = Field(min_length=1)
    lines: list[str] = Field(default_factory=list)


class NumberEditModel(BaseModel):
    """Просьба поправить номер договора (`number_edit`): допись или замена.

    Режим и текст проверяет код (`validate_number_edit`), а не схема: отказ приходит в виде
    `422 {"detail": {"error": "bad_request"}}`, как и остальные отказы /docx/amend.
    """

    mode: str
    text: str
    separator: str = DEFAULT_NUMBER_SEPARATOR


class AmendContractParams(BaseModel):
    """Параметры /docx/amend без файла: поле `params` multipart-входа и часть JSON-тела.

    Номер договора по умолчанию не меняется: он правится только при `number_edit` (решение
    владельца 19.11.2026). Поля «наш номер» нет; старый вызов с `our_number` не падает: лишние
    поля принимаются и игнорируются, а обработчик пишет в журнал только их имена
    (`extra="allow"`, значения в журнал не попадают). `party` - в чей блок вписываются
    реквизиты (`customer` по умолчанию | `executor`); значение проверяет код.
    """

    model_config = ConfigDict(extra="allow")

    file_name: str = Field(min_length=1)
    own_requisites: OwnRequisitesModel | None = None
    party: str = PARTY_CUSTOMER
    number_edit: NumberEditModel | None = None


class AmendContractRequest(AmendContractParams):
    """Тело /docx/amend: договор исполнителя и наши реквизиты."""

    content_base64: str


class PartyBlockParams(BaseModel):
    """Параметры /docx/party-block без файла: роль стороны («Заказчик»)."""

    role: str = Field(min_length=1)


class PartyBlockRequest(PartyBlockParams):
    """Тело /docx/party-block: документ и роль стороны («Заказчик»)."""

    content_base64: str


class ReplaceSignatoryParams(BaseModel):
    """Параметры /docx/replace-signatory без файла: новый подписант нашей стороны в формах."""

    nominative_short: str = Field(min_length=1, max_length=MAX_SIGNATORY_FORM_CHARS)
    nominative_reversed: str = Field(min_length=1, max_length=MAX_SIGNATORY_FORM_CHARS)
    genitive_full: str = Field(min_length=1, max_length=MAX_SIGNATORY_FORM_CHARS)
    genitive_short: str = Field(min_length=1, max_length=MAX_SIGNATORY_FORM_CHARS)


class ReplaceSignatoryRequest(ReplaceSignatoryParams):
    """Тело /docx/replace-signatory: шаблон договора и формы подписанта."""

    content_base64: str


class ClassifyContractParams(BaseModel):
    """Параметры /docx/classify без файла: наши шаблоны и наши юрлица (ИНН, наименования).

    Шаблоны сервис не монтирует: их читает ядро и присылает байтами (не больше MAX_TEMPLATES).
    """

    file_name: str = Field(min_length=1)
    templates_base64: list[str] = Field(default_factory=list, max_length=MAX_TEMPLATES)
    own_inns: list[str] = Field(default_factory=list, max_length=MAX_OWN_VALUES)
    own_names: list[str] = Field(default_factory=list, max_length=MAX_OWN_VALUES)


class ClassifyContractRequest(ClassifyContractParams):
    """Тело /docx/classify: присланный договор и параметры."""

    content_base64: str


class PagesParams(BaseModel):
    """Параметры /docx/pages без файла: имя файла нужно лишь для журнала, поэтому необязательно."""

    file_name: str = ""


class PagesRequest(PagesParams):
    """Тело /docx/pages: документ (docx, .doc или RTF) в base64."""

    content_base64: str


def decode_docx(content_base64: str) -> bytes:
    """Байты документа из base64; не base64 - `AmendError` с кодом `bad_request`."""
    try:
        return base64.b64decode(content_base64, validate=True)
    except ValueError as exc:
        raise AmendError(ERR_BAD_REQUEST, "content_base64 не является base64") from exc


def amend_refusal(exc: AmendError | ConversionError) -> HTTPException:
    """422 с машинным кодом отказа; текст ошибки со значениями наружу не уходит.

    Нехватка места на томе спула - 503: сбой временный и от файла не зависит.
    """
    if exc.code == ERR_SPOOL_UNAVAILABLE:
        return HTTPException(HTTP_UNAVAILABLE, {"error": exc.code})
    return HTTPException(HTTP_UNPROCESSABLE, {"error": exc.code})


def too_large(exc: DocumentTooLargeError) -> HTTPException:
    """413 с фиксированным текстом; для причин, зависящих от нагрузки, добавляет заголовок."""
    logger.info("разбор отклонён по лимиту: %s", exc.reason)
    headers = (
        {HEADER_REJECT_KIND: REJECT_KIND_TRANSIENT} if exc.reason in TRANSIENT_REASONS else None
    )
    return HTTPException(HTTP_TOO_LARGE, DETAIL_TOO_LARGE, headers=headers)


async def _guarded(call: Awaitable[Response]) -> Response:
    """Ждёт ответ ручки и переводит ошибки документа в HTTP-отказы."""
    try:
        return await call
    except (AmendError, ConversionError) as exc:
        raise amend_refusal(exc) from exc
    except DocumentTooLargeError as exc:
        raise too_large(exc) from exc
    except CorruptDocumentError as exc:
        raise HTTPException(HTTP_UNPROCESSABLE, DETAIL_CORRUPT) from exc


def register_docx_routes(
    app: FastAPI, cfg: Settings, file_route: FileRoute, gate: PriorityGate
) -> None:
    """Регистрирует маршруты `/docx/*` на приложении платформы.

    Args:
        app: Приложение, которое вернул платформенный `create_app`.
        cfg: Настройки сервиса (лимиты разбора).
        file_route: Платформенная ручка с двумя входами (multipart и JSON).
        gate: Очередь договорных заданий (своё место сверх слотов разбора).
    """

    @app.post(ROUTE_AMEND)
    async def amend_contract(request: Request) -> Response:
        """Дополняет договор реквизитами (`party`: заказчик или исполнитель), правит номер.

        Номер договора не меняется, пока не передан `number_edit`. Текст исполнителя не
        удаляется и не заменяется (проверяется после правки). Принимает docx, а также .doc и RTF
        (конвертируются), ответ всегда docx. В ответе `not_found` и `notes` - что найти не
        удалось. Отказ: 422 `{"detail": {"error": "<код>"}}`; время или размер - 413; спул не
        принял файлы - 503 `spool_unavailable`. Схема: `CONTRACT-8y.md`.
        """

        def run(data: Source, body: AmendContractParams, _sink: BinaryIO | None) -> dict[str, Any]:
            if body.model_extra:
                # Старый вызов с «нашим номером» (параметр удалён): игнорируем, значений нет.
                logger.warning(
                    "дополнение договора: лишние поля запроса игнорируются: %s",
                    ",".join(sorted(body.model_extra)),
                )
            # Просьба о номере проверяется до конвертации: плохой текст отклоняется сразу.
            wanted = body.number_edit
            edit = (
                None if wanted is None else NumberEdit(wanted.mode, wanted.text, wanted.separator)
            )
            if edit is not None:
                validate_number_edit(edit)
            # docx правится python-docx целиком в памяти: файл читается разом (договор, не прайс)
            prepared = prepare_docx(read_all(data), cfg.limits)
            own = (
                None
                if body.own_requisites is None
                else OwnRequisites(body.own_requisites.name, tuple(body.own_requisites.lines))
            )
            result = amend_counterparty_contract(
                prepared.content, own, cfg.limits, party=body.party, number_edit=edit
            )
            stem = body.file_name.rsplit(".", 1)[0] if "." in body.file_name else body.file_name
            return {
                "file_name": safe_file_name(stem, "docx"),
                "mime_type": DOCX_MIME,
                "converted_from": prepared.converted_from,
                **result.report.as_dict(),
                RESULT_CONTENT_KEY: result.content,
            }

        return await _guarded(
            file_route(request, AmendContractRequest, AmendContractParams, decode_docx, run, gate)
        )

    @app.post(ROUTE_PARTY_BLOCK)
    async def party_block(request: Request) -> Response:
        """Читает блок стороны («Заказчик») документа: наименование и строки реквизитов.

        Входы те же, что у `/docx/amend`: JSON (`content_base64`, `role`) и multipart
        `file` + `params` (`{"role": ...}`). Принимает .doc и RTF (конвертируются в docx).
        """

        def run(data: Source, body: PartyBlockParams, _sink: BinaryIO | None) -> dict[str, Any]:
            prepared = prepare_docx(read_all(data), cfg.limits)
            block = read_party_block(prepared.content, body.role, cfg.limits)
            return {"name": block.name, "lines": list(block.lines)}

        return await _guarded(
            file_route(request, PartyBlockRequest, PartyBlockParams, decode_docx, run, gate)
        )

    @app.post(ROUTE_REPLACE_SIGNATORY)
    async def replace_signatory_route(request: Request) -> Response:
        """Подставляет подписанта нашей стороны в шаблон договора вместо напечатанного.

        Прежний подписант определяется по самому шаблону (якоря «в лице ... действующего» и
        строка подписи). Ответ `{file_name, mime_type, content_base64, found, replaced,
        unchanged}`; значений нет. Отказ 422: `signatory_not_found`, `signatory_inconsistent`,
        `signatory_left`, `verification_failed`, `bad_request`.
        """

        def run(
            data: Source, body: ReplaceSignatoryParams, _sink: BinaryIO | None
        ) -> dict[str, Any]:
            prepared = prepare_docx(read_all(data), cfg.limits)
            result = replace_signatory(
                prepared.content,
                SignatoryForms(
                    body.nominative_short,
                    body.nominative_reversed,
                    body.genitive_full,
                    body.genitive_short,
                ),
                cfg.limits,
            )
            return {
                "file_name": "contract.docx",
                "mime_type": DOCX_MIME,
                "found": result.report.found,
                "replaced": result.report.replaced,
                "unchanged": result.report.unchanged,
                RESULT_CONTENT_KEY: result.content,
            }

        return await _guarded(
            file_route(
                request, ReplaceSignatoryRequest, ReplaceSignatoryParams, decode_docx, run, gate
            )
        )

    @app.post(ROUTE_CLASSIFY)
    async def classify_contract_route(request: Request) -> Response:
        """Признак «договор поставщика» кодом: не наш шаблон и сторона исполнителя заполнена.

        Ответ `{verdict, reasons, converted_from}`: `supplier` / `own_template` /
        `our_side_executor` / `unclear`; значений документа в нём нет.
        """

        def run(
            data: Source, body: ClassifyContractParams, _sink: BinaryIO | None
        ) -> dict[str, Any]:
            if any(len(item) > MAX_OWN_VALUE_CHARS for item in [*body.own_inns, *body.own_names]):
                raise AmendError(ERR_BAD_REQUEST, "слишком длинные наши данные")
            prepared = prepare_docx(read_all(data), cfg.limits)
            templates = [decode_docx(item) for item in body.templates_base64]
            kind = classify_contract(
                prepared.content, templates, body.own_inns, body.own_names, cfg.limits
            )
            return {
                "verdict": kind.verdict,
                "reasons": list(kind.reasons),
                "converted_from": prepared.converted_from,
            }

        return await _guarded(
            file_route(
                request, ClassifyContractRequest, ClassifyContractParams, decode_docx, run, gate
            )
        )


    @app.post(ROUTE_PAGES)
    async def pages_route(request: Request) -> Response:
        """Тексты страниц документа по фактической раскладке (рендер LibreOffice в PDF).

        Принимает docx, .doc и RTF. Ответ `{page_count, pages: [{number, text}], truncated}`:
        номера с 1, пустая страница - пустой `text`; страниц не больше 500, текста на страницу
        не больше 20000 знаков, сверх - `truncated: true` (`page_count` остаётся настоящим).
        Отказ: 422 `{"detail": {"error": "<код>"}}`; размер или время - 413; спул не принял
        файлы - 503 `spool_unavailable`. Схема: `CONTRACT-9p.md`.
        """

        def run(data: Source, _body: PagesParams, _sink: BinaryIO | None) -> dict[str, Any]:
            # PDF строится из файла целиком: читаем его разом, как и у остальных договорных ручек
            return document_pages(read_all(data), cfg.limits).as_dict()

        return await _guarded(
            file_route(request, PagesRequest, PagesParams, decode_docx, run, gate)
        )
