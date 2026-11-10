import { z } from 'zod';
import type { PriceItem } from '../../kit/domain/models';
import {
  PRICE_GRADES,
  type PriceRelevanceItem,
  type PriceRelevanceName,
} from '../../kit/ports/price-relevance';
import type { ToolContext } from '@business-ai/core';
import { externalQueryProblem, mapPool } from '@business-ai/core';
import type { OrderCalcDeps } from './deps';
import { codeOf, withTimeout } from './web-enrichment';

/**
 * Проверка строк прайсов моделью (этапы 121 и 135). Поиск по прайсам находит строки по словам и
 * смыслу, и среди них бывает другой товар («Сокочай ... и Мёд» на «мёд»), а также тот же товар
 * не того года, объёма или ёмкости (ежедневник без даты на «датированный 2027», аккумулятор
 * 2500 мА·ч на 10000). Каждому названию даётся ключ `p1`, `p2`...; модель отвечает по ключу:
 * `exact` (тот же товар), `analog` (близкий, но не он) или `wrong`. `wrong` цены не даёт, `analog`
 * идёт в шорт-лист с пометкой «похожий товар» и в среднюю не входит. Модель видит только позицию
 * (название и требования к ней) и названия товаров (без поставщиков, цен, артикулов), ходит
 * через шлюз псевдонимизации; сбой, таймаут или недостоверный ответ ничего не убирают.
 */

/**
 * Сколько названий уходит модели за один вызов (`PRICE_RELEVANCE_MAX_NAMES`). Позиция с
 * большим числом названий делится на части, части позиций упаковываются в вызовы.
 */
export const PRICE_RELEVANCE_MAX_NAMES = 150;
/**
 * Предел ожидания одного вызова проверки, мс. Пачка до 150 названий отвечает дольше, чем
 * план запросов или извлечение цены, поэтому предел задан отдельной константой; сейчас он равен
 * общему (120 с, решение владельца 09.11), но не должен становиться меньше общего.
 */
export const PRICE_RELEVANCE_TIMEOUT_MS = 120_000;
/**
 * Сколько разных названий от одного поставщика проверяется по позиции: проверяются ВСЕ найденные
 * поставщики, а не те, что забрали верх выдачи (прежние 40 первых по рангу давали 1-2 поставщиков).
 */
export const PRICE_RELEVANCE_NAMES_PER_SUPPLIER = 3;
/** Сколько частей позиций упаковывается в один вызов. */
export const PRICE_RELEVANCE_MAX_ITEMS = 12;
/** Сколько вызовов модели допускается на сборку; остальные позиции остаются без проверки. */
export const PRICE_RELEVANCE_MAX_CALLS = 8;
/** Сколько вызовов идёт одновременно. */
const PRICE_RELEVANCE_CONCURRENCY = 3;
/** Самая длинная причина, которую мы храним (знаки): она нужна ранжированию, а не показу. */
export const PRICE_RELEVANCE_REASON_MAX_CHARS = 120;
const KEY_PREFIX = 'p';

/** Строки, найденные для одной позиции заявки. */
export interface PriceRowsOfItem {
  /** Позиция заявки (текст, как в заявке). */
  position: string;
  /** Характеристики позиции из задачи: по ним модель отличает нужный товар от близкого. */
  requirements?: string | undefined;
  /** Строки прайсов в порядке убывания близости. */
  rows: readonly PriceItem[];
}

/** Оценка строки, которая остаётся в выдаче (`wrong` строк не возвращается). */
export interface GradedPriceRow {
  row: PriceItem;
  /** `exact` - тот же товар; `analog` - похожий (в среднюю не входит). */
  grade: 'exact' | 'analog';
  /** Причина от модели (коротко); у строк без оценки модели её нет. */
  reason?: string | undefined;
  /**
   * Модель действительно оценила название этой строки. Нет признака - строка не проверялась
   * (проверяющего нет, сбой, позиция пропущена) и `exact` означает лишь «проверять нечем».
   */
  checked?: true | undefined;
}

/**
 * Ответ модели. Оценка читается строкой и проверяется отдельно: одна неизвестная оценка не
 * должна ронять ответ по остальным ключам.
 */
const answerSchema = z.object({
  results: z.array(
    z.object({
      item: z.coerce.number().int().nonnegative(),
      grades: z.array(
        z.object({
          key: z.string(),
          grade: z.string(),
          reason: z.string().optional(),
        }),
      ),
    }),
  ),
});

const gradeSchema = z.enum(PRICE_GRADES);
const WHITESPACE_RUN = /\s+/g;

/** Ключ названия для сопоставления вердикта со строками: без регистра и лишних пробелов. */
function nameKey(name: string): string {
  return name.replace(WHITESPACE_RUN, ' ').trim().toLowerCase();
}

/** Название, отправляемое на проверку, и его ключ для модели. */
interface NameEntry extends PriceRelevanceName {
  nameKey: string;
}

/** Часть позиции, ушедшая в один вызов. */
interface Piece {
  /** Индекс группы во входе `filterRelevantPrices`. */
  groupIndex: number;
  position: string;
  requirements?: string | undefined;
  entries: NameEntry[];
}

/** Решение модели по названию. */
interface Verdict {
  grade: 'exact' | 'analog' | 'wrong';
  reason: string | undefined;
}

/**
 * Названия на проверку по позиции: не больше `perSupplier` разных названий от поставщика, в
 * порядке выдачи. Названия, уже взятые у другого поставщика, места не занимают.
 */
function namesToCheck(rows: readonly PriceItem[], perSupplier: number): NameEntry[] {
  const entries: NameEntry[] = [];
  const known = new Set<string>();
  const taken = new Map<string, number>();
  for (const row of rows) {
    const key = nameKey(row.productName);
    if (known.has(key)) continue;
    const count = taken.get(row.supplierId) ?? 0;
    if (count >= perSupplier) continue;
    taken.set(row.supplierId, count + 1);
    known.add(key);
    entries.push({
      key: `${KEY_PREFIX}${entries.length + 1}`,
      name: row.productName,
      nameKey: key,
    });
  }
  return entries;
}

/** Упаковать части позиций в вызовы: не больше `maxNames` названий и `MAX_ITEMS` частей. */
function packCalls(plans: readonly Piece[], maxNames: number): Piece[][] {
  const calls: Piece[][] = [];
  let current: Piece[] = [];
  let used = 0;
  const flush = (): void => {
    if (current.length > 0) calls.push(current);
    current = [];
    used = 0;
  };
  for (const plan of plans) {
    for (let from = 0; from < plan.entries.length; from += maxNames) {
      const entries = plan.entries.slice(from, from + maxNames);
      if (used + entries.length > maxNames || current.length >= PRICE_RELEVANCE_MAX_ITEMS) flush();
      current.push({ ...plan, entries });
      used += entries.length;
    }
  }
  flush();
  return calls;
}

/**
 * Оценить строки позиций. Возвращает по списку на каждую входную позицию в том же порядке:
 * строки `wrong` убраны, у остальных - оценка. Нет проверяющего, нечего проверять, сбой или
 * недостоверный ответ - позиция возвращается без изменений, все строки `exact` (проверять
 * нечем, как и до этапа 135). В позиции, на которую модель ответила, строки с названием вне
 * отправленных отбрасываются (хвост выдачи сверх лимита названий на поставщика и названия
 * вызова, который сбился и после повтора), а название, по
 * которому модель ключ пропустила, считается непроверенным и идёт как `analog`: в среднюю
 * непроверенное не попадает, но и молча в «подходящие» не превращается.
 */
export async function filterRelevantPrices(
  deps: OrderCalcDeps,
  context: ToolContext,
  groups: readonly PriceRowsOfItem[],
): Promise<GradedPriceRow[][]> {
  const unchanged = (): GradedPriceRow[][] =>
    groups.map((group) => group.rows.map((row) => ({ row, grade: 'exact' as const })));
  const checker = deps.priceRelevance;
  if (checker === undefined) return unchanged();
  const maxNames = Math.max(1, deps.priceRelevanceMaxNames ?? PRICE_RELEVANCE_MAX_NAMES);
  const plans: Piece[] = [];
  for (const [groupIndex, group] of groups.entries()) {
    if (group.rows.length === 0 || externalQueryProblem(group.position) !== null) continue;
    const entries = namesToCheck(group.rows, PRICE_RELEVANCE_NAMES_PER_SUPPLIER);
    if (entries.length > 0) {
      plans.push({
        groupIndex,
        position: group.position,
        ...(group.requirements === undefined ? {} : { requirements: group.requirements }),
        entries,
      });
    }
  }
  const calls = packCalls(plans, maxNames).slice(0, PRICE_RELEVANCE_MAX_CALLS);
  if (calls.length === 0) return unchanged();
  const answers = await mapPool(calls, PRICE_RELEVANCE_CONCURRENCY, async (call) => {
    // Один повтор: сбой одного из нескольких вызовов по позиции иначе выкидывает его названия.
    const first = await askModel(deps, context, call);
    return first ?? (await askModel(deps, context, call));
  });
  // Позиция -> название -> решение. Позиция без записи в `answered` не проверялась вовсе.
  const verdicts = new Map<number, Map<string, Verdict>>();
  const answered = new Set<number>();
  const asked = new Map<number, Set<string>>();
  for (const [callIndex, call] of calls.entries()) {
    const answer = answers[callIndex];
    for (const [pieceIndex, piece] of call.entries()) {
      const byKey = answer?.get(pieceIndex);
      // Названия вызова, который не ответил, в «отправленные» не идут: если по позиции ответили
      // другие вызовы, такие строки отбрасываются как непроверенные, а не проходят как `analog`
      // (флешки 30.10: семь вызовов отвергли всё, восьмой сбился - и его 40 строк мусора
      // прошли в шорт-лист с ценой).
      if (byKey === undefined) continue;
      const names = asked.get(piece.groupIndex) ?? new Set<string>();
      for (const entry of piece.entries) names.add(entry.nameKey);
      asked.set(piece.groupIndex, names);
      answered.add(piece.groupIndex);
      const own = verdicts.get(piece.groupIndex) ?? new Map<string, Verdict>();
      for (const entry of piece.entries) {
        const verdict = byKey.get(entry.key);
        if (verdict !== undefined) own.set(entry.nameKey, verdict);
      }
      verdicts.set(piece.groupIndex, own);
    }
  }
  return groups.map((group, index) => {
    if (!answered.has(index)) return group.rows.map((row) => ({ row, grade: 'exact' as const }));
    const own = verdicts.get(index) ?? new Map<string, Verdict>();
    const sent = asked.get(index) ?? new Set<string>();
    const graded: GradedPriceRow[] = [];
    for (const row of group.rows) {
      const key = nameKey(row.productName);
      if (!sent.has(key)) continue;
      const verdict = own.get(key);
      // Ключ пропущен в ответившем вызове - непроверенное, в среднюю не идёт.
      if (verdict === undefined) graded.push({ row, grade: 'analog' });
      else if (verdict.grade !== 'wrong') {
        graded.push({ row, grade: verdict.grade, reason: verdict.reason, checked: true });
      }
    }
    return graded;
  });
}

/** Усечь причину модели: она идёт в ранжирование и журнал состояния, а не в показ. */
function shortReason(reason: string | undefined): string | undefined {
  const text = (reason ?? '').replace(WHITESPACE_RUN, ' ').trim();
  if (text === '') return undefined;
  return Array.from(text).slice(0, PRICE_RELEVANCE_REASON_MAX_CHARS).join('');
}

/**
 * Один вызов модели и разбор ответа: индекс части в вызове -> ключ -> решение. Неизвестные
 * ключи и оценки отбрасываются, пропущенные ключи в карту не попадают. `null` - сбой, таймаут
 * или недостоверный ответ (вызывающий код ничего не убирает).
 */
async function askModel(
  deps: OrderCalcDeps,
  context: ToolContext,
  call: readonly Piece[],
): Promise<Map<number, Map<string, Verdict>> | null> {
  const checker = deps.priceRelevance;
  if (checker === undefined) return null;
  const input: PriceRelevanceItem[] = call.map((piece, item) => ({
    item,
    position: piece.position,
    // Требования идут тем же путём, что и название: через шлюз псевдонимизации.
    ...(piece.requirements === undefined ? {} : { requirements: piece.requirements }),
    names: piece.entries.map(({ key, name }) => ({ key, name })),
  }));
  const sent = call.reduce((sum, piece) => sum + piece.entries.length, 0);
  try {
    const raw = await withTimeout(
      (signal) => checker.check({ items: input }, { signal }),
      context.signal,
      PRICE_RELEVANCE_TIMEOUT_MS,
    );
    const parsed = answerSchema.safeParse(raw);
    if (!parsed.success) {
      deps.log?.('price_relevance_failed', { code: 'bad_answer', sent });
      return null;
    }
    const result = new Map<number, Map<string, Verdict>>();
    const counts = { exact: 0, analog: 0, wrong: 0 };
    for (const entry of parsed.data.results) {
      const piece = call[entry.item];
      if (piece === undefined || result.has(entry.item)) continue;
      const known = new Set(piece.entries.map((name) => name.key));
      const byKey = new Map<string, Verdict>();
      for (const item of entry.grades) {
        const key = item.key.trim().toLowerCase();
        const grade = gradeSchema.safeParse(item.grade.trim().toLowerCase());
        if (!known.has(key) || byKey.has(key) || !grade.success) continue;
        byKey.set(key, { grade: grade.data, reason: shortReason(item.reason) });
        counts[grade.data] += 1;
      }
      result.set(entry.item, byKey);
    }
    deps.log?.('price_relevance_check', {
      sent,
      answeredNames: counts.exact + counts.analog + counts.wrong,
      exact: counts.exact,
      analog: counts.analog,
      // Прежнее поле журнала: сколько названий отсеяно.
      rejected: counts.wrong,
    });
    // Откат остаётся только на сбой и на ответ без позиций: большая доля `wrong` - честный
    // ответ (поиск по словам приносит ложечки для мёда), а не повод вернуть весь мусор.
    return result.size === 0 ? null : result;
  } catch (error) {
    deps.log?.('price_relevance_failed', { code: codeOf(error), sent });
    return null;
  }
}
