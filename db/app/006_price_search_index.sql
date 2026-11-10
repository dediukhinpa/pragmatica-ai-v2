-- Миграция 016: поиск по прайсу через индексы (R5-DB-1, R5-ADP-5, R5-DB-2).
--
-- Раньше поиск по названию нормализовал (NFKC, тире, регистр, «ё») каждую строку
-- price_items на каждый запрос: полный скан, 500 тыс. строк - 33-37 с при
-- statement_timeout 30 с. Теперь нормализованный текст хранится в сгенерированных столбцах,
-- а подстрока и «слово - начало токена» ищутся по GIN-индексам.
--
-- ВНИМАНИЕ: ADD COLUMN со STORED-выражением переписывает таблицу price_items под блокировкой
-- ACCESS EXCLUSIVE (500 тыс. строк: около 80 с, ещё ~40 с на индексы). Выполнять в окне
-- обслуживания, см. docs/RUNBOOK.md, «Миграция 016». Миграция идемпотентна.
--
-- Выражение hay совпадает со старым MATCHED_CTE (price-repository.ts) и с normalizeProductName
-- (core/src/domain/price-diff.ts): шаблон тире и разделители слов - литералы, потому что
-- выражение генерируемого столбца и функционального индекса не может зависеть от параметра.
-- Менять его нужно только вместе с DASH_PATTERN / PRODUCT_WORD_SEPARATORS в коде.

-- Расширение уже входит в образ pgvector/pgvector:pg16 (contrib postgres:16).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Нормализованное «название + артикул».
ALTER TABLE price_items ADD COLUMN IF NOT EXISTS hay text GENERATED ALWAYS AS (
  replace(
    regexp_replace(
      regexp_replace(lower(normalize(product_name || ' ' || coalesce(sku, ''), NFKC)),
                     '[‐-―−﹘﹣－]', '-', 'g'),
      '\s*-\s*', '-', 'g'),
    'ё', 'е')
) STORED;

-- Слова нормализованного текста (разделители те же, что PRODUCT_WORD_SEPARATORS в домене).
ALTER TABLE price_items ADD COLUMN IF NOT EXISTS words text[] GENERATED ALWAYS AS (
  regexp_split_to_array(
    replace(
      regexp_replace(
        regexp_replace(lower(normalize(product_name || ' ' || coalesce(sku, ''), NFKC)),
                       '[‐-―−﹘﹣－]', '-', 'g'),
        '\s*-\s*', '-', 'g'),
      'ё', 'е'),
    '[\s.,;:()/"«»]+')
) STORED;

-- Подстрока токена в тексте (LIKE '%токен%') -> триграммы.
CREATE INDEX IF NOT EXISTS price_items_hay_trgm_idx ON price_items USING gin (hay gin_trgm_ops);
-- Слово названия - начало токена (words && ARRAY[префиксы токена]).
CREATE INDEX IF NOT EXISTS price_items_words_idx ON price_items USING gin (words);

-- Артикул: ровно выражение listBySku/listBySkus (без него индекс по выражению не берётся).
CREATE INDEX IF NOT EXISTS price_items_sku_norm_idx ON price_items (
  (regexp_replace(
     regexp_replace(lower(normalize(sku, NFKC)), '[‐-―−﹘﹣－]', '-', 'g'),
     '\s*-\s*', '-', 'g'))
);

-- Без статистики по новым столбцам и выражению планировщик индексы не выберет.
ANALYZE price_items;

-- Прежний price_items_sku_idx (lower(sku)) не используется ни одним запросом (grep по ядру,
-- e2e и скриптам: выражение запросов другое), поэтому заменён price_items_sku_norm_idx.
DROP INDEX IF EXISTS price_items_sku_idx;
