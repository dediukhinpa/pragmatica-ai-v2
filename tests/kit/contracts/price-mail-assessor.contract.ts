import { describe, expect, test } from 'bun:test';
import {
  PRICE_MAIL_ASSESSMENT_REASONS,
  PRICE_MAIL_VERDICTS,
  type PriceMailAssessmentInput,
  type PriceMailAssessor,
} from '../../../src/kit/ports/price-mail-assessor';

const INPUT: PriceMailAssessmentInput = {
  subject: 'Повышение цен с 1 ноября',
  body: 'Сообщаем о повышении цен на 5%.',
  attachmentNames: ['Прайс_2026.xlsx'],
  triggerIds: ['price_increase'],
  supplierName: 'Поставщик',
  matchedByName: false,
  attachmentText: '',
};

/** Контрактный набор PriceMailAssessor. */
export function priceMailAssessorContract(name: string, factory: () => PriceMailAssessor): void {
  describe(`PriceMailAssessor: ${name}`, () => {
    test('вердикт и код причины из допустимых значений', async () => {
      const result = await factory().assess(INPUT, { signal: new AbortController().signal });
      expect(PRICE_MAIL_VERDICTS).toContain(result.verdict);
      expect(PRICE_MAIL_ASSESSMENT_REASONS).toContain(result.reason);
    });

    test('в ответе только вердикт и код: текста письма нет', async () => {
      const result = await factory().assess(INPUT, { signal: new AbortController().signal });
      expect(Object.keys(result).sort()).toEqual(['reason', 'verdict']);
      expect(JSON.stringify(result)).not.toContain(INPUT.subject);
    });

    test('отменённый сигнал прерывает оценку исключением', async () => {
      const controller = new AbortController();
      controller.abort(new Error('timeout'));
      await expect(factory().assess(INPUT, { signal: controller.signal })).rejects.toThrow();
    });

    test('входные данные не изменяются', async () => {
      const input: PriceMailAssessmentInput = {
        ...INPUT,
        attachmentNames: [...INPUT.attachmentNames],
        triggerIds: [...INPUT.triggerIds],
      };
      await factory().assess(input, { signal: new AbortController().signal });
      expect(input).toEqual(INPUT);
    });
  });
}
