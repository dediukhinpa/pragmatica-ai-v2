-- Ретенция состояния сценариев: удаляются только строки завершённых сценариев.
-- `done` ставится при записи (put с done=true); живое состояние не трогается никогда.
-- Частичный индекс по updated_at ускоряет purgeOlderThan. Идемпотентна.

ALTER TABLE workflow_state ADD COLUMN IF NOT EXISTS done boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS workflow_state_done_idx ON workflow_state (updated_at) WHERE done;
