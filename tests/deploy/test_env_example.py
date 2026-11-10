"""Образец deploy/.env.example: полнота, формат и значения ПДн по решениям владельца."""

from __future__ import annotations

import re
import unittest

import baseline_data as base
import compose_loader as loader

# Активная строка образца: `KEY=значение` (значение может быть пустым).
ACTIVE_RE = re.compile(r"^([A-Z_][A-Z0-9_]*)=(.*)$")
# Имена секретов: значение в образце должно быть пустым.
SECRET_NAME_RE = re.compile(r"_(TOKEN|API_KEY|PASSWORD|SECRET|PRIVATE_KEY)$")
# Решения владельца по ПДн: имя -> значение в образце.
PII_DECISIONS = {
    "PSEUDONYMIZER_STORE": "sqlite",
    "PSEUDONYMIZER_KEY_SCHEME": "v2",
    "PSEUDONYMIZER_ENABLE_INFLECT_SIGNATORY": "on",
    "PSEUDONYMIZER_ENABLE_DELETE_THREADS": "off",
    "PSEUDONYMIZER_ENABLE_EXPOSE_BOOT_ID": "off",
    "PSEUDONYMIZER_ENABLE_CASE_LABELS": "off",
    "PSEUDONYMIZER_MAX_INFLIGHT": "2",
    "PSEUDONYMIZER_ADDRESS_MASK": "on",
    "PSEUDONYMIZER_MASK_LEGAL_ENTITY": "false",
    "PSEUDONYMIZER_RETENTION_DAYS": "90",
    "IMAGE_TEXT_MODE": "tokens",
    "IMAGE_TEXT_OCR_IN_DOCUMENTS": "true",
    "IMAGE_TEXT_GATE": "enforce",
    "WEB_PAGE_PII_STRIP": "enforce",
}
# Переменные образов подставляет images.lock, в образце они не объявляются.
IMAGE_VAR_PREFIX = "BAI_IMAGE_"
# Переменные, которые compose сам подставляет из окружения оболочки или обёртки.
SHELL_VARS = frozenset({"HOME", "PWD", "USER", "COMPOSE_PROJECT_NAME"})


def active_values() -> dict[str, str]:
    """Активные (не закомментированные) пары образца."""
    values: dict[str, str] = {}
    for line in loader.ENV_EXAMPLE_FILE.read_text(encoding="utf-8").splitlines():
        match = ACTIVE_RE.match(line)
        if match:
            values[match.group(1)] = match.group(2)
    return values


class EnvExampleTest(unittest.TestCase):
    """Проверки образца окружения."""

    def test_all_prod_names_present(self) -> None:
        """Каждое из 163 имён боевого .env есть в образце или в compose."""
        known = loader.declared_in_example() | loader.referenced_vars()
        missing = sorted(set(base.PROD_ENV_NAMES) - known)
        self.assertEqual([], missing)

    def test_compose_vars_declared(self) -> None:
        """Все переменные compose объявлены в образце (кроме образов и оболочки)."""
        declared = loader.declared_in_example()
        missing = sorted(
            name
            for name in loader.referenced_vars()
            if name not in declared
            and not name.startswith(IMAGE_VAR_PREFIX)
            and name not in SHELL_VARS
        )
        self.assertEqual([], missing)

    def test_required_vars_declared(self) -> None:
        """Обязательные переменные (`:?`) объявлены в образце."""
        required = {n for n in loader.required_vars() if not n.startswith(IMAGE_VAR_PREFIX)}
        missing = sorted(required - loader.declared_in_example())
        self.assertEqual([], missing)

    def test_value_format(self) -> None:
        """Значения без кавычек и без хвостовых комментариев (формат docker compose)."""
        bad: list[str] = []
        for name, value in active_values().items():
            if name == "BITRIX24_BOTS":
                continue  # JSON допускает кавычки внутри значения
            if value[:1] in {'"', "'"} or " #" in value:
                bad.append(name)
        self.assertEqual([], bad)

    def test_no_duplicate_active_keys(self) -> None:
        """Ключ не повторяется среди активных строк."""
        keys = [
            m.group(1)
            for line in loader.ENV_EXAMPLE_FILE.read_text(encoding="utf-8").splitlines()
            if (m := ACTIVE_RE.match(line))
        ]
        duplicates = sorted({key for key in keys if keys.count(key) > 1})
        self.assertEqual([], duplicates)

    def test_secret_names_empty(self) -> None:
        """У секретных имён нет значений."""
        filled = [n for n, v in active_values().items() if SECRET_NAME_RE.search(n) and v]
        self.assertEqual([], filled)

    def test_pii_decisions(self) -> None:
        """Значения ПДн соответствуют решениям владельца."""
        values = active_values()
        for name, expected in PII_DECISIONS.items():
            with self.subTest(name=name):
                self.assertEqual(expected, values.get(name))

    def test_allowed_words_empty(self) -> None:
        """Слова-исключения ПДн в репозиторий не кладутся."""
        self.assertEqual("", active_values().get("PII_ALLOWED_WORDS"))

    def test_line_length(self) -> None:
        """Строки образца не длиннее 100 символов (кроме JSON-значений ботов)."""
        long_lines = [
            number
            for number, line in enumerate(
                loader.ENV_EXAMPLE_FILE.read_text(encoding="utf-8").splitlines(), start=1
            )
            if len(line) > 100 and "BITRIX24_BOTS" not in line
        ]
        self.assertEqual([], long_lines)


if __name__ == "__main__":
    unittest.main()
