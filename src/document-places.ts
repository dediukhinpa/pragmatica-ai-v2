/** Код символа вертикальной черты: так начинается строка таблицы markdown. */
const PIPE = 0x7c;
/** Строка-разделитель таблицы (то же правило, что у разбора таблиц платформы). */
const SEPARATOR_ROW = /^\|(\s*:?-+:?\s*\|)+\s*$/;
/** Заголовок слайда или страницы: `## Слайд 3`, `## Слайд 3: Название [hidden]`. */
const HEADING_ROW = /^## (Слайд|Страница) (\d+)(?::[ \t]*(.*?))?([ \t]+\[hidden\])?[ \t\r]*$/;
/** Начало строки заголовка, по которому отсекаются обычные строки без среза. */
const HEADING_PREFIX = '## ';
const SLIDE_WORD = 'Слайд';

/** Место таблицы в исходном документе: слайд презентации или страница pdf. */
export interface TablePlace {
  kind: 'slide' | 'page';
  number: number;
  title?: string;
  hidden?: boolean;
}

/** Границы строки (без «\n») начиная с `from`. */
function lineEnd(markdown: string, from: number): number {
  const at = markdown.indexOf('\n', from);
  return at === -1 ? markdown.length : at;
}

/** Место из строки заголовка `markdown[from, to)` или `null`, если это не заголовок. */
function placeOfHeading(markdown: string, from: number, to: number): TablePlace | null {
  if (!markdown.startsWith(HEADING_PREFIX, from)) return null;
  const match = HEADING_ROW.exec(markdown.slice(from, to));
  if (match === null) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) return null;
  const title = (match[3] ?? '').trim();
  return {
    kind: match[1] === SLIDE_WORD ? 'slide' : 'page',
    number,
    ...(title === '' ? {} : { title }),
    ...(match[4] === undefined ? {} : { hidden: true }),
  };
}

/**
 * Место каждой таблицы markdown: последний заголовок слайда или страницы перед ней.
 *
 * Обход повторяет разбор таблиц платформы (`markdownToTables`): блок строк на `|` с
 * разделителем второй строкой, поэтому индекс результата равен индексу таблицы, а длины
 * совпадают всегда. Заголовок считается только в начале строки вне таблицы: `## Слайд 9`
 * внутри ячейки или посреди строки места не меняет. У документов без заголовков (xlsx, docx,
 * csv) место каждой таблицы - `null`. Разбор одним проходом, строки не копируются в массив.
 */
export function tablePlacesFromMarkdown(markdown: string): Array<TablePlace | null> {
  const places: Array<TablePlace | null> = [];
  const size = markdown.length;
  let current: TablePlace | null = null;
  let at = 0;
  while (at < size) {
    const end = lineEnd(markdown, at);
    const next = end + 1;
    if (markdown.charCodeAt(at) !== PIPE) {
      // Строка вне таблицы: возможный заголовок нового места.
      current = placeOfHeading(markdown, at, end) ?? current;
      at = next;
      continue;
    }
    if (next > size) break;
    const nextEnd = lineEnd(markdown, next);
    if (!SEPARATOR_ROW.test(markdown.slice(next, nextEnd))) {
      at = next;
      continue;
    }
    places.push(current);
    at = nextEnd + 1;
    while (at < size && markdown.charCodeAt(at) === PIPE) at = lineEnd(markdown, at) + 1;
  }
  return places;
}

/** Подпись места для сотрудника и модели: «Слайд 11», «Страница 3»; без места - `null`. */
export function placeLabel(place: TablePlace | null): string | null {
  if (place === null) return null;
  return `${place.kind === 'slide' ? 'Слайд' : 'Страница'} ${place.number}`;
}

/** Места таблиц markdown и их подписи (индекс - индекс таблицы). */
export function describeTablePlaces(markdown: string): {
  places: Array<TablePlace | null>;
  labels: Array<string | null>;
} {
  const places = tablePlacesFromMarkdown(markdown);
  return { places, labels: places.map(placeLabel) };
}
