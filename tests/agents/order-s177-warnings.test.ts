import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryPortalLinks, MemoryTaskReader } from '@business-ai/adapters';
import { MemoryCrm } from '../../src/kit/adapters/memory/crm.owned';
import {
  INTAKE_COMMENT_MAX_CHARS,
  INTAKE_HARD_MAX_ITEMS,
  INTAKE_PROMPT,
  normalizeIntake,
} from '../../src/agents/order-calc/intake';
import { ORDER_CALC_MAIL_PROMPT, ORDER_CALC_PROMPT } from '../../src/agents/order-calc/prompt';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { handoffToPrices, pricesHandoffInput } from '../../src/agents/order-calc/handoff-to-prices';
import { orderStatus } from '../../src/agents/order-calc/order-status';
import {
  quoteValidator,
  recordQuote,
  softValidUntil,
} from '../../src/agents/order-calc/record-quote';
import { recordManagerChoice } from '../../src/agents/order-calc/ask-manager-to-choose';
import { saveSelection } from '../../src/agents/order-calc/state';
import { saveIntakeRequest } from '../../src/agents/order-calc/save-intake-request';
import { storeReply } from '../../src/agents/order-calc/reply-store';
import type { PurchaseRequest } from '../../src/kit/domain/models';
import { CREATED_AT, CTX } from './support';
import { READER_CTX, REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

// Этап 177: в агенте «Поиск поставщика» сомнение в данных даёт результат и предупреждение,
// а не отказ. Данные синтетические.

const BOLT = { name: 'Болт М8', quantity: 10, unit: 'шт' };

describe('s177: приём позиций - предупреждения вместо отказа', () => {
  test('пустое название: позиция пропущена, остальные приняты, есть предупреждение', () => {
    const out = normalizeIntake([BOLT, { name: '  ', quantity: 1 }], 'merge');
    expect(out.items).toHaveLength(1);
    expect(out.warnings).toEqual([expect.stringContaining('позиция 2 без названия пропущена')]);
  });

  test('название длиннее 200 знаков обрезается с предупреждением', () => {
    const out = normalizeIntake([{ ...BOLT, name: 'Б'.repeat(300) }], 'merge');
    expect(out.items[0]?.name).toHaveLength(200);
    expect(out.warnings.join(' ')).toContain('позиция 1: название длиннее 200');
  });

  test('длинная единица -> «не указана», длинный артикул обрезан', () => {
    const out = normalizeIntake(
      [{ ...BOLT, unit: 'ящик '.repeat(10), sku: 'A'.repeat(150) }],
      'merge',
    );
    expect(out.items[0]?.unit).toBe('не указана');
    expect(out.items[0]?.sku).toHaveLength(100);
    expect(out.warnings).toHaveLength(2);
  });

  test('количество -5 и NaN: позиция без количества, не придуманное значение', () => {
    const out = normalizeIntake(
      [BOLT, { name: 'Гайка', quantity: -5, unit: 'шт' }, { name: 'Шайба', quantity: NaN }],
      'merge',
    );
    expect(out.items[1]?.quantity).toBeUndefined();
    expect(out.items[2]?.quantity).toBeUndefined();
    expect(out.warnings.filter((w) => w.includes('количество не принято'))).toHaveLength(2);
  });

  test('больше жёсткого предела: принимаются первые, остальное названо в предупреждении', () => {
    const many = Array.from({ length: INTAKE_HARD_MAX_ITEMS + 3 }, (_, i) => ({
      name: `Позиция ${i}`,
      unit: 'шт',
    }));
    const out = normalizeIntake(many, 'merge');
    expect(out.items).toHaveLength(INTAKE_HARD_MAX_ITEMS);
    expect(out.warnings[0]).toContain(`принято ${INTAKE_HARD_MAX_ITEMS} позиций из`);
  });
});

describe('s177: saveIntakeRequest', () => {
  let deps: OrderTestDeps & {
    crm: MemoryCrm;
    tasks: MemoryTaskReader;
    links: MemoryPortalLinks;
  };

  beforeEach(async () => {
    const base = await buildOrderDeps({ request: null });
    deps = {
      ...base,
      crm: new MemoryCrm(new Map()),
      tasks: new MemoryTaskReader(),
      links: new MemoryPortalLinks('portal.example.test'),
    };
  });

  const save = (input: unknown) => saveIntakeRequest.execute(input, deps, CTX);

  test('схема принимает комментарий и название любой длины (раньше max 1000 / 200)', () => {
    const parsed = saveIntakeRequest.inputSchema.safeParse({
      source: 'text',
      items: [BOLT],
      comment: 'я'.repeat(1_500),
      title: 'т'.repeat(500),
    });
    expect(parsed.success).toBe(true);
  });

  test('комментарий 1500 знаков: заявка сохранена без предупреждений об обрезке', async () => {
    const out = await save({ source: 'text', items: [BOLT], comment: 'я'.repeat(1_500) });
    expect(out.itemCount).toBe(1);
    expect(out.warnings).toBeUndefined();
  });

  test('комментарий сверх защитного предела: сохранено, есть предупреждение', async () => {
    const long = 'я'.repeat(INTAKE_COMMENT_MAX_CHARS + 10);
    const out = await save({ source: 'text', items: [BOLT], comment: long });
    expect(out.itemCount).toBe(1);
    expect(out.warnings?.join(' ')).toContain('текст менеджера длиннее');
  });

  test('длинное название и плохое количество: заявка сохранена с предупреждениями', async () => {
    const out = await save({
      source: 'text',
      items: [BOLT, { name: 'Ш'.repeat(300), quantity: -5 }],
    });
    expect(out.itemCount).toBe(2);
    expect(out.warnings).toHaveLength(2);
    const stored = await deps.requests.get(out.requestId);
    expect(stored?.items[1]?.name).toHaveLength(200);
    expect(stored?.items[1]?.quantity).toBeUndefined();
  });
});

describe('s177: recordQuote - запись с предупреждениями', () => {
  const REQUEST: PurchaseRequest = {
    id: REQUEST_ID,
    dealRef: 'D-1',
    items: [
      { name: 'Арматура', quantity: 100, unit: 'м' },
      { name: 'Болт М8', quantity: 10, unit: 'шт' },
      { name: 'Болт М10', quantity: 10, unit: 'шт' },
    ],
    createdAt: CREATED_AT,
  };
  let deps: OrderTestDeps;

  beforeEach(async () => {
    deps = await buildOrderDeps({ request: REQUEST });
    await saveSelection(deps, {
      requestId: REQUEST_ID,
      supplierIds: ['s1'],
      createdAt: CREATED_AT,
    });
    await storeReply(deps.state, REQUEST_ID, {
      id: 'out:r-s1',
      channel: 'email',
      supplierId: 's1',
      text: 'КП',
      receivedAt: CREATED_AT,
      attachments: [],
    });
  });

  const args = (overrides: Record<string, unknown> = {}) => ({
    requestId: REQUEST_ID,
    supplierId: 's1',
    sourceRef: 'out:r-s1',
    currency: 'RUB',
    lines: [{ productName: 'Арматура', unitPrice: 50, quantity: 100 }],
    ...overrides,
  });

  async function record(input: Record<string, unknown>) {
    expect(await quoteValidator.validate(input, deps, READER_CTX)).toEqual([]);
    return recordQuote.execute(input, deps, READER_CTX);
  }

  test('строка вне заявки: КП записано как дополнительная позиция + warning', async () => {
    const out = await record(
      args({
        lines: [
          { productName: 'Арматура', unitPrice: 50, quantity: 100 },
          { productName: 'Труба стальная', unitPrice: 70 },
        ],
      }),
    );
    expect(out.warnings?.join(' ')).toContain('«Труба стальная» нет в заявке');
    const saved = await deps.quotes.get(REQUEST_ID, 's1');
    expect(saved?.lines[1]?.isReplacement).toBe(true);
    expect(saved?.lines[0]?.isReplacement).toBeUndefined();
  });

  test('строка подходит двум позициям: записана без привязки + warning', async () => {
    const out = await record(args({ lines: [{ productName: 'Болт', unitPrice: 5 }] }));
    expect(out.warnings?.join(' ')).toContain('подходит нескольким позициям');
    const saved = await deps.quotes.get(REQUEST_ID, 's1');
    expect(saved?.lines[0]?.isReplacement).toBe(true);
  });

  test('позиция указана дважды: обе строки записаны + warning', async () => {
    const out = await record(
      args({
        lines: [
          { productName: 'Арматура', unitPrice: 50 },
          { productName: 'арматура', unitPrice: 55 },
        ],
      }),
    );
    expect(out.warnings?.join(' ')).toContain('указана в КП больше одного раза');
    expect((await deps.quotes.get(REQUEST_ID, 's1'))?.lines).toHaveLength(2);
  });

  test('нестандартная валюта XYZ: записано как есть + warning', async () => {
    const out = await record(args({ currency: 'xyz' }));
    expect(out.warnings?.join(' ')).toContain('валюта XYZ нестандартная');
    expect((await deps.quotes.get(REQUEST_ID, 's1'))?.currency).toBe('XYZ');
  });

  test('поставщик не из выбора по-прежнему блокируется (чужие данные)', async () => {
    await storeReply(deps.state, REQUEST_ID, {
      id: 'out:r-s9',
      channel: 'email',
      supplierId: 's9',
      text: 'КП',
      receivedAt: CREATED_AT,
      attachments: [],
    });
    const other = args({ supplierId: 's9', sourceRef: 'out:r-s9' });
    const issues = await quoteValidator.validate(other, deps, READER_CTX);
    expect(issues.map((issue) => issue.code)).toEqual(['supplier_not_in_selection']);
  });

  test('срок «01.02.2026» переводится в ISO, нечитаемый - пусто + warning', async () => {
    expect(softValidUntil('01.02.2026')).toEqual({ value: '2026-02-01' });
    expect(softValidUntil('2026-02-01T00:00:00+03:00').warning).toBeUndefined();
    expect(softValidUntil('на днях').value).toBeUndefined();
    const out = await record(args({ validUntil: 'на днях' }));
    expect(out.warnings?.join(' ')).toContain('срок действия КП не распознан');
    expect(out.gaps.map((gap) => gap.code)).toContain('no_validity');
    expect((await deps.quotes.get(REQUEST_ID, 's1'))?.validUntil).toBeUndefined();
  });
});

describe('s177: orderStatus без выбора', () => {
  test('вместо ошибки - статус «поставщики не выбраны»', async () => {
    const deps = await buildOrderDeps();
    const out = await orderStatus.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.suppliers).toEqual([]);
    const text = deps.chat.outbox.at(-1)?.message?.text ?? '';
    expect(text).toContain('Поставщики по заявке ещё не выбраны.');
  });
});

describe('s177: лимиты в схемах инструментов убраны', () => {
  test('handoffToPrices: 45 позиций, длинные и с переводом строки - схема пропускает', () => {
    const positions = Array.from({ length: 45 }, (_, i) => `Позиция ${i}\nвторая строка`);
    positions.push('П'.repeat(400));
    const parsed = handoffToPrices.inputSchema.safeParse({ requestId: 'req-1', positions });
    expect(parsed.success).toBe(true);
  });

  test('pricesHandoffInput: одна строка на позицию, обрезка и пометка «передано N из M»', () => {
    const positions = Array.from({ length: 205 }, (_, i) => `Поз ${i}\nвторая`);
    positions[0] = 'П'.repeat(400);
    const text = pricesHandoffInput({ requestId: 'req-1', positions });
    expect(text).toContain('Предупреждение: передано 200 позиций из 205');
    const lines = text.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(200);
    expect(lines[0]).toHaveLength(2 + 200);
    expect(lines[1]).toBe('- Поз 1 вторая');
  });

  test('recordManagerChoice: 25 пунктов выбора не отклоняются схемой', () => {
    const picks = Array.from({ length: 25 }, (_, i) => String(i + 1));
    const parsed = recordManagerChoice.inputSchema.safeParse({
      requestId: 'req-1',
      decision: 'picked',
      picks,
    });
    expect(parsed.success).toBe(true);
  });

  test('buildShortlist: название поставщика длиннее 200 знаков не отклоняется схемой', () => {
    const parsed = buildShortlist.inputSchema.safeParse({
      requestId: 'req-1',
      namedSuppliers: ['Ф'.repeat(300)],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('s177: промпты - без «дождись/попроси подтвердить/спроси», один список', () => {
  test('приём: сомнительное сохраняется, подтверждения до результата нет', () => {
    expect(INTAKE_PROMPT).not.toContain('дождись подтверждения');
    expect(INTAKE_PROMPT).not.toContain('попроси подтвердить текстом');
    expect(INTAKE_PROMPT).not.toContain('подтверди их у сотрудника');
    expect(INTAKE_PROMPT).toContain('вынеси сомнение в предупреждения');
  });

  test('КП: дату не переспрашивают, строка вне заявки не блокирует', () => {
    expect(ORDER_CALC_MAIL_PROMPT).not.toContain('уточни у менеджера');
    expect(ORDER_CALC_MAIL_PROMPT).not.toContain('принимается только с');
    expect(ORDER_CALC_MAIL_PROMPT).not.toContain('спроси менеджера,\n  есть ли у него контакт');
    expect(ORDER_CALC_MAIL_PROMPT).toContain('менеджера не переспрашивай');
  });

  test('оба варианта требуют результат и ОДИН короткий список предупреждений', () => {
    for (const prompt of [ORDER_CALC_PROMPT, ORDER_CALC_MAIL_PROMPT]) {
      expect(prompt).toContain('ОДИН короткий список предупреждений');
    }
  });
});
