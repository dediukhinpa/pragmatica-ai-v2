-- Метрики операций агентов и обратная связь сотрудников (замер метрик, сбор обратной
-- связи, итоговый отчёт). Только числа, коды и идентификаторы: тексты сообщений,
-- аргументы инструментов и ПДн сюда не пишутся. Идемпотентна.

CREATE TABLE IF NOT EXISTS operation_metrics (
  id            text PRIMARY KEY,
  agent         text NOT NULL,
  operation     text NOT NULL,                 -- run | resume
  ref           text NOT NULL,                 -- тред (диалог), в котором шла операция
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NOT NULL,
  outcome       text NOT NULL CHECK (outcome = 'ok' OR outcome = 'blocked' OR outcome LIKE 'error:%'),
  steps         integer NOT NULL CHECK (steps >= 0),
  input_tokens  integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  CHECK (finished_at >= started_at)
);
CREATE INDEX IF NOT EXISTS operation_metrics_started_idx ON operation_metrics (started_at);
CREATE INDEX IF NOT EXISTS operation_metrics_agent_idx ON operation_metrics (agent, started_at);

-- Без внешнего ключа на operation_metrics: сбой записи метрики не должен ломать оценку.
CREATE TABLE IF NOT EXISTS feedback (
  operation_id text NOT NULL,
  author       text NOT NULL,                  -- идентификатор сотрудника в канале чата
  agent        text NOT NULL,
  rating       text NOT NULL CHECK (rating IN ('up', 'down')),
  comment      text CHECK (comment IS NULL OR char_length(comment) <= 500),
  at           timestamptz NOT NULL,
  PRIMARY KEY (operation_id, author)
);
CREATE INDEX IF NOT EXISTS feedback_at_idx ON feedback (at);
