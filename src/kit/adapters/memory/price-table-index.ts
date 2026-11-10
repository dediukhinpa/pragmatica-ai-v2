import { looksLikePriceTableText, PRICE_TABLE_CHUNK_COUNT } from '../../domain/price-table-signal';
import type { PriceTableIndex, PriceTableVerdict } from '../../ports/price-table-index';

/** Признак «таблица цен» в памяти: тексты фрагментов кладутся служебным методом. */
export class MemoryPriceTableIndex implements PriceTableIndex {
  private readonly chunksBySource = new Map<string, string[]>();
  /** Сколько раз просили вердикты (для проверок «одна пачка, а не файл за файлом»). */
  calls = 0;

  /** Положить фрагменты файла по порядку (служебный метод заглушки). */
  put(source: string, chunks: readonly string[]): void {
    this.chunksBySource.set(source, [...chunks]);
  }

  async verdicts(paths: readonly string[]): Promise<Map<string, PriceTableVerdict>> {
    this.calls += 1;
    const result = new Map<string, PriceTableVerdict>();
    for (const path of paths) {
      const chunks = this.chunksBySource.get(path);
      if (chunks === undefined) {
        result.set(path, 'absent');
        continue;
      }
      const text = chunks.slice(0, PRICE_TABLE_CHUNK_COUNT).join('\n');
      result.set(path, looksLikePriceTableText(text) ? 'table' : 'not_table');
    }
    return result;
  }
}
