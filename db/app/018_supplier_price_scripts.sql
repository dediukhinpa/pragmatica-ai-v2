-- Миграция 035: сохранённые скрипты разбора прайсов за поставщиком (этап 111, тема 3).
--
-- Когда обычный разбор прайса не берёт таблицу, агент пишет Python-скрипт (песочница). Удачный
-- скрипт запоминается за поставщиком и формой таблицы: следующий прайс той же формы сначала
-- разбирается им, без модели.
--   form_hash   SHA-256 (hex) ОТПЕЧАТКА ФОРМЫ таблицы: число столбцов и нормализованные ячейки
--               шапки (раскладка), без значений данных. Другая шапка - другая форма - другой
--               скрипт;
--   version     номер версии скрипта для пары (поставщик, форма), с 1; правка скрипта (агентом
--               или по просьбе сотрудника) - новая версия, прежние остаются для отката;
--   code        исходник скрипта (точка входа run(tables, source)); не больше 30 000 символов;
--   created_by  'agent' - скрипт написал агент сам; 'employee_request' - переписан по просьбе
--               сотрудника («цена в столбце D»);
--   created_at  когда версия сохранена.
-- Ретенция: код после записи оставляет у пары не больше 5 последних версий. Внешнего ключа на
-- suppliers нет (как у кэшей): запись слияния черновика безвредна, мёртвый скрипт никому не
-- мешает - он не проходит сверку или не находит свою форму.
--
-- Идемпотентна: CREATE TABLE IF NOT EXISTS. Откат (скрипты пересоздаст агент):
--   DROP TABLE IF EXISTS supplier_price_scripts;
--   DELETE FROM schema_migrations WHERE version = '035_supplier_price_scripts';

CREATE TABLE IF NOT EXISTS supplier_price_scripts (
  supplier_id text        NOT NULL CHECK (supplier_id <> '' AND char_length(supplier_id) <= 100),
  form_hash   text        NOT NULL CHECK (form_hash ~ '^[0-9a-f]{64}$'),
  version     integer     NOT NULL CHECK (version >= 1),
  code        text        NOT NULL CHECK (code <> '' AND char_length(code) <= 30000),
  created_by  text        NOT NULL CHECK (created_by IN ('agent', 'employee_request')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier_id, form_hash, version)
);
