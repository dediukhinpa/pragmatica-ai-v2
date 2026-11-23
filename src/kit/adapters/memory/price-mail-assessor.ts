import type {
  PriceMailAssessment,
  PriceMailAssessmentInput,
  PriceMailAssessOptions,
  PriceMailAssessor,
} from '../../ports/price-mail-assessor';

/** Решение заглушки по умолчанию: письмо значимо. */
const DEFAULT_ASSESSMENT: PriceMailAssessment = {
  verdict: 'relevant',
  reason: 'price_change_announced',
};

/**
 * Оценщик писем в памяти (заглушка и тестовый двойник): решение задаётся функцией, вызовы
 * считаются. Содержимое вызовов не сохраняется: тесты проверяют только число обращений.
 */
export class MemoryPriceMailAssessor implements PriceMailAssessor {
  /** Сколько раз оценщика вызвали. */
  calls = 0;

  constructor(
    private readonly decide: (input: PriceMailAssessmentInput) => PriceMailAssessment = () =>
      DEFAULT_ASSESSMENT,
  ) {}

  async assess(
    input: PriceMailAssessmentInput,
    options: PriceMailAssessOptions,
  ): Promise<PriceMailAssessment> {
    options.signal.throwIfAborted();
    this.calls += 1;
    return this.decide(input);
  }
}
