import { DomainError } from '@business-ai/core';
import { type PriceItem } from '../../domain/models';
import type {
  ImportStaging,
  StagedImport,
  StagingChunk,
  StagingHeader,
} from '../../ports/import-staging';
import { deleteWhere } from '@business-ai/adapters';

interface Entry {
  header: StagingHeader;
  createdAt: number;
  chunkKeys: Set<string>;
  /** Строк данных по таблицам исходника. */
  tables: Map<string, number>;
  /** Пропущенные строки («не позиция») по ключу куска: повтор куска не удваивает счёт. */
  skipped: Map<string, number>;
  truncated: boolean;
  items: PriceItem[];
}

/** Staging импорта прайсов в памяти. */
export class MemoryImportStaging implements ImportStaging {
  private readonly imports = new Map<string, Entry>();

  async append(
    importId: string,
    header: StagingHeader,
    chunk: StagingChunk,
    now: Date,
  ): Promise<number> {
    let entry = this.imports.get(importId);
    if (entry === undefined) {
      entry = {
        header: { ...header },
        createdAt: now.getTime(),
        chunkKeys: new Set(),
        tables: new Map(),
        skipped: new Map(),
        truncated: false,
        items: [],
      };
      this.imports.set(importId, entry);
    } else if (
      entry.header.supplierId !== header.supplierId ||
      entry.header.fileHash !== header.fileHash
    ) {
      throw new DomainError(
        'conflict',
        `Импорт ${importId} начат для другого файла или поставщика.`,
      );
    }
    entry.tables.set(chunk.table, chunk.tableRows);
    if (chunk.truncated === true) entry.truncated = true;
    if (!entry.chunkKeys.has(chunk.key)) {
      entry.chunkKeys.add(chunk.key);
      entry.skipped.set(chunk.key, chunk.skippedRows ?? 0);
      entry.items.push(...chunk.items.map((item) => ({ ...item })));
    }
    return entry.items.length;
  }

  async load(importId: string): Promise<StagedImport | null> {
    const entry = this.imports.get(importId);
    if (entry === undefined) return null;
    return {
      importId,
      ...entry.header,
      sourceRowCount: [...entry.tables.values()].reduce((sum, rows) => sum + rows, 0),
      skippedRowCount: [...entry.skipped.values()].reduce((sum, rows) => sum + rows, 0),
      truncated: entry.truncated,
      items: entry.items.map((item) => ({ ...item })),
    };
  }

  async exists(importId: string): Promise<boolean> {
    return this.imports.has(importId);
  }

  async discard(importId: string): Promise<void> {
    this.imports.delete(importId);
  }

  async purgeStale(before: Date): Promise<number> {
    return deleteWhere(this.imports, (entry) => entry.createdAt < before.getTime());
  }
}
