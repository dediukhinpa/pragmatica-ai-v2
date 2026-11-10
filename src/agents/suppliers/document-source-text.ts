import { z } from 'zod';
import type { WorkflowStateStore } from '@business-ai/core';
import type { ToolDefinition } from '@business-ai/core';
import { readState, writeState } from '@business-ai/core';

/**
 * Текст файлов и фото, которые агент прочитал из чата сотрудника (этап 219). Нужен одному:
 * чтобы дополнение карточки поставщика из документа принимало в `sourceText` только то, что
 * действительно лежит во вложениях этого треда. Раньше `sourceText` целиком давала модель, и
 * поддельная «цитата договора» (например, текст веб-страницы) проходила проверку происхождения.
 * Значения здесь реальные (до псевдонимизации): запись чистится по сроку, как текст сообщений
 * сотрудника.
 *
 * Второе назначение (ревью 233): отличить присланный документ от письма. Письмо - путь подмены
 * реквизитов, а вид материала (`origin`) называет модель; поэтому код сам отмечает, что среди
 * прочитанных вложений было письмо (`letter`): расширение .eml/.msg либо начало текста в виде
 * заголовков письма. Отметка липкая на весь тред - при сомнении реквизиты идут на подтверждение.
 */

/** Пространство состояния: накопленный текст прочитанных вложений треда. */
export const ATTACHMENT_TEXT_NAMESPACE = 'agents:attachment-text';

/** Сколько знаков текста вложений треда храним (хвост самый свежий). */
const ATTACHMENT_TEXT_MAX_CHARS = 200_000;

const attachmentTextSchema = z.object({ text: z.string(), letter: z.boolean().optional() });

/** Файлы-письма по расширению имени. */
const LETTER_FILE_RE = /\.(eml|msg|mbox|emlx)$/i;
/** Заголовки письма в начале текста: достаточно двух из них в первых строках. */
const LETTER_HEADER_RE = /^\s*(from|to|cc|subject|date|от|кому|тема|дата|reply-to|message-id)\s*:/i;
const LETTER_HEADER_LINES = 12;
const LETTER_HEADERS_NEEDED = 2;

/** Текст похож на письмо: в первых строках не меньше двух почтовых заголовков. */
export function looksLikeLetter(text: string): boolean {
  const head = text.split(/\r?\n/).slice(0, LETTER_HEADER_LINES);
  return head.filter((line) => LETTER_HEADER_RE.test(line)).length >= LETTER_HEADERS_NEEDED;
}

/** Раздел прочитанного вложения: имя файла (если есть) и текст. */
export interface AttachmentSection {
  name?: string | undefined;
  text: string;
}

/** Среди разделов есть письмо (по имени файла или по виду текста). */
function hasLetter(sections: readonly AttachmentSection[]): boolean {
  return sections.some(
    (section) =>
      (section.name !== undefined && LETTER_FILE_RE.test(section.name.trim())) ||
      looksLikeLetter(section.text),
  );
}

/** Запомнить тексты прочитанных вложений. Пустое и уже сохранённое повторно не пишется. */
export async function noteAttachmentText(
  state: WorkflowStateStore | undefined,
  threadId: string,
  sections: ReadonlyArray<string | AttachmentSection>,
): Promise<void> {
  if (state === undefined || threadId === '') return;
  const known = await readState(state, ATTACHMENT_TEXT_NAMESPACE, threadId, attachmentTextSchema);
  const normalized = sections.map((item) => (typeof item === 'string' ? { text: item } : item));
  const letter = (known?.letter ?? false) || hasLetter(normalized);
  let text = known?.text ?? '';
  for (const { text: section } of normalized) {
    if (section.trim() === '' || text.includes(section)) continue;
    text = [text, section].filter((part) => part !== '').join('\n\n');
  }
  text = text.slice(-ATTACHMENT_TEXT_MAX_CHARS);
  if (text === (known?.text ?? '') && letter === (known?.letter ?? false)) return;
  await writeState(state, ATTACHMENT_TEXT_NAMESPACE, threadId, {
    text,
    ...(letter ? { letter: true } : {}),
  });
}

/**
 * Что код знает о прочитанных вложениях треда: текст и отметка «среди них было письмо».
 * Нет хранилища или записи - пустой текст без отметки (доказать нечем).
 */
export async function readAttachmentRecord(
  state: WorkflowStateStore | undefined,
  threadId: string | undefined,
): Promise<{ text: string; letter: boolean }> {
  if (state === undefined || threadId === undefined) return { text: '', letter: false };
  const stored = await readState(state, ATTACHMENT_TEXT_NAMESPACE, threadId, attachmentTextSchema);
  return { text: stored?.text ?? '', letter: stored?.letter ?? false };
}

/** Текст прочитанных вложений треда; пусто, если вложений не читали или хранилища нет. */
export async function readAttachmentText(
  state: WorkflowStateStore | undefined,
  threadId: string | undefined,
): Promise<string> {
  if (state === undefined || threadId === undefined) return '';
  const stored = await readState(state, ATTACHMENT_TEXT_NAMESPACE, threadId, attachmentTextSchema);
  return stored?.text ?? '';
}

/** Что нужно записи текста от зависимостей агента. */
interface RecordingHost {
  state?: WorkflowStateStore | undefined;
  log?: ((event: string, fields?: Record<string, string | number | boolean>) => void) | undefined;
}

/** Часть вывода чтения вложений, из которой берётся текст. */
interface AttachmentReadOutput {
  attachmentTexts?: ReadonlyArray<{ text: string; name?: string | undefined }> | undefined;
  imageReads?:
    | ReadonlyArray<{
        status: string;
        text: string;
        name?: string | undefined;
        unreadable?: boolean | undefined;
      }>
    | undefined;
}

/** Разделы вывода чтения вложений: файлы и успешно прочитанные фото (с именами файлов). */
function sectionsOf(output: AttachmentReadOutput): AttachmentSection[] {
  const files = (output.attachmentTexts ?? []).map((item) => ({
    name: item.name,
    text: item.text,
  }));
  const images = (output.imageReads ?? [])
    .filter((item) => item.status === 'ok' && item.unreadable !== true)
    .map((item) => ({ name: item.name, text: item.text }));
  return [...files, ...images];
}

/**
 * Инструмент чтения вложений, который заодно запоминает прочитанный текст в состоянии треда.
 * Имя, схемы и вывод те же: модель разницы не видит. Сбой записи чтение не ломает.
 */
export function withAttachmentTextRecording<
  I,
  O extends AttachmentReadOutput,
  D extends RecordingHost,
>(tool: ToolDefinition<I, O, D>): ToolDefinition<I, O, D> {
  return {
    ...tool,
    async execute(input, deps, context) {
      const output = await tool.execute(input, deps, context);
      try {
        await noteAttachmentText(deps.state, context.threadId, sectionsOf(output));
      } catch {
        // Только код события: текста вложений в журнале быть не должно.
        deps.log?.('attachment_text_not_saved', {});
      }
      return output;
    },
  };
}
