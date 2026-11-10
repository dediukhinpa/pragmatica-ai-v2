-- Миграция 038: гибридный поиск по строкам прайсов (этап 121, тема 1).
--
-- Раньше строки прайса искались подстрокой по `hay` («мед» находил «медальон»), смысла слов
-- поиск не знал. Теперь у `price_items` есть полнотекстовый столбец по названию товара и
-- эмбеддинг названия; поиск сливает ветки FTS, вектора и «начала слова» по RRF в коде ядра
-- (`PostgresPriceRepository.searchRankedProducts`), как поиск по базе знаний.
--
-- FTS считает сама БД: «ё» заменена на «е», как в `hay`, поэтому «мёд» и «мед» дают одну
-- лексему. Название режется до 100000 символов: tsvector ограничен ~1 МБ, сверхдлинная ячейка
-- не должна ронять импорт (как в 030). Эмбеддинг (768, как у knowledge_chunks) пишет ядро
-- после коммита импорта; NULL - ещё не посчитан (дозагрузка: core/src/backfill-price-embeddings.ts).
-- Пока вектора нет, строка находится по FTS и началу слова.
--
-- ВНИМАНИЕ: ADD COLUMN ... GENERATED STORED переписывает price_items под ACCESS EXCLUSIVE
-- (8 тыс. строк - секунды; на сотнях тысяч - минуты, см. миграцию 016): выполнять в окне
-- обслуживания. HNSW строится по пустому столбцу и заполняется по мере дозагрузки.
-- Идемпотентна. Откат:
--   DROP INDEX IF EXISTS price_items_fts_idx; DROP INDEX IF EXISTS price_items_embedding_idx;
--   ALTER TABLE price_items DROP COLUMN IF EXISTS fts, DROP COLUMN IF EXISTS embedding;
--   DELETE FROM schema_migrations WHERE version = '038_price_items_hybrid_search';

ALTER TABLE price_items
  ADD COLUMN IF NOT EXISTS fts tsvector GENERATED ALWAYS AS (
    to_tsvector('russian', replace(lower(left(product_name, 100000)), 'ё', 'е'))
  ) STORED;

ALTER TABLE price_items ADD COLUMN IF NOT EXISTS embedding vector(768);

CREATE INDEX IF NOT EXISTS price_items_fts_idx ON price_items USING gin (fts);
-- Параметры HNSW те же, что у knowledge_chunks (003) и messages (030).
CREATE INDEX IF NOT EXISTS price_items_embedding_idx
  ON price_items USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- Выборка строк без вектора для дозагрузки (`WHERE embedding IS NULL ORDER BY id`).
CREATE INDEX IF NOT EXISTS price_items_no_embedding_idx ON price_items (id) WHERE embedding IS NULL;

ANALYZE price_items;
