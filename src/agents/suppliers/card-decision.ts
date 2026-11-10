import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { assertEmployeeChatTurn } from '@business-ai/core';
import { readState, requirePort, stableHash, writeState } from '@business-ai/core';
import {
  createSupplierCardService,
  supplierCardOutcomeText,
  type SupplierCardOutcome,
} from './card-approval';
import { confirmCardUnavailableError, confirmCardVerdict } from './confirm-card-right';
import { supplierCardFieldsSchema, type SupplierCardFields } from './card-fields';
import { cardRequestSchema, pendingSupplierRequest, type SupplierCardAction } from './card-request';
import {
  SUPPLIER_CARD_REQUEST_NAMESPACE,
  type SupplierCardsDeps,
  type SupplierCardsHost,
} from './deps';

/**
 * Ответ сотрудника текстом на показ карточки, заметки, «Запомнить?» или пачки из файла (кнопок
 * нет, решение владельца 26.10.2026). Запись делает тот же `SupplierCardService.press`, что и
 * старая кнопка, со всеми его проверками (тред, владелец, срок, дубли и версия на момент записи).
 * Предохранители сверх них: ход начат сообщением сотрудника в чате, право
 * `suppliers.confirm_card` (кроме личной заметки), запрос показан этим же агентом.
 */

const MODULE_NAME = 'карточки поставщиков';
/** Решения, которые модель может передать (кроме прежнего «Изменить»: поправку пишут текстом). */
const DECISIONS = ['save', 'create', 'update', 'cancel', 'unclear'] as const;
/** unclear - ответ неясен: ничего не пишется, запрос остаётся ждать (этап 164). */
const UNCLEAR_TEXT =
  'Ответ неясен, ничего не записано. Ответь по существу и один раз коротко повтори вопрос ' +
  'с примерами ответа.';

const inputSchema = z.object({
  decision: z
    .enum(DECISIONS)
    .describe(
      'save - согласие сохранить («да, сохраняй», «хорошо», «давай», «ок»; для пачки - записать ' +
        'новых), create - создать новую при похожих, update - обновить существующую (для пачки ' +
        '- записать и обновить дубли), cancel - отказ («отмена», «нет», «не надо», «пока не ' +
        'нужно»), unclear - ответ неоднозначен или не про вопрос',
    ),
  requestId: z
    .string()
    .min(1)
    .optional()
    .describe('requestId из ответа prepare*; нет - последний показ в этом чате'),
  /**
   * Поправка сотрудника к показанной карточке в том же ответе («сохрани, но телефон другой»):
   * накладывается на поля показа (поле целиком заменяется), затем карточка проверяется заново.
   */
  changes: supplierCardFieldsSchema
    .optional()
    .describe('Только то, что сотрудник сам велел поправить в ответе; иначе не передавай'),
});
type Input = z.infer<typeof inputSchema>;

const STATUSES = [
  'saved',
  'note_added',
  'pair_note_saved',
  'pair_note_full',
  'batch_done',
  'edit_requested',
  'cancelled',
  'invalid',
  'duplicate_appeared',
  'card_changed',
  'target_missing',
  'wrong_action',
  'failed',
  'already_done',
  'expired',
  'wrong_owner',
  'wrong_thread',
  'unknown_request',
  'no_identity',
  'nothing_pending',
  'access_denied',
  'unclear',
] as const;

const outputSchema = z.object({
  status: z.enum(STATUSES),
  /** Итог для сотрудника без содержимого карточки: перескажи его своими словами. */
  message: z.string(),
});
type Output = z.infer<typeof outputSchema>;

const NOTHING_PENDING_TEXT =
  'Нет показанной карточки или пачки, ждущей ответа: сначала подготовь её (prepare*).';
const ACCESS_DENIED_TEXT =
  'Записывать карточки поставщиков в общую базу могут только руководители отделов.';
const CHANGES_NOT_ALLOWED_TEXT =
  'Поправку можно передать только для карточки; для заметки и пачки подготовь их заново.';

/** Токен запроса, к которому относится ответ: явный id или последний показ треда. */
async function resolveToken(
  deps: SupplierCardsDeps,
  threadId: string,
  input: Pick<Input, 'requestId'>,
): Promise<string | null> {
  if (input.requestId !== undefined) return input.requestId;
  return (await pendingSupplierRequest(deps.state, threadId))?.token ?? null;
}

/** Поправка накладывается на поля показа: переданное поле заменяет прежнее целиком. */
async function applyChanges(
  deps: SupplierCardsDeps,
  token: string,
  changes: SupplierCardFields,
): Promise<boolean> {
  const request = await readState(
    deps.state,
    SUPPLIER_CARD_REQUEST_NAMESPACE,
    token,
    cardRequestSchema,
  );
  if (request === null || request.kind !== 'card' || request.fields === undefined) return false;
  if (request.closedAt !== undefined) return true;
  const fields = supplierCardFieldsSchema.parse({ ...request.fields, ...changes });
  await writeState(deps.state, SUPPLIER_CARD_REQUEST_NAMESPACE, token, { ...request, fields });
  return true;
}

function result(outcome: SupplierCardOutcome): Output {
  return { status: outcome.kind, message: supplierCardOutcomeText(outcome) };
}

/** Записать решение сотрудника по показанной карточке, заметке, «Запомнить?» или пачке. */
export const confirmSupplierRequest = defineTool<Input, Output, SupplierCardsHost>({
  name: 'confirmSupplierRequest',
  description:
    'Записать ответ сотрудника на показ prepareSupplierCard, prepareSupplierCardEdit, ' +
    'addSupplierNote, rememberForMe или отчёт о файле ' +
    'поставщиков. Ответ свободный, смысл читаешь ты; вызывай только по явному ответу в этом ' +
    'сообщении сразу на показанный вопрос. Согласие («да, сохраняй», «да», «хорошо», «давай», ' +
    '«ок», «записывай») - save; «создай новую» - create; «обнови существующую» / «записать и ' +
    'обновить дубли» - update; отказ («отмена», «нет», «не надо», «пока не нужно», «пока ' +
    'нет») - cancel; сомнение или ответ не про вопрос («ок» вне ответа на показ, «а какой ' +
    'у него ИНН?») - unclear: ничего не записывается, ответь по существу и один раз коротко ' +
    'повтори вопрос. Если он подтвердил с поправкой («сохрани, но телефон другой: …»), ' +
    'передай её в changes. Не выдумывай решение и не вызывай без ответа. Перескажи ' +
    'сотруднику message.',
  sideEffect: true,
  inputSchema,
  outputSchema,
  idempotencyKey: (input) =>
    `suppliers-confirm:${input.requestId ?? ''}:${input.decision}:` +
    stableHash(input.changes ?? {}),
  // Без явного id ответ относится к последнему показу треда: другой показ - другая операция.
  idempotencyPredecessor: async (input, host, threadId) => {
    const deps = host.supplierCards;
    if (deps === undefined || input.requestId !== undefined) return '';
    return (await pendingSupplierRequest(deps.state, threadId))?.token ?? '';
  },
  async execute(input, host, context) {
    const userId = assertEmployeeChatTurn(context);
    // Неясный ответ ничего не пишет и запрос не закрывает: показ остаётся ждать ответа.
    if (input.decision === 'unclear') return { status: 'unclear', message: UNCLEAR_TEXT };
    const deps = requirePort(host.supplierCards, MODULE_NAME);
    // Ход сотрудника корневой и не служебный: его тред и есть тред чата, куда ушёл показ.
    const threadId = context.threadId;
    const token = await resolveToken(deps, threadId, input);
    if (token === null) return { status: 'nothing_pending', message: NOTHING_PENDING_TEXT };
    const service = createSupplierCardService(deps);
    const ref = await service.lookup(token);
    if (ref === null) return result({ kind: 'unknown_request' });
    // Показ другого агента (другого бота) этим ответом не подтверждается.
    if (ref.agentId !== context.agentId) return result({ kind: 'unknown_request' });
    if (ref.kind !== 'pair_note') {
      const access = requirePort(deps.access, 'проверка прав');
      const verdict = await confirmCardVerdict(access, { userId, botId: ref.agentId });
      // Сбой справочника - исключение (не кэшируется), а не результат-отказ: иначе тот же ответ
      // на тот же показ после восстановления вернул бы сохранённый отказ.
      if (verdict === 'unavailable') throw confirmCardUnavailableError();
      if (verdict === 'denied') return { status: 'access_denied', message: ACCESS_DENIED_TEXT };
    }
    const identity = { token, userId, threadId };
    const decision = input.decision;
    if (decision === 'cancel') return result(await service.cancel(identity));
    if (input.changes !== undefined) {
      // Владелец и тред запроса сверяются до поправки: чужой запрос не меняется.
      if (ref.ownerUserId !== userId) return result({ kind: 'wrong_owner' });
      if (ref.threadId !== threadId) return result({ kind: 'wrong_thread' });
      if (!(await applyChanges(deps, token, input.changes))) {
        throw new DomainError('invalid_input', CHANGES_NOT_ALLOWED_TEXT);
      }
    }
    const action: Exclude<SupplierCardAction, 'cancel'> = decision;
    return result(await service.press({ ...identity, action }));
  },
});
