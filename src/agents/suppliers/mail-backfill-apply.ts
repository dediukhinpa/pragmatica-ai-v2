import type { SupplierNote } from '../../kit/domain/supplier-card';
import type { AuditRepository, Clock } from '@business-ai/core';
import { failureName, joinKey, stableHash, type FailureLog } from '@business-ai/core';
import {
  enrichCard,
  prepareFields,
  saveEnriched,
  type BuildContext,
  type EnrichmentNote,
  type EnrichmentSuppliers,
} from './card-enrichment';
import { SUPPLIER_AUDIT_ENRICH } from './deps';
import {
  cardChanges,
  cardFieldShown,
  cardVersionOf,
  reportItemId,
  type BackfillReport,
  type BackfillReportItem,
} from './mail-backfill-report';

/**
 * Применение подтверждённых пунктов отчёта разового прохода (этап 220b). Применяется только то,
 * что человек пометил `approved: true`. Перед записью код сверяет пункт с тем, что видел человек:
 * номер пункта - хэш (карточка, вид, поле, предложение), а запись `patch` на текущей карточке
 * должна дать ровно одно изменение - «поле -> предложение» этого пункта (иначе пункт не
 * применяется: файл правили или он испорчен). Решение принималось по состоянию поля на момент
 * отчёта: если карточку правили, но поле пункта прежнее (`was`), пункт применяется; если правили
 * само поле - пропуск `card_changed`, а режим `recheck` возвращает такой пункт на новое
 * подтверждение. Значения пишет тот же код обогащения, что и везде: только пустые поля, новые
 * контакты и элементы списков, расходящиеся значения не перезаписываются (поэтому пункты
 * `conflict` не применяются). Модель не вызывается. Повторное применение безопасно: применённые
 * пункты закрыты статусом, а заметка карточки несёт метку пункта.
 */

/** Автор записей в карточках и аудите. */
const APPLY_AUTHOR = 'supplier-mail-backfill';
/** Подпись заметки: откуда сведения и кто подтвердил. */
const APPLY_NOTE = 'Дополнено из общего ящика по подтверждению владельца';
const NOTE_MARKER_PREFIX = 'enrich:';
/** Длина даты в заметке: `YYYY-MM-DD`. */
const DATE_LENGTH = 10;

/** Зависимости применения. */
export interface BackfillApplyDeps {
  suppliers: EnrichmentSuppliers;
  clock: Pick<Clock, 'now'>;
  audit?: AuditRepository | undefined;
  /** Журнал событий: только коды и числа. */
  log?: FailureLog | undefined;
}

/** Итог применения: счётчики и состояние каждого пункта (номер пункта - хэш, без данных). */
export interface BackfillApplyResult {
  /** Применено (в пробном запуске - было бы применено). */
  applied: number;
  /** Пропущено: карточка менялась после отчёта. */
  skippedChanged: number;
  /** Пропущено: карточки больше нет. */
  skippedMissing: number;
  /** Пропущено: сведения уже в карточке или поле заполнено другим значением. */
  skippedPresent: number;
  /** Пропущено: пункт вида `conflict` или значение не прошло проверку. */
  skippedNotApplicable: number;
  /** Пункты без подтверждения: не тронуты. */
  notApproved: number;
  /** Подтверждённые пункты, закрытые ещё раньше. */
  alreadyResolved: number;
  items: Array<{ id: string; status: 'applied' | 'skipped'; reason?: string }>;
}

function emptyApplyResult(): BackfillApplyResult {
  return {
    applied: 0,
    skippedChanged: 0,
    skippedMissing: 0,
    skippedPresent: 0,
    skippedNotApplicable: 0,
    notApproved: 0,
    alreadyResolved: 0,
    items: [],
  };
}

type SkipReason = 'card_changed' | 'card_missing' | 'already_present' | 'not_applicable';

function noteOf(item: BackfillReportItem, nowIso: string): EnrichmentNote {
  const marker = `\n[${NOTE_MARKER_PREFIX}${stableHash(['info-backfill-apply', item.id])}]`;
  const note: SupplierNote = {
    text: `${APPLY_NOTE} ${nowIso.slice(0, DATE_LENGTH)}.${marker}`,
    authorId: APPLY_AUTHOR,
    createdAt: nowIso,
  };
  return { note, marker };
}

/** Запись аудита: кто, какая карточка, какой пункт; значений нет. Сбой аудита не роняет. */
async function auditApply(
  deps: BackfillApplyDeps,
  item: BackfillReportItem,
  nowIso: string,
): Promise<void> {
  if (deps.audit === undefined) return;
  try {
    await deps.audit.append(
      {
        at: nowIso,
        actor: APPLY_AUTHOR,
        agent: APPLY_AUTHOR,
        action: SUPPLIER_AUDIT_ENRICH,
        details: `supplier=${item.supplierId} item=${item.id} fields=1`,
        result: 'ok',
      },
      joinKey('suppliers-mail-backfill-apply', item.id),
    );
  } catch (error) {
    deps.log?.('supplier_mail_backfill_audit_failed', { code: failureName(error) });
  }
}

/** Закрыть пункт как пропущенный (в отчёте - только вне пробного запуска). */
function skip(
  result: BackfillApplyResult,
  item: BackfillReportItem,
  reason: SkipReason,
  nowIso: string,
  dryRun: boolean,
): void {
  if (reason === 'card_changed') result.skippedChanged += 1;
  else if (reason === 'card_missing') result.skippedMissing += 1;
  else if (reason === 'already_present') result.skippedPresent += 1;
  else result.skippedNotApplicable += 1;
  result.items.push({ id: item.id, status: 'skipped', reason });
  if (dryRun) return;
  item.status = 'skipped';
  item.reason = reason;
  item.resolvedAt = nowIso;
}

/**
 * Применить подтверждённые пункты. Меняет статусы пунктов в `report` (сохраняет вызывающий);
 * в пробном запуске (`dryRun`) не пишет ничего и отчёт не меняет, а только считает.
 */
export async function applyBackfillReport(
  report: BackfillReport,
  deps: BackfillApplyDeps,
  options: { dryRun: boolean },
): Promise<BackfillApplyResult> {
  const result = emptyApplyResult();
  const nowIso = deps.clock.now().toISOString();
  const context: BuildContext = { userId: APPLY_AUTHOR, nowIso };
  const bySupplier = new Map<string, BackfillReportItem[]>();
  for (const item of report.items) {
    if (!item.approved) {
      if (item.status === 'pending') result.notApproved += 1;
      continue;
    }
    if (item.status !== 'pending') {
      result.alreadyResolved += 1;
      continue;
    }
    if (item.kind !== 'fill' || item.patch === undefined) {
      skip(result, item, 'not_applicable', nowIso, options.dryRun);
      continue;
    }
    bySupplier.set(item.supplierId, [...(bySupplier.get(item.supplierId) ?? []), item]);
  }
  for (const [supplierId, items] of bySupplier) {
    // Версия сверяется один раз на карточку: после первой записи версия меняется, но остальные
    // пункты той же карточки подтверждались по тому же состоянию.
    const start = await deps.suppliers.getCard(supplierId);
    for (const item of items) {
      if (start === null) {
        skip(result, item, 'card_missing', nowIso, options.dryRun);
        continue;
      }
      // Запись прошла, а отчёт сохранить не успели: заметка пункта в карточке - он уже применён.
      const marker = noteOf(item, nowIso).marker;
      if (start.notes.some((note) => note.text.endsWith(marker))) {
        result.alreadyResolved += 1;
        if (!options.dryRun) {
          item.status = 'applied';
          item.resolvedAt = nowIso;
        }
        continue;
      }
      // Номер пункта несёт его содержимое: подмена поля или значения в файле его меняет.
      if (item.id !== reportItemId(item.supplierId, item.kind, item.field, item.proposed)) {
        skip(result, item, 'not_applicable', nowIso, options.dryRun);
        continue;
      }
      const patch = prepareFields(item.patch ?? {}, context).fields;
      if (Object.keys(patch).length === 0) {
        skip(result, item, 'not_applicable', nowIso, options.dryRun);
        continue;
      }
      // Правка другого поля пункту не мешает (запись только дописывающая); правка самого поля
      // меняет то, что человек подтверждал, - такой пункт пропускается.
      const versionSame = item.cardVersion === cardVersionOf(start);
      const fieldSame = cardFieldShown(start, item.field) === item.was;
      if (!versionSame && !fieldSame) {
        skip(result, item, 'card_changed', nowIso, options.dryRun);
        continue;
      }
      const preview = enrichCard(start, patch, context);
      if (!preview.changed) {
        skip(result, item, 'already_present', nowIso, options.dryRun);
        continue;
      }
      // Записано будет ровно то, что видел человек: одно поле и то же значение.
      const [only, ...rest] = cardChanges(start, preview.card);
      if (
        only === undefined ||
        rest.length > 0 ||
        only.field !== item.field ||
        only.proposed !== item.proposed
      ) {
        skip(result, item, versionSame ? 'not_applicable' : 'card_changed', nowIso, options.dryRun);
        continue;
      }
      const latest = (await deps.suppliers.getCard(supplierId)) ?? start;
      const note = noteOf(item, nowIso);
      const changed = options.dryRun
        ? enrichCard(latest, patch, context).changed
        : (await saveEnriched(deps.suppliers, supplierId, patch, context, undefined, note)).changed;
      if (!changed) {
        skip(result, item, 'already_present', nowIso, options.dryRun);
        continue;
      }
      result.applied += 1;
      result.items.push({ id: item.id, status: 'applied' });
      if (options.dryRun) continue;
      item.status = 'applied';
      item.resolvedAt = nowIso;
      await auditApply(deps, item, nowIso);
    }
  }
  return result;
}

/** Итог перепроверки: сколько пунктов вернулось на подтверждение и что стало с остальными. */
export interface BackfillRecheckResult {
  /** Пункт заново составлен по текущей карточке и ждёт подтверждения (`approved: false`). */
  reopened: number;
  /** Сведения уже есть в карточке: пункт закрыт как `already_present`. */
  alreadyPresent: number;
  /** Пункт больше не сводится к одной записи (поле заполнено иначе): оставлен как был. */
  unchanged: number;
  /** Карточки больше нет: пункт оставлен как был. */
  missing: number;
}

/**
 * Вернуть пропущенные `card_changed` пункты на повторное подтверждение, не читая ящик:
 * предложение заново считается из сохранённого `patch` на текущей карточке (письмо закрыто
 * отметкой, повторный проход его не прочитает). Прежнее подтверждение не переносится: в пункте
 * новые «было» и «предлагается», человек подтверждает его заново. В пробном запуске отчёт не
 * меняется.
 */
export async function recheckBackfillReport(
  report: BackfillReport,
  deps: Pick<BackfillApplyDeps, 'suppliers' | 'clock'>,
  options: { dryRun: boolean },
): Promise<BackfillRecheckResult> {
  const result: BackfillRecheckResult = {
    reopened: 0,
    alreadyPresent: 0,
    unchanged: 0,
    missing: 0,
  };
  const nowIso = deps.clock.now().toISOString();
  const context: BuildContext = { userId: APPLY_AUTHOR, nowIso };
  for (const item of [...report.items]) {
    const stale =
      item.status === 'skipped' &&
      item.reason === 'card_changed' &&
      item.kind === 'fill' &&
      item.patch !== undefined;
    if (!stale) continue;
    const card = await deps.suppliers.getCard(item.supplierId);
    if (card === null) {
      result.missing += 1;
      continue;
    }
    const preview = enrichCard(card, prepareFields(item.patch ?? {}, context).fields, context);
    if (!preview.changed) {
      result.alreadyPresent += 1;
      if (!options.dryRun) {
        item.reason = 'already_present';
        item.resolvedAt = nowIso;
      }
      continue;
    }
    const [only, ...rest] = cardChanges(card, preview.card);
    if (only === undefined || rest.length > 0 || only.field !== item.field) {
      result.unchanged += 1;
      continue;
    }
    result.reopened += 1;
    if (options.dryRun) continue;
    const id = reportItemId(item.supplierId, item.kind, item.field, only.proposed);
    const twin = report.items.find((other) => other !== item && other.id === id);
    if (twin !== undefined) {
      // Такое предложение уже есть отдельным пунктом: письма переносятся к нему.
      for (const ref of item.letters) {
        if (!twin.letters.some((known) => known.id === ref.id)) twin.letters.push(ref);
      }
      report.items.splice(report.items.indexOf(item), 1);
      continue;
    }
    item.id = id;
    item.was = only.was;
    item.proposed = only.proposed;
    item.cardVersion = cardVersionOf(card);
    item.approved = false;
    item.status = 'pending';
    delete item.reason;
    delete item.resolvedAt;
  }
  return result;
}
