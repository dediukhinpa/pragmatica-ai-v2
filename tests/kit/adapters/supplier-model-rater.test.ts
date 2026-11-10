import { describe, expect, test } from 'bun:test';
import { MemoryModelGateway } from '@business-ai/adapters';
import {
  ModelSupplierRater,
  SUPPLIER_RATING_INVALID_ANSWER,
  SUPPLIER_RATING_THREAD_ID,
} from '../../../src/kit/adapters/litellm/supplier-model-rater';
import {
  SUPPLIER_RATING_FACTS_VERSION,
  type SupplierRatingFacts,
} from '../../../src/kit/domain/supplier-rating-facts';
import {
  SUPPLIER_RATING_RATIONALE_MAX_LENGTH,
} from '../../../src/kit/domain/supplier-rating-verdict';
import type { ModelRequest } from '@business-ai/core';
import { supplierRaterContract } from '../contracts/supplier-rater.contract';

const MODEL = 'order-calc-alias';
const SIGNAL = new AbortController().signal;
const SECRET_TEXT = 'Секретная сильная сторона';
const FACTS: SupplierRatingFacts = {
  version: SUPPLIER_RATING_FACTS_VERSION,
  status: 'active',
  strengths: SECRET_TEXT,
  completeness: 2,
};
const GOOD = '{"score":4,"rationale":"Действующий поставщик, замечаний мало."}';

function adapter(answer: string): { rater: ModelSupplierRater; gateway: MemoryModelGateway } {
  const gateway = new MemoryModelGateway(() => answer);
  return { rater: new ModelSupplierRater(gateway, MODEL), gateway };
}

supplierRaterContract('ModelSupplierRater', () => adapter(GOOD).rater);

describe('ModelSupplierRater', () => {
  test('валидный ответ; запрос с алиасом агента, общим тредом и фактами', async () => {
    const { rater, gateway } = adapter(GOOD);
    expect(await rater.rate(FACTS, { signal: SIGNAL })).toEqual({
      score: 4,
      rationale: 'Действующий поставщик, замечаний мало.',
    });
    const request = gateway.requests[0] as ModelRequest;
    expect(request.model).toBe(MODEL);
    expect(request.threadId).toBe(SUPPLIER_RATING_THREAD_ID);
    expect(request.messages.at(-1)?.content).toContain(SECRET_TEXT);
  });

  test('JSON в блоке кода разбирается', async () => {
    const { rater } = adapter('```json\n{"score":2,"rationale":"Есть слабые стороны."}\n```');
    expect((await rater.rate(FACTS, { signal: SIGNAL })).score).toBe(2);
  });

  const bad = [
    '',
    'не знаю',
    '{"score":6,"rationale":"ок"}',
    '{"score":0,"rationale":"ок"}',
    '{"score":-1,"rationale":"ок"}',
    '{"score":3.5,"rationale":"ок"}',
    '{"score":"4","rationale":"ок"}',
    '{"score":null,"rationale":"ок"}',
    '{"rationale":"ок"}',
    '{"score":4}',
    '{"score":4,"rationale":""}',
    '{"score":4,"rationale":"   "}',
    '{"score":4,"rationale":"ок","confidence":0.9}',
    '{"score":4,"rationale":5}',
    '[4,"ок"]',
    '{"score":4,',
    `{"score":4,"rationale":"${'я'.repeat(SUPPLIER_RATING_RATIONALE_MAX_LENGTH + 1)}"}`,
    '{"score":4,"rationale":"пишите на info@supplier.test"}',
    '{"score":4,"rationale":"звоните 8 (495) 123-45-67"}',
    '{"score":4,"rationale":"ИНН 7707083893"}',
    '{"score":4,"rationale":"смотрите https://supplier.test"}',
  ];
  for (const answer of bad) {
    const label = JSON.stringify(answer).slice(0, 60);
    test(`неверный ответ - исключение без текста: ${label}`, async () => {
      const { rater } = adapter(answer);
      const error = await rater.rate(FACTS, { signal: SIGNAL }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(SUPPLIER_RATING_INVALID_ANSWER);
    });
  }

  test('обоснование ровно предельной длины допустимо', async () => {
    const text = 'я'.repeat(SUPPLIER_RATING_RATIONALE_MAX_LENGTH);
    const { rater } = adapter(`{"score":3,"rationale":"${text}"}`);
    expect((await rater.rate(FACTS, { signal: SIGNAL })).rationale).toBe(text);
  });

  test('сбой шлюза пробрасывается', async () => {
    const failing = new MemoryModelGateway(() => {
      throw new Error('gateway down');
    });
    const rater = new ModelSupplierRater(failing, MODEL);
    await expect(rater.rate(FACTS, { signal: SIGNAL })).rejects.toThrow('gateway down');
  });

  test('отменённый сигнал: модель не вызывается', async () => {
    const { rater, gateway } = adapter(GOOD);
    const controller = new AbortController();
    controller.abort(new Error('timeout'));
    await expect(rater.rate(FACTS, { signal: controller.signal })).rejects.toThrow();
    expect(gateway.requests).toHaveLength(0);
  });
});
