import { describe, expect, spyOn, test } from 'bun:test';
import { MemoryKnowledgeSearch } from '../../src/kit/adapters/memory/knowledge-search.owned';
import { loadSourceResult } from '../../src/agents/order-calc/state';
import { searchKnowledgeSuppliers } from '../../src/agents/order-calc/search-sources';
import { DomainError } from '@business-ai/core';
import { type PurchaseRequest } from '../../src/kit/domain/models';
import { CTX } from './support';
import { ORDER_REQUEST, REQUEST_ID, buildOrderDeps } from './order-support';

const WORDS = ['альфа', 'бета', 'гамма', 'дельта', 'эпсилон', 'зета', 'эта', 'тета'];

/** Заявка из позиций-слов; каждое слово встречается в одном документе базы знаний. */
function requestOf(words: readonly string[]): PurchaseRequest {
  return {
    ...ORDER_REQUEST,
    items: words.map((name) => ({ name, quantity: 1, unit: 'шт' })),
  };
}

function knowledgeOf(words: readonly string[]): MemoryKnowledgeSearch {
  return new MemoryKnowledgeSearch(new Map(words.map((word) => [`kb-${word}`, `Условия ${word}`])));
}

/** Пауза в макрозадачу: даёт задачам пула завершаться не в порядке запуска. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('searchKnowledgeSuppliers: пул, подсказки, пакетные карточки', () => {
  test('после трёх подсказок гибридный поиск по остальным позициям не идёт', async () => {
    const deps = await buildOrderDeps({ request: requestOf(WORDS) });
    deps.knowledge = knowledgeOf(WORDS);
    const search = spyOn(deps.knowledge, 'search');
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(search.mock.calls.length).toBeLessThan(WORDS.length);
  });

  test('подсказки не зависят от порядка завершения параллельных задач', async () => {
    const deps = await buildOrderDeps({ request: requestOf(WORDS) });
    const memory = knowledgeOf(WORDS);
    // Первые позиции отвечают дольше последних: наивный пул собрал бы подсказки «с хвоста».
    deps.knowledge = {
      async search(query, limit, scope) {
        await sleep((WORDS.length - WORDS.indexOf(query)) * 3);
        return memory.search(query, limit, scope);
      },
    };
    const out = await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.references.map((ref) => ref.documentId)).toEqual([
      'kb-альфа',
      'kb-бета',
      'kb-гамма',
    ]);
  });

  test('результат пула совпадает с последовательным обходом: порядок и оценки', async () => {
    const one = await buildOrderDeps({ request: requestOf(['Арматура', 'Болт', 'Арматура 12']) });
    const many = await buildOrderDeps({ request: requestOf(['Арматура', 'Болт', 'Арматура 12']) });
    const slow = many.prices.searchSuppliersByProduct.bind(many.prices);
    many.prices.searchSuppliersByProduct = async (query, limit) => {
      await sleep(query === 'Арматура' ? 10 : 1);
      return slow(query, limit);
    };
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, one, CTX);
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, many, CTX);
    const expected = await loadSourceResult(one, REQUEST_ID, 'knowledge');
    expect(expected?.candidates.length).toBeGreaterThan(0);
    expect(await loadSourceResult(many, REQUEST_ID, 'knowledge')).toEqual(expected);
  });

  test('карточки поставщиков из прайса читаются одним getCards, без getCard', async () => {
    const deps = await buildOrderDeps();
    const single = spyOn(deps.suppliers, 'getCard');
    const batch = spyOn(deps.suppliers, 'getCards');
    const out = await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.found).toBe(2); // s1 и s2 из прайса
    expect(single).not.toHaveBeenCalled();
    expect(batch).toHaveBeenCalledTimes(1);
  });

  test('сбой поиска по карточкам логируется кодом, результаты по прайсам остаются', async () => {
    const deps = await buildOrderDeps();
    const events: Array<{ event: string; fields?: Record<string, unknown> | undefined }> = [];
    deps.log = (event, fields) => events.push({ event, fields });
    spyOn(deps.suppliers, 'searchCards').mockRejectedValue(
      new DomainError('external_failure', 'секретный текст ошибки'),
    );
    const out = await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.status).toBe('ok');
    expect(out.found).toBe(2);
    expect(events).toEqual([
      { event: 'order_calc_card_search_failed', fields: { code: 'external_failure' } },
    ]);
  });
});
