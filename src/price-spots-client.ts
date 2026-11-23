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
 * Числа вне таблиц презентации (этап 9q). Сервис документов умеет отдать карту правимых мест
 * pptx: `POST /parse` с полем `locations=true` (при `DOCUMENTS_EDIT_PPTX`) добавляет в ответ
 * `locations` - числа в текстовых блоках и группах с локаторами `slide/shape/paragraph/start`.
 * Адаптер платформы `/parse` этого поля не просит и не отдаёт, поэтому проект читает карту сам.
 * Любой сбой (сеть, срок, не-200, ответ не по схеме, сервис без поля) даёт `null`: правка цен в
 * таблицах от карты не зависит и работает как прежде.
 */

const SERVICE = 'документов (карта мест pptx)';
/** Имена полей формы `/parse` (контракт сервиса документов). */
const FILE_FIELD = 'file';
const LOCATIONS_FIELD = 'locations';
const LOCATIONS_ON = 'true';
/** Расширения презентаций, для которых сервис может вернуть карту мест. */
const SPOT_EXTENSIONS = ['.pptx', '.ppt'] as const;
/** Причина отказа при истечении срока запроса. */
const TIMEOUT_REASON = 'timeout';

/** Число в текстовом блоке слайда: локатор правки и текст вокруг. */
export interface PriceSpot {
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

/** Фигура, в которой числа не правятся: картинка, диаграмма, SmartArt, OLE. */
export interface UnreachableShape {
  slide: number;
  shape: string;
  kind: string;
}

/** Карта чисел вне таблиц презентации. */
export interface PriceSpotMap {
  spots: readonly PriceSpot[];
  unreachable: readonly UnreachableShape[];
  /** Сервис обрезал карту по своему пределу. */
  truncated: boolean;
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

const spotSchema = z.object({
  slide: z.number().int().min(1),
  shape: z.string().min(1),
  paragraph: z.number().int().min(0),
  start: z.number().int().min(0),
  text: z.string(),
  context: z.string(),
});

const unreachableSchema = z.object({
  slide: z.number().int().min(1),
  shape: z.string(),
  kind: z.string(),
});

const locationsSchema = z.object({
  spots: z.array(spotSchema),
  unreachable: z.array(unreachableSchema).default([]),
  truncated: z.boolean().default(false),
});

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
      // Сервис без правки pptx или со старой версией поле не отдаёт: карты нет, это не сбой.
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
