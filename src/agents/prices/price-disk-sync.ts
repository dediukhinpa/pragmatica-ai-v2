import { z } from 'zod';
import type { FileEntry, Scheduler, WorkflowStateStore } from '@business-ai/core';
import { baseName, failureName, readState, stableHash, writeState } from '@business-ai/core';
import { listAllSuppliers } from '../shared/supplier-email-index';
import { PRICES_AGENT_ID, responsibleThread, type PricesDeps } from './deps';
import {
  loadDiskSyncOutcomes,
  queueDiskSyncOutcome,
  recordDiskSyncOutcome,
} from './disk-sync-outcome';
import { buildInitialImportSummary, pendingOutcomes } from './initial-import-summary';
import { requireState } from './price-state';
import { fileRefOf } from './file-ref';
import { resolveDiskFileSupplier, type DiskFileSupplier } from './disk-sync-supplier';
import { supplierAskThreads } from './disk-sync-ask-recipient';
import { readSupplierAnswer, readSupplierAsk, writeSupplierAsk } from './disk-sync-pending';
import { createAutoSupplierCard } from '../suppliers/draft-card';
import type { Supplier } from '../../kit/domain/models';
import { selectImportablePriceFiles } from './stale-price-files';

/**
 * Синхронизация цен с диска (решение владельца 26.10.2026: диск - источник правды). Плановая
 * задача смотрит изменения файлов на диске и на каждый новый или изменённый прайс ставит запуск
 * агента прайсов с прямым поручением импортировать этот файл. Колонки сопоставляет агент, с
 * теми же проверками записи; поставщика определяет КОД тика (этап 145, `disk-sync-supplier`):
 * нашёл - поручение с его id, надёжное название - код заводит новую карточку,
 * иначе вопрос сотруднику.
 */

/** Как часто смотреть изменения на диске. */
/** Минут между проверками диска. */
const PRICE_DISK_SYNC_INTERVAL_MINUTES = 10;
const MS_PER_MINUTE = 60_000;
export const PRICE_DISK_SYNC_INTERVAL_MS = PRICE_DISK_SYNC_INTERVAL_MINUTES * MS_PER_MINUTE;
/** Сколько файлов ставить в работу за один тик; остальные - в следующих тиках. */
export const PRICE_DISK_SYNC_MAX_FILES = 5;
/** Тип задачи запуска агента (совпадает с `AGENT_RUN_JOB` службы). */
export const PRICE_DISK_SYNC_RUN_TASK = 'agent.run';
/** Известный список файлов диска (ключ `known`). */
export const PRICE_DISK_SYNC_NAMESPACE = 'prices:disk-sync';
const KNOWN_KEY = 'known';
/** Префикс треда запуска агента на файл с диска. */
export const DISK_SYNC_THREAD_PREFIX = `${PRICES_AGENT_ID}-disk-sync-`;
/** Отметка первичного импорта (ключ в том же пространстве): запущен ли он и дочитан ли диск. */
const INITIAL_IMPORT_KEY = 'initial-import';

const knownSchema = z.object({
  entries: z.array(z.object({ path: z.string(), mtimeMs: z.number(), hash: z.string() })),
});

/**
 * Отметка первичного импорта. Появляется один раз, когда импорт включён явным флагом:
 * повторный запуск с тем же флагом ничего не сбрасывает. `scanComplete` - все существующие
 * прайсы поставлены в работу (отложенных не осталось).
 */
const markSchema = z.object({
  startedAt: z.string(),
  scanComplete: z.boolean(),
  /** Сводка ответственному отправлена (один раз за запуск). */
  summarySent: z.boolean().optional(),
});
type InitialImportMark = z.infer<typeof markSchema>;

/**
 * Отметка первичного импорта из хранилища состояния (только чтение): `null` - не запускался.
 * Нужна смете, чтобы показать, начат ли импорт.
 */
export async function initialImportState(
  state: WorkflowStateStore,
): Promise<{ startedAt: string; scanComplete: boolean } | null> {
  return readState(state, PRICE_DISK_SYNC_NAMESPACE, INITIAL_IMPORT_KEY, markSchema);
}

/** Параметры тика. */
export interface PriceDiskSyncOptions {
  /**
   * Первичный импорт существующих прайсов (`PRICE_DISK_INITIAL_IMPORT_ENABLED`). Выключен -
   * прежнее поведение: первый тик только запоминает диск. Включается явным действием
   * владельца и не запускается сам.
   */
  initialImport?: boolean | undefined;
}

/** Итог тика: только счётчики (без путей). */
export interface PriceDiskSyncResult {
  status: 'baseline' | 'synced';
  enqueued: number;
  deferred: number;
  /** Заведено новых карточек за тик (только число). */
  suppliersCreated?: number | undefined;
  /** Задано вопросов сотруднику «чей прайс» за тик (только число). */
  suppliersAsked?: number | undefined;
  /** Состояние первичного импорта; нет поля - режим выключен и не запускался. */
  initialImport?: 'running' | 'completed' | undefined;
}

/**
 * Поручение агенту: импортировать один файл с диска и записать его. Файл назван не путём, а
 * непрозрачным идентификатором: в имени бывает фамилия, путь маскируется как ПДн и возвращается
 * моделью искажённым (этап 107). Идентификатор принимают все инструменты в поле path.
 */
export function priceDiskSyncInput(
  path: string,
  fileRefSecret: string,
  supplierId?: string,
): string {
  // Поставщика определил код тика: модель его не ищет и не заводит.
  const supplier =
    supplierId === undefined
      ? 'Поставщика определи по searchSuppliers; нет в базе или неоднозначно - файл не ' +
        'записывай, сообщи reportToManager (needs_review). '
      : `Поставщик файла уже определён кодом: supplierId=${supplierId}. Записывай цены с этим ` +
        'supplierId, поставщика не ищи и новую карточку не заводи. ';
  return (
    `Плановая синхронизация цен с диска: файл ${fileRefOf(path, fileRefSecret)} на сетевом ` +
    'диске новый или изменён. Везде, где инструменты просят path, передавай этот ' +
    'идентификатор как есть, ' +
    'целиком и без изменений (это не путь, переписывать его не нужно). ' +
    'Импортируй именно этот файл в базу (readPriceFile, normalizePriceTable, savePriceImport ' +
    'или stagePriceRows + commitPriceImport) и запиши его. ' +
    supplier +
    'Если записать нельзя (needs_review, structure_changed, скан), ничего не записывай и ' +
    'сообщи reportToManager с причиной.'
  );
}

/**
 * Один тик синхронизации. Первый запуск (известного списка нет) только запоминает текущее
 * состояние диска: старые файлы не импортируются все разом. Исключение - явно включённый
 * первичный импорт: тогда «известный» список начинается пустым, и все существующие прайсы
 * (кроме исключённых областью проверки: «Архив...», «НЕ БРАТЬ», файлы-блокировки) идут через
 * ту же очередь с прежним пределом за тик; не поместившиеся откладываются на следующие тики.
 * Задача на файл идемпотентна по хэшу содержимого: тот же файл не ставится повторно.
 */
export async function runPriceDiskSync(
  deps: PricesDeps,
  scheduler: Pick<Scheduler, 'schedule'>,
  options: PriceDiskSyncOptions = {},
): Promise<PriceDiskSyncResult> {
  const state = requireState(deps);
  let stored = await readState(state, PRICE_DISK_SYNC_NAMESPACE, KNOWN_KEY, knownSchema);
  let mark = await readState(state, PRICE_DISK_SYNC_NAMESPACE, INITIAL_IMPORT_KEY, markSchema);
  if (options.initialImport === true && mark === null) {
    // Явный запуск первичного импорта: диск считается «неизвестным» целиком.
    mark = { startedAt: deps.clock.now().toISOString(), scanComplete: false };
    await writeState(state, PRICE_DISK_SYNC_NAMESPACE, INITIAL_IMPORT_KEY, mark);
    stored = { entries: [] };
    // Пустой «известный» список пишется сразу вслед за отметкой, а не только в конце тика.
    await writeState(state, PRICE_DISK_SYNC_NAMESPACE, KNOWN_KEY, stored);
  } else if (stored === null && mark !== null && !mark.scanComplete) {
    // Сбой между записью отметки и списка (или посреди тика): отметка уже стоит, а списка нет.
    // Без этой ветки следующий тик принял бы весь диск за baseline и импорт был бы потерян.
    stored = { entries: [] };
  }
  if (stored === null) {
    await writeState(state, PRICE_DISK_SYNC_NAMESPACE, KNOWN_KEY, {
      entries: await deps.files.list(),
    });
    return { status: 'baseline', enqueued: 0, deferred: 0 };
  }
  const changes = await deps.files.changesSince(stored.entries);
  const touched = changes.filter((change) => change.kind !== 'removed').map((c) => c.entry);
  const prices = await selectImportablePriceFiles(deps, touched);
  const now = deps.clock.now();
  // Итоги по файлам ведутся только пока идёт первичный импорт (до дочитывания диска).
  const trackedRun = mark !== null && !mark.scanComplete ? mark.startedAt : null;
  const tick = await resolveTickFiles(deps, prices);
  const taken = tick.taken;
  for (const { entry, supplierId, draft } of taken) {
    if (trackedRun !== null) {
      await queueDiskSyncOutcome(
        state,
        diskSyncThreadId(entry.path),
        trackedRun,
        entry.path,
        now.toISOString(),
      );
      if (draft !== undefined) {
        await recordDiskSyncOutcome(deps, diskSyncThreadId(entry.path), { draft });
      }
    }
    const payload = JSON.stringify({
      agentId: PRICES_AGENT_ID,
      threadId: diskSyncThreadId(entry.path),
      input: priceDiskSyncInput(entry.path, deps.fileRefSecret, supplierId),
    });
    await scheduler.schedule(
      PRICE_DISK_SYNC_RUN_TASK,
      payload,
      now,
      `prices-disk-sync:${entry.hash}`,
    );
  }
  // Отложенные прайсы остаются «неизвестными»: следующий тик увидит их снова.
  // Файлы в ожидании ответа сотрудника тоже остаются «неизвестными», но отложенными не
  // считаются: иначе первичный импорт не дочитывался бы, пока на вопросы не ответят.
  const deferred = new Set(tick.deferred);
  const waiting = new Set(tick.waiting);
  const known = new Map(stored.entries.map((entry): [string, FileEntry] => [entry.path, entry]));
  for (const change of changes) {
    if (change.kind === 'removed') known.delete(change.entry.path);
    else if (!deferred.has(change.entry.path) && !waiting.has(change.entry.path)) {
      known.set(change.entry.path, change.entry);
    }
  }
  await writeState(state, PRICE_DISK_SYNC_NAMESPACE, KNOWN_KEY, { entries: [...known.values()] });
  const initialImport = await advanceInitialImport(deps, mark, deferred.size);
  if (initialImport === 'completed') await sendInitialImportSummary(deps);
  return {
    status: 'synced',
    enqueued: taken.length,
    deferred: deferred.size,
    suppliersCreated: tick.created,
    suppliersAsked: tick.asked,
    ...(initialImport === undefined ? {} : { initialImport }),
  };
}

/** Файл тика с определённым кодом поставщиком. */
interface TickFile {
  entry: FileEntry;
  supplierId: string;
  /** Карточка заведена кодом в этом тике (для итогов первичного импорта). */
  draft?: { supplierId: string; name: string } | undefined;
}

/** Что решил код по подходящим файлам тика. */
interface TickFiles {
  taken: TickFile[];
  /** Сверх предела за тик: следующие тики. */
  deferred: string[];
  /** Ждут ответа сотрудника: остаются «неизвестными», пока поставщика не назовут. */
  waiting: string[];
  created: number;
  asked: number;
}

/** Происхождение новой карточки в заметке: файл заведён кодом синхронизации диска. */
const DRAFT_ORIGIN = 'синхронизация диска';

/** Текст вопроса сотруднику (собирается кодом, свободного текста модели в нём нет). */
function supplierQuestionText(path: string, candidates: readonly string[]): string {
  const options = candidates.length === 0 ? '' : ` Возможно: ${candidates.join(', ')}.`;
  return (
    `Прайс «${baseName(path)}» на диске: не удалось определить поставщика.${options} ` +
    'Напишите, чей это прайс, или назовите нового поставщика.'
  );
}

/** Решение по одному файлу: поручение, новая карточка или вопрос сотруднику. */
async function decideFile(
  deps: PricesDeps,
  suppliers: Supplier[],
  entry: FileEntry,
  result: TickFiles,
): Promise<void> {
  const state = requireState(deps);
  const decision: DiskFileSupplier = await resolveDiskFileSupplier(deps, suppliers, entry);
  if (decision.kind === 'found') {
    result.taken.push({ entry, supplierId: decision.supplierId });
    return;
  }
  if (decision.kind === 'create') {
    const card = await createAutoSupplierCard(
      deps.suppliers,
      { name: decision.name, inn: decision.inn },
      { userId: PRICES_AGENT_ID, nowIso: deps.clock.now().toISOString(), origin: DRAFT_ORIGIN },
    );
    if (card.created) {
      result.created += 1;
      suppliers.push(card.card);
    }
    result.taken.push({
      entry,
      supplierId: card.card.id,
      draft: { supplierId: card.card.id, name: card.card.name },
    });
    return;
  }
  // Адресат - сотрудник, положивший файл (этап 148): ему и отвечать за прайс.
  const threads = await supplierAskThreads(deps, entry.path);
  const text = supplierQuestionText(entry.path, decision.candidates);
  for (const threadId of threads) {
    // Ключ общего адресата прежний (вопросы этапа 145 не дублируются); личный - с тредом.
    const key =
      threadId === responsibleThread(deps)
        ? `prices-supplier-ask:${entry.hash}`
        : `prices-supplier-ask:${entry.hash}:${threadId}`;
    await deps.chat.reply(threadId, { text }, key);
  }
  // Запись о вопросе пишется ПОСЛЕ успешной отправки: при сбое отправки вопрос не теряется
  // и уйдёт в следующем тике, а дубль исключает ключ идемпотентности сообщения.
  await writeSupplierAsk(state, entry.hash, {
    path: entry.path,
    askedAt: deps.clock.now().toISOString(),
    threadIds: threads,
  });
  result.asked += 1;
  result.waiting.push(entry.path);
}

/**
 * Определить поставщика каждого подходящего файла до постановки поручения. Предел за тик
 * считается по файлам в работу и по новым вопросам сотруднику: ожидающие ответа место не занимают.
 */
async function resolveTickFiles(
  deps: PricesDeps,
  prices: readonly FileEntry[],
): Promise<TickFiles> {
  const state = requireState(deps);
  const result: TickFiles = { taken: [], deferred: [], waiting: [], created: 0, asked: 0 };
  let suppliers: Supplier[] | null = null;
  for (const entry of prices) {
    const answer = await readSupplierAnswer(state, entry.hash);
    // Вопрос уже задан: ждём ответа, файл не читаем заново и предел не расходуем.
    if (answer === null && (await readSupplierAsk(state, entry.hash)) !== null) {
      result.waiting.push(entry.path);
      continue;
    }
    // Предел считает и принятые файлы, и новые вопросы сотруднику: лишнее - в следующий тик.
    if (result.taken.length + result.asked >= PRICE_DISK_SYNC_MAX_FILES) {
      result.deferred.push(entry.path);
      continue;
    }
    if (answer !== null) {
      result.taken.push({ entry, supplierId: answer.supplierId });
      continue;
    }
    suppliers ??= await listAllSuppliers(deps.suppliers);
    try {
      await decideFile(deps, suppliers, entry, result);
    } catch (error) {
      // Сбой одного файла не должен останавливать остальные: файл остаётся «неизвестным» и
      // будет разобран в следующем тике. В журнал - только код ошибки.
      deps.log?.('price_disk_supplier_failed', { error: failureName(error) });
      result.waiting.push(entry.path);
    }
  }
  return result;
}

/** Тред запуска агента на один файл (детерминирован по пути). */
export function diskSyncThreadId(path: string): string {
  return `${DISK_SYNC_THREAD_PREFIX}${stableHash([path])}`;
}

/**
 * Сводка ответственному, когда все поставленные в работу файлы получили итог (или срок
 * ожидания итога истёк). Отправляется один раз за запуск: повтор защищён отметкой и ключом
 * идемпотентности сообщения.
 */
async function sendInitialImportSummary(deps: PricesDeps): Promise<void> {
  const state = requireState(deps);
  const mark = await readState(state, PRICE_DISK_SYNC_NAMESPACE, INITIAL_IMPORT_KEY, markSchema);
  if (mark === null || !mark.scanComplete || mark.summarySent === true) return;
  const { outcomes, truncated } = await loadDiskSyncOutcomes(state, mark.startedAt);
  if (pendingOutcomes(outcomes, deps.clock.now()) > 0) return;
  const text = buildInitialImportSummary(outcomes, truncated);
  await deps.chat.reply(
    responsibleThread(deps),
    { text },
    `prices-initial-import-summary:${mark.startedAt}`,
  );
  await writeState(state, PRICE_DISK_SYNC_NAMESPACE, INITIAL_IMPORT_KEY, {
    ...mark,
    summarySent: true,
  });
}

/** Первичный импорт дочитал диск, когда в очереди не осталось отложенных прайсов. */
async function advanceInitialImport(
  deps: PricesDeps,
  mark: InitialImportMark | null,
  deferred: number,
): Promise<'running' | 'completed' | undefined> {
  if (mark === null) return undefined;
  if (mark.scanComplete) return 'completed';
  if (deferred > 0) return 'running';
  await writeState(requireState(deps), PRICE_DISK_SYNC_NAMESPACE, INITIAL_IMPORT_KEY, {
    ...mark,
    scanComplete: true,
  });
  return 'completed';
}
