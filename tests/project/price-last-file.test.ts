import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ToolContext } from '@business-ai/core';
import {
  NO_LAST_FILE_MESSAGE,
  RESENT_MESSAGE,
  RESEND_LAST_FILE_TOOL,
  resendLastPriceFile,
} from '../../src/price-last-file';
import {
  configureTurnFileBuffer,
  createTurnFileStore,
  flushTurnFiles,
  resetTurnFileBufferForTests,
  runInTurnFileStore,
  turnFileChat,
} from '../../src/turn-file-buffer';
import {
  EMPLOYEE_THREAD,
  SCHEDULER_CTX,
  buildFullPricesDeps,
  employeeContext,
  type FullPricesDeps,
} from '../agents/prices-support';

/**
 * Повторная отправка последнего файла правки (этап 9u): «вышли файл» не пересчитывает, а
 * отправляет прежний файл тем же именем и байтами. Данные синтетические.
 */

const FILE_NAME = 'Прайс_новые_цены_01.01.2026.pptx';
const FILE_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const FILE_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 7, 8, 9]);
/** Номер следующего хода сотрудника в том же треде. */
const NEXT_TURN = 2;

let deps: FullPricesDeps;
let ctx: ToolContext;

/** Файлы, ушедшие в чат, по порядку. */
function sentFiles(): Array<{ name: string; mimeType: string; content: Uint8Array }> {
  return deps.chat.outbox.flatMap((item) => (item.file === undefined ? [] : [item.file]));
}

/** Положить файл в кэш последнего файла треда: как после отправки в конце хода. */
async function rememberLastFile(): Promise<void> {
  const store = createTurnFileStore();
  const buffered = turnFileChat(deps.chat);
  await runInTurnFileStore(store, () =>
    buffered.sendFile(
      EMPLOYEE_THREAD,
      { name: FILE_NAME, mimeType: FILE_MIME, content: FILE_BYTES },
      'test-last-file',
    ),
  );
  await flushTurnFiles(store, 'ok');
  deps.chat.outbox.length = 0;
}

beforeEach(async () => {
  resetTurnFileBufferForTests();
  configureTurnFileBuffer({ enabled: true });
  deps = await buildFullPricesDeps();
  ctx = employeeContext('u-resend', EMPLOYEE_THREAD);
});

afterEach(() => {
  resetTurnFileBufferForTests();
});

describe('resendLastPriceFile', () => {
  test('описание: пустой вход, побочный эффект, имя инструмента', () => {
    expect(resendLastPriceFile.name).toBe(RESEND_LAST_FILE_TOOL);
    expect(resendLastPriceFile.sideEffect).toBe(true);
    expect(resendLastPriceFile.inputSchema.safeParse({}).success).toBe(true);
    expect(resendLastPriceFile.inputSchema.safeParse({ path: 'x' }).success).toBe(false);
  });

  test('файл есть: уходит тем же именем и теми же байтами, status=sent', async () => {
    await rememberLastFile();
    const out = await resendLastPriceFile.execute({}, deps, ctx);
    expect(out).toEqual({ status: 'sent', fileName: FILE_NAME, message: RESENT_MESSAGE });
    const [file] = sentFiles();
    expect(sentFiles()).toHaveLength(1);
    expect(file?.name).toBe(FILE_NAME);
    expect(file?.mimeType).toBe(FILE_MIME);
    expect(Array.from(file?.content ?? [])).toEqual(Array.from(FILE_BYTES));
  });

  test('файла нет: status=no_file, ничего не отправлено', async () => {
    const out = await resendLastPriceFile.execute({}, deps, ctx);
    expect(out.status).toBe('no_file');
    expect(out.fileName).toBeUndefined();
    expect(out.message).toBe(NO_LAST_FILE_MESSAGE);
    expect(out.message).toContain('не пересчитывай');
    expect(sentFiles()).toHaveLength(0);
  });

  test('плановый ход (не чат сотрудника): conflict', async () => {
    await rememberLastFile();
    await expect(resendLastPriceFile.execute({}, deps, SCHEDULER_CTX)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(sentFiles()).toHaveLength(0);
  });

  test('ключ отправки: ход и имя файла, другой ход - другой ключ', async () => {
    await rememberLastFile();
    const keys: string[] = [];
    const sendFile = deps.chat.sendFile.bind(deps.chat);
    const spying = {
      ...deps,
      chat: {
        ...deps.chat,
        sendFile: async (threadId: string, file: Parameters<typeof sendFile>[1], key: string) => {
          keys.push(key);
          await sendFile(threadId, file, key);
        },
      },
    } as unknown as FullPricesDeps;
    await resendLastPriceFile.execute({}, spying, ctx);
    await resendLastPriceFile.execute({}, spying, { ...ctx, turnNumber: NEXT_TURN });
    expect(keys).toEqual([
      `resend-last:${EMPLOYEE_THREAD}:${ctx.turnNumber}:${FILE_NAME}`,
      `resend-last:${EMPLOYEE_THREAD}:${NEXT_TURN}:${FILE_NAME}`,
    ]);
  });

  test('ключ идемпотентности на ход: повтор хода тот же, другой ход - другой', async () => {
    const same = await resendLastPriceFile.idempotencyPredecessor?.({}, deps, EMPLOYEE_THREAD, 1);
    const again = await resendLastPriceFile.idempotencyPredecessor?.({}, deps, EMPLOYEE_THREAD, 1);
    const next = await resendLastPriceFile.idempotencyPredecessor?.(
      {},
      deps,
      EMPLOYEE_THREAD,
      NEXT_TURN,
    );
    expect(same).toBe(again);
    expect(next).not.toBe(same);
    expect(resendLastPriceFile.idempotencyKey?.({})).toBe('resend-last');
  });
});
