import { z } from 'zod';
import { PRICE_FILE_STALE_MONTHS } from '../../kit/domain/price-file-date';
import { daysSince, isPriceStale, priceFreshness } from '../../kit/domain/price-schedule';
import { defineTool } from '@business-ai/core';
import { listAllSuppliers } from '../shared/supplier-email-index';
import type { PricesDeps } from './deps';
import { loadAllPriceUploads } from './price-state';

/** Сколько неактуальных поставщиков показываем за вызов. */
const STALE_LISTED_LIMIT = 50;

const staleSchema = z.object({
  supplierId: z.string(),
  name: z.string(),
  lastUpdate: z.string(),
  daysSinceUpdate: z.number().int(),
  hasEmail: z.boolean(),
});
type StaleSupplier = z.infer<typeof staleSchema>;

/** Поставщики, чей прайс в базе не обновлялся дольше срока. */
export const listStalePriceSuppliers = defineTool<
  Record<string, never>,
  { suppliers: StaleSupplier[]; more: number },
  PricesDeps
>({
  name: 'listStalePriceSuppliers',
  description:
    `Поставщики с прайсом в базе, который не обновлялся дольше ${PRICE_FILE_STALE_MONTHS} ` +
    'календарных месяцев (от даты последней загрузки прайса). Поставщики без прайса в базе ' +
    'не входят в список. Письма поставщикам агент не отправляет.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    suppliers: z.array(staleSchema),
    more: z.number().int(),
  }),
  async execute(_input, deps) {
    const now = deps.clock.now();
    const stale: StaleSupplier[] = [];
    // Даты загрузки всех поставщиков - один проход по пространству, а не get на каждого.
    const uploadOf = await loadAllPriceUploads(deps);
    // Все поставщики постранично: перечень с лимитом оставлял «хвост» без напоминаний.
    for (const supplier of await listAllSuppliers(deps.suppliers)) {
      // Дата загрузки файла, а не правки позиции словами сотрудника (R4-ALG-11).
      // Прайс поставщика читается только если даты загрузки нет (или она не разбирается):
      // иначе `priceFreshness` вернёт её, а чтение всего прайса было бы лишним (R5-CORE-8).
      const upload = uploadOf(supplier.id);
      const uploadKnown = upload !== null && Number.isFinite(Date.parse(upload));
      const last = priceFreshness(
        upload,
        uploadKnown ? [] : await deps.prices.listBySupplier(supplier.id),
      );
      if (last === null || !isPriceStale(last, now, deps.businessTimeZone)) continue;
      stale.push({
        supplierId: supplier.id,
        name: supplier.name,
        lastUpdate: last,
        daysSinceUpdate: daysSince(last, now),
        hasEmail: supplier.email !== undefined,
      });
    }
    stale.sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);
    return {
      suppliers: stale.slice(0, STALE_LISTED_LIMIT),
      more: Math.max(0, stale.length - STALE_LISTED_LIMIT),
    };
  },
});
