-- Миграция 040: сквозная нумерация договоров по всем юрлицам (решение владельца 01.11).
-- Раньше счётчик ключевался (юрлицо, год) - у каждого юрлица своя последовательность.
-- Теперь счётчик общий: строка с ключом 'ALL' на каждый год. Её начальное значение -
-- максимум по счётчикам юрлиц и по выданным номерам этого года, чтобы новый номер был
-- больше любого выданного ранее. Префикс юрлица остаётся в номере, в contract_numbers - реальное юрлицо.
-- Идемпотентна: повторный запуск не уменьшает общий счётчик (GREATEST) и не создаёт дублей.
-- Старые строки юрлиц не удаляются: это история, новый код их не читает.
-- Накатывает владелец на бою (красная зона). Порядок выкладки: бэкап БД -> миграция -> код.
-- Код всё равно переживает обратный порядок: при создании строки 'ALL' он берёт максимум
-- выданных за год номеров из contract_numbers, а не единицу.
-- Откат (после отката кода; номера в документах остаются):
--   DELETE FROM contract_number_counters WHERE legal_entity = 'ALL';
--   DELETE FROM schema_migrations WHERE version = '040_contract_number_shared_counter';

INSERT INTO contract_number_counters (legal_entity, year, last_sequence)
SELECT 'ALL', year, MAX(seq)
  FROM (
    SELECT year, last_sequence AS seq
      FROM contract_number_counters WHERE legal_entity <> 'ALL'
    UNION ALL
    SELECT year, sequence AS seq FROM contract_numbers
  ) AS sources
 GROUP BY year
ON CONFLICT (legal_entity, year)
DO UPDATE SET last_sequence =
  GREATEST(contract_number_counters.last_sequence, EXCLUDED.last_sequence);
