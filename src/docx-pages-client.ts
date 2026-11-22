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
  fetchFn?: FetchFn;
  /** Причина отказа (без содержимого файла и его имени): для журнала, не для сотрудника. */
  onFailure?: (reason: string) => void;
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
  private readonly fetchFn: FetchFn;
  private readonly onFailure: ((reason: string) => void) | undefined;

  constructor(options: HttpDocxLayoutClientOptions) {
    this.baseUrl = trimBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LAYOUT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? fetch;
    this.onFailure = options.onFailure;
  }

  async pages(file: { name: string; bytes: Uint8Array }): Promise<DocxLayout | null> {
    if (!supportsDocxLayout(file.name)) return null;
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
      if (response.status !== STATUS_OK) return this.fail(`status ${response.status}`);
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
