-- Коммерческие предложения поставщиков (разобранные ответы). Идемпотентна.
-- Одно актуальное КП поставщика по заявке: новое замещает прежнее, `version` растёт на 1.
-- Позиции и пометки «чего не хватает» лежат в jsonb, а не в отдельной таблице: КП всегда
-- читается и заменяется целиком, по позициям не ищут и не соединяют, форма позиции
-- (необязательные поля) меняется чаще схемы БД. Читатель повторно проверяет jsonb Zod-схемой.
-- Внешнего ключа на suppliers/purchase_requests нет: как у price_items, КП может прийти
-- раньше карточки, а заявки живут в своей таблице с собственной ретенцией.

CREATE TABLE IF NOT EXISTS supplier_quotes (
  request_id    text NOT NULL,
  supplier_id   text NOT NULL,
  id            text NOT NULL CHECK (id <> ''),
  currency      char(3) NOT NULL,
  received_at   timestamptz NOT NULL,
  valid_until   timestamptz,
  delivery_days integer CHECK (delivery_days >= 0),
  payment_terms text,
  notes         text,
  source_ref    text,
  lines         jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  gaps          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(gaps) = 'array'),
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, supplier_id)
);
-- Выборка по заявке идёт по префиксу первичного ключа (request_id, supplier_id), отдельный
-- индекс по request_id был бы дублем; для «все КП поставщика» нужен индекс по supplier_id.
CREATE INDEX IF NOT EXISTS supplier_quotes_supplier_idx ON supplier_quotes (supplier_id);
