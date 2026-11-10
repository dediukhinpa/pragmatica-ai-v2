import type {
  SupplierMailClassification,
  SupplierMailClassificationInput,
  SupplierMailClassifier,
  SupplierMailClassifyOptions,
} from '../../ports/supplier-mail-classifier';

/** Решение заглушки по умолчанию: письмо поставщика со сведениями, без названия и категорий. */
const DEFAULT_CLASSIFICATION: SupplierMailClassification = {
  kind: 'supplier',
  hasSupplierInfo: true,
  categories: [],
};

/**
 * Классификатор писем в памяти (заглушка и тестовый двойник): решение задаётся функцией от
 * входа, вызовы считаются. Содержимое вызовов не сохраняется: тесты проверяют число обращений.
 */
export class MemorySupplierMailClassifier implements SupplierMailClassifier {
  /** Сколько раз классификатор вызвали. */
  calls = 0;

  constructor(
    private readonly decide: (
      input: SupplierMailClassificationInput,
    ) => SupplierMailClassification = () => DEFAULT_CLASSIFICATION,
  ) {}

  async classify(
    input: SupplierMailClassificationInput,
    options: SupplierMailClassifyOptions,
  ): Promise<SupplierMailClassification> {
    options.signal.throwIfAborted();
    this.calls += 1;
    return this.decide(input);
  }
}
