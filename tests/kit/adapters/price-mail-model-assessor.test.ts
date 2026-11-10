import { describe, expect, test } from 'bun:test';
import { MemoryModelGateway } from '@business-ai/adapters';
import {
  ModelPriceMailAssessor,
  PRICE_MAIL_ASSESS_INVALID_ANSWER,
  PRICE_MAIL_ASSESS_THREAD_ID,
} from '../../../src/kit/adapters/litellm/price-mail-model-assessor';
import type { ModelRequest } from '@business-ai/core';
import type { PriceMailAssessmentInput } from '../../../src/kit/ports/price-mail-assessor';
import { priceMailAssessorContract } from '../contracts/price-mail-assessor.contract';

const MODEL = 'prices-alias';
const SIGNAL = new AbortController().signal;
const SECRET_BODY = 'Секретный текст письма 12345';
const INPUT: PriceMailAssessmentInput = {
  subject: 'Новые цены с 1 ноября',
  body: SECRET_BODY,
  attachmentNames: ['Прайс_2026.xlsx'],
  triggerIds: ['price_change'],
  supplierName: 'Поставщик',
  matchedByName: false,
  attachmentText: '',
};

interface Setup {
  assessor: ModelPriceMailAssessor;
  gateway: MemoryModelGateway;
}

function adapter(answer: string): Setup {
  const gateway = new MemoryModelGateway(() => answer);
  return { assessor: new ModelPriceMailAssessor(gateway, MODEL), gateway };
}

priceMailAssessorContract(
  'ModelPriceMailAssessor',
  () => adapter('{"verdict":"relevant","reason":"price_change_announced"}').assessor,
);

describe('ModelPriceMailAssessor', () => {
  test('валидный ответ: вердикт и код; запрос с алиасом агента и общим тредом', async () => {
    const { assessor, gateway } = adapter('{"verdict":"not_relevant","reason":"newsletter"}');
    expect(await assessor.assess(INPUT, { signal: SIGNAL })).toEqual({
      verdict: 'not_relevant',
      reason: 'newsletter',
    });
    const request = gateway.requests[0] as ModelRequest;
    expect(request.model).toBe(MODEL);
    expect(request.threadId).toBe(PRICE_MAIL_ASSESS_THREAD_ID);
    expect(request.messages.at(-1)?.content).toContain(SECRET_BODY);
    expect(request.messages.at(-1)?.content).toContain(INPUT.subject);
  });

  test('JSON в блоке кода разбирается; лишние поля отбрасываются', async () => {
    const { assessor } = adapter(
      '```json\n{"verdict":"relevant","reason":"undetermined","note":"x"}\n```',
    );
    expect(await assessor.assess(INPUT, { signal: SIGNAL })).toEqual({
      verdict: 'relevant',
      reason: 'undetermined',
    });
  });

  const bad = [
    '',
    'не знаю',
    '{"verdict":"maybe","reason":"newsletter"}',
    '{"verdict":"relevant"}',
    '{"verdict":"relevant","reason":"свободный текст с ПДн"}',
    '{"verdict":"relevant",',
    '[1,2,3]',
    // противоречия: глушить письмо об изменении цен или неопределённое нельзя
    '{"verdict":"not_relevant","reason":"price_change_announced"}',
    '{"verdict":"not_relevant","reason":"undetermined"}',
    '{"verdict":"relevant","reason":"newsletter"}',
  ];
  for (const answer of bad) {
    test(`неверный ответ - исключение без текста письма: ${JSON.stringify(answer)}`, async () => {
      const { assessor } = adapter(answer);
      const error = await assessor.assess(INPUT, { signal: SIGNAL }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(PRICE_MAIL_ASSESS_INVALID_ANSWER);
    });
  }

  test('сбой шлюза пробрасывается (вызывающий код откатывается к уведомлению)', async () => {
    const failing = new MemoryModelGateway(() => {
      throw new Error('gateway down');
    });
    const assessor = new ModelPriceMailAssessor(failing, MODEL);
    await expect(assessor.assess(INPUT, { signal: SIGNAL })).rejects.toThrow('gateway down');
  });

  test('отменённый сигнал: модель не вызывается', async () => {
    const { assessor, gateway } = adapter('{"verdict":"relevant","reason":"undetermined"}');
    const controller = new AbortController();
    controller.abort(new Error('timeout'));
    await expect(assessor.assess(INPUT, { signal: controller.signal })).rejects.toThrow();
    expect(gateway.requests).toHaveLength(0);
  });
});
