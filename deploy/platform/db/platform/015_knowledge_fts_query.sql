-- Запрос FTS базы знаний: нормализация лексем кодов позиций.
--
-- FTS-ветка `hybrid_search` строила запрос текстом:
-- `replace(plainto_tsquery(...)::text, '&', '|')`. Дефекты:
--  * `M8x40` (латиница) не находит `М8х40` (кириллица): это разные лексемы `m8x40`/`м8х40`;
--  * `3х2.5` не находит `3х2,5`: запятая режет число, в документе лексемы `3х2` и `5`;
--  * однозначные лексемы (`5` из `3x2,5`) в OR совпадают почти с любым фрагментом с цифрами:
--    шум в выдаче и лишняя работа медленной FTS-ветки;
--  * `&` внутри лексемы-URL (`example.test/p?a=1&b=2`) превращался в `|` внутри кавычек,
--    лексема переставала совпадать.
-- Исправление - только на стороне запроса, функция `knowledge_fts_query`:
--  * операнды берутся из `plainto_tsquery` по одному (в кавычках), порядок и повторы прежние,
--    `&` внутри лексемы не трогается; запрос собирается OR по операндам;
--  * к ним добавляются варианты кодов позиций: лексема с цифрой и буквой в одной раскладке
--    (латинские буквы-двойники -> кириллица и обратно, `m8x40` <-> `м8х40`); запятая между
--    цифрами читается как точка (`3x2,5` -> `3x2.5`), и для десятичной лексемы добавляется
--    часть до точки - так режет число индекс документа (`3х2,5` -> `3х2`);
--  * лексемы короче 2 символов отбрасываются, если остаётся хоть одна; запрос из одних
--    коротких лексем (`5`) ведёт себя как раньше.
-- Для запроса без кодов позиций, URL и однозначных лексем строка запроса посимвольно та же,
-- что раньше: выдача не меняется (тест hybrid-search-equivalence).
-- Индекс документов (`fts`, 003) НЕ меняется и не пересчитывается: нормализация текста
-- документа потребовала бы переписать `knowledge_chunks` целиком (STORED-столбец в PG 16
-- не меняет выражение без перезаписи таблицы; при перезаписи заново строится и HNSW).
-- Остаток: код позиции со смешанной раскладкой ВНУТРИ документа (`М8x40`: кириллическая М и
-- латинская x) запросом в одной раскладке не находится, как и раньше; векторная ветка
-- такие случаи частично покрывает.
--
-- Сигнатура и RETURNS TABLE `hybrid_search` прежние (клиентский код не меняется). Таблицы и
-- индексы не трогаются: миграция мгновенная, окно обслуживания не нужно.
-- Идемпотентна: только CREATE OR REPLACE FUNCTION.
-- Откат: выполнить CREATE OR REPLACE FUNCTION hybrid_search из
-- 014_hybrid_search_iterative_scan.sql, затем DROP FUNCTION IF EXISTS knowledge_fts_query(text);
-- DELETE FROM schema_migrations WHERE version LIKE '%015_knowledge_fts_query';

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
