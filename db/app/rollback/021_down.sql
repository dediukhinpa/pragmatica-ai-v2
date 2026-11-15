-- Обратная миграция к platform/021_jobs_daily_schedule: возврат таблицы jobs к виду, который
-- ждёт образ прежней Прагматики (FREEZE_SRC 5ea7f2d3, миграции 001-042 прежнего репозитория).
--
-- Зачем. Миграция платформы 1.1.x добавила jobs.daily_at, jobs.time_zone и ограничение
-- jobs_daily_schedule_check (серии «в часы дня по поясу»). Код прежней Прагматики столбцов не
-- знает: строку-серию (repeat_every_ms пуст, daily_at задан) он прочтёт как РАЗОВУЮ задачу,
-- выполнит один раз и закроет (status = 'done'), то есть серия молча потеряется. Поэтому до
-- удаления столбцов серии снимаются: после отката старый код сам заново ставит свои
-- расписания, а ключи идемпотентности снятых серий освобождаются. Разовые задачи и серии по
-- интервалу (daily_at пуст) не меняются.
--
-- Когда запускается. rollback.sh пакета переключения исполняет его ДО старта старых контейнеров
-- и ПОСЛЕ остановки новых (приложения, индексатора), ПЕРЕД 026_down.sql: сначала 021_down, затем
-- 026_down. Удаление столбцов берёт блокировку ACCESS EXCLUSIVE на jobs. Запуск:
--   psql --single-transaction -v ON_ERROR_STOP=1 -f db/app/rollback/021_down.sql
-- BEGIN/COMMIT здесь не пишутся: транзакцию открывает psql. Файл лежит в подкаталоге
-- rollback/ вне потока: раннер (migrate.sh) читает только db/app/*.sql и его не применяет.
--
-- Что делает (после выполнения схема jobs и учёт совпадают с состоянием до платформы 1.1.x):
--   1. удаляет строки jobs с daily_at IS NOT NULL (серии часов дня), сообщает их число;
--   2. снимает ограничение jobs_daily_schedule_check, затем столбцы daily_at и time_zone
--      (они были добавлены в конец таблицы, порядок остальных столбцов не меняется);
--   3. из schema_migrations удаляет запись миграции: `platform/021_jobs_daily_schedule` (так её
--      пишет раннер) и `021_jobs_daily_schedule` (так он пишет её при MIGRATE_LEGACY_NAMES=1,
--      прежнему репозиторию это имя не принадлежит: его 021 - 021_metrics_cache_tokens).
--      Остальные записи не трогаются: версии 026 снимает 026_down.sql. Раннер v2 при
--      следующем запуске снова увидит 021 как pending и применит её.
--
-- Идемпотентность. Шаги 1-2 завершаются без ошибок, если столбцов уже нет (IF EXISTS и
-- проверка столбца перед DELETE); шаг 3 удаляет 0 строк. Порядок «сначала 021_down, затем
-- 026_down» не обязателен для корректности: схема jobs и столбец knowledge_chunks независимы,
-- запись учёта снимается при любом порядке (026_down снимает все записи с префиксом, 021_down
-- после него находит схему и снимает остатки).
-- Защита: если в учёте есть записи с префиксом, но нет ни одной прежней (база поднята
-- раннером v2 с нуля), откат к прежнему образу невозможен: скрипт останавливается ДО любых
-- изменений, чтобы не оставить базу откатанной наполовину.
--
-- Проверка: tools/prove-rollback.sh (схема до v2 = схема после 021_down и 026_down; старый
-- код на серии часов дня без отката выполняет её один раз и закрывает, после отката серии нет).

-- Та же блокировка, что у раннеров (LOCK_ID в migrate.sh): откат не пересечётся с миграцией.
SELECT pg_advisory_xact_lock(48151623);
-- Не висеть на чужих сессиях: лучше упасть с ошибкой, чем стоять с ACCESS EXCLUSIVE в очереди.
SET LOCAL lock_timeout = '30s';

-- Защита от базы без прежних записей учёта (раньше любых изменений схемы).
DO $guard$
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
END
$guard$;

-- Серии часов дня: старый код выполнил бы такую строку один раз как разовую и закрыл.
DO $series$
DECLARE
  removed bigint;
BEGIN
  IF EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'jobs' AND column_name = 'daily_at')
  THEN
    DELETE FROM jobs WHERE daily_at IS NOT NULL;
    GET DIAGNOSTICS removed = ROW_COUNT;
    RAISE NOTICE 'снято серий часов дня (jobs.daily_at): %', removed;
  END IF;
END
$series$;

ALTER TABLE IF EXISTS jobs DROP CONSTRAINT IF EXISTS jobs_daily_schedule_check;
ALTER TABLE IF EXISTS jobs DROP COLUMN IF EXISTS daily_at;
ALTER TABLE IF EXISTS jobs DROP COLUMN IF EXISTS time_zone;

-- Учёт: запись 021 исчезает, раннер v2 сможет применить миграцию заново.
DO $ledger$
BEGIN
  IF to_regclass('schema_migrations') IS NULL THEN
    RETURN;
  END IF;
  DELETE FROM schema_migrations
  WHERE version IN ('platform/021_jobs_daily_schedule', '021_jobs_daily_schedule');
END
$ledger$;
