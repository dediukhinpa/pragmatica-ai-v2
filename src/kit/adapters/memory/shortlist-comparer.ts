import type { ShortlistCompareFacts } from '../../domain/shortlist-compare';
import type { ShortlistCompareOptions, ShortlistComparer } from '../../ports/shortlist-comparer';

/** Сравнитель в памяти (тестовый двойник): ответ по фактам, вызовы и входы запоминаются. */
export class MemoryShortlistComparer implements ShortlistComparer {
  calls = 0;
  readonly seen: ShortlistCompareFacts[] = [];

  constructor(private readonly answer: (facts: ShortlistCompareFacts) => unknown) {}

  async compare(facts: ShortlistCompareFacts, options: ShortlistCompareOptions): Promise<unknown> {
    options.signal.throwIfAborted();
    this.calls += 1;
    this.seen.push(facts);
    return this.answer(facts);
  }
}
