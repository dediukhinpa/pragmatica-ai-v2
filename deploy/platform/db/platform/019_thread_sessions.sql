-- Сессии внутри треда связки «бот - сотрудник» и накопленная сводка прошлых сессий.
-- Тред один на всё время (скоуп псевдонимизации не меняется), сессия - граница внутри него:
-- история до session_start_turn модели не подаётся, но остаётся в messages. Сводка хранится в
-- исходном виде (после restore), как и сами сообщения: таблица живёт только в контуре заказчика.
-- Номера реплик - монотонный счётчик реплик человека треда (userTurns), а не id сообщений:
-- история усекается с начала, номера не сдвигаются.
-- Запись удаляется вместе с тредом (ON DELETE CASCADE): ретенция та же, что у threads.
-- Миграция только создаёт таблицу, данные не переносятся и не удаляются. Идемпотентна.

CREATE TABLE IF NOT EXISTS thread_sessions (
  thread_id           text PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
  session_number      integer NOT NULL DEFAULT 1 CHECK (session_number >= 1),
  session_started_at  timestamptz NOT NULL DEFAULT now(),
  session_start_turn  integer NOT NULL DEFAULT 0 CHECK (session_start_turn >= 0),
  summary             text NOT NULL DEFAULT '',
  summary_covers_turn integer NOT NULL DEFAULT 0 CHECK (summary_covers_turn >= 0),
  last_activity_at    timestamptz NOT NULL DEFAULT now(),
  -- Растёт при смене сводки или сессии; оптимистичная блокировка: сводка и ход не затирают
  -- друг друга.
  version             integer NOT NULL DEFAULT 0 CHECK (version >= 0)
);
