"""Образцы config/: корректный формат, полнота политики доступа, условные идентификаторы."""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path
from typing import Any

import baseline_data as base
import compose_loader as loader

CONFIG_DIR = loader.REPO_DIR / "config"
# Образец: `имя.ext.example` или `имя.example.json`.
EXAMPLE_MARKERS = (".example", ".example.json")
# Допустимые id в образце политики: условные идентификаторы пользователей и малые числа групп.
PLACEHOLDER_USER_RE = re.compile(r"^employee-id-\d+$")
GROUP_ID_RE = re.compile(r"^\d{1,2}$")
# Слова-исключения: буквы и одиночные дефисы внутри слова, до 64 байт.
ALLOWED_WORD_RE = re.compile(r"^[^\W\d_]+(-[^\W\d_]+)*$")
MAX_WORD_BYTES = 64
# Подразделы правил доступа.
RULE_KEYS = ("allow", "deny")


def example_files() -> list[Path]:
    """Все образцы в config/."""
    return sorted(p for p in CONFIG_DIR.iterdir() if p.name.endswith(EXAMPLE_MARKERS))


def load_json(name: str) -> Any:
    """Читает JSON-образец из config/."""
    return json.loads((CONFIG_DIR / name).read_text(encoding="utf-8"))


def collect_actions(policy: dict[str, Any]) -> set[str]:
    """Действия, перечисленные в политике по всем ботам."""
    found: set[str] = set()
    for bot in policy["bots"].values():
        found.update(bot.get("actions", {}).keys())
    return found


def collect_ids(node: Any, key: str = "") -> list[tuple[str, str]]:
    """Рекурсивно собирает пары (раздел, id) из списков users/departments/workgroups."""
    pairs: list[tuple[str, str]] = []
    if isinstance(node, dict):
        for name, value in node.items():
            pairs.extend(collect_ids(value, name))
    elif isinstance(node, list):
        pairs.extend((key, str(item)) for item in node)
    return pairs


class ConfigExamplesTest(unittest.TestCase):
    """Проверки образцов."""

    def test_only_examples_in_repo(self) -> None:
        """В config/ только README и образцы (боевых файлов нет)."""
        extra = [
            p.name for p in CONFIG_DIR.iterdir()
            if p.name != "README.md" and not p.name.endswith(EXAMPLE_MARKERS)
        ]
        self.assertEqual([], extra)

    def test_json_examples_valid(self) -> None:
        """Все JSON-образцы разбираются."""
        for path in example_files():
            if ".json" in path.name:
                with self.subTest(file=path.name):
                    self.assertIsInstance(json.loads(path.read_text(encoding="utf-8")), dict)

    def test_access_policy_covers_all_actions(self) -> None:
        """Образец политики упоминает все действия, которые знает ядро."""
        policy = load_json("access-policy.example.json")
        self.assertEqual(set(base.ACCESS_ACTIONS), collect_actions(policy))

    def test_access_policy_bots(self) -> None:
        """Боты политики: documents, prices, order-calc, site-export."""
        policy = load_json("access-policy.example.json")
        self.assertEqual(1, policy["version"])
        self.assertEqual(
            {"documents", "prices", "order-calc", "site-export"}, set(policy["bots"])
        )

    def test_access_policy_placeholder_ids(self) -> None:
        """В политике только условные идентификаторы."""
        policy = load_json("access-policy.example.json")
        for section, value in collect_ids(policy["bots"]):
            if section == "users":
                self.assertRegex(value, PLACEHOLDER_USER_RE, value)
            elif section in {"departments", "workgroups"}:
                self.assertRegex(value, GROUP_ID_RE, value)

    def test_access_policy_rule_keys(self) -> None:
        """Правила содержат только allow и deny."""
        policy = load_json("access-policy.example.json")

        def check(node: dict[str, Any]) -> None:
            for key, value in node.items():
                if key in {"allow", "deny"}:
                    self.assertLessEqual(set(value), {"users", "departments", "workgroups"})
                elif key == "actions":
                    for rule in value.values():
                        check(rule)
                elif key not in {"version"}:
                    check(value)

        check(policy["bots"])

    def test_template_rules_values(self) -> None:
        """Правила шапки шаблона: строка шапки 11 и два заголовка."""
        rules = load_json("template-rules.json.example")
        self.assertEqual(11, rules["header_row"])
        self.assertIn("название", json.dumps(rules, ensure_ascii=False))
        self.assertIn("артикул", json.dumps(rules, ensure_ascii=False))

    def test_currencies_shape(self) -> None:
        """Каждая валюта имеет код, символы и псевдонимы."""
        for item in load_json("currencies.json.example")["currencies"]:
            self.assertRegex(item["code"], r"^[A-Z]{3}$")
            self.assertIsInstance(item["symbols"], list)
            self.assertIsInstance(item["aliases"], list)

    def test_documents_flags_boolean(self) -> None:
        """documents.json содержит булевы режимы."""
        for key, value in load_json("documents.json.example").items():
            with self.subTest(key=key):
                self.assertIsInstance(value, bool)

    def test_allowed_words_example_has_no_real_words(self) -> None:
        """Образец слов-исключений содержит только комментарии."""
        text = (CONFIG_DIR / "pii-allowed-words.txt.example").read_text(encoding="utf-8")
        words = [x.strip() for x in text.splitlines() if x.strip() and not x.startswith("#")]
        self.assertEqual([], words)
        for word in words:
            self.assertRegex(word, ALLOWED_WORD_RE)
            self.assertLessEqual(len(word.encode("utf-8")), MAX_WORD_BYTES)

    def test_contacts_example_has_no_real_names(self) -> None:
        """Образец словаря контактов содержит только комментарии."""
        text = (CONFIG_DIR / "contacts.txt.example").read_text(encoding="utf-8")
        data = [x for x in text.splitlines() if x.strip() and not x.lstrip().startswith("#")]
        self.assertEqual([], data)

    def test_readme_lists_every_example(self) -> None:
        """README перечисляет каждый образец."""
        readme = (CONFIG_DIR / "README.md").read_text(encoding="utf-8")
        for path in example_files():
            with self.subTest(file=path.name):
                self.assertIn(path.name, readme)


if __name__ == "__main__":
    unittest.main()
