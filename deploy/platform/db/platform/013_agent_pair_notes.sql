-- Личный слой связки «сотрудник + бот»: предпочтения и личные заметки сотрудника. Читает и
-- пишет только своя связка: условие по обоим столбцам (bot_id, user_id) есть в каждом запросе
-- адаптера. Пределы длины и числа записей (1000 знаков, 100 на связку) совпадают с константами
-- core/src/domain/pair-notes.ts; число записей на связку проверяет код под блокировкой.
-- Идемпотентна: повторный запуск ничего не меняет.
--
-- Откат (вручную, данные заметок будут потеряны):
--   DROP TABLE IF EXISTS agent_pair_notes;
--   DELETE FROM schema_migrations WHERE version LIKE '%013_agent_pair_notes';

CREATE TABLE IF NOT EXISTS agent_pair_notes (
  id         bigserial PRIMARY KEY,
  bot_id     text NOT NULL CHECK (bot_id <> ''),
  user_id    text NOT NULL CHECK (user_id <> ''),
  kind       text NOT NULL CHECK (kind IN ('preference', 'note')),
  text       text NOT NULL CHECK (btrim(text) <> '' AND char_length(text) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_pair_notes_pair_idx
  ON agent_pair_notes (bot_id, user_id, created_at, id);
