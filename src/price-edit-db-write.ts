import { z } from 'zod';
import { DomainError, defineTool, requireEmployee, stableHash } from '@business-ai/core';
import { priceFreshness } from './kit/domain/price-schedule';
import { latestPrices, priceItemKey } from './kit/domain/price-diff';
import { buildPriceMatchIndex, matchPriceItem } from './kit/domain/price-match';
import type { PriceItem } from './kit/domain/models';
import { DEFAULT_PRICE_CURRENCY, type PricesDeps } from './agents/prices/deps';
import { priceListHash } from './agents/prices/employee-updates';
import { checkImport, issuesToWarnings, limitIssues } from './agents/prices/import-checks';
import { loadPriceUpload, savePriceUpload } from './agents/prices/price-state';
import {
  EMPLOYEE_FILE_EDIT_KEY_PREFIX,
  EMPLOYEE_FILE_EDIT_SOURCE,
  employeeEditKey,
  saveEmployeeFileEdits,
  type EmployeeFileEdit,
} from './employee-file-edits';
import {
  PRICE_EDIT_FOLLOWUP_NAMESPACE,
  followupThreadOf,
  loadFollowup,
  saveFollowup,
  type FollowupChange,
} from './price-edit-followup';

/**
 * Запись в базу цен, изменённых в файле сотрудника, по его явному «да» (этап 9q, решение
 * владельца 23.11.2026). Раньше такие цены уходили предложением и в базу попадали только с диска.
 *
 * Что пишется: только позиции этой правки. Новую цену и старую берёт код из ожидания правки
 * (`getPendingPriceEdit`), а не модель: модель говорит лишь, какая позиция базы соответствует
 * строке файла. Поставщик обязателен. Прежние проверки записи цен (чужой поставщик, дубли, даты,
 * сверка с базой при записи) те же, что у обычного импорта.
 */

/** Имя инструмента. */
export const PRICE_EDIT_DB_WRITE_TOOL = 'writeEditedPricesToDb';

const matchSchema = z.object({
  /** Номер изменения в ожидании правки (changes[i] из getPendingPriceEdit), с нуля. */
  change: z.number().int().nonnegative(),
  /** Артикул позиции в базе (из ячеек строки файла). */
  sku: z.string().min(1).optional(),
  /** Название позиции (из ячеек строки файла). */
  productName: z.string().min(1).optional(),
  /** Позиции нет в базе, а сотрудник просит её добавить (только с названием). */
  addIfMissing: z.boolean().default(false),
});
type Match = z.infer<typeof matchSchema>;

const inputSchema = z.object({
  /** Поставщик из базы (searchSuppliers / lookupSupplierInBase); без него писать нельзя. */
  supplierId: z.string().min(1),
  matches: z.array(matchSchema).min(1),
});
interface WriteInput {
  supplierId: string;
  matches: Match[];
}

const appliedSchema = z.object({
  change: z.number().int(),
  productName: z.string(),
  sku: z.string().optional(),
  /** Цена в базе до записи; нет - позиция новая. */
  previousPrice: z.number().optional(),
  newPrice: z.number(),
  currency: z.string(),
  isNew: z.boolean(),
});
const questionSchema = z.object({ change: z.number().int(), code: z.string(), text: z.string() });
const outputSchema = z.object({
  status: z.enum(['written', 'nothing_written', 'blocked']),
  supplier: z.object({ id: z.string(), name: z.string() }),
  applied: z.array(appliedSchema),
  questions: z.array(questionSchema),
  /** Сколько изменений осталось в ожидании (вопросы без ответа). */
  stillPending: z.number().int(),
  warnings: z.array(z.string()),
  message: z.string(),
});
type WriteOutput = z.infer<typeof outputSchema>;
type Applied = z.infer<typeof appliedSchema>;
type Question = z.infer<typeof questionSchema>;

const NO_PENDING_MESSAGE =
  'Ожидающей правки в этом чате нет (её не было, срок вышел или вопрос уже закрыт). В базу ' +
  'ничего не записано: спроси сотрудника, какие цены он имеет в виду.';
const EMPLOYEE_ONLY_TEXT =
  'Цены в базу по правке файла записываются только по просьбе сотрудника в чате.';
/** Длина префикса отпечатка в ключе записи. */
const HASH_PREFIX_CHARS = 16;

function question(change: number, code: string, text: string): Question {
  return { change, code, text };
}

/** Преобладающая валюта прайса; null - прайс пуст. */
function dominantCurrency(items: readonly PriceItem[]): string | null {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.currency, (counts.get(item.currency) ?? 0) + 1);
  let best: string | null = null;
  for (const [code, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) best = code;
  }
  return best;
}

/** Ключ записи: тот же набор правок поверх того же прайса - та же операция. */
function writeKey(input: WriteInput): string {
  return `${EMPLOYEE_FILE_EDIT_KEY_PREFIX}:${input.supplierId}:${stableHash(input.matches)}`;
}

/** Записать цены, изменённые в файле сотрудника, в базу (только после явного «да»). */
export const writeEditedPricesToDb = defineTool<WriteInput, WriteOutput, PricesDeps>({
  name: PRICE_EDIT_DB_WRITE_TOOL,
  sideEffect: true,
  description:
    'Записать в БАЗУ цен изменённые в файле сотрудника цены - ТОЛЬКО после явного «да» ' +
    'сотрудника на вопрос «обновить цены этих позиций в базе?». Сначала getPendingPriceEdit; ' +
    'потом supplierId (поставщик обязателен: найден в базе, а если карточки нет - сначала ' +
    'предложи завести её прежним путём) и matches: для каждого изменения change (номер из ' +
    'changes), sku и/или productName позиции из ячеек строки (rowCells). Цену берёт код из ' +
    'ожидания правки, не передавай её. Пишутся только изменённые позиции; остальной прайс ' +
    'поставщика не меняется. Позиции, которых нет в базе, не добавляются, если не передать ' +
    'addIfMissing (только по просьбе сотрудника). Неоднозначные позиции возвращаются в ' +
    'questions: спроси сотрудника, не угадывай. status=blocked - проверки записи не пройдены ' +
    '(скажи причины, ничего не записано). После status=written ожидание закрывается само: ' +
    'скажи сотруднику, что цены записаны в базу (источник «сотрудник, правка файла»), и ' +
    'перечисли applied. Более поздний прайс с диска обновит эти цены как обычно, более старый ' +
    'файл с диска их не затрёт.',
  inputSchema,
  outputSchema,
  idempotencyKey: writeKey,
  // Тот же набор правок поверх другого прайса (после A -> B -> A) - новая операция.
  idempotencyPredecessor: async (input, deps) =>
    priceListHash(await deps.prices.listBySupplier(input.supplierId)),
  async execute(input, deps, context) {
    requireEmployee(context, EMPLOYEE_ONLY_TEXT);
    const threadId = await followupThreadOf(deps, context);
    if (deps.state === undefined || threadId === null) {
      throw new DomainError('conflict', NO_PENDING_MESSAGE);
    }
    const now = deps.clock.now();
    const followup = await loadFollowup(deps.state, threadId, now);
    if (followup === null) throw new DomainError('conflict', NO_PENDING_MESSAGE);
    const supplier = await deps.suppliers.get(input.supplierId);
    if (supplier === null || supplier === undefined) {
      throw new DomainError('not_found', `Поставщик ${input.supplierId} не найден в базе.`);
    }
    const supplierRef = { id: input.supplierId, name: supplier.name };
    const base = [...latestPrices(await deps.prices.listBySupplier(input.supplierId)).values()];
    const baseIndex = buildPriceMatchIndex(base);
    const nowIso = now.toISOString();
    const replaced = new Map<string, PriceItem>();
    const added: PriceItem[] = [];
    const applied: Applied[] = [];
    const questions: Question[] = [];
    const doneChanges = new Set<number>();
    const registry: Record<string, EmployeeFileEdit> = {};
    for (const match of input.matches) {
      const change: FollowupChange | undefined = followup.changes[match.change];
      if (change === undefined) {
        questions.push(question(match.change, 'no_change', 'Такого изменения в ожидании нет.'));
        continue;
      }
      if (doneChanges.has(match.change)) {
        questions.push(question(match.change, 'duplicate', 'Это изменение указано дважды.'));
        continue;
      }
      if (match.sku === undefined && match.productName === undefined) {
        questions.push(
          question(match.change, 'no_item', 'Не указана позиция: артикул или название.'),
        );
        continue;
      }
      const label = match.sku ?? match.productName ?? '';
      const found = matchPriceItem(
        base,
        { sku: match.sku, productName: match.productName },
        baseIndex,
      );
      if (found.kind === 'ambiguous') {
        questions.push(
          question(match.change, 'ambiguous_match', `По «${label}» несколько позиций: уточните.`),
        );
        continue;
      }
      let item: PriceItem;
      let previous: PriceItem | undefined;
      if (found.kind === 'match') {
        previous = found.item;
        if (previous.priceTiers !== undefined && previous.priceTiers.length > 0) {
          questions.push(
            question(
              match.change,
              'tiered_price',
              `У «${previous.productName}» цены по тиражам: одну цену сменить нельзя, ` +
                'внесите на диск.',
            ),
          );
          continue;
        }
        if (previous.price === change.newPrice && previous.priceQualifier === undefined) {
          questions.push(
            question(
              match.change,
              'same_price',
              `Цена «${previous.productName}» уже ${previous.price}.`,
            ),
          );
          continue;
        }
        const { priceQualifier: _q, priceMax: _m, ...exact } = previous;
        item = { ...exact, price: change.newPrice, date: nowIso };
      } else if (
        match.addIfMissing &&
        match.productName !== undefined &&
        found.candidates.length === 0
      ) {
        item = {
          supplierId: input.supplierId,
          productName: match.productName,
          ...(match.sku === undefined ? {} : { sku: match.sku }),
          price: change.newPrice,
          currency: dominantCurrency(base) ?? DEFAULT_PRICE_CURRENCY,
          date: nowIso,
        };
      } else {
        const similar = found.candidates.length > 0 ? ' Есть похожие позиции: сверьте.' : '';
        questions.push(
          question(
            match.change,
            'not_found',
            `Позиция «${label}» не найдена в прайсе поставщика.${similar} Новую позицию ` +
              'добавляй только по просьбе сотрудника (addIfMissing).',
          ),
        );
        continue;
      }
      const key = priceItemKey(item);
      if (replaced.has(key) || added.some((other) => priceItemKey(other) === key)) {
        questions.push(question(match.change, 'duplicate', `«${label}» указана дважды.`));
        continue;
      }
      if (previous === undefined) added.push(item);
      else replaced.set(key, item);
      doneChanges.add(match.change);
      registry[employeeEditKey(item)] = {
        editedAt: nowIso,
        fileName: followup.sourceName,
        author: threadId,
        price: item.price,
        ...(previous === undefined ? {} : { previousPrice: previous.price }),
      };
      applied.push({
        change: match.change,
        productName: item.productName,
        ...(item.sku === undefined ? {} : { sku: item.sku }),
        ...(previous === undefined ? {} : { previousPrice: previous.price }),
        newPrice: item.price,
        currency: item.currency,
        isNew: previous === undefined,
      });
    }
    const pendingAfter = followup.changes.length - doneChanges.size;
    if (applied.length === 0) {
      return {
        status: 'nothing_written' as const,
        supplier: supplierRef,
        applied,
        questions,
        stillPending: followup.changes.length,
        warnings: [],
        message:
          'В базу ничего не записано: по каждому изменению нужен ответ (questions). Задай ' +
          'сотруднику вопрос по списку; ожидание правки остаётся.',
      };
    }
    const items = [...base.map((item) => replaced.get(priceItemKey(item)) ?? item), ...added];
    const itemsHash = stableHash({ supplier: input.supplierId, items }).slice(0, HASH_PREFIX_CHARS);
    const fileHash = `emp-file-${itemsHash}`;
    const candidate = {
      supplierId: input.supplierId,
      importId: `${input.supplierId}:${fileHash}`,
      sourceRowCount: items.length,
      items,
      source: 'employee' as const,
    };
    const verdict = await checkImport(deps, candidate);
    if (verdict.issues.length > 0) {
      const issues = limitIssues(verdict.issues);
      return {
        status: 'blocked' as const,
        supplier: supplierRef,
        applied: [],
        questions,
        stillPending: followup.changes.length,
        warnings: issuesToWarnings(issues),
        message:
          'Запись в базу не прошла проверки (warnings): ничего не записано. Назови сотруднику ' +
          'причины; ожидание правки остаётся.',
      };
    }
    const dbKey = `${writeKey(input)}:base:${verdict.baseHash}`;
    await deps.prices.saveImport(input.supplierId, items, dbKey, {
      isExpectedBase: (current) => priceListHash(current) === verdict.baseHash,
    });
    // Свежесть прайса: правка словами сотрудника дату загрузки не двигает (как recordFreshness).
    if ((await loadPriceUpload(deps, input.supplierId)) === null) {
      const previousDate = priceFreshness(null, verdict.existing);
      if (previousDate !== null) await savePriceUpload(deps, input.supplierId, previousDate);
    }
    await saveEmployeeFileEdits(deps.state, input.supplierId, registry, now);
    if (pendingAfter === 0) {
      await deps.state.delete(PRICE_EDIT_FOLLOWUP_NAMESPACE, threadId);
    } else {
      await saveFollowup(deps.state, threadId, {
        ...followup,
        changes: followup.changes.filter((_, index) => !doneChanges.has(index)),
      });
    }
    return {
      status: 'written' as const,
      supplier: supplierRef,
      applied,
      questions,
      stillPending: pendingAfter,
      warnings: [],
      message:
        `Записано в базу позиций: ${applied.length} (источник «${EMPLOYEE_FILE_EDIT_SOURCE}», ` +
        `файл «${followup.sourceName}»), поставщик ${supplierRef.name}. Остальной прайс не ` +
        'менялся.' +
        (pendingAfter === 0
          ? ' Ожидание закрыто.'
          : ` Не записано (см. questions): ${pendingAfter}; ожидание остаётся.`),
    };
  },
});
