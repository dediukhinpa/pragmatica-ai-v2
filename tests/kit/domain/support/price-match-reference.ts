// Эталон: реализация до этапа 30 (R5), без оптимизаций. Нужна только тестам эквивалентности.
import type { PriceItem } from '../../../../src/kit/domain/models';
import type { PriceItemQuery, PriceMatch } from '../../../../src/kit/domain/price-match';
import { normalizeProductName, normalizeSku } from './price-diff-reference';

/** Сколько кандидатов показываем в вопросе при неоднозначном совпадении. */
const PRICE_MATCH_MAX_CANDIDATES = 5;

/**
 * Найти позицию в текущем прайсе. Назван артикул - ищем ТОЛЬКО по нему (нормализация как у
 * ключа позиции): если такого артикула нет, правка не переносится на позицию с похожим или
 * даже точно совпавшим названием, а возвращается «не найдено» с кандидатами по названию.
 * Артикул и название указывают на разные позиции - «неоднозначно». Без артикула - точное
 * название (без регистра и лишних пробелов); похожее название не совпадение: кандидаты
 * отдаются человеку.
 */
export function matchPriceItem(items: readonly PriceItem[], query: PriceItemQuery): PriceMatch {
  const sku = query.sku === undefined ? '' : normalizeSku(query.sku);
  const name = query.productName === undefined ? '' : normalizeProductName(query.productName);
  const exact =
    name === '' ? [] : items.filter((item) => normalizeProductName(item.productName) === name);
  const similar =
    name === ''
      ? []
      : items.filter((item) => {
          const candidate = normalizeProductName(item.productName);
          return candidate.includes(name) || name.includes(candidate);
        });
  const limit = (candidates: readonly PriceItem[]): PriceItem[] =>
    [...new Set(candidates)].slice(0, PRICE_MATCH_MAX_CANDIDATES);
  if (sku !== '') {
    const bySku = items.filter((item) => normalizeSku(item.sku ?? '') === sku);
    const [only] = bySku;
    if (bySku.length > 1) return { kind: 'ambiguous', candidates: limit(bySku) };
    if (only === undefined) return { kind: 'none', candidates: limit([...exact, ...similar]) };
    const others = exact.filter((item) => item !== only);
    if (others.length > 0 && !exact.includes(only)) {
      return { kind: 'ambiguous', candidates: limit([only, ...others]) };
    }
    // Название не про найденную позицию, но похоже на другую: не угадываем (R3-ALG-18).
    const isSimilar = (item: PriceItem): boolean => similar.includes(item) || exact.includes(item);
    const otherSimilar = similar.filter((item) => item !== only);
    if (name !== '' && !isSimilar(only) && otherSimilar.length > 0) {
      return { kind: 'ambiguous', candidates: limit([only, ...otherSimilar]) };
    }
    return { kind: 'match', item: only };
  }
  if (name === '') return { kind: 'none', candidates: [] };
  if (exact.length === 1 && exact[0] !== undefined) return { kind: 'match', item: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: limit(exact) };
  return { kind: 'none', candidates: limit(similar) };
}
