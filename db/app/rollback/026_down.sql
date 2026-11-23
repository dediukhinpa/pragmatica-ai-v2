-- Обратная миграция к 026_knowledge_scope_compat: возврат схемы базы знаний к виду, который
-- ждёт образ прежней Прагматики (FREEZE_SRC 5ea7f2d3, миграции 001-042 прежнего репозитория).
--
-- Зачем. 026 переименовала knowledge_chunks.supplier_id в scope, индекс
-- knowledge_chunks_supplier_idx в knowledge_chunks_scope_idx и пересоздала knowledge_fts_query,
-- hybrid_search и hybrid_search_suppliers под столбец scope (параметр filter_supplier стал
-- filter_scope). Код прежней Прагматики пишет и читает supplier_id: после 026 запись знаний
-- (INSERT ... supplier_id), supplierIdsOf и прямые обращения к столбцу падают с
-- `column "supplier_id" does not exist`. Без этого скрипта откат на старые контейнеры
-- невозможен.
--
-- Когда запускается. rollback.sh пакета переключения исполняет его ДО старта старых
-- контейнеров и ПОСЛЕ остановки новых (приложения, индексатора): переименование столбца берёт
-- блокировку ACCESS EXCLUSIVE на knowledge_chunks. Запуск:
--   psql --single-transaction -v ON_ERROR_STOP=1 -f db/app/rollback/026_down.sql
-- BEGIN/COMMIT здесь не пишутся: транзакцию открывает psql. Файл лежит в подкаталоге
-- rollback/ вне потока: раннер (migrate.sh) читает только db/app/*.sql и его не применяет.
--
-- Что делает (после выполнения схема и учёт совпадают с состоянием до накатки v2):
--   1. scope -> supplier_id, knowledge_chunks_scope_idx -> knowledge_chunks_supplier_idx
--      (переименование: тип text, отсутствие NOT NULL и данные остаются теми же);
--   2. снимает платформенный hybrid_search (параметр filter_scope) и возвращает три функции в
--      редакции прежнего репозитория, миграция 020_knowledge_fts_query_suppliers_hnsw
--      (она последняя определяет все три; 003/013/015/017/019 для hybrid_search и 018 для
--      hybrid_search_suppliers старше). knowledge_fts_query НЕ удаляется, а заменяется на
--      прежнюю IMMUTABLE-редакцию: её вызывает hybrid_search_messages (миграция 030, поиск по
--      репликам), после DROP она бы сломалась. hybrid_search_suppliers пересоздана 026 вне
--      условного блока и читает scope, поэтому тоже возвращается;
--   3. из schema_migrations удаляет версии с префиксом потока (`platform/...`, `app/...`),
--      которые раннер v2 дописал рядом со старыми записями. Остаются ровно прежние записи
--      вида `001_core`, по которым работает прежний раннер db/migrate.sh. Раннер v2 при
--      следующем запуске допишет новые версии сам (карта legacy-map.tsv) и применит 026 заново.
--
-- Идемпотентность. Шаги 1-2 выполняются, только если есть столбец scope и нет supplier_id
-- (зеркало условия 026); на уже откатанной базе блок пропускается, шаг 3 удаляет 0 строк.
-- Защита: если в учёте есть записи с префиксом, но нет ни одной прежней (база поднята
-- раннером v2 с нуля), откат к прежнему образу невозможен и скрипт останавливается.
--
-- Если 026 изменится (тело функций), прежние редакции ниже не зависят от неё: они взяты из
-- 5ea7f2d3:db/migrations/020_knowledge_fts_query_suppliers_hnsw.sql дословно.
-- Проверка: tools/prove-rollback-026.sh (схема до v2 = схема после v2 и этого скрипта).

-- Та же блокировка, что у раннеров (LOCK_ID в migrate.sh): откат не пересечётся с миграцией.
SELECT pg_advisory_xact_lock(48151623);
-- Не висеть на чужих сессиях: лучше упасть с ошибкой, чем стоять с ACCESS EXCLUSIVE в очереди.
SET LOCAL lock_timeout = '30s';

DO $rollback$
BEGIN
  IF EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'knowledge_chunks' AND column_name = 'scope')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'knowledge_chunks' AND column_name = 'supplier_id')
  THEN
    ALTER TABLE knowledge_chunks RENAME COLUMN scope TO supplier_id;
    ALTER INDEX IF EXISTS knowledge_chunks_scope_idx RENAME TO knowledge_chunks_supplier_idx;
    -- Тот же список типов, что у обеих редакций (имя параметра в сигнатуру не входит):
    -- CREATE OR REPLACE не умеет менять имя параметра, поэтому платформенная снимается.
    DROP FUNCTION IF EXISTS hybrid_search(
      text, vector, integer, text, text, integer, integer, integer, double precision);
    -- Прежний запрос FTS (020): IMMUTABLE вместо платформенного STABLE.
    EXECUTE $kfq$
CREATE OR REPLACE FUNCTION knowledge_fts_query(query_text text)
RETURNS tsquery
LANGUAGE sql IMMUTABLE PARALLEL SAFE
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
    -- Артикул: буквы, цифры, точка и дефис; есть и цифра, и буква (не URL, не путь).
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
    -- Прежний hybrid_search (020): параметр filter_supplier, фильтр по supplier_id.
    EXECUTE $hs$
CREATE OR REPLACE FUNCTION hybrid_search(
  query_text      text,
  query_embedding vector(768),
  match_limit     integer,
  filter_source   text DEFAULT NULL,
  filter_supplier text DEFAULT NULL,
  rrf_k           integer DEFAULT 60,
  candidates      integer DEFAULT 50,
  snippet_length  integer DEFAULT 200,
  min_cosine      double precision DEFAULT 0
)
RETURNS TABLE (document_id text, chunk_index integer, snippet text, score double precision)
LANGUAGE plpgsql STABLE
-- Без этого HNSW отдаёт не больше 40 строк (ef_search по умолчанию) и запас ниже не
-- набирается; 500 = candidates (50) * VEC_OVERFETCH_FACTOR (10).
SET hnsw.ef_search = 500
-- Фильтр по поставщику/источнику после HNSW: обход продолжается, пока LIMIT не наберётся.
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
        AND (filter_supplier IS NULL OR c.supplier_id = filter_supplier)
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
      AND (filter_supplier IS NULL OR c.supplier_id = filter_supplier)
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
    -- Прежний hybrid_search_suppliers (020): читает supplier_id.
    EXECUTE $hss$
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
    $hss$;
  END IF;
END
$rollback$;

-- Учёт: вернуть вид «до переключения». Записи вида `001_core` (без `/`) не трогаются.
DO $ledger$
BEGIN
  IF to_regclass('schema_migrations') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations
             WHERE version LIKE 'platform/%' OR version LIKE 'app/%')
     AND NOT EXISTS (SELECT 1 FROM schema_migrations
                     WHERE version NOT LIKE 'platform/%' AND version NOT LIKE 'app/%')
  THEN
    RAISE EXCEPTION
      'в schema_migrations нет прежних записей: база поднята раннером v2 с нуля, откат невозможен';
  END IF;
  DELETE FROM schema_migrations
  WHERE version LIKE 'platform/%' OR version LIKE 'app/%';
END
$ledger$;
