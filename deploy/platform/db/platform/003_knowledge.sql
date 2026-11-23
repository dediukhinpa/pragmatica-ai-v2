-- База знаний: гибридный поиск (полнотекстовый русский + векторы pgvector).
-- Размерность 768 совпадает с эмбеддером; смена модели = новая миграция и переиндексация.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id          bigserial PRIMARY KEY,
  document_id text NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content     text NOT NULL,
  source      text,                -- источник (файл, раздел, URL) - SQL-фильтр
  scope       text,                -- область (проект, раздел, владелец) - SQL-фильтр
  embedding   vector(768),         -- NULL, пока эмбеддинг не посчитан
  fts         tsvector GENERATED ALWAYS AS (to_tsvector('russian', content)) STORED,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_fts_idx ON knowledge_chunks USING gin (fts);
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS knowledge_chunks_source_idx ON knowledge_chunks (source);
CREATE INDEX IF NOT EXISTS knowledge_chunks_scope_idx ON knowledge_chunks (scope);

-- Гибридный поиск: ветка FTS (OR по лексемам) + ветка векторов (косинус), слияние RRF.
-- query_embedding может быть NULL (тогда только FTS). Возвращает лучший фрагмент
-- каждого документа. score - сумма 1/(rrf_k + ранг) по веткам, больше = лучше.
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
LANGUAGE sql STABLE AS $$
  WITH q AS (
    SELECT NULLIF(replace(plainto_tsquery('russian', query_text)::text, '&', '|'), '')::tsquery
      AS tsq
  ),
  fts_hits AS (
    SELECT id, row_number() OVER (ORDER BY rank DESC, id) AS rnk
    FROM (
      SELECT c.id, ts_rank_cd(c.fts, q.tsq) AS rank
      FROM knowledge_chunks c, q
      WHERE q.tsq IS NOT NULL AND c.fts @@ q.tsq
        AND (filter_source IS NULL OR c.source = filter_source)
        AND (filter_scope IS NULL OR c.scope = filter_scope)
      ORDER BY rank DESC, c.id
      LIMIT candidates
    ) f
  ),
  vec_hits AS (
    SELECT id, row_number() OVER (ORDER BY dist, id) AS rnk
    FROM (
      SELECT c.id, c.embedding <=> query_embedding AS dist
      FROM knowledge_chunks c
      WHERE query_embedding IS NOT NULL AND c.embedding IS NOT NULL
        AND (filter_source IS NULL OR c.source = filter_source)
        AND (filter_scope IS NULL OR c.scope = filter_scope)
      ORDER BY c.embedding <=> query_embedding
      LIMIT candidates
    ) v
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
