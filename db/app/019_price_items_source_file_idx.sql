-- Миграция 036: индекс по файлу прайса поставщика (этап 116, тема D).
--
-- У поставщика теперь несколько прайс-файлов (значки, медали): импорт заменяет и сравнивает
-- строки только своего `source_file`. Столбец `source_file` есть с миграции 001; до этой версии
-- он не заполнялся (NULL у всех строк). Миграция данные НЕ меняет и файл задним числом не
-- угадывает: строки с NULL заменяются при первом импорте файла поставщика, у которого других
-- файлов нет (см. `planSourceReplacement`). Индекс ускоряет `DELETE ... WHERE supplier_id AND
-- source_file = ANY(...)` и выборку файлов поставщика.
--
-- Идемпотентна: CREATE INDEX IF NOT EXISTS. Откат:
--   DROP INDEX IF EXISTS price_items_supplier_file_idx;
--   DELETE FROM schema_migrations WHERE version = '036_price_items_source_file_idx';

CREATE INDEX IF NOT EXISTS price_items_supplier_file_idx ON price_items (supplier_id, source_file);
