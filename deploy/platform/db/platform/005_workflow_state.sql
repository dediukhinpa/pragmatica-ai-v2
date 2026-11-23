-- Состояние долгих сценариев агентов (выбор пользователя, промежуточные результаты, наборы данных между шагами).
-- Ключ с побайтовой сортировкой: курсор по ключу не зависит от локали базы. Идемпотентна.

CREATE TABLE IF NOT EXISTS workflow_state (
  namespace  text NOT NULL,
  key        text COLLATE "C" NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, key)
);
