import { PostgresPriceRepository } from '../../src/kit/adapters/postgres/price-repository';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import type { PgClient } from '@business-ai/adapters';
import type { StubReply } from '@business-ai/testing/e2e';
import { lastResult } from '@business-ai/testing/e2e';

/** Поставщик и колонки прайса из фикстуры (синхронно с fixtures/make_fixtures.py). */
export const FLOW_SUPPLIER_ID = 'sup-e2e-flow';
export const COLUMNS = { sku: 0, name: 1, price: 2, currency: 3 };
const HEADER_WORD = 'Наименование';
/** Цены в базе занижены вдвое: каждая позиция файла даёт «скачок» сверх порога. */
const SEED_PRICE_FACTOR = 0.5;
const SEED_DATE = '2026-09-01';
/** Позиции фикстуры: артикул, название, цена файла. */
const FILE_ROWS: Array<[string, string, number]> = [
  ['AR-001', 'Арматура А500С d12', 62500.5],
  ['AR-002', 'Арматура А500С d16', 61800.0],
  ['LS-010', 'Лист стальной 3 мм', 71200.0],
  ['TR-020', 'Труба профильная 40x40', 68900.25],
  ['UG-030', 'Уголок равнополочный 50', 64300.0],
];
/**
 * Шаги агента до сравнения с базой: список файлов, чтение, staging, сравнение. Вопроса человеку
 * после них нет: подтверждение прайса снято (26.10.2026).
 */
export const JUMP_FLOW_STEPS = 4;

/** Число строк шапки по markdown из readPriceFile (строки нумеруются с нуля). */
export function headerRowCount(markdown: string): number {
  for (const line of markdown.split('\n')) {
    const match = /^\|\s*(\d+)\s*\|/.exec(line);
    if (match !== null && line.includes(HEADER_WORD)) return Number(match[1]) + 1;
  }
  throw new Error('В markdown прайса нет строки заголовка');
}

/** Поставщик и прайс в базе, где все цены вдвое ниже файла: импорт файла даст скачки. */
export async function seedJumpyPrices(db: PgClient): Promise<void> {
  const suppliers = new PostgresSupplierRepository(db);
  await suppliers.upsert({ id: FLOW_SUPPLIER_ID, name: 'ООО Металлопрокат' });
  await new PostgresPriceRepository(db).saveImport(
    FLOW_SUPPLIER_ID,
    FILE_ROWS.map(([sku, productName, price]) => ({
      supplierId: FLOW_SUPPLIER_ID,
      sku,
      productName,
      price: price * SEED_PRICE_FACTOR,
      currency: 'RUB',
      date: SEED_DATE,
    })),
    'e2e-seed-jumpy-prices',
  );
}

/** Вызов `readPriceFile` для первого файла из результата `listPriceFiles` в истории. */
export function readFirstFileReply(body: Record<string, unknown>): StubReply {
  const files = lastResult(body, 'listPriceFiles')['files'];
  const first = Array.isArray(files) ? files[0] : undefined;
  const path = (first as { path?: string } | undefined)?.path;
  if (path === undefined) throw new Error('listPriceFiles не вернул файлов');
  return { kind: 'tool', name: 'readPriceFile', input: { path } };
}

/**
 * Реплики агента «Актуализация прайса (ИИ агент)»: список файлов, чтение, staging, сравнение.
 * Шаг считает вызывающий. Запроса решения человека больше нет (подтверждение прайса снято),
 * поэтому ход на этих шагах не приостанавливается. `_db` оставлен для прежних вызовов.
 */
export async function jumpFlowReply(
  step: number,
  body: Record<string, unknown>,
  _db: PgClient,
): Promise<StubReply> {
  switch (step) {
    case 0:
      return { kind: 'tool', name: 'listPriceFiles', input: {} };
    case 1:
      return readFirstFileReply(body);
    case 2: {
      const read = lastResult(body, 'readPriceFile');
      return {
        kind: 'tool',
        name: 'stagePriceRows',
        input: {
          path: read['path'],
          supplierId: FLOW_SUPPLIER_ID,
          tableIndex: 0,
          headerRows: headerRowCount(String(read['markdown'])),
          columns: COLUMNS,
          reset: true,
        },
      };
    }
    case 3: {
      const staged = lastResult(body, 'stagePriceRows');
      return {
        kind: 'tool',
        name: 'previewPriceChanges',
        input: { supplierId: FLOW_SUPPLIER_ID, fileHash: staged['fileHash'] },
      };
    }
    default:
      throw new Error(`Нет реплики для шага ${step}`);
  }
}
