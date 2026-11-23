import { z } from 'zod';
import { defineTool } from '@business-ai/core';
import { assertEmployeeChatTurn } from '@business-ai/core';
import type { OrderCalcDeps } from './deps';
import { assertOrderOwner } from './order-access';
import { approveQuoteReplacementByAnswer } from './quote-replacement';

interface ConfirmInput {
  requestId: string;
  supplierId: string;
}

const CONFIRM_STATUSES = ['approved', 'already_approved', 'not_offered', 'expired'] as const;

interface ConfirmOutput {
  status: (typeof CONFIRM_STATUSES)[number];
  /** Ответ, из которого теперь можно записать КП (sourceRef для recordQuote). */
  replyId?: string | undefined;
}

/**
 * Записать решение менеджера «заменить КП поставщика данными нового ответа» по его ответу в
 * чате (вопрос задаёт код при чтении ответов; кнопок нет, решение владельца 26.10.2026). Только
 * в ходе сотрудника в чате: письмо поставщика или плановый запуск замену не одобрят.
 */
export const confirmQuoteReplacement = defineTool<ConfirmInput, ConfirmOutput, OrderCalcDeps>({
  name: 'confirmQuoteReplacement',
  description:
    'Записать согласие менеджера заменить КП поставщика supplierId по заявке requestId данными ' +
    'его нового ответа («замени КП МеталлТорг»). Вызывай только по явному ответу менеджера на ' +
    'вопрос о замене. approved: вызови recordQuote с sourceRef=replyId (только данные этого ' +
    'ответа), затем compareQuotes и sendQuoteSummary. not_offered: вопроса о замене по этому ' +
    'поставщику в этом чате не было. expired: срок решения истёк, прочитай ответы заново.',
  sideEffect: true,
  inputSchema: z.object({ requestId: z.string().min(1), supplierId: z.string().min(1) }),
  outputSchema: z.object({
    status: z.enum(CONFIRM_STATUSES),
    replyId: z.string().optional(),
  }),
  idempotencyKey: (input) => `order-quote-replace-confirm:${input.requestId}:${input.supplierId}`,
  // Тред ответа: то же согласие из другого треда проверяется заново.
  idempotencyPredecessor: async (_input, _deps, threadId) => threadId,
  async execute(input, deps, context) {
    const userId = assertEmployeeChatTurn(context);
    await assertOrderOwner(deps, input.requestId, context);
    const outcome = await approveQuoteReplacementByAnswer(deps, {
      requestId: input.requestId,
      supplierId: input.supplierId,
      userId,
      threadId: context.threadId,
    });
    switch (outcome.kind) {
      case 'approved':
      case 'already_approved':
        return { status: outcome.kind, replyId: outcome.replyId };
      case 'expired':
        return { status: 'expired' };
      case 'unknown_offer':
      case 'wrong_thread':
      case 'no_identity':
        return { status: 'not_offered' };
    }
  },
});
