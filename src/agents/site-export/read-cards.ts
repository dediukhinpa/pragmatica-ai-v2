import { z } from 'zod';
import { formatPriceWithQualifier } from '../../kit/domain/market-price';
import { type SourceCard } from '../../kit/domain/site-export';
import { defineTool } from '@business-ai/core';
import { unconfirmedLookup } from '../prices/price-proposals';
import { HINT_LIMIT, READ_MAX_TOTAL, READ_PAGE_SIZE, type SiteExportDeps } from './deps';

interface ReadCardsInput {
  query: string;
  cursor: number;
  limit: number;
}
interface ReadCardsOutput {
  cards: Array<Record<string, string | number>>;
  /** Смещение следующей страницы; null, когда карточки кончились. */
  nextCursor: number | null;
  hints: Array<{ documentId: string; snippet: string }>;
  /** Предупреждение: выдача упёрлась в верхнюю границу и могла быть обрезана. */
  warning?: string | undefined;
}

/**
 * Прочитать карточки товаров из базы (цены поставщиков) по запросу, постранично. Поля
 * исходной карточки: sku, name, price, currency, supplierId, updatedAt.
 */
export const readCards = defineTool<ReadCardsInput, ReadCardsOutput, SiteExportDeps>({
  name: 'readCards',
  description:
    'Прочитать карточки товаров из базы по запросу query (название или артикул), страницами: ' +
    'cursor=nextCursor, пока он не null. Поля: sku, name, price, currency, supplierId, ' +
    'updatedAt; unconfirmed (если есть) — справка о свежей неподтверждённой цене не с диска: ' +
    'в карточки сайта её не переносить. hints — документы базы знаний для описаний.',
  inputSchema: z.object({
    query: z.string().min(1),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(READ_PAGE_SIZE).default(READ_PAGE_SIZE),
  }),
  outputSchema: z.object({
    cards: z.array(z.record(z.union([z.string(), z.number()]))),
    nextCursor: z.number().int().nullable(),
    hints: z.array(z.object({ documentId: z.string(), snippet: z.string() })),
    warning: z.string().optional(),
  }),
  async execute(input, deps) {
    // Порт ищет только «первые N»: страница — срез выдачи, курсор — смещение в ней.
    const found = await deps.prices.searchProducts(input.query, READ_MAX_TOTAL);
    const page = found.slice(input.cursor, input.cursor + input.limit);
    const unconfirmedOf = unconfirmedLookup(deps.state);
    const notes = await Promise.all(page.map(unconfirmedOf));
    const cards = page.map((item, index): SourceCard & Record<string, string | number> => ({
      ...(item.sku === undefined ? {} : { sku: item.sku }),
      // Справка о неподтверждённой цене не с диска: в карточку сайта не переносится.
      ...(notes[index] === undefined ? {} : { unconfirmed: notes[index] }),
      name: item.productName,
      price: item.price,
      // Цена «от»/диапазон: нижняя граница в price, признак и готовый текст рядом, чтобы
      // карточка сайта не выдала нижнюю границу за точную цену.
      ...(item.priceQualifier === undefined
        ? {}
        : {
            priceQualifier: item.priceQualifier,
            ...(item.priceMax === undefined ? {} : { priceMax: item.priceMax }),
            priceText: formatPriceWithQualifier({
              amount: item.price,
              currency: item.currency,
              qualifier: item.priceQualifier,
              max: item.priceMax,
            }),
          }),
      currency: item.currency,
      supplierId: item.supplierId,
      updatedAt: item.date,
    }));
    const next = input.cursor + page.length;
    const hints =
      input.cursor === 0 ? await deps.knowledge.search(input.query, HINT_LIMIT) : [];
    return {
      cards,
      nextCursor: next < found.length ? next : null,
      hints: hints.map((hit) => ({ documentId: hit.documentId, snippet: hit.snippet })),
      // Лимит выборки не должен молча резать результат: говорим об этом в предупреждении.
      ...(found.length >= READ_MAX_TOTAL
        ? {
            warning:
              `Выдача достигла предела ${READ_MAX_TOTAL} карточек и могла быть обрезана: ` +
              'уточни запрос.',
          }
        : {}),
    };
  },
});
