import { addDays, localDateKey, startOfLocalDay } from '@business-ai/core';
import { DEFAULT_BUSINESS_TIMEZONE } from './monitoring';

/** Откуда взят год для даты без года в названии файла прайса. */
export type YearAnchorSource = 'path' | 'properties' | 'mtime';

/** Опорная дата файла: относительно неё читается запись `дд.мм` без года. */
export interface YearAnchor {
  /** Опорный момент (не позже текущего). */
  at: Date;
  source: YearAnchorSource;
}

/** Откуда что известно о файле (все источники необязательны). */
export interface YearAnchorSources {
  /** Путь файла относительно корня. */
  path: string;
  /** Дата последнего сохранения из свойств документа (ISO); null - свойств нет. */
  savedAtIso?: string | null | undefined;
  /** Время изменения файла на диске, мс. */
  mtimeMs?: number | null | undefined;
}

/** Допустимое окно годов (как у даты в названии). */
const MIN_YEAR = 2000;
const MAX_YEAR = 2099;
/** Год в сегменте каталога: отдельное число из четырёх цифр, начинающееся с 20. */
const YEAR_IN_SEGMENT = /(?<!\d)(20\d{2})(?!\d)/gu;
const DECEMBER = 12;
const LAST_DAY_OF_YEAR = 31;

/** Подписи источников года для сводки сотруднику. */
export const YEAR_ANCHOR_LABELS: Readonly<Record<YearAnchorSource, string>> = {
  path: 'год по папке файла',
  properties: 'год по дате сохранения в свойствах файла',
  mtime: 'год по дате изменения файла',
};

/**
 * Год из каталогов пути: сегмент, который сам является годом или содержит год отдельным
 * числом (`2024`, `Прайсы 2024`). Имя файла не смотрится. Из нескольких сегментов берётся
 * ближайший к файлу; в сегменте с несколькими годами (`2023-2024`) - самый поздний.
 */
export function yearFromPath(path: string): number | null {
  const segments = path.split(/[\\/]/u).slice(0, -1);
  for (let at = segments.length - 1; at >= 0; at -= 1) {
    const years = [...(segments[at] ?? '').matchAll(YEAR_IN_SEGMENT)]
      .map((match) => Number(match[1]))
      .filter((year) => year >= MIN_YEAR && year <= MAX_YEAR);
    if (years.length > 0) return Math.max(...years);
  }
  return null;
}

/** Разбор момента: невалидное значение и год вне окна - null. */
function validMoment(at: Date | null): Date | null {
  if (at === null || Number.isNaN(at.getTime())) return null;
  const year = at.getUTCFullYear();
  return year >= MIN_YEAR && year <= MAX_YEAR ? at : null;
}

function earlier(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

/**
 * Опорная дата файла для записи `дд.мм` без года, по приоритету: год в пути (конец этого года,
 * по часам бизнеса), дата сохранения из свойств документа, время изменения файла на диске.
 * Опорный момент не бывает позже `now`: свойства и mtime «из будущего» (сбитые часы) и год
 * папки, который ещё не закончился, обрезаются текущим моментом. Нет ни одного источника -
 * null: дата не выводится, файл идёт в «без даты».
 */
export function resolveYearAnchor(
  sources: YearAnchorSources,
  now: Date,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): YearAnchor | null {
  const year = yearFromPath(sources.path);
  if (year !== null) {
    // Конец года: последние сутки года целиком, чтобы 31.12 попал в этот год.
    const newYear = startOfLocalDay(
      addDays(`${year}-${DECEMBER}-${LAST_DAY_OF_YEAR}`, 1),
      timeZone,
    );
    const endOfYear = new Date(newYear.getTime() - 1);
    return { at: earlier(endOfYear, now), source: 'path' };
  }
  const saved = validMoment(
    sources.savedAtIso === undefined || sources.savedAtIso === null
      ? null
      : new Date(sources.savedAtIso),
  );
  if (saved !== null) return { at: earlier(saved, now), source: 'properties' };
  const mtime = validMoment(
    sources.mtimeMs === undefined || sources.mtimeMs === null ? null : new Date(sources.mtimeMs),
  );
  if (mtime !== null) return { at: earlier(mtime, now), source: 'mtime' };
  return null;
}

/** Локальная дата опорного момента (`YYYY-MM-DD`) для подсказки запасному разбору. */
export function yearAnchorDateKey(anchor: YearAnchor, timeZone: string): string {
  return localDateKey(anchor.at, timeZone);
}
