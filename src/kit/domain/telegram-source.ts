import { extractWebPageFactsByCode, parseWebPageFacts, type WebPageFacts } from './web-candidate';
import { hasPersonName } from '@business-ai/core';

/**
 * Закрытый Telegram-канал как источник поиска поставщиков для шорт-листа (этап 216).
 * Приоритет в ранжировании как у базы знаний (канал выбирает владелец), поэтому у источника
 * своя подпись: это не «ИЗ ИНТЕРНЕТА» (публичные сайты), а закрытый источник компании.
 */

/** Единый индикатор шорт-листа: сведение взято из Telegram-канала. Другой подписи нигде нет. */
export const TELEGRAM_SOURCE_MARK = 'из Telegram-канала';

/** Значение с пометкой источника: «Пермь (из Telegram-канала)». */
export function withTelegramNote(text: string): string {
  return `${text} (${TELEGRAM_SOURCE_MARK})`;
}

/**
 * Поля строки шорт-листа, которые могут быть взяты из канала. Происхождение хранится по полю
 * (`telegramFields`), как у `webFields`: после слияния с базой часть сведений своя, часть из
 * канала. `prices` - цены поставщика (в строке лежат в общем поле цен, как цены базы).
 */
export const TELEGRAM_FIELDS = ['city', 'contacts', 'email', 'leadTime', 'prices'] as const;
export type TelegramField = (typeof TELEGRAM_FIELDS)[number];

/** Начало ссылки на пост в `reference` кандидата: «tg:<канал>/<номер>». Адресом страницы не является. */
export const TELEGRAM_REFERENCE_PREFIX = 'tg:';

/** Ссылка на пост для `reference`: канал и номер сообщения, без текста поста. */
export function telegramReference(channel: string, messageId: number): string {
  return `${TELEGRAM_REFERENCE_PREFIX}${channel}/${messageId}`;
}

/**
 * Сколько мест шорт-листа может занять канал без карточки в базе (приоритет «как у базы», но не
 * вытеснять базу целиком: канал отдаёт цены без карточки и истории работы с поставщиком).
 * Поставщик, найденный и в базе, под предел не попадает: он занимает место как поставщик базы.
 */
export const TELEGRAM_MAX_SHORTLIST_PLACES = 3;

/**
 * Предел строки поиска, которую ядро отправляет сервису чтения канала (знаки). Равен
 * `MAX_QUERY_CHARS` сервиса (gateway/tg-reader): длиннее сервис отклоняет. Запросы ядра заведомо
 * короче (`EXTERNAL_QUERY_MAX_CHARS`), предел страхует адаптер.
 */
export const TELEGRAM_QUERY_MAX_CHARS = 200;

/** Предел длины названия поставщика из поста (знаки). */
export const TELEGRAM_NAME_MAX_CHARS = 120;
const WHITESPACE = /[\s ]+/g;
const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
/** Название не бывает адресом почты или ссылкой: так модель иногда «называет» поставщика. */
const NOT_A_NAME = /@|https?:|www\./iu;
/** Длинная серия цифр в названии - телефон или реквизиты, а не название. */
const DIGIT_SERIES = /\d{7,}/u;
/** Пометки очистки текста: в названии их быть не может (кроме «ИП [ФИО]», см. ниже). */
const MASK_LABEL = /\[(?:телефон|почта|ФИО|адрес)\]/u;
/** Начало названия индивидуального предпринимателя. */
const IP_PREFIX = /^(?:ИП|индивидуальный предприниматель)(?=\s|$)\s*/iu;
/**
 * «ИП» и ФИО в исходном тексте поста: «Фамилия И.О.», «И.О. Фамилия» либо до трёх слов с
 * заглавной. ФИО модель не видит (текст очищен), поэтому название ИП восстанавливает код.
 */
const NAME_WORD = '[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?';
const NAME_INITIALS = '[А-ЯЁ]\\.\\s?[А-ЯЁ]\\.';
const IP_NAME_IN_TEXT = new RegExp(
  '(?:ИП|[Ии]ндивидуальный\\s+предприниматель)\\s+' +
    `(${NAME_WORD}\\s+${NAME_INITIALS}|${NAME_INITIALS}\\s+${NAME_WORD}|` +
    `${NAME_WORD}(?:\\s+${NAME_WORD}){0,2})`,
  'u',
);

/** Сведения из поста, разобранные кодом: название и факты (телефон и почту ставит код). */
export interface TelegramPostFacts {
  name: string;
  facts: WebPageFacts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** ИП и ФИО из исходного текста поста: «ИП Фамилия И.О.»; нет в тексте - `undefined`. */
function ipNameFromText(sourceText: string): string | undefined {
  const found = IP_NAME_IN_TEXT.exec(sourceText);
  if (found === null) return undefined;
  const name = `ИП ${(found[1] ?? '').replace(WHITESPACE, ' ').trim()}`;
  return name.length > TELEGRAM_NAME_MAX_CHARS ? undefined : name;
}

/**
 * Название поставщика из ответа модели; ФИО, почта, ссылка и телефон названием не считаются.
 * Исключение - индивидуальный предприниматель: «ИП Фамилия И.О.» и есть название поставщика. ФИО
 * модели не передаётся (очистка текста ставит «ИП [ФИО]»), поэтому у такого названия ФИО
 * берётся из исходного текста поста, а не из ответа модели: выдуманному ФИО места нет.
 */
function parseName(value: unknown, sourceText: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(CONTROL_CHARS, ' ').replace(WHITESPACE, ' ').trim();
  if (text === '' || text.length > TELEGRAM_NAME_MAX_CHARS) return undefined;
  if (NOT_A_NAME.test(text) || DIGIT_SERIES.test(text)) return undefined;
  const prefix = IP_PREFIX.exec(text);
  if (prefix !== null) {
    const rest = text.slice(prefix[0].length);
    if (rest === '') return undefined;
    // «ИП Ромашка-Опт»: человека в названии нет - берём как есть.
    if (!MASK_LABEL.test(rest) && !hasPersonName(rest)) return text;
    return ipNameFromText(sourceText);
  }
  if (MASK_LABEL.test(text) || hasPersonName(text)) return undefined;
  return text;
}

/**
 * Разобрать сырой ответ модели о посте. Телефон и почту модель не отдаёт: из ИСХОДНОГО текста
 * поста их достаёт код (модель видит текст без контактов), её значения этих полей игнорируются.
 * Город модели важнее города из текста. Нет названия - `null`: пост отбрасывается, поставщика
 * без названия в шорт-листе быть не может.
 */
export function parseTelegramPostFacts(raw: unknown, sourceText: string): TelegramPostFacts | null {
  if (!isRecord(raw)) return null;
  const name = parseName(raw.name, sourceText);
  if (name === undefined) return null;
  const { phone: _phone, email: _email, ...fromModel } = raw;
  const parsed = parseWebPageFacts(fromModel);
  const byCode = parseWebPageFacts(extractWebPageFactsByCode([sourceText]));
  return {
    name,
    facts: {
      ...parsed,
      ...(byCode.phone === undefined ? {} : { phone: byCode.phone }),
      ...(byCode.email === undefined ? {} : { email: byCode.email }),
      ...(parsed.city !== undefined || byCode.city === undefined ? {} : { city: byCode.city }),
    },
  };
}
