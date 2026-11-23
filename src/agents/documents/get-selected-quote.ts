import { z } from 'zod';
import { describeQuoteGap } from '../../kit/domain/quotes';
import { parseIsoDeadline } from '../../kit/domain/iso-datetime';
import { quoteLineSchema, type QuoteLine } from '../../kit/domain/models';
import { quoteTotal } from '../../kit/domain/supplier-document';
import { defineTool } from '@business-ai/core';
import { requirePort } from '@business-ai/core';
import type { DocumentsDeps } from './deps';

interface SelectedQuoteOutput {
  found: boolean;
  currency?: string | undefined;
  lines: QuoteLine[];
  total?: number | undefined;
  deliveryDays?: number | undefined;
  paymentTerms?: string | undefined;
  validUntil?: string | undefined;
  expired: boolean;
  receivedAt?: string | undefined;
  /** Чего не хватает в КП (человекочитаемо). */
  gaps: string[];
}

/**
 * Условия КП поставщика, с которым готовят документ. Какое КП «выбранное», определяет человек:
 * сотрудник называет поставщика, агент победителя не выбирает.
 */
export const getSelectedQuote = defineTool<
  { requestId: string; supplierId: string },
  SelectedQuoteOutput,
  DocumentsDeps
>({
  name: 'getSelectedQuote',
  description:
    'Условия КП поставщика supplierId по заявке requestId (их сохранил «Поиск поставщика (ИИ ' +
    'агент)»): ' +
    'позиции, цены, количества, итог, срок поставки, условия оплаты, срок действия, чего не ' +
    'хватает. found=false: КП не сохранено, спроси сотрудника (нет данных - собирай без КП, ' +
    'в чек-листе будет пометка). Поставщика называет ' +
    'сотрудник; ты его не выбираешь.',
  inputSchema: z.object({ requestId: z.string().min(1), supplierId: z.string().min(1) }),
  outputSchema: z.object({
    found: z.boolean(),
    currency: z.string().optional(),
    lines: z.array(quoteLineSchema),
    total: z.number().optional(),
    deliveryDays: z.number().optional(),
    paymentTerms: z.string().optional(),
    validUntil: z.string().optional(),
    expired: z.boolean(),
    receivedAt: z.string().optional(),
    gaps: z.array(z.string()),
  }),
  async execute(input, deps) {
    const quotes = requirePort(deps.quotes, 'хранилище КП');
    const quote = await quotes.get(input.requestId, input.supplierId);
    if (quote === null) return { found: false, lines: [], expired: false, gaps: [] };
    const now = deps.clock?.now();
    return {
      found: true,
      currency: quote.currency,
      lines: quote.lines,
      total: quoteTotal(quote),
      deliveryDays: quote.deliveryDays,
      paymentTerms: quote.paymentTerms,
      validUntil: quote.validUntil,
      expired:
        now !== undefined &&
        quote.validUntil !== undefined &&
        // Дата без времени означает конец суток по МСК (D-14), а не её начало.
        (parseIsoDeadline(quote.validUntil) ?? Date.parse(quote.validUntil)) < now.getTime(),
      receivedAt: quote.receivedAt,
      gaps: quote.gaps.map(describeQuoteGap),
    };
  },
});
