import type { InboxMessage } from '@business-ai/core';

/** Сколько знаков начала собственного текста письма участвует в поиске названия. */
const NAME_SEARCH_HEAD_CHARS = 1_500;
/** Сколько знаков конца собственного текста (подпись) участвует в поиске названия. */
const NAME_SEARCH_TAIL_CHARS = 600;
/** Строка цитаты. */
const QUOTED_LINE_RE = /^\s*>/;
/** Начало блока заголовков пересланного или цитируемого письма. */
const HEADER_BLOCK_RE = /^\s*(от|from)\s*:/i;
/** Строка-разделитель цитаты: «-----Original Message-----», «15.10.2026, X написал:». */
const QUOTE_MARKER_RE =
  /^\s*(-{2,}\s*(original message|исходное сообщение)|.{0,200}(написал[аи]?|wrote)\s*:\s*$)/i;
/** Первый блок «От:» допустим (шапка самого письма), цитата начинается со второго. */
const ALLOWED_HEADER_BLOCKS = 1;

/**
 * Собственный текст письма без цитируемой переписки: строки `>` отбрасываются, текст обрывается
 * на разделителе цитаты и на втором блоке «От:».
 */
export function ownBody(body: string): string {
  const kept: string[] = [];
  let headerBlocks = 0;
  for (const line of body.split(/\r?\n/)) {
    if (QUOTE_MARKER_RE.test(line)) break;
    if (HEADER_BLOCK_RE.test(line)) {
      headerBlocks += 1;
      if (headerBlocks > ALLOWED_HEADER_BLOCKS) break;
    }
    if (!QUOTED_LINE_RE.test(line)) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Тексты письма, в которых ищется название поставщика: тема, начало и конец (подпись)
 * собственного текста, имена вложений. Цитируемая переписка не входит.
 */
export function nameSearchText(message: InboxMessage): string {
  const own = ownBody(message.body);
  const head = own.slice(0, NAME_SEARCH_HEAD_CHARS);
  const tail = own.length > NAME_SEARCH_HEAD_CHARS ? own.slice(-NAME_SEARCH_TAIL_CHARS) : '';
  const names = [
    ...message.attachments.map((file) => file.fileName),
    ...(message.attachmentNames ?? []),
  ];
  return [message.subject, head, tail, ...names].join('\n');
}
