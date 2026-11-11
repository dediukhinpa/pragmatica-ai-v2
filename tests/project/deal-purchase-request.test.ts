import { describe, expect, test } from 'bun:test';
import { MemoryCrm, createBitrix24PortalClient } from '@business-ai/adapters';
import type { Bitrix24PortalClient } from '@business-ai/adapters';
import { DomainError, isDomainError } from '@business-ai/core';
import type { z } from 'zod';
import { dealFieldMapSchema, parseLineItems } from '../../src/adapters/deal-field-map';
import { DealPurchaseRequestReader } from '../../src/adapters/deal-purchase-request';
import {
  DEAL_REQUESTS_PORTS_KEY,
  buildDealRequestPorts,
  dealRequestsOf,
} from '../../src/adapters/deal-request-ports';
import { PlatformBackedCrm } from '../../src/adapters/platform-crm';
import { pragmatikaConfigSchema } from '../../src/config';

/** Выдуманные данные: адрес и секрет вебхука не настоящие. */
const WEBHOOK = 'https://portal.test/rest/1/secret/';
const DEAL = 410;
const CREATED = '2026-10-12T10:00:00+03:00';
const CREATED_UTC = '2026-10-12T07:00:00.000Z';
const ITEMS_FIELD = 'UF_CRM_ITEMS';
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_SERVER_ERROR = 500;

/** Товарная строка заглушки портала. */
interface FakeRow {
  name: string;
  quantity: number | string;
  measureName?: string;
}

/** Сделка заглушки портала. */
interface FakeDeal {
  fields: Record<string, unknown>;
  rows: FakeRow[];
}

/** Заглушка портала в процессе: методы чтения сделки, без сети. */
class FakePortal {
  readonly deals = new Map<number, FakeDeal>();
  readonly calls: string[] = [];
  /** Сделки без прав у вебхука на объект. */
  readonly denied = new Set<number>();
  /** Вебхук без права на CRM. */
  scopeMissing = false;
  /** Все ответы - сбой сервера. */
  failing = false;

  addDeal(id: number, rows: FakeRow[], fields: Record<string, unknown> = {}): void {
    this.deals.set(id, { fields: { ID: String(id), DATE_CREATE: CREATED, ...fields }, rows });
  }

  fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const method = input.split('/').pop() ?? '';
    this.calls.push(method);
    const body = JSON.parse(String(init.body ?? '{}')) as { id?: number };
    const id = Number(body.id);
    if (this.failing) return Response.json({ error: 'INTERNAL' }, { status: HTTP_SERVER_ERROR });
    if (this.scopeMissing) {
      return Response.json({ error: 'insufficient_scope' }, { status: HTTP_FORBIDDEN });
    }
    if (this.denied.has(id)) {
      return Response.json(
        { error: 'ACCESS_DENIED', error_description: 'Access denied' },
        { status: HTTP_BAD_REQUEST },
      );
    }
    const deal = this.deals.get(id);
    if (deal === undefined) {
      return Response.json(
        { error: 'NOT_FOUND', error_description: 'Not found' },
        { status: HTTP_BAD_REQUEST },
      );
    }
    if (method === 'crm.deal.get') return Response.json({ result: deal.fields });
    const rows = deal.rows.map((row) => ({
      PRODUCT_NAME: row.name,
      QUANTITY: row.quantity,
      MEASURE_NAME: row.measureName ?? null,
    }));
    return Response.json({ result: rows });
  };

  client(): Bitrix24PortalClient {
    return createBitrix24PortalClient({
      webhookUrl: WEBHOOK,
      fetchFn: this.fetch,
      sleep: async () => undefined,
      random: () => 0.5,
      minRequestIntervalMs: 0,
      maxAttempts: 1,
    });
  }
}

function reader(
  portal: FakePortal,
  fieldMap?: z.input<typeof dealFieldMapSchema>,
): DealPurchaseRequestReader {
  return new DealPurchaseRequestReader({ portal: portal.client(), fieldMap });
}

async function failureOf(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!isDomainError(error)) throw new Error('ожидался DomainError');
  return error;
}

describe('карта полей', () => {
  test('по умолчанию: товарные строки', async () => {
    const portal = new FakePortal();
    portal.addDeal(DEAL, [
      { name: 'Болт М8х30', quantity: '100.0000', measureName: 'шт' },
      { name: 'Гайка М8', quantity: 250 },
    ]);
    expect(await reader(portal).getPurchaseRequest(String(DEAL))).toEqual({
      id: `bx24-deal-${DEAL}`,
      dealRef: String(DEAL),
      items: [
        { name: 'Болт М8х30', quantity: 100, unit: 'шт' },
        { name: 'Гайка М8', quantity: 250, unit: 'шт' },
      ],
      createdAt: CREATED_UTC,
    });
  });

  test('единица по умолчанию берётся из карты', async () => {
    const portal = new FakePortal();
    portal.addDeal(DEAL, [{ name: 'Песок', quantity: '3,5', measureName: '' }]);
    const request = await reader(portal, { defaultUnit: 'м3' }).getPurchaseRequest(String(DEAL));
    expect(request?.items).toEqual([{ name: 'Песок', quantity: 3.5, unit: 'м3' }]);
  });

  test('позиции из пользовательского поля построчно, товарные строки не читаются', async () => {
    const portal = new FakePortal();
    portal.addDeal(DEAL, [{ name: 'Товарная строка игнорируется', quantity: 1 }], {
      [ITEMS_FIELD]: 'Арматура А500; 10; т\r\nПроволока; 200; кг\n\nЦемент; 5',
    });
    const request = await reader(portal, {
      items: { source: 'field', field: ITEMS_FIELD, format: 'lines' },
    }).getPurchaseRequest(String(DEAL));
    expect(request?.items).toEqual([
      { name: 'Арматура А500', quantity: 10, unit: 'т' },
      { name: 'Проволока', quantity: 200, unit: 'кг' },
      { name: 'Цемент', quantity: 5, unit: 'шт' },
    ]);
    expect(portal.calls).not.toContain('crm.deal.productrows.get');
  });

  test('множественное поле приходит массивом строк', async () => {
    const portal = new FakePortal();
    portal.addDeal(DEAL, [], { [ITEMS_FIELD]: ['Болт; 10; шт', 'Гайка; 5'] });
    const request = await reader(portal, {
      items: { source: 'field', field: ITEMS_FIELD, format: 'lines' },
    }).getPurchaseRequest(String(DEAL));
    expect(request?.items.map((item) => item.name)).toEqual(['Болт', 'Гайка']);
  });

  test('срок ответа не передаётся: прежние ключи карты принимаются и игнорируются', async () => {
    const portal = new FakePortal();
    portal.addDeal(DEAL, [{ name: 'Болт', quantity: 1 }], {
      UF_CRM_DEADLINE: '2026-10-20T18:00:00+03:00',
    });
    const request = await reader(portal, {
      deadlineField: 'UF_CRM_DEADLINE',
      slaHours: 8,
    }).getPurchaseRequest(String(DEAL));
    expect(Object.keys(request ?? {}).sort()).toEqual(['createdAt', 'dealRef', 'id', 'items']);
    expect(JSON.stringify(request)).not.toContain('2026-10-20');
  });

  test('карта валидируется: чужое поле, не UF_CRM, лишние ключи', () => {
    expect(dealFieldMapSchema.parse({}).items).toEqual({ source: 'productRows' });
    for (const bad of [
      { items: { source: 'field', field: 'TITLE', format: 'lines' } },
      { items: { source: 'field', field: 'UF_CRM_x', format: 'lines' } },
      { items: { source: 'field', field: 'UF_CRM_A', format: 'json' } },
      { deadlineField: 'CLOSEDATE' },
      { slaHours: 0 },
      { unknown: 1 },
    ]) {
      expect(dealFieldMapSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('нераспознанные строки: отказ, а не частичная заявка', () => {
  test('товарные строки: брак - validation_failed с номерами строк, без текстов', async () => {
    const portal = new FakePortal();
    portal.addDeal(DEAL, [
      { name: 'Хорошая', quantity: '2.0000', measureName: 'шт' },
      { name: 'СекретныйНуль', quantity: '0.0000' },
      { name: 'СекретнаяОтрицательная', quantity: -3 },
      { name: 'СекретноеНечисло', quantity: 'много' },
      { name: 'СекретнаяЭкспонента', quantity: '1e3' },
      { name: '   ', quantity: 1 },
    ]);
    const error = await failureOf(reader(portal).getPurchaseRequest(String(DEAL)));
    expect(error.code).toBe('validation_failed');
    expect(error.message).toContain('5 строк не распознаны (строки: 2, 3, 4, 5, 6)');
    expect(error.message).toContain('пришлите заявку текстом');
    expect(error.message).not.toContain('Секрет');
  });

  test('ни одной годной позиции: тоже отказ с номерами, а не null', async () => {
    const portal = new FakePortal();
    portal.addDeal(DEAL, [{ name: 'Брак', quantity: 0 }]);
    const error = await failureOf(reader(portal).getPurchaseRequest(String(DEAL)));
    expect(error.code).toBe('validation_failed');
    expect(error.message).toContain('(строки: 1)');
  });

  test('сделка без товарных строк: null', async () => {
    const portal = new FakePortal();
    portal.addDeal(DEAL, []);
    expect(await reader(portal).getPurchaseRequest(String(DEAL))).toBeNull();
  });

  test('длинный перечень номеров обрезается', async () => {
    const portal = new FakePortal();
    portal.addDeal(
      DEAL,
      Array.from({ length: 30 }, (_, index) => ({ name: `Б${index}`, quantity: 0 })),
    );
    const error = await failureOf(reader(portal).getPurchaseRequest(String(DEAL)));
    expect(error.message).toContain('30 строк не распознаны');
    expect(error.message).toContain('и ещё 10');
  });

  test('поле построчно: номера строк поля, пустые строки входят в нумерацию', async () => {
    const portal = new FakePortal();
    portal.addDeal(DEAL, [], {
      [ITEMS_FIELD]: [
        'Болт; 10; шт',
        'без количества',
        'Гайка; много; шт',
        '',
        ';5;шт',
        'Шайба; 4',
      ].join('\n'),
    });
    const error = await failureOf(
      reader(portal, {
        items: { source: 'field', field: ITEMS_FIELD, format: 'lines' },
      }).getPurchaseRequest(String(DEAL)),
    );
    expect(error.code).toBe('validation_failed');
    expect(error.message).toContain('3 строк не распознаны (строки: 2, 3, 5)');
    expect(error.message).not.toContain('Гайка');
  });

  test('parseLineItems: лишние части и пустые строки', () => {
    expect(parseLineItems('a; 1; шт; лишнее\n\n  \nb; 2', 'шт')).toEqual({
      items: [{ name: 'b', quantity: 2, unit: 'шт' }],
      dropped: 1,
    });
  });

  test('поле позиций не заполнено: null', async () => {
    const portal = new FakePortal();
    portal.addDeal(DEAL, []);
    const request = await reader(portal, {
      items: { source: 'field', field: ITEMS_FIELD, format: 'lines' },
    }).getPurchaseRequest(String(DEAL));
    expect(request).toBeNull();
  });
});

describe('getPurchaseRequest: границы', () => {
  test('нечисловая ссылка: null без запросов к порталу', async () => {
    const portal = new FakePortal();
    for (const bad of ['deal-1', '', '12a', '-5', '1.0', 'text-abc']) {
      expect(await reader(portal).getPurchaseRequest(bad)).toBeNull();
    }
    expect(portal.calls).toHaveLength(0);
  });

  test('нет сделки: null', async () => {
    expect(await reader(new FakePortal()).getPurchaseRequest('99999')).toBeNull();
  });

  test('нет прав на объект: null, существование не раскрывается', async () => {
    const portal = new FakePortal();
    portal.addDeal(DEAL, [{ name: 'Болт', quantity: 1 }]);
    portal.denied.add(DEAL);
    expect(await reader(portal).getPurchaseRequest(String(DEAL))).toBeNull();
  });

  test('у вебхука нет права на CRM: отказ доступа, не повторяемый', async () => {
    const portal = new FakePortal();
    portal.addDeal(DEAL, [{ name: 'Болт', quantity: 1 }]);
    portal.scopeMissing = true;
    const error = await failureOf(reader(portal).getPurchaseRequest(String(DEAL)));
    expect(error.name).toBe('ExternalAccessDeniedError');
    expect(error.retryable).toBe(false);
  });

  test('сбой портала: external_failure, повторяемый', async () => {
    const portal = new FakePortal();
    portal.addDeal(DEAL, [{ name: 'Болт', quantity: 1 }]);
    portal.failing = true;
    const error = await failureOf(reader(portal).getPurchaseRequest(String(DEAL)));
    expect(error.code).toBe('external_failure');
    expect(error.retryable).toBe(true);
  });

  test('нет даты создания или она нечитаема: ошибка, а не «сейчас»', async () => {
    const portal = new FakePortal();
    portal.addDeal(DEAL, [{ name: 'Болт', quantity: 1 }], { DATE_CREATE: undefined });
    expect((await failureOf(reader(portal).getPurchaseRequest(String(DEAL)))).code).toBe(
      'external_failure',
    );
    portal.addDeal(DEAL + 1, [{ name: 'Болт', quantity: 1 }], { DATE_CREATE: '12.10.2026' });
    expect((await failureOf(reader(portal).getPurchaseRequest(String(DEAL + 1)))).code).toBe(
      'external_failure',
    );
  });

  test('id заявки детерминирован, ссылка канонизируется', async () => {
    const portal = new FakePortal();
    portal.addDeal(DEAL, [{ name: 'Болт', quantity: 1 }]);
    const first = await reader(portal).getPurchaseRequest(String(DEAL));
    const again = await reader(portal).getPurchaseRequest(`00${DEAL}`);
    expect(again).toEqual(first);
    expect(first?.id).toBe(`bx24-deal-${DEAL}`);
  });

  test('чтение не пишет на портал: только методы чтения', async () => {
    const portal = new FakePortal();
    portal.addDeal(DEAL, [{ name: 'Болт', quantity: 1 }]);
    await reader(portal).getPurchaseRequest(String(DEAL));
    expect([...portal.calls].sort()).toEqual(['crm.deal.get', 'crm.deal.productrows.get']);
  });
});

describe('CRM проекта и подключение', () => {
  test('PlatformBackedCrm отдаёт заявку по сделке через читателя', async () => {
    const portal = new FakePortal();
    portal.addDeal(DEAL, [{ name: 'Болт', quantity: 3, measureName: 'шт' }]);
    const crm = new PlatformBackedCrm(new MemoryCrm(), reader(portal));
    const request = await crm.getPurchaseRequest(String(DEAL));
    expect(request?.items).toEqual([{ name: 'Болт', quantity: 3, unit: 'шт' }]);
  });

  test('без читателя (портал не настроен) заявка по сделке не находится', async () => {
    const crm = new PlatformBackedCrm(new MemoryCrm());
    expect(await crm.getPurchaseRequest(String(DEAL))).toBeNull();
  });

  test('ports.extra: читатель строится из портала и карты, без портала его нет', async () => {
    const portal = new FakePortal();
    portal.addDeal(DEAL, [], { [ITEMS_FIELD]: 'Болт; 4; шт' });
    const config = {
      project: {
        BITRIX24_DEAL_FIELD_MAP: dealFieldMapSchema.parse({
          items: { source: 'field', field: ITEMS_FIELD, format: 'lines' },
        }),
      },
    };
    const extra = buildDealRequestPorts({ portal: { portal: portal.client() }, config });
    expect(Object.keys(extra)).toEqual([DEAL_REQUESTS_PORTS_KEY]);
    const found = dealRequestsOf(extra);
    expect((await found?.getPurchaseRequest(String(DEAL)))?.items).toEqual([
      { name: 'Болт', quantity: 4, unit: 'шт' },
    ]);
    expect(buildDealRequestPorts({ portal: undefined, config })).toEqual({});
    expect(dealRequestsOf({})).toBeUndefined();
    expect(dealRequestsOf(undefined)).toBeUndefined();
  });
});

describe('BITRIX24_DEAL_FIELD_MAP в конфигурации', () => {
  const base = {
    PRICES_FILES_ROOT: '/files/prices',
    TEMPLATES_FILES_ROOT: '/files/templates',
    OWN_COMPANY_NAMES: 'Тестовая компания',
  };
  const CANARY = 'CANARY_VALUE_9f3a';

  test('не задана или пустая: карты нет', () => {
    expect(pragmatikaConfigSchema.parse(base).BITRIX24_DEAL_FIELD_MAP).toBeUndefined();
    const empty = pragmatikaConfigSchema.parse({ ...base, BITRIX24_DEAL_FIELD_MAP: '' });
    expect(empty.BITRIX24_DEAL_FIELD_MAP).toBeUndefined();
  });

  test('валидная карта разбирается строгой схемой', () => {
    const map = {
      items: { source: 'field', field: 'UF_CRM_ITEMS', format: 'lines' },
      deadlineField: 'UF_CRM_DEADLINE',
      slaHours: 8,
    } as const;
    const config = pragmatikaConfigSchema.parse({
      ...base,
      BITRIX24_DEAL_FIELD_MAP: JSON.stringify(map),
    });
    expect(config.BITRIX24_DEAL_FIELD_MAP).toEqual(map);
  });

  test('мусор отклоняется, значение в сообщение не попадает', () => {
    const broken = [
      `не json ${CANARY}`,
      '[]',
      `{"unknown":"${CANARY}"}`,
      `{"items":{"source":"field","field":"${CANARY}","format":"lines"}}`,
      '{"items":{"source":"field","field":"UF_CRM_X","format":"csv"}}',
      '{"slaHours":0}',
      '{"slaHours":"8"}',
    ];
    for (const value of broken) {
      const result = pragmatikaConfigSchema.safeParse({
        ...base,
        BITRIX24_DEAL_FIELD_MAP: value,
      });
      expect(result.success).toBe(false);
      const paths = result.success ? [] : result.error.issues.map((issue) => issue.path[0]);
      expect(paths).toContain('BITRIX24_DEAL_FIELD_MAP');
    }
  });
});
