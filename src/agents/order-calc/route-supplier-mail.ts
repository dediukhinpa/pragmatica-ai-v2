import { z } from 'zod';
import { defineTool } from '@business-ai/core';
import { assertEmployeeChatTurn } from '@business-ai/core';
import type { OrderCalcDeps } from './deps';
import { assertOrderOwner } from './order-access';
import { routeMailByAnswer } from './reply-routing';

interface RouteInput {
  requestId: string;
  supplierId?: string | undefined;
  mailCode?: string | undefined;
}

const ROUTE_STATUSES = [
  'assigned',
  'already_assigned',
  'not_found',
  'ambiguous',
  'needs_supplier',
] as const;

interface RouteOutput {
  status: (typeof ROUTE_STATUSES)[number];
  /** Заявка, к которой письмо отнесено (assigned, already_assigned). */
  requestId?: string | undefined;
  /** Коды писем, из которых надо выбрать (ambiguous). */
  mailCodes?: string[] | undefined;
  /** Поставщики заявки с этим адресом, из которых надо выбрать (needs_supplier). */
  supplierIds?: string[] | undefined;
}

/**
 * Отнести письмо поставщика к заявке по ответу менеджера в чате (вопрос «к какой заявке
 * отнести письмо» задаёт код; кнопок нет, решение владельца 26.10.2026). Пишет то же решение,
 * что прежняя кнопка, только в ходе сотрудника в чате: письмо, пересказанное в другом письме
 * или в плановом запуске, к заявке не привязать.
 */
export const routeSupplierMail = defineTool<RouteInput, RouteOutput, OrderCalcDeps>({
  name: 'routeSupplierMail',
  description:
    'Отнести письмо поставщика к заявке по ответу менеджера на вопрос «к какой заявке ' +
    'отнести письмо» («отнеси к заявке пледы от 28.10»). requestId — заявка, которую назвал ' +
    'менеджер (по названию); ' +
    'mailCode — код письма из вопроса (#a1b2c3), если менеджер его назвал или писем ' +
    'несколько; supplierId — если у заявки несколько поставщиков с этим адресом. Вызывай ' +
    'только по явному ответу менеджера, не угадывай. assigned: письмо стало ответом по заявке, ' +
    'прочитай его readSupplierReplies. ambiguous / needs_supplier: переспроси менеджера, ' +
    'какое письмо или какой поставщик. not_found: такого письма на разнесении в этом чате нет.',
  sideEffect: true,
  inputSchema: z.object({
    requestId: z.string().min(1),
    supplierId: z.string().min(1).optional(),
    mailCode: z.string().min(1).optional(),
  }),
  outputSchema: z.object({
    status: z.enum(ROUTE_STATUSES),
    requestId: z.string().optional(),
    mailCodes: z.array(z.string()).optional(),
    supplierIds: z.array(z.string()).optional(),
  }),
  idempotencyKey: (input) =>
    `order-route-mail:${input.requestId}:${input.mailCode ?? ''}:${input.supplierId ?? ''}`,
  // Ответ даётся в своём треде: тот же ответ из другого треда проверяется заново.
  idempotencyPredecessor: async (_input, _deps, threadId) => threadId,
  async execute(input, deps, context) {
    const userId = assertEmployeeChatTurn(context);
    await assertOrderOwner(deps, input.requestId, context);
    const outcome = await routeMailByAnswer(deps, {
      requestId: input.requestId,
      supplierId: input.supplierId,
      mailCode: input.mailCode,
      userId,
      threadId: context.threadId,
    });
    switch (outcome.kind) {
      case 'assigned':
      case 'already_assigned':
        return { status: outcome.kind, requestId: outcome.requestId };
      case 'ambiguous_mail':
        return { status: 'ambiguous', mailCodes: outcome.mailCodes };
      case 'needs_supplier':
        return { status: 'needs_supplier', supplierIds: outcome.supplierIds };
      case 'no_pending':
      case 'unknown_mail':
      case 'unknown_request':
      case 'wrong_thread':
      case 'no_identity':
        return { status: 'not_found' };
    }
  },
});
