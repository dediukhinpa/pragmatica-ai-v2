import { describe, expect, test } from 'bun:test';
import { MemoryModelGateway } from '@business-ai/adapters';
import { ModelShortlistComparer } from '../../../src/kit/adapters/litellm/shortlist-model-comparer';
import { buildCompareFacts } from '../../../src/kit/domain/shortlist-compare';
import { type ShortlistEntry } from '../../../src/kit/domain/shortlist';

const POOL_SIZE = 20;
/** Минимум токенов ответа на 20 кандидатов: ~100 на коды плюс запас на ограду и пояснения. */
const MIN_TOKENS_FOR_POOL = 1200;

function pool(size: number): ShortlistEntry[] {
  return Array.from({ length: size }, (_, index) => ({
    supplierId: `s${index}`,
    name: `s${index}`,
    sources: ['knowledge'],
    score: 0.5,
    references: [],
  }));
}

describe('ModelShortlistComparer', () => {
  test('лимит токенов покрывает 20 кандидатов, запрос с примером JSON', async () => {
    const models = new MemoryModelGateway(() => '{"order":["c1"]}');
    const comparer = new ModelShortlistComparer(models, 'alias');
    const { facts } = buildCompareFacts(pool(POOL_SIZE));
    await comparer.compare(facts, { signal: new AbortController().signal });
    const request = models.requests[0];
    expect(request?.maxTokens).toBeGreaterThanOrEqual(MIN_TOKENS_FOR_POOL);
    expect(request?.messages[0]?.content).toContain('{"picks":[{"id":"c3"');
    expect(request?.messages[1]?.content).toContain(`Кандидатов: ${POOL_SIZE}.`);
  });

  test('промпт: требования заявки, оценки товаров, причина по каждому, ярусы цен', async () => {
    const models = new MemoryModelGateway(() => '{"picks":[{"id":"c1","reason":"x"}]}');
    const comparer = new ModelShortlistComparer(models, 'alias');
    const { facts } = buildCompareFacts(pool(2));
    await comparer.compare(facts, { signal: new AbortController().signal });
    const prompt = String(models.requests[0]?.messages[0]?.content);
    expect(prompt).toContain('requirements');
    expect(prompt).toContain('соответствие требованиям заявки');
    expect(prompt).toContain('grade');
    expect(prompt).toContain('required=true');
    expect(prompt).toContain('не больше limit');
    expect(prompt).toContain('reason');
    expect(prompt).toContain('единицы и фасовку');
    expect(prompt).toContain('hasContacts');
    expect(prompt).toContain('наименее критичны');
    expect(prompt.indexOf('рейтинг поставщика')).toBeGreaterThan(prompt.indexOf('hasCity,'));
  });

  test('обрыв по max_tokens помечается в сыром ответе', async () => {
    const models = new MemoryModelGateway(() => ({
      content: '{"order":["c1"',
      stopReason: 'max_tokens',
    }));
    const comparer = new ModelShortlistComparer(models, 'alias');
    const { facts } = buildCompareFacts(pool(2));
    const answer = await comparer.compare(facts, { signal: new AbortController().signal });
    expect(answer).toEqual({ text: '{"order":["c1"', truncated: true });
  });
});
