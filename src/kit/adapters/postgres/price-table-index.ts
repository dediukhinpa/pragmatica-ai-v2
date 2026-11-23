import { z } from 'zod';
import { looksLikePriceTableText, PRICE_TABLE_CHUNK_COUNT } from '../../domain/price-table-signal';
import type { PriceTableIndex, PriceTableVerdict } from '../../ports/price-table-index';
import type { PgClient } from '@business-ai/adapters';
import { parseRows } from '@business-ai/adapters';

/** Сколько путей уходит в один запрос (параметры массива, не по запросу на файл). */
const PATHS_PER_QUERY = 500;

const chunkRow = z.object({
  source: z.string(),
  content: z.string(),
});

/**
 * Признак «таблица цен» по `knowledge_chunks`: `source` - путь от корня диска, берутся первые
 * {@link PRICE_TABLE_CHUNK_COUNT} фрагментов файла. Путь без фрагментов - `absent`.
 */
export class PostgresPriceTableIndex implements PriceTableIndex {
  constructor(private readonly db: PgClient) {}

  async verdicts(paths: readonly string[]): Promise<Map<string, PriceTableVerdict>> {
    const result = new Map<string, PriceTableVerdict>();
    const unique = [...new Set(paths)];
    for (let start = 0; start < unique.length; start += PATHS_PER_QUERY) {
      const batch = unique.slice(start, start + PATHS_PER_QUERY);
      const rows = await this.db.query(
        `SELECT source, content FROM knowledge_chunks
         WHERE source = ANY(ARRAY(SELECT jsonb_array_elements_text($1::text::jsonb))) AND chunk_index < $2
         ORDER BY source, chunk_index`,
        [JSON.stringify(batch), PRICE_TABLE_CHUNK_COUNT],
      );
      const textBySource = new Map<string, string[]>();
      for (const row of parseRows(chunkRow, rows)) {
        const parts = textBySource.get(row.source) ?? [];
        parts.push(row.content);
        textBySource.set(row.source, parts);
      }
      for (const path of batch) {
        const parts = textBySource.get(path);
        if (parts === undefined) result.set(path, 'absent');
        else result.set(path, looksLikePriceTableText(parts.join('\n')) ? 'table' : 'not_table');
      }
    }
    return result;
  }
}

const textLengthRow = z.object({
  source: z.string(),
  chars: z.coerce.number().int().nonnegative(),
});

/**
 * Длина извлечённого текста файлов по `knowledge_chunks` (сумма длин всех фрагментов), только
 * чтение. Нужна смете импорта: так длина берётся по разобранному индексатором тексту, а не по
 * размеру файла. Путь без фрагментов в ответ не попадает.
 */
export async function knowledgeTextChars(
  db: PgClient,
  paths: readonly string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const unique = [...new Set(paths)];
  for (let start = 0; start < unique.length; start += PATHS_PER_QUERY) {
    const batch = unique.slice(start, start + PATHS_PER_QUERY);
    const rows = await db.query(
      `SELECT source, sum(length(content)) AS chars FROM knowledge_chunks
       WHERE source = ANY(ARRAY(SELECT jsonb_array_elements_text($1::text::jsonb)))
       GROUP BY source`,
      [JSON.stringify(batch)],
    );
    for (const row of parseRows(textLengthRow, rows)) result.set(row.source, row.chars);
  }
  return result;
}
