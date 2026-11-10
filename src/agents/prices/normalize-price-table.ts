import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import { PRICE_TIER_BASES, priceItemSchema, type PriceItem } from '../../kit/domain/models';
import { defineTool } from '@business-ai/core';
import type { PricesDeps } from './deps';
import type { MailAccess } from './price-state';
import { parseSource } from './parse-cache';
import { hiddenTableWarnings } from './sheet-tables';
import { assertSourceSupplier, openPriceSource, type PriceSource } from './price-sources';
import {
  currencyMismatchWarning,
  parseTableRows,
  resolveTableCurrency,
  tierWarnings,
  type ParsedRows,
} from './table-rows';

/** Номера столбцов (с нуля, как в markdown из readPriceFile). */
const columnsSchema = z.object({
  name: z.number().int().nonnegative(),
  /** Столбец единственной цены; при нескольких ценах по тиражам вместо него - priceTiers. */
  price: z.number().int().nonnegative().optional(),
  /**
   * Цены по тиражам («от 50 шт», «от 100 шт» в разных столбцах): столбец и минимальный
   * тираж. В базу идёт цена минимального тиража, все тиражи сохраняются в позиции.
   */
  priceTiers: z
    .array(
      z.object({
        column: z.number().int().nonnegative(),
        minQuantity: z.number().int().positive(),
      }),
    )
    .min(2)
    .optional(),
  /**
   * Основание порогов priceTiers: 'quantity' (штуки, по умолчанию) или 'order_sum' - если в
   * шапке стоит сумма заказа в рублях («Цена от 62 000», «от 102 000 руб.»), а не количество.
   */
  tierBasis: z.enum(PRICE_TIER_BASES).optional(),
  sku: z.number().int().nonnegative().optional(),
  currency: z.number().int().nonnegative().optional(),
  /**
   * Столбцы варианта (размер, цвет, вес, фасовка), до трёх. Название позиции код собирает
   * как «<название> <вариант1> <вариант2>», ключ позиции учитывает варианты.
   */
  variantColumns: z.array(z.number().int().nonnegative()).optional(),
  /** Столбец группы (модель, категория): из него берётся название строк без названия. */
  group: z.number().int().nonnegative().optional(),
  /**
   * Название в строке-заголовке группы (есть название, нет цены): строки под ней без
   * названия получают название группы.
   */
  groupHeaderRows: z.boolean().optional(),
});

export const rejectedSchema = z.object({ row: z.number().int(), reason: z.string() });
export const skippedSchema = z.object({
  row: z.number().int(),
  reason: z.string(),
  text: z.string(),
});

/** Сколько пропущенных строк («не позиция») показываем агенту; остальные только числом. */
export const MAX_SKIPPED_LISTED = 50;

/**
 * Сколько позиций normalizePriceTable возвращает модели. Лист на 50 тыс. строк - это ~5 МБ
 * JSON в контексте и в истории треда; для проверки разбора хватает начала таблицы, остальное
 * идёт через stagePriceRows, который позиции модели не отдаёт.
 */
export const MAX_NORMALIZED_ITEMS_LISTED = 500;

/** Подсказка модели, когда список позиций усечён. */
const ITEMS_TRUNCATED_HINT =
  `Показаны первые ${MAX_NORMALIZED_ITEMS_LISTED} позиций из таблицы; для большого прайса ` +
  'не сохраняй через savePriceImport, а загрузи таблицу через stagePriceRows (позиции ' +
  'инструмент хранит сам) и зафиксируй commitPriceImport.';

/** Указатель на таблицу файла и сопоставление колонок: всё, что задаёт модель. */
export interface PriceTableInput {
  path: string;
  supplierId: string;
  tableIndex: number;
  headerRows: number;
  columns: z.infer<typeof columnsSchema>;
  /**
   * Валюта прайса, если её не удаётся определить из заголовка столбца цены. Расхождение с
   * заголовком - отказ `currency_mismatch`; без заголовка и аргумента - RUB.
   */
  defaultCurrency?: string | undefined;
}

export const priceTableInputShape = {
  path: z.string().min(1),
  supplierId: z.string().min(1),
  tableIndex: z.number().int().nonnegative().default(0),
  headerRows: z.number().int().nonnegative().default(1),
  columns: columnsSchema,
  defaultCurrency: z.string().length(3).optional(),
};

/** Таблица прайса, разобранная кодом. */
export interface ParsedPriceTable extends ParsedRows {
  source: PriceSource;
  /** Парсер обрезал файл по своим лимитам: прайс прочитан не целиком. */
  truncated: boolean;
  /** Валюта заголовка столбца цены расходится с defaultCurrency (молча не выбираем). */
  currencyConflict: { header: string; explicit: string } | null;
  /** Предупреждения листа: таблица взята со скрытого листа. */
  sheetWarnings: string[];
}

/**
 * Открыть таблицу прайса: поставщик, источник, разбор файла и выбор таблицы по индексу.
 * Общая преамбула parsePriceTable и stagePriceRows; ошибки и порядок проверок едины.
 */
export async function openPriceTable(
  deps: PricesDeps,
  input: PriceTableInput,
  access: MailAccess,
) {
  if ((await deps.suppliers.get(input.supplierId)) === null) {
    throw new DomainError('not_found', `Поставщик ${input.supplierId} не найден в базе.`);
  }
  const source = await openPriceSource(deps, input.path, access);
  assertSourceSupplier(source, input.supplierId);
  const parsed = await parseSource(deps.parser, source, deps.turnScope);
  const table = parsed.tables[input.tableIndex];
  if (table === undefined) {
    throw new DomainError(
      'invalid_input',
      `В файле нет таблицы ${input.tableIndex} (всего ${parsed.tables.length}).`,
    );
  }
  return { source, parsed, table };
}

/**
 * Перечитать файл по указателю и разобрать таблицу в позиции. Единственный путь, которым
 * позиции попадают в базу из файла: модель задаёт только путь и колонки, строки читает код.
 */
export async function parsePriceTable(
  deps: PricesDeps,
  input: PriceTableInput,
  access: MailAccess,
): Promise<ParsedPriceTable> {
  const { source, parsed, table } = await openPriceTable(deps, input, access);
  const currency = resolveTableCurrency(
    table,
    input.headerRows,
    input.columns,
    input.defaultCurrency,
  );
  const rows = parseTableRows(table, {
    supplierId: input.supplierId,
    headerRows: input.headerRows,
    columns: input.columns,
    defaultCurrency: currency.kind === 'ok' ? currency.currency : currency.header,
    date: deps.clock.now().toISOString(),
  });
  const currencyConflict =
    currency.kind === 'mismatch' ? { header: currency.header, explicit: currency.explicit } : null;
  const sheetWarnings = hiddenTableWarnings(parsed, input.tableIndex);
  return { ...rows, source, truncated: parsed.truncated, currencyConflict, sheetWarnings };
}

interface NormalizeOutput {
  supplierId: string;
  fileHash: string;
  /** Строк данных в исходнике (непустых, после заголовка). */
  sourceRowCount: number;
  /** Первые `MAX_NORMALIZED_ITEMS_LISTED` позиций: таблица целиком модели не отдаётся. */
  items: PriceItem[];
  /** Сколько позиций разобрано всего (в `items` может быть меньше). */
  itemsCount: number;
  /** Список `items` усечён пределом: остальные позиции модель не видит. */
  itemsTruncated: boolean;
  /** Что делать с усечённым списком (только при `itemsTruncated`). */
  hint?: string | undefined;
  /** Строки, которые не удалось разобрать (номер строки как в markdown). */
  rejected: Array<z.infer<typeof rejectedSchema>>;
  /** Строки «не позиция» (группы, «по запросу», итоги, шапка): не блокируют импорт. */
  skippedRows: Array<z.infer<typeof skippedSchema>>;
  skippedCount: number;
  warnings: string[];
}

/**
 * Разбор таблицы прайса в позиции для просмотра. Модель только указывает, какой столбец что
 * содержит; строки разбирает код. В базу эти позиции через модель не идут: savePriceImport
 * перечитывает файл сам.
 */
export const normalizePriceTable = defineTool<PriceTableInput, NormalizeOutput, PricesDeps>({
  name: 'normalizePriceTable',
  readsFile: true,
  scriptFallbackOnError: true,
  description:
    'Разобрать таблицу прайса в позиции (для проверки разбора). Укажите поставщика, номер ' +
    'таблицы, число строк заголовка и номера столбцов (name, price или - при нескольких ценах за тиражи - priceTiers ' +
    '[{column, minQuantity}] (и tierBasis=order_sum, если порог в шапке - сумма заказа в рублях), ' +
    'при наличии sku и currency; для вариантов - variantColumns до трёх столбцов размера/цвета/веса/фасовки, ' +
    'для названия только в строке-заголовке группы или в объединённой ячейке - ' +
    'groupHeaderRows=true либо group). Матрица «размер × тираж» (название товара - строкой-заголовком группы): ' +
    'name и variantColumns=[тот же столбец размера], groupHeaderRows=true, priceTiers; диапазоны в ячейках тиражей сохраняются. Название и ключ с вариантами собирает код. Валюта берётся из заголовка столбца цены («Цена, USD»); defaultCurrency ' +
    'нужен, только если в заголовке её нет, и не должен ему противоречить. Возвращает ' +
    'позиции, число строк исходника, отклонённые строки (rejected: блокируют запись), ' +
    'пропущенные строки (skippedRows: группы, «по запросу», итоги, шапка - не позиции, ' +
    'запись не блокируют, покажите их человеку) и fileHash. ' +
    'Для записи вызовите savePriceImport с тем же path, fileHash и столбцами: позиции в ' +
    `него не передаются. Показываются не более ${MAX_NORMALIZED_ITEMS_LISTED} позиций ` +
    '(itemsTruncated=true, itemsCount - сколько разобрано всего): большую таблицу ' +
    'загружайте через stagePriceRows.',
  inputSchema: z.object(priceTableInputShape),
  outputSchema: z.object({
    supplierId: z.string(),
    fileHash: z.string(),
    sourceRowCount: z.number().int(),
    items: z.array(priceItemSchema),
    itemsCount: z.number().int(),
    itemsTruncated: z.boolean(),
    hint: z.string().optional(),
    rejected: z.array(rejectedSchema),
    skippedRows: z.array(skippedSchema),
    skippedCount: z.number().int(),
    /** Предупреждения разбора (валюта заголовка вместо аргумента и т. п.). */
    warnings: z.array(z.string()),
  }),
  async execute(input, deps, context) {
    const table = await parsePriceTable(deps, input, context);
    // Расхождение валюты - не отказ: позиции уже разобраны с валютой заголовка, сотруднику
    // уходит предупреждение (этап 177).
    const warnings = [
      ...(table.currencyConflict === null
        ? []
        : [
            currencyMismatchWarning(
              table.currencyConflict.header,
              table.currencyConflict.explicit,
            ),
          ]),
      ...tierWarnings(input.columns),
      ...table.sheetWarnings,
    ];
    const itemsTruncated = table.items.length > MAX_NORMALIZED_ITEMS_LISTED;
    return {
      supplierId: input.supplierId,
      fileHash: table.source.hash,
      sourceRowCount: table.sourceRowCount,
      items: itemsTruncated ? table.items.slice(0, MAX_NORMALIZED_ITEMS_LISTED) : table.items,
      itemsCount: table.items.length,
      itemsTruncated,
      ...(itemsTruncated ? { hint: ITEMS_TRUNCATED_HINT } : {}),
      rejected: table.rejected,
      skippedRows: table.skipped.slice(0, MAX_SKIPPED_LISTED),
      skippedCount: table.skipped.length,
      warnings,
    };
  },
});
