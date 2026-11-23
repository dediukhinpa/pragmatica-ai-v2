import type { PriceItem } from '../domain/models';

/** Через сколько часов брошенный (не зафиксированный) импорт удаляется `purgeStale`. */
export const STAGING_RETENTION_HOURS = 48;

/** Чей и какого файла импорт: задаётся первым куском и дальше не меняется. */
export interface StagingHeader {
  supplierId: string;
  fileHash: string;
}

/** Кусок разобранных позиций одной таблицы (листа) исходного файла. */
export interface StagingChunk {
  /** Ключ куска: повторная отправка того же куска ничего не добавляет. */
  key: string;
  /** Таблица (лист) исходника, из которой взят кусок. */
  table: string;
  /** Сколько всего строк данных в этой таблице исходника (для сверки при фиксации). */
  tableRows: number;
  items: PriceItem[];
  /** Строк этого куска, признанных «не позиция» (для сводки человеку). */
  skippedRows?: number;
  /** Парсер обрезал файл по лимитам: признак сохраняется на весь импорт (любой кусок). */
  truncated?: boolean;
}

/** Накопленный импорт, готовый к фиксации. */
export interface StagedImport extends StagingHeader {
  importId: string;
  /** Сумма строк данных по всем таблицам, из которых брали куски. */
  sourceRowCount: number;
  /** Строк «не позиция», пропущенных при разборе (группы, итоги, «по запросу», шапка). */
  skippedRowCount: number;
  /** Хотя бы один кусок пришёл из усечённого парсером файла. */
  truncated: boolean;
  /** Позиции в порядке добавления кусков. */
  items: PriceItem[];
}

/**
 * Промежуточное хранилище больших прайсов: позиции складываются кусками под `importId`,
 * затем целиком забираются для проверок и атомарной замены прайса поставщика
 * (`PriceRepository.saveImport`). Модель сами позиции не видит и не копирует.
 */
export interface ImportStaging {
  /**
   * Добавить кусок. Повтор куска с тем же ключом не меняет данные. Другой поставщик или
   * хэш файла под тем же `importId` — DomainError('conflict'). Возвращает число позиций
   * в импорте после добавления.
   */
  append(
    importId: string,
    header: StagingHeader,
    chunk: StagingChunk,
    now: Date,
  ): Promise<number>;
  /** Весь накопленный импорт; null, если такого нет. */
  load(importId: string): Promise<StagedImport | null>;
  /** Есть ли такой импорт: без выгрузки позиций (для проверок «staging ещё не очищен»). */
  exists(importId: string): Promise<boolean>;
  /** Удалить импорт со всеми кусками (после фиксации или для старта заново). */
  discard(importId: string): Promise<void>;
  /** Удалить импорты, начатые раньше `before`. Возвращает число удалённых. */
  purgeStale(before: Date): Promise<number>;
}
