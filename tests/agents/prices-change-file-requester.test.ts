import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryChatChannel } from '@business-ai/adapters';
import { createToolContext, type ToolContext } from '@business-ai/core';
import {
  previewPriceChanges,
  priceChangeFileName,
  sendPriceChangeFile,
} from '../../src/agents/prices/price-changes';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { bindingThreadId } from '@business-ai/core';
import type { ChatFile, IdempotencyKey } from '@business-ai/core';
import { SUPPLIER_ID, putFile } from './support';
import {
  COLUMNS,
  buildFullPricesDeps,
  skuCsv,
  skuItem,
  type FullPricesDeps,
} from './prices-support';

/** Владелец работы (начал импорт) и другой сотрудник, который просит файл позже. */
const OWNER_THREAD = bindingThreadId({ botId: 'bot-a', userId: 'owner' });
const REQUESTER_THREAD = bindingThreadId({ botId: 'bot-a', userId: 'requester' });

/** Чат, у которого отправка файла падает: проверка честного ответа без «отправил». */
class FailingFileChat extends MemoryChatChannel {
  override async sendFile(
    _threadId: string,
    _file: ChatFile,
    _key: IdempotencyKey,
  ): Promise<void> {
    throw new Error('канал недоступен');
  }
}

function chatCtx(threadId: string, operationId: string): ToolContext {
  return createToolContext({
    threadId,
    agentId: 'test-agent',
    operationId,
    initiator: { kind: 'user', userId: threadId },
  });
}

describe('файл изменений цен: адресат и имя', () => {
  let deps: FullPricesDeps;
  beforeEach(async () => {
    deps = await buildFullPricesDeps();
    await deps.prices.saveImport(SUPPLIER_ID, [skuItem('Болт', 10, 'B1')], 'seed');
  });

  async function prepare(target: FullPricesDeps) {
    putFile(target, 'chg.csv', skuCsv([['Болт', 12, 'B1']]));
    const stage = { path: 'chg.csv', supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true };
    // Работу начинает владелец: за ним закрепляется импорт.
    const staged = await stagePriceRows.execute(stage, target, chatCtx(OWNER_THREAD, 'op-1'));
    const input = { supplierId: SUPPLIER_ID, fileHash: staged.fileHash };
    const ctx = chatCtx(REQUESTER_THREAD, 'op-2');
    const { diffHash } = await previewPriceChanges.execute(input, target, ctx);
    return { input: { ...input, diffHash }, ctx };
  }

  test('файл уходит запросившему в его тред, владельцу работы - ничего', async () => {
    const { input, ctx } = await prepare(deps);
    await sendPriceChangeFile.execute(input, deps, ctx);
    const threads = new Set(deps.chat.outbox.map((item) => item.threadId));
    expect(threads).toEqual(new Set([REQUESTER_THREAD]));
    const file = deps.chat.outbox.find((item) => item.file !== undefined)?.file;
    expect(file?.name).toBe(priceChangeFileName('МеталлТорг', deps.clock.now().toISOString()));
    expect(file?.name.startsWith('Прайс_МеталлТорг_')).toBe(true);
  });

  test('ошибка отправки: причина без слова «отправил»', async () => {
    const failing = { ...deps, chat: new FailingFileChat() };
    const { input, ctx } = await prepare(failing);
    const error = await sendPriceChangeFile.execute(input, failing, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('канал недоступен');
    expect(message.toLowerCase()).not.toContain('отправил');
  });

  test('имя файла: Прайс_<поставщик>_<ДД.ММ.ГГГГ>, недопустимые символы заменены', () => {
    expect(priceChangeFileName('ООО «Метиз/Торг»: "Юг"?', '2026-11-02T10:00:00Z')).toBe(
      'Прайс_ООО «Метиз_Торг»_ _Юг___02.11.2026.xlsx',
    );
  });
});
