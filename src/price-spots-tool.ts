import { z } from 'zod';
import { defineTool } from '@business-ai/core';
import type { PricesDeps } from './agents/prices/deps';
import { openPriceSource } from './agents/prices/price-sources';
import { parsePriceCell } from './agents/prices/table-rows';
import { isEditableSpot, loadSpotMap, spotExcerpt, spotPlace } from './price-spots';
import {
  isPdfSpot,
  isUnreachablePage,
  supportsPriceSpots,
  type PriceSpot,
  type PriceSpotMap,
} from './price-spots-client';

/**
 * Числа вне таблиц (этап 9q - слайды pptx, этап 9r - страницы PDF): текстовые блоки, подписи,
 * группы фигур, цена в предложении и колонки без линий в PDF. `readPriceFile` показывает
 * таблицы, а цена в плашке «Акция: 680 ₽» или в строке «Item A ... 1 250,00 USD» в них не видна.
 * Инструмент даёт агенту список таких чисел с номером слайда или страницы и текстом вокруг, чтобы
 * он назвал сотруднику место и передал в `editPriceInFile` слайд или страницу и слова из текста
 * (`rowText`).
 */

/** Расширение pdf: у такого файла места задаёт страница, а не слайд. */
const PDF_EXTENSION = '.pdf';

/** Имя инструмента. */
export const LIST_PRICE_SPOTS_TOOL = 'listPriceSpots';

/** Сколько чисел показываем за вызов: остальное - числом и просьбой сузить слайдом. */
export const SPOTS_LIST_MAX = 40;
/** Длина отрывка текста вокруг числа. */
const SPOT_EXCERPT_MAX_CHARS = 120;

const inputSchema = z.object({
  /** Идентификатор файла: path из сообщения сотрудника (чат), письма или диска. */
  path: z.string().min(1),
  /** Только числа этого слайда (с 1; презентация). */
  slide: z.number().int().positive().optional(),
  /** Только числа этой страницы (с 1; pdf). */
  page: z.number().int().positive().optional(),
});
interface SpotsInput {
  path: string;
  slide?: number | undefined;
  page?: number | undefined;
}

const STATUSES = ['ok', 'not_available', 'not_applicable'] as const;

const spotOutputSchema = z.object({
  /** «Слайд 11» или «Страница 3». */
  place: z.string(),
  /** Число как в тексте: «680», «1 200,50 руб.»; у pdf - само число («1 250,00»). */
  text: z.string(),
  /** Значение числа; null - не разбирается как цена. */
  value: z.number().nullable(),
  /** Текст вокруг числа: по нему сотрудник узнаёт место. */
  context: z.string(),
  /** false - «от N», «до N», диапазон: как точная цена не правится. */
  editable: z.boolean(),
  /** Заголовок столбца, если число стоит в таблице без линий (pdf). */
  header: z.string().optional(),
});
const outputSchema = z.object({
  status: z.enum(STATUSES),
  /** Сколько чисел найдено (с учётом слайда или страницы); в `spots` не больше SPOTS_LIST_MAX. */
  total: z.number().int(),
  spots: z.array(spotOutputSchema),
  /** Сервис обрезал карту по своему пределу: список неполный. */
  truncated: z.boolean(),
  /** Фигуры и страницы, где числа не правятся (картинки, диаграммы, повёрнутый текст): сколько. */
  unreachableCount: z.number().int(),
  message: z.string(),
});
type SpotsOutput = z.infer<typeof outputSchema>;

/** Пустой ответ без списка. */
function none(status: SpotsOutput['status'], message: string): SpotsOutput {
  return { status, total: 0, spots: [], truncated: false, unreachableCount: 0, message };
}

/** Подходит ли число под слайд или страницу из запроса (чужого вида - не подходит). */
function inScope(spot: PriceSpot, input: SpotsInput): boolean {
  if (isPdfSpot(spot)) {
    return input.slide === undefined && (input.page === undefined || spot.page === input.page);
  }
  return input.page === undefined && (input.slide === undefined || spot.slide === input.slide);
}

/** Сколько недоступных мест карты относится к слайду или странице из запроса. */
function unreachableIn(map: PriceSpotMap, input: SpotsInput): number {
  return map.unreachable.filter((item) =>
    isUnreachablePage(item)
      ? input.slide === undefined && (input.page === undefined || item.page === input.page)
      : input.page === undefined && (input.slide === undefined || item.slide === input.slide),
  ).length;
}

/** Подпись запрошенного места для сообщения: « на слайде 3», « на странице 2» или пусто. */
function scopeNote(input: SpotsInput): string {
  if (input.slide !== undefined) return ` на слайде ${input.slide}`;
  if (input.page !== undefined) return ` на странице ${input.page}`;
  return '';
}

/**
 * Показать числа вне таблиц файла: слайд или страница, число и текст вокруг. Только чтение:
 * правит числа `editPriceInFile`.
 */
export const listPriceSpots = defineTool<SpotsInput, SpotsOutput, PricesDeps>({
  name: LIST_PRICE_SPOTS_TOOL,
  readsFile: true,
  description:
    'Показать числа вне таблиц файла: в презентации pptx (текстовые блоки, подписи, группы) и ' +
    'в pdf с текстовым слоем (цена в предложении, колонки без линий): слайд или страница, ' +
    'число и текст вокруг него. Вызывай, когда сотрудник назвал цену, которой нет в таблицах ' +
    'из readPriceFile, или просит «что за цены на слайде N» и «на странице N». Передай path ' +
    'файла и, если известны, slide (презентация) или page (pdf). Это только список: цену правит ' +
    'editPriceInFile (передай slide или page и слова из текста вокруг числа в rowText). Числа ' +
    'с editable=false («от N», диапазон) как точная цена не правятся. status=not_available - ' +
    'сервис не вернул карту (выключено или сбой): скажи, что числа вне таблиц сейчас не вижу. ' +
    'Цены в картинках и диаграммах (unreachableCount) не правятся никогда.',
  inputSchema,
  outputSchema,
  async execute(input, deps, context): Promise<SpotsOutput> {
    const source = await openPriceSource(deps, input.path, context);
    if (!supportsPriceSpots(source.name)) {
      return none(
        'not_applicable',
        'Числа вне таблиц есть только у презентаций pptx, ppt и у pdf; у этого файла такого ' +
          'списка нет.',
      );
    }
    const map = await loadSpotMap(deps, source);
    if (map === null) {
      return none(
        'not_available',
        'Числа вне таблиц сейчас получить не удалось (чтение выключено или сервис не ответил). ' +
          'Не придумывай их: правка возможна только по таблицам, которые видны в readPriceFile.',
      );
    }
    const found = map.spots.filter(
      (spot) => inScope(spot, input) && parsePriceCell(spot.text).kind === 'ok',
    );
    const shown = found.slice(0, SPOTS_LIST_MAX).map((spot) => {
      const cell = parsePriceCell(spot.text);
      return {
        place: spotPlace(spot),
        text: spot.text,
        value: cell.kind === 'ok' ? cell.value : null,
        context: spotExcerpt(spot, SPOT_EXCERPT_MAX_CHARS),
        editable: isEditableSpot(spot),
        ...(isPdfSpot(spot) && spot.header !== null && spot.header !== ''
          ? { header: spot.header }
          : {}),
      };
    });
    const unreachableCount = unreachableIn(map, input);
    // У pdf места задаёт страница, у презентации - слайд
    const selector = source.name.toLowerCase().endsWith(PDF_EXTENSION) ? 'page' : 'slide';
    const more = found.length > shown.length;
    return {
      status: 'ok',
      total: found.length,
      spots: shown,
      truncated: map.truncated,
      unreachableCount,
      message:
        found.length === 0
          ? `Чисел вне таблиц не найдено${scopeNote(input)}.`
          : `Найдено чисел вне таблиц: ${found.length}` +
            (more
              ? `, показано ${shown.length}: укажи ${selector}, чтобы увидеть остальные`
              : '') +
            '. Это годы, телефоны, количества и цены вперемешку: цену выбирает сотрудник по ' +
            `тексту вокруг. Правка - editPriceInFile со ${selector} и rowText.` +
            (map.truncated ? ' Сервис обрезал карту: список неполный.' : ''),
    };
  },
});
