-- Staging больших прайсов: позиции складываются кусками под import_id, затем фиксируются
-- одной атомарной заменой прайса поставщика. Идемпотентна (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS import_staging (
  import_id   text PRIMARY KEY,
  supplier_id text NOT NULL,
  file_hash   text NOT NULL,
  -- Строк данных по таблицам (листам) исходника: { "<таблица>": <число> }.
  sources     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_staging_created_idx ON import_staging (created_at);

-- Принятые куски: повтор куска с тем же ключом ничего не добавляет.
CREATE TABLE IF NOT EXISTS import_staging_chunks (
  import_id text NOT NULL REFERENCES import_staging (import_id) ON DELETE CASCADE,
  chunk_key text NOT NULL,
  PRIMARY KEY (import_id, chunk_key)
);

CREATE TABLE IF NOT EXISTS import_staging_items (
  id           bigserial PRIMARY KEY,
  import_id    text NOT NULL REFERENCES import_staging (import_id) ON DELETE CASCADE,
  product_name text NOT NULL CHECK (product_name <> ''),
  sku          text,
  price        numeric(18, 4) NOT NULL CHECK (price > 0),
  currency     char(3) NOT NULL,
  price_date   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS import_staging_items_import_idx
  ON import_staging_items (import_id, id);
