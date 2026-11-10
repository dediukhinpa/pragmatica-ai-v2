"""Простая проверка в духе gitleaks: в deploy/ и config/ нет секретов и данных заказчика."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

import compose_loader as loader

CONFIG_DIR = loader.REPO_DIR / "config"
PLATFORM_DIR = loader.DEPLOY_DIR / "platform"
SCANNED_DIRS = (loader.DEPLOY_DIR, CONFIG_DIR)
# Расширения двоичных файлов, которые не сканируются.
BINARY_SUFFIXES = frozenset({".png", ".jpg", ".gz", ".zip", ".xlsx", ".docx"})

# Шаблоны секретов: имя правила -> регулярное выражение.
SECRET_PATTERNS: dict[str, re.Pattern[str]] = {
    "приватный ключ": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "токен Telegram": re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b"),
    "ключ sk-": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    "токен GitHub": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),
    "ключ AWS": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "Bearer-токен": re.compile(r"Bearer\s+[A-Za-z0-9._-]{30,}"),
    "пароль в URL": re.compile(r"://[^/\s:@$]+:[^/\s@$]{4,}@(?!\$)"),
}
# Адреса и IP не из документации: реальные данные заказчика в репозиторий не попадают.
EMAIL_RE = re.compile(r"\b[\w.+-]+@([\w-]+\.)+[a-z]{2,}\b", re.IGNORECASE)
IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
# Допустимые почтовые домены (документация и заглушки).
ALLOWED_EMAIL_DOMAINS = frozenset({"example.com", "example.org", "example.net", "example.ru"})
# Допустимые IP: служебные и документационные диапазоны.
ALLOWED_IP_PREFIXES = ("127.", "0.0.0.0", "10.", "172.16.", "172.17.", "172.18.", "192.0.2.",
                       "198.51.100.", "203.0.113.", "255.")
# Слова заказчика, которых в образцах быть не должно.
CUSTOMER_WORDS = ("Мастер Гифтс", "Екатеринбург", "ИИ агент")


def scanned_files() -> list[Path]:
    """Текстовые файлы deploy/ и config/ (без кэша Python)."""
    files: list[Path] = []
    for root in SCANNED_DIRS:
        for path in sorted(root.rglob("*")):
            if path.is_file() and path.suffix not in BINARY_SUFFIXES:
                if "__pycache__" not in path.parts:
                    files.append(path)
    return files


def lines_of(path: Path) -> list[tuple[int, str]]:
    """Нумерованные строки файла; нечитаемый как UTF-8 файл пропускается."""
    try:
        return list(enumerate(path.read_text(encoding="utf-8").splitlines(), start=1))
    except UnicodeDecodeError:
        return []


class NoSecretsTest(unittest.TestCase):
    """Поиск секретов и данных заказчика."""

    def test_secret_patterns(self) -> None:
        """Нет приватных ключей, токенов и паролей в URL."""
        found: list[str] = []
        for path in scanned_files():
            for number, line in lines_of(path):
                for rule, pattern in SECRET_PATTERNS.items():
                    if pattern.search(line):
                        found.append(f"{path.relative_to(loader.REPO_DIR)}:{number}: {rule}")
        self.assertEqual([], found)

    def test_emails_are_placeholders(self) -> None:
        """Почтовые адреса только из документационных доменов."""
        found: list[str] = []
        for path in scanned_files():
            if PLATFORM_DIR in path.parents:
                continue
            for number, line in lines_of(path):
                for match in EMAIL_RE.finditer(line):
                    domain = match.group(0).split("@", 1)[1].lower()
                    if domain not in ALLOWED_EMAIL_DOMAINS:
                        found.append(f"{path.relative_to(loader.REPO_DIR)}:{number}")
        self.assertEqual([], found)

    def test_ips_are_reserved(self) -> None:
        """IP-адреса только служебные или из документационных диапазонов."""
        found: list[str] = []
        for path in scanned_files():
            if PLATFORM_DIR in path.parents:
                continue
            for number, line in lines_of(path):
                for match in IPV4_RE.finditer(line):
                    if not match.group(0).startswith(ALLOWED_IP_PREFIXES):
                        found.append(f"{path.relative_to(loader.REPO_DIR)}:{number}")
        self.assertEqual([], found)

    def test_no_customer_words(self) -> None:
        """В образцах нет названий и слов заказчика."""
        found: list[str] = []
        for path in scanned_files():
            if PLATFORM_DIR in path.parents:
                continue
            for number, line in lines_of(path):
                if any(word in line for word in CUSTOMER_WORDS):
                    found.append(f"{path.relative_to(loader.REPO_DIR)}:{number}")
        self.assertEqual([], found)

    def test_no_real_env_or_secret_files(self) -> None:
        """В deploy/ и config/ нет боевых .env, ключей и сертификатов."""
        bad = [
            str(p.relative_to(loader.REPO_DIR))
            for p in scanned_files()
            if p.name in {".env", "channel.env"} or p.suffix in {".pem", ".key", ".p12"}
        ]
        self.assertEqual([], bad)


if __name__ == "__main__":
    unittest.main()
