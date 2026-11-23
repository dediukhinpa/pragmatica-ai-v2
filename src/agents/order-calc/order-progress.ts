import { z } from 'zod';
import { daysBetween, localDateKey } from '@business-ai/core';
import { readState, writeState } from '@business-ai/core';
import { ORDER_CLOSED_NAMESPACE, type OrderCalcDeps } from './deps';
import { loadReplies, type ReplyChannel, type StoredReply } from './reply-store';
import { sentAtFor, type SentRecord } from './state';

/**
 * Ход заказа по данным системы (не по почте): кому запрос подготовлен/отправлен, кто и по какому
 * каналу ответил, у кого записано КП. Общий источник для инструмента `orderStatus` и утренней
 * сводки: ответ из любого канала (письмо, телефон, мессенджер) считается ответом.
 */

/** Подписи каналов ответа для сотрудника. */
export const CHANNEL_NAMES: Record<ReplyChannel, string> = {
  email: 'почта',
  phone: 'телефон',
  messenger: 'мессенджер',
  other: 'другой канал',
};

const closedSchema = z.object({ closedAt: z.string(), closedBy: z.string().min(1) });

/** Закрыт ли заказ сотрудником (явное «заказ закрыт»). */
export async function isOrderClosed(deps: OrderCalcDeps, requestId: string): Promise<boolean> {
  return (await readState(deps.state, ORDER_CLOSED_NAMESPACE, requestId, closedSchema)) !== null;
}

/** Закрыть заказ: запись одна на заявку, повтор не меняет первую. */
export async function closeOrderRecord(
  deps: OrderCalcDeps,
  requestId: string,
  closedBy: string,
): Promise<boolean> {
  if (await isOrderClosed(deps, requestId)) return false;
  await writeState(deps.state, ORDER_CLOSED_NAMESPACE, requestId, {
    closedAt: deps.clock.now().toISOString(),
    closedBy,
  });
  return true;
}

/** Ответ поставщика, засчитанный как ответ. */
export interface CountedReply {
  replyId: string;
  channel: ReplyChannel;
  at: string | undefined;
  declined: boolean;
}

/** Ход по одному поставщику заявки. */
export interface SupplierProgress {
  supplierId: string;
  name: string;
  /** Когда запрос подготовлен/отправлен; нет - запрос по этому поставщику не готовили. */
  requestAt: string | undefined;
  replies: CountedReply[];
  /** Явный отказ поставщика давать КП. */
  declined: boolean;
  quoteRecorded: boolean;
}

/** Ход по заявке. */
export interface OrderProgress {
  requestId: string;
  closed: boolean;
  /** Запись прежнего формата: письмо ушло из системы (иначе текст подготовлен в чате). */
  legacySent: boolean;
  /** Самый ранний момент подготовки/отправки запроса. */
  firstSentAt: string | undefined;
  suppliers: SupplierProgress[];
}

/**
 * Засчитывается ли ответ: письмо - только с подтверждённым отправителем; любой ответ - только
 * полученный после запроса. Ответ, записанный сотрудником (телефон, мессенджер), доверенный.
 */
function countsAsAnswer(reply: StoredReply, requestAt: string | undefined): boolean {
  if (reply.channel === 'email' && reply.senderUnverified === true) return false;
  if (requestAt === undefined || reply.receivedAt === undefined) return true;
  return Date.parse(reply.receivedAt) >= Date.parse(requestAt);
}

/** Поставщики, которым по заявке готовили/отправляли запрос, по возрастанию id. */
export function sentSupplierIds(record: SentRecord): string[] {
  return [...new Set([...record.supplierIds, ...Object.keys(record.sentBySupplier)])].sort();
}

/** Собрать ход по заявке. `names` - кэш названий на время одного прогона. */
export async function loadOrderProgress(
  deps: OrderCalcDeps,
  requestId: string,
  record: SentRecord | null,
  supplierIds: readonly string[],
  names: Map<string, string> = new Map(),
  unknownName = 'поставщик без названия',
): Promise<OrderProgress> {
  const replies = await loadReplies(deps.state, requestId);
  const suppliers: SupplierProgress[] = [];
  for (const supplierId of supplierIds) {
    const requestAt = record === null ? undefined : sentAtFor(record, supplierId);
    const counted = replies
      .filter((reply) => reply.supplierId === supplierId && countsAsAnswer(reply, requestAt))
      .map((reply) => ({
        replyId: reply.id,
        channel: reply.channel,
        at: reply.receivedAt,
        declined: reply.declined === true,
      }));
    let name = names.get(supplierId);
    if (name === undefined) {
      name = (await deps.suppliers.get(supplierId))?.name ?? unknownName;
      names.set(supplierId, name);
    }
    suppliers.push({
      supplierId,
      name,
      requestAt,
      replies: counted,
      declined: counted.some((reply) => reply.declined),
      quoteRecorded: (await deps.quotes.get(requestId, supplierId)) !== null,
    });
  }
  const sentTimes = suppliers
    .map((supplier) => supplier.requestAt)
    .filter((at): at is string => at !== undefined)
    .sort();
  return {
    requestId,
    closed: await isOrderClosed(deps, requestId),
    legacySent: record?.state === 'sent',
    firstSentAt: sentTimes[0],
    suppliers,
  };
}

/** Поставщик «закрыт»: КП записано либо явный отказ. */
export function isSupplierResolved(supplier: SupplierProgress): boolean {
  return supplier.quoteRecorded || supplier.declined;
}

/**
 * Заказ открыт: запросы подготовлены/отправлены, заказ не закрыт, и есть поставщик, по
 * которому запрос ушёл, но нет ни КП, ни отказа.
 */
export function isOrderOpen(progress: OrderProgress): boolean {
  if (progress.closed) return false;
  return progress.suppliers.some(
    (supplier) => supplier.requestAt !== undefined && !isSupplierResolved(supplier),
  );
}

/** Сколько календарных дней (по поясу бизнеса) прошло от момента до сегодня. */
export function daysSince(iso: string, today: Date, timezone: string): number {
  return daysBetween(localDateKey(new Date(iso), timezone), localDateKey(today, timezone));
}
