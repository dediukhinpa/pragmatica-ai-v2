-- Основные таблицы закупа. Миграция идемпотентна (IF NOT EXISTS), можно гонять повторно.
-- Намеренно нет таблицы замен псевдонимизатора: у сервиса псевдонимизации своё хранилище.

CREATE TABLE IF NOT EXISTS suppliers (
  id           text PRIMARY KEY,
  name         text NOT NULL CHECK (name <> ''),
  email        text,
  contact_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Предметная часть прежней миграции 001_core. Платформенная часть (idempotency_keys,
-- audit_log, jobs) живёт в потоке platform: platform/001_core.
-- Операторы перенесены без изменений, порядок сохранён.

-- Строки прайсов. Без внешнего ключа на suppliers: прайс может прийти раньше карточки
-- поставщика (так же ведёт себя заглушка в памяти).
CREATE TABLE IF NOT EXISTS price_items (
  id           bigserial PRIMARY KEY,
  supplier_id  text NOT NULL,
  product_name text NOT NULL CHECK (product_name <> ''),
  sku          text,
  price        numeric(18, 4) NOT NULL CHECK (price > 0),
  currency     char(3) NOT NULL,
  price_date   timestamptz NOT NULL,
  source_file  text,             -- исходный файл прайса (если известен)
  import_key   text NOT NULL,    -- ключ идемпотентности импорта
  import_hash  text NOT NULL,    -- sha256 содержимого импорта (для сверки повторов)
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_items_supplier_idx ON price_items (supplier_id);
CREATE INDEX IF NOT EXISTS price_items_sku_idx ON price_items (lower(sku));

CREATE TABLE IF NOT EXISTS purchase_requests (
  id           text PRIMARY KEY,
  deal_ref     text NOT NULL,
  items        jsonb NOT NULL,
  created_at   timestamptz NOT NULL,
  sla_deadline timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS purchase_requests_deal_idx ON purchase_requests (deal_ref);
CREATE INDEX IF NOT EXISTS purchase_requests_sla_idx ON purchase_requests (sla_deadline);
