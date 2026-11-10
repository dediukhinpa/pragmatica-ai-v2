-- hybrid_search с фильтром раздела не теряет векторную ветку.
-- Дефект: при `filter_scope` крупного раздела (на 100 тыс. фрагментов - от ~10-25% базы)
-- планировщик берёт индекс HNSW, а фильтр по `scope` применяется ПОСЛЕ него. HNSW отдаёт
-- не больше `hnsw.ef_search` (500) ближайших строк по всей базе; если все они чужие, векторная
-- ветка пуста, хотя в разделе есть близкие фрагменты выше `min_cosine`.
-- Исправление: итеративный скан pgvector >= 0.8 (`hnsw.iterative_scan = relaxed_order`):
-- если после фильтра строк меньше LIMIT, индекс продолжает обход, пока LIMIT не наберётся или
-- не просмотрено `hnsw.max_scan_tuples` строк. Без фильтра первая порция (ef_search) уже
-- набирает LIMIT, выдача не меняется.
-- Порядок: в relaxed_order строки vec_raw могут идти слегка не по расстоянию, но выборка
-- всё равно точно упорядочена ниже: `vec_hits` сортирует по `dist, id` (DISTINCT ON и
-- row_number), порог `min_cosine` считается по точному `dist` каждой строки. strict_order
-- не берём: он отбрасывает часть найденных строк ради порядка, который здесь не нужен.
-- `hnsw.max_scan_tuples = 50000` (по умолчанию 20000): запас для раздела с ~10% базы, когда
-- его фрагменты далеко от запроса; это верхняя граница работы на один вызов, а не норма.
-- GUC задаются в определении функции (SET ...): действуют только на время вызова и
-- возвращаются при выходе, как уже заданные здесь ef_search и plan_cache_mode (012).
-- СИГНАТУРА, ТЕЛО ЗАПРОСА И RETURNS TABLE ПРЕЖНИЕ (012): клиентский код не меняется.
-- Таблицы не трогаются. Идемпотентна (проверка версии + CREATE OR REPLACE).
-- Откат: выполнить CREATE OR REPLACE FUNCTION hybrid_search из 012_hybrid_search_plpgsql.sql.

-- Нужна библиотека pgvector >= 0.8 (параметры hnsw.iterative_scan и hnsw.max_scan_tuples).
-- Приведение к vector загружает библиотеку в сеанс: после этого её параметры видны в
-- pg_settings (у неизвестного параметра pg_settings строки нет), а SET в определении функции
-- ниже проверяется по-настоящему, а не принимается как произвольная строка.
DO $check$
DECLARE
  lib_version text;
BEGIN
  PERFORM '[1]'::vector;
  SELECT default_version INTO lib_version FROM pg_available_extensions WHERE name = 'vector';
  IF NOT EXISTS (SELECT 1 FROM pg_settings WHERE name = 'hnsw.iterative_scan')
     OR NOT EXISTS (SELECT 1 FROM pg_settings WHERE name = 'hnsw.max_scan_tuples') THEN
    RAISE EXCEPTION 'pgvector % слишком старый: нужен >= 0.8 (hnsw.iterative_scan)',
      coalesce(lib_version, '?')
      USING HINT = 'Обновите образ Postgres (POSTGRES_IMAGE, deploy/docker-compose.yml) на '
        'pgvector 0.8+ для pg16 и повторите миграцию.';
  END IF;
END
$check$;

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
-- Фильтр по разделу/источнику после HNSW: обход продолжается, пока LIMIT не наберётся.
SET hnsw.iterative_scan = relaxed_order
-- Предел итеративного обхода на один вызов (по умолчанию 20000).
SET hnsw.max_scan_tuples = 50000
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
    -- и порог близости применяются к этой выборке. При relaxed_order порядок строк здесь
    -- приблизительный: точный порядок задаёт сортировка по dist в vec_hits.
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
