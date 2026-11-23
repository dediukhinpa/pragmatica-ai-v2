import { CancelledError } from '@business-ai/core';
import type { BotFileRef } from '@business-ai/core';
import type { ToolContext } from '@business-ai/core';
import { assertEmployeeChatTurn } from '@business-ai/core';
import { attachmentsSignal, safeAttachmentName } from './attachment-context';
import type { ChatAttachmentsHost } from './read-chat-attachments';

/**
 * Сырые байты файла, присланного сотруднику в личный чат (этап 158: агенту нужен сам xlsx,
 * чтобы дополнить его, а не только текст). Ссылки берутся из `botFiles`, скачивает тот же
 * `BitrixAttachmentReader`, что у readChatAttachments, - лимиты B24_ATTACHMENT_*, проверка хоста
 * и таймаут общие; своего скачивания здесь нет.
 */

/** Файл чата в списке для агента: только имя, без байтов. */
export interface ChatFileInfo {
  /** Номер в списке свежих файлов треда (с 1). */
  index: number;
  name: string;
}

/** Результат запроса байтов файла чата. */
export type ChatFileBytes =
  | { status: 'ok'; name: string; mime: string; bytes: Uint8Array }
  /** Чтение файлов чата не подключено (нет скачивания или реестра). */
  | { status: 'not_configured' }
  /** В чате нет подходящего файла (нет файлов вообще либо имя не совпало). */
  | { status: 'not_found'; available: string[] }
  /** Имени недостаточно: подходит несколько файлов. */
  | { status: 'ambiguous'; candidates: string[] }
  /** Файл найден, но не скачан (лимит размера, портал не отдал): `message` для сотрудника. */
  | { status: 'failed'; name: string; message: string };

/** Что нужно от зависимостей: те же поля, что у readChatAttachments. */
export type ChatFileBytesHost = Pick<ChatAttachmentsHost, 'attachments' | 'botFiles'>;

/** Имя файла для показа и сравнения: без управляющих символов, запасное - по id. */
function labelOf(file: BotFileRef): string {
  const name = file.name === undefined ? '' : safeAttachmentName(file.name).trim();
  return name === '' ? `файл ${file.fileId}` : name;
}

/** Свежие файлы чата (имена; байты не скачиваются). Пусто, если реестра нет. */
export function listChatFiles(deps: ChatFileBytesHost, threadId: string): ChatFileInfo[] {
  const files = deps.botFiles?.recent(threadId) ?? [];
  return files.map((file, position) => ({ index: position + 1, name: labelOf(file) }));
}

/** Запрос байтов: имя файла (без учёта регистра) или номер из {@link listChatFiles}. */
export interface ChatFileSelector {
  /** Имя файла, как в списке. Не задано и нет номера - берётся единственный подходящий файл. */
  name?: string | undefined;
  index?: number | undefined;
  /** Расширение для выбора без имени (например, `.xlsx`): прочие файлы чата не считаются. */
  extension?: string | undefined;
}

/**
 * Скачать байты одного файла из чата сотрудника. Ход должен вести сотрудник (как у
 * readChatAttachments), тред берётся из контекста хода, а не из аргументов модели. Сбой скачивания
 * не бросается: он возвращается как `failed` с пометкой для сотрудника; отмена хода пробрасывается.
 */
export async function readChatFileBytes(
  deps: ChatFileBytesHost,
  context: Pick<ToolContext, 'threadId' | 'initiator' | 'depth' | 'mode' | 'signal'>,
  selector: ChatFileSelector = {},
): Promise<ChatFileBytes> {
  assertEmployeeChatTurn(context);
  if (deps.attachments === undefined || deps.botFiles === undefined) {
    return { status: 'not_configured' };
  }
  const files = deps.botFiles.recent(context.threadId);
  const all = files.map((file) => labelOf(file));
  const wanted = selector.name?.trim().toLowerCase();
  const extension = selector.extension?.toLowerCase();
  const matches = files.filter((file, position) => {
    if (selector.index !== undefined) return position + 1 === selector.index;
    const label = labelOf(file).toLowerCase();
    if (wanted !== undefined && wanted !== '') return label === wanted;
    return extension === undefined || label.endsWith(extension);
  });
  if (matches.length === 0) return { status: 'not_found', available: all };
  // Без имени и номера берём только единственный подходящий файл: угадывать между двумя нельзя.
  const [file] = matches;
  if (file === undefined) return { status: 'not_found', available: all };
  if (matches.length > 1) return { status: 'ambiguous', candidates: matches.map(labelOf) };
  try {
    const bundle = await deps.attachments.fetchAttachments({
      botFiles: [file],
      signal: attachmentsSignal(context.signal),
    });
    const downloaded = bundle.attachments[0];
    if (downloaded !== undefined) {
      return {
        status: 'ok',
        name: downloaded.name,
        mime: downloaded.mime,
        bytes: downloaded.bytes,
      };
    }
    const message =
      bundle.errors[0]?.message ?? 'не удалось прочитать вложение (портал не отдал файл)';
    return { status: 'failed', name: labelOf(file), message };
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    return {
      status: 'failed',
      name: labelOf(file),
      message: `не удалось прочитать вложение ${labelOf(file)} (сбой чтения файлов)`,
    };
  }
}
