-- Миграция 041: реквизиты наших юрлиц как данные (этап 230).
-- До неё реквизиты «Прагматики» и «Мастер Гифтс» были напечатаны только в шаблонах договоров
-- и частично лежали в переменной окружения; теперь по одной записи на юрлицо, ключ - стабильный
-- код (pragmatika, master_gifts). Агент договоров берёт наши реквизиты отсюда, а фильтр «наших
-- реквизитов» при обогащении карточек поставщиков объединяет эти записи с OWN_COMPANY_REQUISITES.
-- CHECK проверяют только формат (как для suppliers, миграция 008): контрольные суммы ИНН, ОГРН,
-- БИК и счетов проверяет код до записи (core/src/domain/own-legal-entity.ts).
-- Идемпотентна: IF NOT EXISTS; данных не вставляет (заполняет скрипт own-requisites-load.sh).
-- Накатывает владелец на бою (красная зона). Порядок выкладки: бэкап БД -> миграция -> код.
-- Откат (после отката кода):
--   DROP TABLE IF EXISTS own_legal_entities;
--   DELETE FROM schema_migrations WHERE version = '041_own_legal_entities';

CREATE TABLE IF NOT EXISTS own_legal_entities (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,31}$'),
  full_name text NOT NULL CHECK (btrim(full_name) <> '' AND length(full_name) <= 500),
  short_name text NOT NULL CHECK (btrim(short_name) <> '' AND length(short_name) <= 500),
  inn text NOT NULL CHECK (inn ~ '^[0-9]{10}$|^[0-9]{12}$'),
  kpp text NOT NULL CHECK (kpp ~ '^[0-9]{4}[0-9A-Z]{2}[0-9]{3}$'),
  ogrn text CHECK (ogrn IS NULL OR ogrn ~ '^[0-9]{13}$|^[0-9]{15}$'),
  legal_address text NOT NULL CHECK (btrim(legal_address) <> '' AND length(legal_address) <= 500),
  postal_address text CHECK (postal_address IS NULL OR length(postal_address) <= 500),
  actual_address text CHECK (actual_address IS NULL OR length(actual_address) <= 500),
  bank_name text NOT NULL CHECK (btrim(bank_name) <> '' AND length(bank_name) <= 500),
  bik text NOT NULL CHECK (bik ~ '^[0-9]{9}$'),
  settlement_account text NOT NULL CHECK (settlement_account ~ '^[0-9]{20}$'),
  correspondent_account text NOT NULL CHECK (correspondent_account ~ '^[0-9]{20}$'),
  signatory_position text NOT NULL
    CHECK (btrim(signatory_position) <> '' AND length(signatory_position) <= 500),
  signatory_name text NOT NULL
    CHECK (btrim(signatory_name) <> '' AND length(signatory_name) <= 500),
  signatory_basis text NOT NULL
    CHECK (btrim(signatory_basis) <> '' AND length(signatory_basis) <= 500),
  phone text CHECK (phone IS NULL OR length(phone) <= 500),
  email text CHECK (email IS NULL OR length(email) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Кто записал: id сотрудника или метка скрипта заполнения. Значения реквизитов в журналы не пишутся.
  updated_by text NOT NULL CHECK (btrim(updated_by) <> '')
);

COMMENT ON TABLE own_legal_entities IS
  'Реквизиты наших юрлиц (этап 230): источник для договоров и фильтра своих реквизитов';
