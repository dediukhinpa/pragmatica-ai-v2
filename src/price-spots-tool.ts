import { z } from 'zod';
import { defineTool } from '@business-ai/core';
import type { PricesDeps } from './agents/prices/deps';
import { openPriceSource } from './agents/prices/price-sources';
import { parsePriceCell } from './agents/prices/table-rows';
import { isEditableSpot, loadSpotMap, slidePlace, spotExcerpt } from './price-spots';
import { supportsPriceSpots } from './price-spots-client';

/**
 * Числа вне таблиц слайдов (этап 9q): текстовые блоки, подписи, группы фигур. `readPriceFile`
 * показывает таблицы, а цена в плашке «Акция: 680 ₽» в них не видна. Инструмент даёт агенту
 * список таких чисел с номером слайда и текстом вокруг, чтобы он назвал сотруднику место и
 * передал в `editPriceInFile` слайд и слова из текста (`rowText`).
 */

/** Имя инструмента. */
export const LIST_PRICE_SPOTS_TOOL = 'listPriceSpots';

/** Сколько чисел показываем за вызов: остальное - числом и просьбой сузить слайдом. */
export const SPOTS_LIST_MAX = 40;
/** Длина отрывка текста вокруг числа. */
const SPOT_EXCERPT_MAX_CHARS = 120;

const inputSchema = z.object({
  /** Идентификатор файла: path из сообщения сотрудника (чат), письма или диска. */
  path: z.string().min(1),
  /** Только числа этого слайда (с 1). */
  slide: z.number().int().positive().optional(),
});
interface SpotsInput {
  path: string;
  slide?: number | undefined;
}

const STATUSES = ['ok', 'not_available', 'not_applicable'] as const;

const spotOutputSchema = z.object({
  /** «Слайд 11». */
  place: z.string(),
  /** Число как в тексте: «680», «1 200,50 руб.». */
  text: z.string(),
  /** Значение числа; null - не разбирается как цена. */
  value: z.number().nullable(),
  /** Текст вокруг числа: по нему сотрудник узнаёт место. */
  context: z.string(),
  /** false - «от N», «до N», диапазон: как точная цена не правится. */
  editable: z.boolean(),
});
const outputSchema = z.object({
  status: z.enum(STATUSES),
  /** Сколько чисел найдено (с учётом слайда); в `spots` не больше {@link SPOTS_LIST_MAX}. */
  total: z.number().int(),
  spots: z.array(spotOutputSchema),
  /** Сервис обрезал карту по своему пределу: список неполный. */
  truncated: z.boolean(),
  /** Фигуры, в которых числа не правятся (картинки, диаграммы, SmartArt): сколько их. */
  unreachableCount: z.number().int(),
  message: z.string(),
});
type SpotsOutput = z.infer<typeof outputSchema>;

/** Пустой ответ без списка. */
function none(status: SpotsOutput['status'], message: string): SpotsOutput {
  return { status, total: 0, spots: [], truncated: false, unreachableCount: 0, message };
}

/**
 * Показать числа вне таблиц презентации: слайд, число и текст вокруг. Только чтение: правит
 * числа `editPriceInFile`.
 */
export const listPriceSpots = defineTool<SpotsInput, SpotsOutput, PricesDeps>({
  name: LIST_PRICE_SPOTS_TOOL,
  readsFile: true,
  description:
    'Показать числа вне таблиц презентации pptx (текстовые блоки, подписи, группы): слайд, ' +
    'число и текст вокруг него. Вызывай, когда сотрудник назвал цену, которой нет в таблицах ' +
    'из readPriceFile, или просит «что за цены на слайде N». Передай path файла и, если ' +
    'известен, slide. Это только список: цену правит editPriceInFile (передай slide и слова ' +
    'из текста вокруг числа в rowText). Числа с editable=false («от N», диапазон) как точная ' +
    'цена не правятся. status=not_available - сервис не вернул карту (выключено или сбой): ' +
    'скажи, что числа вне таблиц сейчас не вижу. Цены в картинках и диаграммах ' +
    '(unreachableCount) не правятся никогда.',
  inputSchema,
  outputSchema,
  async execute(input, deps, context): Promise<SpotsOutput> {
    const source = await openPriceSource(deps, input.path, context);
    if (!supportsPriceSpots(source.name)) {
      return none(
        'not_applicable',
        'Числа вне таблиц есть только у презентаций pptx и ppt; у этого файла такого списка нет.',
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
      (spot) =>
        (input.slide === undefined || spot.slide === input.slide) &&
        parsePriceCell(spot.text).kind === 'ok',
    );
    const shown = found.slice(0, SPOTS_LIST_MAX).map((spot) => {
      const cell = parsePriceCell(spot.text);
      return {
        place: slidePlace(spot.slide),
        text: spot.text,
        value: cell.kind === 'ok' ? cell.value : null,
        context: spotExcerpt(spot, SPOT_EXCERPT_MAX_CHARS),
        editable: isEditableSpot(spot),
      };
    });
    const unreachableCount = map.unreachable.filter(
      (item) => input.slide === undefined || item.slide === input.slide,
    ).length;
    const more = found.length > shown.length;
    return {
      status: 'ok',
      total: found.length,
      spots: shown,
      truncated: map.truncated,
      unreachableCount,
      message:
        found.length === 0
          ? 'Чисел вне таблиц не найдено' +
            (input.slide === undefined ? '.' : ` на слайде ${input.slide}.`)
          : `Найдено чисел вне таблиц: ${found.length}` +
            (more ? `, показано ${shown.length}: укажи slide, чтобы увидеть остальные` : '') +
            '. Это годы, телефоны, количества и цены вперемешку: цену выбирает сотрудник по ' +
            'тексту вокруг. Правка - editPriceInFile со slide и rowText.' +
            (map.truncated ? ' Сервис обрезал карту: список неполный.' : ''),
    };
  },
});
