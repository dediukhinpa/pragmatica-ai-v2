import {
  MemoryChatChannel,
  MemoryFileSource,
  MemoryMailboxDirectory,
  MemoryWebSearch,
} from '@business-ai/adapters';
import { MemorySupplierRepository } from '../../src/kit/adapters/memory/repositories.owned';
import { parseEmailDraftButton } from '@business-ai/core';
import type { PriceItem, Supplier } from '../../src/kit/domain/models';
import type { PriceRepository } from '../../src/kit/ports/repositories.owned';
import type { WebSearchHit, WebSearchOptions } from '@business-ai/core';
import type { priceRowSchema } from '../state';
import type { z } from 'zod';

/** Срок жизни mtime файлов на «диске»: значение не важно, нужна только стабильность. */
const FILE_MTIME = 1_000;
type PriceRow = z.output<typeof priceRowSchema>;
/** Поставщики в памяти. */
export async function seedSuppliers(
  suppliers: MemorySupplierRepository,
  items: readonly Supplier[],
): Promise<void> {
  for (const supplier of items) await suppliers.upsert(supplier);
}
/** Прайсы в памяти: по одному импорту на поставщика. */
export async function seedPrices(
  prices: PriceRepository,
  rows: readonly PriceRow[],
): Promise<void> {
  const bySupplier = new Map<string, PriceItem[]>();
  for (const row of rows) {
    const item: PriceItem = {
      supplierId: row.supplierId,
      productName: row.productName,
      price: row.price,
      currency: row.currency,
      date: row.date,
      ...(row.sku === undefined ? {} : { sku: row.sku }),
    };
    bySupplier.set(row.supplierId, [...(bySupplier.get(row.supplierId) ?? []), item]);
  }
  for (const [supplierId, items] of bySupplier) {
    await prices.saveImport(supplierId, items, `eval-seed-${supplierId}`);
  }
}
/** Файлы на «диске». */
export function seedFiles(
  files: MemoryFileSource,
  items: ReadonlyArray<{ path: string; text: string }>,
): void {
  const encoder = new TextEncoder();
  for (const file of items) files.put(file.path, encoder.encode(file.text), FILE_MTIME);
}
/** Сколько файлов в исходящих чата содержат подстроку (файлы - текст UTF-8). */
export function chatFileContainsCount(chat: MemoryChatChannel, needle: string): number {
  return chat.outbox.filter(
    (entry) =>
      entry.file !== undefined && new TextDecoder().decode(entry.file.content).includes(needle),
  ).length;
}
/** Ящики сотрудников из состояния кейса; пустой список - режима почты нет (undefined). */
export function buildMailboxes(
  items: ReadonlyArray<{ userId: string; address: string }>,
): MemoryMailboxDirectory | undefined {
  if (items.length === 0) return undefined;
  const directory = new MemoryMailboxDirectory();
  for (const item of items) directory.connect(item.userId, item.address);
  return directory;
}
/** Сколько черновиков писем показано в чате (сообщения с кнопкой «Отправить»). */
export function draftsShownCount(chat: MemoryChatChannel): number {
  return chat.outbox.filter((entry) =>
    (entry.message?.buttons ?? []).some(
      (button) => parseEmailDraftButton(button.id)?.action === 'send',
    ),
  ).length;
}
/** Приветствие и вводная строка письма-запроса по шаблону ТЗ (разд. 5): признак текста запроса. */
const REQUEST_TEXT_MARKER = 'Добрый день.\n\nПрошу рассчитать:';
/** Сколько текстов запроса поставщикам показано в чате (по одному сообщению на поставщика). */
export function requestTextsShownCount(chat: MemoryChatChannel): number {
  return chat.outbox.filter((entry) => entry.message?.text.includes(REQUEST_TEXT_MARKER) === true)
    .length;
}
/** Сколько сообщений менеджеру содержат подстроку (без учёта регистра). */
export function chatTextContainsCount(chat: MemoryChatChannel, needle: string): number {
  const wanted = needle.toLowerCase();
  return chat.outbox.filter((entry) => entry.message?.text.toLowerCase().includes(wanted) === true)
    .length;
}
/** Веб-поиск в памяти, который помнит запросы: так видно, что именно строила модель. */
export class RecordingWebSearch extends MemoryWebSearch {
  readonly queries: string[] = [];

  override async search(
    query: string,
    limit: number,
    options?: WebSearchOptions,
  ): Promise<WebSearchHit[]> {
    this.queries.push(query);
    return super.search(query, limit, options);
  }
}
/** Сколько писем ушло из ящиков сотрудников (каждому получателю - отдельное письмо). */
export function mailSentCount(
  directory: MemoryMailboxDirectory | undefined,
  userIds: readonly string[],
): number {
  if (directory === undefined) return 0;
  return userIds.reduce((sum, userId) => sum + directory.sentBy(userId).length, 0);
}
