-- Миграция 020: поиск по истории диалога.
-- Агент достаёт подробности старых реплик (номера сделок, цифры, обещания) инструментом поиска
-- по СВОЕМУ треду. Для этого у `messages` появляются полнотекстовый столбец и эмбеддинг,
-- а гибридный поиск (FTS + pgvector, слияние RRF) - функция `hybrid_search_messages`.
--
-- Удаление: оба столбца лежат в строке сообщения, поэтому исчезают вместе с ней (в том числе
-- каскадом `threads` -> `messages`, ретенция 009): отдельных таблиц и хвостов нет.
-- Старые сообщения не пересчитываются: `fts` вычисляется самой БД при добавлении столбца,
-- `embedding` у них NULL и они ищутся только полнотекстово (пересчёта старых сообщений нет).
-- Эмбеддинг новых сообщений пишет приложение после коммита хода (вне горячего пути); нет
-- эмбеддера или он упал - `embedding` остаётся NULL, работает только FTS.
--
-- Блокировка: ADD COLUMN ... GENERATED STORED переписывает `messages` под ACCESS EXCLUSIVE.
-- Таблица мала (тред хранит не больше MAX_STORED_THREAD_MESSAGES = 5000 реплик, модели из них
-- подаётся хвост в 200), окно обслуживания не нужно.
-- Идемпотентна. Откат: DROP FUNCTION IF EXISTS hybrid_search_messages(text, text, vector,
-- integer, timestamptz, timestamptz, integer, integer, double precision);
-- ALTER TABLE messages DROP COLUMN IF EXISTS embedding, DROP COLUMN IF EXISTS fts;
-- DELETE FROM schema_migrations WHERE version LIKE '%020_message_search';

-- Для tsvector есть предел ~1 МБ: сверхдлинная реплика уронила бы INSERT и ход агента. В индекс
-- идёт начало реплики (100000 символов - с большим запасом под предел).
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS fts tsvector
    GENERATED ALWAYS AS (to_tsvector('russian', left(content, 100000))) STORED;

-- 768 - как у knowledge_chunks (003): тот же сервис эмбеддингов. NULL - не посчитан.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding vector(768);

CREATE INDEX IF NOT EXISTS messages_fts_idx ON messages USING gin (fts);
CREATE INDEX IF NOT EXISTS messages_embedding_idx
  ON messages USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- Гибридный поиск по репликам ОДНОГО треда. Тело - как у hybrid_search (015): ветка FTS (OR по
-- лексемам через knowledge_fts_query) + ветка векторов (косинус, порог min_cosine), слияние
-- RRF; отличия: единица выдачи - реплика, а не документ; обязательный фильтр `thread_id`
-- (WHERE, чужой тред недоступен по построению) и необязательный период по `created_at`.
-- Параметры HNSW - как в 014/015: фильтр по треду применяется после обхода графа, итеративный
-- скан добирает строки; малый тред планировщик читает точно по индексу messages_thread_idx.
CREATE OR REPLACE FUNCTION hybrid_search_messages(
  filter_thread   text,
  query_text      text,
  query_embedding vector(768),
  match_limit     integer,
  filter_since    timestamptz DEFAULT NULL,
  filter_until    timestamptz DEFAULT NULL,
  rrf_k           integer DEFAULT 60,
  candidates      integer DEFAULT 50,
  min_cosine      double precision DEFAULT 0
)
RETURNS TABLE (message_id bigint, score double precision)
LANGUAGE plpgsql STABLE
SET hnsw.ef_search = 500
SET hnsw.iterative_scan = relaxed_order
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
    SELECT m.id AS message_id,
           row_number() OVER (ORDER BY ts_rank_cd(m.fts, q.tsq) DESC, m.id DESC) AS rnk
    FROM messages m, q
    WHERE m.thread_id = filter_thread
      AND q.tsq IS NOT NULL AND m.fts @@ q.tsq
      AND (filter_since IS NULL OR m.created_at >= filter_since)
      AND (filter_until IS NULL OR m.created_at <= filter_until)
    ORDER BY ts_rank_cd(m.fts, q.tsq) DESC, m.id DESC
    LIMIT candidates
  ),
  vec_raw AS (
    SELECT m.id, m.embedding <=> query_embedding AS dist
    FROM messages m
    WHERE m.thread_id = filter_thread
      AND query_embedding IS NOT NULL AND m.embedding IS NOT NULL
      AND (filter_since IS NULL OR m.created_at >= filter_since)
      AND (filter_until IS NULL OR m.created_at <= filter_until)
    ORDER BY m.embedding <=> query_embedding
    LIMIT candidates * 10
  ),
  vec_hits AS (
    SELECT r.id AS message_id, row_number() OVER (ORDER BY r.dist, r.id DESC) AS rnk
    FROM vec_raw r
    WHERE 1 - r.dist >= min_cosine
    ORDER BY r.dist, r.id DESC
    LIMIT candidates
  ),
  fused AS (
    SELECT u.message_id, sum(1.0 / (rrf_k + u.rnk))::double precision AS score
    FROM (
      SELECT message_id, rnk FROM fts_hits
      UNION ALL
      SELECT message_id, rnk FROM vec_hits
    ) u
    GROUP BY u.message_id
  )
  SELECT f.message_id, f.score
  FROM fused f
  ORDER BY f.score DESC, f.message_id DESC
  LIMIT match_limit;
END
$fn$;
