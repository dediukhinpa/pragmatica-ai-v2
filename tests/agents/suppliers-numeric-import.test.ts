import { describe, expect, test } from 'bun:test';
import {
  SUPPLIER_TEMPLATE_COLUMNS,
  matchSupplierHeaders,
  supplierTemplateCellRules,
} from '../../src/agents/suppliers/supplier-template';
import {
  applyFieldsToCard,
  supplierCardFieldsSchema,
} from '../../src/agents/suppliers/card-fields';
import { describeSupplierCard } from '../../src/agents/suppliers/card-view';
import { importSuppliersFile } from '../../src/agents/suppliers/import-suppliers-file';
import { parseTurnoverByYear } from '../../src/kit/domain/supplier-card-values';
import { parseExtraRowFields } from '../../src/agents/suppliers/import-row-fields';
import { FULL_CARD, FULL_SECTION_10 } from '../kit/support/supplier-fixtures';
import {
  DISCOUNT_CASES,
  OKVED_CASES,
  PACKAGING_CASES,
  TURNOVER_CASES,
  VAT_CASES,
} from '../kit/support/supplier-value-cases';
import { THREAD_A, USER_A, buildSupplierWorld, lastShown, pressOf } from './suppliers-support';

const cells = (values: Record<string, string>) => (key: string): string | undefined =>
  values[key];

describe('импорт: оборот по годам (разд. 10.9)', () => {
  test('«год: сумма» даёт оборот по годам от нового года к старому', () => {
    const { fields, issues } = parseExtraRowFields(
      cells({ turnover: '2023: 100 млн; 2025: 1,5 млрд; 2024: 120 млн' }),
    );
    expect(issues).toEqual([]);
    expect(fields['turnoverByYear']).toEqual([
      { year: 2025, rub: 1_500_000_000 },
      { year: 2024, rub: 120_000_000 },
      { year: 2023, rub: 100_000_000 },
    ]);
    expect(fields['turnoverRub']).toBeUndefined();
  });

  test('одна сумма без года остаётся оборотом без года', () => {
    const { fields, issues } = parseExtraRowFields(cells({ turnover: '150 млн' }));
    expect(issues).toEqual([]);
    expect(fields['turnoverRub']).toBe(150_000_000);
    expect(fields['turnoverByYear']).toBeUndefined();
  });

  test('год без суммы и повтор года - ошибка колонки без значения в тексте', () => {
    for (const bad of ['2024: много', '2024: 150 млн; 2024: 120 млн']) {
      const { fields, issues } = parseExtraRowFields(cells({ turnover: bad }));
      expect(fields).toEqual({});
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('Оборот по годам, руб.');
      expect(issues[0]).not.toContain('много');
    }
  });
});

describe('импорт: НДС, скидка, оборот, ОКВЭД, упаковка (разд. 10.3, 10.6, 10.9)', () => {
  test.each(VAT_CASES.filter(([input]) => input.trim() !== ''))('НДС %p', (input, expected) => {
    const { fields, issues } = parseExtraRowFields(cells({ vat: input }));
    if (expected === null) {
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('Колонка «НДС, %»');
      expect(fields).toEqual({});
      return;
    }
    expect(issues).toEqual([]);
    expect(fields['vatMode']).toBe(expected.mode);
    expect(fields['vatRatePercent']).toBe(expected.rate);
  });

  test.each(DISCOUNT_CASES.filter(([input]) => input !== ''))('скидка %p', (input, expected) => {
    const { fields, issues } = parseExtraRowFields(cells({ agencyDiscount: input }));
    expect(fields['agencyDiscountPercent'] ?? null).toBe(expected);
    expect(issues).toHaveLength(expected === null ? 1 : 0);
  });

  // Записи «год: сумма» разбирает отдельный тест ниже (оборот по годам).
  const singleSums = TURNOVER_CASES.filter(
    ([input]) => input !== '' && !parseTurnoverByYear(input).ok,
  );
  test.each(singleSums)('оборот %p', (input, expected) => {
    const { fields, issues } = parseExtraRowFields(cells({ turnover: input }));
    expect(fields['turnoverRub'] ?? null).toBe(expected);
    expect(issues).toHaveLength(expected === null ? 1 : 0);
  });

  test.each(OKVED_CASES.filter(([input]) => input.trim() !== ''))('ОКВЭД %p', (input, expected) => {
    const { fields, issues } = parseExtraRowFields(cells({ okved: input }));
    expect(fields['okved'] ?? null).toBe(expected);
    expect(issues).toHaveLength(expected === null ? 1 : 0);
  });

  test.each(PACKAGING_CASES.filter(([input]) => input !== ''))('упаковка %p', (input, expected) => {
    const { fields, issues } = parseExtraRowFields(cells({ packaging: input }));
    const ok = expected !== 'ambiguous' && expected !== 'unknown';
    expect(fields['packaging']).toBe(ok ? expected : undefined);
    expect(issues).toHaveLength(ok ? 0 : 1);
  });

  test('прежние значения упаковки и коды перечисления понимаются', () => {
    for (const [input, kind] of [
      ['gift', 'gift'],
      ['Подарочная', 'gift'],
      ['подарочная упаковка', 'gift'],
      ['транспортная', 'transport'],
      ['none', 'none'],
    ] as const) {
      expect(parseExtraRowFields(cells({ packaging: input })).fields['packaging']).toBe(kind);
    }
  });

  test('замечания называют колонку и формат, но не значение ячейки', () => {
    const { issues } = parseExtraRowFields(
      cells({
        agencyDiscount: 'секретно-до-5',
        vat: 'секретно-ндс',
        turnover: 'секретно-оборот',
        okved: 'секретно-оквэд',
        packaging: 'транспортная и подарочная',
      }),
    );
    expect(issues).toHaveLength(5);
    const text = issues.join(' ');
    expect(text).not.toContain('секретно');
    expect(issues[0]).toContain('Скидка для агентства, %');
    expect(issues[1]).toContain('«без НДС»');
    expect(issues[2]).toContain('Оборот по годам, руб.');
    expect(issues[3]).toContain('ОКВЭД 2');
    expect(issues[4]).toContain('Упаковка');
    expect(issues[4]).toContain('одно значение');
  });

  test('«без НДС» не задаёт ставку, «0» задаёт нулевую ставку плательщика', () => {
    expect(parseExtraRowFields(cells({ vat: 'УСН' })).fields).toEqual({ vatMode: 'no_vat' });
    expect(parseExtraRowFields(cells({ vat: '0' })).fields).toEqual({
      vatMode: 'with_vat',
      vatRatePercent: 0,
    });
  });
});

describe('шаблон xlsx: числовые колонки и списки', () => {
  test('67 колонок, прежние заголовки распознаются как псевдонимы новых', () => {
    expect(SUPPLIER_TEMPLATE_COLUMNS).toHaveLength(67);
    const old = ['Название*', 'ИНН', 'Скидка для агентства', 'НДС', 'Оборот за 2-3 года'];
    expect(matchSupplierHeaders(old)?.size).toBe(old.length);
    const now = SUPPLIER_TEMPLATE_COLUMNS.map((column) => column.header);
    expect(matchSupplierHeaders(now)?.size).toBe(67);
  });

  test('правила ячеек: упаковка - список из трёх значений, скидка - число, оборот - текст', () => {
    const rules = supplierTemplateCellRules();
    const packaging = rules.find((rule) => rule.key === 'packaging');
    expect(packaging).toMatchObject({
      kind: 'list',
      values: ['нет', 'транспортная', 'подарочная'],
    });
    expect(rules.find((rule) => rule.key === 'agencyDiscount')).toMatchObject({
      kind: 'number',
      min: 0,
      max: 100,
    });
    // Оборот - текст «год: сумма», числовая проверка Excel отклонила бы запись по годам.
    expect(rules.find((rule) => rule.key === 'turnover')?.kind).toBe('text');
    // Заголовки правил есть в шаблоне: иначе сборка файла молча пропустила бы правило.
    const headers = SUPPLIER_TEMPLATE_COLUMNS.map((column) => column.header);
    for (const rule of rules) expect(headers).toContain(rule.header);
    expect(rules.find((rule) => rule.key === 'okved')?.kind).toBe('text');
  });

  test('пример строки шаблона проходит собственный разбор без замечаний', () => {
    const example = Object.fromEntries(
      SUPPLIER_TEMPLATE_COLUMNS.map((column) => [column.key, column.example]),
    );
    expect(parseExtraRowFields(cells(example)).issues).toEqual([]);
  });
});

describe('загрузка файла: числовые поля попадают в карточку', () => {
  test('значения разбираются, неверные строки - в отчёт с номером строки', async () => {
    const world = buildSupplierWorld();
    const row = (values: Record<string, string>): string[] =>
      SUPPLIER_TEMPLATE_COLUMNS.map((column) => values[column.key] ?? '');
    world.parser.tables = [
      [
        SUPPLIER_TEMPLATE_COLUMNS.map((column) => column.header),
        row({
          name: 'Числовая',
          inn: '7707083893',
          agencyDiscount: '5,5 %',
          vat: 'с НДС 22%',
          turnover: '1,5 млрд',
          okved: 'ОКВЭД 2: 4719 Торговля',
          packaging: 'подарочная упаковка',
        }),
        row({ name: 'Без НДС', inn: '500100732259', vat: 'УСН', turnover: '500 000 000 руб.' }),
        row({ name: 'Плохая', inn: '7736050003', vat: 'по договору', okved: '00.12',
          turnover: 'около 100 млн', agencyDiscount: 'до 5%', packaging: 'коробка' }),
      ],
    ];
    await importSuppliersFile(world.deps, {
      agentId: 'prices',
      threadId: THREAD_A,
      userId: USER_A,
      fileName: 'поставщики.xlsx',
      content: new Uint8Array([1]),
    });
    const shown = await lastShown(world.chat, THREAD_A);
    expect(shown.text).toContain('строка 4:');
    expect(shown.text).not.toContain('по договору');
    await world.service.press(pressOf(shown.token, USER_A, THREAD_A, 'save'));
    const [numeric] = await world.suppliers.searchCards({ query: 'Числовая', limit: 5 });
    expect(numeric).toMatchObject({
      agencyDiscountPercent: 5.5,
      vatMode: 'with_vat',
      vatRatePercent: 22,
      turnoverRub: 1_500_000_000,
      okved: '47.19',
      packaging: 'gift',
    });
    const [plain] = await world.suppliers.searchCards({ inn: '500100732259', limit: 5 });
    expect(plain?.vatMode).toBe('no_vat');
    expect(plain && 'vatRatePercent' in plain).toBe(false);
    expect(plain?.turnoverRub).toBe(500_000_000);
    // Этап 177: строка с непонятными значениями записывается, значения остаются пустыми.
    const [bad] = await world.suppliers.searchCards({ query: 'Плохая', limit: 5 });
    expect(bad?.vatMode).toBeUndefined();
    expect(bad?.turnoverRub).toBeUndefined();
  });
});

describe('поля карточки и показ', () => {
  test('схема: числа в границах, ставка и режим по отдельности', () => {
    for (const ok of [
      { vatRatePercent: 0 },
      { vatMode: 'no_vat' },
      { agencyDiscountPercent: 100 },
      { turnoverRub: 0 },
    ]) {
      expect(supplierCardFieldsSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of [
      { vatRatePercent: 100.1 },
      { vatMode: 'usn' },
      { agencyDiscountPercent: -0.1 },
      { turnoverRub: -1 },
    ]) {
      expect(supplierCardFieldsSchema.safeParse(bad).success).toBe(false);
    }
  });

  test('показ: НДС, скидка и оборот читаемо, без слипшихся цифр', () => {
    const card = { ...FULL_CARD, ...FULL_SECTION_10, turnoverRub: 1_500_000_000.5 };
    const shown = describeSupplierCard(card, 'Карточка');
    expect(shown).toContain('НДС: с НДС 20%');
    expect(shown).toContain('Скидка для агентства: 10%');
    expect(shown).toContain('Оборот: 1 500 000 000,50 руб.');
    const noVat = describeSupplierCard({ ...card, vatMode: 'no_vat' }, 'Карточка');
    expect(noVat).toContain('НДС: без НДС');
  });

  test('правка: смена на «без НДС» снимает прежнюю ставку, явный конфликт отклоняется', () => {
    const context = { userId: 'u1', nowIso: '2026-10-21T10:00:00.000Z', source: 'chat' as const };
    const full = { ...FULL_CARD, ...FULL_SECTION_10 };
    const next = applyFieldsToCard(full, { vatMode: 'no_vat' }, context);
    expect(next.vatMode).toBe('no_vat');
    expect('vatRatePercent' in next).toBe(false);
    const rate = applyFieldsToCard(next, { vatRatePercent: 10 }, context);
    expect(rate.vatRatePercent).toBe(10);
  });
});
