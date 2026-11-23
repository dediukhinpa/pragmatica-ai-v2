-- Миграция 025: НДС, оборот, размер скидки - числами; ОКВЭД ОК 029-2014 (ОКВЭД 2) по шаблону.
--
-- Было (миграция 024): `vat`, `turnover`, `agency_discount` - свободный текст, `okved` - 2-6 цифр
-- через точки. Стало:
--   vat_mode                 text   'with_vat' (плательщик) | 'no_vat' (без НДС: УСН и др.);
--   vat_rate_percent         numeric(5,2), 0..100, только при vat_mode = 'with_vat' (ставка
--                            может быть не названа: просто «с НДС»);
--   turnover_rub             numeric(16,2), рубли, 0..10 трлн;
--   agency_discount_percent  numeric(5,2), 0..100;
--   okved                    CHECK по ОКВЭД 2: NN, NN.N, NN.NN, NN.NN.N, NN.NN.NN (класс 01-99).
-- Режим НДС нужен отдельно: «без НДС / УСН» и «НДС 0%» - разные вещи (нулевая ставка у
-- плательщика, например экспорт), а ставка NULL одна и та же.
--
-- Перенос (один раз, при первом применении; повторный запуск данные не трогает):
--   * текст разбирается теми же правилами, что в core/src/domain/supplier-card-values.ts
--     (кириллица, запятая как десятичный разделитель, пробелы-разделители тысяч,
--     «тыс/млн/млрд», «руб.»); однозначно разобранное записывается в новую колонку;
--   * не разобранное (несколько лет в обороте, «до 5%», код вне ОКВЭД 2 и т.п.) НЕ теряется:
--     исходный текст добавляется заметкой карточки «Миграция 025: <поле> (исходный текст): ...»
--     (автор migration-025); числовая колонка остаётся NULL;
--   * ОКВЭД приводится к записи с точками на месте; не разобранный код - в заметку, поле NULL.
-- Упаковка (`packaging`) уже в 024 ограничена перечислением none / transport / gift, свободных
-- текстовых значений в базе нет, переносить нечего. Несколько значений в одно поле не
-- записывались и записаться не могут (CHECK).
--
-- Старые текстовые колонки `vat`, `turnover`, `agency_discount` ОСТАЮТСЯ нетронутыми (код их
-- больше не читает и не пишет): `assertSchemaCurrent` допускает откат образа приложения на
-- прежнюю версию при уже накатанной схеме, а прежний образ читает эти колонки. Удаление -
-- отдельной миграцией после того, как релиз закреплён. До этого значения в них - снимок на
-- момент миграции.
--
-- Идемпотентна: ADD COLUMN IF NOT EXISTS, ограничения пересоздаются, перенос выполняется
-- только если колонки `vat_mode` ещё не было. Откат (данные новых колонок теряются, старые
-- тексты на месте):
--   ALTER TABLE suppliers
--     DROP CONSTRAINT IF EXISTS suppliers_okved_format_check,
--     DROP CONSTRAINT IF EXISTS suppliers_vat_consistent_check,
--     DROP COLUMN IF EXISTS vat_mode, DROP COLUMN IF EXISTS vat_rate_percent,
--     DROP COLUMN IF EXISTS turnover_rub, DROP COLUMN IF EXISTS agency_discount_percent;
--   ALTER TABLE suppliers ADD CONSTRAINT suppliers_okved_check
--     CHECK (okved ~ '^[0-9]{2}([.][0-9]{1,2}){0,2}$');
--   DELETE FROM schema_migrations WHERE version = '025_supplier_card_numeric_fields';

-- Разбор значений. Функции временные (живут до конца сеанса, в схеме не остаются).

-- Свёртка текста: пробелы (в том числе неразрывные) в один, регистр и «ё» не важны. Кириллица
-- переводится явной таблицей: lower() в базе с локалью C буквы не из ASCII не понижает.
CREATE OR REPLACE FUNCTION pg_temp.m025_fold(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
  SELECT lower(btrim(regexp_replace(
    translate(t, 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯЁё', 'абвгдежзийклмнопрстуфхцчшщъыьэюяее'),
    '[\s  ]+', ' ', 'g')))
$f$;

-- Процент 0..100: «5», «5%», «5,5 %», «скидка 10%», «10% от цены поставщика»; иначе NULL.
CREATE OR REPLACE FUNCTION pg_temp.m025_percent(t text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE
  m text[];
  v numeric;
BEGIN
  m := regexp_match(pg_temp.m025_fold(t),
    '^(?:скидка )?(\d+(?:[.,]\d+)?) ?%?(?: от цены(?: поставщика)?)?$');
  IF m IS NULL THEN RETURN NULL; END IF;
  v := replace(m[1], ',', '.')::numeric;
  IF v < 0 OR v > 100 THEN RETURN NULL; END IF;
  RETURN round(v, 2);
END
$f$;

-- НДС: массив {режим, ставка или NULL}; не разобрано - NULL.
CREATE OR REPLACE FUNCTION pg_temp.m025_vat(t text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE
  f text := pg_temp.m025_fold(t);
  m text[];
  v numeric;
BEGIN
  IF f ~ ('^(?:без ндс|(?:ндс )?не облагается(?: ндс)?|усн(?: без ндс)?|упрощенка|'
          || 'упрощенная система(?: налогообложения)?|нет ндс|ндс нет|не плательщик ндс)$') THEN
    RETURN ARRAY['no_vat', NULL::text];
  END IF;
  IF f ~ '^(?:с ндс|ндс|включая ндс|ндс включен|в том числе ндс)$' THEN
    RETURN ARRAY['with_vat', NULL::text];
  END IF;
  m := regexp_match(f,
    '^(?:(?:(?:с |включая )?ндс:? )|ставка )?(\d+(?:[.,]\d+)?) ?%?(?: ндс)?$');
  IF m IS NULL THEN RETURN NULL; END IF;
  v := replace(m[1], ',', '.')::numeric;
  IF v < 0 OR v > 100 THEN RETURN NULL; END IF;
  RETURN ARRAY['with_vat', round(v, 2)::text];
END
$f$;

-- Сумма в рублях: «120 млн», «1,5 млрд», «500 000 000 руб.», «250 тыс.»; год, несколько сумм и
-- «1.500» без множителя не разбираются (NULL); голое число без множителя и без «руб.»/«₽»
-- меньше 100000 («2023», «120») тоже NULL, исходный текст уйдёт в заметку.
CREATE OR REPLACE FUNCTION pg_temp.m025_money(t text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE
  m text[];
  digits text;
  frac text;
  word text;
  mult numeric;
  min_bare numeric;
  v numeric;
BEGIN
  m := regexp_match(pg_temp.m025_fold(t),
    '^(\d+(?: \d{3})*(?:[.,]\d+)?|\d{1,3}(?:\.\d{3}){2,}) ?'
    || '(тыс\.?|тысяч|млн\.?|миллионов|миллиона|миллион|млрд\.?|миллиардов|миллиарда|миллиард)?'
    || ' ?(руб(?:\.|лей|ля|ль)?|р\.?|₽)?$');
  IF m IS NULL THEN RETURN NULL; END IF;
  word := m[2];
  IF m[1] ~ '^\d{1,3}(?:\.\d{3}){2,}$' THEN
    digits := replace(m[1], '.', '');
  ELSE
    digits := replace(m[1], ' ', '');
  END IF;
  frac := (regexp_match(digits, '[.,](\d+)$'))[1];
  IF word IS NULL AND frac IS NOT NULL AND length(frac) > 2 THEN RETURN NULL; END IF;
  -- Порог голого числа: тот же, что MIN_BARE_TURNOVER_RUB в supplier-card-values.ts.
  min_bare := 100000;
  mult := CASE
    WHEN word IS NULL THEN 1
    WHEN left(word, 3) = 'тыс' THEN 1000
    WHEN left(word, 4) = 'млрд' OR left(word, 8) = 'миллиард' THEN 1000000000
    ELSE 1000000
  END;
  v := round(replace(digits, ',', '.')::numeric * mult, 2);
  IF word IS NULL AND m[3] IS NULL AND v < min_bare THEN RETURN NULL; END IF;
  IF v > 10000000000000 THEN RETURN NULL; END IF;
  RETURN v;
END
$f$;

-- ОКВЭД 2 с точками: «4719», «47,19», «ОКВЭД 2: 47.19 Торговля...» -> «47.19»; иначе NULL.
CREATE OR REPLACE FUNCTION pg_temp.m025_okved(t text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE
  rest text;
  m text[];
  run text;
  tail text;
  code text;
  canon text;
  groups text[];
  n integer;
BEGIN
  rest := regexp_replace(pg_temp.m025_fold(t),
    '^(?:оквэд(?: ?-? ?2(?![0-9.,]))?|код)?[ :№-]*', '');
  m := regexp_match(rest, '^(\d[\d .,-]*)(.*)$');
  IF m IS NULL THEN RETURN NULL; END IF;
  run := m[1];
  tail := m[2];
  IF tail <> '' AND run !~ '[ .,-]$' THEN RETURN NULL; END IF;
  code := regexp_replace(run, '[ .,-]+$', '');
  IF code ~ '^\d+$' THEN
    canon := CASE length(code)
      WHEN 2 THEN code
      WHEN 3 THEN substr(code, 1, 2) || '.' || substr(code, 3)
      WHEN 4 THEN substr(code, 1, 2) || '.' || substr(code, 3)
      WHEN 5 THEN substr(code, 1, 2) || '.' || substr(code, 3, 2) || '.' || substr(code, 5)
      WHEN 6 THEN substr(code, 1, 2) || '.' || substr(code, 3, 2) || '.' || substr(code, 5)
      ELSE NULL
    END;
  ELSE
    groups := regexp_split_to_array(code, '[ .,-]+');
    n := array_length(groups, 1);
    IF n BETWEEN 2 AND 3
       AND length(groups[1]) = 2
       AND length(groups[2]) BETWEEN 1 AND 2
       AND (n = 2 OR length(groups[3]) BETWEEN 1 AND 2) THEN
      canon := array_to_string(groups, '.');
    END IF;
  END IF;
  IF canon ~ '^(?:0[1-9]|[1-9][0-9])(?:\.[0-9]|\.[0-9]{2}(?:\.[0-9]{1,2})?)?$' THEN
    RETURN canon;
  END IF;
  RETURN NULL;
END
$f$;

DO $mig$
DECLARE
  first_run boolean;
  old_check record;
BEGIN
  -- Перенос только при первом применении: признак - ещё нет колонки режима НДС.
  first_run := NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'suppliers'
      AND column_name = 'vat_mode');

  ALTER TABLE suppliers
    ADD COLUMN IF NOT EXISTS vat_mode text
      CHECK (vat_mode IN ('with_vat', 'no_vat')),
    ADD COLUMN IF NOT EXISTS vat_rate_percent numeric(5, 2)
      CHECK (vat_rate_percent BETWEEN 0 AND 100),
    ADD COLUMN IF NOT EXISTS turnover_rub numeric(16, 2)
      CHECK (turnover_rub BETWEEN 0 AND 10000000000000),
    ADD COLUMN IF NOT EXISTS agency_discount_percent numeric(5, 2)
      CHECK (agency_discount_percent BETWEEN 0 AND 100);

  IF first_run THEN
    -- Числа: однозначно разобранное переносится.
    UPDATE suppliers SET agency_discount_percent = pg_temp.m025_percent(agency_discount)
    WHERE agency_discount IS NOT NULL;
    UPDATE suppliers SET turnover_rub = pg_temp.m025_money(turnover)
    WHERE turnover IS NOT NULL;
    UPDATE suppliers s SET vat_mode = v.parsed[1], vat_rate_percent = v.parsed[2]::numeric
    FROM (SELECT id, pg_temp.m025_vat(vat) AS parsed FROM suppliers WHERE vat IS NOT NULL) v
    WHERE s.id = v.id AND v.parsed IS NOT NULL;

    -- Не разобранное: исходный текст в заметку карточки (ничего не теряем).
    INSERT INTO supplier_notes (supplier_id, text, author_id)
    SELECT id, left('Миграция 025: ' || label || ' (исходный текст): ' || value, 2000),
           'migration-025'
    FROM (
      SELECT id, 'скидка для агентства' AS label, agency_discount AS value
      FROM suppliers WHERE agency_discount IS NOT NULL AND agency_discount_percent IS NULL
      UNION ALL
      SELECT id, 'НДС', vat FROM suppliers WHERE vat IS NOT NULL AND vat_mode IS NULL
      UNION ALL
      SELECT id, 'оборот', turnover FROM suppliers
      WHERE turnover IS NOT NULL AND turnover_rub IS NULL
      UNION ALL
      SELECT id, 'основной ОКВЭД', okved FROM suppliers
      WHERE okved IS NOT NULL AND pg_temp.m025_okved(okved) IS NULL
    ) unparsed
    ORDER BY id, label;

    -- ОКВЭД: каноничная запись на месте, не разобранный код - NULL (текст уже в заметке).
    UPDATE suppliers SET okved = pg_temp.m025_okved(okved)
    WHERE okved IS NOT NULL AND okved IS DISTINCT FROM pg_temp.m025_okved(okved);
  END IF;

  -- Прежнее ограничение ОКВЭД (имя могло быть любым) заменяется строгим по ОКВЭД 2.
  FOR old_check IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = 'suppliers'::regclass AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%okved%'
      AND c.conname <> 'suppliers_okved_format_check'
  LOOP
    EXECUTE format('ALTER TABLE suppliers DROP CONSTRAINT %I', old_check.conname);
  END LOOP;
  ALTER TABLE suppliers DROP CONSTRAINT IF EXISTS suppliers_okved_format_check;
  ALTER TABLE suppliers ADD CONSTRAINT suppliers_okved_format_check
    CHECK (okved ~ '^(0[1-9]|[1-9][0-9])(\.[0-9]|\.[0-9]{2}(\.[0-9]{1,2})?)?$');

  -- Ставка бывает только у плательщика НДС.
  ALTER TABLE suppliers DROP CONSTRAINT IF EXISTS suppliers_vat_consistent_check;
  ALTER TABLE suppliers ADD CONSTRAINT suppliers_vat_consistent_check
    CHECK (vat_rate_percent IS NULL OR vat_mode IS NOT DISTINCT FROM 'with_vat');
END
$mig$;

COMMENT ON COLUMN suppliers.vat IS
  'Устарело (025): снимок текста на момент миграции, код не читает; '
  'см. vat_mode и vat_rate_percent.';
COMMENT ON COLUMN suppliers.turnover IS
  'Устарело (025): снимок текста на момент миграции, код не читает; см. turnover_rub.';
COMMENT ON COLUMN suppliers.agency_discount IS
  'Устарело (025): снимок текста на момент миграции, код не читает; см. agency_discount_percent.';
