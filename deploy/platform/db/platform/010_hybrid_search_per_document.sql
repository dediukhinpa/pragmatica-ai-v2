-- R3-ALG-10: гибридный поиск возвращал меньше документов, чем просили. Ветки брали
-- `candidates` лучших ФРАГМЕНТОВ и лишь потом оставляли по лучшему фрагменту на документ
-- (DISTINCT ON), поэтому длинный документ с десятками похожих фрагментов занимал все 50
-- мест кандидатов, и вместо 10 документов приходил один.
-- Теперь: ветка FTS сначала оставляет лучший фрагмент каждого документа и только потом
-- режет до `candidates` документов; ветка векторов берёт с запасом (VEC_OVERFETCH_FACTOR
-- фрагментов на кандидата), сворачивает по документу и режет до `candidates`.
-- Сигнатура и порядок параметров прежние (CREATE OR REPLACE, перегрузки не появляется).
-- Идемпотентна. Откат: повторно выполнить тело hybrid_search из 003_knowledge.sql.

CREATE OR REPLACE FUNCTION hybrid_search(
  query_text      text,
  query_embedding vector(768),
  match_limit     integer,
  filter_source   text DEFAULT NULL,
  filter_scope    text DEFAULT NULL,
  rrf_k           integer DEFAULT 60,
  candidates      integer DEFAULT 50,
  snippet_length  integer DEFAULT 200
)
RETURNS TABLE (document_id text, chunk_index integer, snippet text, score double precision)
LANGUAGE sql STABLE
-- Без этого HNSW отдаёт не больше 40 строк (ef_search по умолчанию) и запас ниже не
-- набирается; 500 = candidates (50) * VEC_OVERFETCH_FACTOR (10).
SET hnsw.ef_search = 500
AS $$
  WITH q AS (
    SELECT NULLIF(replace(plainto_tsquery('russian', query_text)::text, '&', '|'), '')::tsquery
      AS tsq
  ),
  fts_hits AS (
    -- Лучший фрагмент каждого документа, затем `candidates` лучших документов.
    SELECT id, row_number() OVER (ORDER BY rank DESC, id) AS rnk
    FROM (
      SELECT d.id, d.rank
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
    ) f
  ),
  vec_raw AS (
    -- Ближайшие фрагменты с запасом: LIMIT здесь нужен индексу HNSW, свёртка по
    -- документу идёт уже над этой выборкой.
    SELECT c.id, c.document_id, c.embedding <=> query_embedding AS dist
    FROM knowledge_chunks c
    WHERE query_embedding IS NOT NULL AND c.embedding IS NOT NULL
      AND (filter_source IS NULL OR c.source = filter_source)
      AND (filter_scope IS NULL OR c.scope = filter_scope)
    ORDER BY c.embedding <=> query_embedding
    LIMIT candidates * 10
  ),
  vec_hits AS (
    SELECT id, row_number() OVER (ORDER BY dist, id) AS rnk
    FROM (
      SELECT DISTINCT ON (r.document_id) r.id, r.dist
      FROM vec_raw r
      ORDER BY r.document_id, r.dist, r.id
    ) one
    ORDER BY dist, id
    LIMIT candidates
  ),
  fused AS (
    SELECT u.id, sum(1.0 / (rrf_k + u.rnk))::double precision AS score
    FROM (SELECT id, rnk FROM fts_hits UNION ALL SELECT id, rnk FROM vec_hits) u
    GROUP BY u.id
  ),
  best AS (
    SELECT DISTINCT ON (c.document_id)
      c.document_id, c.chunk_index, left(c.content, snippet_length) AS snippet, f.score
    FROM fused f JOIN knowledge_chunks c ON c.id = f.id
    ORDER BY c.document_id, f.score DESC, c.chunk_index
  )
  SELECT b.document_id, b.chunk_index, b.snippet, b.score
  FROM best b
  ORDER BY b.score DESC, b.document_id
  LIMIT match_limit
$$;
