-- Согласование базы знаний прежней Прагматики с платформой (миграция проекта, прообраза в
-- прежнем репозитории нет).
--
-- Зачем. В прежней схеме knowledge_chunks хранит привязку к поставщику в столбце supplier_id,
-- а hybrid_search принимает filter_supplier. Платформа (поток platform) создаёт тот же
-- объект с нейтральными именами: столбец scope, параметр filter_scope. На пустой базе поток
-- platform уже создал платформенный вариант, и блок ниже ничего не делает. На базе, поднятой
-- прежним раннером, платформенные 003 и 010-015 отмечены применёнными по карте
-- legacy-map.tsv (их тела не выполнялись), поэтому здесь схема приводится к платформенной:
--   * столбец supplier_id -> scope и индекс knowledge_chunks_supplier_idx ->
--     knowledge_chunks_scope_idx (переименование, данные и индекс не пересоздаются);
--   * knowledge_fts_query и hybrid_search - в платформенной редакции (текст из
--     platform/015_knowledge_fts_query). Параметр filter_supplier -> filter_scope: имя
--     параметра CREATE OR REPLACE менять не умеет, поэтому прежняя перегрузка снимается.
-- Данные и ранжирование не меняются: тело запроса то же, только имя столбца.
--
-- Порядок: раннер применяет поток platform раньше app. Блок срабатывает один раз на базу со
-- столбцом supplier_id; на базе со столбцом scope (пустая база или повторный запуск) он
-- пропускается. Если платформа изменит эти функции в новой миграции, обновить копию ниже
-- (проверка tools/check-migrations.sh сравнит схемы и покажет расхождение).
--
-- Откат на образ прежней Прагматики после этой миграции невозможен без обратного
-- переименования (scope -> supplier_id) и возврата функций из 020 прежнего репозитория.

DO $compat$
BEGIN
  IF EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'knowledge_chunks' AND column_name = 'supplier_id')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'knowledge_chunks' AND column_name = 'scope')
  THEN
    ALTER TABLE knowledge_chunks RENAME COLUMN supplier_id TO scope;
    ALTER INDEX IF EXISTS knowledge_chunks_supplier_idx RENAME TO knowledge_chunks_scope_idx;
    DROP FUNCTION IF EXISTS hybrid_search(
      text, vector, integer, text, text, integer, integer, integer, double precision);
    EXECUTE $kfq$
-- Запрос FTS базы знаний: OR по лексемам запроса плюс варианты кодов позиций (см. шапку).
-- NULL - в запросе нет лексем (пустой или из одних стоп-слов), как прежний NULLIF(..., '').
-- Лексема в выводе tsquery - в кавычках, `'` удвоена, `\` удвоен: шаблон `'(?:[^']|'')*'`
-- выделяет операнд целиком, а `&` внутри кавычек не путается с оператором.
CREATE OR REPLACE FUNCTION knowledge_fts_query(query_text text)
RETURNS tsquery
LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$
  WITH original AS (
    -- Операнды прежнего запроса: порядок и повторы те же, что у plainto_tsquery.
    SELECT m.ord, m.item[1] AS item,
           replace(replace(substr(m.item[1], 2, char_length(m.item[1]) - 2), '''''', ''''),
                   '\\', '\') AS lexeme
    FROM regexp_matches(plainto_tsquery('russian', query_text)::text,
                        '''(?:[^'']|'''')*''', 'g') WITH ORDINALITY AS m(item, ord)
  ),
  decimal_lexemes AS (
    -- Запятая между цифрами как точка: `3x2,5` даёт одну лексему `3x2.5`, а не `3x2` и `5`.
    SELECT replace(replace(substr(m.item[1], 2, char_length(m.item[1]) - 2), '''''', ''''),
                   '\\', '\') AS lexeme
    FROM regexp_matches(
           plainto_tsquery('russian',
                           regexp_replace(query_text, '(\d),(?=\d)', '\1.', 'g'))::text,
           '''(?:[^'']|'''')*''', 'g') AS m(item)
  ),
  seeds AS (
    SELECT lexeme FROM original
    UNION SELECT lexeme FROM decimal_lexemes
    -- Часть до первой десятичной точки: так индекс документа режет `3х2,5` (лексема `3х2`).
    UNION SELECT substring(lexeme FROM '^(.*?\d)\.\d') FROM decimal_lexemes
  ),
  articles AS (
    -- Код позиции: буквы, цифры, точка и дефис; есть и цифра, и буква (не URL, не путь).
    SELECT lexeme FROM seeds
    WHERE lexeme ~ '^[0-9a-zа-яё][0-9a-zа-яё.-]*$' AND lexeme ~ '[0-9]'
      AND lexeme ~ '[a-zа-яё]'
  ),
  variants AS (
    -- Буквы-двойники в одну раскладку; вариант берётся, только если он целиком в одной.
    SELECT v.lexeme
    FROM articles a,
         LATERAL (VALUES (translate(a.lexeme, 'abcehkmoptxy', 'авсенкмортху')),
                         (translate(a.lexeme, 'авсенкмортху', 'abcehkmoptxy'))) AS v(lexeme)
    WHERE v.lexeme !~ '[a-z]' OR v.lexeme !~ '[а-яё]'
  ),
  extra AS (
    SELECT DISTINCT x.lexeme
    FROM (SELECT lexeme FROM seeds UNION SELECT lexeme FROM variants) x
    WHERE x.lexeme IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM original o WHERE o.lexeme = x.lexeme)
  ),
  items AS (
    SELECT 0 AS part, ord AS pos, item, lexeme FROM original
    UNION ALL
    -- Добавленные лексемы - после прежних, в стабильном порядке.
    SELECT 1, row_number() OVER (ORDER BY lexeme COLLATE "C"),
           '''' || replace(replace(lexeme, '\', '\\'), '''', '''''') || '''', lexeme
    FROM extra
  ),
  kept AS (
    -- Однозначные лексемы (`5`, `x`) в OR совпадают почти со всем: шум и медленная ветка.
    SELECT part, pos, item FROM items WHERE char_length(lexeme) >= 2
  ),
  chosen AS (
    SELECT part, pos, item FROM kept
    UNION ALL
    -- Запрос только из коротких лексем: прежнее поведение, а не пустая FTS-ветка.
    SELECT part, pos, item FROM items WHERE NOT EXISTS (SELECT 1 FROM kept)
  )
  SELECT NULLIF(string_agg(item, ' | ' ORDER BY part, pos), '')::tsquery FROM chosen
$fn$;
    $kfq$;
    EXECUTE $hs$
-- Тело - как в 014, отличие только в q: knowledge_fts_query вместо текстовой замены.
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
    SELECT knowledge_fts_query(query_text) AS tsq
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
    $hs$;
  END IF;
END
$compat$;

-- Поиск по разделу поставщиков (app/008) читает столбец scope: на пустой базе и на базе,
-- приведённой блоком выше. Тело то же, что в 008, меняется только имя столбца.
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
-- Фильтр `scope IS NOT NULL` после HNSW: обход продолжается, пока LIMIT не наберётся.
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
        AND c.scope IS NOT NULL
      ORDER BY c.document_id, ts_rank_cd(c.fts, q.tsq) DESC, c.id
    ) d
    ORDER BY d.rank DESC, d.id
    LIMIT candidates
  ),
  vec_raw AS (
    -- Крупный раздел: HNSW + итеративный скан; малый: точная сортировка по индексу
    -- scope. Выбор - за планировщиком по статистике (custom-план на каждый вызов).
    SELECT c.id, c.document_id, c.embedding <=> query_embedding AS dist
    FROM knowledge_chunks c
    WHERE query_embedding IS NOT NULL AND c.embedding IS NOT NULL
      AND c.scope IS NOT NULL
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
