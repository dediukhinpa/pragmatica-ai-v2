-- Миграция 037: дата договора рядом с выданным номером (этап 120, тема 3).
--
-- NDA «приложение к основному договору» берёт номер и дату последнего договора поставщика из
-- уже выданных номеров. Номер лежит в contract_numbers, а дата договора (issuedAt документа)
-- в ключе операции есть не всегда (при заявке в ключе номер заявки). Столбец хранит дату
-- договора на момент выдачи. У старых строк он NULL: для них берётся дата выдачи (created_at).
--
-- Идемпотентна: ADD COLUMN IF NOT EXISTS. Откат:
--   ALTER TABLE contract_numbers DROP COLUMN IF EXISTS document_date;
--   DELETE FROM schema_migrations WHERE version = '037_contract_number_document_date';

ALTER TABLE contract_numbers ADD COLUMN IF NOT EXISTS document_date date;
