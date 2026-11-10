-- Миграция 034: основание тиража в позиции прайса.
--
-- `price_tier_basis` - от чего считается порог в `price_tiers[].minQuantity`: 'quantity' - от
-- количества штук (все прежние строки), 'order_sum' - от суммы заказа в рублях («цена от
-- 62 000 / 102 000»: одеяла и подобные прайсы). Основание одно на всю позицию. Для 'order_sum'
-- тиражи обязательны: основание без массива тиражей ничего не значит.
-- Столбец есть и в staging импорта: куски прайса хранятся там до фиксации.
--
-- Идемпотентна: ADD COLUMN IF NOT EXISTS; NOT NULL DEFAULT с константой не перезаписывает
-- таблицу (PostgreSQL 11+). Существующие данные не меняются. Откат (основание теряется,
-- пороги сумм остаются как числа - перед откатом их нужно убрать вручную):
--   ALTER TABLE price_items DROP COLUMN IF EXISTS price_tier_basis;
--   ALTER TABLE import_staging_items DROP COLUMN IF EXISTS price_tier_basis;
--   DELETE FROM schema_migrations WHERE version = '034_price_tier_basis';

ALTER TABLE price_items
  ADD COLUMN IF NOT EXISTS price_tier_basis text NOT NULL DEFAULT 'quantity'
    CHECK (price_tier_basis IN ('quantity', 'order_sum')
           AND (price_tier_basis = 'quantity' OR price_tiers IS NOT NULL));

ALTER TABLE import_staging_items
  ADD COLUMN IF NOT EXISTS price_tier_basis text NOT NULL DEFAULT 'quantity'
    CHECK (price_tier_basis IN ('quantity', 'order_sum')
           AND (price_tier_basis = 'quantity' OR price_tiers IS NOT NULL));
