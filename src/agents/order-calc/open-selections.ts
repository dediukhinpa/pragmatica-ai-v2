import { z } from 'zod';
import { DAY_MS } from '../../kit/domain/time';
import { stateEntries } from '@business-ai/core';
import { readState, writeState } from '@business-ai/core';
import {
  OPEN_SELECTION_BACKFILL_NAMESPACE,
  OPEN_SELECTION_NAMESPACE,
  REPLY_WINDOW_DAYS,
  SELECTION_NAMESPACE,
  STATE_SCAN_MAX_PAGES,
  STATE_SCAN_PAGE,
  type OrderCalcDeps,
} from './deps';
import { loadSent, logScanLimit, selectionSchema, type Selection } from './state';

type OpenSelectionsDeps = Pick<OrderCalcDeps, 'state' | 'clock' | 'log'>;

/** Ключ и значение отметки однократного внесения старых выборов в индекс. */
const BACKFILL_MARKER_KEY = 'v1';
const backfillMarkerSchema = z.object({ doneAt: z.string() });

/** Окно ответа по выбору истекло: письмо поставщика уже не может быть ответом на запрос. */
function isSelectionExpired(selection: Selection, nowMs: number): boolean {
  const created = Date.parse(selection.createdAt);
  return !Number.isNaN(created) && nowMs - created > REPLY_WINDOW_DAYS * DAY_MS;
}

/**
 * Один раз внести в индекс выборы, сделанные до его появления (запасной путь для старых
 * записей): обход всего пространства выборов идёт потоком, без накопления, и только пока нет
 * отметки. Записи, уже попавшие в индекс при новой записи выбора, не перезаписываются.
 * Отметка ставится после полного обхода: сбой посередине даёт повтор, а не пропуск.
 */
async function backfillOpenSelections(deps: OpenSelectionsDeps): Promise<void> {
  const { state } = deps;
  const marker = await readState(
    state,
    OPEN_SELECTION_BACKFILL_NAMESPACE,
    BACKFILL_MARKER_KEY,
    backfillMarkerSchema,
  );
  if (marker !== null) return;
  const nowMs = deps.clock.now().getTime();
  let scanned = 0;
  let indexed = 0;
  const entries = stateEntries(state, SELECTION_NAMESPACE, { pageSize: STATE_SCAN_PAGE });
  for await (const entry of entries) {
    scanned += 1;
    const parsed = selectionSchema.safeParse(entry.value);
    if (!parsed.success || isSelectionExpired(parsed.data, nowMs)) continue;
    if ((await state.get(OPEN_SELECTION_NAMESPACE, parsed.data.requestId)) !== null) continue;
    await writeState(state, OPEN_SELECTION_NAMESPACE, parsed.data.requestId, parsed.data);
    indexed += 1;
  }
  await writeState(state, OPEN_SELECTION_BACKFILL_NAMESPACE, BACKFILL_MARKER_KEY, {
    doneAt: deps.clock.now().toISOString(),
  });
  deps.log?.('order_selection_index_backfilled', { scanned, indexed });
}

/**
 * Выборы менеджера, по которым запрос ещё не записан ни у кого (R6-01-06): ответ на такой
 * выбор может прийти раньше записи об отправке. Читается индекс открытых выборов, а не все
 * выборы: ключи выборов - хэши, и по прошествии ~10 тыс. заявок свежие выпадали бы из
 * ограниченного обхода. Закрытые (запрос ушёл всем выбранным) и просроченные выборы
 * снимаются с индекса здесь же. В `supplierIds` остаются только поставщики без записанного
 * запроса.
 */
export async function listOpenSelections(deps: OpenSelectionsDeps): Promise<Selection[]> {
  await backfillOpenSelections(deps);
  const { state } = deps;
  const nowMs = deps.clock.now().getTime();
  const result: Selection[] = [];
  const entries = stateEntries(state, OPEN_SELECTION_NAMESPACE, {
    pageSize: STATE_SCAN_PAGE,
    maxPages: STATE_SCAN_MAX_PAGES,
    onLimit: () => logScanLimit(deps.log, OPEN_SELECTION_NAMESPACE),
  });
  for await (const entry of entries) {
    const parsed = selectionSchema.safeParse(entry.value);
    if (!parsed.success) continue;
    const { requestId } = parsed.data;
    if (isSelectionExpired(parsed.data, nowMs)) {
      await state.delete(OPEN_SELECTION_NAMESPACE, requestId);
      continue;
    }
    const sent = await loadSent(deps, requestId);
    const rest = parsed.data.supplierIds.filter((id) => sent?.supplierIds.includes(id) !== true);
    if (rest.length === 0) {
      await state.delete(OPEN_SELECTION_NAMESPACE, requestId);
      continue;
    }
    result.push({ ...parsed.data, supplierIds: rest });
  }
  return result;
}
