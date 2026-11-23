import type { PricesDeps } from './agents/prices/deps';
import type { PriceSource } from './agents/prices/price-sources';
import { parsePriceCell } from './agents/prices/table-rows';
import { supportsPriceSpots, type PriceSpot, type PriceSpotMap } from './price-spots-client';

/**
 * Цены в текстовых блоках и группах слайдов pptx (этап 9q): поиск места по числу из карты мест
 * сервиса документов. Число разбирается тем же `parsePriceCell`, что и ячейка таблицы, поэтому
 * «680», «680 ₽» и «1 200,50 руб.» считаются одной ценой с её числовым значением; сравнение со
 * старой ценой и фильтры места (слайд, слова из строки) те же, что у таблиц.
 */

/** Допуск сравнения цен: разбор округляет цену до долей копейки. */
const PRICE_EPSILON = 1e-6;
/** Сколько карт держим в памяти процесса (по файлу одна). */
const SPOT_CACHE_MAX = 8;
/** Метка места числа в тексте слайда: та же, что у таблицы слайда. */
export const SLIDE_PLACE_PREFIX = 'Слайд';

/** Условия поиска числа: подмножество указаний сотрудника (см. `editSpecSchema`). */
export interface SpotQuery {
  oldPrice: number;
  slide?: number | undefined;
  page?: number | undefined;
  sheet?: string | undefined;
  table?: number | undefined;
  row?: number | undefined;
  rowText?: string | undefined;
}

/** Нормализация текста для сравнения: регистр и пробелы не важны. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** Совпадает ли текст ячейки или числа с ценой: обычная цена без «от»/диапазона/тиража. */
export function isPlainPrice(raw: string, price: number): boolean {
  const cell = parsePriceCell(raw);
  return (
    cell.kind === 'ok' &&
    cell.qualifier === undefined &&
    cell.minQuantity === undefined &&
    Math.abs(cell.value - price) < PRICE_EPSILON
  );
}

/** Метка места: «Слайд 11». */
export function slidePlace(slide: number): string {
  return `${SLIDE_PLACE_PREFIX} ${slide}`;
}

/** Ключ числа по локатору: связывает правку, пропуск сервиса и строку для сотрудника. */
export function spotKey(locator: {
  slide: number;
  shape: string;
  paragraph: number;
  start: number;
}): string {
  return `${locator.slide}:${locator.shape}:${locator.paragraph}:${locator.start}`;
}

/**
 * Отрывок контекста вокруг числа не длиннее `max` знаков: число остаётся в отрывке, обрезка
 * с краёв помечается «…». Контекст сервиса до 200 знаков, а сотруднику нужна подсказка места.
 */
export function spotExcerpt(spot: PriceSpot, max: number): string {
  const context = spot.context.trim();
  if (context.length <= max) return context;
  const at = Math.max(0, context.indexOf(spot.text));
  const centered = at - Math.floor((max - spot.text.length) / 2);
  const begin = Math.max(0, Math.min(centered, context.length - max));
  const cut = context.slice(begin, begin + max);
  return `${begin > 0 ? '…' : ''}${cut}${begin + max < context.length ? '…' : ''}`;
}

/** Слово «от»/«до» перед числом (нижняя граница, потолок): это не точная цена. */
const QUALIFIER_BEFORE = /(?:^|[\s(])(?:от|до)\s*$/iu;
/** Дефис перед числом после цифры («100-120»): число - край диапазона. */
const RANGE_BEFORE = /\d\s*[-–—]\s*$/u;
/** Дефис и цифра после числа («100-120»): число - край диапазона. */
const RANGE_AFTER = /^\s*[-–—]\s*\d/u;

/**
 * Стоит ли число в контексте как «от N», «до N» или край диапазона. Таблица такие ячейки не
 * правит (текстовая цена), текстовый блок - тоже. Если число встречается в окне несколько раз,
 * положение неизвестно, и число не исключается: сервис всё равно сверит его с `expected`.
 */
export function isQualifiedInContext(spot: PriceSpot): boolean {
  const first = spot.context.indexOf(spot.text);
  if (first < 0 || spot.context.indexOf(spot.text, first + 1) >= 0) return false;
  const before = spot.context.slice(0, first);
  const after = spot.context.slice(first + spot.text.length);
  return QUALIFIER_BEFORE.test(before) || RANGE_BEFORE.test(before) || RANGE_AFTER.test(after);
}

/** Можно ли править число как точную цену (разбирается, без «от»/диапазона). */
export function isEditableSpot(spot: PriceSpot): boolean {
  const cell = parsePriceCell(spot.text);
  return (
    cell.kind === 'ok' &&
    cell.qualifier === undefined &&
    cell.minQuantity === undefined &&
    !isQualifiedInContext(spot)
  );
}

/**
 * Числа текстовых блоков, подходящие под указание сотрудника. Указание, которое относится
 * только к таблицам (номер таблицы, строка, лист, страница), текстовые блоки исключает: «строка
 * 3 таблицы 2» не может быть числом в подписи.
 */
export function findSpotCandidates(spots: readonly PriceSpot[], query: SpotQuery): PriceSpot[] {
  if (
    query.table !== undefined ||
    query.row !== undefined ||
    query.sheet !== undefined ||
    query.page !== undefined
  ) {
    return [];
  }
  const wanted = query.rowText === undefined ? null : normalizeText(query.rowText);
  return spots.filter((spot) => {
    if (query.slide !== undefined && spot.slide !== query.slide) return false;
    if (wanted !== null && !normalizeText(spot.context).includes(wanted)) return false;
    return isPlainPrice(spot.text, query.oldPrice) && !isQualifiedInContext(spot);
  });
}

const mapCache = new Map<string, Promise<PriceSpotMap | null>>();

/** Забыть кэш карт (тесты). */
export function resetSpotCache(): void {
  mapCache.clear();
}

/**
 * Карта чисел вне таблиц презентации или `null`: нет клиента (флаг выключен), файл не
 * презентация, сервис без карты или сбой. Результат кэшируется по файлу: поиск цены и список
 * мест за один ход не разбирают презентацию на сервисе дважды; неудача в кэше не остаётся.
 */
export async function loadSpotMap(
  deps: Pick<PricesDeps, 'priceSpots'>,
  source: PriceSource,
): Promise<PriceSpotMap | null> {
  const reader = deps.priceSpots;
  if (reader === undefined || !supportsPriceSpots(source.name)) return null;
  const key = `${source.hash}|${source.name}`;
  const cached = mapCache.get(key);
  if (cached !== undefined) return cached;
  const pending = (async (): Promise<PriceSpotMap | null> => {
    try {
      // Файл от сотрудника лежит на диске: большая презентация уходит потоком, не в память.
      return await reader.read(
        source.disk === undefined
          ? { name: source.name, bytes: await source.read() }
          : { name: source.name, disk: await source.disk() },
      );
    } catch {
      return null;
    }
  })();
  mapCache.set(key, pending);
  if (mapCache.size > SPOT_CACHE_MAX) {
    const oldest = mapCache.keys().next();
    if (oldest.done !== true) mapCache.delete(oldest.value);
  }
  void pending.then((map) => {
    if (map === null) mapCache.delete(key);
  });
  return pending;
}
