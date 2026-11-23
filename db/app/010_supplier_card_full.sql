-- Миграция 024: полная структура карточки поставщика (разд. 10.1-10.9 ТЗ заказчика).
--
-- Добавляет недостающие поля к `suppliers` и две таблицы: «все юридические лица» (название и
-- ИНН) и «материалы» (презентации и портфолио - ссылки на файлы в базе знаний, сами файлы в
-- карточке не хранятся; логотип - столбец logo_ref). Все столбцы необязательные (NULL = не
-- указано): старые карточки читаются без изменений. Перечисления - text + CHECK по допустимым
-- значениям, списки строк - text[] (как categories в 018). Пределы длины совпадают с
-- константами core/src/domain/supplier-card-full.ts.
--
-- Что уже было и здесь не дублируется: название, сайт, реквизиты, статус (тип поставщика:
-- active / new = потенциальный / inactive = не действующий), контакты, категории (направления
-- товарных групп), условия оплаты, доставки, минимальный тираж (min_batch), сроки (lead_time),
-- условия дополнительной скидки (discounts), город и адрес (023), сильные и слабые стороны и
-- процент брака (023).
--
-- Идемпотентна: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS. Откат (данные новых
-- столбцов и таблиц теряются):
--   DROP TABLE IF EXISTS supplier_materials, supplier_legal_entities;
--   ALTER TABLE suppliers
--     DROP COLUMN IF EXISTS logo_ref, DROP COLUMN IF EXISTS supplier_kind,
--     DROP COLUMN IF EXISTS founded_year, DROP COLUMN IF EXISTS agency_discount,
--     DROP COLUMN IF EXISTS min_order_amount, DROP COLUMN IF EXISTS samples_available,
--     DROP COLUMN IF EXISTS samples_quantity, DROP COLUMN IF EXISTS samples_terms,
--     DROP COLUMN IF EXISTS payment_notes, DROP COLUMN IF EXISTS vat,
--     DROP COLUMN IF EXISTS free_delivery, DROP COLUMN IF EXISTS document_flow,
--     DROP COLUMN IF EXISTS contract_notes, DROP COLUMN IF EXISTS packaging,
--     DROP COLUMN IF EXISTS packaging_pricing, DROP COLUMN IF EXISTS technologies,
--     DROP COLUMN IF EXISTS personalization_types,
--     DROP COLUMN IF EXISTS technical_requirements,
--     DROP COLUMN IF EXISTS pragmatika_portfolio, DROP COLUMN IF EXISTS transport_info,
--     DROP COLUMN IF EXISTS marketing_support, DROP COLUMN IF EXISTS training_formats,
--     DROP COLUMN IF EXISTS exclusivity, DROP COLUMN IF EXISTS has_own_designers,
--     DROP COLUMN IF EXISTS design_services, DROP COLUMN IF EXISTS has_quality_control,
--     DROP COLUMN IF EXISTS additional_services, DROP COLUMN IF EXISTS claims_handling,
--     DROP COLUMN IF EXISTS competitive_advantages, DROP COLUMN IF EXISTS customers,
--     DROP COLUMN IF EXISTS turnover, DROP COLUMN IF EXISTS okved,
--     DROP COLUMN IF EXISTS employee_count;
--   DELETE FROM schema_migrations WHERE version = '024_supplier_card_full';

ALTER TABLE suppliers
  -- 10.1 О компании
  ADD COLUMN IF NOT EXISTS logo_ref text
    CHECK (logo_ref <> '' AND char_length(logo_ref) <= 500),
  ADD COLUMN IF NOT EXISTS supplier_kind text
    CHECK (supplier_kind IN ('production_only', 'production_and_branding', 'branding_only')),
  ADD COLUMN IF NOT EXISTS founded_year integer
    CHECK (founded_year BETWEEN 1700 AND 2100),
  -- 10.3 Условия работы
  ADD COLUMN IF NOT EXISTS agency_discount text
    CHECK (agency_discount <> '' AND char_length(agency_discount) <= 300),
  ADD COLUMN IF NOT EXISTS min_order_amount text
    CHECK (min_order_amount <> '' AND char_length(min_order_amount) <= 300),
  ADD COLUMN IF NOT EXISTS samples_available boolean,
  ADD COLUMN IF NOT EXISTS samples_quantity integer
    CHECK (samples_quantity BETWEEN 0 AND 1000000),
  ADD COLUMN IF NOT EXISTS samples_terms text
    CHECK (samples_terms <> '' AND char_length(samples_terms) <= 300),
  ADD COLUMN IF NOT EXISTS payment_notes text
    CHECK (payment_notes <> '' AND char_length(payment_notes) <= 1000),
  ADD COLUMN IF NOT EXISTS vat text
    CHECK (vat <> '' AND char_length(vat) <= 300),
  -- 10.4 Доставка (условия и сроки - прежний столбец delivery_terms)
  ADD COLUMN IF NOT EXISTS free_delivery text
    CHECK (free_delivery <> '' AND char_length(free_delivery) <= 300),
  -- 10.5 Документы и договор
  ADD COLUMN IF NOT EXISTS document_flow text
    CHECK (document_flow IN ('edo', 'none')),
  ADD COLUMN IF NOT EXISTS contract_notes text
    CHECK (contract_notes <> '' AND char_length(contract_notes) <= 1000),
  -- 10.6 О продукции
  ADD COLUMN IF NOT EXISTS packaging text
    CHECK (packaging IN ('none', 'transport', 'gift')),
  ADD COLUMN IF NOT EXISTS packaging_pricing text
    CHECK (packaging_pricing IN ('included', 'separate_price')),
  ADD COLUMN IF NOT EXISTS technologies text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(technologies) <= 50),
  ADD COLUMN IF NOT EXISTS personalization_types text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(personalization_types) <= 50),
  ADD COLUMN IF NOT EXISTS technical_requirements text
    CHECK (technical_requirements <> '' AND char_length(technical_requirements) <= 2000),
  ADD COLUMN IF NOT EXISTS pragmatika_portfolio text
    CHECK (pragmatika_portfolio <> '' AND char_length(pragmatika_portfolio) <= 2000),
  -- 10.7 Расположение (город и адрес - миграция 023)
  ADD COLUMN IF NOT EXISTS transport_info text
    CHECK (transport_info <> '' AND char_length(transport_info) <= 1000),
  -- 10.8 Сервис
  ADD COLUMN IF NOT EXISTS marketing_support text
    CHECK (marketing_support <> '' AND char_length(marketing_support) <= 1000),
  ADD COLUMN IF NOT EXISTS training_formats text[] NOT NULL DEFAULT '{}'
    CHECK (training_formats <@ ARRAY['online', 'offline']::text[]),
  ADD COLUMN IF NOT EXISTS exclusivity text
    CHECK (exclusivity <> '' AND char_length(exclusivity) <= 1000),
  ADD COLUMN IF NOT EXISTS has_own_designers boolean,
  ADD COLUMN IF NOT EXISTS design_services text
    CHECK (design_services <> '' AND char_length(design_services) <= 1000),
  ADD COLUMN IF NOT EXISTS has_quality_control boolean,
  ADD COLUMN IF NOT EXISTS additional_services text
    CHECK (additional_services <> '' AND char_length(additional_services) <= 1000),
  -- 10.9 Оценка поставщика (сильные и слабые стороны, брак - миграция 023)
  ADD COLUMN IF NOT EXISTS claims_handling text
    CHECK (claims_handling <> '' AND char_length(claims_handling) <= 1000),
  ADD COLUMN IF NOT EXISTS competitive_advantages text
    CHECK (competitive_advantages <> '' AND char_length(competitive_advantages) <= 1000),
  ADD COLUMN IF NOT EXISTS customers text
    CHECK (customers <> '' AND char_length(customers) <= 1000),
  ADD COLUMN IF NOT EXISTS turnover text
    CHECK (turnover <> '' AND char_length(turnover) <= 300),
  ADD COLUMN IF NOT EXISTS okved text
    CHECK (okved ~ '^\d{2}(\.\d{1,2}){0,2}$'),
  ADD COLUMN IF NOT EXISTS employee_count integer
    CHECK (employee_count BETWEEN 0 AND 1000000);

-- 10.5 Все юридические лица поставщика: название и ИНН (порядок - sort_order).
CREATE TABLE IF NOT EXISTS supplier_legal_entities (
  id          bigserial PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES suppliers (id) ON DELETE CASCADE,
  sort_order  integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  name        text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 300),
  inn         text CHECK (inn ~ '^\d{10}(\d{2})?$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_legal_entities_supplier_idx
  ON supplier_legal_entities (supplier_id, sort_order, id);
CREATE INDEX IF NOT EXISTS supplier_legal_entities_inn_idx ON supplier_legal_entities (inn);

-- 10.6 Презентации компании и продукции, портфолио: ссылки на файлы в базе знаний.
CREATE TABLE IF NOT EXISTS supplier_materials (
  id          bigserial PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES suppliers (id) ON DELETE CASCADE,
  sort_order  integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  kind        text NOT NULL CHECK (kind IN ('presentation', 'portfolio')),
  ref         text NOT NULL CHECK (btrim(ref) <> '' AND char_length(ref) <= 500),
  title       text CHECK (title <> '' AND char_length(title) <= 200),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_materials_supplier_idx
  ON supplier_materials (supplier_id, sort_order, id);
