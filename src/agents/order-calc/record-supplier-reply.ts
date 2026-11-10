import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import { hoursToMs } from '../../kit/domain/time';
import { base64Of } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { assertEmployeeChatTurn } from '@business-ai/core';
import { predecessorOf, readState, requirePort, stableHash, writeState } from '@business-ai/core';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_REPLY_TEXT_CHARS,
  REPLY_PENDING_NAMESPACE,
  REPLY_PENDING_TTL_HOURS,
  type OrderCalcDeps,
} from './deps';
import {
  MANUAL_REPLY_CHANNELS,
  attachmentKey,
  loadReplies,
  replyFilesNamespace,
  storeReply,
  type StoredReply,
} from './reply-store';
import { offerQuoteReplacements } from './quote-replacement';
import { assertOrderOwner } from './order-access';
import { loadSelection } from './state';
import { requestLabel } from './request-title';

/** Подписи каналов для сотрудника. */
const CHANNEL_LABELS: Record<(typeof MANUAL_REPLY_CHANNELS)[number], string> = {
  phone: 'по телефону',
  messenger: 'в мессенджере',
  other: 'другим способом',
};
/** Подсказки ответа сотрудника на показ (решение владельца: текстом, без кнопок). */
const CONFIRM_HINT = 'Например: «да, записывай», «записывай» или «отмена», «не надо».';

/**
 * Плоская схема (без объединений сверху: иначе API модели отвечает 400). Сочетания полей
 * проверяет код в `execute`.
 */
const inputSchema = z.object({
  requestId: z.string().min(1),
  supplierId: z.string().min(1).describe('Поставщик из выбора менеджера по этой заявке'),
  channel: z.enum(MANUAL_REPLY_CHANNELS).describe('phone, messenger или other'),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(MAX_REPLY_TEXT_CHARS)
    .describe('Что ответил поставщик - ровно со слов сотрудника, без домыслов'),
  filePath: z
    .string()
    .min(1)
    .optional()
    .describe('Файл, присланный сотрудником в чат (path из хранилища файлов), если есть'),
  declined: z
    .boolean()
    .optional()
    .describe('true - поставщик явно отказался давать КП (заказ по нему закрыт)'),
  confirmed: z
    .boolean()
    .optional()
    .describe(
      'Не передавай при первом вызове (код покажет запись сотруднику). true - только после ' +
        'явного согласия сотрудника («да», «записывай», «хорошо», «ок») сразу в ответ на ' +
        'показ, в его следующем сообщении, с теми же остальными полями',
    ),
});
type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  status: z.enum(['needs_confirmation', 'recorded', 'already_recorded']),
  replyId: z.string().optional(),
  /** Итог для сотрудника: перескажи его своими словами. */
  message: z.string(),
});
type Output = z.infer<typeof outputSchema>;

/** Показанный сотруднику ответ, ждущий «да»: хранится только до подтверждения. */
const pendingSchema = z.object({
  fingerprint: z.string().min(1),
  userId: z.string().min(1),
  threadId: z.string().min(1),
  /** Номер реплики сотрудника, в которой показано: подтвердить можно только в следующей. */
  turnNumber: z.number().int(),
  createdAt: z.string(),
});

const pendingKey = (input: Pick<Input, 'requestId' | 'supplierId'>): string =>
  `${input.requestId}:${input.supplierId}`;

/** Отпечаток содержимого: подтверждение относится ровно к показанному тексту. */
function fingerprintOf(input: Input): string {
  return stableHash({
    channel: input.channel,
    summary: input.summary,
    declined: input.declined === true,
    filePath: input.filePath ?? null,
  });
}

/** Идентификатор ответа: один и тот же ответ по тому же поставщику не дублируется. */
export function manualReplyId(input: Input): string {
  return `manual:${stableHash({
    requestId: input.requestId,
    supplierId: input.supplierId,
    fingerprint: fingerprintOf(input),
  })}`;
}

/** Заявка и поставщик проверяются кодом: поставщик только из выбора менеджера. */
async function assertSupplierSelected(deps: OrderCalcDeps, input: Input): Promise<string> {
  const request = await deps.requests.get(input.requestId);
  if (request === null) {
    throw new DomainError('not_found', `Заявка ${input.requestId} не найдена.`);
  }
  const selection = await loadSelection(deps, input.requestId);
  if (selection === null) {
    throw new DomainError('not_found', 'Менеджер ещё не выбрал поставщиков по заявке.');
  }
  if (!selection.supplierIds.includes(input.supplierId)) {
    throw new DomainError(
      'invalid_input',
      `Поставщик ${input.supplierId} не входит в выбор менеджера по заявке ${input.requestId}.`,
    );
  }
  return (await deps.suppliers.get(input.supplierId))?.name ?? input.supplierId;
}

/** Текст показа сотруднику (собирает код: название поставщика в модель не уходит). */
function previewText(
  label: string,
  input: Input,
  supplierName: string,
  fileName: string | undefined,
): string {
  const lines = [
    `Заявка «${label}»: записать ответ поставщика «${supplierName}» ` +
      `${CHANNEL_LABELS[input.channel]} (со слов сотрудника)?`,
    input.declined === true ? 'Поставщик отказался давать КП.' : `Ответ: ${input.summary}`,
  ];
  if (input.declined === true) lines.push(`Комментарий: ${input.summary}`);
  if (fileName !== undefined) lines.push(`Файл: ${fileName}`);
  lines.push(CONFIRM_HINT);
  return lines.join('\n');
}

/** Файл из чата: имя и содержимое (вне хранилища файлов или чужой тред - not_found). */
async function readChatFile(
  deps: OrderCalcDeps,
  threadId: string,
  path: string,
): Promise<{ fileName: string; bytes: Uint8Array }> {
  const intake = requirePort(deps.intake, 'хранилище файлов сотрудников');
  const entry = (await intake.list(threadId)).find((item) => item.path === path);
  if (entry === undefined) {
    throw new DomainError('not_found', 'Файл не найден среди присланных в этом чате.');
  }
  return { fileName: entry.fileName, bytes: await intake.read(threadId, path) };
}

/** Сохранить ответ сотрудника в то же хранилище, что и письма (`loadReplies`). */
async function saveManualReply(
  deps: OrderCalcDeps,
  input: Input,
  userId: string,
  threadId: string,
): Promise<{ replyId: string; created: boolean }> {
  const id = manualReplyId(input);
  const attachments: StoredReply['attachments'] = [];
  if (input.filePath !== undefined) {
    const file = await readChatFile(deps, threadId, input.filePath);
    const stored = file.bytes.length <= MAX_ATTACHMENT_BYTES;
    if (stored) {
      await writeState(deps.state, replyFilesNamespace(input.requestId), attachmentKey(id, 0), {
        base64: base64Of(file.bytes),
      });
    }
    attachments.push({
      id: `${id}#0`,
      fileName: file.fileName,
      mimeType: 'application/octet-stream',
      sizeBytes: file.bytes.length,
      stored,
    });
  }
  const created = await storeReply(deps.state, input.requestId, {
    id,
    channel: input.channel,
    supplierId: input.supplierId,
    text: input.summary,
    receivedAt: deps.clock.now().toISOString(),
    attachments,
    recordedBy: userId,
    ...(input.declined === true ? { declined: true } : {}),
  });
  return { replyId: id, created };
}

/**
 * Ответ поставщика вне почты (телефон, мессенджер): сотрудник сообщает, что ответил поставщик.
 * Два шага, как у карточек: первый вызов показывает запись сотруднику (ничего не пишет), второй
 * (`confirmed=true`, в следующей реплике сотрудника, с теми же полями) записывает её в
 * хранилище ответов заявки. После записи `replyId` годится как `sourceRef` для recordQuote.
 */
export const recordSupplierReply = defineTool<Input, Output, OrderCalcDeps>({
  name: 'recordSupplierReply',
  description:
    'Записать ответ поставщика, полученный НЕ по почте (по телефону, в мессенджере): requestId, ' +
    'supplierId (из выбора менеджера), channel (phone | messenger | other), summary - что ' +
    'ответил поставщик ровно со слов сотрудника, filePath - файл из чата (если сотрудник ' +
    'прислал), declined=true - поставщик отказался давать КП. Первый вызов (без confirmed) ' +
    'показывает запись сотруднику: закончи ход и жди его ответа. Согласие свободное («да», ' +
    '«записывай», «хорошо», «давай», «ок») и только как явный ответ на показ в его ' +
    'следующем сообщении: тогда вызови ещё раз с теми же полями и confirmed=true. Те же ' +
    'слова вне этого вопроса, отказ («отмена», «не надо», «нет») или неясный ответ - ' +
    'confirmed не ставь (неясно - один раз коротко переспроси). Ничего не ' +
    'выдумывай за поставщика. После записи replyId - sourceRef для recordQuote.',
  sideEffect: true,
  inputSchema,
  outputSchema,
  idempotencyKey: (input) =>
    `order-reply-manual:${input.requestId}:${input.supplierId}:` +
    `${input.confirmed === true ? 'confirm' : 'show'}:${fingerprintOf(input)}`,
  // Состояние до операции: показ после отмены/истечения и повторная запись - новые операции.
  idempotencyPredecessor: async (input, deps) => {
    const pending = await readState(
      deps.state,
      REPLY_PENDING_NAMESPACE,
      pendingKey(input),
      pendingSchema,
    );
    const replies = await loadReplies(deps.state, input.requestId);
    return predecessorOf({
      pending: pending?.createdAt ?? null,
      recorded: replies.some((reply) => reply.id === manualReplyId(input)),
    });
  },
  async execute(input, deps, context) {
    const userId = assertEmployeeChatTurn(context);
    await assertOrderOwner(deps, input.requestId, context);
    const supplierName = await assertSupplierSelected(deps, input);
    const fingerprint = fingerprintOf(input);
    if (input.confirmed !== true) {
      const file =
        input.filePath === undefined
          ? undefined
          : await readChatFile(deps, context.threadId, input.filePath);
      const now = deps.clock.now();
      await writeState(deps.state, REPLY_PENDING_NAMESPACE, pendingKey(input), {
        fingerprint,
        userId,
        threadId: context.threadId,
        turnNumber: context.turnNumber,
        createdAt: now.toISOString(),
      });
      await deps.chat.reply(
        context.threadId,
        {
          text: previewText(
            await requestLabel(deps, input.requestId),
            input,
            supplierName,
            file?.fileName,
          ),
        },
        `order-reply-manual-show:${input.requestId}:${input.supplierId}:${fingerprint}:` +
          `${now.getTime()}`,
      );
      return {
        status: 'needs_confirmation',
        message:
          'Запись показана сотруднику в чате. Ничего не записано: закончи ход и жди его ' +
          'ответа; не говори, что ответ записан.',
      };
    }
    const pending = await readState(
      deps.state,
      REPLY_PENDING_NAMESPACE,
      pendingKey(input),
      pendingSchema,
    );
    const replyId = manualReplyId(input);
    if (pending === null) {
      // Повтор после записи: ответ уже есть, второй раз не пишется.
      const known = (await loadReplies(deps.state, input.requestId)).some(
        (reply) => reply.id === replyId,
      );
      if (known) {
        return { status: 'already_recorded', replyId, message: 'Этот ответ уже записан.' };
      }
      throw new DomainError('conflict', 'Эту запись сотруднику не показывали: сначала покажи её.');
    }
    const expiresAt = Date.parse(pending.createdAt) + hoursToMs(REPLY_PENDING_TTL_HOURS);
    if (pending.fingerprint !== fingerprint) {
      throw new DomainError(
        'conflict',
        'Поля отличаются от показанных сотруднику: покажи запись заново и дождись «да».',
      );
    }
    if (pending.userId !== userId || pending.threadId !== context.threadId) {
      throw new DomainError(
        'access_denied',
        'Эту запись показывали другому сотруднику или в другом чате.',
      );
    }
    if (pending.turnNumber >= context.turnNumber) {
      throw new DomainError(
        'conflict',
        'Подтверждение возможно только отдельным сообщением сотрудника после показа записи.',
      );
    }
    if (deps.clock.now().getTime() > expiresAt) {
      throw new DomainError('conflict', 'Показ записи устарел: покажи её заново.');
    }
    const saved = await saveManualReply(deps, input, userId, context.threadId);
    // Показ расходуется записью: повторное подтверждение уже ничего не запишет.
    await deps.state.delete(REPLY_PENDING_NAMESPACE, pendingKey(input));
    // Без почты readSupplierReplies недоступен, а вопрос о замене КП задаёт только он: новый ответ
    // после записанного КП иначе упирается в quote_source_conflict без выхода.
    if (saved.created) {
      try {
        await offerQuoteReplacements(deps, input.requestId);
      } catch {
        // Запись уже сделана; вопрос о замене повторится при чтении ответов.
        deps.log?.('order_reply_replace_offer_failed', { requestId: input.requestId });
      }
    }
    return {
      status: saved.created ? 'recorded' : 'already_recorded',
      replyId: saved.replyId,
      message:
        'Ответ записан. Для КП вызови recordQuote с sourceRef=replyId; ' +
        'утренняя сводка и статус заказа учитывают этот ответ.',
    };
  },
});
