import { z } from 'zod';

/** Смещение Москвы в записи ISO 8601 (МСК без перехода на летнее время). */
const MSK_OFFSET_TEXT = '+03:00';
/** Конец суток для даты без времени (до миллисекунды: срок «до 2 января» включает весь день). */
const END_OF_DAY = 'T23:59:59.999';
const MINUTE_MS = 60_000;
const MS_DIGITS = 3;
const MAX_OFFSET_HOURS = 23;
const MAX_MINUTE = 59;
const MAX_HOUR = 23;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(Z|[+-]\d{2}:\d{2})$/;

/** Составные части календарной даты существуют (2026-02-30 - нет). */
function validDate(year: number, month: number, day: number): boolean {
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** Календарная дата без времени в строгом виде `YYYY-MM-DD` существует. */
function isIsoDateOnly(text: string): boolean {
  const match = DATE_ONLY.exec(text.trim());
  return match !== null && validDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

/**
 * Момент времени ISO 8601 (миллисекунды с эпохи) или `undefined`. Часовой пояс (Z или ±hh:mm)
 * обязателен: время без пояса зависит от TZ процесса и означало бы разные моменты. Несуществующая
 * дата, «01.02.2026», «01/02/2026» и дата без времени не принимаются.
 */
export function parseIsoInstant(text: string): number | undefined {
  const match = DATE_TIME.exec(text.trim());
  if (match === null) return undefined;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const fraction = match[7] ?? '';
  const millis = fraction === '' ? 0 : Number(fraction.slice(0, MS_DIGITS).padEnd(MS_DIGITS, '0'));
  if (!validDate(year, month, day)) return undefined;
  if (hour > MAX_HOUR || minute > MAX_MINUTE || second > MAX_MINUTE) return undefined;
  let offsetMinutes = 0;
  const zone = match[8] ?? 'Z';
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMins = Number(zone.slice(4, 6));
    if (offsetHours > MAX_OFFSET_HOURS || offsetMins > MAX_MINUTE) return undefined;
    const sign = zone.startsWith('-') ? -1 : 1;
    offsetMinutes = sign * (offsetHours * 60 + offsetMins);
  }
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(hour, minute, second, millis);
  return probe.getTime() - offsetMinutes * MINUTE_MS;
}

/**
 * Срок или момент «до»: момент с поясом либо дата без времени. Дата без времени означает КОНЕЦ
 * суток по Москве (срок «до 2 января» не истекает в начале 2 января). Иначе `undefined`.
 */
export function parseIsoDeadline(text: string): number | undefined {
  const trimmed = text.trim();
  if (isIsoDateOnly(trimmed)) return parseIsoInstant(`${trimmed}${END_OF_DAY}${MSK_OFFSET_TEXT}`);
  return parseIsoInstant(trimmed);
}

/**
 * Привести срок к записи с поясом: дата без времени получает конец суток МСК, остальное
 * остаётся как есть. Нераспознанное - `undefined`.
 */
export function normalizeIsoDeadline(text: string): string | undefined {
  const trimmed = text.trim();
  if (isIsoDateOnly(trimmed)) return `${trimmed}${END_OF_DAY}${MSK_OFFSET_TEXT}`;
  return parseIsoInstant(trimmed) === undefined ? undefined : trimmed;
}

const INSTANT_MESSAGE =
  'ожидается дата и время ISO 8601 с часовым поясом (2026-01-02T18:00:00+03:00 или ...Z)';
const DEADLINE_MESSAGE =
  'ожидается дата ГГГГ-ММ-ДД или дата и время ISO 8601 с часовым поясом (...Z, ...+03:00)';

/** Момент времени: обязателен часовой пояс, дата без времени и форматы вроде «01.02.2026» - нет. */
export const isoInstantSchema = z
  .string()
  .refine((value) => parseIsoInstant(value) !== undefined, { message: INSTANT_MESSAGE });

/** Дата позиции прайса и т.п.: дата без времени или момент с поясом; значение не меняется. */
export const isoDateOrInstantSchema = z
  .string()
  .refine((value) => isIsoDateOnly(value) || parseIsoInstant(value) !== undefined, {
    message: DEADLINE_MESSAGE,
  });

/** Срок «действует до»: дата без времени превращается в конец суток по МСК (D-14). */
export const isoDeadlineSchema = z
  .string()
  .transform((value, ctx): string => {
    const normalized = normalizeIsoDeadline(value);
    if (normalized === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: DEADLINE_MESSAGE });
      return z.NEVER;
    }
    return normalized;
  });
