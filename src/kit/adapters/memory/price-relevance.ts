import type {
  PriceRelevanceChecker,
  PriceRelevanceInput,
  PriceRelevanceOptions,
} from '../../ports/price-relevance';

/** Проверка строк прайсов в памяти (тестовый двойник): ответ по входу, входы запоминаются. */
export class MemoryPriceRelevanceChecker implements PriceRelevanceChecker {
  readonly seen: PriceRelevanceInput[] = [];

  constructor(private readonly answer: (input: PriceRelevanceInput) => unknown) {}

  async check(input: PriceRelevanceInput, options: PriceRelevanceOptions): Promise<unknown> {
    options.signal.throwIfAborted();
    this.seen.push(input);
    return this.answer(input);
  }
}
