import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryAccessPolicy } from '@business-ai/adapters';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import { createPricesAgent } from '../../src/agents/prices/declaration';
import { createSupplierFromAttachment } from '../../src/agents/suppliers/attachment-create';
import { SUPPLIER_CARDS_PROMPT } from '../../src/agents/suppliers/prompt';
import { ACTION_CONFIRM_SUPPLIER_CARD } from '../../src/kit/domain/access.owned';
import {
  BOT_PRICES,
  INN_ALPHA,
  INN_BETA,
  SwitchableAccess,
  THREAD_A,
  USER_A,
  buildSupplierWorld,
  turnContext,
  type SupplierWorld,
} from './suppliers-support';

/**
 * Поставщика нет в базе и во вложении карточка предприятия: карточка заводится без вопросов;
 * несколько совпадений или нераспознанные реквизиты - уточнение; уже есть - без дубля.
 */

let world: SupplierWorld;
beforeEach(() => {
  world = buildSupplierWorld();
  const access = new MemoryAccessPolicy();
  access.allow({ userId: USER_A, botId: BOT_PRICES, action: ACTION_CONFIRM_SUPPLIER_CARD });
  world.deps.access = access;
});

const ctx = () => turnContext(USER_A, THREAD_A);
const count = async (): Promise<number> =>
  (await world.suppliers.searchCards({ limit: 10 })).length;

const CARD_TEXT = [
  'Карточка предприятия',
  'ООО «Бета Трейд»',
  `ИНН ${INN_BETA}`,
  'КПП 770701001',
  'Юридический адрес: г. Тестоград, ул. Условная, 1',
].join('\n');

describe('карточка поставщика из вложения', () => {
  test('нет в базе + вложение: карточка создана без вопросов, с реквизитами', async () => {
    const out = await createSupplierFromAttachment.execute(
      { sourceText: CARD_TEXT, kpp: '770701001', legalAddress: 'г. Тестоград, ул. Условная, 1' },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('created');
    // Вопрос сотруднику не показывался.
    expect(world.chat.outbox.length).toBe(0);
    const [card] = await world.suppliers.searchCards({ limit: 10 });
    expect(card?.name).toContain('Бета Трейд');
    expect(card?.inn).toBe(INN_BETA);
    expect(card?.kpp).toBe('770701001');
    expect(card?.legalAddress).toBe('г. Тестоград, ул. Условная, 1');
  });

  test('несколько совпадений: уточнение, ничего не создано', async () => {
    // Одно совпадение по ИНН, другое по названию: это разные карточки.
    await world.suppliers.saveCard(await mk('Бета Один', INN_BETA));
    await world.suppliers.saveCard(await mk('Бета Три', undefined));
    const out = await createSupplierFromAttachment.execute(
      { name: 'Бета Три', inn: INN_BETA, sourceText: 'Бета Три, ИНН ' + INN_BETA },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('multiple_matches');
    expect(out.matches.length).toBe(2);
    expect(await count()).toBe(2);
    expect(world.chat.outbox.length).toBe(0);
  });

  test('реквизиты не распознаны: уточнение, карточки нет', async () => {
    const out = await createSupplierFromAttachment.execute(
      { sourceText: 'Просим рассмотреть сотрудничество, подробности по телефону.' },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('not_recognized');
    expect(await count()).toBe(0);
  });

  test('поставщик уже есть в базе: дубль не создаётся', async () => {
    await world.suppliers.saveCard(await mk('Альфа Металл', INN_ALPHA));
    const out = await createSupplierFromAttachment.execute(
      { name: 'Альфа Металл', inn: INN_ALPHA, messageText: `Альфа Металл ${INN_ALPHA}` },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('exists');
    expect(await count()).toBe(1);
  });

  test('нет права записи: карточка не создаётся', async () => {
    world.deps.access = new MemoryAccessPolicy();
    const out = await createSupplierFromAttachment.execute(
      { name: 'Бета Трейд', inn: INN_BETA, messageText: `Бета Трейд ИНН ${INN_BETA}` },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('access_denied');
    expect(await count()).toBe(0);
  });
});

describe('сбой справочника руководителей (этап 234)', () => {
  test('временный сбой - ошибка, а не отказ; повтор после восстановления проходит', async () => {
    const right = new SwitchableAccess();
    world.deps.access = right;
    right.mode = 'down';
    const input = { name: 'Бета Трейд', inn: INN_BETA, messageText: `Бета Трейд ИНН ${INN_BETA}` };
    const failed = await createSupplierFromAttachment
      .execute(input, world.host, ctx())
      .catch((caught: unknown) => caught);
    expect(String((failed as Error).message)).toContain('временный сбой');
    expect(await count()).toBe(0);
    right.mode = 'allow';
    const out = await createSupplierFromAttachment.execute(input, world.host, ctx());
    expect(out.status).toBe('created');
    expect(await count()).toBe(1);
  });

  test('отказ руководителя остаётся ответом access_denied', async () => {
    const right = new SwitchableAccess();
    right.mode = 'deny';
    world.deps.access = right;
    const out = await createSupplierFromAttachment.execute(
      { name: 'Бета Трейд', inn: INN_BETA, messageText: `Бета Трейд ИНН ${INN_BETA}` },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('access_denied');
  });
});

describe('чтение вложения доступно агенту', () => {
  test('агент прайсов: инструмент заведения и чтение файла сотрудника', () => {
    const agent = createPricesAgent({ model: 'm', supplierCards: {} });
    const names = agent.tools.map((tool) => tool.name);
    expect(names).toContain('createSupplierFromAttachment');
    expect(names).toContain('readIntakeFile');
    expect(agent.prompt).toContain('createSupplierFromAttachment');
  });

  test('агент заявок с приёмом: чтение файлов чата и заведение карточки', () => {
    const agent = createOrderCalcAgent({
      model: 'm',
      intake: true,
      supplierCards: {},
    });
    const names = agent.tools.map((tool) => tool.name);
    expect(names).toContain('readChatAttachments');
    expect(names).toContain('createSupplierFromAttachment');
  });

  test('промпт: без вопросов при вложении и уточнение при неоднозначности', () => {
    expect(SUPPLIER_CARDS_PROMPT).toContain('НЕ задавайте вопросов');
    expect(SUPPLIER_CARDS_PROMPT).toContain('multiple_matches');
    expect(SUPPLIER_CARDS_PROMPT).toContain('not_recognized');
  });
});

async function mk(name: string, inn: string | undefined) {
  const { cardFromFields, newCardId } = await import('../../src/agents/suppliers/card-fields');
  const fields = { name, ...(inn === undefined ? {} : { inn }) };
  return cardFromFields(
    fields,
    { userId: USER_A, nowIso: '2026-05-04T09:00:00.000Z', source: 'chat' },
    newCardId(fields),
  );
}
