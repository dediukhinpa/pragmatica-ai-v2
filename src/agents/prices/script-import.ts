import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import { MAX_PRICE_TIERS, type PriceItem } from '../../kit/domain/models';
import { priceItemKey } from '../../kit/domain/price-diff';
import type { JsonValue, ParsedDocument } from '@business-ai/core';
import type { PriceScriptAuthor } from '../../kit/ports/supplier-price-scripts';
import type { ToolContext } from '@business-ai/core';
import { readState, recordWorkOwner, requirePort, stableHash, writeState } from '@business-ai/core';
import { workSubject } from '../shared/work-owner.owned';
import {
  buildScriptRequest,
  SCRIPT_RESULT_SAMPLE_SIZE as PRICE_ITEMS_SAMPLE_SIZE,
  readScriptFile,
} from '@business-ai/core';
import { SCRIPT_UNCONFIRMED_NAMESPACE, type PricesDeps } from './deps';
import { recordDiskSyncOutcome } from './disk-sync-outcome';
import { issuesToWarnings } from './import-checks';
import { assertSourceSupplier, type PriceSource } from './price-sources';
import { recordSource, stagingImportId } from './staging-source';
import {
  TEXT_MAX_CHARS,
  parseScriptItems,
  toPriceItems,
  type ScriptPriceItem,
} from './script-price-items';
import {
  countSourceDataRows,
  collapseExactDuplicates,
  countSourceItemUnits,
  diffItems,
  reconcileScriptItems,
} from './script-reconcile';
import { tableFormFingerprint } from './table-form';

/** События журнала скриптов: только коды и числа. */
const SAVED_SCRIPT_EVENT = 'saved_script_run';
const SCRIPT_STAGED_EVENT = 'script_items_staged';

/** Название таблицы в staging для позиций скрипта: он разбирает файл целиком. */
const SCRIPT_STAGING_TABLE = '0';

/** Источник прайса для скрипта: обычный источник прайса плюс то, что нужно песочнице. */
export interface PriceDataScriptSource {
  name: string;
  read(): Promise<Uint8Array>;
  /** Размер без чтения в память (файл на диске), см. `DataScriptSource.size`. */
  size?(): Promise<number | undefined>;
  parse(): Promise<ParsedDocument>;
  price: PriceSource;
}

/** Признак: источник данных скрипта - файл прайса (а не вложение другого агента). */
export function isPriceDataSource(source: object): source is PriceDataScriptSource {
  return 'price' in source;
}

/** Что нужно, чтобы положить позиции скрипта в staging. */
export interface StageScriptParams {
  supplierId: string;
  source: PriceDataScriptSource;
  parsed: ParsedDocument;
  code: string;
  raw: readonly JsonValue[];
  /** Контекст вызова: тред и инициатор (владелец работы). */
  context: ToolContext;
  /**
   * Кто создал скрипт: сохраняется за поставщиком. `null` - запуск уже сохранённого скрипта,
   * заново он не пишется.
   */
  createdBy: PriceScriptAuthor | null;
  /** Скрипт переписан по просьбе сотрудника: в ответ добавляется разница «было/стало». */
  withDiff: boolean;
  /**
   * Строгий режим для запуска сохранённого скрипта без сотрудника: любое замечание сверки
   * отклоняет результат, и разбор идёт обычным путём. Для скрипта в диалоге (по умолчанию)
   * блокируют только жёсткие замечания, остальное уходит в `warnings` сводки.
   */
  strict?: boolean | undefined;
}

/**
 * Замечания сверки, которые остаются блоком: нечего записывать и цены, которых нет в исходнике
 * (запрет выдумывать значения). Всё остальное - пороговые и формальные проверки - предупреждения.
 */
const HARD_RECONCILE_CODES: ReadonlySet<string> = new Set(['no_items', 'price_not_in_source']);

/** Замечание сверки в ответе модели. */
interface IssueSummary {
  code: string;
  message: string;
}

/** Итог: сверка не пройдена (позиции не записаны) либо позиции в staging. */
export type StageScriptResult =
  | { accepted: false; issues: IssueSummary[]; count: number }
  | { accepted: true; staged: number; summary: Record<string, JsonValue> };

function sampleOf(items: readonly PriceItem[]): JsonValue[] {
  return items.slice(0, PRICE_ITEMS_SAMPLE_SIZE).map((item) => ({
    name: item.productName,
    sku: item.sku ?? null,
    price: item.price,
    currency: item.currency,
    tiers: item.priceTiers?.length ?? 0,
    tierBasis: item.priceTierBasis ?? 'quantity',
    priceQualifier: item.priceQualifier ?? null,
  }));
}

function diffSummary(before: readonly PriceItem[], after: readonly PriceItem[]): JsonValue {
  const diff = diffItems(before, after);
  return {
    before: diff.before,
    after: diff.after,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    sample: diff.sample.map((change) => ({ ...change })),
  };
}

/** Метка неподтверждённой версии: по форме и по импорту. */
const unconfirmedSchema = z.object({
  supplierId: z.string(),
  formHash: z.string(),
  version: z.number().int(),
});
type Unconfirmed = z.infer<typeof unconfirmedSchema>;

const formMarkKey = (supplierId: string, formHash: string): string =>
  `form:${supplierId}:${formHash}`;
const importMarkKey = (importId: string): string => `import:${importId}`;

/**
 * Версия записывается за поставщиком сразу (её номер нужен сводке), но подтверждает её только
 * фиксация импорта (`confirmScriptVersion`): до того запрос ещё мог быть отвергнут человеком, и
 * непроверенный скрипт не должен сам разбирать следующие прайсы (`runSavedScript` его пропускает).
 */
async function markUnconfirmed(
  deps: PricesDeps,
  importId: string,
  mark: Unconfirmed,
): Promise<void> {
  if (deps.state === undefined) return;
  const namespace = SCRIPT_UNCONFIRMED_NAMESPACE;
  await writeState(deps.state, namespace, formMarkKey(mark.supplierId, mark.formHash), mark);
  await writeState(deps.state, namespace, importMarkKey(importId), mark);
}

/** Версия формы ещё не подтверждена фиксацией: автоматически её запускать нельзя. */
async function isUnconfirmed(
  deps: PricesDeps,
  supplierId: string,
  formHash: string,
  version: number,
): Promise<boolean> {
  if (deps.state === undefined) return false;
  const key = formMarkKey(supplierId, formHash);
  const mark = await readState(deps.state, SCRIPT_UNCONFIRMED_NAMESPACE, key, unconfirmedSchema);
  return mark?.version === version;
}

/** Фиксация импорта подтвердила версию скрипта, которой он разобран (нет метки - ничего). */
export async function confirmScriptVersion(deps: PricesDeps, importId: string): Promise<void> {
  if (deps.state === undefined) return;
  const namespace = SCRIPT_UNCONFIRMED_NAMESPACE;
  const key = importMarkKey(importId);
  const mark = await readState(deps.state, namespace, key, unconfirmedSchema);
  if (mark === null) return;
  const formKey = formMarkKey(mark.supplierId, mark.formHash);
  const current = await readState(deps.state, namespace, formKey, unconfirmedSchema);
  // Метку формы снимаем, только если она про эту версию: новее могла появиться другая.
  if (current?.version === mark.version) await deps.state.delete(namespace, formKey);
  await deps.state.delete(namespace, key);
}

/** Сохранить скрипт за поставщиком и формой таблицы; повтор того же кода версию не двигает. */
async function rememberScript(
  deps: PricesDeps,
  params: StageScriptParams,
  createdBy: PriceScriptAuthor,
  importId: string,
): Promise<number | null> {
  if (deps.priceScripts === undefined || params.parsed.truncated) return null;
  const formHash = tableFormFingerprint(params.parsed.tables);
  const latest = await deps.priceScripts.findLatest(params.supplierId, formHash);
  if (latest?.code === params.code) return latest.version;
  const saved = await deps.priceScripts.save({
    supplierId: params.supplierId,
    formHash,
    code: params.code,
    createdBy,
    createdAt: deps.clock.now().toISOString(),
  });
  await markUnconfirmed(deps, importId, {
    supplierId: params.supplierId,
    formHash,
    version: saved.version,
  });
  return saved.version;
}

/**
 * Результат скрипта -> staging того же импорта, что у `stagePriceRows`. Сверка до записи;
 * не прошла - в staging ничего не меняется. Прошла: прежний staging файла заменяется (скрипт
 * разбирает файл целиком), позиции идут дальше тем же путём (`commitPriceImport` и тот же
 * валидатор импорта). Модели возвращается только сводка.
 */
export async function stageScriptItems(
  deps: PricesDeps,
  params: StageScriptParams,
): Promise<StageScriptResult> {
  const { supplierId, source, parsed } = params;
  if ((await deps.suppliers.get(supplierId)) === null) {
    throw new DomainError('not_found', `Поставщик ${supplierId} не найден в базе.`);
  }
  assertSourceSupplier(source.price, supplierId);
  const { items: parsedItems, invalid, textTrimmed, tiersDropped } = parseScriptItems(params.raw);
  const parsedTrimmed = textTrimmed ?? [];
  // Точные повторы строк исходника (лист с повторяющимися товарами) схлопываются до сверки.
  const valid = collapseExactDuplicates(parsedItems);
  const items = toPriceItems(valid, { supplierId, date: deps.clock.now().toISOString() });
  const allIssues = reconcileScriptItems({
    rawCount: params.raw.length,
    parsed: { items: valid, invalid, textTrimmed: [] },
    items,
    sourceRows: countSourceDataRows(parsed.tables),
    sourceUnits: countSourceItemUnits(parsed.tables),
    sourceTables: parsed.tables,
    sourceTableNames: parsed.tableNames,
    sourceFileName: source.name,
  });
  const strict = params.strict === true;
  const issues = strict ? allIssues : allIssues.filter((i) => HARD_RECONCILE_CODES.has(i.code));
  if (issues.length > 0) return { accepted: false, issues, count: items.length };
  // Негодные позиции исключены ещё при разборе контракта: если не осталось ни одной, писать нечего.
  if (items.length === 0) {
    const empty = { code: 'no_items', message: 'Не осталось позиций, пригодных к записи.' };
    return { accepted: false, issues: [empty, ...allIssues], count: 0 };
  }
  // Дубль ключа с другой ценой: остаётся первое вхождение, выбирать цену за сотрудника нельзя.
  const seenKeys = new Set<string>();
  const kept = allIssues.some((i) => i.code === 'duplicate_keys')
    ? items.filter((item) => {
        const key = priceItemKey(item);
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      })
    : items;
  const warnings = [
    ...issuesToWarnings(allIssues),
    ...((parsedTrimmed.length > 0)
      ? [`Слишком длинный текст обрезан до ${TEXT_MAX_CHARS} знаков у позиций: ` +
        `${parsedTrimmed.join(', ')}.`]
      : []),
    ...((tiersDropped ?? 0) > 0
      ? [`Тиражей больше ${MAX_PRICE_TIERS}: у позиций оставлены первые ${MAX_PRICE_TIERS}, ` +
        `отброшено тиражей: ${tiersDropped}.`]
      : []),
  ];
  const importId = stagingImportId(supplierId, source.price.hash);
  const before = await deps.staging.load(importId);
  if (before !== null) await deps.staging.discard(importId);
  await deps.staging.append(
    importId,
    { supplierId, fileHash: source.price.hash },
    {
      key: `script:${stableHash(params.code)}`,
      table: SCRIPT_STAGING_TABLE,
      // Число строк исходника сверил `reconcileScriptItems`: здесь равно числу позиций.
      tableRows: kept.length,
      items: kept,
      skippedRows: 0,
      truncated: parsed.truncated,
    },
    deps.clock.now(),
  );
  await recordSource(deps, importId, source.price.path, { ...source.price.meta, viaScript: true });
  const subject = workSubject.import(source.price.hash);
  await recordWorkOwner(deps.state, subject, params.context, deps.log);
  await recordDiskSyncOutcome(deps, params.context.threadId, { viaScript: true });
  const version =
    params.createdBy === null ? null : await rememberScript(deps, params, params.createdBy, importId);
  const withVariants = valid.filter((item: ScriptPriceItem) => (item.variant ?? '') !== '');
  deps.dataScriptLog?.(SCRIPT_STAGED_EVENT, {
    agent: params.context.agentId,
    staged: kept.length,
  });
  return {
    accepted: true,
    staged: kept.length,
    summary: {
      accepted: true,
      supplierId,
      fileHash: source.price.hash,
      importId,
      staged: kept.length,
      withTiers: kept.filter((item) => item.priceTiers !== undefined).length,
      withVariants: withVariants.length,
      // Валюту скрипт не назвал: взята по умолчанию, сотруднику об этом надо сказать.
      currencyAssumed: valid.filter((item) => item.currency === undefined).length,
      truncated: parsed.truncated,
      scriptVersion: version,
      sample: sampleOf(kept),
      ...(params.withDiff && before !== null
        ? { diff: diffSummary(before.items, kept) }
        : {}),
      ...(warnings.length === 0 ? {} : { warnings }),
      next:
        'Покажи сотруднику сводку и список warnings (если есть), затем ' +
        'commitPriceImport(supplierId, fileHash).',
    },
  };
}

/** Итог попытки сохранённого скрипта. */
export type SavedScriptOutcome =
  | { status: 'none' }
  | { status: 'applied'; staged: number; version: number }
  | { status: 'failed'; code: string };

/**
 * Следующий прайс той же формы: СНАЧАЛА сохранённый скрипт, без модели. Запускается в песочнице
 * напрямую из ядра с теми же проверками (контракт, сверка, staging). Не подошёл (ошибка
 * скрипта, не прошёл сверку) - `failed`, вызывающий продолжает обычным путём.
 */
export async function runSavedScript(
  deps: PricesDeps,
  supplierId: string,
  source: PriceDataScriptSource,
  context: ToolContext,
): Promise<SavedScriptOutcome> {
  if (deps.scriptSandbox === undefined || deps.priceScripts === undefined) {
    return { status: 'none' };
  }
  const parsed = await source.parse();
  if (parsed.needsOcr) return { status: 'none' };
  const formHash = tableFormFingerprint(parsed.tables);
  const saved = await deps.priceScripts.findLatest(supplierId, formHash);
  if (saved === null) return { status: 'none' };
  // Версию, которую фиксация импорта ещё не подтвердила, сама не запускаем.
  if (await isUnconfirmed(deps, supplierId, formHash, saved.version)) return { status: 'none' };
  const sandbox = requirePort(deps.scriptSandbox, 'песочница скриптов');
  const startedAt = performance.now();
  const outcome = await sandbox.run(
    buildScriptRequest({
      agentId: context.agentId,
      threadId: context.threadId,
      code: saved.code,
      parsed,
      bytes: await readScriptFile(source),
      resultKind: 'price_items',
    }),
    context.signal === undefined ? {} : { signal: context.signal },
  );
  const note = (result: string): void => {
    deps.dataScriptLog?.(SAVED_SCRIPT_EVENT, {
      agent: context.agentId,
      outcome: result,
      version: saved.version,
      duration_ms: Math.round(performance.now() - startedAt),
    });
  };
  if (!outcome.ok) {
    note(outcome.error.code);
    return { status: 'failed', code: outcome.error.code };
  }
  const raw = Array.isArray(outcome.result) ? outcome.result : [];
  const staged = await stageScriptItems(deps, {
    supplierId,
    source,
    parsed,
    code: saved.code,
    raw,
    context,
    createdBy: null,
    withDiff: false,
    // Без сотрудника замечание сверки не предупреждение: сохранённый скрипт не подошёл.
    strict: true,
  });
  if (!staged.accepted) {
    note(staged.issues[0]?.code ?? 'reconcile_failed');
    return { status: 'failed', code: staged.issues[0]?.code ?? 'reconcile_failed' };
  }
  note('ok');
  return { status: 'applied', staged: staged.staged, version: saved.version };
}
