-- Миграция 039: признак НДС у строки прайса.
--
-- Цены в прайсах бывают с НДС и без: поиск берёт минимальную цену поставщика, и «без НДС» системно
-- выигрывает у такой же цены «с НДС». Столбец `price_vat` хранит, как указана цена в файле:
-- 'included' - цена с НДС, 'excluded' - без НДС, 'none' - поставщик без НДС (УСН),
-- 'unknown' - из файла не видно. NULL - строка загружена до миграции, признак не размечен.
-- Миграция данные НЕ меняет: разметка уже загруженных почтовых строк делается отдельным
-- скриптом по картам прайсов (по import_key), новые импорты заполняют столбец сами.
--
-- Идемпотентна: ADD COLUMN IF NOT EXISTS без значения по умолчанию (перезаписи таблицы нет).
-- Откат (признак теряется, цены остаются):
--   ALTER TABLE price_items DROP COLUMN IF EXISTS price_vat;
--   ALTER TABLE import_staging_items DROP COLUMN IF EXISTS price_vat;
--   DELETE FROM schema_migrations WHERE version = '039_price_items_vat';

ALTER TABLE price_items
  ADD COLUMN IF NOT EXISTS price_vat text
    CHECK (price_vat IS NULL OR price_vat IN ('included', 'excluded', 'none', 'unknown'));

ALTER TABLE import_staging_items
  ADD COLUMN IF NOT EXISTS price_vat text
    CHECK (price_vat IS NULL OR price_vat IN ('included', 'excluded', 'none', 'unknown'));
