-- Основные таблицы платформы (идемпотентность, аудит, очередь задач).
-- Миграция идемпотентна (IF NOT EXISTS), можно гонять повторно.
-- Намеренно нет таблицы замен псевдонимизатора: у сервиса псевдонимизации своё хранилище.

-- Ключи идемпотентности побочных операций (отправка сообщения, запись в CRM и т.п.).
-- Результат не хранится: повтор с тем же ключом просто ничего не делает.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope      text NOT NULL,
  key        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- Журнал аудита, только добавление. Тексты с ПДн сюда не пишем: details - служебные
-- сведения (идентификаторы, коды), за состав отвечает вызывающий код.
CREATE TABLE IF NOT EXISTS audit_log (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL,
  actor           text NOT NULL,      -- кто (пользователь)
  agent           text,               -- какой агент действовал
  action          text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  result          text,
  details         text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor, id);

-- Очередь отложенных и повторяющихся задач планировщика.
CREATE TABLE IF NOT EXISTS jobs (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  payload          text NOT NULL DEFAULT '',
  due_at           timestamptz NOT NULL,
  repeat_every_ms  bigint CHECK (repeat_every_ms > 0),
  idempotency_key  text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed')),
  attempts         integer NOT NULL DEFAULT 0,
  claimed_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs (due_at) WHERE status = 'pending';
