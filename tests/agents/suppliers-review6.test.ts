import { beforeEach, describe, expect, test } from 'bun:test';
import { SUPPLIER_CARD_REQUEST_NAMESPACE } from '../../src/agents/suppliers/deps';
import { SUPPLIER_TEMPLATE_COLUMNS } from '../../src/agents/suppliers/supplier-template';
import { addSupplierNote, prepareSupplierCard } from '../../src/agents/suppliers/supplier-tools';
import { cardRequestSchema } from '../../src/agents/suppliers/card-request';
import { importSuppliersFile } from '../../src/agents/suppliers/import-suppliers-file';
import { supplierCardOutcomeText } from '../../src/agents/suppliers/card-approval';
import { DAY_MS } from '../../src/kit/domain/time';
import {
  INN_ALPHA,
  INN_BETA,
  INN_GAMMA,
  THREAD_A,
  USER_A,
  USER_B,
  buildSupplierWorld,
  lastShown,
  pressOf,
  turnContext,
  type SupplierWorld,
} from './suppliers-support';

let world: SupplierWorld;
beforeEach(() => {
  world = buildSupplierWorld();
});

const ctxA = () => turnContext(USER_A, THREAD_A);
const HEADERS = SUPPLIER_TEMPLATE_COLUMNS.map((column) => column.header);
const BYTES = new Uint8Array([1, 2, 3]);

/** Строка таблицы по именам колонок шаблона (остальные пусты). */
function row(values: Record<string, string>): string[] {
  return SUPPLIER_TEMPLATE_COLUMNS.map((column) => values[column.key] ?? '');
}

async function importTable(table: string[][]) {
  world.parser.tables = [table];
  return importSuppliersFile(world.deps, {
    agentId: 'prices',
    threadId: THREAD_A,
    userId: USER_A,
    fileName: 'поставщики.xlsx',
    content: BYTES,
  });
}

/** Существующая карточка «Альфа Металл» с ИНН и адресом. */
async function seedAlpha(): Promise<void> {
  await world.suppliers.saveCard({
    id: 'sup-existing',
    name: 'Альфа Металл',
    inn: INN_ALPHA,
    status: 'active',
    contacts: [{ fullName: 'Пётр', email: 'x@alfa.example.ru', isPrimary: true }],
    supplies: { categories: [], brands: [], regions: [] },
    terms: {},
    notes: [],
  });
}

describe('R6-01-05 / R6-07-07: заметка не дублируется при повторе нажатия', () => {
  test('сбой закрытия запроса после записи заметки: повтор не добавляет вторую', async () => {
    await seedAlpha();
    await addSupplierNote.execute(
      { supplierId: 'sup-existing', text: 'Скидка при предоплате' },
      world.host,
      ctxA(),
    );
    const { token } = await lastShown(world.chat, THREAD_A);
    // Закрытие запроса (запись `done`) падает один раз, как при сбое хранилища состояния.
    const originalPut = world.state.put.bind(world.state);
    let failures = 0;
    world.state.put = async (namespace, key, value, options) => {
      if (namespace === SUPPLIER_CARD_REQUEST_NAMESPACE && options?.done === true && failures < 1) {
        failures += 1;
        throw new Error('сбой хранилища состояния');
      }
      return originalPut(namespace, key, value, options);
    };
    const first = await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    // Время идёт: повтор не должен получить другой «момент» заметки.
    world.clock.advance(DAY_MS);
    const second = await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    expect(first).toEqual({ kind: 'note_added' });
    expect(second.kind === 'note_added' || second.kind === 'already_done').toBe(true);
    const notes = (await world.suppliers.getCard('sup-existing'))?.notes ?? [];
    expect(notes.map((note) => note.text)).toEqual(['Скидка при предоплате']);
    expect(failures).toBe(1);
  });
});

describe('R6-09-05: соль идентификатора и пропавшая карточка под тестом', () => {
  test('«Создать новую» для карточек без ИНН с одним названием даёт две карточки', async () => {
    await prepareSupplierCard.execute({ name: 'Бета Снаб' }, world.host, ctxA());
    const first = (await lastShown(world.chat, THREAD_A)).token;
    expect(await world.service.press(pressOf(first, USER_A, THREAD_A, 'save'))).toEqual({
      kind: 'saved',
      mode: 'created',
    });
    await prepareSupplierCard.execute({ name: 'Бета Снаб' }, world.host, ctxA());
    const second = (await lastShown(world.chat, THREAD_A)).token;
    const outcome = await world.service.press(pressOf(second, USER_A, THREAD_A, 'create'));
    expect(outcome).toEqual({ kind: 'saved', mode: 'created' });
    const cards = await world.suppliers.searchCards({ query: 'Бета Снаб', limit: 10 });
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((card) => card.id)).size).toBe(2);
  });

  test('заметка к карточке, которой больше нет: target_missing, запрос закрыт', async () => {
    await seedAlpha();
    await addSupplierNote.execute(
      { supplierId: 'sup-existing', text: 'Позвонить во вторник' },
      world.host,
      ctxA(),
    );
    const { token } = await lastShown(world.chat, THREAD_A);
    world.suppliers.getCard = async () => null;
    const outcome = await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    expect(outcome).toEqual({ kind: 'target_missing' });
    const stored = cardRequestSchema.parse(
      await world.state.get(SUPPLIER_CARD_REQUEST_NAMESPACE, token),
    );
    expect(stored.status).toBe('blocked');
    expect(stored.noteText).toBeUndefined();
  });
});

describe('R6-02-07: пачка с обновлением дублей', () => {
  test('дубль правили между показом и нажатием: чужая правка не затирается', async () => {
    await seedAlpha();
    const fields = { name: 'Альфа', inn: INN_ALPHA, website: 'alfa.example.ru' };
    await importTable([HEADERS, row(fields)]);
    const { token } = await lastShown(world.chat, THREAD_A);
    // Пока пачка ждёт нажатия, другой сотрудник правит эту карточку.
    world.clock.advance(60_000);
    const current = await world.suppliers.getCard('sup-existing');
    if (current === null) throw new Error('карточки нет');
    await world.suppliers.saveCard({
      ...current,
      website: 'changed-by-colleague.example.ru',
      updatedAt: world.clock.now().toISOString(),
      updatedBy: USER_B,
    });
    world.clock.advance(60_000);
    const outcome = await world.service.press(pressOf(token, USER_A, THREAD_A, 'update'));
    expect(outcome).toMatchObject({
      kind: 'batch_done',
      updated: 0,
      failed: [{ row: 2, code: 'card_changed' }],
    });
    expect((await world.suppliers.getCard('sup-existing'))?.website).toBe(
      'changed-by-colleague.example.ru',
    );
  });

  test('две строки файла обновляют одну карточку: обе применяются', async () => {
    await seedAlpha();
    await importTable([
      HEADERS,
      row({ name: 'Альфа', inn: INN_ALPHA, website: 'alfa.example.ru' }),
      row({ name: 'Совсем другое', email: 'x@alfa.example.ru', phone: '+7 900 111-22-33' }),
    ]);
    const { token } = await lastShown(world.chat, THREAD_A);
    world.clock.advance(60_000);
    const outcome = await world.service.press(pressOf(token, USER_A, THREAD_A, 'update'));
    expect(outcome).toMatchObject({ kind: 'batch_done', updated: 2, failed: [] });
  });

  test('повтор после сбоя на второй строке той же карточки: без ложного card_changed', async () => {
    await seedAlpha();
    await importTable([
      HEADERS,
      row({ name: 'Альфа', inn: INN_ALPHA, website: 'alfa.example.ru' }),
      row({ name: 'Совсем другое', email: 'x@alfa.example.ru', phone: '+7 900 111-22-33' }),
    ]);
    const { token } = await lastShown(world.chat, THREAD_A);
    world.clock.advance(60_000);
    const original = world.suppliers.saveCard.bind(world.suppliers);
    let saves = 0;
    world.suppliers.saveCard = async (card, options) => {
      saves += 1;
      if (saves === 2) throw new Error('сбой хранилища');
      return original(card, options);
    };
    const first = await world.service.press(pressOf(token, USER_A, THREAD_A, 'update'));
    expect(first).toMatchObject({ kind: 'batch_done', updated: 1, failed: [{ row: 3 }] });
    world.clock.advance(60_000);
    // Повтор: карточку позже показа правила сама же пачка, это не чужая правка.
    const second = await world.service.press(pressOf(token, USER_A, THREAD_A, 'update'));
    expect(second).toMatchObject({ kind: 'batch_done', updated: 1, failed: [] });
  });

  test('сбой хранилища на строке: запрос остаётся открытым, повтор пишет только её', async () => {
    await importTable([
      HEADERS,
      row({ name: 'Альфа', inn: INN_ALPHA }),
      row({ name: 'Бета', inn: INN_BETA }),
      row({ name: 'Гамма', inn: INN_GAMMA }),
    ]);
    const { token } = await lastShown(world.chat, THREAD_A);
    const original = world.suppliers.saveCard.bind(world.suppliers);
    world.suppliers.saveCard = async (card, options) => {
      if (card.name === 'Гамма') throw new Error('сбой хранилища');
      return original(card, options);
    };
    const first = await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    expect(first).toMatchObject({ kind: 'batch_done', created: 2, failed: [{ row: 4 }] });
    expect(supplierCardOutcomeText(first)).toContain('подтвердите запись ещё раз');
    // Хранилище ожило: повторное нажатие дописывает только неудавшуюся строку.
    world.suppliers.saveCard = original;
    const second = await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    expect(second).toMatchObject({ kind: 'batch_done', created: 1, failed: [], skipped: [] });
    expect(await world.suppliers.searchCards({ limit: 10 })).toHaveLength(3);
    const third = await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    expect(third).toEqual({ kind: 'already_done' });
  });
});
