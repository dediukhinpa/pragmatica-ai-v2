import { CancelledError } from '@business-ai/core';
import type { DocumentParser, ParsedDocument, TurnScope } from '@business-ai/core';
import { BoundedCache } from '@business-ai/core';
import type { PriceSource } from './price-sources';
import { withSheetNames } from './sheet-tables';

/**
 * Бюджет кэша разборов в символах (текст плюс ячейки таблиц). Прайс разбирается заново на
 * каждом вызове чтения страницы и разбора куска, поэтому свежий разбор держим. Прежние 6 млн
 * не вмещали прайс от ~30 тыс. строк, и каждый кусок `stagePriceRows` заново разбирал файл:
 * 50 тыс. строк - около 22 с в сервисе documents и 2 с в ядре на кусок (R9-A1-03). 24 млн
 * символов вмещают два листа по 50 тыс. строк (предел парсера; лист из 6 столбцов - около
 * 10 млн) - порядка 50-60 МБ в UTF-16 с накладными на ячейки, при лимите контейнера app 2 ГБ.
 * Документ крупнее бюджета не кэшируется (прежнее поведение).
 */
export const PARSE_CACHE_MAX_CHARS = 24_000_000;
/** Сколько разобранных файлов держим одновременно. */
const PARSE_CACHE_MAX_FILES = 4;
/** Сообщение о выходе хода из ожидания общего разбора. */
const CANCELLED_MESSAGE = 'Ход остановлен, разбор файла не ждём.';
/** Накладные расходы на ячейку при оценке размера разбора, символов. */
const CELL_OVERHEAD_CHARS = 8;

/** Общий идущий разбор: им владеют все ждущие вместе, а не ход, который начал первым. */
interface SharedParse {
  key: string;
  promise: Promise<ParsedDocument>;
  /** Сколько ходов (и тиков) ждут результат сейчас. */
  waiters: number;
  /** Отмена самой работы: срабатывает, когда ушли все ждущие. */
  abort: AbortController;
  settled: boolean;
}

interface ParserCache {
  done: BoundedCache<ParsedDocument>;
  /** Разборы, которые идут сейчас: параллельный вызов ждёт их, а не разбирает второй раз. */
  running: Map<string, SharedParse>;
}

/** Свой кэш на экземпляр парсера: разные парсеры (и тесты) друг другу не мешают. */
const caches = new WeakMap<DocumentParser, ParserCache>();

function cacheOf(parser: DocumentParser): ParserCache {
  let cache = caches.get(parser);
  if (cache === undefined) {
    cache = {
      done: new BoundedCache<ParsedDocument>(PARSE_CACHE_MAX_FILES, {
        maxCost: PARSE_CACHE_MAX_CHARS,
        costOf: parsedCost,
      }),
      running: new Map(),
    };
    caches.set(parser, cache);
  }
  return cache;
}

/** Оценка размера разбора в символах. */
function parsedCost(parsed: ParsedDocument): number {
  let cost = parsed.text.length;
  for (const table of parsed.tables) {
    for (const row of table) {
      for (const cell of row) cost += cell.length + CELL_OVERHEAD_CHARS;
    }
  }
  return cost;
}

/**
 * Разобрать источник с кэшем по (имя, хэш источника). Результат общий для вызывающих: его
 * нельзя менять. Хэш диска - от содержимого, письма и файла сотрудника - от неизменяемого
 * вложения, поэтому для одного ключа содержимое то же самое.
 *
 * Идущий разбор общий (этап 239g): десять сотрудников с одним прайсом ждут одну работу, и она
 * не привязана к сигналу хода, который начал её первым. Остановка или срок одного хода убирает
 * из ожидания только его самого (`CancelledError`); работа в сервисе отменяется, лишь когда
 * ушли все ждущие, а иначе кончается своим сроком запроса. Без `scope` ходы не различаются
 * (память, тесты): работа идёт в контексте первого вызывающего, как раньше.
 *
 * @param parser Разборщик документов.
 * @param source Источник прайса.
 * @param scope Связь с ходами: сигнал текущего хода и запуск общей работы вне хода.
 */
export async function parseSource(
  parser: DocumentParser,
  source: PriceSource,
  scope?: TurnScope,
): Promise<ParsedDocument> {
  const cache = cacheOf(parser);
  const key = `${source.hash}|${source.name}`;
  const cached = cache.done.get(key);
  if (cached !== undefined) return cached;
  const shared = cache.running.get(key) ?? startShared(cache, key, parser, source, scope);
  return waitShared(cache, shared, scope);
}

function startShared(
  cache: ParserCache,
  key: string,
  parser: DocumentParser,
  source: PriceSource,
  scope: TurnScope | undefined,
): SharedParse {
  const abort = new AbortController();
  const work = async (): Promise<ParsedDocument> => {
    // Названия листов и пометка скрытых ставятся здесь, до любого потребителя (чтение, разбор,
    // скрипты): индексы таблиц везде одни и те же. Скрытые листы читаются с предупреждением.
    const parsed = withSheetNames(await parseOf(parser, source));
    cache.done.set(key, parsed);
    return parsed;
  };
  const shared: SharedParse = {
    key,
    promise: (scope === undefined ? work() : scope.runDetached(abort.signal, work)).finally(
      () => {
        shared.settled = true;
        // Запись могла уже смениться свежим разбором: чужую не трогаем.
        if (cache.running.get(key) === shared) cache.running.delete(key);
      },
    ),
    waiters: 0,
    abort,
    settled: false,
  };
  // Результат читают ждущие; если все ушли, отказ отменённой работы никому не нужен.
  shared.promise.catch(() => undefined);
  cache.running.set(key, shared);
  return shared;
}

/**
 * Ждать общий разбор; свой сигнал снимает с ожидания только этого вызывающего. Пока ход ждёт,
 * его часы стоят (этап 239j): работа идёт в отдельном контексте общей работы и часов ждущих ходов
 * не касается, поэтому останавливает их сам ждущий, на всё ожидание, как и очередь сервиса.
 */
async function waitShared(
  cache: ParserCache,
  shared: SharedParse,
  scope: TurnScope | undefined,
): Promise<ParsedDocument> {
  const own = scope?.currentSignal();
  const resume = scope?.hold();
  shared.waiters += 1;
  let onAbort: (() => void) | undefined;
  try {
    if (own === undefined) return await shared.promise;
    if (own.aborted) throw new CancelledError(CANCELLED_MESSAGE);
    const left = new Promise<never>((_, reject) => {
      onAbort = (): void => reject(new CancelledError(CANCELLED_MESSAGE));
      own.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([shared.promise, left]);
  } finally {
    if (onAbort !== undefined) own?.removeEventListener('abort', onAbort);
    resume?.();
    shared.waiters -= 1;
    if (shared.waiters === 0 && !shared.settled) {
      // Отменённая работа больше не общая: новый вызов начнёт свежий разбор, а не присоединится.
      if (cache.running.get(shared.key) === shared) cache.running.delete(shared.key);
      shared.abort.abort();
    }
  }
}

/** Разбор с диска, когда источник и парсер это умеют (этап 231), иначе из памяти. */
async function parseOf(parser: DocumentParser, source: PriceSource): Promise<ParsedDocument> {
  if (parser.parseFile !== undefined && source.disk !== undefined) {
    return parser.parseFile(source.name, await source.disk());
  }
  return parser.parse(source.name, await source.read());
}
