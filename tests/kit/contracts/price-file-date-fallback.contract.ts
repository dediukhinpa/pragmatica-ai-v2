import { describe, expect, test } from 'bun:test';
import type {
  PriceFileDateFallback,
  PriceFileDateFallbackInput,
} from '../../../src/kit/ports/price-file-date-fallback';

const INPUT: PriceFileDateFallbackInput = {
  fileName: 'Прайс_Пример_01.10.2026.xlsx',
  today: '2026-10-22',
};

const MIN_MONTH = 1;
const MAX_MONTH = 12;
const MIN_DAY = 1;
const MAX_DAY = 31;

/** Контрактный набор PriceFileDateFallback. */
export function priceFileDateFallbackContract(
  name: string,
  factory: () => PriceFileDateFallback,
): void {
  describe(`PriceFileDateFallback: ${name}`, () => {
    test('ответ - null либо дата: год, месяц, день (день может быть null)', async () => {
      const result = await factory().resolve(INPUT, { signal: new AbortController().signal });
      if (result === null) return;
      expect(Number.isInteger(result.year)).toBe(true);
      expect(result.month).toBeGreaterThanOrEqual(MIN_MONTH);
      expect(result.month).toBeLessThanOrEqual(MAX_MONTH);
      if (result.day !== null) {
        expect(result.day).toBeGreaterThanOrEqual(MIN_DAY);
        expect(result.day).toBeLessThanOrEqual(MAX_DAY);
      }
      expect(Object.keys(result).sort()).toEqual(['day', 'month', 'year']);
    });

    test('отменённый сигнал прерывает разбор исключением', async () => {
      const controller = new AbortController();
      controller.abort(new Error('timeout'));
      await expect(factory().resolve(INPUT, { signal: controller.signal })).rejects.toThrow();
    });

    test('входные данные не изменяются', async () => {
      const input: PriceFileDateFallbackInput = { ...INPUT };
      await factory().resolve(input, { signal: new AbortController().signal });
      expect(input).toEqual(INPUT);
    });
  });
}
