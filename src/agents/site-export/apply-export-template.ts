import { z } from 'zod';
import {
  mapCardToTemplate,
  type ExportCard,
  type ExportTemplate,
  type SourceCard,
} from '../../kit/domain/site-export';
import { type PriceItem } from '../../kit/domain/models';
import { recordWorkOwner, toStoredJson } from '@business-ai/core';
import { workSubject } from '../shared/work-owner.owned';
import { defineTool } from '@business-ai/core';
import { cardKey, indexCardSku, listByPrefix, markSkuIndexComplete, partKeyPrefix } from './cards';
import { SKU_LOOKUP_LIMIT, exportNamespace, skuIndexNamespace, type SiteExportDeps } from './deps';

interface ApplyInput {
  exportId: string;
  /** Номер части набора; повтор той же части заменяет её карточки. */
  part: number;
  /** Начать набор заново: прежние карточки удаляются. */
  reset: boolean;
  cards: SourceCard[];
}
interface ApplyOutput {
  exportId: string;
  part: number;
  stored: number;
}

const sourceCardSchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));

/**
 * Цена карточки берётся из базы кодом (R3-SEC-4), а не из значения, которое передала модель:
 * по артикулу ищутся цены поставщиков. Одна цена - она и ставится; цен несколько и они
 * расходятся или артикула в базе нет - поле цены снимается, `validateCards` отметит пустую цену,
 * а решение остаётся за человеком. `hitsBySku` - выдача базы по артикулам всей пачки (один
 * пакетный запрос вместо запроса на карточку, R5-CORE-6).
 */
function withBasePrice(
  card: ExportCard,
  template: ExportTemplate,
  hitsBySku: ReadonlyMap<string, PriceItem[]>,
): ExportCard {
  const priceField = template.priceField;
  if (priceField === undefined) return card;
  const { [priceField]: _ignored, ...rest } = card;
  const sku = card[template.skuField];
  if (typeof sku !== 'string' || sku === '') return rest;
  // Точный артикул (не подстрока и не первые 10 по цене): иначе нужная позиция могла не
  // попасть в выдачу, а цена без валюты склеила бы 100 RUB и 100 USD в «одну цену» (R4-ALG-10).
  const hits = hitsBySku.get(sku) ?? [];
  // Выдача упёрлась в лимит: все цены артикула неизвестны, решать нельзя.
  if (hits.length >= SKU_LOOKUP_LIMIT) return rest;
  const prices = new Map(
    hits.map((hit) => [
      [hit.price, hit.currency, hit.priceQualifier ?? '', hit.priceMax ?? ''].join('\u0000'),
      hit,
    ]),
  );
  const [only] = [...prices.values()];
  // Цена «от» или диапазон в числовое поле карточки сайта не ставится: нижняя граница стала бы
  // точной ценой без признака. Поле остаётся пустым, `validateCards` отметит его человеку.
  if (only?.priceQualifier !== undefined) return rest;
  return prices.size === 1 && only !== undefined ? { ...rest, [priceField]: only.price } : rest;
}

/** Артикулы пачки карточек (после приведения к шаблону), без повторов. */
function skusOf(cards: readonly ExportCard[], template: ExportTemplate): string[] {
  const skus = new Set<string>();
  for (const card of cards) {
    const sku = card[template.skuField];
    if (typeof sku === 'string' && sku !== '') skus.add(sku);
  }
  return [...skus];
}

/**
 * Повтор части заменяет её карточки (R9-A2-02): карточки этой части с номерами за новой
 * длиной удаляются из набора. Раньше они оставались, и на сайт уходили карточки, которые
 * модель из части убрала. Удаляются только записи этого набора в нашем хранилище и только
 * этой части (их создал этот же инструмент); на сайте ничего не удаляется - у порта сайта
 * удаления нет, а уже опубликованная прежде карточка остаётся на сайте, как и раньше.
 */
async function dropStalePartCards(
  deps: SiteExportDeps,
  namespace: string,
  part: number,
  kept: number,
): Promise<void> {
  const keptKeys = new Set(Array.from({ length: kept }, (_, index) => cardKey(part, index)));
  for (const entry of await listByPrefix(deps.state, namespace, partKeyPrefix(part))) {
    if (!keptKeys.has(entry.key)) await deps.state.delete(namespace, entry.key);
  }
}

/**
 * Привести карточки к шаблону выгрузки и сложить в набор. Набор живёт в состоянии, а не в
 * контексте модели: дальше карточки адресуются по `exportId`.
 */
export const applyExportTemplate = defineTool<ApplyInput, ApplyOutput, SiteExportDeps>({
  name: 'applyExportTemplate',
  description:
    'Применить шаблон выгрузки к карточкам из readCards и сохранить в набор exportId. ' +
    'Остаются только поля шаблона. part — номер части (с 0); reset=true только в первом ' +
    'вызове нового набора. Цену код берёт из базы по артикулу (твоя игнорируется). ' +
    'Структуру и значения не правит: ошибки найдёт validateCards.',
  inputSchema: z.object({
    exportId: z.string().min(1),
    part: z.number().int().nonnegative(),
    reset: z.boolean().default(false),
    cards: z.array(sourceCardSchema).min(1),
  }),
  outputSchema: z.object({
    exportId: z.string(),
    part: z.number().int(),
    stored: z.number().int(),
  }),
  async execute(input, deps, context) {
    const namespace = exportNamespace(input.exportId);
    if (input.reset) await deps.state.clear(namespace);
    if (input.reset) await deps.state.clear(skuIndexNamespace(input.exportId));
    // Новый набор (сброс или ещё пустой): каждая его карточка пройдёт через индекс артикулов.
    if (input.reset || (await deps.state.list(namespace, null, 1)).length === 0) {
      await markSkuIndexComplete(deps, input.exportId);
    }
    const mapped = input.cards.map((source) => mapCardToTemplate(source, deps.template));
    const hitsBySku =
      deps.template.priceField === undefined
        ? new Map<string, PriceItem[]>()
        : await deps.prices.listBySkus(skusOf(mapped, deps.template), SKU_LOOKUP_LIMIT);
    for (const [index, mappedCard] of mapped.entries()) {
      const card = withBasePrice(mappedCard, deps.template, hitsBySku);
      const key = cardKey(input.part, index);
      // Сначала индекс: запись индекса без карточки безвредна (проверяется по содержимому), а
      // карточка без записи индекса в наборе с полным индексом не нашлась бы по артикулу.
      await indexCardSku(deps, input.exportId, key, card);
      await deps.state.put(namespace, key, toStoredJson(card));
    }
    await dropStalePartCards(deps, namespace, input.part, mapped.length);
    // Набор начал сотрудник в чате: итог и файл карточек вернутся к нему (первый владелец).
    await recordWorkOwner(deps.state, workSubject.export(input.exportId), context);
    return { exportId: input.exportId, part: input.part, stored: input.cards.length };
  },
});
