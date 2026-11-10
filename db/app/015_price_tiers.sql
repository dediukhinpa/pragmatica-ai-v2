-- Миграция 032: цены по тиражам в позиции прайса.
--
-- `price_tiers` - JSON-массив [{"minQuantity": 50, "price": 120}, {"minQuantity": 100,
-- "price": 100}, ...] по возрастанию тиража, от 2 до 8 элементов. NULL - у позиции одна цена
-- (все прежние строки). Основная цена `price` у позиции с тиражами - цена МИНИМАЛЬНОГО тиража
-- (первого элемента массива): по ней идут сортировка, сравнение и средняя цена по базе, а
-- массив нужен для показа «от 50 шт - X, от 100 - Y» и для сравнения тиража с тиражом.
-- Столбец есть и в staging импорта: куски прайса хранятся там до фиксации.
--
-- Идемпотентна: ADD COLUMN IF NOT EXISTS (без значения по умолчанию - перезаписи таблиц
-- нет). Существующие данные не меняются. Откат (тиражи теряются, основные цены остаются):
--   ALTER TABLE price_items DROP COLUMN IF EXISTS price_tiers;
--   ALTER TABLE import_staging_items DROP COLUMN IF EXISTS price_tiers;
--   DELETE FROM schema_migrations WHERE version = '032_price_tiers';

ALTER TABLE price_items
  ADD COLUMN IF NOT EXISTS price_tiers jsonb
    CHECK (price_tiers IS NULL OR (
      jsonb_typeof(price_tiers) = 'array' AND jsonb_array_length(price_tiers) BETWEEN 2 AND 8));

ALTER TABLE import_staging_items
  ADD COLUMN IF NOT EXISTS price_tiers jsonb
    CHECK (price_tiers IS NULL OR (
      jsonb_typeof(price_tiers) = 'array' AND jsonb_array_length(price_tiers) BETWEEN 2 AND 8));
