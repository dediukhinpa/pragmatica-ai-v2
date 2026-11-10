import {
  buildSupplierRatingFacts,
  canonicalFactsJson,
  type SupplierRatingFacts,
} from '../../kit/domain/supplier-rating-facts';
import { computeSupplierRating } from '../../kit/domain/supplier-rating';
import { parseSupplierRatingVerdict } from '../../kit/domain/supplier-rating-verdict';
import { type SupplierCard } from '../../kit/domain/supplier-card';
import type { Clock } from '@business-ai/core';
import type { SupplierRater } from '../../kit/ports/supplier-rater';
import type {
  SupplierRatingCache,
  SupplierRatingSource,
} from '../../kit/ports/supplier-rating-cache';
import { sha256HexSync } from '@business-ai/core';
import { mapPool } from '@business-ai/core';

/**
 * Рейтинг поставщиков при сборке шорт-листа (ТЗ, разд. 4). Формулы у заказчика нет, поэтому
 * оценку даёт модель по фактам карточки, а код её проверяет, кэширует и подстраховывает
 * правилом `computeSupplierRating`. Сборка шорт-листа от модели не зависит: любой сбой,
 * таймаут или неверный ответ - запасное правило, исключение наружу не выходит.
 */

/** Сколько вызовов модели разрешено за одну сборку шорт-листа; остальные карточки - по правилу. */
export const SUPPLIER_RATING_MAX_MODEL_CALLS = 10;
/** Сколько вызовов модели идёт одновременно. */
const SUPPLIER_RATING_CONCURRENCY = 5;
/** Предел ожидания одной оценки, мс: по истечении запрос отменяется, берётся правило. */
const SUPPLIER_RATING_TIMEOUT_MS = 15_000;
/** Код отмены по таймауту (в журнал идёт только он). */
const TIMEOUT_CODE = 'supplier_rating_timeout';

/** Оценщик и кэш: подключаются вместе, без модели рейтинг считает только правило. */
export interface SupplierRatingDeps {
  rater: SupplierRater;
  cache: SupplierRatingCache;
  /** Предел ожидания одной оценки, мс; по умолчанию `SUPPLIER_RATING_TIMEOUT_MS`. */
  timeoutMs?: number | undefined;
}

/** Что нужно сервису оценки от зависимостей агента. */
export interface SupplierRatingHost {
  supplierRating?: SupplierRatingDeps | undefined;
  clock: Clock;
  log?: ((event: string, fields?: Record<string, string | number | boolean>) => void) | undefined;
}

/** Итог оценки одной карточки. */
export interface CardRating {
  /** Оценка 1..5 либо `null` - «нет оценки». */
  value: number | null;
  /** Откуда оценка; при `null` нет. */
  source?: SupplierRatingSource | undefined;
  /** Обоснование модели (проверено кодом); у оценки по правилу его нет. */
  rationale?: string | undefined;
}

/** Хэш фактов: SHA-256 (hex) каноничной записи; не зависит от порядка ключей и пробелов. */
export function hashSupplierRatingFacts(facts: SupplierRatingFacts): string {
  return sha256HexSync(canonicalFactsJson(facts));
}

/** Оценка по запасному правилу; нет сигналов - «нет оценки». */
function ruleRating(card: SupplierCard): CardRating {
  const rule = computeSupplierRating(card);
  return rule.status === 'rated' ? { value: rule.value, source: 'rule' } : { value: null };
}

/** Код ошибки для журнала: имя класса либо код таймаута, без текста (в нём могли быть факты). */
function failureName(error: unknown): string {
  if (error instanceof Error && error.message === TIMEOUT_CODE) return TIMEOUT_CODE;
  return error instanceof Error ? error.name : 'unexpected';
}

/** Вызов оценщика с пределом ожидания; по таймауту запрос к модели отменяется. */
async function rateWithTimeout(
  rater: SupplierRater,
  facts: SupplierRatingFacts,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(TIMEOUT_CODE);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    return await Promise.race([rater.rate(facts, { signal: controller.signal }), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Карточка, ожидающая ответа модели. */
interface Pending {
  card: SupplierCard;
  facts: SupplierRatingFacts;
  hash: string;
}

/**
 * Оценить карточки. `cards` идут в порядке приоритета (первые получают вызовы модели, когда
 * лимит `SUPPLIER_RATING_MAX_MODEL_CALLS` меньше числа промахов кэша). Порядок:
 *  1. нет оценочных сигналов - «нет оценки», модель и кэш не трогаются;
 *  2. нет оценщика - правило;
 *  3. запись кэша по хэшу фактов - без вызова модели;
 *  4. промах - вызов модели в пределах лимита и таймаута; успех кэшируется (source `model`);
 *  5. сбой, таймаут, неверный ответ или превышение лимита - правило; в кэш оно НЕ пишется,
 *     чтобы следующая сборка повторила попытку, а не закрепила правило навсегда.
 * Возвращает оценки по id карточки; не бросает исключений.
 */
export async function rateSupplierCards(
  host: SupplierRatingHost,
  cards: readonly SupplierCard[],
): Promise<Map<string, CardRating>> {
  const result = new Map<string, CardRating>();
  const model = host.supplierRating;
  const misses: Pending[] = [];
  const unique = [...new Map(cards.map((card) => [card.id, card])).values()];
  for (const card of unique) {
    const rule = ruleRating(card);
    result.set(card.id, rule);
    if (model === undefined || rule.value === null) continue;
    const facts = buildSupplierRatingFacts(card);
    const hash = hashSupplierRatingFacts(facts);
    const cached = await model.cache.get(card.id, hash).catch((error: unknown) => {
      host.log?.('supplier_rating_cache_read_failed', { code: failureName(error) });
      return null;
    });
    // Запись кэша проверяется заново теми же правилами: старая запись не обходит проверку.
    const verdict =
      cached?.source === 'model'
        ? parseSupplierRatingVerdict({ score: cached.score, rationale: cached.rationale })
        : null;
    if (verdict === null) misses.push({ card, facts, hash });
    else {
      result.set(card.id, {
        value: verdict.score,
        source: 'model',
        rationale: verdict.rationale,
      });
    }
  }
  if (model === undefined || misses.length === 0) return result;
  const allowed = misses.slice(0, SUPPLIER_RATING_MAX_MODEL_CALLS);
  if (misses.length > allowed.length) {
    host.log?.('supplier_rating_model_limit', { skipped: misses.length - allowed.length });
  }
  await mapPool(allowed, SUPPLIER_RATING_CONCURRENCY, async (pending) => {
    try {
      const timeoutMs = model.timeoutMs ?? SUPPLIER_RATING_TIMEOUT_MS;
      const answer = await rateWithTimeout(model.rater, pending.facts, timeoutMs);
      const verdict = parseSupplierRatingVerdict(answer);
      if (verdict === null) throw new Error('supplier_rating_invalid_verdict');
      result.set(pending.card.id, {
        value: verdict.score,
        source: 'model',
        rationale: verdict.rationale,
      });
      await model.cache
        .put({
          supplierId: pending.card.id,
          factsHash: pending.hash,
          score: verdict.score,
          rationale: verdict.rationale,
          source: 'model',
          createdAt: host.clock.now().toISOString(),
        })
        .catch((error: unknown) => {
          host.log?.('supplier_rating_cache_write_failed', { code: failureName(error) });
        });
    } catch (error) {
      host.log?.('supplier_rating_model_failed', { code: failureName(error) });
    }
  });
  return result;
}
