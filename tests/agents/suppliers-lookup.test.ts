import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryAccessPolicy } from '@business-ai/adapters';
import { lookupSupplierInBase } from '../../src/agents/suppliers/supplier-lookup';
import { recordSupplierLookupDecision } from '../../src/agents/suppliers/supplier-lookup-offer';
import { supplierLookupTools } from '../../src/agents/suppliers/tools';
import { ACTION_CONFIRM_SUPPLIER_CARD } from '../../src/kit/domain/access.owned';
import { type SupplierCard } from '../../src/kit/domain/supplier-card';
import {
  BOT_PRICES,
  INN_ALPHA,
  INN_BETA,
  SCHEDULER_CONTEXT,
  SwitchableAccess,
  THREAD_A,
  THREAD_B,
  USER_A,
  USER_B,
  buildSupplierWorld,
  turnContext,
  type SupplierWorld,
} from './suppliers-support';

/** Общий поиск поставщика по базе и предложение добавить (этап 182). Данные синтетические. */

const NAME = 'ООО «Тест Поставщик А»';
const NEW_NAME = 'Новый Поставщик Б';
const QUESTION = `Поставщика «${NEW_NAME}» нет в базе. Добавить в базу?`;

let world: SupplierWorld;
let logged: string[];

function card(id: string, name: string, extra: Partial<SupplierCard> = {}): SupplierCard {
  return {
    id,
    name,
    status: 'active',
    contacts: [],
    supplies: { categories: [], brands: [], regions: [] },
    terms: {},
    notes: [],
    ...extra,
  };
}

beforeEach(async () => {
  world = buildSupplierWorld();
  logged = [];
  world.deps.log = (event, fields) => logged.push(`${event} ${JSON.stringify(fields ?? {})}`);
  const access = new MemoryAccessPolicy();
  access.allow({ userId: USER_A, botId: BOT_PRICES, action: ACTION_CONFIRM_SUPPLIER_CARD });
  world.deps.access = access;
  await world.suppliers.saveCard(card('s1', NAME, { inn: INN_ALPHA }));
});

const ctx = () => turnContext(USER_A, THREAD_A);
const lookup = (input: { name?: string; inn?: string }, context = ctx()) =>
  lookupSupplierInBase.execute(input, world.host, context);
const decide = (
  input: Parameters<typeof recordSupplierLookupDecision.execute>[0],
  context = ctx(),
) => recordSupplierLookupDecision.execute(input, world.host, context);
const byName = (name: string) => world.suppliers.searchCards({ query: name, limit: 10 });

describe('lookupSupplierInBase: поиск', () => {
  test('найден по названию с другой формой и регистром', async () => {
    const out = await lookup({ name: 'тест поставщик а' });
    expect(out.status).toBe('found');
    expect(out.card?.id).toBe('s1');
    expect(out.card?.innLast4).toBe(INN_ALPHA.slice(-4));
  });

  test('найден по ИНН, полный ИНН в ответе не отдаётся', async () => {
    const out = await lookup({ inn: INN_ALPHA });
    expect(out.status).toBe('found');
    expect(out.card?.id).toBe('s1');
    expect(JSON.stringify(out)).not.toContain(INN_ALPHA);
  });

  test('несколько кандидатов', async () => {
    await world.suppliers.saveCard(card('s2', 'Тест Поставщик Альфа'));
    await world.suppliers.saveCard(card('s3', 'Тест Поставщик Бета'));
    const out = await lookup({ name: 'Тест Поставщик' });
    expect(out.status).toBe('several');
    expect(out.candidates?.length).toBeGreaterThan(1);
    expect(out.candidates?.length).toBeLessThanOrEqual(5);
  });

  test('inactive: карточка есть, сообщаем, не блокируем', async () => {
    await world.suppliers.saveCard(card('s4', 'Закрытый Завод', { status: 'inactive' }));
    const out = await lookup({ name: 'Закрытый Завод' });
    expect(out.status).toBe('inactive');
    expect(out.card?.id).toBe('s4');
  });

  test('карточка найдена без пометки черновика', async () => {
    await world.suppliers.saveCard(card('s5', 'Авто Опт', {}));
    const out = await lookup({ name: 'Авто Опт' });
    expect(out.status).toBe('found');
    expect(out.card).not.toHaveProperty('draft');
  });

  test('сбой базы и нет порта: unavailable, без исключения', async () => {
    world.suppliers.searchCards = async () => {
      throw new Error('db down');
    };
    world.suppliers.getCard = async () => {
      throw new Error('db down');
    };
    expect((await lookup({ name: NAME })).status).toBe('unavailable');
    const out = await lookupSupplierInBase.execute({ name: NAME }, {}, ctx());
    expect(out.status).toBe('unavailable');
  });

  test('без названия и ИНН - ошибка входа', async () => {
    await expect(lookup({})).rejects.toThrow();
  });
});

describe('lookupSupplierInBase: none и предложение', () => {
  test('none + готовый вопрос, карточка не создана', async () => {
    const out = await lookup({ name: NEW_NAME });
    expect(out.status).toBe('none');
    expect(out.offer).toBe('asked');
    expect(out.question).toBe(QUESTION);
    expect(await byName(NEW_NAME)).toHaveLength(0);
  });

  test('повторный none в треде тот же, вопрос не множится', async () => {
    const first = await lookup({ name: NEW_NAME });
    const second = await lookup({ name: `ООО "${NEW_NAME.toLowerCase()}"` });
    expect(second.status).toBe(first.status);
    expect(second.offer).toBe('asked');
    expect(logged.filter((line) => line.startsWith('supplier_lookup_offer'))).toHaveLength(1);
  });

  test('none по одному ИНН: предложения нет', async () => {
    const out = await lookup({ inn: INN_BETA });
    expect(out.status).toBe('none');
    expect(out.offer).toBeUndefined();
  });

  test('lookup не требует хода сотрудника (плановый запуск)', async () => {
    const out = await lookup({ name: NEW_NAME }, SCHEDULER_CONTEXT);
    expect(out.status).toBe('none');
  });
});

describe('recordSupplierLookupDecision', () => {
  test('create + право: карточка один раз, повтор не плодит', async () => {
    await lookup({ name: NEW_NAME });
    const out = await decide({ decision: 'create', phone: '+7 495 123-45-67' });
    expect(out.status).toBe('created');
    expect(out.card).not.toHaveProperty('draft');
    expect(await byName(NEW_NAME)).toHaveLength(1);
    const again = await decide({ decision: 'create', phone: '+7 495 123-45-67' });
    expect(again.status).toBe('already_created');
    expect(await byName(NEW_NAME)).toHaveLength(1);
  });

  test('карточка с таким названием уже есть: already_exists, дубля нет', async () => {
    await lookup({ name: NEW_NAME });
    await world.suppliers.saveCard(card('s9', NEW_NAME));
    const out = await decide({ decision: 'create' });
    expect(out.status).toBe('already_exists');
    expect(await byName(NEW_NAME)).toHaveLength(1);
  });

  test('decline: не создана, повторный lookup вопрос не задаёт', async () => {
    await lookup({ name: NEW_NAME });
    expect((await decide({ decision: 'decline' })).status).toBe('declined');
    expect(await byName(NEW_NAME)).toHaveLength(0);
    const out = await lookup({ name: NEW_NAME });
    expect(out.status).toBe('none');
    expect(out.offer).toBe('declined_before');
    expect(out.question).toBeUndefined();
    expect((await decide({ decision: 'create' })).status).toBe('not_asked');
  });

  test('unclear: не создана, один повтор вопроса, потом молчим', async () => {
    await lookup({ name: NEW_NAME });
    const first = await decide({ decision: 'unclear' });
    expect(first.repeatQuestion).toBe(true);
    expect(first.question).toBe(QUESTION);
    const second = await decide({ decision: 'unclear' });
    expect(second.repeatQuestion).toBe(false);
    expect(second.question).toBeUndefined();
    expect(await byName(NEW_NAME)).toHaveLength(0);
  });

  test('без права: no_permission, карточки нет', async () => {
    const context = turnContext(USER_B, THREAD_B);
    await lookup({ name: NEW_NAME }, context);
    const out = await decide({ decision: 'create' }, context);
    expect(out.status).toBe('no_permission');
    expect(await byName(NEW_NAME)).toHaveLength(0);
    world.deps.access = undefined;
    await lookup({ name: NEW_NAME });
    expect((await decide({ decision: 'create' })).status).toBe('no_permission');
  });

  test('сбой справочника: unavailable, не отказ; повтор после восстановления', async () => {
    const right = new SwitchableAccess();
    world.deps.access = right;
    await lookup({ name: NEW_NAME });
    right.mode = 'down';
    const out = await decide({ decision: 'create' });
    expect(out.status).toBe('unavailable');
    expect(await byName(NEW_NAME)).toHaveLength(0);
    right.mode = 'allow';
    expect((await decide({ decision: 'create' })).status).toBe('created');
    expect(await byName(NEW_NAME)).toHaveLength(1);
  });

  test('вопроса не было: not_asked', async () => {
    expect((await decide({ decision: 'create', name: NEW_NAME })).status).toBe('not_asked');
    expect(await byName(NEW_NAME)).toHaveLength(0);
  });

  test('вызов не в ходе сотрудника отклоняется', async () => {
    await lookup({ name: NEW_NAME });
    await expect(decide({ decision: 'create' }, SCHEDULER_CONTEXT)).rejects.toThrow();
    expect(await byName(NEW_NAME)).toHaveLength(0);
  });

  test('сбой записи: unavailable, не исключение', async () => {
    await lookup({ name: NEW_NAME });
    world.suppliers.saveCard = async () => {
      throw new Error('db down');
    };
    const out = await decide({ decision: 'create' });
    expect(out.status).toBe('unavailable');
  });
});

describe('журнал и набор', () => {
  test('в журнале нет названий и ИНН', async () => {
    await lookup({ name: NEW_NAME });
    await lookup({ name: NAME, inn: INN_ALPHA });
    await decide({ decision: 'create', inn: INN_BETA });
    world.suppliers.searchCards = async () => {
      throw new Error(`boom ${NEW_NAME} ${INN_BETA}`);
    };
    await lookup({ name: NEW_NAME });
    const text = logged.join('\n');
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of [NEW_NAME, 'Тест Поставщик', INN_ALPHA, INN_BETA]) {
      expect(text).not.toContain(secret);
    }
  });

  test('набор содержит оба инструмента', () => {
    expect(supplierLookupTools().map((tool) => tool.name)).toEqual([
      'lookupSupplierInBase',
      'recordSupplierLookupDecision',
    ]);
  });
});
