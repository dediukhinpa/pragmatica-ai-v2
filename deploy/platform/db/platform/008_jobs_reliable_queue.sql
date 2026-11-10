-- Надёжная очередь «не менее одного раза»: pending -> running -> done / failed.
-- Раньше `claimed` значило и «взято», и «готово»: задача, взятая упавшим воркером, терялась.
-- Теперь взятая задача остаётся в running до отметки исхода; брошенную (locked_at старше
-- таймаута видимости) планировщик отдаёт снова.
--
-- Существующие `claimed` переводятся в `done`, а не в `pending`. По старой строке нельзя
-- отличить выполненную задачу от потерянной, а за срок ретенции (30 дней) там почти все
-- выполненные: вернуть их в очередь значило бы разом повторить старые напоминания и запуски
-- агентов. Потерянные при прежней схеме и так не исполнялись, хуже им не становится. Найти
-- перенесённые строки можно по last_error = 'migrated_from_claimed' (docs/RUNBOOK.md).
--
-- Идемпотентна и безопасна на непустой таблице: ADD COLUMN / CREATE INDEX с IF NOT EXISTS,
-- ограничение пересоздаётся, UPDATE затрагивает только строки старого формата.
-- Применять при остановленном app: старый код пишет статус `claimed`, новое ограничение
-- его не примет.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS locked_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS locked_by text;
-- Не раньше какого момента повторять после сбоя; due_at остаётся плановым сроком запуска.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS finished_at timestamptz;
-- Код последней ошибки (без текста: в тексте могут быть ПДн).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_error text;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;

UPDATE jobs
SET status = 'done',
    finished_at = COALESCE(claimed_at, now()),
    last_error = 'migrated_from_claimed'
WHERE status = 'claimed';

-- attempts раньше считал захваты за всю жизнь строки (у повторяющейся задачи рос без конца);
-- теперь это попытки на текущем сроке, для ожидающих начинаем с нуля. Строки нового формата
-- с ненулевым счётчиком ждут повтора и имеют next_attempt_at: их повторный прогон не тронет.
UPDATE jobs SET attempts = 0
WHERE status = 'pending' AND attempts <> 0 AND next_attempt_at IS NULL;

ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('pending', 'running', 'done', 'failed'));

-- claimed_at больше не пишется (время захвата теперь в locked_at); столбец оставлен, чтобы
-- миграция ничего не удаляла.
DROP INDEX IF EXISTS jobs_finished_idx;
CREATE INDEX IF NOT EXISTS jobs_finished_at_idx ON jobs (finished_at)
  WHERE status IN ('done', 'failed');
CREATE INDEX IF NOT EXISTS jobs_running_idx ON jobs (locked_at) WHERE status = 'running';
