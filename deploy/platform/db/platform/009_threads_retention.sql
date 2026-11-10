-- Ретенция тредов агентов: удаляются только завершённые (status = 'completed') треды без
-- активности; идущие и ждущие человека не трогаются никогда. Сообщения уходят каскадом
-- (messages.thread_id ... ON DELETE CASCADE). Частичный индекс по updated_at обслуживает
-- ThreadStore.purgeOlderThan и плановую чистку deploy/scripts/maintenance.sh. Идемпотентна.

CREATE INDEX IF NOT EXISTS threads_completed_idx ON threads (updated_at)
  WHERE status = 'completed';
