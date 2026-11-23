import { describe, expect, test } from 'bun:test';
import { RATING_MAX, RATING_MIN } from '../../../src/kit/domain/supplier-rating';
import {
  SUPPLIER_RATING_RATIONALE_MAX_LENGTH,
} from '../../../src/kit/domain/supplier-rating-verdict';
import {
  SUPPLIER_RATING_FACTS_VERSION,
  type SupplierRatingFacts,
} from '../../../src/kit/domain/supplier-rating-facts';
import type { SupplierRater } from '../../../src/kit/ports/supplier-rater';

const FACTS: SupplierRatingFacts = {
  version: SUPPLIER_RATING_FACTS_VERSION,
  status: 'active',
  defectRatePercent: 2,
  strengths: 'Быстро печатает небольшие тиражи',
  completeness: 3,
};

/** Контрактный набор SupplierRater: оценка 1..5 целым и короткое обоснование. */
export function supplierRaterContract(name: string, factory: () => SupplierRater): void {
  describe(`SupplierRater: ${name}`, () => {
    test('оценка - целое от 1 до 5, обоснование - непустая короткая строка', async () => {
      const result = await factory().rate(FACTS, { signal: new AbortController().signal });
      expect(Number.isInteger(result.score)).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(RATING_MIN);
      expect(result.score).toBeLessThanOrEqual(RATING_MAX);
      expect(result.rationale.length).toBeGreaterThan(0);
      expect(result.rationale.length).toBeLessThanOrEqual(SUPPLIER_RATING_RATIONALE_MAX_LENGTH);
    });

    test('в ответе только оценка и обоснование', async () => {
      const result = await factory().rate(FACTS, { signal: new AbortController().signal });
      expect(Object.keys(result).sort()).toEqual(['rationale', 'score']);
    });

    test('отменённый сигнал прерывает оценку исключением', async () => {
      const controller = new AbortController();
      controller.abort(new Error('timeout'));
      await expect(factory().rate(FACTS, { signal: controller.signal })).rejects.toThrow();
    });

    test('входные факты не изменяются', async () => {
      const facts = { ...FACTS };
      await factory().rate(facts, { signal: new AbortController().signal });
      expect(facts).toEqual(FACTS);
    });
  });
}
