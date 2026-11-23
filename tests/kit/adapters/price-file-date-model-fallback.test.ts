import { describe, expect, test } from 'bun:test';
import { MemoryModelGateway } from '@business-ai/adapters';
import {
  ModelPriceFileDateFallback,
  PRICE_FILE_DATE_THREAD_ID,
} from '../../../src/kit/adapters/litellm/price-file-date-model-fallback';
import type { ModelRequest } from '@business-ai/core';
import { priceFileDateFallbackContract } from '../contracts/price-file-date-fallback.contract';

const MODEL = 'prices-alias';
const SIGNAL = new AbortController().signal;
const INPUT = { fileName: 'Прайс_13.10.xlsx', today: '2026-10-22' };

interface Setup {
  fallback: ModelPriceFileDateFallback;
  gateway: MemoryModelGateway;
}

function adapter(answer: string): Setup {
  const gateway = new MemoryModelGateway(() => answer);
  return { fallback: new ModelPriceFileDateFallback(gateway, MODEL), gateway };
}

priceFileDateFallbackContract(
  'ModelPriceFileDateFallback',
  () => adapter('{"year":2026,"month":10,"day":1}').fallback,
);

describe('ModelPriceFileDateFallback', () => {
  test('JSON по схеме -> дата; запрос идёт с алиасом агента и общим тредом', async () => {
    const { fallback, gateway } = adapter('{"year":2026,"month":10,"day":13}');
    expect(await fallback.resolve(INPUT, { signal: SIGNAL })).toEqual({
      year: 2026,
      month: 10,
      day: 13,
    });
    const request = gateway.requests[0] as ModelRequest;
    expect(request.model).toBe(MODEL);
    expect(request.threadId).toBe(PRICE_FILE_DATE_THREAD_ID);
    expect(request.messages.at(-1)?.content).toContain(INPUT.fileName);
    expect(request.messages.at(-1)?.content).toContain(INPUT.today);
  });

  test('JSON в блоке кода и месяц без дня разбираются', async () => {
    const { fallback } = adapter('```json\n{"year":2026,"month":6,"day":null}\n```');
    expect(await fallback.resolve(INPUT, { signal: SIGNAL })).toEqual({
      year: 2026,
      month: 6,
      day: null,
    });
  });

  const bad = [
    '',
    'не знаю',
    '{"year":null,"month":null,"day":null}',
    '{"year":"2026","month":10,"day":1}',
    '{"year":2026.5,"month":10,"day":1}',
    '{"year":2026,"month":10}',
    '{"year":2026,',
    '[1,2,3]',
  ];
  for (const answer of bad) {
    test(`неверный ответ даёт null: ${JSON.stringify(answer)}`, async () => {
      const { fallback } = adapter(answer);
      expect(await fallback.resolve(INPUT, { signal: SIGNAL })).toBeNull();
    });
  }

  test('сбой шлюза пробрасывается (вызывающий код трактует как «дата не найдена»)', async () => {
    const failing = new MemoryModelGateway(() => {
      throw new Error('gateway down');
    });
    const fallback = new ModelPriceFileDateFallback(failing, MODEL);
    await expect(fallback.resolve(INPUT, { signal: SIGNAL })).rejects.toThrow('gateway down');
  });
});
