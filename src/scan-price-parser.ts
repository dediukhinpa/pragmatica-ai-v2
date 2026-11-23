import type { DiskFile, DocumentParser, ParseOptions, ParsedDocument } from '@business-ai/core';
import { DOUBT_LABELS, readScanText, type ScanLine } from './scan-price-lines';

/**
 * Разборщик-надстройка: позиции скана становятся таблицей (этап 9v, решение владельца: сканы
 * прайсов идут в базу без подтверждения, спорные строки - на проверку).
 *
 * Табличный разборщик картинок в режиме токенов отдаёт распознанный скан обычным текстом, без
 * таблицы, а весь импорт прайса работает по таблицам. Здесь код читает этот текст
 * (`readScanText`) и строит таблицу из ПОНЯТНЫХ позиций; строки с нечитаемыми или несошедшимися
 * числами в таблицу не попадают (их не записать, не угадывая), а перечислены в предупреждениях
 * «на проверку». Файл с готовой таблицей (зрение в режиме `table`) и обычные файлы не меняются.
 */

/** Признак распознанного скана в предупреждении разборщика картинок. */
const RECOGNIZED_FROM_SCAN = /распознан[а-я]*\s+со скана/iu;
/** Шапка таблицы из скана: по ней агент выбирает столбцы в `stagePriceRows`. */
export const SCAN_TABLE_HEADER: readonly string[] = ['Наименование', 'Кол-во', 'Цена', 'Сумма'];
/** Сколько спорных позиций называем в предупреждении; остальное - числом. */
const MAX_DOUBTFUL_LISTED = 10;
/** Предупреждение: позиции получены из скана, источник записи - скан. */
export const SCAN_IMPORT_WARNING =
  'Позиции получены из скана (источник «скан»): цифры и названия распознаны моделью, ' +
  'сверьте с оригиналом.';

/** Строка таблицы из понятной позиции. */
function rowOf(line: ScanLine): string[] {
  return [
    line.name,
    line.qty === null ? '' : String(line.qty),
    line.price === null ? '' : String(line.price),
    line.sum === null ? '' : String(line.sum),
  ];
}

/** Предупреждение «на проверку»: позиции, которые код не стал записывать. */
function reviewWarning(doubtful: readonly ScanLine[]): string {
  const listed = doubtful
    .slice(0, MAX_DOUBTFUL_LISTED)
    .map((line) => `«${line.name}» (${line.doubts.map((d) => DOUBT_LABELS[d]).join(', ')})`)
    .join('; ');
  const rest = doubtful.length - MAX_DOUBTFUL_LISTED;
  const tail = rest > 0 ? `; ещё ${rest}` : '';
  return (
    `Скан: на проверку ${doubtful.length} поз., в таблицу и в базу они не вошли: ` +
    `${listed}${tail}. Считайте их в needsReview.`
  );
}

/** Скан с распознанным текстом без таблицы -> документ с таблицей понятных позиций. */
export function withScanTable(document: ParsedDocument): ParsedDocument {
  const fromScan = document.warnings.some((warning) => RECOGNIZED_FROM_SCAN.test(warning));
  if (!fromScan || document.needsOcr || document.tables.length > 0) return document;
  if (document.text.trim() === '') return document;
  const { lines } = readScanText(document.text);
  if (lines.length === 0) return document;
  const clear = lines.filter((line) => line.doubts.length === 0 && line.price !== null);
  const doubtful = lines.filter((line) => line.doubts.length > 0 || line.price === null);
  const warnings = [...document.warnings, SCAN_IMPORT_WARNING];
  if (doubtful.length > 0) warnings.push(reviewWarning(doubtful));
  if (clear.length === 0) return { ...document, warnings };
  return {
    ...document,
    tables: [[[...SCAN_TABLE_HEADER], ...clear.map(rowOf)]],
    tableNames: ['Скан'],
    warnings,
  };
}

/** Надстройка над разборщиком прайсов: скан с текстом получает таблицу позиций. */
export class ScanTableDocumentParser implements DocumentParser {
  /** Разбор файла с диска потоком; есть, только если он есть у базового разборщика. */
  readonly parseFile?: (
    name: string,
    file: DiskFile,
    options?: ParseOptions,
  ) => Promise<ParsedDocument>;

  constructor(private readonly base: DocumentParser) {
    const parseFile = base.parseFile?.bind(base);
    if (parseFile !== undefined) {
      this.parseFile = async (name, file, options) =>
        withScanTable(await parseFile(name, file, options));
    }
  }

  /** Свойства базового разборщика сохраняются: от них зависит чтение картинок и архивов. */
  get readsImages(): boolean {
    return this.base.readsImages === true;
  }

  get readsArchives(): boolean {
    return this.base.readsArchives === true;
  }

  async parse(name: string, content: Uint8Array, options?: ParseOptions): Promise<ParsedDocument> {
    return withScanTable(await this.base.parse(name, content, options));
  }
}

/** Подключить надстройку по флагу `PRICES_SCAN_FLOW_ENABLED`; выключено - разборщик как был. */
export function withScanTableParser(parser: DocumentParser, enabled: boolean): DocumentParser {
  return enabled ? new ScanTableDocumentParser(parser) : parser;
}
