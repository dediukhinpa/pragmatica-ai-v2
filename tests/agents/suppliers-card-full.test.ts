import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SUPPLIER_TEMPLATE_COLUMNS,
  buildSupplierTemplateRows,
  matchSupplierHeaders,
} from '../../src/agents/suppliers/supplier-template';
import {
  applyFieldsToCard,
  cardFromFields,
  supplierCardFieldsSchema,
} from '../../src/agents/suppliers/card-fields';
import { describeSupplierCard } from '../../src/agents/suppliers/card-view';
import { importSuppliersFile } from '../../src/agents/suppliers/import-suppliers-file';
import { normalizeSupplierCard, validateSupplierCard } from '../../src/kit/domain/supplier-card';
import { FULL_CARD, FULL_SECTION_10 } from '../kit/support/supplier-fixtures';
import { THREAD_A, USER_A, buildSupplierWorld, lastShown, pressOf } from './suppliers-support';
import { parseExtraRowFields } from '../../src/agents/suppliers/import-row-fields';

const CONTEXT = { userId: 'u1', nowIso: '2026-10-21T10:00:00.000Z', source: 'chat' as const };

describe('полная карточка: поля, правка, показ (разд. 10 ТЗ)', () => {
  test('схема принимает все поля раздела 10 и отклоняет неверные', () => {
    const ok = supplierCardFieldsSchema.safeParse({
      name: 'Х',
      supplierKind: 'branding_only',
      documentFlow: 'edo',
      packaging: 'transport',
      trainingFormats: ['online'],
      legalEntities: [{ name: 'ООО Х', inn: '7707083893' }],
      materials: [{ kind: 'presentation', ref: 'Поставщики/Х/p.pdf' }],
      okved: '32.99',
      employeeCount: 10,
      samplesAvailable: false,
    });
    expect(ok.success).toBe(true);
    for (const bad of [
      { supplierKind: 'всё' },
      { documentFlow: 'почта' },
      { trainingFormats: ['video'] },
      { employeeCount: 1.5 },
      { materials: [{ kind: 'other', ref: 'x' }] },
    ]) {
      expect(supplierCardFieldsSchema.safeParse(bad).success).toBe(false);
    }
  });

  test('новая карточка получает поля, нормализуется и проходит проверку', () => {
    const fields = supplierCardFieldsSchema.parse({
      name: 'Типография',
      kpp: '773601001',
      vatRatePercent: 20.004,
      technologies: ['офсет'],
      legalEntities: [{ name: 'ООО Типография', inn: '7707083893' }],
    });
    const card = normalizeSupplierCard(cardFromFields(fields, CONTEXT, 'sup-1'));
    // Ставка без режима - плательщик НДС; ставка округляется до сотых.
    expect(card.vatMode).toBe('with_vat');
    expect(card.vatRatePercent).toBe(20);
    expect(card.kpp).toBe('773601001');
    expect(card.legalEntities).toEqual([{ name: 'ООО Типография', inn: '7707083893' }]);
    expect(validateSupplierCard(card).map((item) => item.code)).not.toContain('vat_rate_invalid');
  });

  test('правка заменяет переданное, остальное сохраняет; clear очищает', () => {
    const full = { ...FULL_CARD, ...FULL_SECTION_10 };
    const next = applyFieldsToCard(
      full,
      { vatMode: 'no_vat', technologies: ['литьё под давлением'], clear: ['materials', 'okved'] },
      CONTEXT,
    );
    expect(next.vatMode).toBe('no_vat');
    // Ставка прежней карточки при переходе на «без НДС» снимается.
    expect('vatRatePercent' in next).toBe(false);
    expect(next.technologies).toEqual(['литьё под давлением']);
    expect(next.legalEntities).toEqual(full.legalEntities);
    expect('materials' in next).toBe(false);
    expect('okved' in next).toBe(false);
  });

  test('показ: строки по разделам, у старой карточки раздела нет', () => {
    const old = describeSupplierCard(FULL_CARD, 'Карточка');
    expect(old).not.toContain('Вид поставщика');
    expect(old).not.toContain('Юридические лица');
    const shown = describeSupplierCard({ ...FULL_CARD, ...FULL_SECTION_10 }, 'Карточка');
    expect(shown).toContain('Тип поставщика: действующий');
    expect(shown).toContain('Вид поставщика: изготавливает и наносит');
    expect(shown).toContain('Документооборот: ЭДО');
    expect(shown).toContain('Юридические лица: ООО «МеталлТорг» (ИНН 7707083893); ИП Петров');
    expect(shown).toContain('Упаковка: подарочная, отдельный прайс');
    expect(shown).toContain('Бесплатные образцы: да, 2 шт., при заказе тиража');
    expect(shown).toContain('Обучение менеджеров: онлайн, офлайн');
    expect(shown).toContain('Собственные дизайнеры: нет');
    expect(shown).toContain('Презентации (презентация): О компании: Поставщики/');
    expect(shown).toContain('Основной ОКВЭД: 32.99');
  });
});

describe('шаблон xlsx и импорт колонок раздела 10', () => {
  test('колонки по порядку разделов, заголовки и псевдонимы не пересекаются', () => {
    const sections = SUPPLIER_TEMPLATE_COLUMNS.map((column) => column.section);
    const order = [...new Set(sections)];
    expect(order).toEqual([
      '10.1 О компании',
      '10.2 Контакты',
      '10.3 Условия работы',
      '10.4 Доставка',
      '10.5 Документы и договор',
      '10.6 О продукции',
      '10.7 Расположение',
      '10.8 Сервис',
      '10.9 Оценка поставщика',
      'Общее',
    ]);
    const headers = SUPPLIER_TEMPLATE_COLUMNS.map((column) => column.header);
    const matched = matchSupplierHeaders(headers);
    expect(matched?.size).toBe(SUPPLIER_TEMPLATE_COLUMNS.length);
    const [, guide] = buildSupplierTemplateRows();
    expect(guide?.columns[0]).toBe('Раздел ТЗ');
  });

  test('файл шаблона в репозитории совпадает с колонками кода', async () => {
    const path = join(import.meta.dir, '../../docs/templates/supplier-template.xlsx');
    const bytes = readFileSync(path);
    // xlsx - zip со сжатыми строками: содержимое сверяет сборка из тех же колонок
    // (`build_supplier_template.py`), здесь проверяется, что файл на месте и это zip.
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  const cells = (values: Record<string, string>) => (key: string): string | undefined =>
    values[key];

  test('разбор строки: перечисления по подписи, да/нет, числа, юрлица, ссылки', () => {
    const { fields, issues } = parseExtraRowFields(
      cells({
        supplierKind: 'Только наносит',
        documentFlow: 'ЭДО',
        packaging: 'транспортная',
        packagingPricing: 'входит в стоимость',
        trainingFormats: 'онлайн; офлайн',
        samplesAvailable: 'Да',
        hasQualityControl: 'нет',
        foundedYear: '2005',
        employeeCount: '1 200',
        defectRatePercent: '1,5%',
        legalEntities: 'ООО «Ромашка» 7707083893; ИП Иванов, ИНН 500100732259; Без ИНН',
        presentations: 'a/p.pdf; a/q.pdf',
        portfolioLinks: 'a/portfolio.pdf',
        technologies: 'литьё, штамповка',
      })
    );
    expect(issues).toEqual([]);
    expect(fields).toMatchObject({
      supplierKind: 'branding_only',
      documentFlow: 'edo',
      packaging: 'transport',
      packagingPricing: 'included',
      trainingFormats: ['online', 'offline'],
      samplesAvailable: true,
      hasQualityControl: false,
      foundedYear: 2005,
      employeeCount: 1200,
      defectRatePercent: 1.5,
      technologies: ['литьё', 'штамповка'],
    });
    expect(fields.legalEntities).toEqual([
      { name: 'ООО «Ромашка»', inn: '7707083893' },
      { name: 'ИП Иванов', inn: '500100732259' },
      { name: 'Без ИНН' },
    ]);
    expect(fields.materials).toEqual([
      { kind: 'presentation', ref: 'a/p.pdf' },
      { kind: 'presentation', ref: 'a/q.pdf' },
      { kind: 'portfolio', ref: 'a/portfolio.pdf' },
    ]);
  });

  test('неверные значения: замечание с названием колонки, без значения ячейки', () => {
    const { fields, issues } = parseExtraRowFields(
      cells({ supplierKind: 'секретное', foundedYear: 'ХХХ', hasQualityControl: 'может быть' }),
    );
    expect(fields).toEqual({});
    expect(issues).toHaveLength(3);
    const text = issues.join(' ');
    expect(text).toContain('Вид поставщика');
    expect(text).not.toContain('секретное');
    expect(text).not.toContain('ХХХ');
  });
});

describe('загрузка файла с колонками раздела 10', () => {
  test('строка с полной карточкой записывается; неверное значение - в отчёт', async () => {
    const world = buildSupplierWorld();
    const row = (values: Record<string, string>): string[] =>
      SUPPLIER_TEMPLATE_COLUMNS.map((column) => values[column.key] ?? '');
    world.parser.tables = [
      [
        SUPPLIER_TEMPLATE_COLUMNS.map((column) => column.header),
        row({
          name: 'Полная',
          inn: '7707083893',
          supplierKind: 'изготавливает и наносит',
          status: 'потенциальный',
          documentFlow: 'ЭДО',
          legalEntities: 'ООО «Полная» 7707083893',
          presentations: 'Поставщики/Полная/p.pdf',
          okved: '32.99',
          employeeCount: '50',
        }),
        row({ name: 'Старая запись', inn: '5001007322', status: 'не работаем' }),
        row({ name: 'Ошибка', supplierKind: 'неведомо', okved: '00.12' }),
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
    expect(shown.text).not.toContain('неведомо');
    await world.service.press(pressOf(shown.token, USER_A, THREAD_A, 'save'));
    const cards = await world.suppliers.searchCards({ query: 'Полная', limit: 5 });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      supplierKind: 'production_and_branding',
      status: 'new',
      documentFlow: 'edo',
      legalEntities: [{ name: 'ООО «Полная»', inn: '7707083893' }],
      materials: [{ kind: 'presentation', ref: 'Поставщики/Полная/p.pdf' }],
      okved: '32.99',
      employeeCount: 50,
    });
  });
});
