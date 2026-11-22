import type { ParsedDocument } from '@business-ai/core';
import { extensionOf } from '@business-ai/core';
import type { PricesDeps } from './agents/prices/deps';
import type { PriceSource } from './agents/prices/price-sources';
import { describeTablePlaces } from './document-places';
import { annotateTextWithPages, pageOfTables, type PageAnnotation } from './docx-pages';
import type { DocxLayout, DocxLayoutClient } from './docx-pages-client';

/**
 * Место каждой таблицы файла для агента (этап 9p): слайд презентации, страница pdf, лист xlsx,
 * страница docx по фактической раскладке. Агент видит его в заголовке таблицы и в поле
 * `tablePlaces`, а правка по указанию «на слайде 11» ищет цену по тем же меткам, поэтому место
 * в тексте и место правки не расходятся. Не определилось - метки нет (`text: null`), номер
 * не выдумывается.
 */

/** Метка места одной таблицы. */
export interface TableLabel {
  kind: 'slide' | 'page' | 'sheet' | null;
  /** Номер слайда или страницы (с 1). */
  number?: number;
  /** Название листа (xlsx). */
  name?: string;
  /** Подпись для сотрудника: «Слайд 11», «Страница 3», «Лист «Прайс»»; null - не определено. */
  text: string | null;
}

/** Таблица без места. */
export const NO_LABEL: TableLabel = { kind: null, text: null };

/** Расширения презентаций и pdf: место берётся из заголовков разбора. */
const HEADING_EXTENSIONS: readonly string[] = ['.pptx', '.ppt', '.pdf'];
/** Расширения книг: место - название листа. */
const SHEET_EXTENSIONS: readonly string[] = ['.xlsx', '.xlsm', '.xls'];
/** Расширения текстовых документов: страница по раскладке сервиса. */
const FLOW_EXTENSIONS: readonly string[] = ['.docx', '.doc', '.rtf'];

/** Сколько раскладок держим в памяти процесса (по файлу одна). */
const LAYOUT_CACHE_MAX = 8;

const layoutCache = new Map<string, Promise<DocxLayout | null>>();

/** Расширение с точкой в нижнем регистре. */
function dotted(name: string): string {
  const extension = extensionOf(name).toLowerCase();
  return extension === '' || extension.startsWith('.') ? extension : `.${extension}`;
}

/**
 * Раскладка страниц документа от проектного сервиса; сбой, старый сервис или не-docx - `null`
 * (страницы - подсказка, чтение файла от них не зависит). Результат кэшируется по файлу, чтобы
 * чтение страницами не рендерило документ заново на каждый вызов.
 */
async function layoutOf(
  client: DocxLayoutClient,
  source: PriceSource,
): Promise<DocxLayout | null> {
  const key = `${source.hash}|${source.name}`;
  const cached = layoutCache.get(key);
  if (cached !== undefined) return cached;
  const pending = (async (): Promise<DocxLayout | null> => {
    try {
      return await client.pages({ name: source.name, bytes: await source.read() });
    } catch {
      return null;
    }
  })();
  layoutCache.set(key, pending);
  if (layoutCache.size > LAYOUT_CACHE_MAX) {
    const oldest = layoutCache.keys().next();
    if (oldest.done !== true) layoutCache.delete(oldest.value);
  }
  // Неудача не должна закрепиться в кэше: следующий вызов попробует снова.
  void pending.then((layout) => {
    if (layout === null) layoutCache.delete(key);
  });
  return pending;
}

/** Забыть кэш раскладок (тесты). */
export function resetLayoutCache(): void {
  layoutCache.clear();
}

/** Раскладка для источника, если она применима и сервис её отдал. */
async function flowLayout(deps: PricesDeps, source: PriceSource): Promise<DocxLayout | null> {
  const client = deps.docxLayout;
  if (client === undefined || !FLOW_EXTENSIONS.includes(dotted(source.name))) return null;
  return layoutOf(client, source);
}

/**
 * Метки мест всех таблиц разбора (по индексу таблицы). Для pptx и pdf место берётся из
 * заголовков `## Слайд N` / `## Страница N` текста разбора, для xlsx - название листа, для
 * docx/doc/rtf - страница из раскладки LibreOffice. Если число таблиц по заголовкам не
 * сошлось с `tables` (не должно быть), метки не ставятся, а не сдвигаются.
 */
export async function labelTables(
  deps: PricesDeps,
  source: PriceSource,
  parsed: ParsedDocument,
): Promise<TableLabel[]> {
  const extension = dotted(source.name);
  const empty = (): TableLabel[] => parsed.tables.map(() => NO_LABEL);
  if (HEADING_EXTENSIONS.includes(extension)) {
    const { places, labels } = describeTablePlaces(parsed.text);
    if (places.length !== parsed.tables.length) return empty();
    return places.map((place, index): TableLabel => {
      const text = labels[index] ?? null;
      return place === null || text === null
        ? NO_LABEL
        : { kind: place.kind, number: place.number, text };
    });
  }
  if (SHEET_EXTENSIONS.includes(extension)) {
    return parsed.tables.map((_, index): TableLabel => {
      const name = parsed.tableNames?.[index];
      return name === undefined || name === ''
        ? NO_LABEL
        : { kind: 'sheet', name, text: `Лист «${name}»` };
    });
  }
  if (FLOW_EXTENSIONS.includes(extension)) {
    const layout = await flowLayout(deps, source);
    if (layout === null) return empty();
    return pageOfTables(parsed.tables, layout.pages).map((page): TableLabel => {
      return page === null ? NO_LABEL : { kind: 'page', number: page, text: `Страница ${page}` };
    });
  }
  return empty();
}

/**
 * Названия таблиц для заголовков markdown: название листа, а если его нет - место («Слайд 11»,
 * «Страница 3»). Заголовок читается как `Таблица 5: «Слайд 11»`.
 */
export function headingNames(
  parsed: ParsedDocument,
  labels: readonly TableLabel[],
): string[] {
  return parsed.tables.map((_, index) => {
    const sheet = parsed.tableNames?.[index];
    if (sheet !== undefined && sheet !== '') return sheet;
    return labels[index]?.text ?? '';
  });
}

/** Текст разбора со страницами docx: маркеры `[стр. N]` либо исходный текст без изменений. */
export interface PagedText {
  text: string;
  /** Страницы определены (маркеры расставлены). */
  pagesKnown: boolean;
  /** Пометка для агента, если страницы не определены. */
  note?: string | undefined;
}

/** Пометка, когда страницы документа определить не удалось. */
export const PAGES_UNKNOWN_NOTE = 'страница не определена';

/**
 * Текст документа с маркерами страниц. Для docx/doc/rtf маркеры `[стр. N]` ставятся по фактической
 * раскладке; не получилось (нет сервиса, сбой, текст не сошёлся со страницами) - исходный текст и
 * пометка «страница не определена», номера не выдумываются. Для остальных форматов - без
 * изменений (у pptx и pdf заголовки уже в тексте разбора).
 */
export async function textWithPages(
  deps: PricesDeps,
  source: PriceSource,
  text: string,
): Promise<PagedText> {
  if (!FLOW_EXTENSIONS.includes(dotted(source.name))) return { text, pagesKnown: false };
  const layout = await flowLayout(deps, source);
  if (layout === null) return { text, pagesKnown: false, note: PAGES_UNKNOWN_NOTE };
  const annotated: PageAnnotation = annotateTextWithPages(text, layout.pages);
  return annotated.pagesKnown
    ? { text: annotated.text, pagesKnown: true }
    : { text, pagesKnown: false, note: PAGES_UNKNOWN_NOTE };
}

/** Пометка к таблицам docx, у которых ни одной страницы определить не удалось. */
export function tablePagesNote(
  source: PriceSource,
  labels: readonly TableLabel[],
): string | undefined {
  if (!FLOW_EXTENSIONS.includes(dotted(source.name))) return undefined;
  return labels.length > 0 && labels.every((label) => label.text === null)
    ? PAGES_UNKNOWN_NOTE
    : undefined;
}
