import type { PriceFileDate } from '../../domain/price-file-date';
import type {
  PriceFileDateFallback,
  PriceFileDateFallbackInput,
  PriceFileDateFallbackOptions,
} from '../../ports/price-file-date-fallback';

/**
 * Запасной разбор даты в памяти (заглушка и тестовый двойник): решение задаётся функцией, по
 * умолчанию «дату определить нельзя». Вызовы считаются; имена не сохраняются.
 */
export class MemoryPriceFileDateFallback implements PriceFileDateFallback {
  /** Сколько раз разбор вызывали. */
  calls = 0;

  constructor(
    private readonly decide: (input: PriceFileDateFallbackInput) => PriceFileDate | null = () =>
      null,
  ) {}

  async resolve(
    input: PriceFileDateFallbackInput,
    options: PriceFileDateFallbackOptions,
  ): Promise<PriceFileDate | null> {
    options.signal.throwIfAborted();
    this.calls += 1;
    return this.decide(input);
  }
}
