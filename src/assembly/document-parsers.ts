import { HttpDocumentParser, VisionTableDocumentParser } from '@business-ai/adapters';
import { isArchiveName } from '@business-ai/core';
import { withScanTableParser } from '../scan-price-parser';
import type {
  DocumentParser,
  ImageReader,
  ParseOptions,
  ParsedDocument,
} from '@business-ai/core';

/** Расширения файлов-картинок: их целиком читает зрение (как у разборщика прайсов). */
const IMAGE_FILE_PATTERN = /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i;

/** Страницы скана вместе с разбором: то, что отдаёт `HttpDocumentParser.parseWithImages`. */
type ScanRead = Awaited<ReturnType<HttpDocumentParser['parseWithImages']>>;

/** Разборщик для документов (текст) и для прайсов (таблицы). */
export interface DocumentParsers {
  /** Прайсы и таблицы: картинки и сканы читает зрение в режиме `table`, остальное - таблицы. */
  table: DocumentParser;
  /** Документы: сканы PDF уходят страницами в чтение изображений целиком (текст и таблицы). */
  text: DocumentParser;
}

/**
 * Разборщик документов (договор, счёт, карточка компании), где скан читается целиком.
 *
 * Табличный разборщик (`VisionTableDocumentParser`) читает страницы скана в режиме `table`,
 * оставляет только таблицы и теряет остальной текст (реквизиты в шапке счёта); если таблиц нет,
 * скан остаётся нечитаемым, а страниц картинками он не отдаёт. Здесь скан PDF возвращается
 * как есть (`needsOcr`), а `parseWithImages` отдаёт его страницы: чтение вложений
 * (`buildAttachmentContext`) отправляет их в чтение изображений в действующем режиме
 * (`IMAGE_TEXT_MODE`, распознавание и маскирование ПДн как у любого фото в чате).
 * Всё, что не скан PDF, идёт прежним табличным разборщиком без изменений.
 */
export class ScanTextDocumentParser implements DocumentParser {
  /** Страницы последнего прочитанного скана: тот же файл не разбирается во второй раз. */
  private readonly scans = new WeakMap<Uint8Array, ScanRead>();

  constructor(
    private readonly base: HttpDocumentParser,
    private readonly fallback: DocumentParser,
  ) {}

  /** Сканы сам не читает (их берёт чтение вложений), поэтому для прайсов он не «читающий». */
  readonly readsImages = false;

  /** Архивы раскрывает базовый разборщик через табличный. */
  get readsArchives(): boolean {
    return this.fallback.readsArchives === true;
  }

  async parse(name: string, content: Uint8Array, options?: ParseOptions): Promise<ParsedDocument> {
    // Архивы и файлы-картинки табличный разборщик обрабатывает сам и без нашего вмешательства.
    if (isArchiveName(name) || IMAGE_FILE_PATTERN.test(name)) {
      return this.fallback.parse(name, content, options);
    }
    const read = await this.base.parseWithImages(name, content, options);
    if (read.document.needsOcr) {
      // Скан: текста нет, страницы заберёт `parseWithImages` по тому же объекту байтов.
      this.scans.set(content, read);
      return read.document;
    }
    if (read.images.length === 0) return read.document;
    // Картинки внутри обычного документа читает табличный разборщик, как раньше.
    return this.fallback.parse(name, content, options);
  }

  /** Страницы скана картинками; повторного запроса к сервису разбора нет после `parse`. */
  async parseWithImages(
    name: string,
    content: Uint8Array,
    options?: ParseOptions,
  ): Promise<ScanRead> {
    const cached = this.scans.get(content);
    if (cached !== undefined) {
      this.scans.delete(content);
      return cached;
    }
    return this.base.parseWithImages(name, content, options);
  }
}

/** Параметры сборки разборщиков: новое поведение этапа 9v включается явно, без них - прежнее. */
export interface DocumentParserOptions {
  /**
   * Сканы прайсов (`PRICES_SCAN_FLOW_ENABLED`): табличный разборщик оставляет распознанный
   * текст скана, а позиции скана становятся таблицей. Разборщик документов не меняется.
   */
  scanFlow?: boolean;
  /** Предупреждение о картинках с текстом по слайдам (`VISION_TEXT_FIRST`); false - прежнее. */
  textFirstWarnings?: boolean;
}

/**
 * Разборщики проекта. Для боевого `HttpDocumentParser` - табличный (прайсы) и текстовый
 * (документы); для любого другого (тестовая заглушка) - один и тот же исходный, как раньше.
 */
export function buildDocumentParsers(
  source: DocumentParser,
  imageReader: ImageReader,
  options: DocumentParserOptions = {},
): DocumentParsers {
  if (!(source instanceof HttpDocumentParser)) return { table: source, text: source };
  const textFirstWarnings = options.textFirstWarnings ?? true;
  const plain = new VisionTableDocumentParser(source, imageReader, { textFirstWarnings });
  const text = new ScanTextDocumentParser(source, plain);
  if (options.scanFlow !== true) return { table: plain, text };
  const prices = withScanTableParser(
    new VisionTableDocumentParser(source, imageReader, { textFirstWarnings, keepScanText: true }),
    true,
  );
  // Документам скан нужен целиком страницами: их разборщик остаётся прежним табличным.
  return { table: prices, text };
}
