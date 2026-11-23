import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import { readState, writeState } from '@business-ai/core';
import type { SystemContextBlock } from '@business-ai/core';
import { ORDER_CLOSED_NAMESPACE, type OrderCalcDeps } from './deps';
import { titledRequest } from './request-title';
import { REMINDER_BLOCK_ID, reminderContextLines } from './reminder-reply';
import { loadCompleteness, loadProposal, loadSelection, loadSent } from './state';

/**
 * Активная заявка треда (этап 135). История диалога хранит только тексты, без вызовов
 * инструментов, поэтому на втором ходу модель не знает `requestId` и заводит заявку заново
 * (бой 29.10: две заявки за 4 минуты). Код помнит заявку сам: запись ключом - тред, значение -
 * последняя принятая в нём заявка. Пространство в `WORKFLOW_STATE_STALE_SCOPE` не входит:
 * запись одна на тред и перезаписывается новой заявкой.
 */
export const ACTIVE_REQUEST_NAMESPACE = 'order-calc:active-request';
/** Стабильное имя системного блока хода (для журнала счётчиков). */
export const ACTIVE_REQUEST_BLOCK_ID = 'active_request';
/** Сколько позиций показываем модели в блоке: остальное она увидит инструментами. */
const BLOCK_ITEMS_MAX = 20;
/** Длина названия позиции в блоке, знаков. */
const BLOCK_ITEM_NAME_MAX_CHARS = 120;

const activeRequestSchema = z.object({ requestId: z.string().min(1), updatedAt: z.string() });

/** Запомнить заявку как активную в треде (новый приём перезаписывает прежнюю). */
export async function setActiveRequest(
  deps: Pick<OrderCalcDeps, 'state' | 'clock'>,
  threadId: string,
  requestId: string,
): Promise<void> {
  await writeState(deps.state, ACTIVE_REQUEST_NAMESPACE, threadId, {
    requestId,
    updatedAt: deps.clock.now().toISOString(),
  });
}

/** Id активной заявки треда, если она ещё есть в репозитории заявок; иначе null. */
export async function activeRequestId(
  deps: Pick<OrderCalcDeps, 'state' | 'requests'>,
  threadId: string,
): Promise<string | null> {
  const record = await readState(
    deps.state,
    ACTIVE_REQUEST_NAMESPACE,
    threadId,
    activeRequestSchema,
  );
  if (record === null) return null;
  return (await deps.requests.get(record.requestId)) === null ? null : record.requestId;
}

/** Этап заявки словами для модели: самый поздний из достигнутых. */
async function stageOf(deps: OrderCalcDeps, requestId: string): Promise<string> {
  const closed = await readState(deps.state, ORDER_CLOSED_NAMESPACE, requestId, z.unknown());
  if (closed !== null) return 'заказ закрыт сотрудником';
  const sent = await loadSent(deps, requestId);
  if (sent !== null) return 'текст запроса поставщикам подготовлен, идёт ожидание ответов';
  if ((await loadSelection(deps, requestId)) !== null) {
    return 'менеджер выбрал поставщиков, нужен текст запроса (prepareSupplierRequestText)';
  }
  if ((await loadProposal(deps, requestId)) !== null) {
    return 'шорт-лист собран, ждёт выбора менеджера (askManagerToChoose)';
  }
  if ((await loadCompleteness(deps, requestId)) !== null) {
    return 'заявка сохранена, полнота проверена, шорт-лист ещё не собран';
  }
  return 'заявка сохранена, шорт-лист ещё не собран';
}

/**
 * Системный блок хода с активной заявкой треда: id, название, этап и позиции. Нет активной
 * заявки (или её нет в репозитории) - null. Подаётся модели отдельным сообщением на каждый ход
 * и в историю треда не попадает: этап всегда свежий, а не пересказ старого сообщения.
 */
export async function activeRequestBlock(
  deps: OrderCalcDeps,
  threadId: string,
): Promise<SystemContextBlock | null> {
  const text = await activeRequestText(deps, threadId);
  return text === null ? null : { id: ACTIVE_REQUEST_BLOCK_ID, text };
}

/**
 * Системные блоки хода агента заказов: активная заявка треда и (этап 226, при включённом
 * ответе на напоминание) справка о недавней утренней сводке. Справка - отдельный блок, и её
 * сбой (запись состояния, схема) блок активной заявки не убивает: без справки ход идёт как
 * раньше, в журнал уходит только код ошибки. Сводку отправляет код мимо истории, поэтому без
 * справки ответ на неё модель не свяжет.
 */
export async function activeRequestBlocks(
  deps: OrderCalcDeps,
  threadId: string,
): Promise<SystemContextBlock[]> {
  const blocks: SystemContextBlock[] = [];
  const active = await activeRequestBlock(deps, threadId);
  if (active !== null) blocks.push(active);
  try {
    const reminder = await reminderContextLines(deps, threadId);
    if (reminder !== null) blocks.push({ id: REMINDER_BLOCK_ID, text: reminder.join('\n') });
  } catch (error) {
    deps.log?.('order_reminder_context_failed', {
      code: error instanceof DomainError ? error.code : 'unexpected',
    });
  }
  return blocks;
}

/** Текст блока активной заявки треда: id, название, этап и позиции; нет заявки - null. */
async function activeRequestText(deps: OrderCalcDeps, threadId: string): Promise<string | null> {
  const requestId = await activeRequestId(deps, threadId);
  if (requestId === null) return null;
  const request = await deps.requests.get(requestId);
  if (request === null) return null;
  const title = (await titledRequest(deps, requestId))?.title ?? '';
  const quantityText = (item: { quantity?: number | undefined }): string =>
    item.quantity === undefined ? 'количество не указано,' : String(item.quantity);
  const shown = request.items.slice(0, BLOCK_ITEMS_MAX).map((item, index) => {
    const name = item.name.length > BLOCK_ITEM_NAME_MAX_CHARS
      ? `${item.name.slice(0, BLOCK_ITEM_NAME_MAX_CHARS)}…`
      : item.name;
    return `${index + 1}. ${name} - ${quantityText(item)} ${item.unit}`;
  });
  const more = request.items.length - shown.length;
  const lines = [
    '[Справка системы: активная заявка этого диалога; это не просьба сотрудника.]',
    `requestId: ${requestId}`,
    ...(title === '' ? [] : [`Название: ${title}`]),
    `Этап: ${await stageOf(deps, requestId)}`,
    'Позиции:',
    ...shown,
    ...(more > 0 ? [`... и ещё ${more}`] : []),
    'Продолжая работу над этой заявкой, передавай этот requestId и НЕ сохраняй заявку заново ' +
      'через saveIntakeRequest. Новую заявку заводи, только если сотрудник прислал другую.',
  ];
  return lines.join('\n');
}
