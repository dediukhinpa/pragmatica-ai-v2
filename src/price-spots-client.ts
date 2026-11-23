import { z } from 'zod';
import type { DiskFile, Telemetry } from '@business-ai/core';
import {
  DEFAULT_PARSE_TIMEOUT_MS,
  currentTurnBudget,
  httpTrace,
  requestJson,
  streamMultipart,
  trimBaseUrl,
  type FetchFn,
  type HttpTrace,
} from '@business-ai/adapters';

/**
 * Числа вне таблиц (этапы 9q и 9r). Сервис документов умеет отдать карту правимых мест:
 * `POST /parse` с полем `locations=true` добавляет в ответ `locations`. У презентации pptx (при
 * `DOCUMENTS_EDIT_PPTX`) это числа в текстовых блоках и группах с локаторами
 * `slide/shape/paragraph/start`; у PDF с текстовым слоем (при `DOCUMENTS_EDIT_PDF` и
 * `DOCUMENTS_EDIT_PDF_TEXT`, `format: "pdf"`) - числа вне таблиц с линиями: цена в предложении,
 * колонки без линий; место адресуется парой `page/spot`.
 * Адаптер платформы `/parse` этого поля не просит и не отдаёт, поэтому проект читает карту сам.
 * Любой сбой (сеть, срок, не-200, ответ не по схеме, сервис без поля) даёт `null`: правка цен в
 * таблицах от карты не зависит и работает как прежде.
 */

const SERVICE = 'документов (карта мест)';
/** Имена полей формы `/parse` (контракт сервиса документов). */
const FILE_FIELD = 'file';
const LOCATIONS_FIELD = 'locations';
const LOCATIONS_ON = 'true';
/** Расширения файлов, для которых сервис может вернуть карту мест: презентации и PDF. */
const SPOT_EXTENSIONS = ['.pptx', '.ppt', '.pdf'] as const;
/** Значение поля `format` карты мест PDF (у pptx поля может не быть). */
const PDF_FORMAT = 'pdf';
const PPTX_FORMAT = 'pptx';
/** Причина отказа при истечении срока запроса. */
const TIMEOUT_REASON = 'timeout';

/** Число в текстовом блоке слайда pptx: локатор правки и текст вокруг. */
export interface PptxPriceSpot {
  kind: 'pptx';
  /** Слайд с 1. */
  slide: number;
  /** Путь фигуры: id через «/» (для группы «7/12»). */
  shape: string;
  /** Абзац с 0 (пустые абзацы считаются). */
  paragraph: number;
  /** Смещение числа в тексте абзаца с 0. */
  start: number;
  /** Само число как в тексте («680», «1 200,50 руб.», «₽ 99»). */
  text: string;
  /** Окно текста абзаца вокруг числа (до 200 знаков). */
  context: string;
}

/**
 * Число в PDF вне таблиц с линиями (этап 9r): цена в тексте или в колонке без линий. Адрес места -
 * страница и номер места на ней; число в `text` без валюты и слов («1 250,00»).
 */
export interface PdfPriceSpot {
  kind: 'pdf';
  /** Страница с 1. */
  page: number;
  /** Номер места на странице с 0 (по строкам сверху вниз, слева направо). */
  spot: number;
  /** Число как напечатано: «1 250,00»; валюта и слова вокруг в место не входят. */
  text: string;
  /** Строка вокруг числа (до 200 знаков), колонки разделены « | ». */
  context: string;
  /** Номер таблицы без линий, в которую попало число; null - число в обычном тексте. */
  textTable: number | null;
  /** Строка и столбец в такой таблице (подсказка, правки не касается). */
  row: number | null;
  col: number | null;
  /** Заголовок столбца такой таблицы; null - не определён. */
  header: string | null;
}

/** Число вне таблиц: слайда pptx или страницы PDF (различаются по `kind`). */
export type PriceSpot = PptxPriceSpot | PdfPriceSpot;

/** Фигура pptx, в которой числа не правятся: картинка, диаграмма, SmartArt, OLE. */
export interface UnreachableShape {
  slide: number;
  shape: string;
  kind: string;
}

/** Страница PDF, на которой числа не правятся: повёрнутый текст, нет текстового слоя и т. п. */
export interface UnreachablePage {
  page: number;
  kind: string;
}

/** Карта чисел вне таблиц файла: все места одного вида (pptx или PDF). */
export interface PriceSpotMap {
  spots: readonly PriceSpot[];
  unreachable: readonly (UnreachableShape | UnreachablePage)[];
  /** Сервис обрезал карту по своему пределу. */
  truncated: boolean;
}

/** Место pptx (по `kind`). */
export function isPptxSpot(spot: PriceSpot): spot is PptxPriceSpot {
  return spot.kind === 'pptx';
}

/** Место PDF (по `kind`). */
export function isPdfSpot(spot: PriceSpot): spot is PdfPriceSpot {
  return spot.kind === 'pdf';
}

/** Недоступное место PDF (по полю `page`; у фигур pptx его нет). */
export function isUnreachablePage(
  item: UnreachableShape | UnreachablePage,
): item is UnreachablePage {
  return 'page' in item;
}

/** Файл для чтения карты: байты в памяти либо файл на диске (большой уходит потоком). */
export type PriceSpotFile =
  | { name: string; bytes: Uint8Array; disk?: undefined }
  | { name: string; disk: DiskFile; bytes?: undefined };

/** Порт чтения чисел вне таблиц презентации. */
export interface PriceSpotReader {
  /** Карта мест или `null`, если её нет (не презентация, сервис без поддержки, сбой). */
  read(file: PriceSpotFile): Promise<PriceSpotMap | null>;
}

const pptxSpotSchema = z
  .object({
    slide: z.number().int().min(1),
    shape: z.string().min(1),
    paragraph: z.number().int().min(0),
    start: z.number().int().min(0),
    text: z.string(),
    context: z.string(),
  })
  .transform((spot): PptxPriceSpot => ({ kind: 'pptx', ...spot }));

const pdfSpotSchema = z
  .object({
    page: z.number().int().min(1),
    spot: z.number().int().min(0),
    text: z.string(),
    context: z.string().default(''),
    text_table: z.number().int().min(0).nullish(),
    row: z.number().int().min(0).nullish(),
    col: z.number().int().min(0).nullish(),
    header: z.string().nullish(),
  })
  .transform(
    (spot): PdfPriceSpot => ({
      kind: 'pdf',
      page: spot.page,
      spot: spot.spot,
      text: spot.text,
      context: spot.context,
      textTable: spot.text_table ?? null,
      row: spot.row ?? null,
      col: spot.col ?? null,
      header: spot.header ?? null,
    }),
  );

const unreachableSchema = z.object({
  slide: z.number().int().min(1),
  shape: z.string(),
  kind: z.string(),
});

const unreachablePageSchema = z.object({
  page: z.number().int().min(1),
  kind: z.string(),
});

const pptxLocationsSchema = z.object({
  // Сервис прежних версий поля `format` у презентации не отдаёт
  format: z.literal(PPTX_FORMAT).optional(),
  spots: z.array(pptxSpotSchema),
  unreachable: z.array(unreachableSchema).default([]),
  truncated: z.boolean().default(false),
});

const pdfLocationsSchema = z.object({
  format: z.literal(PDF_FORMAT),
  spots: z.array(pdfSpotSchema),
  unreachable: z.array(unreachablePageSchema).default([]),
  truncated: z.boolean().default(false),
});

/** Карта по формату: `format: "pdf"` - места PDF, иначе (поля нет или `pptx`) - слайдов. */
const locationsSchema = z.union([pdfLocationsSchema, pptxLocationsSchema]);

/** Ответ `/parse`: нужно только поле `locations`, остальное (текст, таблицы) не читается. */
const responseSchema = z.object({ locations: locationsSchema.nullish() });

/** Параметры HTTP-клиента карты мест. */
export interface HttpPriceSpotReaderOptions {
  baseUrl: string;
  /** Срок запроса, мс; по умолчанию как у разбора документов (слот разбора общий). */
  timeoutMs?: number;
  fetchFn?: FetchFn;
  /** Телеметрия: спан `http.client`; не задана - как раньше. */
  telemetry?: Telemetry | undefined;
  /** Причина отказа (без имени и содержимого файла): для журнала, не для сотрудника. */
  onFailure?: (reason: string) => void;
}

/** Поддерживает ли клиент файл с таким именем (по расширению). */
export function supportsPriceSpots(name: string): boolean {
  const lower = name.toLowerCase();
  return SPOT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** Имя файла без каталога: в форму уходит только оно. */
function baseName(name: string): string {
  return name.split(/[\\/]/).pop() ?? name;
}

/** `Blob` из байтов: для обычного буфера без лишней копии, для общей памяти с копией. */
function blobOf(bytes: Uint8Array): Blob {
  const { buffer, byteOffset, length } = bytes;
  if (buffer instanceof ArrayBuffer) return new Blob([new Uint8Array(buffer, byteOffset, length)]);
  return new Blob([new Uint8Array(bytes)]);
}

/**
 * HTTP-клиент `POST /parse` с `locations=true`. Любой сбой даёт `null` и причину в `onFailure`:
 * наружу ошибка не выходит, чтение и правка таблиц от карты не зависят.
 */
export class HttpPriceSpotReader implements PriceSpotReader {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;
  private readonly trace: HttpTrace | undefined;
  private readonly onFailure: ((reason: string) => void) | undefined;

  constructor(options: HttpPriceSpotReaderOptions) {
    this.baseUrl = trimBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? fetch;
    this.trace = httpTrace(options.telemetry, 'documents', true);
    this.onFailure = options.onFailure;
  }

  async read(file: PriceSpotFile): Promise<PriceSpotMap | null> {
    if (!supportsPriceSpots(file.name)) return null;
    const fileName = baseName(file.name);
    try {
      const body = this.bodyOf(file, fileName);
      const data = await requestJson({
        fetchFn: this.fetchFn,
        trace: this.trace,
        service: SERVICE,
        url: `${this.baseUrl}/parse`,
        method: 'POST',
        ...body,
        timeoutMs: this.timeoutMs,
        // Ход закончился (срок, остановка) - разбор в очереди documents не ждём.
        signal: currentTurnBudget()?.signal,
        // Ожидание слота разбора срок хода не тратит.
        holdTurnClock: true,
      });
      const parsed = responseSchema.safeParse(data);
      if (!parsed.success) return this.fail('invalid response');
      const found = parsed.data.locations;
      // Сервис без правки pptx/PDF или со старой версией поле не отдаёт: карты нет, это не сбой.
      if (found == null) return null;
      return { spots: found.spots, unreachable: found.unreachable, truncated: found.truncated };
    } catch (error) {
      return this.fail(describeFailure(error));
    }
  }

  /** Тело запроса: форма в памяти или поток с диска (большой файл целиком не читается). */
  private bodyOf(
    file: PriceSpotFile,
    fileName: string,
  ):
    | { form: FormData }
    | {
        streamBody: ReadableStream<Uint8Array>;
        streamLifecycle: ReturnType<typeof streamMultipart>;
        headers: Record<string, string>;
      } {
    if (file.disk === undefined) {
      const form = new FormData();
      form.append(FILE_FIELD, blobOf(file.bytes), fileName);
      form.append(LOCATIONS_FIELD, LOCATIONS_ON);
      return { form };
    }
    const multipart = streamMultipart(
      { [LOCATIONS_FIELD]: LOCATIONS_ON },
      { field: FILE_FIELD, fileName, file: file.disk },
    );
    return { streamBody: multipart.body, streamLifecycle: multipart, headers: multipart.headers };
  }

  /** Сообщить причину отказа (сбой самого колбэка не выходит наружу) и вернуть `null`. */
  private fail(reason: string): null {
    try {
      this.onFailure?.(reason);
    } catch {
      // Журнал причины не должен ломать чтение файла.
    }
    return null;
  }
}

/** Причина сбоя для журнала: класс ошибки и признак срока, без текста сообщения. */
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    return /timeout|timed out|abort/iu.test(`${error.name} ${error.message}`)
      ? TIMEOUT_REASON
      : error.name;
  }
  return 'unknown';
}
