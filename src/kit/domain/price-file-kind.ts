/** Тип файла в папке прайсов по его названию. */
export type PriceFileKind = 'price' | 'not_price';

/** Правило «это не прайс»: пояснение и признак в базовом имени (нижний регистр, без расширения). */
interface NotPriceRule {
  /** Для чего правило (читается человеком; в логику не входит). */
  reason: string;
  pattern: RegExp;
  /** Действует, только если в названии нет слова «прайс» (каталог-прайс остаётся прайсом). */
  unlessPriceWord: boolean;
}

/** Слово «прайс»/«price» (с любой формой: прайсов, прайс-лист, price-list). */
const PRICE_WORD = /(?<!\p{L})(?:прайс|price)/iu;

/**
 * Таблица признаков «это не прайс». Проверяется по названию файла, не по содержимому:
 * каталоги, презентации, документы-правила и образцы оформления прайсом не являются, и в
 * список «дата в названии не найдена» попадать не должны. Новый признак - новая строка.
 */
const NOT_PRICE_RULES: readonly NotPriceRule[] = [
  { reason: 'каталог без слова «прайс»', pattern: /(?<!\p{L})каталог/iu, unlessPriceWord: true },
  { reason: 'презентация без слова «прайс»', pattern: /презентаци/iu, unlessPriceWord: true },
  {
    // `\b` в JS не знает кириллицу, поэтому границы слова - через \p{L}; цифра не граница-запрет
    // («КП5», «КП2024»), а `_`, `-`, `.` и пробел - разделители. «Некоммерческое» не ловится.
    reason: 'коммерческое предложение (КП) без слова «прайс»',
    pattern: /(?<!\p{L})кп(?!\p{L})|(?<!\p{L})коммерческ\p{L}*\s+предложени/iu,
    unlessPriceWord: true,
  },
  {
    reason: 'сроки исполнения заказов без слова «прайс»',
    pattern: /(?<!\p{L})сроки\s+исполнения/iu,
    unlessPriceWord: true,
  },
  {
    // Пометка владельца файла «не актуален» важнее слова «прайс» в названии.
    reason: 'пометка «не актуален» («неактуальный» и т.п.)',
    pattern: /(?<!\p{L})не\s*актуал(?:ен|ьн)/iu,
    unlessPriceWord: false,
  },
  { reason: 'регламент, правила', pattern: /(?<!\p{L})правила(?!\p{L})/iu, unlessPriceWord: false },
  {
    reason: 'приложение к документу («Прил_18 ...»)',
    pattern: /^прил(?:ожение|\.)?[\s._-]*\d+/iu,
    unlessPriceWord: false,
  },
  {
    reason: 'образцы оформления и брендирования',
    pattern: /^примеры?[\s._-]+(?:брендирования|оформления|нанесения)/iu,
    unlessPriceWord: false,
  },
];

/** Базовое имя файла: последний сегмент пути без расширения (с буквой, до 5 символов). */
export function priceFileBaseName(fileName: string): string {
  const last = fileName.split(/[\\/]/).pop() ?? '';
  return last.replace(/\.(?=[a-z0-9]*[a-z])[a-z0-9]{1,5}$/iu, '').trim();
}

/**
 * Прайс это или нет, только по названию (таблица {@link NOT_PRICE_RULES}). Всё, что не
 * опознано как «не прайс», считается прайсом: файл лежит в папке прайсов.
 *
 * @param fileName Имя файла или путь.
 */
export function classifyPriceFileName(fileName: string): PriceFileKind {
  const name = priceFileBaseName(fileName);
  const hasPriceWord = PRICE_WORD.test(name);
  for (const rule of NOT_PRICE_RULES) {
    if (rule.unlessPriceWord && hasPriceWord) continue;
    if (rule.pattern.test(name)) return 'not_price';
  }
  return 'price';
}

/**
 * Название похоже на прайс: опознано как прайс и содержит слово «прайс»/«price». Условие
 * для запасного разбора даты моделью: чужие файлы (сканы, счета) ей не отправляются.
 */
export function looksLikePriceListName(fileName: string): boolean {
  if (classifyPriceFileName(fileName) !== 'price') return false;
  return PRICE_WORD.test(priceFileBaseName(fileName));
}
