-- Миграция 026: кэш оценок поставщиков моделью (ТЗ, разд. 4: рейтинг в шорт-листе).
--
-- Рейтинг считается вместе с моделью по фактам карточки (docs/ARCHITECTURE.md, «Шорт-лист»).
-- Чтобы не звать модель на каждый шорт-лист, оценка кладётся сюда по ключу
-- (поставщик, хэш фактов): пока факты карточки не менялись, берётся запись, а не новый вызов.
--   facts_hash  SHA-256 (hex) каноничной записи фактов; смена фактов даёт другой хэш;
--   score       оценка 1..5 (numeric(2,1): запасное правило даёт и половинки);
--   rationale   короткое обоснование, проверенное кодом (без контактов и серий цифр);
--   source      'model' | 'rule'. Код кэширует только 'model': результат запасного правила
--               при сбое модели не записывается, чтобы позже повторить попытку.
-- Ретенция: при записи код удаляет прочие записи того же поставщика (факты изменились -
-- прежняя оценка не нужна), поэтому в таблице не больше одной строки на поставщика и
-- отдельная чистка не нужна. Внешнего ключа на suppliers нет: кэш производный, любая запись
-- безопасно пересчитывается; строка удалённого поставщика безвредна и перезапишется.
--
-- Идемпотентна: CREATE TABLE IF NOT EXISTS. Откат (кэш пересоберётся сам):
--   DROP TABLE IF EXISTS supplier_rating_cache;
--   DELETE FROM schema_migrations WHERE version = '026_supplier_rating_cache';

CREATE TABLE IF NOT EXISTS supplier_rating_cache (
  supplier_id text          NOT NULL CHECK (supplier_id <> '' AND char_length(supplier_id) <= 100),
  facts_hash  text          NOT NULL CHECK (facts_hash ~ '^[0-9a-f]{64}$'),
  score       numeric(2, 1) NOT NULL CHECK (score >= 1 AND score <= 5),
  rationale   text          NOT NULL CHECK (rationale <> '' AND char_length(rationale) <= 200),
  source      text          NOT NULL CHECK (source IN ('model', 'rule')),
  created_at  timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier_id, facts_hash)
);
