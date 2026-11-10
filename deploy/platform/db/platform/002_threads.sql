-- Треды агентов в исходном виде (без псевдонимизации): хранятся только в РФ-контуре.
-- Наружу, к модели, уходит уже псевдонимизированный текст.

CREATE TABLE IF NOT EXISTS threads (
  id         text PRIMARY KEY,
  agent      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id         bigserial PRIMARY KEY,
  thread_id  text NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id, id);
