import {
  assertQueryText,
  PostgresKnowledgeSearch,
  type PgClient,
} from '@business-ai/adapters';
import type { Embedder, KnowledgeHit } from '@business-ai/core';
import type { KnowledgeScope, KnowledgeSearch } from '../kit/ports/knowledge-search.owned';

/** Порог косинусной близости векторной ветки, как у поиска платформы по умолчанию. */
const DEFAULT_MIN_COSINE = 0.3;

/** Строка выдачи SQL-функций поиска. */
interface HitRow {
  document_id: string;
  snippet: string;
  score: number | string;
}

/** Строка привязки документа к поставщику. */
interface BindingRow {
  document_id: string;
  scope: string;
}

/** Вектор запроса в текстовом виде pgvector. */
function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Поиск по базе знаний с областью проекта: весь раздел поставщиков или один поставщик.
 *
 * Поиск платформы (`PostgresKnowledgeSearch.search`) область не знает, поэтому без этого адаптера
 * подсказки «только из раздела поставщиков» вернули бы всю базу. Без области поиск делает
 * платформенный класс. Привязка фрагмента к поставщику лежит в столбце `scope` (в бою раньше он
 * назывался `supplier_id`, переименован миграцией app/026).
 */
export class ProjectKnowledgeSearch implements KnowledgeSearch {
  private readonly base: PostgresKnowledgeSearch;

  constructor(
    private readonly db: PgClient,
    private readonly embedder: Embedder,
    private readonly minCosine: number = DEFAULT_MIN_COSINE,
  ) {
    this.base = new PostgresKnowledgeSearch(db, embedder, minCosine);
  }

  /** Порт: без области - вся база; `supplierId` - один поставщик; `suppliersOnly` - раздел. */
  async search(query: string, limit: number, scope: KnowledgeScope = {}): Promise<KnowledgeHit[]> {
    if (scope.supplierId === undefined && scope.suppliersOnly !== true) {
      return this.base.search(query, limit);
    }
    assertQueryText(query);
    const vector = toVectorLiteral(await this.embedder.embedQuery(query));
    if (scope.supplierId !== undefined) {
      const rows = await this.db.query(
        `SELECT document_id, snippet, score
         FROM hybrid_search($1::text, $2::vector, $3::integer, $4::text, $5::text,
                            min_cosine => $6::double precision)`,
        [query, vector, limit, null, scope.supplierId, this.minCosine],
      );
      return hitsOf(rows as unknown as HitRow[]);
    }
    const rows = await this.db.query(
      `SELECT document_id, snippet, score
       FROM hybrid_search_suppliers($1::text, $2::vector, $3::integer,
                                    min_cosine => $4::double precision)`,
      [query, vector, limit, this.minCosine],
    );
    return hitsOf(rows as unknown as HitRow[]);
  }

  /**
   * Поставщик документа: только документы с ОДНОЗНАЧНОЙ привязкой (все фрагменты одного
   * поставщика); остальные в результате отсутствуют.
   */
  async supplierIdsOf(documentIds: readonly string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (documentIds.length === 0) return result;
    const rows = await this.db.query(
      `SELECT document_id, min(scope) AS scope
       FROM knowledge_chunks
       WHERE document_id IN (SELECT jsonb_array_elements_text($1::jsonb))
         AND scope IS NOT NULL
       GROUP BY document_id HAVING count(DISTINCT scope) = 1`,
      [JSON.stringify(documentIds)],
    );
    for (const row of rows as unknown as BindingRow[]) result.set(row.document_id, row.scope);
    return result;
  }
}

/** Выдача функций поиска -> документы порта. */
function hitsOf(rows: readonly HitRow[]): KnowledgeHit[] {
  return rows.map((row) => ({
    documentId: row.document_id,
    snippet: row.snippet,
    score: Number(row.score),
  }));
}
