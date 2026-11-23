import { z } from 'zod';
import { DomainError, type ValidationIssue } from '@business-ai/core';
import { validateShortlistSelection } from '../../kit/domain/shortlist';
import { type Supplier } from '../../kit/domain/models';
import { schemaValidator, type AgentValidator } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import type { OrderCalcDeps } from './deps';
import { assertOrderOwner } from './order-access';
import { closeChoiceAsk, loadChoiceConfirmation } from './choice-confirmation';
import { predecessorOf } from '@business-ai/core';
import { loadProposal, loadSelection, loadSent, saveSelection } from './state';

interface RecordSelectionInput {
  requestId: string;
  /**
   * Необязателен и набор не задаёт: фиксируется накопленное подтверждение менеджера. Если
   * передан, должен входить в него (иначе отказ): модель не может подменить набор.
   */
  supplierIds?: string[] | undefined;
}
interface RecordSelectionOutput {
  requestId: string;
  selected: number;
  /** Выбранные без контакта: им запрос не уйдёт, пока менеджер не даст контакт. */
  withoutContact: string[];
}

const inputSchema = z.object({
  requestId: z.string().min(1),
  supplierIds: z.array(z.string().min(1)).min(1).optional(),
});

/** Ключ: заявка; какой именно набор - различает состояние-предшественник. */
function selectionKey(input: RecordSelectionInput): string {
  return `order-select:${input.requestId}`;
}

/**
 * Подтверждение человека (S-01): набор берётся из того, что менеджер выбрал через канал
 * (ответ в чате, записанный recordManagerChoice, или старые кнопки с «Готово»). Набор в
 * аргументах модели его не подменяет.
 */
async function confirmationIssues(
  input: RecordSelectionInput,
  proposalVersion: string,
  deps: OrderCalcDeps,
): Promise<ValidationIssue[]> {
  const confirmation = await loadChoiceConfirmation(deps.state, input.requestId);
  if (confirmation === null || confirmation.version !== proposalVersion) {
    return [
      {
        code: 'selection_unconfirmed',
        message:
          'Менеджер ещё не выбрал поставщиков: вызовите askManagerToChoose и ждите его ответа. ' +
          'Когда он ответил, запишите выбор recordManagerChoice.',
      },
    ];
  }
  const outside = (input.supplierIds ?? []).filter((id) => !confirmation.supplierIds.includes(id));
  if (outside.length > 0) {
    return [
      {
        code: 'selection_not_confirmed',
        message:
          `Менеджер не выбирал этих поставщиков: ${outside.join(', ')}. ` +
          'Фиксируйте только тех, кого он выбрал.',
      },
    ];
  }
  if (!confirmation.done) {
    return [
      {
        code: 'selection_not_finished',
        message:
          'Менеджер ещё не завершил выбор. Ничего не фиксируйте и не отправляйте: спросите, ' +
          'кому готовить запросы, и запишите ответ recordManagerChoice.',
      },
    ];
  }
  return [];
}

/** Выбор менеджера — только из предложенного шорт-листа заявки. */
export const selectionValidator: AgentValidator<OrderCalcDeps> = schemaValidator({
  name: 'shortlist-selection',
  tool: 'recordSelection',
  schema: inputSchema,
  async check(input, deps) {
    const proposal = await loadProposal(deps, input.requestId);
    if (proposal === null) {
      return [{ code: 'no_proposal', message: 'Шорт-лист по заявке не собран (buildShortlist).' }];
    }
    const named = input.supplierIds;
    if (named !== undefined) {
      const issues = validateShortlistSelection(named, proposal);
      if (issues.length > 0) return issues;
    }
    return confirmationIssues(input, proposal.version, deps);
  },
});

/**
 * Зафиксировать выбор менеджера: после этого только эти поставщики допустимы как адресаты.
 * Найденные вне базы (веб) заводятся в базу поставщиков под присвоенным id.
 */
export const recordSelection = defineTool<
  RecordSelectionInput,
  RecordSelectionOutput,
  OrderCalcDeps
>({
  name: 'recordSelection',
  description:
    'Зафиксировать выбор менеджера по заявке requestId. Набор берётся из его подтверждения в ' +
    'чате (записан recordManagerChoice), а не из аргументов: supplierIds не нужен. Пока ' +
    'выбор менеджера не записан, фиксация блокируется.',
  sideEffect: true,
  inputSchema,
  outputSchema: z.object({
    requestId: z.string(),
    selected: z.number().int(),
    withoutContact: z.array(z.string()),
  }),
  idempotencyKey: selectionKey,
  // Выбор до операции и подтверждённый набор: возврат A -> B -> A применяется, а повтор при
  // том же наборе - нет.
  idempotencyPredecessor: async (input, deps) => {
    const current = await loadSelection(deps, input.requestId);
    const confirmed = await loadChoiceConfirmation(deps.state, input.requestId);
    return predecessorOf({
      selected: current === null ? null : [...current.supplierIds].sort(),
      confirmed: confirmed === null ? null : [...confirmed.supplierIds].sort(),
      done: confirmed?.done === true,
    });
  },
  async execute(input, deps, context) {
    await assertOrderOwner(deps, input.requestId, context);
    // Состав предложения и завершённость выбора проверил валидатор до вызова.
    const proposal = await loadProposal(deps, input.requestId);
    const confirmation = await loadChoiceConfirmation(deps.state, input.requestId);
    if (confirmation === null || !confirmation.done) {
      throw new DomainError('conflict', 'Менеджер не завершил выбор поставщиков.');
    }
    // Кому запрос уже ушёл, остаётся в выборе: иначе его ответы перестали бы читаться и
    // КП отклонялись бы (R4-AGT-1). Отозвать отправленное письмо нельзя.
    const sent = await loadSent(deps, input.requestId);
    const ids = [...new Set([...confirmation.supplierIds, ...(sent?.supplierIds ?? [])])];
    const withoutContact: string[] = [];
    for (const id of ids) {
      let supplier: Supplier | null = await deps.suppliers.get(id);
      if (supplier === null) {
        const entry = proposal?.entries.find((candidate) => candidate.supplierId === id);
        if (entry === undefined) continue;
        supplier = { id, name: entry.name, email: entry.email };
        await deps.suppliers.upsert(supplier);
      }
      if (supplier.email === undefined) withoutContact.push(id);
    }
    const current = await loadSelection(deps, input.requestId);
    const same =
      current !== null &&
      [...current.supplierIds].sort().join(',') === [...ids].sort().join(',');
    // Тот же набор поверх такого же не переписывается (дата выбора остаётся первой).
    if (!same) {
      await saveSelection(deps, {
        requestId: input.requestId,
        supplierIds: ids,
        createdAt: deps.clock.now().toISOString(),
      });
    }
    // Вопрос закрывается после записи: ни текст, ни старые кнопки его больше не подтвердят.
    await closeChoiceAsk(deps.state, deps.clock, context.threadId, input.requestId);
    return { requestId: input.requestId, selected: ids.length, withoutContact };
  },
});
