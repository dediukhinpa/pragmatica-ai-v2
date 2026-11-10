-- R3-ALG-26: numeric(18, 4) молча округлял цены до 4 знаков: 0.00001234 становилась 0.0000,
-- а 0.00005 - 0.0001 (цена за штуку мелкого крепежа, пересчёт из цены за 1000 шт.).
-- Колонки цены переводятся в numeric без точности и масштаба: значение хранится ровно
-- так, как пришло (адаптер передаёт число JS, а читает numeric строкой и приводит к
-- Number - круг без потерь). CHECK (price > 0) остаётся.
-- Совместимость: все существующие значения сохраняются как есть; запросы и индексы по
-- price не меняются; старый код читает новый тип так же (строка -> Number).
-- Операция ALTER TYPE numeric(18,4) -> numeric не перезаписывает таблицу (расширение
-- ограничения), блокировка короткая. Идемпотентна (повтор ничего не меняет).
-- Откат (после него мелкие цены снова округлятся; значения длиннее 4 знаков потеряют точность):
--   ALTER TABLE price_items ALTER COLUMN price TYPE numeric(18, 4);
--   ALTER TABLE import_staging_items ALTER COLUMN price TYPE numeric(18, 4);

ALTER TABLE price_items ALTER COLUMN price TYPE numeric;
ALTER TABLE import_staging_items ALTER COLUMN price TYPE numeric;
