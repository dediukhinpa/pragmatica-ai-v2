import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryAccessPolicy } from '@business-ai/adapters';
import { confirmSupplierRequest } from '../../src/agents/suppliers/card-decision';
import { importSuppliersFile } from '../../src/agents/suppliers/import-suppliers-file';
import { prepareSupplierCard } from '../../src/agents/suppliers/supplier-tools';
import { rememberForMe } from '../../src/agents/suppliers/pair-notes';
import { SUPPLIER_CARDS_PROMPT } from '../../src/agents/suppliers/prompt';
import { SUPPLIER_TEMPLATE_COLUMNS } from '../../src/agents/suppliers/supplier-template';
import { ACTION_CONFIRM_SUPPLIER_CARD } from '../../src/kit/domain/access.owned';
import { isDomainError } from '@business-ai/core';
import {
  BOT_PRICES,
  INN_ALPHA,
  SCHEDULER_CONTEXT,
  SwitchableAccess,
  THREAD_A,
  USER_A,
  buildSupplierWorld,
  turnContext,
  type SupplierWorld,
} from './suppliers-support';

/**
 * Ответ сотрудника текстом вместо кнопок карточки (решение владельца 26.10.2026): запись делает
 * `confirmSupplierRequest` только в ходе сотрудника в чате и с правом `suppliers.confirm_card`.
 */

let world: SupplierWorld;
let access: MemoryAccessPolicy;
beforeEach(() => {
  world = buildSupplierWorld();
  access = new MemoryAccessPolicy();
  access.allow({ userId: USER_A, botId: BOT_PRICES, action: ACTION_CONFIRM_SUPPLIER_CARD });
  world.deps.access = access;
});

const ctxA = () => turnContext(USER_A, THREAD_A);

async function showAlpha(): Promise<void> {
  await prepareSupplierCard.execute(
    { name: 'Альфа Металл', inn: INN_ALPHA, contacts: [{ email: 'sales@alfa.example.ru' }] },
    world.host,
    ctxA(),
  );
}

async function cards(): Promise<number> {
  return (await world.suppliers.searchCards({ limit: 10 })).length;
}

describe('карточка поставщика: подтверждение текстом', () => {
  test('показ без кнопок, «да, сохраняй» записывает карточку', async () => {
    await showAlpha();
    expect(world.chat.outbox.at(-1)?.message?.buttons).toBeUndefined();
    expect(world.chat.outbox.at(-1)?.message?.text).toContain('«да, сохраняй»');
    const out = await confirmSupplierRequest.execute({ decision: 'save' }, world.host, ctxA());
    expect(out.status).toBe('saved');
    expect(await cards()).toBe(1);
    // Повтор того же ответа ничего не дублирует.
    const again = await confirmSupplierRequest.execute({ decision: 'save' }, world.host, ctxA());
    expect(again.status).toBe('already_done');
    expect(await cards()).toBe(1);
  });

  test('«сохрани, но контакт другой»: поправка накладывается на показ', async () => {
    await showAlpha();
    const out = await confirmSupplierRequest.execute(
      { decision: 'save', changes: { contacts: [{ email: 'boss@alfa.example.ru' }] } },
      world.host,
      ctxA(),
    );
    expect(out.status).toBe('saved');
    const [card] = await world.suppliers.searchCards({ limit: 10 });
    expect(card?.contacts.map((contact) => contact.email)).toEqual(['boss@alfa.example.ru']);
  });

  test('не ход сотрудника в чате - отказ, в базе пусто', async () => {
    await showAlpha();
    const denied = await confirmSupplierRequest
      .execute({ decision: 'save' }, world.host, SCHEDULER_CONTEXT)
      .catch((error: unknown) => error);
    expect(isDomainError(denied) && denied.code).toBe('access_denied');
    expect(await cards()).toBe(0);
  });

  test('без права на запись карточек - отказ', async () => {
    await showAlpha();
    // Право отозвано между показом и ответом: запись на подтверждении проверяется заново.
    world.deps.access = new MemoryAccessPolicy();
    const out = await confirmSupplierRequest.execute({ decision: 'save' }, world.host, ctxA());
    expect(out.status).toBe('access_denied');
    expect(await cards()).toBe(0);
  });

  test('не руководитель: карточка не показывается, запроса и записи нет (этап 234)', async () => {
    world.deps.access = new MemoryAccessPolicy();
    const error = await showAlpha().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'access_denied' });
    expect(String((error as Error).message)).toContain('только руководители отделов');
    const none = await confirmSupplierRequest.execute({ decision: 'save' }, world.host, ctxA());
    expect(none.status).toBe('nothing_pending');
    expect(await cards()).toBe(0);
  });

  test('справочник руководителей недоступен: показа нет, текст про временный сбой', async () => {
    world.deps.access = {
      isAllowed: async () => false,
      decide: async () => ({ allowed: false, reason: 'directory_unavailable', message: '' }),
    };
    const error = await showAlpha().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'access_denied' });
    expect(String((error as Error).message)).toContain('временный сбой');
  });

  test('сбой справочника при ответе «да»: не отказ, повтор потом проходит', async () => {
    await showAlpha();
    const right = new SwitchableAccess();
    world.deps.access = right;
    right.mode = 'down';
    const failed = await confirmSupplierRequest
      .execute({ decision: 'save' }, world.host, ctxA())
      .catch((caught: unknown) => caught);
    expect(failed).toMatchObject({ code: 'access_denied' });
    expect(String((failed as Error).message)).toContain('временный сбой');
    expect(await cards()).toBe(0);
    // Сбой не записан как отказ: тот же ответ на тот же показ после восстановления проходит.
    right.mode = 'allow';
    const out = await confirmSupplierRequest.execute({ decision: 'save' }, world.host, ctxA());
    expect(out.status).toBe('saved');
    expect(await cards()).toBe(1);
  });

  test('показ другого бота этим ответом не подтверждается', async () => {
    await showAlpha();
    const other = turnContext(USER_A, THREAD_A, 'orders');
    const out = await confirmSupplierRequest.execute({ decision: 'save' }, world.host, other);
    expect(out.status).toBe('unknown_request');
    expect(await cards()).toBe(0);
  });

  test('«отмена» и пустой тред', async () => {
    const none = await confirmSupplierRequest.execute({ decision: 'save' }, world.host, ctxA());
    expect(none.status).toBe('nothing_pending');
    await showAlpha();
    const out = await confirmSupplierRequest.execute({ decision: 'cancel' }, world.host, ctxA());
    expect(out.status).toBe('cancelled');
    expect(await cards()).toBe(0);
  });

  test('«Запомнить?»: «да» записывает личную заметку без права на карточки', async () => {
    world.deps.access = new MemoryAccessPolicy();
    await rememberForMe.execute({ text: 'Пиши кратко', kind: 'note' }, world.host, ctxA());
    const out = await confirmSupplierRequest.execute({ decision: 'save' }, world.host, ctxA());
    expect(out.status).toBe('pair_note_saved');
  });

  test('пачка из файла: ответ «записать» по последнему показу треда', async () => {
    const headers = SUPPLIER_TEMPLATE_COLUMNS.map((column) => column.header);
    const values: Record<string, string> = { name: 'Альфа', inn: INN_ALPHA };
    const line = SUPPLIER_TEMPLATE_COLUMNS.map((column) => values[column.key] ?? '');
    world.parser.tables = [[headers, line]];
    const shown = await importSuppliersFile(world.deps, {
      agentId: BOT_PRICES,
      threadId: THREAD_A,
      userId: USER_A,
      fileName: 'поставщики.xlsx',
      content: new Uint8Array(),
    });
    expect(shown.kind).toBe('shown');
    expect(world.chat.outbox.at(-1)?.message?.buttons).toBeUndefined();
    const out = await confirmSupplierRequest.execute({ decision: 'save' }, world.host, ctxA());
    expect(out.status).toBe('batch_done');
    expect(await cards()).toBe(1);
  });
});

describe('этап 164: свободные ответы на показ карточки', () => {
  test('в показе примеры ответа, а не «Напишите»; «хорошо»/«давай»/«ок» = save ' +
    'записывает', async () => {
    await showAlpha();
    const text = world.chat.outbox.at(-1)?.message?.text ?? '';
    expect(text).toContain('Например: «да, сохраняй»');
    expect(text).not.toContain('Напишите');
    // Слова согласия читает модель и передаёт save; код записывает ровно один раз.
    const out = await confirmSupplierRequest.execute({ decision: 'save' }, world.host, ctxA());
    expect(out.status).toBe('saved');
    expect(await cards()).toBe(1);
  });

  test('«не надо»/«нет»/«пока не нужно» = cancel: карточка не записана', async () => {
    await showAlpha();
    const out = await confirmSupplierRequest.execute({ decision: 'cancel' }, world.host, ctxA());
    expect(out.status).toBe('cancelled');
    expect(await cards()).toBe(0);
  });

  test('неясный ответ и ответ не про вопрос: ничего не записано, показ ждёт ответа', async () => {
    await showAlpha();
    const unclear = await confirmSupplierRequest.execute(
      { decision: 'unclear' },
      world.host,
      ctxA(),
    );
    expect(unclear.status).toBe('unclear');
    expect(unclear.message).toContain('повтори вопрос');
    expect(await cards()).toBe(0);
    // Показ не закрыт и право не расходовано: следующее внятное «да» записывает.
    const saved = await confirmSupplierRequest.execute({ decision: 'save' }, world.host, ctxA());
    expect(saved.status).toBe('saved');
    expect(await cards()).toBe(1);
  });

  test('unclear не обходит предохранитель хода сотрудника', async () => {
    await showAlpha();
    const denied = await confirmSupplierRequest
      .execute({ decision: 'unclear' }, world.host, SCHEDULER_CONTEXT)
      .catch((e: unknown) => e);
    expect(isDomainError(denied) && denied.code).toBe('access_denied');
  });

  test('описание инструмента и промпт перечисляют свободные слова', () => {
    for (const word of ['«хорошо»', '«давай»', '«ок»', '«не надо»', '«пока не нужно»', 'unclear']) {
      expect(confirmSupplierRequest.description).toContain(word);
      expect(SUPPLIER_CARDS_PROMPT).toContain(word);
    }
  });
});
