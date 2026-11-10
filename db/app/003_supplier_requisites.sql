-- Реквизиты поставщика для документов (договор, спецификация). Миграция идемпотентна:
-- проверки заданы прямо в ADD COLUMN IF NOT EXISTS, повторный запуск их не дублирует.
-- Все столбцы необязательны: карточка поставщика появляется раньше, чем его реквизиты.
-- Здесь только формат (длина, цифры); контрольные суммы ИНН/ОГРН/счетов проверяет код
-- (core/src/domain/requisites.ts) до записи: в SQL их дублировать незачем.
-- У ИП ИНН/ОГРН/адрес/счёт — персональные данные. Это обычные данные организации в РФ-базе,
-- таблицу замен псевдонимизатора они не затрагивают (в модель уходят только токены).

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS inn text
    CHECK (inn ~ '^([0-9]{10}|[0-9]{12})$'),
  ADD COLUMN IF NOT EXISTS kpp text
    CHECK (kpp ~ '^[0-9]{4}[0-9A-Z]{2}[0-9]{3}$'),
  ADD COLUMN IF NOT EXISTS ogrn text
    CHECK (ogrn ~ '^([0-9]{13}|[0-9]{15})$'),
  ADD COLUMN IF NOT EXISTS legal_address text
    CHECK (legal_address <> '' AND char_length(legal_address) <= 500),
  ADD COLUMN IF NOT EXISTS bank_name text
    CHECK (bank_name <> '' AND char_length(bank_name) <= 500),
  ADD COLUMN IF NOT EXISTS bik text
    CHECK (bik ~ '^[0-9]{9}$'),
  ADD COLUMN IF NOT EXISTS settlement_account text
    CHECK (settlement_account ~ '^[0-9]{20}$'),
  ADD COLUMN IF NOT EXISTS correspondent_account text
    CHECK (correspondent_account ~ '^[0-9]{20}$'),
  ADD COLUMN IF NOT EXISTS director_name text
    CHECK (director_name <> '' AND char_length(director_name) <= 500);
