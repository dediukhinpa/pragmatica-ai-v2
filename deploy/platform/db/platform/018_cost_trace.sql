-- Стоимость вызова и трасса в замерах операций, трасса в оценках ответов.
-- trace_id - идентификатор трассы телеметрии (32 hex-символа), по нему жалобу 👎 открывают
-- трассой; model - алиас модели агента; cost_usd - стоимость операции в USD (заголовок прокси
-- или таблица цен). NULL: телеметрия выключена / стоимость неизвестна. Только коды и числа,
-- ПДн нет. Идемпотентна: повторный прогон ничего не меняет.

ALTER TABLE operation_metrics
  ADD COLUMN IF NOT EXISTS trace_id text,
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS cost_usd numeric(12, 6);

-- Проверка неотрицательности - отдельным ограничением: NOT VALID не сканирует таблицу при
-- добавлении (короткая блокировка), VALIDATE проверяет уже существующие строки отдельным
-- оператором. Добавление защищено проверкой pg_constraint: повторный прогон ничего не меняет.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operation_metrics_cost_usd_nonneg'
      AND conrelid = 'operation_metrics'::regclass
  ) THEN
    ALTER TABLE operation_metrics
      ADD CONSTRAINT operation_metrics_cost_usd_nonneg CHECK (cost_usd >= 0) NOT VALID;
  END IF;
END
$$;

ALTER TABLE operation_metrics VALIDATE CONSTRAINT operation_metrics_cost_usd_nonneg;

-- Частичный индекс: большинство строк (телеметрия выключена) без трассы в индекс не попадают.
CREATE INDEX IF NOT EXISTS operation_metrics_trace_idx
  ON operation_metrics (trace_id) WHERE trace_id IS NOT NULL;

-- Оценка хранит трассу того хода, который оценивают (отдельной колонкой: JSON-поля в feedback
-- нет, а нулевая колонка без ограничений - самое дешёвое и безопасное расширение).
ALTER TABLE feedback
  ADD COLUMN IF NOT EXISTS trace_id text;
