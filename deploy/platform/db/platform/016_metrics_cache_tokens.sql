-- Токены кэша промпта в замерах операций: сколько входных токенов прочитано из кэша и сколько
-- записано в него. Обе колонки входят в input_tokens, а не добавляются к нему. NULL - шлюз
-- счётчик не сообщил. Только числа, ПДн нет. Идемпотентна.

ALTER TABLE operation_metrics
  ADD COLUMN IF NOT EXISTS cache_read_input_tokens integer
    CHECK (cache_read_input_tokens >= 0),
  ADD COLUMN IF NOT EXISTS cache_creation_input_tokens integer
    CHECK (cache_creation_input_tokens >= 0);
