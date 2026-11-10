-- Индекс под ночную чистку и подсчёт «в сомнении» хранилища результатов операций
-- (purgeOlderThan / countInDoubt): отбор по области и возрасту без прохода по всей таблице.
-- Индекс частичный (только область operation_result), прочие области ключей в него не
-- попадают. Идемпотентна: CREATE INDEX IF NOT EXISTS; старый код работает и без индекса.
--
-- ВНИМАНИЕ: db/migrate.sh выполняет миграцию в одной транзакции (--single-transaction), а
-- CREATE INDEX CONCURRENTLY в транзакции невозможен, поэтому индекс строится обычным
-- CREATE INDEX и на время сборки блокирует ЗАПИСЬ в idempotency_keys. Таблица небольшая
-- (результаты чистятся по ретенции), но выкатывать лучше вне пика нагрузки.

CREATE INDEX IF NOT EXISTS idempotency_keys_result_created_idx
  ON idempotency_keys (created_at)
  WHERE scope = 'operation_result';
