import { DomainError } from '@business-ai/core';
import type { KnowledgeHit } from '@business-ai/core';
import type { KnowledgeScope, KnowledgeSearch } from '../../ports/knowledge-search.owned';

/** Длина фрагмента в выдаче. */
const SNIPPET_LENGTH = 80;
/** Документ заглушки: текст и, необязательно, поставщик, которому он принадлежит. */
export interface MemoryKnowledgeDocument {
  text: string;
  supplierId?: string | undefined;
}
/** Поиск-заглушка: доля слов запроса, найденных в тексте. */
export class MemoryKnowledgeSearch implements KnowledgeSearch {
  /** Документ - строка (без поставщика) или `MemoryKnowledgeDocument`. */
  constructor(private readonly documents: ReadonlyMap<string, string | MemoryKnowledgeDocument>) {}

  async supplierIdsOf(documentIds: readonly string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const id of documentIds) {
      const document = this.documents.get(id);
      if (typeof document === 'object' && document.supplierId !== undefined) {
        result.set(id, document.supplierId);
      }
    }
    return result;
  }

  async search(query: string, limit: number, scope: KnowledgeScope = {}): Promise<KnowledgeHit[]> {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '');
    // Как в Postgres-адаптере: пустой запрос отклоняется, а не «ничего не найдено».
    if (words.length === 0) {
      throw new DomainError('validation_failed', 'Поисковый запрос пуст: укажите, что искать.');
    }
    const hits: KnowledgeHit[] = [];
    for (const [documentId, document] of this.documents) {
      const text = typeof document === 'string' ? document : document.text;
      const supplierId = typeof document === 'string' ? undefined : document.supplierId;
      if (scope.supplierId !== undefined && supplierId !== scope.supplierId) continue;
      if (scope.suppliersOnly === true && supplierId === undefined) continue;
      const lower = text.toLowerCase();
      const matched = words.filter((word) => lower.includes(word)).length;
      if (matched > 0) {
        hits.push({
          documentId,
          snippet: text.slice(0, SNIPPET_LENGTH),
          score: matched / words.length,
        });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
