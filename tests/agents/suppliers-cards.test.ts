import { beforeEach, describe, expect, test } from 'bun:test';
import {
  SUPPLIER_BATCH_NAMESPACE,
  SUPPLIER_CARD_REQUEST_NAMESPACE,
  SUPPLIER_CARD_REQUEST_TTL_MS,
} from '../../src/agents/suppliers/deps';
import {
  addSupplierNote,
  findSupplierCard,
  prepareSupplierCard,
  prepareSupplierCardEdit,
} from '../../src/agents/suppliers/supplier-tools';
import {
  cardRequestSchema,
  parseSupplierCardButton,
} from '../../src/agents/suppliers/card-request';
import { findDigitSeries } from '@business-ai/core';
import {
  supplierCardOutcomeText,
  type SupplierCardButtons,
  type SupplierCardCancel,
  type SupplierCardRef,
} from '../../src/agents/suppliers/card-approval';
import { supplierCardsTools } from '../../src/agents/suppliers/tools';
import { WORKFLOW_STATE_STALE_SCOPE } from '../../src/kit/app/workflow-state-retention';
import { ACTION_CONFIRM_SUPPLIER_CARD } from '../../src/kit/domain/access.owned';
import {
  INN_ALPHA,
  INN_BROKEN,
  INN_GAMMA,
  SCHEDULER_CONTEXT,
  THREAD_A,
  THREAD_B,
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

/** Подготовить карточку «Альфа» от сотрудника A и вернуть токен показанного запроса. */
async function showAlpha(extra: Record<string, unknown> = {}): Promise<string> {
  const result = await prepareSupplierCard.execute(
    {
      name: 'Альфа Металл',
      inn: INN_ALPHA,
      contacts: [
        { fullName: 'Пётр Сидоров', email: 'Sales@Alfa.example.ru', phone: '8 900 123-45-67' },
      ],
      categories: ['Метизы'],
      ...extra,
    },
    world.host,
    ctxA(),
  );
  expect(result).toMatchObject({ status: 'shown' });
  return (await lastShown(world.chat, THREAD_A)).token;
}

describe('запись только после кнопки', () => {
  test('до нажатия карточки в базе нет; показ строит код и содержит ИНН', async () => {
    await showAlpha();
    expect(await world.suppliers.searchCards({ limit: 10 })).toHaveLength(0);
    const shown = await lastShown(world.chat, THREAD_A);
    expect(shown.text).toContain('как будет сохранена');
    expect(shown.text).toContain('Альфа Металл');
    expect(shown.text).toContain(INN_ALPHA);
    expect(shown.actions).toEqual(['save', 'cancel']);
    expect(shown.text).toContain('«да, сохраняй»');
    expect(shown.text).toContain('«отмена»');
    expect(world.chat.outbox.every((item) => item.message?.buttons === undefined)).toBe(true);
    expect(shown.ids.map((id) => parseSupplierCardButton(id)?.action)).toEqual([
      'save',
      'cancel',
    ]);
  });

  test('запись только через confirmSupplierRequest: «подготовить» карточку не пишет', async () => {
    const names = supplierCardsTools().map((tool) => tool.name);
    expect(names).toEqual([
      'findSupplierCard',
      'prepareSupplierCard',
      // Единственная запись без показа: только по вложению и когда поставщика нет в базе.
      'createSupplierFromAttachment',
      // Вторая запись без показа (этап 218): только пустые поля существующей карточки.
      'enrichSupplierCard',
      'prepareSupplierCardEdit',
      'addSupplierNote',
      'confirmSupplierRequest',
      'rememberForMe',
      'whatDoYouRemember',
      'forgetMyNote',
    ]);
    // Все «подготовить» вызваны - в базе по-прежнему пусто.
    await showAlpha();
    expect(await world.suppliers.searchCards({ limit: 10 })).toHaveLength(0);
  });

  test('«Сохранить» записывает карточку: автор и источник из нажатия и запроса', async () => {
    const token = await showAlpha({ source: 'email' });
    const outcome = await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    expect(outcome).toEqual({ kind: 'saved', mode: 'created' });
    const [card] = await world.suppliers.searchCards({ inn: INN_ALPHA, limit: 10 });
    expect(card?.name).toBe('Альфа Металл');
    expect(card?.createdBy).toBe(USER_A);
    expect(card?.updatedBy).toBe(USER_A);
    expect(card?.source).toBe('email');
    expect(card?.contacts[0]?.email).toBe('sales@alfa.example.ru');
    expect(card?.contacts[0]?.phone).toBe('+79001234567');
    expect(supplierCardOutcomeText(outcome)).toContain('сохранена');
  });

  test('повторное нажатие ничего не пишет; запрос закрыт, данные стёрты', async () => {
    const token = await showAlpha();
    await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    const again = await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    expect(again).toEqual({ kind: 'already_done' });
    expect(await world.suppliers.searchCards({ limit: 10 })).toHaveLength(1);
    const stored = cardRequestSchema.parse(
      await world.state.get(SUPPLIER_CARD_REQUEST_NAMESPACE, token),
    );
    expect(stored.status).toBe('saved');
    expect(stored.fields).toBeUndefined();
    expect(stored.closedAt).toBeDefined();
  });

  test('кнопка из чужого треда и от чужого сотрудника не действует', async () => {
    const token = await showAlpha();
    const foreignThread = await world.service.press(pressOf(token, USER_A, THREAD_B, 'save'));
    const foreignUser = await world.service.press(pressOf(token, USER_B, THREAD_A, 'save'));
    const noIdentity = await world.service.press(pressOf(token, ' ', THREAD_A, 'save'));
    expect(foreignThread).toEqual({ kind: 'wrong_thread' });
    expect(foreignUser).toEqual({ kind: 'wrong_owner' });
    expect(noIdentity).toEqual({ kind: 'no_identity' });
    expect(await world.suppliers.searchCards({ limit: 10 })).toHaveLength(0);
    // Запрос остался открытым: свой сотрудник по-прежнему может сохранить.
    const ok = await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    expect(ok.kind).toBe('saved');
  });

  test('просроченный запрос закрывается без записи', async () => {
    const token = await showAlpha();
    world.clock.advance(SUPPLIER_CARD_REQUEST_TTL_MS + 1);
    const outcome = await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    expect(outcome).toEqual({ kind: 'expired' });
    expect(await world.suppliers.searchCards({ limit: 10 })).toHaveLength(0);
    expect(await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'))).toEqual({
      kind: 'already_done',
    });
  });

  test('неизвестный токен и «Отмена»', async () => {
    expect(await world.service.press(pressOf('нет', USER_A, THREAD_A, 'save'))).toEqual({
      kind: 'unknown_request',
    });
    const token = await showAlpha();
    const press: SupplierCardCancel = { token, userId: USER_A, threadId: THREAD_A };
    const cancelled = await world.service.cancel(press);
    expect(cancelled).toEqual({ kind: 'cancelled' });
    expect(await world.suppliers.searchCards({ limit: 10 })).toHaveLength(0);
    const late = await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    expect(late).toEqual({ kind: 'already_done' });
  });

  test('lookup отдаёт агента-владельца и тип запроса для маршрутизации', async () => {
    const token = await showAlpha();
    const buttons: SupplierCardButtons = world.service;
    const expected: SupplierCardRef = {
      token,
      kind: 'card',
      agentId: 'prices',
      ownerUserId: USER_A,
      threadId: THREAD_A,
    };
    expect(await buttons.lookup(token)).toEqual(expected);
    expect(await buttons.lookup('нет')).toBeNull();
  });

  test('«Изменить» закрывает запрос и просит написать правку', async () => {
    const token = await showAlpha();
    const outcome = await world.service.press(pressOf(token, USER_A, THREAD_A, 'edit'));
    expect(outcome).toEqual({ kind: 'edit_requested' });
    expect(await world.suppliers.searchCards({ limit: 10 })).toHaveLength(0);
  });

  test('плановый запуск карточку подготовить не может', async () => {
    const attempt = prepareSupplierCard.execute({ name: 'Х' }, world.host, SCHEDULER_CONTEXT);
    await expect(attempt).rejects.toMatchObject({ code: 'access_denied' });
    expect(world.chat.outbox).toHaveLength(0);
  });

  test('этап 177: карточка с неверным ИНН показывается, ИНН очищен, есть warnings', async () => {
    const result = await prepareSupplierCard.execute(
      { name: 'Бета', inn: INN_BROKEN },
      world.host,
      ctxA(),
    );
    expect(result.status).toBe('shown');
    expect(result.warnings.join(' ')).toContain('ИНН');
    expect(JSON.stringify(result)).not.toContain(INN_BROKEN);
    expect(world.chat.outbox).toHaveLength(1);
    expect(JSON.stringify(world.chat.outbox)).not.toContain(INN_BROKEN);
    // «Да, сохраняй»: репозиторий не получает неверный ИНН, запись проходит с предупреждением.
    const saved = await world.service.press(
      pressOf(result.requestId ?? '', USER_A, THREAD_A, 'save'),
    );
    expect(saved).toMatchObject({ kind: 'saved', mode: 'created' });
    const [card] = await world.suppliers.searchCards({ query: 'Бета', limit: 5 });
    expect(card?.inn).toBeUndefined();
  });

  test('этап 177: без названия карточка по-прежнему не показывается', async () => {
    const result = await prepareSupplierCard.execute({ inn: INN_ALPHA }, world.host, ctxA());
    expect(result.status).toBe('invalid');
    expect(world.chat.outbox).toHaveLength(0);
  });

  test('аудит: токен и коды, без названий, ИНН и адресов', async () => {
    const token = await showAlpha();
    await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    const entries = await world.audit.list();
    expect(entries.map((entry) => entry.action)).toEqual(['suppliers.card_save']);
    const text = JSON.stringify(entries);
    expect(text).toContain(token);
    for (const secret of ['Альфа', INN_ALPHA, 'alfa.example.ru', 'Сидоров']) {
      expect(text).not.toContain(secret);
    }
  });

  test('ретенция: пространства запросов в списке очистки, закрытый запрос стирается', async () => {
    expect(WORKFLOW_STATE_STALE_SCOPE.namespaces).toContain(SUPPLIER_CARD_REQUEST_NAMESPACE);
    expect(WORKFLOW_STATE_STALE_SCOPE.namespaces).toContain(SUPPLIER_BATCH_NAMESPACE);
    const token = await showAlpha();
    await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    const border = new Date(world.clock.now().getTime() + 1);
    // Закрытая запись помечена done: общая очистка завершённых её удаляет вместе с данными.
    expect(await world.state.purgeOlderThan(border)).toBe(1);
    expect(await world.state.get(SUPPLIER_CARD_REQUEST_NAMESPACE, token)).toBeNull();
  });

  test('право на запись карточки - отдельное действие доступа', () => {
    expect(ACTION_CONFIRM_SUPPLIER_CARD).toBe('suppliers.confirm_card');
  });
});

describe('дубли и выбор «обновить / создать новую / отмена»', () => {
  async function seedAlpha(): Promise<void> {
    const token = await showAlpha();
    await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    world.chat.outbox.length = 0;
  }

  test('дубль по ИНН: показ с «похоже на существующего» и выбором', async () => {
    await seedAlpha();
    const result = await prepareSupplierCard.execute(
      { name: 'Совсем другое имя', inn: INN_ALPHA },
      world.host,
      turnContext(USER_B, THREAD_B),
    );
    expect(result.duplicates).toEqual([{ name: 'Альфа Металл', reasons: ['совпадает ИНН'] }]);
    const shown = await lastShown(world.chat, THREAD_B);
    expect(shown.text).toContain('Похоже на существующего: «Альфа Металл» (совпадает ИНН)');
    expect(shown.actions).toEqual(['update', 'create', 'cancel']);
    expect(shown.text).toContain(
      'Например: «обнови существующую», «создай новую» или «отмена».',
    );
  });

  test('дубль по email и по названию', async () => {
    await seedAlpha();
    const byEmail = await prepareSupplierCard.execute(
      { name: 'Иное', contacts: [{ email: 'SALES@alfa.example.ru' }] },
      world.host,
      ctxA(),
    );
    expect(byEmail.duplicates[0]?.reasons).toEqual(['совпадает email']);
    const byName = await prepareSupplierCard.execute(
      { name: '  АЛЬФА металл ' },
      world.host,
      ctxA(),
    );
    expect(byName.duplicates[0]?.reasons).toEqual(['совпадает название']);
  });

  test('«Обновить существующую» дополняет карточку и не создаёт вторую', async () => {
    await seedAlpha();
    await prepareSupplierCard.execute(
      { name: 'Альфа Металл', brands: ['Bosch'], terms: { payment: 'отсрочка 10 дней' } },
      world.host,
      ctxA(),
    );
    const shown = await lastShown(world.chat, THREAD_A);
    const update = shown.ids.find((id) => parseSupplierCardButton(id)?.action === 'update') ?? '';
    const outcome = await world.service.press(
      pressOf(parseSupplierCardButton(update)?.token ?? '', USER_A, THREAD_A, 'update'),
    );
    expect(outcome).toEqual({ kind: 'saved', mode: 'updated' });
    const cards = await world.suppliers.searchCards({ limit: 10 });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.supplies.brands).toEqual(['Bosch']);
    expect(cards[0]?.supplies.categories).toEqual(['Метизы']);
    expect(cards[0]?.terms.payment).toBe('отсрочка 10 дней');
    expect(cards[0]?.inn).toBe(INN_ALPHA);
  });

  test('«Создать новую» создаёт отдельную карточку, не затирая похожую', async () => {
    await seedAlpha();
    await prepareSupplierCard.execute({ name: 'Альфа Металл' }, world.host, ctxA());
    const { token } = await lastShown(world.chat, THREAD_A);
    const outcome = await world.service.press(pressOf(token, USER_A, THREAD_A, 'create'));
    expect(outcome).toEqual({ kind: 'saved', mode: 'created' });
    const cards = await world.suppliers.searchCards({ limit: 10 });
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((card) => card.id)).size).toBe(2);
  });

  test('при дублях «Сохранить» не принимается; без дублей «Обновить» не принимается', async () => {
    await seedAlpha();
    await prepareSupplierCard.execute({ name: 'Альфа Металл' }, world.host, ctxA());
    const withDuplicates = (await lastShown(world.chat, THREAD_A)).token;
    expect(await world.service.press(pressOf(withDuplicates, USER_A, THREAD_A, 'save'))).toEqual({
      kind: 'wrong_action',
    });
    await prepareSupplierCard.execute({ name: 'Совершенно новый' }, world.host, ctxA());
    const clean = (await lastShown(world.chat, THREAD_A)).token;
    expect(await world.service.press(pressOf(clean, USER_A, THREAD_A, 'update'))).toEqual({
      kind: 'wrong_action',
    });
  });

  test('дубль, появившийся после показа, блокирует запись', async () => {
    const token = await showAlpha();
    // Пока карточка ждёт нажатия, другой сотрудник сохранил такого же поставщика.
    await prepareSupplierCard.execute(
      { name: 'Альфа Металл', inn: INN_ALPHA },
      world.host,
      turnContext(USER_B, THREAD_B),
    );
    const other = (await lastShown(world.chat, THREAD_B)).token;
    const saved = await world.service.press(pressOf(other, USER_B, THREAD_B, 'save'));
    expect(saved.kind).toBe('saved');
    const outcome = await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    expect(outcome).toEqual({ kind: 'duplicate_appeared' });
    expect(await world.suppliers.searchCards({ limit: 10 })).toHaveLength(1);
  });

  test('отмена при дублях ничего не меняет', async () => {
    await seedAlpha();
    await prepareSupplierCard.execute({ name: 'Альфа Металл' }, world.host, ctxA());
    const { token } = await lastShown(world.chat, THREAD_A);
    await world.service.cancel({ token, userId: USER_A, threadId: THREAD_A });
    expect(await world.suppliers.searchCards({ limit: 10 })).toHaveLength(1);
  });
});

describe('правка и заметка к общей карточке', () => {
  async function savedId(): Promise<string> {
    const token = await showAlpha();
    await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    const [card] = await world.suppliers.searchCards({ limit: 10 });
    world.chat.outbox.length = 0;
    return card?.id ?? '';
  }

  test('правка: меняются только переданные поля, запись после кнопки', async () => {
    const id = await savedId();
    world.clock.advance(60_000);
    const result = await prepareSupplierCardEdit.execute(
      { supplierId: id, changes: { website: 'alfa.example.ru', status: 'active' } },
      world.host,
      ctxA(),
    );
    expect(result.status).toBe('shown');
    expect((await world.suppliers.getCard(id))?.website).toBeUndefined();
    const { token, text } = await lastShown(world.chat, THREAD_A);
    expect(text).toContain('после правки');
    expect(text).toContain('Сайт: alfa.example.ru');
    const outcome = await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    expect(outcome).toEqual({ kind: 'saved', mode: 'updated' });
    const card = await world.suppliers.getCard(id);
    expect(card?.website).toBe('alfa.example.ru');
    expect(card?.status).toBe('active');
    expect(card?.name).toBe('Альфа Металл');
    expect(card?.supplies.categories).toEqual(['Метизы']);
    expect(card?.createdBy).toBe(USER_A);
  });

  test('правка без изменений и несуществующая карточка', async () => {
    const id = await savedId();
    const none = await prepareSupplierCardEdit.execute(
      { supplierId: id, changes: {} },
      world.host,
      ctxA(),
    );
    expect(none.status).toBe('no_changes');
    const same = await prepareSupplierCardEdit.execute(
      { supplierId: id, changes: { name: 'Альфа Металл' } },
      world.host,
      ctxA(),
    );
    expect(same.status).toBe('no_changes');
    await expect(
      prepareSupplierCardEdit.execute(
        { supplierId: 'нет', changes: { name: 'Х' } },
        world.host,
        ctxA(),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(world.chat.outbox).toHaveLength(0);
  });

  test('заметка к общей карточке добавляется только по подтверждению, автор - он', async () => {
    const id = await savedId();
    const result = await addSupplierNote.execute(
      { supplierId: id, text: 'Скидка при предоплате' },
      world.host,
      ctxA(),
    );
    expect(result.status).toBe('shown');
    expect((await world.suppliers.getCard(id))?.notes).toHaveLength(0);
    const { token, actions, text } = await lastShown(world.chat, THREAD_A);
    expect(actions).toEqual(['save', 'cancel']);
    expect(text).toContain('Например: «да» или «нет».');
    const outcome = await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    expect(outcome).toEqual({ kind: 'note_added' });
    const notes = (await world.suppliers.getCard(id))?.notes ?? [];
    expect(notes.map((note) => [note.text, note.authorId])).toEqual([
      ['Скидка при предоплате', USER_A],
    ]);
  });
});

describe('что видит модель: никаких серий из 10+ цифр', () => {
  test('поиск отдаёт маскированные ИНН, телефон и адрес', async () => {
    const token = await showAlpha({ website: 'alfa.example.ru' });
    await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    const byInn = await findSupplierCard.execute({ query: INN_ALPHA }, world.host, ctxA());
    expect(byInn.count).toBe(1);
    const card = byInn.cards[0];
    expect(card?.hasInn).toBe(true);
    expect(card?.innLast4).toBe(INN_ALPHA.slice(-4));
    expect(card?.contacts[0]?.phone).toBe('***4567');
    expect(card?.contacts[0]?.email).toBe('s***@alfa.example.ru');
    const byEmail = await findSupplierCard.execute(
      { email: 'sales@alfa.example.ru' },
      world.host,
      ctxA(),
    );
    const byCategory = await findSupplierCard.execute({ category: 'метиз' }, world.host, ctxA());
    const byBrand = await findSupplierCard.execute({ brand: 'нет такого' }, world.host, ctxA());
    expect([byEmail.count, byCategory.count, byBrand.count]).toEqual([1, 1, 0]);
    for (const output of [byInn, byEmail, byCategory]) {
      expect(findDigitSeries(JSON.stringify(output))).toEqual([]);
      expect(JSON.stringify(output)).not.toContain(INN_ALPHA);
    }
  });

  test('длинные цифры в названии и условиях маскируются; ответ prepare без серий', async () => {
    const result = await prepareSupplierCard.execute(
      {
        name: 'Склад 12345678901234',
        inn: INN_GAMMA,
        terms: { payment: 'счёт 40702810200000000001' },
      },
      world.host,
      ctxA(),
    );
    expect(result.status).toBe('shown');
    expect(findDigitSeries(JSON.stringify(result))).toEqual([]);
    const { token } = await lastShown(world.chat, THREAD_A);
    await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    const found = await findSupplierCard.execute({ query: 'Склад' }, world.host, ctxA());
    expect(found.count).toBe(1);
    expect(findDigitSeries(JSON.stringify(found))).toEqual([]);
    expect(found.cards[0]?.name).toBe('Склад ***1234');
  });

  test('без зависимостей модуль отвечает not_configured', async () => {
    await expect(findSupplierCard.execute({ query: 'х' }, {}, ctxA())).rejects.toMatchObject({
      code: 'not_configured',
    });
  });
});
