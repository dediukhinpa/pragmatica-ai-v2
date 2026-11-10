import { describe, expect, test } from 'bun:test';
import {
  SUPPLIER_MAIL_KINDS,
  SUPPLIER_MAIL_MAX_CATEGORIES,
  type SupplierMailClassificationInput,
  type SupplierMailClassifier,
} from '../../../src/kit/ports/supplier-mail-classifier';

const INPUT: SupplierMailClassificationInput = {
  subject: 'Коммерческое предложение на упаковку',
  body: 'ООО «Пример» предлагает картонную упаковку. Сайт: https://example.test',
  attachmentNames: ['КП.pdf'],
  senderDomain: 'vendor.test',
};

/** Контрактный набор SupplierMailClassifier (общий для обзора почты, этапы 220 и 222). */
export function supplierMailClassifierContract(
  name: string,
  factory: () => SupplierMailClassifier,
): void {
  describe(`SupplierMailClassifier: ${name}`, () => {
    test('вид письма из допустимых значений, список категорий ограничен', async () => {
      const result = await factory().classify(INPUT, { signal: new AbortController().signal });
      expect(SUPPLIER_MAIL_KINDS).toContain(result.kind);
      expect(typeof result.hasSupplierInfo).toBe('boolean');
      expect(result.categories.length).toBeLessThanOrEqual(SUPPLIER_MAIL_MAX_CATEGORIES);
    });

    test('сведения о поставщике бывают только у письма вида «поставщик»', async () => {
      const result = await factory().classify(INPUT, { signal: new AbortController().signal });
      if (result.hasSupplierInfo) expect(result.kind).toBe('supplier');
    });

    test('отменённый сигнал прерывает классификацию исключением', async () => {
      const controller = new AbortController();
      controller.abort(new Error('timeout'));
      await expect(factory().classify(INPUT, { signal: controller.signal })).rejects.toThrow();
    });

    test('входные данные не изменяются', async () => {
      const input: SupplierMailClassificationInput = {
        ...INPUT,
        attachmentNames: [...INPUT.attachmentNames],
      };
      await factory().classify(input, { signal: new AbortController().signal });
      expect(input).toEqual(INPUT);
    });
  });
}
