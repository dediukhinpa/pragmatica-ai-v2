import { z } from 'zod';
import { defineTool } from '@business-ai/core';
import type { OrderCalcDeps } from './deps';
import { predecessorOf } from '@business-ai/core';
import { loadProposal, loadSent, orderRecipient } from './state';
import { requestLabel } from './request-title';
import { reminderRound } from './schedule-reminder';

interface RemindInput {
  requestId: string;
}

/** Текст напоминания: только название заявки, без контактов и других ПДн (id не показываем). */
function reminderText(label: string): string {
  return (
    `Заявка «${label}»: мы подготовили запросы поставщикам сутки назад. ` +
    'Проверьте, пожалуйста, статус вручную: ответ мог прийти на почту, в мессенджере или по ' +
    'телефону.'
  );
}

/** Напомнить менеджеру по закупу проверить ответы. Разбора ответов агент не делает. */
export const remindManager = defineTool<RemindInput, { delivered: boolean }, OrderCalcDeps>({
  name: 'remindManager',
  description:
    'Отправить менеджеру по закупу напоминание «проверьте статус ответов поставщиков» по ' +
    'заявке requestId. Свободный текст не передаётся. Ответы поставщиков ты не разбираешь.',
  sideEffect: true,
  inputSchema: z.object({ requestId: z.string().min(1) }),
  outputSchema: z.object({ delivered: z.boolean() }),
  idempotencyKey: (input) => `order-remind:${input.requestId}`,
  // Напоминание привязано к раунду рассылки: после новой рассылки (появился контакт)
  // менеджер получит новое напоминание, а не глухой возврат первого.
  idempotencyPredecessor: async (input, deps) =>
    predecessorOf(reminderRound(await loadSent(deps, input.requestId))),
  async execute(input, deps) {
    const round = predecessorOf(reminderRound(await loadSent(deps, input.requestId)));
    const proposal = await loadProposal(deps, input.requestId);
    const threadId = await orderRecipient(deps, input.requestId, proposal);
    await deps.chat.reply(
      threadId,
      { text: reminderText(await requestLabel(deps, input.requestId)) },
      `order-remind:${input.requestId}:${round}`,
    );
    return { delivered: true };
  },
});
