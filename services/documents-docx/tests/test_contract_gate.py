"""Договорные ручки (/docx/*, конвертация LibreOffice) идут в своём месте, мимо слотов разбора.

Решение владельца 9 (08.11.2026): число мест как в бою. В бою слот разбора один
(DOCUMENTS_PARSE_CONCURRENCY=1); конвертация .doc/RTF его не отнимает.
"""

from __future__ import annotations

import base64
import threading
import time

import anyio
import httpx
import pytest

from documents import api as api_module
from pragmatika_documents import routes as routes_module
from pragmatika_documents.app import create_app
from documents.config import Settings, load_settings
from documents.models import ParseResult
from test_docx_amend import OUR_LINES, OUR_NAME, SIGNATURE, make_contract

WAIT = 5.0


def _party_block_body() -> dict[str, str]:
    template = make_contract(["Заказчик:", *OUR_LINES, "", SIGNATURE])
    return {"content_base64": base64.b64encode(template).decode("ascii"), "role": "Заказчик"}


def test_contract_route_does_not_wait_for_the_busy_parse_slot(
    xlsx_bytes: bytes, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Разбор держит единственный слот, договорная ручка при этом отвечает."""
    release = threading.Event()
    started = threading.Event()

    def blocked_parse(data: bytes, filename: str, limits: object) -> ParseResult:
        started.set()
        release.wait(WAIT)
        return ParseResult(format="xlsx")

    monkeypatch.setattr(api_module, "parse_document", blocked_parse)
    app = create_app(Settings(parse_concurrency=1))
    outcome: dict[str, object] = {}

    async def scenario() -> None:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://d") as client:

            async def parse() -> None:
                await client.post("/parse", files={"file": ("a.xlsx", xlsx_bytes)})

            async def contract() -> None:
                while not started.is_set():
                    await anyio.sleep(0.01)
                began = time.monotonic()
                response = await client.post("/docx/party-block", json=_party_block_body())
                outcome["status"] = response.status_code
                outcome["name"] = response.json().get("name")
                outcome["seconds"] = time.monotonic() - began
                release.set()

            async with anyio.create_task_group() as group:
                group.start_soon(parse)
                group.start_soon(contract)

    anyio.run(scenario)
    assert outcome["status"] == 200 and outcome["name"] == OUR_NAME
    assert outcome["seconds"] < WAIT / 2  # не ждал, пока освободится слот разбора


def test_parse_does_not_wait_for_the_busy_contract_slot(
    xlsx_bytes: bytes, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Обратное: долгая конвертация договора не занимает место разбора и правки."""
    release = threading.Event()
    started = threading.Event()

    def blocked_prepare(data: bytes, limits: object) -> object:
        started.set()
        release.wait(WAIT)
        return real_prepare(data, limits)

    real_prepare = routes_module.prepare_docx
    monkeypatch.setattr(routes_module, "prepare_docx", blocked_prepare)
    app = create_app(Settings(parse_concurrency=1))
    outcome: dict[str, object] = {}

    async def scenario() -> None:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://d") as client:

            async def contract() -> None:
                await client.post("/docx/party-block", json=_party_block_body())

            async def parse() -> None:
                while not started.is_set():
                    await anyio.sleep(0.01)
                began = time.monotonic()
                response = await client.post("/parse", files={"file": ("a.xlsx", xlsx_bytes)})
                outcome["status"] = response.status_code
                outcome["seconds"] = time.monotonic() - began
                release.set()

            async with anyio.create_task_group() as group:
                group.start_soon(contract)
                group.start_soon(parse)

    anyio.run(scenario)
    assert outcome["status"] == 200
    assert outcome["seconds"] < WAIT / 2


def test_contract_slots_default_to_one_and_come_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Число договорных мест берётся из настройки конвертации платформы (прежнее имя env живо)."""
    assert Settings().convert_concurrency == 1
    monkeypatch.setenv("DOCUMENTS_CONTRACT_CONCURRENCY", "2")
    assert load_settings().convert_concurrency == 2
    with pytest.raises(ValueError):
        Settings(convert_concurrency=0)
