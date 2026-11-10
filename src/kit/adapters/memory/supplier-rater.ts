import {
  RATING_MAX,
  RATING_MIN,
  computeSupplierRatingFromFacts,
} from '../../domain/supplier-rating';
import { type SupplierRatingFacts } from '../../domain/supplier-rating-facts';
import { type SupplierRatingVerdict } from '../../domain/supplier-rating-verdict';
import type { SupplierRateOptions, SupplierRater } from '../../ports/supplier-rater';

/** Обоснование заглушки: коротко, без чисел и контактов. */
const STUB_RATIONALE = 'Оценка по правилу заглушки: статус, брак, стороны, полнота карточки.';

/** Оценка заглушки без сигналов: середина шкалы (код такие карточки до оценщика не пускает). */
const STUB_NO_SIGNAL_SCORE = 3;

/**
 * Оценщик в памяти (заглушка и тестовый двойник). Без аргументов оценивает детерминированно
 * по тому же правилу, что запасной путь (`computeSupplierRating`), но по фактам: оценка
 * округляется до целого. Вызовы считаются; факты запоминаются для проверок состава запроса.
 */
export class MemorySupplierRater implements SupplierRater {
  /** Сколько раз оценщика вызвали. */
  calls = 0;
  /** Факты каждого вызова в порядке вызовов. */
  readonly seen: SupplierRatingFacts[] = [];

  constructor(
    private readonly decide: (facts: SupplierRatingFacts) => SupplierRatingVerdict = (facts) => ({
      score: stubScore(facts),
      rationale: STUB_RATIONALE,
    }),
  ) {}

  async rate(
    facts: SupplierRatingFacts,
    options: SupplierRateOptions,
  ): Promise<SupplierRatingVerdict> {
    options.signal.throwIfAborted();
    this.calls += 1;
    this.seen.push(facts);
    return this.decide(facts);
  }
}

/** Правило `computeSupplierRating`, округлённое до целого (порт отдаёт целые оценки). */
function stubScore(facts: SupplierRatingFacts): number {
  const rule = computeSupplierRatingFromFacts(facts);
  const value = rule.status === 'rated' ? rule.value : STUB_NO_SIGNAL_SCORE;
  return Math.min(RATING_MAX, Math.max(RATING_MIN, Math.round(value)));
}
