import { describe, expect, test } from 'bun:test';
import { MemoryModelGateway } from '@business-ai/adapters';
import {
  ModelSupplierMailClassifier,
  SUPPLIER_MAIL_CLASSIFY_INVALID_ANSWER,
  SUPPLIER_MAIL_CLASSIFY_THREAD_ID,
} from '../../../src/kit/adapters/litellm/supplier-mail-model-classifier';
import type { ModelRequest } from '@business-ai/core';
import type {
  SupplierMailClassificationInput,
} from '../../../src/kit/ports/supplier-mail-classifier';
import { supplierMailClassifierContract } from '../contracts/supplier-mail-classifier.contract';

const MODEL = 'prices-alias';
const SIGNAL = new AbortController().signal;
const SECRET_BODY = 'Секретный текст письма 12345';
const INPUT: SupplierMailClassificationInput = {
  subject: 'Коммерческое предложение',
  body: SECRET_BODY,
  attachmentNames: ['КП.pdf'],
  senderDomain: 'vendor.test',
};
const SUPPLIER_ANSWER =
  '{"kind":"supplier","hasSupplierInfo":true,"companyName":"ООО «Пример»",' +
  '"categories":["картонная упаковка"]}';

function adapter(answer: string) {
  const gateway = new MemoryModelGateway(() => answer);
  return { classifier: new ModelSupplierMailClassifier(gateway, MODEL), gateway };
}

supplierMailClassifierContract(
  'ModelSupplierMailClassifier',
  () => adapter(SUPPLIER_ANSWER).classifier,
);

describe('ModelSupplierMailClassifier', () => {
  test('валидный ответ: вид, признак, название, категории; алиас и общий тред', async () => {
    const { classifier, gateway } = adapter(SUPPLIER_ANSWER);
    expect(await classifier.classify(INPUT, { signal: SIGNAL })).toEqual({
      kind: 'supplier',
      hasSupplierInfo: true,
      companyName: 'ООО «Пример»',
      categories: ['картонная упаковка'],
    });
    const request = gateway.requests[0] as ModelRequest;
    expect(request.model).toBe(MODEL);
    expect(request.threadId).toBe(SUPPLIER_MAIL_CLASSIFY_THREAD_ID);
    const user = request.messages.at(-1)?.content ?? '';
    expect(user).toContain(SECRET_BODY);
    expect(user).toContain(INPUT.subject);
    // Адрес отправителя модели не уходит: только домен.
    expect(user).toContain('vendor.test');
  });

  test('рассылка: без сведений, категории и название необязательны', async () => {
    const { classifier } = adapter('{"kind":"newsletter","hasSupplierInfo":false}');
    expect(await classifier.classify(INPUT, { signal: SIGNAL })).toEqual({
      kind: 'newsletter',
      hasSupplierInfo: false,
      categories: [],
    });
  });

  test('JSON в блоке кода разбирается, лишнее отброшено, категорий не больше предела', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `"товар ${i}"`).join(',');
    const { classifier } = adapter(
      '```json\n{"kind":"supplier","hasSupplierInfo":true,"note":"x",' +
        `"categories":[${many}]}\n\`\`\``,
    );
    const result = await classifier.classify(INPUT, { signal: SIGNAL });
    expect(Object.keys(result).sort()).toEqual(['categories', 'hasSupplierInfo', 'kind']);
    expect(result.categories.length).toBeLessThanOrEqual(5);
  });

  const bad = [
    '',
    'не знаю',
    '{"kind":"maybe","hasSupplierInfo":false}',
    '{"kind":"supplier"}',
    '{"hasSupplierInfo":true}',
    '{"kind":"supplier","hasSupplierInfo":"yes"}',
    '{"kind":"supplier",',
    '[1,2,3]',
    // противоречие: сведения о поставщике у письма клиента или рассылки
    '{"kind":"customer","hasSupplierInfo":true}',
    '{"kind":"newsletter","hasSupplierInfo":true,"companyName":"ООО «Х»"}',
  ];
  for (const answer of bad) {
    test(`неверный ответ - исключение без текста письма: ${JSON.stringify(answer)}`, async () => {
      const { classifier } = adapter(answer);
      const error = await classifier.classify(INPUT, { signal: SIGNAL }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(SUPPLIER_MAIL_CLASSIFY_INVALID_ANSWER);
    });
  }

  test('сбой шлюза пробрасывается', async () => {
    const failing = new MemoryModelGateway(() => {
      throw new Error('gateway down');
    });
    const classifier = new ModelSupplierMailClassifier(failing, MODEL);
    await expect(classifier.classify(INPUT, { signal: SIGNAL })).rejects.toThrow('gateway down');
  });

  test('отменённый сигнал: модель не вызывается', async () => {
    const { classifier, gateway } = adapter(SUPPLIER_ANSWER);
    const controller = new AbortController();
    controller.abort(new Error('timeout'));
    await expect(classifier.classify(INPUT, { signal: controller.signal })).rejects.toThrow();
    expect(gateway.requests).toHaveLength(0);
  });
});
