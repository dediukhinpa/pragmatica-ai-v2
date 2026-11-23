import type { Clock, ConversationHistorySearch } from '@business-ai/core';
import { pragmatikaRuntime } from './runtime';

/**
 * Подписи к файлам в тексте сообщений сотрудника (этап 9q). Платформа зовёт хук входящих
 * сообщений только для самостоятельного сообщения; текст, слитый с файлом как подпись, в хук не
 * попадает, и сверка «слов сотрудника» (номер договора, юрлицо, реквизиты) его не видела. Здесь
 * подпись берётся из истории треда в момент чтения: платформа сохраняет запрос хода до вызова
 * инструментов. В запись идёт только текст сотрудника до служебных строк о файле, реальный (до
 * псевдонимизации), как у обычных сообщений.
 */

/** Слова служебной строки о файле: по ним история отдаёт реплики хода с файлом. */
export const FILE_NOTICE_QUERY = 'Сотрудник прислал файл';
/** Начало служебной строки о файле в запросе хода: прямой приём и файл портала. */
const FILE_NOTICE_LINE = /^Сотрудник прислал (?:в чат )?файл «/mu;
/** Окно поиска реплик с файлом, часов: дальше подпись не нужна сверке. */
const SEARCH_WINDOW_HOURS = 24;
const MS_PER_HOUR = 3_600_000;
/** Сколько реплик берём из истории за одно чтение (предел порта поиска - 20). */
const SEARCH_LIMIT = 20;

/**
 * Подпись сотрудника из запроса хода с файлом: текст до первой служебной строки. Запрос без
 * служебной строки - не ход с файлом (обычные сообщения записывает хук) - даёт пустую строку.
 */
export function captionOf(turnText: string): string {
  const match = FILE_NOTICE_LINE.exec(turnText);
  if (match === null) return '';
  return turnText.slice(0, match.index).trim();
}

/** Что нужно сверке, чтобы дописать подписи: поиск по истории и часы. */
export interface TurnCaptionSource {
  history: ConversationHistorySearch;
  clock: Clock;
}

/** Куда писать: уже накопленный текст и запись нового сообщения (из employee-messages). */
export interface EmployeeTextSink {
  /** Накопленный нормализованный текст треда; строки - сообщения. */
  readKnown(): Promise<string>;
  note(text: string): Promise<void>;
  /** Нормализация, общая с записью (`normalizeEmployeeText`). */
  normalize(text: string): string;
}

/**
 * Дописать в текст сообщений сотрудника подписи файлов треда, которых там ещё нет. Возвращает,
 * сколько подписей добавлено. Сбой поиска не ломает чтение: подписей просто не прибавится.
 */
export async function recordTurnCaptions(
  source: TurnCaptionSource | undefined,
  threadId: string,
  sink: EmployeeTextSink,
): Promise<number> {
  if (source === undefined || threadId === '') return 0;
  const now = source.clock.now();
  let hits;
  try {
    hits = await source.history.search({
      threadId,
      query: FILE_NOTICE_QUERY,
      since: new Date(now.getTime() - SEARCH_WINDOW_HOURS * MS_PER_HOUR),
      limit: SEARCH_LIMIT,
    });
  } catch {
    return 0;
  }
  const turns = hits
    .map((hit) => hit.message)
    .filter((message) => message.role === 'user')
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const known = new Set((await sink.readKnown()).split('\n'));
  let added = 0;
  for (const message of turns) {
    const caption = captionOf(message.text);
    const normalized = sink.normalize(caption);
    if (normalized === '' || known.has(normalized)) continue;
    await sink.note(caption);
    known.add(normalized);
    added += 1;
  }
  return added;
}

/** Источник подписей собранного приложения; нет истории (не собрано, тест) - `undefined`. */
export function turnCaptionSource(): TurnCaptionSource | undefined {
  const runtime = pragmatikaRuntime();
  if (runtime?.conversationHistory === undefined) return undefined;
  return { history: runtime.conversationHistory, clock: runtime.clock };
}
