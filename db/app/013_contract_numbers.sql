-- Миграция 027: номера договоров присваивает система (ТЗ 78, docs/ARCHITECTURE.md,
-- «Номера договоров»). Формат: <ПРЕФИКС ЮРЛИЦА>-<ГОД>-<NNNN>, например МГ-2026-0007.
--   contract_number_counters  счётчик по ключу (юрлицо, год); растёт одним оператором
--                             INSERT ... ON CONFLICT DO UPDATE ... RETURNING, поэтому
--                             параллельные операции получают разные номера;
--   contract_numbers          выданные номера; operation_key - ключ операции заполнения
--                             договора, повтор той же операции возвращает тот же номер.
-- Номер не переиспользуется: запись выдачи не удаляется. Идемпотентна: IF NOT EXISTS.
-- Откат (номера уже в документах - откатывать только до первого использования):
--   DROP TABLE IF EXISTS contract_numbers; DROP TABLE IF EXISTS contract_number_counters;
--   DELETE FROM schema_migrations WHERE version = '027_contract_numbers';

CREATE TABLE IF NOT EXISTS contract_number_counters (
  legal_entity  text    NOT NULL CHECK (legal_entity <> '' AND char_length(legal_entity) <= 20),
  year          integer NOT NULL CHECK (year BETWEEN 2000 AND 2999),
  last_sequence integer NOT NULL CHECK (last_sequence >= 1),
  PRIMARY KEY (legal_entity, year)
);

CREATE TABLE IF NOT EXISTS contract_numbers (
  operation_key text        PRIMARY KEY
                            CHECK (operation_key <> '' AND char_length(operation_key) <= 500),
  legal_entity  text        NOT NULL,
  year          integer     NOT NULL,
  sequence      integer     NOT NULL CHECK (sequence >= 1),
  number        text        NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity, year, sequence)
);
