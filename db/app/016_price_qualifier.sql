-- Миграция 033: цена словами в позиции прайса («от 500», «500-700») и тираж из одной ячейки.
--
-- `price_qualifier` - 'from' («от 500») или 'range' («500-700»); NULL - точная цена (все прежние
-- строки). `price_max` - верхняя граница диапазона: NULL или (qualifier = 'range' и
-- price_max > price). Основная цена `price` при признаке - НИЖНЯЯ граница.
-- Столбцы есть и в staging импорта: куски прайса хранятся там до фиксации.
--
-- Кроме того, ограничение на `price_tiers` ослабляется с 2..8 до 1..8 элементов: ячейка
-- «от 100 шт 45 руб» даёт один тираж, и минимальный тираж терять нельзя. Имена ограничений -
-- автоматические имена Postgres для столбцового CHECK из миграции 032.
--
-- Идемпотентна: ADD COLUMN IF NOT EXISTS (без значения по умолчанию - перезаписи таблиц
-- нет), DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT в одной транзакции миграции. Существующие
-- данные не меняются (ослабленное ограничение прежние строки не нарушают). Откат (признаки
-- теряются, основные цены остаются; перед возвратом CHECK 2..8 нужно убрать тиражи из одного
-- элемента: UPDATE ... SET price_tiers = NULL WHERE jsonb_array_length(price_tiers) = 1):
--   ALTER TABLE price_items DROP COLUMN IF EXISTS price_qualifier, DROP COLUMN IF EXISTS price_max;
--   ALTER TABLE import_staging_items
--     DROP COLUMN IF EXISTS price_qualifier, DROP COLUMN IF EXISTS price_max;
--   DELETE FROM schema_migrations WHERE version = '033_price_qualifier';

ALTER TABLE price_items
  ADD COLUMN IF NOT EXISTS price_qualifier text
    CHECK (price_qualifier IS NULL OR price_qualifier IN ('from', 'range'));
-- Отдельной командой: CHECK ссылается на столбец, добавленный выше.
ALTER TABLE price_items
  ADD COLUMN IF NOT EXISTS price_max numeric
    CHECK (price_max IS NULL OR (price_qualifier = 'range' AND price_max > price));

ALTER TABLE import_staging_items
  ADD COLUMN IF NOT EXISTS price_qualifier text
    CHECK (price_qualifier IS NULL OR price_qualifier IN ('from', 'range'));
-- Отдельной командой: CHECK ссылается на столбец, добавленный выше.
ALTER TABLE import_staging_items
  ADD COLUMN IF NOT EXISTS price_max numeric
    CHECK (price_max IS NULL OR (price_qualifier = 'range' AND price_max > price));

ALTER TABLE price_items DROP CONSTRAINT IF EXISTS price_items_price_tiers_check;
ALTER TABLE price_items
  ADD CONSTRAINT price_items_price_tiers_check CHECK (price_tiers IS NULL OR (
    jsonb_typeof(price_tiers) = 'array' AND jsonb_array_length(price_tiers) BETWEEN 1 AND 8));

ALTER TABLE import_staging_items DROP CONSTRAINT IF EXISTS import_staging_items_price_tiers_check;
ALTER TABLE import_staging_items
  ADD CONSTRAINT import_staging_items_price_tiers_check CHECK (price_tiers IS NULL OR (
    jsonb_typeof(price_tiers) = 'array' AND jsonb_array_length(price_tiers) BETWEEN 1 AND 8));
