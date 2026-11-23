-- Миграция 023: расположение и оценка поставщика в карточке (разд. 10.7 и 10.9 ТЗ).
--
-- Нужны шорт-листу: город производства, адрес склада и производства, сильные и слабые
-- стороны, процент брака. По ним код считает рейтинг (docs/ARCHITECTURE.md, «Шорт-лист»).
-- Все столбцы необязательные (NULL = не указано): старые карточки читаются без изменений,
-- а «нет оценки» отличается от нуля - процент брака 0 допустим и означает «брака нет».
-- Пределы длины совпадают с константами core/src/domain/supplier-card.ts.
--
-- Идемпотентна: ADD COLUMN IF NOT EXISTS. Откат (данные этих столбцов теряются):
--   ALTER TABLE suppliers DROP COLUMN IF EXISTS production_city, DROP COLUMN IF EXISTS address,
--     DROP COLUMN IF EXISTS strengths, DROP COLUMN IF EXISTS weaknesses,
--     DROP COLUMN IF EXISTS defect_rate_percent;
--   DELETE FROM schema_migrations WHERE version = '023_supplier_location_assessment';

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS production_city text
    CHECK (production_city <> '' AND char_length(production_city) <= 100),
  ADD COLUMN IF NOT EXISTS address text
    CHECK (address <> '' AND char_length(address) <= 300),
  ADD COLUMN IF NOT EXISTS strengths text
    CHECK (strengths <> '' AND char_length(strengths) <= 1000),
  ADD COLUMN IF NOT EXISTS weaknesses text
    CHECK (weaknesses <> '' AND char_length(weaknesses) <= 1000),
  ADD COLUMN IF NOT EXISTS defect_rate_percent numeric(5, 2)
    CHECK (defect_rate_percent >= 0 AND defect_rate_percent <= 100);
