import { describe, expect, test } from 'bun:test';
import {
  buildInitialImportSummary,
  issueLabel,
} from '../../src/agents/prices/initial-import-summary';
import { PRICES_PROMPT } from '../../src/agents/prices/prompt';

const AT = '2026-10-27T00:00:00.000Z';

function summaryFor(reason: string): string {
  return buildInitialImportSummary(
    [{ run: 'r', file: 'a.xlsx', status: 'skipped', reason, at: AT }],
    false,
  );
}

describe('подписи кодов замечаний в сводке первичного импорта', () => {
  test.each([
    ['size_variants_same_article', 'варианты товара (размеры)'],
    ['group_header_names', 'название в заголовке группы'],
    ['price_tiers_by_quantity', 'цены по тиражам'],
    ['hidden_data', 'скрытые данные'],
    ['hidden_sheets', 'скрытые листы'],
    ['file_truncated', 'файл прочитан не целиком'],
    ['rows_rejected', 'часть строк отклонена'],
  ])('код %s показан словами', (code, label) => {
    const text = summaryFor(`needs_review:${code}`);
    expect(text).toContain(`нужна проверка (${label})`);
    expect(text).not.toContain(code);
  });

  test('неизвестный код показывается как есть, одинаковые подписи не повторяются', () => {
    const text = summaryFor(
      'needs_review:made_up_code,multiple_price_tiers,price_tiers_by_quantity',
    );
    expect(text).toContain('(made_up_code, цены по тиражам)');
  });
});

describe('промпт «Прайсов»: итоги и порядок действий', () => {
  test('structure_changed только при наличии прежнего прайса', () => {
    expect(PRICES_PROMPT).toContain(
      'только когда у поставщика уже есть прежний прайс',
    );
    expect(PRICES_PROMPT).toContain('complex_table');
  });

  test('промпт называет коды для скрытых данных и обрезки, как в подписях', () => {
    expect(PRICES_PROMPT).toContain('hidden_data');
    expect(PRICES_PROMPT).toContain('file_truncated');
  });

  test('при замечаниях сначала варианты, группы и тиражи, потом откладывать', () => {
    const at = PRICES_PROMPT.indexOf('Порядок при замечаниях по таблице');
    expect(at).toBeGreaterThan(-1);
    const part = PRICES_PROMPT.slice(at, at + 500);
    expect(part).toContain('variantColumns');
    expect(part).toContain('priceTiers');
    expect(part).toContain('Откладывай файл');
  });
});

describe('подписи кодов, которые агент придумал сам (по ключевым словам)', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['multi_tier_price_columns', 'цены по тиражам'],
    ['tiered_price_by_quantity', 'цены по тиражам'],
    ['group_rows_without_price', 'название в заголовке группы'],
    ['name_not_unique_across_packaging', 'варианты товара'],
    ['duplicate_names_across_tables', 'повторяющиеся строки'],
    ['hidden_flag_without_hidden_sheets', 'скрытые данные'],
    ['supplier_draft_created', 'создана новая карточка поставщика'],
    ['multiple_tables_mixed_content', 'сложная таблица'],
    ['price_depends_on_exchange_rate', 'цена зависит от валюты или курса'],
    ['price_anomaly_suspected', 'резкий скачок цены'],
  ];
  for (const [code, label] of cases) {
    test(code, () => expect(issueLabel(code)).toBe(label));
  }

  test('точная подпись важнее ключевого слова', () => {
    expect(issueLabel('two_price_columns')).toBe('два столбца цен');
  });

  test('ни одно слово не подошло - код как есть', () => {
    expect(issueLabel('xyz_unknown')).toBe('xyz_unknown');
  });
});
