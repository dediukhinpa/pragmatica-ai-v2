-- Миграция 018: карточки поставщиков (этап 51).
--
-- Карточка общая на компанию, у каждой записи есть автор. Таблица `suppliers` расширяется
-- (сайт, статус, что поставляет, условия, служебные поля), контакты и заметки выносятся в
-- отдельные таблицы, личные предпочтения сотрудника - в `agent_pair_notes`.
-- Старые столбцы (`email`, `contact_name`, реквизиты) НЕ удаляются и не меняются: код,
-- читающий `suppliers.email`, работает как раньше; при записи карточки эти столбцы
-- заполняются из основного контакта. Данные не теряются.
--
-- Выбор типов:
--  * categories/brands/regions - text[], а не jsonb: это плоские списки коротких строк,
--    читаются и пишутся целиком, ищутся по подстроке элемента (unnest); массив даёт CHECK
--    на число элементов без разбора jsonb. Длину элемента проверяет код (domain).
--  * контакты - отдельная таблица: их несколько, по email ищут (дубли, подтверждение
--    отправителя письма), нужен индекс по lower(email).
--  * индексы по suppliers(inn), lower(email) и названию НЕ уникальны: ИНН и email у разных
--    записей прежних данных уже могут повторяться, дубли ищет код и показывает сотруднику,
--    решение принимает человек.
--  * единственное исключение - частичный уникальный индекс «основной контакт один на
--    поставщика»: это инвариант самой карточки, а не поиск дублей.
--  * в `supplier_contacts` порядок контактов - `sort_order`, должность - `job_title`
--    (слово position в SQL служебное: position(a in b)).
--
-- Перенос данных: прежние `suppliers.email`/`contact_name` копируются в основной контакт
-- ТОЛЬКО у поставщиков, у которых ещё нет контактов, поэтому повторный запуск дублей не
-- создаёт. Слишком длинные значения (больше пределов CHECK) обрезаются или пропускаются в
-- копии; исходные столбцы остаются нетронутыми.
--
-- База знаний: раздел поставщиков = фрагменты с непустым `supplier_id` (столбец и индекс
-- есть с 003). Фильтр «только раздел поставщиков» равенством `filter_supplier` не выразить,
-- а менять сигнатуру `hybrid_search` нельзя (перегрузка сделала бы вызовы неоднозначными,
-- см. 015), поэтому добавлена ОТДЕЛЬНАЯ функция `hybrid_search_suppliers` с тем же телом,
-- что у 017, плюс условие `supplier_id IS NOT NULL`. `hybrid_search` не тронута. При правке
-- ранжирования в `hybrid_search` менять нужно и эту функцию. Векторная ветка здесь без
-- индекса HNSW (выборка за барьером OFFSET 0 сортируется точно): индекс с пост-фильтром
-- отдавал бы не больше ef_search строк, большая часть которых не из раздела поставщиков.
-- Раздел поставщиков мал в сравнении со всей базой знаний, точный перебор дёшев.
--
-- Идемпотентна: IF NOT EXISTS, CREATE OR REPLACE, перенос данных с проверкой NOT EXISTS.
-- Откат (данные старых столбцов остаются):
--   DROP FUNCTION IF EXISTS hybrid_search_suppliers(text, vector, integer, integer, integer,
--     integer, double precision);
--   DROP TABLE IF EXISTS agent_pair_notes, supplier_notes, supplier_contacts;
--   DROP INDEX IF EXISTS suppliers_inn_idx, suppliers_email_idx, suppliers_name_trgm_idx;
--   ALTER TABLE suppliers DROP COLUMN IF EXISTS website, DROP COLUMN IF EXISTS status,
--     DROP COLUMN IF EXISTS categories, DROP COLUMN IF EXISTS brands,
--     DROP COLUMN IF EXISTS regions, DROP COLUMN IF EXISTS payment_terms,
--     DROP COLUMN IF EXISTS delivery_terms, DROP COLUMN IF EXISTS min_batch,
--     DROP COLUMN IF EXISTS lead_time, DROP COLUMN IF EXISTS discounts,
--     DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS updated_by,
--     DROP COLUMN IF EXISTS source;
--   DELETE FROM schema_migrations WHERE version = '018_supplier_cards';

-- Для индекса по названию (уже поставлено 016; повтор безопасен).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Пределы длины и числа записей совпадают с константами core/src/domain/supplier-card.ts.
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS website text
    CHECK (website <> '' AND char_length(website) <= 200),
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('active', 'new', 'inactive')),
  ADD COLUMN IF NOT EXISTS categories text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(categories) <= 50),
  ADD COLUMN IF NOT EXISTS brands text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(brands) <= 50),
  ADD COLUMN IF NOT EXISTS regions text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(regions) <= 50),
  ADD COLUMN IF NOT EXISTS payment_terms text
    CHECK (payment_terms <> '' AND char_length(payment_terms) <= 300),
  ADD COLUMN IF NOT EXISTS delivery_terms text
    CHECK (delivery_terms <> '' AND char_length(delivery_terms) <= 300),
  ADD COLUMN IF NOT EXISTS min_batch text
    CHECK (min_batch <> '' AND char_length(min_batch) <= 300),
  ADD COLUMN IF NOT EXISTS lead_time text
    CHECK (lead_time <> '' AND char_length(lead_time) <= 300),
  ADD COLUMN IF NOT EXISTS discounts text
    CHECK (discounts <> '' AND char_length(discounts) <= 300),
  ADD COLUMN IF NOT EXISTS created_by text
    CHECK (created_by <> '' AND char_length(created_by) <= 200),
  ADD COLUMN IF NOT EXISTS updated_by text
    CHECK (updated_by <> '' AND char_length(updated_by) <= 200),
  ADD COLUMN IF NOT EXISTS source text
    CHECK (source IN ('chat', 'file', 'email'));

-- Поиск и дубли: ИНН, email, название (подстрока и «слово»), без уникальности.
CREATE INDEX IF NOT EXISTS suppliers_inn_idx ON suppliers (inn);
CREATE INDEX IF NOT EXISTS suppliers_email_idx ON suppliers (lower(email));
-- Выражение совпадает с запросами адаптера: без него индекс не берётся.
CREATE INDEX IF NOT EXISTS suppliers_name_trgm_idx
  ON suppliers USING gin (replace(lower(name), 'ё', 'е') gin_trgm_ops);

-- Контакты поставщика (несколько, один основной).
CREATE TABLE IF NOT EXISTS supplier_contacts (
  id          bigserial PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES suppliers (id) ON DELETE CASCADE,
  sort_order  integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  full_name   text CHECK (full_name <> '' AND char_length(full_name) <= 150),
  job_title   text CHECK (job_title <> '' AND char_length(job_title) <= 100),
  email       text CHECK (email <> '' AND char_length(email) <= 254),
  phone       text CHECK (phone <> '' AND char_length(phone) <= 32),
  messenger   text CHECK (messenger <> '' AND char_length(messenger) <= 100),
  is_primary  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_contacts_supplier_idx
  ON supplier_contacts (supplier_id, sort_order, id);
CREATE INDEX IF NOT EXISTS supplier_contacts_email_idx ON supplier_contacts (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS supplier_contacts_one_primary_idx
  ON supplier_contacts (supplier_id) WHERE is_primary;

-- Заметки к карточке: только добавляются.
CREATE TABLE IF NOT EXISTS supplier_notes (
  id          bigserial PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES suppliers (id) ON DELETE CASCADE,
  text        text NOT NULL CHECK (btrim(text) <> '' AND char_length(text) <= 2000),
  author_id   text NOT NULL CHECK (author_id <> '' AND char_length(author_id) <= 200),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_notes_supplier_idx
  ON supplier_notes (supplier_id, created_at, id);

-- Таблица agent_pair_notes (личный слой связки «бот + сотрудник») и её индекс перенесены в
-- поток platform: platform/013_agent_pair_notes. Остальные операторы - без изменений.

-- Перенос: прежний email/contact_name -> основной контакт, если контактов ещё нет.
INSERT INTO supplier_contacts (supplier_id, sort_order, full_name, email, is_primary)
SELECT s.id, 0, s.full_name, s.contact_email, true
FROM (
  SELECT id,
         NULLIF(left(btrim(contact_name), 150), '') AS full_name,
         CASE WHEN char_length(btrim(email)) BETWEEN 1 AND 254
              THEN lower(btrim(email)) END AS contact_email
  FROM suppliers
) s
WHERE (s.full_name IS NOT NULL OR s.contact_email IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM supplier_contacts c WHERE c.supplier_id = s.id);

-- Поиск знаний только по разделу поставщиков. Тело - как в 017 (hybrid_search), отличия:
-- нет filter_source/filter_supplier, везде `supplier_id IS NOT NULL`, векторная ветка
-- читает отфильтрованные фрагменты и сортирует их точно (барьер OFFSET 0 отключает HNSW).
CREATE OR REPLACE FUNCTION hybrid_search_suppliers(
  query_text      text,
  query_embedding vector(768),
  match_limit     integer,
  rrf_k           integer DEFAULT 60,
  candidates      integer DEFAULT 50,
  snippet_length  integer DEFAULT 200,
  min_cosine      double precision DEFAULT 0
)
RETURNS TABLE (document_id text, chunk_index integer, snippet text, score double precision)
LANGUAGE plpgsql STABLE
SET plan_cache_mode = force_custom_plan
AS $fn$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH q AS (
    SELECT NULLIF(replace(plainto_tsquery('russian', query_text)::text, '&', '|'), '')::tsquery
      AS tsq
  ),
  fts_hits AS (
    SELECT d.document_id, d.id AS chunk_id,
           row_number() OVER (ORDER BY d.rank DESC, d.id) AS rnk
    FROM (
      SELECT DISTINCT ON (c.document_id) c.id, c.document_id,
             ts_rank_cd(c.fts, q.tsq) AS rank
      FROM knowledge_chunks c, q
      WHERE q.tsq IS NOT NULL AND c.fts @@ q.tsq
        AND c.supplier_id IS NOT NULL
      ORDER BY c.document_id, ts_rank_cd(c.fts, q.tsq) DESC, c.id
    ) d
    ORDER BY d.rank DESC, d.id
    LIMIT candidates
  ),
  vec_raw AS (
    SELECT s.id, s.document_id, s.dist
    FROM (
      SELECT c.id, c.document_id, c.embedding <=> query_embedding AS dist
      FROM knowledge_chunks c
      WHERE query_embedding IS NOT NULL AND c.embedding IS NOT NULL
        AND c.supplier_id IS NOT NULL
      OFFSET 0
    ) s
    ORDER BY s.dist, s.id
    LIMIT candidates * 10
  ),
  vec_hits AS (
    SELECT one.document_id, one.id AS chunk_id,
           row_number() OVER (ORDER BY one.dist, one.id) AS rnk
    FROM (
      SELECT DISTINCT ON (r.document_id) r.id, r.document_id, r.dist
      FROM vec_raw r
      WHERE 1 - r.dist >= min_cosine
      ORDER BY r.document_id, r.dist, r.id
    ) one
    ORDER BY one.dist, one.id
    LIMIT candidates
  ),
  fused AS (
    SELECT u.document_id,
           sum(1.0 / (rrf_k + u.rnk))::double precision AS score,
           (array_agg(u.chunk_id ORDER BY u.branch))[1] AS chunk_id
    FROM (
      SELECT document_id, chunk_id, rnk, 0 AS branch FROM fts_hits
      UNION ALL
      SELECT document_id, chunk_id, rnk, 1 AS branch FROM vec_hits
    ) u
    GROUP BY u.document_id
  )
  SELECT c.document_id, c.chunk_index, left(c.content, snippet_length) AS snippet, f.score
  FROM fused f JOIN knowledge_chunks c ON c.id = f.chunk_id
  ORDER BY f.score DESC, c.document_id
  LIMIT match_limit;
END
$fn$;
