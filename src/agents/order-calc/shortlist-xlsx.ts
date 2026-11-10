import { DomainError } from '@business-ai/core';
import {
  formatPrice,
  formatPriceTiers,
  formatPriceWithQualifier,
  type MarketPriceSample,
} from '../../kit/domain/market-price';
import { formatSupplierRating } from '../../kit/domain/supplier-rating';
import { type ShortlistProposal, webPricesOf } from '../../kit/domain/shortlist';
import { withWebNote } from '../../kit/domain/supplier-enrichment';
import { normalizeUnit } from '../../kit/domain/units';
import type { TableCell, TableSheet } from '@business-ai/core';
import type { OrderCalcDeps } from './deps';
import { SUMMARY_FILE_FORMAT } from './deps';
import { requestLabel } from './request-title';
import { DEFAULT_REQUEST_LABEL, SIMILAR_NOTE } from './shortlist-message';
import {
  contactsText,
  dateNotes,
  telegramPriceNoted,
  leadTimeText,
  marketView,
  placeText,
  priceLabel,
  siteOf,
  sourceLabel,
  vatNote,
  webContactsText,
  webMatchWarning,
  webPlaceText,
  webPriceText,
} from './shortlist-message';

/**
 * Файл Excel с полной таблицей шорт-листа (этап 113): карточки в чате показывают до трёх цен
 * и без сравнения, а менеджеру нужны все цены, тиражи и обоснование рейтинга в одном месте.
 * Таблицу строит код; контакты поставщиков уходят только менеджеру в чат и в модель не идут.
 */

type Entry = ShortlistProposal['entries'][number];

/** Имя листа с таблицей и листа со сведениями о заявке (в Excel имя листа - до 31 знака). */
export const SHORTLIST_SHEET_NAME = 'Шорт-лист';
export const SHORTLIST_INFO_SHEET_NAME = 'Заявка';
/** Префикс имени файла: «Шорт-лист_<номер заявки>.xlsx». */
const FILE_NAME_PREFIX = 'Шорт-лист_';
/** Символы, недопустимые в имени файла на портале и в файловых системах. */
const FILE_NAME_FORBIDDEN = /[\\/:*?"<>|\s]+/gu;
/** Пометка цены, как в карточке чата. */
const APPROXIMATE_NOTE = '(приблизительно, по части слов позиции)';
const RATING_MODEL_LABEL = 'оценка модели';
const RATING_RULE_LABEL = 'по правилу';
/** Разделитель нескольких значений в одной ячейке: перенос строки. */
const CELL_SEPARATOR = '\n';
const SECOND_FRACTION_DIGITS = 2;
/** Пустое сведение в таблице (решение владельца 28.10: все колонки ТЗ заполнены всегда). */
const NO_DATA = 'нет данных';

/** Столбцы таблицы в порядке показа. */
export const SHORTLIST_COLUMNS = [
  '№',
  'Поставщик',
  'Источник',
  'Стоимость',
  'Средняя/мин',
  'Срок',
  'Рейтинг',
  'Обоснование рейтинга',
  'Город/адрес',
  'Контакты',
  'Сайт',
  'Пометки',
] as const;

/** Одна цена текстом: тиражи, «от»/диапазон, справка о неподтверждённой, «приблизительно». */
function priceCell(price: MarketPriceSample): string {
  const [onlyTier, ...moreTiers] = price.tiers ?? [];
  const tiers =
    price.tiers === undefined
      ? ''
      : ` (${formatPriceTiers(price.tiers, price.currency, price.tierBasis)})`;
  const value =
    onlyTier !== undefined && moreTiers.length === 0 && price.tiers !== undefined
      ? formatPriceTiers(price.tiers, price.currency, price.tierBasis)
      : `${formatPriceWithQualifier(price)}${tiers}`;
  const note = price.unconfirmed === undefined ? '' : ` (${price.unconfirmed})`;
  // Близкий товар по оценке модели подписан так же, как у веба; прочее приблизительное - по словам.
  const rough =
    price.similar === true
      ? ` (${SIMILAR_NOTE})`
      : price.approximate === true
        ? ` ${APPROXIMATE_NOTE}`
        : '';
  const terms = price.note === undefined ? '' : ` (${price.note})`;
  const text = `${value}${dateNotes(price)} (${vatNote(price.vat)})${terms}${note}${rough}`;
  const label = priceLabel(price);
  return label === undefined ? text : `${label}: ${text}`;
}

/** Все цены поставщика; цена со страницы веб-кандидата - только если цен из базы нет. */
function pricesCell(entry: Entry): string {
  const prices = entry.prices ?? [];
  const web = webPricesOf(entry);
  if (prices.length === 0 && web.length > 0) {
    return web.map((price) => webPriceText(price, price.currency)).join(CELL_SEPARATOR);
  }
  // Цены из канала: пометка у каждой такой цены, как у цен со страниц сайтов.
  return prices.map((price) => telegramPriceNoted(price, priceCell(price))).join(CELL_SEPARATOR);
}

/** Выборка цен для среднего и минимума: цены с пометкой «приблизительно» в расчёт не берём. */
type StatSample = Pick<
  MarketPriceSample,
  'amount' | 'currency' | 'unit' | 'item' | 'vat' | 'fromTelegram'
>;

function statsSamples(entry: Entry): StatSample[] {
  const prices = entry.prices ?? [];
  const samples = prices.length === 0 ? webPricesOf(entry) : prices;
  return samples.filter((price) => price.approximate !== true);
}

/** Считается ли «Средняя/мин» по ценам со страниц (цен базы нет): тогда она из интернета. */
function statsFromWeb(entry: Entry): boolean {
  return (entry.prices ?? []).length === 0 && webPricesOf(entry).length > 0;
}

/**
 * «Средняя/мин» по группам одной позиции, валюты, единицы и признака НДС; одна цена - только
 * «мин». НДС в ключе группы: цена с НДС и без НДС несопоставимы, среднее между ними вводило бы
 * в заблуждение (ревью этапа 214); у строки группы стоит та же пометка НДС, что у цены.
 */
function averageCell(entry: Entry): string {
  const groups = new Map<string, StatSample[]>();
  for (const sample of statsSamples(entry)) {
    const key = JSON.stringify([
      sample.item ?? '',
      sample.currency,
      sample.unit === undefined ? '' : normalizeUnit(sample.unit),
      vatNote(sample.vat),
      // Цены базы и канала в одну среднюю не смешиваются (у канала своя пометка).
      sample.fromTelegram === true,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  const lines: string[] = [];
  const fromWeb = statsFromWeb(entry);
  for (const group of groups.values()) {
    const [first] = group;
    if (first === undefined) continue;
    const amounts = group.map((sample) => sample.amount);
    const min = Math.min(...amounts);
    const mean = amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length;
    const fmt = (amount: number): string =>
      formatPrice({ amount, currency: first.currency, unit: first.unit });
    const head = first.item === undefined ? '' : `${first.item}: `;
    const body =
      group.length === 1
        ? `${head}мин ${fmt(min)}`
        : `${head}ср. ${fmt(Number(mean.toFixed(SECOND_FRACTION_DIGITS)))}, мин ${fmt(min)}`;
    const text = `${body} (${vatNote(first.vat)})`;
    // Среднее и минимум по ценам страниц - тоже сведения из интернета; по ценам канала - из канала.
    if (fromWeb) lines.push(withWebNote(text));
    else lines.push(telegramPriceNoted(first, text));
  }
  return lines.join(CELL_SEPARATOR);
}

function ratingCell(entry: Entry): string {
  return entry.rating === null || entry.rating === undefined
    ? ''
    : formatSupplierRating(entry.rating);
}

/** Обоснование: источник оценки (модель или правило) и текст, если он есть. */
function ratingWhyCell(entry: Entry): string {
  if (entry.rating === null || entry.rating === undefined) return '';
  const mark = entry.ratingSource === 'model' ? RATING_MODEL_LABEL : RATING_RULE_LABEL;
  return entry.ratingRationale === undefined ? mark : `${mark}: ${entry.ratingRationale}`;
}

/**
 * Пометки строки: только предупреждение о совпадении данных из интернета. Пометок «не проверено,
 * не проверено» и «нет контактов» в шорт-листе нет (решение владельца 28.10), как и в сообщении.
 */
function notesCell(entry: Entry): string {
  return webMatchWarning(entry) ?? '';
}

function orNoData(value: string): string {
  return value.trim() === '' ? NO_DATA : value;
}

/** Строка таблицы одного поставщика; пустое сведение колонок ТЗ - «нет данных». */
function entryRow(entry: Entry, index: number): TableCell[] {
  return [
    index + 1,
    entry.name,
    entry.sources.map((source) => sourceLabel(source)).join(', '),
    orNoData(pricesCell(entry)),
    averageCell(entry),
    orNoData(leadTimeText(entry)),
    orNoData(ratingCell(entry)),
    ratingWhyCell(entry),
    orNoData(placeText(entry) || webPlaceText(entry)),
    orNoData(contactsText(entry) || webContactsText(entry)),
    siteOf(entry)?.text ?? '',
    notesCell(entry),
  ];
}

/** Дата заявки (дд.мм.гггг) из `createdAt`; нечитаемая дата - как есть. */
function dateText(createdAt: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(createdAt);
  return match === null ? createdAt : `${match[3]}.${match[2]}.${match[1]}`;
}

/**
 * Листы файла: «Шорт-лист» (по строке на поставщика) и «Заявка» (номер, дата, средние по базе и
 * по интернету, сколько кандидатов сравнено). Чистая функция: время берётся из шорт-листа.
 */
export function buildShortlistSheets(
  proposal: ShortlistProposal,
  label: string = DEFAULT_REQUEST_LABEL,
): TableSheet[] {
  const hasTiers = proposal.entries.some((entry) =>
    entry.prices?.some((price) => price.tiers !== undefined),
  );
  const view = marketView(
    proposal.market,
    proposal.webMarket,
    proposal.webPricesUnmatched,
    hasTiers,
    false,
    true,
    proposal.telegramMarket,
  );
  const cell = (lines: readonly string[]): string => lines.join(CELL_SEPARATOR);
  const shown = proposal.entries.length;
  const info: TableCell[][] = [
    ['Заявка', label],
    ['Дата', dateText(proposal.createdAt)],
    ['Поставщиков в списке', shown],
    ...(proposal.compared !== undefined && proposal.compared !== shown
      ? [['Сравнено кандидатов', proposal.compared]]
      : []),
    ['Средняя по базе', cell(view.base)],
    ['Средняя по интернету', cell(view.web)],
    ...(view.telegram.length === 0 ? [] : [['Средняя по Telegram-каналу', cell(view.telegram)]]),
    ...(view.note === '' ? [] : [['Пометки', view.note]]),
  ];
  return [
    {
      name: SHORTLIST_SHEET_NAME,
      columns: SHORTLIST_COLUMNS,
      rows: proposal.entries.map(entryRow),
    },
    { name: SHORTLIST_INFO_SHEET_NAME, columns: ['Параметр', 'Значение'], rows: info },
  ];
}

/** Имя файла «Шорт-лист_<название заявки>.xlsx»; недопустимые знаки названия заменены на «_». */
export function shortlistFileName(label: string = DEFAULT_REQUEST_LABEL): string {
  const safe = label.replace(FILE_NAME_FORBIDDEN, '_');
  return `${FILE_NAME_PREFIX}${safe}.${SUMMARY_FILE_FORMAT}`;
}

/** Итог отправки файла; ход от него не зависит. */
export type ShortlistXlsxOutcome = 'sent' | 'disabled' | 'empty' | 'unavailable' | 'failed';

type XlsxDeps = Pick<OrderCalcDeps, 'tableExporter' | 'chat' | 'log' | 'shortlistXlsxEnabled'> &
  Partial<Pick<OrderCalcDeps, 'state' | 'requests'>>;

/**
 * Отправить в тред менеджера файл Excel с шорт-листом. Не бросает: выгрузка недоступна или
 * упала - файла нет, в журнал событие, карточки в чате остаются (менеджер не остаётся без
 * шорт-листа из-за вспомогательного файла). Вызывать после сообщения с шорт-листом.
 */
export async function sendShortlistXlsx(
  deps: XlsxDeps,
  threadId: string,
  proposal: ShortlistProposal,
  key: string,
): Promise<ShortlistXlsxOutcome> {
  if (deps.shortlistXlsxEnabled === false) return 'disabled';
  if (proposal.entries.length === 0) return 'empty';
  if (deps.tableExporter === undefined) {
    deps.log?.('shortlist_xlsx_unavailable', { requestId: proposal.requestId });
    return 'unavailable';
  }
  try {
    // Название заявки вместо id и в файле: сотрудник ищет файл по продукции, а не по хэшу.
    const label =
      deps.state === undefined || deps.requests === undefined
        ? undefined
        : await requestLabel({ state: deps.state, requests: deps.requests }, proposal.requestId);
    const file = await deps.tableExporter.export(
      buildShortlistSheets(proposal, label),
      SUMMARY_FILE_FORMAT,
      shortlistFileName(label),
    );
    await deps.chat.sendFile(
      threadId,
      { name: file.fileName, mimeType: file.mimeType, content: file.bytes },
      `${key}:xlsx`,
    );
    return 'sent';
  } catch (error) {
    const code = error instanceof DomainError ? error.code : 'error';
    deps.log?.('shortlist_xlsx_failed', { requestId: proposal.requestId, code });
    return 'failed';
  }
}
