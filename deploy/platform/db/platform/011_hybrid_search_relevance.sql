-- Гибридный поиск знаний: суммирование по документу и порог релевантности.
--  (а) RRF суммировался по id ФРАГМЕНТА, а документ потом брал максимум: документ, найденный
--      FTS в одном фрагменте и вектором в другом, получал одну ветку (1/61), а не сумму двух, и
--      проигрывал документу, у которого оба совпадения пришлись на один фрагмент. Теперь обе
--      ветки сворачиваются до документа (лучший фрагмент ветки) и только потом суммируются;
--      для сниппета берётся фрагмент из FTS-ветки, иначе из векторной.
--  (б) Порога релевантности не было: векторная ветка всегда возвращала ближайшие, поэтому
--      «ничего не найдено» было невозможно. Новый последний параметр `min_cosine` отсекает
--      фрагменты с косинусной близостью ниже порога (1 - расстояние); по умолчанию 0, то есть
--      прежнее поведение для вызовов без параметра. Порог задаёт адаптер.
-- Параметр добавлен в сигнатуру, поэтому прежняя (8 аргументов) функция удаляется: иначе вызов
-- с пятью аргументами стал бы неоднозначным. Таблицы не трогаются, данные не перезаписываются.
-- Идемпотентна (DROP IF EXISTS + CREATE OR REPLACE).
-- Откат: удалить функцию с 9 аргументами и выполнить тело hybrid_search из
-- 010_hybrid_search_per_document.sql.

DROP FUNCTION IF EXISTS hybrid_search(
  text, vector, integer, text, text, integer, integer, integer
);

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
LANGUAGE sql STABLE
-- Без этого HNSW отдаёт не больше 40 строк (ef_search по умолчанию) и запас ниже не
-- набирается; 500 = candidates (50) * запас фрагментов на кандидата (10).
SET hnsw.ef_search = 500
AS $$
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
  LIMIT match_limit
$$;
