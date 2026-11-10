-- Предметная часть прежней миграции 020: поиск знаний по разделу поставщиков с HNSW.
-- knowledge_fts_query и hybrid_search той же миграции живут в потоке platform:
-- platform/015_knowledge_fts_query. Оператор ниже перенесён без изменений.
-- Причины правок и замеры (R9-A5-03) - в шапке прежней 020 (история старого репозитория).

-- Тело - как в 018, отличия: q через knowledge_fts_query; векторная ветка без барьера
-- OFFSET 0, с теми же параметрами HNSW, что у hybrid_search (019).
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
-- 500 = candidates (50) * VEC_OVERFETCH_FACTOR (10), как в hybrid_search.
SET hnsw.ef_search = 500
-- Фильтр `supplier_id IS NOT NULL` после HNSW: обход продолжается, пока LIMIT не наберётся.
SET hnsw.iterative_scan = relaxed_order
-- Предел итеративного обхода на один вызов (по умолчанию 20000).
SET hnsw.max_scan_tuples = 50000
SET plan_cache_mode = force_custom_plan
AS $fn$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH q AS (
    SELECT knowledge_fts_query(query_text) AS tsq
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
    -- Крупный раздел: HNSW + итеративный скан; малый: точная сортировка по индексу
    -- supplier_id. Выбор - за планировщиком по статистике (custom-план на каждый вызов).
    SELECT c.id, c.document_id, c.embedding <=> query_embedding AS dist
    FROM knowledge_chunks c
    WHERE query_embedding IS NOT NULL AND c.embedding IS NOT NULL
      AND c.supplier_id IS NOT NULL
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
