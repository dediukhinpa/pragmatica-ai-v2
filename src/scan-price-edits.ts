import {
  DOUBT_LABELS,
  lineSum,
  nameMatches,
  sumMoney,
  type ScanDoubt,
  type ScanLine,
} from './scan-price-lines';

/**
 * Правка цен позиций скана и пересчёт сумм (этап 9v). Арифметику делает код: сумма позиции =
 * цена x количество, округление до копейки, итого = сумма сумм. НДС не добавляется и не
 * выделяется: считается только то, что есть в скане. Сомнительные позиции код не правит.
 */

/** Просьба сотрудника: у позиции, похожей на `match`, цена становится `newPrice`. */
export interface ScanPriceEdit {
  match: string;
  newPrice: number;
  /** Менять все подходящие позиции; без этого неоднозначное совпадение - вопрос сотруднику. */
  applyToAll?: boolean | undefined;
}

/** Строка сравнения «было / стало». */
export interface ScanChangeRow {
  index: number;
  name: string;
  qty: number | null;
  unit: string;
  oldPrice: number | null;
  newPrice: number | null;
  oldSum: number | null;
  newSum: number | null;
  /** Цена этой позиции изменена по просьбе. */
  changed: boolean;
  /** Остались сомнения после правки (список причин в `ScanDoubtful`). */
  doubts: ScanDoubt[];
}

/** Сомнительная позиция: код её не правил, человек сверяет со сканом. */
export interface ScanDoubtful {
  index: number;
  name: string;
  reasons: string[];
  raw: string;
}

/** Итог применения правок. */
export type ScanEditOutcome =
  | {
      status: 'ok';
      rows: ScanChangeRow[];
      oldTotal: number | null;
      newTotal: number | null;
      doubtful: ScanDoubtful[];
    }
  | { status: 'no_match'; match: string; names: string[] }
  | { status: 'ambiguous'; match: string; candidates: string[] };

/** Позиции, которые выбрала правка. */
function matchedLines(lines: readonly ScanLine[], edit: ScanPriceEdit): ScanLine[] {
  return lines.filter((line) => nameMatches(line.name, edit.match));
}

/** Итог по списку сумм: null, если хоть у одной позиции суммы нет (итог не угадывается). */
function totalOf(sums: ReadonlyArray<number | null>): number | null {
  const known = sums.filter((sum): sum is number => sum !== null);
  return known.length === sums.length && known.length > 0 ? sumMoney(known) : null;
}

function doubtfulOf(row: ScanChangeRow, line: ScanLine): ScanDoubtful {
  return {
    index: row.index,
    name: row.name,
    reasons: row.doubts.map((reason) => DOUBT_LABELS[reason]),
    raw: line.raw,
  };
}

/**
 * Применить правки цен к позициям скана и пересчитать суммы и итог. Позиция, которую правка не
 * затрагивает, остаётся как прочитана (сумма из скана); сомнительная и не тронутая правкой не
 * пересчитывается, а попадает в `doubtful`. Позиция, чью цену сотрудник задал, пересчитывается,
 * если количество читается: сумма = новая цена x количество.
 */
export function applyScanEdits(
  lines: readonly ScanLine[],
  edits: readonly ScanPriceEdit[],
): ScanEditOutcome {
  const newPrices = new Map<number, number>();
  for (const edit of edits) {
    const found = matchedLines(lines, edit);
    if (found.length === 0) {
      return { status: 'no_match', match: edit.match, names: lines.map((line) => line.name) };
    }
    if (found.length > 1 && edit.applyToAll !== true) {
      return {
        status: 'ambiguous',
        match: edit.match,
        candidates: found.map((line) => line.name),
      };
    }
    for (const line of found) newPrices.set(line.index, edit.newPrice);
  }
  const rows: ScanChangeRow[] = [];
  const doubtful: ScanDoubtful[] = [];
  for (const line of lines) {
    const target = newPrices.get(line.index);
    const changed = target !== undefined;
    const price = changed ? target : line.price;
    // Сумма: пересчёт только у правленой позиции (и при читаемом количестве).
    let newSum = line.sum;
    let doubts: ScanDoubt[] = [...line.doubts];
    if (changed) {
      // Цену задал сотрудник: сомнения про старую цену и старую сумму снимаются пересчётом.
      newSum = line.qty === null ? null : lineSum(target, line.qty);
      doubts = line.qty === null ? ['qty_unreadable'] : [];
    } else if (newSum === null && price !== null && line.qty !== null && doubts.length === 0) {
      newSum = lineSum(price, line.qty);
    }
    const row: ScanChangeRow = {
      index: line.index,
      name: line.name,
      qty: line.qty,
      unit: line.unit,
      oldPrice: line.price,
      newPrice: price,
      oldSum: line.sum,
      newSum,
      changed,
      doubts,
    };
    rows.push(row);
    if (doubts.length > 0) doubtful.push(doubtfulOf(row, line));
  }
  return {
    status: 'ok',
    rows,
    oldTotal: totalOf(lines.map((line) => line.sum)),
    newTotal: totalOf(rows.map((row) => row.newSum)),
    doubtful,
  };
}

/** Число для показа: целое без знаков, дробное с двумя знаками и запятой. */
export function formatMoney(value: number | null): string {
  if (value === null) return '?';
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return text.replace('.', ',');
}

/** Таблица «было / стало» для показа сотруднику; пометка про распознавание в заголовке. */
export function changeTableMarkdown(
  rows: readonly ScanChangeRow[],
  totals: { oldTotal: number | null; newTotal: number | null },
): string {
  const head =
    'Распознано со скана, сверьте с оригиналом.\n\n' +
    '| № | Наименование | Кол-во | Цена было | Цена стало | Сумма было | Сумма стало |\n' +
    '|---|---|---|---|---|---|---|';
  const body = rows.map((row) => {
    const qty = row.qty === null ? '?' : `${formatMoney(row.qty)} ${row.unit}`.trim();
    const mark = row.doubts.length > 0 ? ' (проверить)' : '';
    return (
      `| ${row.index} | ${row.name}${mark} | ${qty} | ${formatMoney(row.oldPrice)} | ` +
      `${formatMoney(row.newPrice)} | ${formatMoney(row.oldSum)} | ${formatMoney(row.newSum)} |`
    );
  });
  const oldTotal = formatMoney(totals.oldTotal);
  const newTotal = formatMoney(totals.newTotal);
  const total = `| | Итого | | | | ${oldTotal} | ${newTotal} |`;
  return [head, ...body, total].join('\n');
}
