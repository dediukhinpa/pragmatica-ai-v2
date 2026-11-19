import { MemoryBotFileRegistry, MemoryWorkflowStateStore } from '@business-ai/adapters';
import { createToolContext } from '@business-ai/core';
import type {
  AttachmentBundle,
  BitrixAttachmentReader,
  DocumentParser,
  ImageAttachment,
  ImageReader,
  ImageReadItem,
  ParsedDocument,
  ToolContext,
} from '@business-ai/core';
import type { ChatAttachmentsHost } from '../../src/agents/order-calc/read-chat-attachments';

/** Хелпер тестов постраничного чтения: порты-заглушки с подсчётом вызовов (данные синтетика). */

const SCAN_MARK = 'SCAN:';
const BOT_ID = 1;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Файл чата: обычный текст либо скан со страницами. */
export interface RigFile {
  name: string;
  /** Текст файла (txt читается без парсера, остальное - парсером-заглушкой). */
  text?: string;
  /** Скан без текстового слоя: число страниц-картинок. */
  scanPages?: number;
}

/** Что отвечает ридер изображений на страницу скана (по номеру с нуля). */
export type PageAnswer = (index: number) => Pick<ImageReadItem, 'status' | 'text' | 'note'>;

export interface RigOptions {
  files: readonly RigFile[];
  /** Имя треда; по умолчанию уникальное, чтобы кэш процесса не смешивал тесты. */
  threadId?: string;
  /** Парсер сообщает, что разобрал файл не целиком. */
  parserTruncated?: boolean;
  /** Без ридера изображений (в сборке это заглушка «не настроено»). */
  noImageReader?: boolean;
  /** Ответ ридера по страницам скана. */
  pageAnswer?: PageAnswer;
  /** Парсер умеет отдавать страницы скана картинками (по умолчанию да). */
  pageImages?: boolean;
  /** Скачивание возвращает ошибку по файлу (не кэшируется). */
  fetchError?: string;
  /** Вместо отсутствующего порта вложений. */
  noAttachments?: boolean;
}

/** Собранный стенд. */
export interface PagedRig {
  deps: ChatAttachmentsHost;
  state: MemoryWorkflowStateStore;
  registry: MemoryBotFileRegistry;
  threadId: string;
  /** Счётчики вызовов портов. */
  calls: { fetches: number; parses: number; imageReads: number };
  context: () => ToolContext;
}

let threadCounter = 0;

/** Контекст хода сотрудника в чате. */
export function employeeContext(threadId: string): ToolContext {
  return createToolContext({
    threadId,
    agentId: 'documents',
    operationId: `op-${threadId}`,
    initiator: { kind: 'user', userId: 'u-1' },
  });
}

/** Контекст планового запуска: не ход сотрудника. */
export function schedulerContext(threadId: string): ToolContext {
  return createToolContext({
    threadId,
    agentId: 'documents',
    operationId: 'op-scheduler',
    initiator: { kind: 'scheduler' },
  });
}

/** Договор из пронумерованных строк около `size` знаков; без пустых хвостов, как после tidy. */
export function syntheticContract(
  size: number,
  tail = 'ПОДПИСИ СТОРОН: Иванов И. И. / Петров П. П.',
): string {
  const lines: string[] = ['ДОГОВОР ПОСТАВКИ № 7 (синтетический)'];
  let total = lines[0]?.length ?? 0;
  for (let number = 1; total < size - tail.length - 1; number += 1) {
    const line = `${number}.1. Поставщик передаёт товар партии ${number}, Покупатель принимает.`;
    lines.push(line);
    total += line.length + 1;
  }
  lines.push(tail);
  return lines.join('\n');
}

export function buildPagedRig(options: RigOptions): PagedRig {
  threadCounter += 1;
  const threadId = options.threadId ?? `documents/paged-${threadCounter}`;
  const calls = { fetches: 0, parses: 0, imageReads: 0 };
  const registry = new MemoryBotFileRegistry({ clock: { now: () => new Date() } });
  options.files.forEach((file, index) => {
    registry.remember(threadId, { botId: BOT_ID, fileId: index + 1, name: file.name });
  });
  const scanPages = new Map<string, number>();
  const attachments: BitrixAttachmentReader = {
    async fetchAttachments(): Promise<AttachmentBundle> {
      calls.fetches += 1;
      const loaded = options.files.map((file) => {
        const isScan = file.scanPages !== undefined;
        if (isScan) scanPages.set(file.name, file.scanPages ?? 0);
        const body = isScan ? `${SCAN_MARK}${file.name}` : (file.text ?? '');
        return {
          name: file.name,
          mime: 'application/octet-stream',
          bytes: encode(body),
          source: 'bot' as const,
        };
      });
      const errors =
        options.fetchError === undefined
          ? []
          : [{ name: 'сбой.pdf', message: options.fetchError }];
      return { attachments: loaded, errors } as AttachmentBundle;
    },
  };
  const parsed = (text: string, needsOcr: boolean): ParsedDocument => ({
    text,
    tables: [],
    needsOcr,
    hasHiddenContent: false,
    hiddenSheets: [],
    truncated: options.parserTruncated === true,
    warnings: [],
  });
  const parserBase: DocumentParser = {
    async parse(_name, bytes) {
      calls.parses += 1;
      const body = decode(bytes);
      return body.startsWith(SCAN_MARK) ? parsed('', true) : parsed(body, false);
    },
  };
  const parser: DocumentParser =
    options.pageImages === false
      ? parserBase
      : Object.assign(parserBase, {
          async parseWithImages(name: string) {
            const count = scanPages.get(name) ?? 0;
            const images = Array.from({ length: count }, (_, index) => ({
              mime: 'image/png',
              bytes: encode(`${name}-страница-${index + 1}`),
              index: index + 1,
              location: `стр. ${index + 1}`,
            }));
            return { images };
          },
        });
  const answer: PageAnswer =
    options.pageAnswer ?? ((index) => ({ status: 'ok', text: `Текст страницы ${index + 1}` }));
  const imageReader: ImageReader = {
    async describe(images: readonly ImageAttachment[]) {
      calls.imageReads += 1;
      const items = images.map((image, index): ImageReadItem => ({
        name: image.name,
        source: image.source,
        ...answer(index),
      }));
      return { items, usage: { inputTokens: 0, outputTokens: 0, images: images.length } };
    },
  };
  const state = new MemoryWorkflowStateStore();
  const deps: ChatAttachmentsHost = {
    botFiles: registry,
    state,
    parser,
    ...(options.noAttachments === true ? {} : { attachments }),
    ...(options.noImageReader === true ? {} : { imageReader }),
  };
  const context = (): ToolContext => employeeContext(threadId);
  return { deps, state, registry, threadId, calls, context };
}
