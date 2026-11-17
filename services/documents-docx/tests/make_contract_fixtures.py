"""Пишет синтетические docx для контрактного теста адаптера v2: `make_contract_fixtures.py <каталог>`.

Файлы строятся программно (синтетика, без данных заказчика) теми же построителями, что и тесты
маршрутов. Запуск не требует pytest: нужны python-docx и пакет `pragmatika_documents` в пути.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_contract_kind import OUR_INN, OUR_NAME, our_template, supplier_contract  # noqa: E402
from test_docx_amend import OUR_LINES, make_contract  # noqa: E402
from test_docx_signatory import _template as signatory_template  # noqa: E402

# Имя файла -> байты. Имена зашиты в контрактный тест адаптера.
FIXTURES = {
    "contract.docx": make_contract,
    "signatory-template.docx": signatory_template,
    "own-template.docx": our_template,
    "supplier.docx": supplier_contract,
}
# Параметры для теста вынесены в JSON, чтобы тест не знал внутренностей построителей.
META = {"ownName": OUR_NAME, "ownInn": OUR_INN, "ownLines": OUR_LINES}


def main(argv: list[str]) -> int:
    """Пишет фикстуры и meta.json в каталог из argv[1]."""
    import json

    if len(argv) != 2:
        print("использование: make_contract_fixtures.py <каталог>", file=sys.stderr)
        return 2
    target = Path(argv[1])
    target.mkdir(parents=True, exist_ok=True)
    for name, build in FIXTURES.items():
        (target / name).write_bytes(build())
    (target / "meta.json").write_text(json.dumps(META, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
