import { z } from 'zod';
import { DomainError, chatThreadOf, defineTool, turnPredecessor } from '@business-ai/core';
import type { PricesDeps } from './agents/prices/deps';
import { lastTurnFileOf } from './turn-file-buffer';

/**
 * Повторная отправка последнего файла правки (этап 9u). Сотрудник пишет «вышли файл», «где
 * файл», «пришли ещё раз»: раньше модель пересчитывала правку заново и присылала ещё один файл,
 * иногда с другими числами. Здесь файл берётся из памяти сервиса (его оставила обёртка канала
 * чата при отправке в конце хода) и уходит тем же именем и теми же байтами, без пересчёта.
 */

/** Имя инструмента. */
export const RESEND_LAST_FILE_TOOL = 'resendLastPriceFile';

/** Что сказать, когда в памяти сервиса файла нет (перезапуск, другой чат, правок не было). */
export const NO_LAST_FILE_MESSAGE =
  'Готового файла правки в этом чате не сохранилось (память сервиса). Скажи сотруднику об этом ' +
  'прямо, не пересчитывай; пусть пришлёт файл и просьбу заново.';

/** Что сказать после повторной отправки. */
export const RESENT_MESSAGE =
  'Файл отправлен повторно тем же именем, без пересчёта; ничего не пересчитывай и новых файлов ' +
  'не делай.';

const inputSchema = z.object({}).strict();
type ResendInput = z.infer<typeof inputSchema>;

const STATUSES = ['sent', 'no_file'] as const;

const outputSchema = z.object({
  status: z.enum(STATUSES),
  fileName: z.string().optional(),
  message: z.string(),
});
type ResendOutput = z.infer<typeof outputSchema>;

/**
 * Отправить сотруднику последний файл правки цены этого чата ещё раз, без пересчёта. Файл
 * уходит с прежним именем: ничего нового не создаётся, числа не меняются.
 */
export const resendLastPriceFile = defineTool<ResendInput, ResendOutput, PricesDeps>({
  name: RESEND_LAST_FILE_TOOL,
  sideEffect: true,
  description:
    'Отправить сотруднику ещё раз последний готовый файл правки цены этого чата: «вышли файл», ' +
    '«где файл», «пришли ещё раз», «файл не пришёл» БЕЗ нового вложения. Ничего не пересчитывает ' +
    'и не создаёт: файл уходит с тем же именем и теми же числами. Не вызывай, если сотрудник ' +
    'прислал файл и просит правку (это новая задача: readPriceFile и editPriceInFile). ' +
    'status=no_file - файла в памяти нет: скажи об этом прямо, не пересчитывай.',
  inputSchema,
  outputSchema,
  // Ключ «на ход»: повтор того же хода файл не задваивает, а новая просьба «вышли файл» в
  // другой реплике сотрудника - новая операция
  idempotencyKey: () => 'resend-last',
  idempotencyPredecessor: async (_input, _deps, threadId, turnNumber) =>
    turnPredecessor(threadId, turnNumber),
  async execute(_input, deps, context) {
    const threadId = deps.state === undefined ? null : await chatThreadOf(deps.state, context);
    if (threadId === null) {
      throw new DomainError(
        'conflict',
        'Повторная отправка файла идёт только в чате сотрудника: плановый ход файл не отправляет.',
      );
    }
    const last = lastTurnFileOf(threadId);
    if (last === undefined) return { status: 'no_file' as const, message: NO_LAST_FILE_MESSAGE };
    await deps.chat.sendFile(
      threadId,
      { name: last.name, mimeType: last.mimeType, content: last.content },
      `resend-last:${threadId}:${context.turnNumber}:${last.name}`,
    );
    return { status: 'sent' as const, fileName: last.name, message: RESENT_MESSAGE };
  },
});
