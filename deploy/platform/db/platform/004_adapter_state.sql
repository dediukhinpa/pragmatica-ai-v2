-- Состояние для адаптеров ThreadStore и IdempotencyStore, индекс для ретенции jobs.
-- Идемпотентна: ADD COLUMN / CREATE INDEX с IF NOT EXISTS.

-- Тред целиком: статус, декларация агента (нужна resume) и причина приостановки.
-- Сообщения лежат в messages (роль agent хранится как assistant).
ALTER TABLE threads ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'running'
  CHECK (status IN ('running', 'suspended', 'completed'));
ALTER TABLE threads ADD COLUMN IF NOT EXISTS spec jsonb;
ALTER TABLE threads ADD COLUMN IF NOT EXISTS suspension jsonb;
ALTER TABLE threads ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Результат операции по ключу: SQL NULL = результата нет (запись ещё не сделана),
-- JSON null хранится как jsonb 'null' и отличим от отсутствия.
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS result jsonb;

-- Ретенция: выбор завершённых (взятых в работу) разовых задач по давности.
CREATE INDEX IF NOT EXISTS jobs_finished_idx ON jobs (claimed_at) WHERE status = 'claimed';
