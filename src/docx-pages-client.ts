import { z } from 'zod';
import { trimBaseUrl, type FetchFn } from '@business-ai/adapters';
import type { RenderedPage } from './docx-pages';

/** Таймаут запроса раскладки по умолчанию, мс: отрисовка длинного договора занимает секунды. */
export const DEFAULT_LAYOUT_TIMEOUT_MS = 90_000;
const STATUS_OK = 200;
/** Имя поля формы с файлом (контракт сервиса документов). */
const FILE_FIELD = 'file';
/** Поле параметров формы: платформенный разбор тела требует его у каждой ручки `/docx/*`. */
const PARAMS_FIELD = 'params';
/** Причина отказа при истечении срока запроса. */
const TIMEOUT_REASON = 'timeout';
/** Статус отказа сервиса по размеру или времени. */
const STATUS_TOO_LARGE = 413;
/** Заголовок сервиса: 413 вызван нагрузкой (время, память), а не размером файла. */
const REJECT_KIND_HEADER = 'X-Reject-Kind';
const REJECT_KIND_TRANSIENT = 'transient';
/** Причина отказа: файл крупнее предела конвертации (постоянная, повтор не поможет). */
export const TOO_LARGE_REASON = 'too_large';
/** Событие журнала: файл крупнее предела (страницы не запрашивались или сервис отказал). */
export const DOCX_PAGES_SKIPPED_EVENT = 'docx_pages_skipped';
/** Событие журнала: сервис раскладки недоступен или ответил сбоем. */
export const DOCX_PAGES_UNAVAILABLE_EVENT = 'docx_pages_unavailable';
const BYTES_IN_MIB = 1024 * 1024;
/**
 * Предел размера файла для раскладки по умолчанию: тот же, что `max_convert_input_bytes` сервиса
 * документов (20 МиБ). Крупнее сервис отвечает 413 ещё до запуска LibreOffice, поэтому такой
 * файл не отправляется вовсе: номера страниц - подсказка, а не условие чтения.
 */
export const DEFAULT_LAYOUT_MAX_BYTES = 20 * BYTES_IN_MIB;
/** Расширения, для которых сервис умеет отрисовать страницы. */
const LAYOUT_EXTENSIONS = ['.docx', '.doc', '.rtf'] as const;

/** Раскладка документа по страницам, отрисованным вёрсткой. */
export interface DocxLayout {
  pageCount: number;
  pages: RenderedPage[];
  /** Сервис обрезал тексты страниц по своему пределу. */
  truncated: boolean;
}

/** Порт получения раскладки документа по страницам. */
export interface DocxLayoutClient {
  /** Файл крупнее этого (байт) на раскладку не отправляется; нет - предела у клиента нет. */
  readonly maxBytes?: number | undefined;
  /** Страницы файла или `null`, если раскладка недоступна (страницы - подсказка, не отказ). */
  pages(file: { name: string; bytes: Uint8Array }): Promise<DocxLayout | null>;
}

const layoutResponse = z.object({
  page_count: z.number().int().nonnegative(),
  pages: z.array(z.object({ number: z.number().int().min(1), text: z.string() })),
  truncated: z.boolean(),
});

/** Параметры HTTP-клиента раскладки. */
export interface HttpDocxLayoutClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  /** Предел размера файла, байт; по умолчанию {@link DEFAULT_LAYOUT_MAX_BYTES}. */
  maxBytes?: number;
  fetchFn?: FetchFn;
  /** Причина отказа (без содержимого файла и его имени): для журнала, не для сотрудника. */
  onFailure?: (reason: string) => void;
}

/**
 * Причина отказа по статусу ответа: 413 без пометки «временно» - файл больше пределов сервиса
 * (постоянный отказ); остальное - сбой сервиса (в том числе 413 из-за нагрузки).
 */
function rejectReasonOf(response: Response): string {
  const transient = response.headers.get(REJECT_KIND_HEADER) === REJECT_KIND_TRANSIENT;
  if (response.status === STATUS_TOO_LARGE && !transient) return TOO_LARGE_REASON;
  return `status ${response.status}`;
}

/** Событие журнала по причине отказа: размер - штатная деградация (info), прочее - сбой. */
export function docxPagesEventOf(reason: string): string {
  return reason === TOO_LARGE_REASON ? DOCX_PAGES_SKIPPED_EVENT : DOCX_PAGES_UNAVAILABLE_EVENT;
}

/** Поддерживает ли сервис раскладку файла с таким именем (по расширению). */
export function supportsDocxLayout(name: string): boolean {
  const lower = name.toLowerCase();
  return LAYOUT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** `Blob` из байтов: для обычного буфера без лишней копии, для общей памяти с копией. */
function blobOf(bytes: Uint8Array): Blob {
  const { buffer, byteOffset, length } = bytes;
  if (buffer instanceof ArrayBuffer) return new Blob([new Uint8Array(buffer, byteOffset, length)]);
  return new Blob([new Uint8Array(bytes)]);
}

/**
 * HTTP-клиент `POST /docx/pages` сервиса документов. Любой сбой (сеть, срок, не-200, ответ не по
 * схеме, 404 от старого сервиса) даёт `null` и причину в `onFailure`: номера страниц - подсказка
 * к тексту, путь чтения документа от них не зависит, наружу ошибка не выходит.
 */
export class HttpDocxLayoutClient implements DocxLayoutClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  readonly maxBytes: number;
  private readonly fetchFn: FetchFn;
  private readonly onFailure: ((reason: string) => void) | undefined;

  constructor(options: HttpDocxLayoutClientOptions) {
    this.baseUrl = trimBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LAYOUT_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_LAYOUT_MAX_BYTES;
    this.fetchFn = options.fetchFn ?? fetch;
    this.onFailure = options.onFailure;
  }

  async pages(file: { name: string; bytes: Uint8Array }): Promise<DocxLayout | null> {
    if (!supportsDocxLayout(file.name)) return null;
    // Заведомо отказ сервиса: тяжёлый файл не гоняем по сети ради ответа 413.
    if (file.bytes.length > this.maxBytes) return this.fail(TOO_LARGE_REASON);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const form = new FormData();
      form.append(FILE_FIELD, blobOf(file.bytes), file.name);
      form.append(PARAMS_FIELD, JSON.stringify({ file_name: file.name }));
      const response = await this.fetchFn(`${this.baseUrl}/docx/pages`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (response.status !== STATUS_OK) return this.fail(rejectReasonOf(response));
      const parsed = layoutResponse.safeParse(await response.json());
      if (!parsed.success) return this.fail('invalid response');
      return {
        pageCount: parsed.data.page_count,
        pages: parsed.data.pages.map((page) => ({ number: page.number, text: page.text })),
        truncated: parsed.data.truncated,
      };
    } catch (error) {
      if (timedOut) return this.fail(TIMEOUT_REASON);
      return this.fail(error instanceof Error ? `${error.name}: ${error.message}` : 'unknown');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Сообщить причину отказа (сбой самого колбэка не выходит наружу) и вернуть `null`. */
  private fail(reason: string): null {
    try {
      this.onFailure?.(reason);
    } catch {
      // Журнал причины не должен ломать чтение документа.
    }
    return null;
  }
}
