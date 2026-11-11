"""Проверки deploy/compat.env: старые имена и значения по умолчанию, сохраняющие поведение."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

COMPAT = Path(__file__).resolve().parents[2] / "deploy" / "compat.env"


def _lines() -> dict[str, str]:
    """Разобрать присваивания `ИМЯ=значение` без комментариев."""
    result: dict[str, str] = {}
    for line in COMPAT.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^([A-Z][A-Z0-9_]*)=(.*)$", line)
        if match:
            result[match.group(1)] = match.group(2)
    return result


class CompatEnvTest(unittest.TestCase):
    """Совместимость переменных окружения."""

    def test_owner_thread_falls_back_to_manager_thread(self) -> None:
        self.assertIn("MANAGER_THREAD_ID", _lines()["OWNER_THREAD_ID"])

    def test_warnings_rule_on_by_default(self) -> None:
        """Прежний код всегда добавлял правило предупреждений в промпт агентов."""
        self.assertEqual(
            _lines()["FEEDBACK_LIMIT_WARNINGS"], "${FEEDBACK_LIMIT_WARNINGS:-true}"
        )

    def test_pair_notes_follow_supplier_cards(self) -> None:
        self.assertIn("SUPPLIER_CARDS_ENABLED", _lines()["PAIR_NOTES_ENABLED"])


if __name__ == "__main__":
    unittest.main()
