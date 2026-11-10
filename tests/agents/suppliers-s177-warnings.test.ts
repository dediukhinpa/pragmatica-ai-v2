import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryAccessPolicy } from '@business-ai/adapters';
import {
  addSupplierNote,
  prepareSupplierCard,
  prepareSupplierCardEdit,
} from '../../src/agents/suppliers/supplier-tools';
import { createSupplierFromAttachment } from '../../src/agents/suppliers/attachment-create';
import { importSuppliersFile } from '../../src/agents/suppliers/import-suppliers-file';
import { SUPPLIER_TEMPLATE_COLUMNS } from '../../src/agents/suppliers/supplier-template';
import { sanitizeSupplierCard } from '../../src/agents/suppliers/card-sanitize';
import { ACTION_CONFIRM_SUPPLIER_CARD } from '../../src/kit/domain/access.owned';
import {
  MAX_ASSESSMENT_LENGTH,
  MAX_CONTACTS,
  MAX_NOTE_LENGTH,
  validateSupplierCard,
  type SupplierCard,
} from '../../src/kit/domain/supplier-card';
import {
  BOT_PRICES,
  INN_ALPHA,
  INN_BROKEN,
  THREAD_A,
  USER_A,
  buildSupplierWorld,
  lastShown,
  pressOf,
  turnContext,
  type SupplierWorld,
} from './suppliers-support';

// Этап 177: данные карточек не отказ, а очистка значения и предупреждение.

const NOW = '2026-01-01T00:00:00.000Z';
const baseCard = (patch: Partial<SupplierCard> = {}): SupplierCard => ({
  id: 'sup-s177',
  name: 'Тестовый поставщик',
  status: 'active',
  contacts: [],
  supplies: { categories: [], brands: [], regions: [] },
  terms: {},
  notes: [],
  createdBy: 'u',
  createdAt: NOW,
  updatedBy: 'u',
  updatedAt: NOW,
  source: 'chat',
  ...patch,
});

let world: SupplierWorld;
beforeEach(() => {
  world = buildSupplierWorld();
  const access = new MemoryAccessPolicy();
  access.allow({ userId: USER_A, botId: BOT_PRICES, action: ACTION_CONFIRM_SUPPLIER_CARD });
  world.deps.access = access;
});
const ctx = () => turnContext(USER_A, THREAD_A);

describe('sanitizeSupplierCard', () => {
  test('неверные ИНН, сайт, телефон, почта очищаются, контакт и название остаются', () => {
    const { card, warnings } = sanitizeSupplierCard(
      baseCard({
        inn: INN_BROKEN,
        website: 'не сайт',
        contacts: [{ fullName: 'Иван', email: 'нет-собаки', phone: '12', isPrimary: true }],
      }),
    );
    expect(card.inn).toBeUndefined();
    expect(card.website).toBeUndefined();
    expect(card.contacts[0]).toMatchObject({ fullName: 'Иван' });
    expect(card.contacts[0]?.email).toBeUndefined();
    expect(card.contacts[0]?.phone).toBeUndefined();
    expect(warnings.length).toBeGreaterThanOrEqual(4);
    expect(validateSupplierCard(card)).toEqual([]);
    expect(JSON.stringify(warnings)).not.toContain(INN_BROKEN);
  });

  test('длины и число элементов обрезаются, брак вне диапазона и неверный КПП очищаются', () => {
    const contacts = Array.from({ length: MAX_CONTACTS + 2 }, (_, index) => ({
      fullName: `Контакт ${index}`,
      isPrimary: index === 0,
    }));
    const { card, warnings } = sanitizeSupplierCard(
      baseCard({
        strengths: 'с'.repeat(MAX_ASSESSMENT_LENGTH + 10),
        defectRatePercent: 150,
        kpp: 'abc',
        contacts,
        notes: [{ text: 'з'.repeat(MAX_NOTE_LENGTH + 5), authorId: 'u', createdAt: NOW }],
      }),
    );
    expect(card.strengths).toHaveLength(MAX_ASSESSMENT_LENGTH);
    expect(card.defectRatePercent).toBeUndefined();
    expect(card.kpp).toBeUndefined();
    expect(card.contacts).toHaveLength(MAX_CONTACTS);
    expect(card.notes[0]?.text).toHaveLength(MAX_NOTE_LENGTH);
    expect(validateSupplierCard(card)).toEqual([]);
    expect(warnings.length).toBeGreaterThanOrEqual(5);
  });

  test('без названия остаётся замечание (ключа записи нет)', () => {
    const { card } = sanitizeSupplierCard(baseCard({ name: '  ' }));
    expect(validateSupplierCard(card).map((issue) => issue.code)).toEqual(['name_required']);
  });
});

describe('инструменты карточек', () => {
  test('prepareSupplierCard: неверные телефон и сайт, показ и запись с warnings', async () => {
    const result = await prepareSupplierCard.execute(
      {
        name: 'Эта',
        website: 'не сайт',
        contacts: [{ fullName: 'Пётр', phone: '1', email: 'p@eta.example.ru', isPrimary: true }],
      },
      world.host,
      ctx(),
    );
    expect(result.status).toBe('shown');
    expect(result.warnings.join(' ')).toContain('Сайт');
    expect(result.warnings.join(' ')).toContain('телефон');
    const shown = await lastShown(world.chat, THREAD_A);
    const outcome = await world.service.press(pressOf(shown.token, USER_A, THREAD_A, 'save'));
    expect(outcome).toMatchObject({ kind: 'saved' });
    const [card] = await world.suppliers.searchCards({ query: 'Эта', limit: 5 });
    expect(card?.website).toBeUndefined();
    expect(card?.contacts[0]?.phone).toBeUndefined();
    expect(card?.contacts[0]?.email).toBe('p@eta.example.ru');
  });

  test('prepareSupplierCard: длинный текст, брак вне диапазона, много контактов', async () => {
    const contacts = Array.from({ length: MAX_CONTACTS + 3 }, (_, index) => ({
      fullName: `К${index}`,
    }));
    const result = await prepareSupplierCard.execute(
      {
        name: 'Длинная',
        strengths: 'с'.repeat(MAX_ASSESSMENT_LENGTH * 2),
        defectRatePercent: 500,
        contacts,
        sourceText: `Длинная ${'я'.repeat(9000)}`,
      },
      world.host,
      ctx(),
    );
    expect(result.status).toBe('shown');
    expect(result.warnings.join(' ')).toContain('8000');
    expect(result.warnings.join(' ')).toContain('Процент брака');
  });

  test('prepareSupplierCardEdit: неверное в правке очищается, правка показана', async () => {
    await world.suppliers.saveCard(baseCard());
    const result = await prepareSupplierCardEdit.execute(
      { supplierId: 'sup-s177', changes: { inn: INN_BROKEN, address: 'Город, улица' } },
      world.host,
      ctx(),
    );
    expect(result.status).toBe('shown');
    expect(result.warnings.join(' ')).toContain('ИНН');
  });

  test('addSupplierNote: длинная заметка обрезается с предупреждением', async () => {
    await world.suppliers.saveCard(baseCard());
    const result = await addSupplierNote.execute(
      { supplierId: 'sup-s177', text: 'з'.repeat(MAX_NOTE_LENGTH + 50) },
      world.host,
      ctx(),
    );
    expect(result.status).toBe('shown');
    expect(result.warnings.join(' ')).toContain('обрезана');
  });
});

describe('вложение без ИНН', () => {
  test('есть название, нет ИНН: создана, warning; нет названия: not_recognized', async () => {
    const created = await createSupplierFromAttachment.execute(
      { sourceText: 'ООО «Гамма Трейд» поставляет болты', name: 'ООО «Гамма Трейд»' },
      world.host,
      ctx(),
    );
    expect(created.status).toBe('created');
    expect(created.warnings.join(' ')).toContain('ИНН не найден');
    const none = await createSupplierFromAttachment.execute(
      { sourceText: 'просто текст без реквизитов' },
      world.host,
      ctx(),
    );
    expect(none.status).toBe('not_recognized');
  });

  test('sourceText длиннее 8000 знаков обрезается с предупреждением', async () => {
    const out = await createSupplierFromAttachment.execute(
      { name: 'Дельта Групп', sourceText: `Дельта Групп ${'я'.repeat(9000)}` },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('created');
    expect(out.warnings.join(' ')).toContain('обрезан');
  });
});

describe('файл поставщиков со строками-ошибками', () => {
  test('строка с плохим ИНН идёт в valid, ошибки в предупреждениях отчёта', async () => {
    const row = (values: Record<string, string>): string[] =>
      SUPPLIER_TEMPLATE_COLUMNS.map((column) => values[column.key] ?? '');
    world.parser.tables = [
      [
        SUPPLIER_TEMPLATE_COLUMNS.map((column) => column.header),
        row({ name: 'Хороший', inn: INN_ALPHA }),
        row({ name: 'Плохой ИНН', inn: INN_BROKEN, vat: 'по договору' }),
        row({ inn: INN_ALPHA }),
      ],
    ];
    const outcome = await importSuppliersFile(world.deps, {
      agentId: 'prices',
      threadId: THREAD_A,
      userId: USER_A,
      fileName: 'поставщики.xlsx',
      content: new Uint8Array([1]),
    });
    if (outcome.kind !== 'shown') throw new Error('ожидался отчёт');
    expect(outcome.report.valid.map((item) => item.row)).toEqual([2, 3]);
    expect(outcome.report.invalid.map((item) => item.row)).toEqual([4]);
    const shown = await lastShown(world.chat, THREAD_A);
    expect(shown.text).toContain('Предупреждения');
    expect(shown.text).toContain('строка 3');
    const result = await world.service.press(pressOf(shown.token, USER_A, THREAD_A, 'save'));
    expect(result).toMatchObject({ kind: 'batch_done', created: 2 });
  });
});
