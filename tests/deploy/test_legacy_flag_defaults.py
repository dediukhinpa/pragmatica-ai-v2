"""Флаги платформы, которые в прежнем коде Прагматики действовали всегда, включены по умолчанию."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

PROJECT_COMPOSE = Path(__file__).resolve().parents[2] / "deploy" / "compose.project.yml"
# Имя флага -> почему он должен быть включён (прежний код делал это без флага)
ALWAYS_ON_FLAGS = {
    "WEB_SEARCH_LIMIT_WARNINGS": "длинный запрос поиска сокращается с предупреждением",
    "EMAIL_DRAFT_LIMIT_WARNINGS": "черновик письма нормализуется с предупреждениями",
    "AGENT_SCRIPT_ERROR_FALLBACK": "после ошибки разбора файла модель получает подсказку",
    "WEB_SEARCH_ENABLED": "инструмент поиска в интернете был всегда",
    "B24_TASK_DEAL_LINK": "привязка задач к сделкам читалась всегда",
    "B24_PORTAL_LINKS": "ссылки портала разбирались всегда",
    "TEMPLATE_WORKBOOK_ENABLED": "xlsx-шаблоны через сервис documents были всегда",
}


class LegacyFlagDefaultsTest(unittest.TestCase):
    """Умолчания флагов в compose.project.yml."""

    def test_always_on_flags_default_true(self) -> None:
        text = PROJECT_COMPOSE.read_text(encoding="utf-8")
        for name, why in ALWAYS_ON_FLAGS.items():
            with self.subTest(flag=name):
                pattern = rf"^\s+{name}: \$\{{{name}:-true\}}\s*$"
                self.assertRegex(text, re.compile(pattern, re.M), why)


if __name__ == "__main__":
    unittest.main()
