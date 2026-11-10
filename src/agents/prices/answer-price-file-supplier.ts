import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import { defineTool, type ToolContext } from '@business-ai/core';
import { baseName, stableHash } from '@business-ai/core';
import {
  CONFIRM_CARD_DENIED_TEXT,
  confirmCardUnavailableError,
  confirmCardVerdict,
} from '../suppliers/confirm-card-right';
import { createAutoSupplierCard } from '../suppliers/draft-card';
import { PRICES_AGENT_ID, responsibleThread, type PricesDeps } from './deps';
import {
  listPendingSupplierFiles,
  writeSupplierAnswer,
  type PendingSupplierFile,
} from './disk-sync-pending';
import { fileRefOf } from './file-ref';
import { requireState } from './price-state';

/** Верхний предел длины значений от сотрудника. */
const FIELD_MAX = 200;

const inputSchema = z.object({
  /** Имя файла из вопроса сотруднику (или fileref:...). */
  file: z.string().min(1).max(FIELD_MAX),
  /** Поставщик, который назван ответом: id из searchSuppliers. Либо это, либо newSupplierName. */
  supplierId: z.string().min(1).max(FIELD_MAX).optional(),
  /** Название нового поставщика, если сотрудник назвал его. */
  newSupplierName: z.string().min(1).max(FIELD_MAX).optional(),
  /** ИНН нового поставщика, если сотрудник его назвал. */
  inn: z.string().min(1).max(FIELD_MAX).optional(),
});
type AnswerInput = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  supplierId: z.string(),
  /** true - карточка создана сейчас. */
  created: z.boolean(),
  /** Файл будет импортирован плановой синхронизацией в ближайшие минуты. */
  queued: z.boolean(),
});
type AnswerOutput = z.infer<typeof outputSchema>;

/** Имя для сравнения: без регистра и лишних пробелов. */
function looseName(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** Ожидающий ответа файл по имени (или идентификатору fileref); неоднозначность - ошибка. */
function pickPending(
  deps: PricesDeps,
  pending: readonly PendingSupplierFile[],
  file: string,
): PendingSupplierFile {
  const wanted = looseName(baseName(file));
  const hits = pending.filter(
    (item) =>
      fileRefOf(item.path, deps.fileRefSecret) === file ||
      looseName(baseName(item.path)) === wanted,
  );
  const [only] = hits;
  if (only === undefined) {
    throw new DomainError('not_found', 'Файл не ждёт ответа о поставщике (вопрос не задавался).');
  }
  if (hits.length > 1) {
    throw new DomainError(
      'conflict',
      'Под это имя подходит несколько файлов, ждущих ответа: уточните у сотрудника папку.',
    );
  }
  return only;
}

/**
 * Отвечать может адресат вопроса (тред, куда он задан) и ответственный/менеджер. Чужой
 * сотрудник получает отказ по правам: подменить поставщика чужого прайса нельзя.
 */
function assertAnswerAllowed(
  deps: PricesDeps,
  target: PendingSupplierFile,
  threadId: string,
): void {
  const allowed = new Set([
    ...(target.threadIds ?? [responsibleThread(deps)]),
    responsibleThread(deps),
    deps.managerThreadId,
  ]);
  if (!allowed.has(threadId)) {
    throw new DomainError('access_denied', 'Ответ на этот вопрос может дать только его адресат.');
  }
}

/**
 * Создать новую карточку в общей базе вправе только руководитель отдела (этап 234). Право
 * проверяется на том, кто отвечает; сбой справочника - временная ошибка (не кэшируется как
 * отказ). Политика - модуля карточек, иначе политика агента; нет ни одной - отказ.
 */
async function assertMayCreateCard(deps: PricesDeps, context: ToolContext): Promise<void> {
  const userId = context.initiator.kind === 'user' ? context.initiator.userId : '';
  const verdict =
    userId === ''
      ? 'denied'
      : await confirmCardVerdict(deps.supplierCards?.access ?? deps.access, {
          userId,
          botId: PRICES_AGENT_ID,
        });
  if (verdict === 'unavailable') throw confirmCardUnavailableError();
  if (verdict === 'denied') {
    throw new DomainError(
      'access_denied',
      `${CONFIRM_CARD_DENIED_TEXT} Можно указать уже существующего поставщика (supplierId).`,
    );
  }
}

/**
 * Записать ответ сотрудника на вопрос «чей это прайс». Общего инструмента заведения поставщика
 * у агента нет: этот работает только для файла, по которому код уже задал вопрос. Сам файл
 * импортирует следующий тик синхронизации с найденным или созданным поставщиком.
 */
export const answerPriceFileSupplier = defineTool<AnswerInput, AnswerOutput, PricesDeps>({
  name: 'answerPriceFileSupplier',
  description:
    'Ответ сотрудника на вопрос «чей это прайс» по файлу с диска, который код не смог ' +
    'определить. Передай file (имя файла из вопроса) и ОДНО из: supplierId (поставщик, ' +
    'найденный searchSuppliers) либо newSupplierName (название нового поставщика, которое ' +
    'назвал сотрудник; inn - если он назвал). Новая карточка сразу рабочая, ' +
    'создаёт её только руководитель отдела: другому сотруднику придёт отказ - скажи, что ' +
    'карточку в общей базе заводит руководитель отдела, и предложи указать существующего ' +
    'поставщика. ' +
    'Карточка создаётся только для ' +
    'файла из вопроса. Импорт файла выполнит плановая синхронизация в течение 10 минут: сам ' +
    'файл не импортируй.',
  sideEffect: true,
  inputSchema,
  outputSchema,
  idempotencyKey: (input) =>
    'prices-ask-answer:' +
    stableHash([input.file, input.supplierId ?? '', input.newSupplierName ?? '']),
  async execute(input, deps, context) {
    const state = requireState(deps);
    if ((input.supplierId === undefined) === (input.newSupplierName === undefined)) {
      throw new DomainError(
        'invalid_input',
        'Передайте ровно одно: supplierId существующего поставщика или newSupplierName.',
      );
    }
    const target = pickPending(deps, await listPendingSupplierFiles(state), input.file);
    assertAnswerAllowed(deps, target, context.threadId);
    let supplierId: string;
    let created = false;
    if (input.supplierId !== undefined) {
      if ((await deps.suppliers.getCard(input.supplierId)) === null) {
        throw new DomainError('not_found', 'Поставщик с таким supplierId не найден.');
      }
      supplierId = input.supplierId;
    } else {
      await assertMayCreateCard(deps, context);
      const draft = await createAutoSupplierCard(
        deps.suppliers,
        { name: input.newSupplierName ?? '', inn: input.inn },
        {
          userId: PRICES_AGENT_ID,
          nowIso: deps.clock.now().toISOString(),
          origin: 'ответ сотрудника',
        },
      );
      supplierId = draft.card.id;
      created = draft.created;
    }
    await writeSupplierAnswer(state, target.hash, {
      supplierId,
      answeredAt: deps.clock.now().toISOString(),
    });
    return { supplierId, created, queued: true };
  },
});
