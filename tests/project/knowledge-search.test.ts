import { describe, expect, test } from 'bun:test';
import type { PgClient } from '@business-ai/adapters';
import type { Embedder } from '@business-ai/core';
import { ProjectKnowledgeSearch } from '../../src/adapters/knowledge-search';

/** Запрос, дошедший до заглушки БД. */
interface Captured {
  sql: string;
  params: readonly unknown[];
}

/** Размерность вектора запроса в заглушке (достаточно для проверки текста запроса). */
const FAKE_DIMENSIONS = 768;

const embedder: Embedder = {
  embedQuery: async () => new Array<number>(FAKE_DIMENSIONS).fill(0.5),
  embedPassages: async (texts) => texts.map(() => new Array<number>(FAKE_DIMENSIONS).fill(0.5)),
};

/** БД-заглушка: запоминает запросы и отвечает заданными строками. */
function fakeDb(rows: unknown[]): { db: PgClient; calls: Captured[] } {
  const calls: Captured[] = [];
  const db = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      return rows;
    },
  } as unknown as PgClient;
  return { db, calls };
}

describe('ProjectKnowledgeSearch', () => {
  test('раздел поставщиков идёт через hybrid_search_suppliers', async () => {
    const { db, calls } = fakeDb([{ document_id: 'doc-1', snippet: 'текст', score: '0.5' }]);
    const hits = await new ProjectKnowledgeSearch(db, embedder).search('цемент', 5, {
      suppliersOnly: true,
    });
    expect(hits).toEqual([{ documentId: 'doc-1', snippet: 'текст', score: 0.5 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('hybrid_search_suppliers');
  });

  test('один поставщик передаётся фильтром scope в hybrid_search', async () => {
    const { db, calls } = fakeDb([]);
    await new ProjectKnowledgeSearch(db, embedder).search('цемент', 5, { supplierId: 'sup-1' });
    expect(calls[0]?.sql).toContain('hybrid_search(');
    expect(calls[0]?.params).toContain('sup-1');
  });

  test('привязка документа к поставщику читает столбец scope', async () => {
    const { db, calls } = fakeDb([{ document_id: 'doc-1', scope: 'sup-1' }]);
    const map = await new ProjectKnowledgeSearch(db, embedder).supplierIdsOf(['doc-1']);
    expect(map.get('doc-1')).toBe('sup-1');
    expect(calls[0]?.sql).toContain('scope');
    expect(calls[0]?.sql).not.toContain('supplier_id');
  });

  test('пустой список документов не обращается к БД', async () => {
    const { db, calls } = fakeDb([]);
    expect((await new ProjectKnowledgeSearch(db, embedder).supplierIdsOf([])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
