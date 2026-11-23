-- Миграция 031: оборот поставщика по годам и признак карточки-черновика.
--
-- Оборот (ТЗ 10.9: «за последние два-три года»): `turnover_by_year` - JSON-массив
-- [{"year": 2025, "rub": 150000000}, ...], не больше 5 лет, новые годы первыми (порядок и
-- уникальность лет обеспечивает код, `normalizeTurnoverYears`). Прежний `turnover_rub`
-- (одна сумма без года) остаётся: у уже заведённых карточек год неизвестен, переносить нечего.
--
-- Черновик: `is_draft` = true у карточки, которую завёл агент прайсов по шапке файла
-- (название, ИНН, телефон, сайт, город) с пометкой «черновик, не проверено». Остальной код
-- работает с ней как с обычной карточкой; слияние с настоящей карточкой переносит цены и
-- удаляет черновик (`deleteDraftCard` удаляет только строки с `is_draft`).
-- Частичный индекс по черновикам: их мало, а список для сводки и слияния нужен быстро.
--
-- Идемпотентна: ADD COLUMN IF NOT EXISTS, индекс IF NOT EXISTS. Повторный запуск данные не
-- меняет. Откат (данные новых столбцов теряются, прежние остаются):
--   DROP INDEX IF EXISTS suppliers_draft_idx;
--   ALTER TABLE suppliers DROP COLUMN IF EXISTS turnover_by_year,
--     DROP COLUMN IF EXISTS is_draft;
--   DELETE FROM schema_migrations WHERE version = '031_supplier_turnover_draft';

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS turnover_by_year jsonb
    CHECK (turnover_by_year IS NULL OR (
      jsonb_typeof(turnover_by_year) = 'array' AND jsonb_array_length(turnover_by_year) <= 5)),
  ADD COLUMN IF NOT EXISTS is_draft boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS suppliers_draft_idx ON suppliers (id) WHERE is_draft;
