/**
 * Название поставщика для автоматически созданной карточки, когда в шапке прайса его нет: берётся из имени
 * файла, а если оно ничего не говорит («Прайс 2026.xlsx») - из ближайшей папки выше. Чистая
 * функция, без обращения к диску.
 */

/** Наименьшая длина осмысленного названия, символов. */
const MIN_DRAFT_NAME_LENGTH = 3;
/** Слова, не нужные в названии поставщика: «прайс», «price», «лист», «list», «актуальный». */
const NOISE_WORDS =
  /(?<![\p{L}\p{N}])(?:прайс|price|лист|list|актуальн\p{L}*)(?![\p{L}])/giu;
/**
 * Хвосты имени файла прайса, которые в названии компании не встречаются: «Медовый дом Мед
 * новинки» искался и сопоставлялся с реестром вместе с «новинки» и не находился (28.10).
 * Срезаются и при поиске по имени папки поставщика (`supplierFolderName`), в т. ч. «опт»:
 * карточку ищем по реестру без слов-шумов, чтобы «Ромашка» и «Ромашка Опт» не плодили дубли
 * и давали одну карточку «Ромашка».
 */
const SEARCH_NOISE_WORDS = new RegExp(
  '(?<![\\p{L}\\p{N}])(?:новинк|набор|ассортимент|каталог|коммерческ|предложени|' +
    'обновлен|остатк|распродаж|скидк|розниц|прейскурант)\\p{L}*' +
    '|(?<![\\p{L}\\p{N}])(?:кп|опт|склад|цены|цена|new)(?![\\p{L}\\p{N}])',
  'giu',
);
/** Числа и версии: после замены разделителей даты 12.10.2026 стали числами 12 10 2026. */
const DATE_OR_NUMBER = /(?<![\p{L}\p{N}])v?\d+(?![\p{L}\p{N}])/giu;
/** Расширение файла. */
const EXTENSION = /\.[A-Za-z0-9]{2,5}$/;
const PATH_SEPARATOR = /[\\/]+/;
const SEPARATORS = /[_\-.,;()[\]]+/g;
const SPACES = /\s+/g;

/** Очистить имя от служебных слов, дат и разделителей; пусто, если ничего не осталось. */
function cleanSegment(segment: string): string {
  const text = segment
    .replace(EXTENSION, '')
    .replace(SEPARATORS, ' ')
    .replace(NOISE_WORDS, ' ')
    .replace(DATE_OR_NUMBER, ' ')
    .replace(SPACES, ' ')
    .trim();
  return text.length >= MIN_DRAFT_NAME_LENGTH ? text : '';
}

/**
 * Название поставщика по пути файла: очищенное имя файла, иначе ближайшая папка выше с
 * осмысленным названием; `null`, если пригодного названия нет.
 */
export function draftSupplierNameFromPath(path: string): string | null {
  const parts = path.split(PATH_SEPARATOR).filter((part) => part !== '');
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const name = cleanSegment(parts[index] ?? '');
    if (name !== '') return name;
  }
  return null;
}

/**
 * Название поставщика для поискового запроса: служебные хвосты («прайс», даты, версии,
 * расширение) убраны. Пусто, если ничего осмысленного не осталось.
 */
export function supplierSearchName(name: string): string {
  return cleanSegment(name.replace(SEARCH_NOISE_WORDS, ' '));
}
