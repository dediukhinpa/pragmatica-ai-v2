import { z } from 'zod';
import { localDateKey } from '@business-ai/core';
import { DEFAULT_BUSINESS_TIMEZONE } from '../../kit/domain/monitoring';
import { defineTool } from '@business-ai/core';
import { assertEmployeeChatTurn } from '@business-ai/core';
import type { SiteExportDeps } from './deps';
import { readTurnSends, recordSend } from './send-ledger';
import { sizeUnresolvedLabels, sizeUnresolvedWarning } from './size-unresolved';
import { loadWorkbook, requireWorkbook, WORKBOOK_MIME } from './template-store';

/** Предел длины имени файла без расширения. */
export const SEND_FILE_NAME_MAX_CHARS = 80;
/** Предел текста сопроводительной подписи. */
const COMMENT_MAX_CHARS = 500;
const XLSX_EXTENSION = /\.xlsx$/i;
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001F\u007F<>:"|?*\\/]/g;

const inputSchema = z.object({
  workbookId: z.string().min(1),
  /** Имя файла для сотрудника, можно без расширения. Не задано - осмысленное имя по умолчанию. */
  fileName: z.string().optional(),
  /** Короткая подпись к файлу (необязательно). */
  comment: z.string().max(COMMENT_MAX_CHARS).optional(),
});

const outputSchema = z.object({
  /** true только после того, как чат принял файл. */
  delivered: z.boolean(),
  fileName: z.string(),
  revision: z.number().int(),
  sizeBytes: z.number().int(),
  /** Листов в отданном файле: должны остаться все. */
  sheets: z.number().int(),
  /** true: эта версия уже выдана в этом ходе, файл повторно НЕ отправлен. */
  alreadySent: z.boolean(),
  /** Сколько файлов выдано в этом ходе сотрудника (с этой выдачей): видно повтор. */
  sendsThisRequest: z.number().int(),
  /**
   * Позиции, у которых размер упаковки не записан (порядок Ш×В×Г неясен или запись не разобрана),
   * по всем вызовам fillTemplateRows этой книги. Есть только когда такие позиции есть.
   */
  sizeUnresolved: z.array(z.string()).optional(),
  /** Готовые предупреждения для итогового сообщения: перенеси их в «Предупреждения» как есть. */
  warnings: z.array(z.string()).optional(),
});

/** Имя файла: без запрещённых знаков, с расширением .xlsx. */
export function templateFileName(raw: string | undefined, fallback: string): string {
  const stem = (raw ?? '')
    .replace(XLSX_EXTENSION, '')
    .replace(FORBIDDEN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SEND_FILE_NAME_MAX_CHARS)
    .trim();
  return `${stem === '' ? fallback : stem}.xlsx`;
}

/** Выдать сотруднику рабочую книгу целым файлом: все листы и колонки как в шаблоне. */
export const sendTemplateFile = defineTool<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>,
  SiteExportDeps
>({
  name: 'sendTemplateFile',
  description:
    'Отправить сотруднику (в этот чат) файл рабочей книги workbookId целиком: все 4 листа и ' +
    'все колонки, в том числе незаполненные. Вызывай ОДИН раз за обращение сотрудника, когда ' +
    'всё заполнено и сверено. Та же версия в том же ходе повторно не уходит (alreadySent=true); ' +
    'новая версия после fillTemplateRows уходит, а sendsThisRequest покажет число выдач. ' +
    'Скажи сотруднику «отправил» только если delivered=true; при ошибке файл не доставлен, ' +
    'так и скажи. fileName - осмысленное имя (.xlsx добавится само). Если в ответе есть ' +
    'warnings (например, «Размеры не удалось определить для: ...»), включи их в итоговое ' +
    'сообщение дословно.',
  inputSchema,
  outputSchema,
  // Другое имя или версия - другой файл в чате: после падения процесса повтор только по кнопке.
  replay: 'confirm',
  async execute(input, deps, context) {
    assertEmployeeChatTurn(context);
    const workbook = requireWorkbook(deps);
    const loaded = await loadWorkbook(deps, input.workbookId);
    const previous = await readTurnSends(deps, loaded.id, context.turnNumber);
    const structure = await workbook.inspect({
      bytes: loaded.bytes,
      headerRow: loaded.record.headerRow,
      signal: context.signal,
    });
    const today =
      deps.clock === undefined
        ? ''
        : localDateKey(deps.clock.now(), deps.businessTimeZone ?? DEFAULT_BUSINESS_TIMEZONE);
    const originalStem = loaded.record.fileName.replace(XLSX_EXTENSION, '');
    const fallback =
      loaded.record.source === 'chat_file'
        ? `${originalStem} - заполнено`
        : `Шаблон сайта - заполнено${today === '' ? '' : ` ${today}`}`;
    const fileName = templateFileName(input.fileName, fallback);
    // Размеры, которые не удалось записать: предупреждение собирает код по записи книги, а не
    // модель по памяти о прошлых вызовах - итог пишется уже после выдачи файла (решение 15).
    const unresolved = loaded.record.sizeUnresolved ?? [];
    const sizeNotice =
      unresolved.length === 0
        ? {}
        : {
            sizeUnresolved: sizeUnresolvedLabels(unresolved),
            warnings: [sizeUnresolvedWarning(unresolved)],
          };
    const fields = { sizeBytes: loaded.bytes.length, revision: loaded.record.revision };
    // Та же версия уже выдана в этом ходе: второй файл и вторая подпись только засоряют чат.
    if (previous !== null && previous.revision === loaded.record.revision) {
      deps.fileLog?.('site_template_send_skipped', { ...fields, sends: previous.sends });
      return {
        delivered: true,
        fileName,
        revision: loaded.record.revision,
        sizeBytes: loaded.bytes.length,
        sheets: structure.sheets.length,
        alreadySent: true,
        sendsThisRequest: previous.sends,
        ...sizeNotice,
      };
    }
    // Ключ с номером версии и вызовом: каждая выдача уходит отдельным файлом, повтор того же
    // вызова после сбоя канала не задвоит файл.
    const key = `site-template-file:${loaded.id}:${loaded.record.revision}:${context.operationId}`;
    try {
      // Подпись кода не добавляем: отчёт о заполнении пишет модель, и два сообщения о том же
      // файле дублировали бы друг друга (автор отчёта один - модель). Подпись есть, только если
      // модель сама передала comment. Ход инструмент не заканчивает (endsTurn нет): итог за
      // моделью.
      const file = { name: fileName, mimeType: WORKBOOK_MIME, content: loaded.bytes };
      if (input.comment !== undefined) {
        await deps.chat.reply(context.threadId, { text: input.comment }, key);
      }
      await deps.chat.sendFile(context.threadId, file, `${key}:file`);
    } catch (error) {
      deps.fileLog?.('site_template_send_failed', fields);
      throw error;
    }
    const sends = (previous?.sends ?? 0) + 1;
    // Запись после доставки: сбой канала не помечает версию выданной.
    await recordSend(deps, loaded.id, {
      turnNumber: context.turnNumber,
      revision: loaded.record.revision,
      sends,
    });
    deps.fileLog?.('site_template_sent', { ...fields, sends });
    return {
      delivered: true,
      fileName,
      revision: loaded.record.revision,
      sizeBytes: loaded.bytes.length,
      sheets: structure.sheets.length,
      alreadySent: false,
      sendsThisRequest: sends,
      ...sizeNotice,
    };
  },
});
