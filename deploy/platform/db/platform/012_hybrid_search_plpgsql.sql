-- hybrid_search на plpgsql с пересчётом плана на каждый вызов.
-- Дефект: в SQL-функции (LANGUAGE sql) тело планировалось один раз как generic-план, где
-- `filter_source`/`filter_scope`/`candidates` неизвестны. На базах до ~100 тыс. фрагментов
-- векторная ветка шла Seq Scan + top-N sort по всей knowledge_chunks (читая весь TOAST
-- векторов), а не по индексу HNSW: 360-1130 мс против 50-110 мс на 60 тыс. фрагментов.
-- Исправление: то же тело, но plpgsql (`RETURN QUERY`) с `plan_cache_mode = force_custom_plan`:
-- планировщик видит значения параметров и берёт HNSW (или btree по области при фильтре).
-- СИГНАТУРА И РЕЗУЛЬТАТ ПРЕЖНИЕ (9 аргументов, те же типы и RETURNS TABLE) - клиентский код не
-- меняется. Выдача и ранжирование не затронуты: тело запроса то же, что в 011.
-- `hnsw.ef_search = 500` сохранён: = candidates (50) * запас фрагментов на кандидата (10).
-- `#variable_conflict use_column`: имена столбцов RETURNS TABLE (document_id, chunk_index,
-- snippet, score) совпадают с именами столбцов таблицы и CTE; побеждает столбец, как в SQL.
-- Таблицы не трогаются, данные не перезаписываются. Идемпотентна (CREATE OR REPLACE).
-- Откат: выполнить CREATE OR REPLACE FUNCTION hybrid_search из 011_hybrid_search_relevance.sql.

CREATE OR REPLACE FUNCTION hybrid_search(
  query_text      text,
  query_embedding vector(768),
  match_limit     integer,
  filter_source   text DEFAULT NULL,
  filter_scope    text DEFAULT NULL,
  rrf_k           integer DEFAULT 60,
  candidates      integer DEFAULT 50,
  snippet_length  integer DEFAULT 200,
  min_cosine      double precision DEFAULT 0
)
RETURNS TABLE (document_id text, chunk_index integer, snippet text, score double precision)
LANGUAGE plpgsql STABLE
-- Без этого HNSW отдаёт не больше 40 строк (ef_search по умолчанию) и запас ниже не
-- набирается; 500 = candidates (50) * запас фрагментов на кандидата (10).
SET hnsw.ef_search = 500
-- Custom-план на каждый вызов: с generic-планом индекс HNSW на малых базах не выбирается.
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
    -- Лучший фрагмент каждого документа, затем `candidates` лучших документов.
    SELECT d.document_id, d.id AS chunk_id,
           row_number() OVER (ORDER BY d.rank DESC, d.id) AS rnk
    FROM (
      SELECT DISTINCT ON (c.document_id) c.id, c.document_id,
             ts_rank_cd(c.fts, q.tsq) AS rank
      FROM knowledge_chunks c, q
      WHERE q.tsq IS NOT NULL AND c.fts @@ q.tsq
        AND (filter_source IS NULL OR c.source = filter_source)
        AND (filter_scope IS NULL OR c.scope = filter_scope)
      ORDER BY c.document_id, ts_rank_cd(c.fts, q.tsq) DESC, c.id
    ) d
    ORDER BY d.rank DESC, d.id
    LIMIT candidates
  ),
  vec_raw AS (
    -- Ближайшие фрагменты с запасом: LIMIT здесь нужен индексу HNSW, свёртка по документу
    -- и порог близости применяются к этой выборке.
    SELECT c.id, c.document_id, c.embedding <=> query_embedding AS dist
    FROM knowledge_chunks c
    WHERE query_embedding IS NOT NULL AND c.embedding IS NOT NULL
      AND (filter_source IS NULL OR c.source = filter_source)
      AND (filter_scope IS NULL OR c.scope = filter_scope)
    ORDER BY c.embedding <=> query_embedding
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
    -- Сумма ветвей по ДОКУМЕНТУ; фрагмент для сниппета: из FTS (0), иначе из векторов (1).
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
