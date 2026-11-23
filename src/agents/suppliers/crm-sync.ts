import { z } from 'zod';
import { ExternalAccessDeniedError, isDomainError } from '@business-ai/core';
import type { AuditRepository, Clock, WorkflowStateStore } from '@business-ai/core';
import type {
  CrmSupplierCompany,
  CrmSuppliers,
  CrmSuppliersCursor,
  CrmSuppliersPage,
} from '../../kit/ports/crm-suppliers';
import type { SupplierRepository } from '../../kit/ports/repositories.owned';
import { failureName, joinKey, readState, writeState, type FailureLog } from '@business-ai/core';
import {
  DomainIndex,
  enrichOrCreateSupplier,
  type EnrichmentFields,
  type EnrichmentOutcome,
} from './card-enrichment';
import { fieldsOf, ownMailDomains } from './crm-sync-fields';
import { SUPPLIER_AUDIT_ENRICH } from './deps';
import { OwnCompanyFilter } from './own-company-filter';

/**
 * Разовый проход по компаниям Bitrix24 CRM (этапы 221/243): компании с признаком «поставщик»
 * (Клиенты -> Компании, воронка «Поставщики» ИЛИ тип «поставщик») создают и дополняют карточки
 * базы. Расписания НЕТ: проход запускает владелец вручную командой `src/crm-suppliers-sync.ts`
 * (обёртка `deploy/scripts/crm-suppliers-sync.sh`), реестр поставщиков в CRM не ведётся.
 * Компании читаются порциями с паузой между запросами к порталу, запись делает код через
 * `enrichOrCreateSupplier`: сопоставление по ИНН, почте, домену, названию, новые карточки
 * сразу боевые (этап 240), у существующих заполняются только пустые поля, расхождения не
 * перезаписывают, а считаются. Модель не участвует.
 *
 * CRM - внутренний источник, доверенный в части происхождения значений (проверки «значение
 * дословно есть в тексте» нет: текста нет). Остаются проверки, не зависящие от доверия: ИНН
 * с верной контрольной суммой (иначе сверка по ИНН не нужна и значение отбрасывается) и фильтр
 * реквизитов нашей компании (`OwnCompanyFilter`): компания CRM, совпавшая с нашей по названию,
 * ИНН или ОГРН, целиком пропускается - в CRM нашу фирму могли завести с типом «поставщик».
 * КПП в признак не входит: он принадлежит филиалу и бывает общим у разных юрлиц, совпавший КПП
 * только не записывается. Почта на нашем домене отбрасывается, соцсети в сайт не пишутся.
 *
 * Что такое «поставщик»: объединение признаков. Порт CRM отдаёт по проходу на признак
 * (`CrmSuppliers.passes`); проходы идут по очереди. Компания из двух множеств отдаётся первым
 * проходом, а в рамках одного запуска разбор повторно не идёт, даже если порт отдал её дважды
 * (`seen`); более свежая версия разбирается заново.
 *
 * Повторный запуск без дублей: курсор живёт только в памяти запуска (каждый запуск читает с
 * начала), а запись идемпотентна - связь «компания -> карточка», ключ источника заметки и
 * сопоставление не дают второй карточки и второй заметки. `--dry-run` ничего не пишет.
 */

/**
 * Связь «компания CRM -> карточка поставщика»: ключ - id компании, значение - id карточки.
 * Без неё переименование компании в CRM (ИНН в CRM нет) дало бы вторую карточку. Не входит в
 * `WORKFLOW_STATE_STALE_SCOPE`: записей не больше числа компаний-поставщиков в CRM, а потеря
 * связи ведёт к дублю.
 */
export const SUPPLIER_CRM_LINK_NAMESPACE = 'suppliers:crm-link.v1';
/**
 * Устаревшее пространство суточного счётчика (до этапа 243): новый код его не пишет, имя нужно
 * ретенции состояния, чтобы старые записи ушли по сроку.
 */
export const SUPPLIER_CRM_QUOTA_NAMESPACE = 'suppliers:crm-sync-quota.v1';
/** Размер порции чтения портала по умолчанию (одна страница запроса к CRM). */
export const SUPPLIER_CRM_PAGE_SIZE = 50;
/** Пауза между порциями по умолчанию, мс: Bitrix24 ограничивает частоту запросов. */
export const SUPPLIER_CRM_PAUSE_MS = 1_000;
const MS_PER_MINUTE = 60_000;
/** Бюджет чтения одной порции с портала. */
const READ_BUDGET_MS = 5 * MS_PER_MINUTE;
/** Бюджет обработки одной порции компаний (отсчёт - от конца чтения). */
const PROCESS_BUDGET_MS = 5 * MS_PER_MINUTE;
/** Автор записей в карточках и аудите. */
const SUPPLIER_CRM_SYNC_AUTHOR = 'supplier-crm-sync';
/** Имя обязанности в аудите. */
const DUTY = 'supplier-crm-sync';
/** Подпись источника для заметки: без названия компании и её id (ИП называют по ФИО). */
const SOURCE_LABEL = 'компания поставщика';
/** Префикс ключа источника: по нему заметка идемпотентна. */
const SOURCE_KEY_PREFIX = 'crm:';
/**
 * Поля, совпадение которых с нашими реквизитами означает «это наша компания». КПП нет: он
 * принадлежит филиалу и бывает общим у разных юрлиц, по нему чужого поставщика не отбрасывают.
 */
const OWN_IDENTITY_FIELDS: readonly string[] = ['name', 'inn', 'ogrn'];

const linkSchema = z.object({ supplierId: z.string().min(1), at: z.string().min(1) });

/** Зависимости задачи. */
export interface SupplierCrmSyncDeps {
  suppliers: SupplierRepository;
  state: WorkflowStateStore;
  clock: Clock;
  crm: CrmSuppliers;
  /** Названия наших юрлиц (`OWN_COMPANY_NAMES`). */
  ownCompanyNames: readonly string[];
  /** Реквизиты наших юрлиц (`OWN_COMPANY_REQUISITES`); не заданы - fail closed. */
  ownCompanyRequisites: readonly string[];
  /** Аудит записей карточек (без значений); не задан - не пишется. */
  audit?: AuditRepository | undefined;
  /** Журнал событий: только коды и числа. */
  log?: FailureLog | undefined;
  /** Пауза между порциями (подмена в тестах); не задана - настоящий таймер. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** Параметры прохода. */
export interface SupplierCrmSyncOptions {
  /** Пробный режим: сопоставление и счётчики те же, но карточки, связи и аудит не пишутся. */
  dryRun?: boolean | undefined;
  /** Сколько новых компаний разобрать за запуск; не задано - без предела (до конца списка). */
  maxCompanies?: number | undefined;
  /** Размер порции чтения портала; не задано - `SUPPLIER_CRM_PAGE_SIZE`. */
  pageSize?: number | undefined;
  /** Пауза между порциями, мс; не задано - `SUPPLIER_CRM_PAUSE_MS`. */
  pauseMs?: number | undefined;
}

/**
 * Почему проход остановился до конца списка: `limit` - разобрано `maxCompanies`, `budget` -
 * вышло время порции или чтение не двигается вперёд, `access_denied` - у вебхука нет прав на
 * CRM. Повторный запуск безопасен (запись идемпотентна) и читает список с начала.
 */
type SupplierCrmStop = 'none' | 'limit' | 'budget' | 'access_denied';

/** Итог прохода: только счётчики (названия, ИНН и контакты в итог не попадают). */
export interface SupplierCrmSyncResult {
  /** Пробный запуск: ничего не записано, `created` и `enriched` - «было бы». */
  dryRun: boolean;
  stoppedBy: SupplierCrmStop;
  /** Id компаний CRM, которые решает человек (двусмысленно, расхождение ИНН, отклонено). */
  needsReview: string[];
  /** Проходы чтения (признаки «поставщик») через `+`: `category-8+companyType-SUPPLIER`. */
  passes: string;
  /** Компании, разобранные в этом запуске (считаются в `maxCompanies`). */
  scanned: number;
  /** Компании из запаса по времени перед курсором: разобраны повторно, в предел не входят. */
  replayed: number;
  /** Строки списка без признака «поставщик» (портал проигнорировал фильтр). */
  markerMismatch: number;
  created: number;
  enriched: number;
  unchanged: number;
  /** Несколько подходящих карточек или только общий домен: ничего не записано. */
  ambiguous: number;
  /** Компания совпала с нашей (название, ИНН, КПП, ОГРН): пропущена целиком. */
  skippedOwn: number;
  /** Нет названия: карточку не завести. */
  noName: number;
  /** Репозиторий отклонил значения компании. */
  rejected: number;
  /** Связанная карточка пропала: связь снята, компания сопоставлена заново. */
  linkReset: number;
  /** Связанная карточка с другим ИНН: ничего не записано, решает человек. */
  linkMismatch: number;
  /** Значения CRM, расходящиеся с заполненным полем карточки: не записаны. */
  conflicts: number;
  /** Компания, уже разобранная в этом запуске по другому признаку: повторно не разбиралась. */
  duplicates: number;
}

function emptyResult(dryRun: boolean, passes: readonly string[]): SupplierCrmSyncResult {
  return {
    dryRun,
    needsReview: [],
    stoppedBy: 'none',
    passes: passes.join('+'),
    scanned: 0,
    replayed: 0,
    markerMismatch: 0,
    created: 0,
    enriched: 0,
    unchanged: 0,
    ambiguous: 0,
    skippedOwn: 0,
    noName: 0,
    rejected: 0,
    linkReset: 0,
    linkMismatch: 0,
    conflicts: 0,
    duplicates: 0,
  };
}

/** Состояние одного прохода. */
interface RunContext {
  deps: SupplierCrmSyncDeps;
  now: Date;
  dryRun: boolean;
  result: SupplierCrmSyncResult;
  filter: OwnCompanyFilter;
  domains: DomainIndex;
  /** Корпоративные домены нашей почты: адреса на них не берутся. */
  ownDomains: ReadonlySet<string>;
  /** Проход, который читается сейчас, и его курсор (только в памяти, двигается вперёд). */
  pass: string;
  cursor: CrmSuppliersCursor | null;
  /**
   * Компании, уже разобранные в этом запуске (по любому проходу), и время изменения разобранной
   * версии: более свежую версию той же компании разбирают заново.
   */
  seen: Map<string, number>;
  /** Пробный запуск: ключи (ИНН, название) карточек, которые были бы заведены. */
  wouldCreate: Set<string>;
}

/** Запись аудита: кто, какая карточка, сколько полей; значений нет. Сбой аудита не роняет. */
async function auditWrite(
  ctx: RunContext,
  company: CrmSupplierCompany,
  outcome: EnrichmentOutcome,
): Promise<void> {
  const { audit, log, clock } = ctx.deps;
  if (audit === undefined || ctx.dryRun) return;
  const supplierId = outcome.supplierId ?? '';
  try {
    await audit.append(
      {
        at: clock.now().toISOString(),
        actor: SUPPLIER_CRM_SYNC_AUTHOR,
        agent: DUTY,
        action: SUPPLIER_AUDIT_ENRICH,
        details:
          `supplier=${supplierId} fields=${outcome.addedFields.length} ` +
          `conflicts=${outcome.conflicts.length}`,
        result: 'ok',
      },
      joinKey('suppliers-crm-sync', company.id, supplierId),
    );
  } catch (error) {
    log?.('supplier_crm_sync_audit_failed', { code: failureName(error) });
  }
}

/** Связать компанию CRM с карточкой (если связь уже такая, запись не повторяется). */
async function linkCompany(
  ctx: RunContext,
  companyId: string,
  supplierId: string,
  known: string | null,
): Promise<void> {
  if (known === supplierId || ctx.dryRun) return;
  await writeState(ctx.deps.state, SUPPLIER_CRM_LINK_NAMESPACE, companyId, {
    supplierId,
    at: ctx.now.toISOString(),
  });
}

/** Записать компанию в карточку; повторяет сопоставление без связи, если карточка пропала. */
async function enrichCompany(
  ctx: RunContext,
  company: CrmSupplierCompany,
  fields: EnrichmentFields,
  linked: string | null,
): Promise<EnrichmentOutcome> {
  const { deps } = ctx;
  const run = (supplierId: string | null): Promise<EnrichmentOutcome> =>
    enrichOrCreateSupplier(
      { suppliers: deps.suppliers, clock: deps.clock, domains: ctx.domains },
      {
        key: `${SOURCE_KEY_PREFIX}${company.id}`,
        label: SOURCE_LABEL,
        ...(supplierId === null ? {} : { supplierId }),
      },
      fields,
      {
        // Пробный запуск карточек не заводит: «было бы создано» считается ниже по ключам.
        createIfMissing: !ctx.dryRun,
        origin: 'crm',
        author: SUPPLIER_CRM_SYNC_AUTHOR,
        existingCards: 'enrich',
        ...(ctx.dryRun ? { dryRun: true } : {}),
      },
    );
  const outcome = await run(linked);
  if (linked !== null && outcome.kind === 'not_found' && outcome.reason === 'supplier_missing') {
    // Карточку удалили: связь устарела, компания сопоставляется как новая (без дубля по ИНН).
    ctx.result.linkReset += 1;
    if (!ctx.dryRun) await deps.state.delete(SUPPLIER_CRM_LINK_NAMESPACE, company.id);
    return run(null);
  }
  return outcome;
}

/**
 * Занести в индекс доменов карточку, созданную или дополненную в этом проходе. Индекс строится
 * один раз; без этой записи следующая компания с тем же доменом не нашла бы только что
 * созданную карточку и завела вторую, а пересборка индекса после каждой карточки читала бы
 * всю базу заново.
 */
async function refreshDomains(ctx: RunContext, outcome: EnrichmentOutcome): Promise<void> {
  if (outcome.supplierId === null || ctx.dryRun) return;
  const summary = await ctx.deps.suppliers.get(outcome.supplierId);
  if (summary !== null) ctx.domains.add(summary);
}

/** Разобрать одну компанию CRM. */
async function processCompany(ctx: RunContext, company: CrmSupplierCompany): Promise<void> {
  const { result, deps } = ctx;
  if (company.replayed === true) result.replayed += 1;
  else result.scanned += 1;
  const cleaned = ctx.filter.clean({ ...fieldsOf(company, ctx.ownDomains), origin: 'document' });
  if (cleaned.dropped.some((field) => OWN_IDENTITY_FIELDS.includes(field))) {
    result.skippedOwn += 1;
    return;
  }
  // Пометка происхождения нужна фильтру, а не узлу обогащения (у него свой `origin`).
  const { origin: _filterOrigin, ...fields } = cleaned.fields;
  const known = await readState(deps.state, SUPPLIER_CRM_LINK_NAMESPACE, company.id, linkSchema);
  let outcome: EnrichmentOutcome;
  try {
    outcome = await enrichCompany(ctx, company, fields, known?.supplierId ?? null);
  } catch (error) {
    // Репозиторий отклонил карточку целиком: повтор даст то же, компанию пропускаем.
    if (!(isDomainError(error) && error.code === 'invalid_input')) throw error;
    result.rejected += 1;
    result.needsReview.push(company.id);
    deps.log?.('supplier_crm_sync_rejected', { code: error.code });
    return;
  }
  result.conflicts += outcome.conflicts.length;
  switch (outcome.kind) {
    case 'created':
      result.created += 1;
      await refreshDomains(ctx, outcome);
      await auditWrite(ctx, company, outcome);
      break;
    case 'enriched':
      result.enriched += 1;
      // Дополнение могло дать карточке основной адрес почты - новый домен для сопоставления.
      await refreshDomains(ctx, outcome);
      await auditWrite(ctx, company, outcome);
      break;
    case 'unchanged':
      result.unchanged += 1;
      break;
    case 'ambiguous':
      result.ambiguous += 1;
      result.needsReview.push(company.id);
      return;
    case 'not_found':
      if (outcome.reason === 'supplier_inn_mismatch' || outcome.reason === 'inn_of_other_card') {
        result.linkMismatch += 1;
        result.needsReview.push(company.id);
        // Расхождение решает человек: в журнал идут только id карточки и компании, без значений.
        deps.log?.('supplier_crm_sync_link_mismatch', {
          supplierId: known?.supplierId ?? '',
          companyId: company.id,
        });
      } else if (ctx.dryRun && outcome.reason === undefined && fields.name !== undefined) {
        countWouldCreate(ctx, fields);
      } else {
        result.noName += 1;
      }
      return;
  }
  if (outcome.supplierId !== null) {
    await linkCompany(ctx, company.id, outcome.supplierId, known?.supplierId ?? null);
  }
}

/**
 * Пробный запуск: карточки нет и она была бы заведена. Вторая компания с тем же ИНН или названием
 * в настоящем проходе нашла бы уже заведённую карточку и дополнила её, поэтому считается так же.
 */
function countWouldCreate(
  ctx: RunContext,
  fields: { name?: string | undefined; inn?: string | undefined },
): void {
  const keys = [fields.inn, fields.name?.trim().toLowerCase()].filter(
    (key): key is string => key !== undefined && key !== '',
  );
  if (keys.some((key) => ctx.wouldCreate.has(key))) ctx.result.enriched += 1;
  else ctx.result.created += 1;
  for (const key of keys) ctx.wouldCreate.add(key);
}

/** Позиция `left` в порядке курсора позже `right` (время изменения, затем числовой id). */
function isLater(left: CrmSuppliersCursor, right: CrmSuppliersCursor | null): boolean {
  if (right === null) return true;
  const byTime = Date.parse(left.modifiedAt) - Date.parse(right.modifiedAt);
  return byTime > 0 || (byTime === 0 && Number(left.id) > Number(right.id));
}

/** Сдвинуть курсор вперёд (в памяти запуска): следующая порция читает то, что за ним. */
function advanceCursor(ctx: RunContext, to: CrmSuppliersCursor): void {
  if (!isLater(to, ctx.cursor)) return;
  ctx.cursor = { modifiedAt: to.modifiedAt, id: to.id };
}

/**
 * Не стал ли фильтр признака «поставщик» пустым звуком: портал, не знающий ключ фильтра,
 * отдаёт все компании (адаптер их отбрасывает и считает), а первый проход без единой компании
 * значит, что признак настроен неверно. Событие - предупреждение владельцу, только числа.
 */
function reportFilterSuspicion(
  ctx: RunContext,
  page: CrmSuppliersPage,
  firstPass: boolean,
): void {
  const { pass } = ctx;
  if (page.markerMismatch > 0) {
    ctx.deps.log?.('supplier_crm_sync_filter_suspect', {
      reason: 'marker_mismatch',
      count: page.markerMismatch,
      pass,
    });
  } else if (firstPass && page.companies.length === 0 && page.viewedUntil === null) {
    // Проход, чьи компании целиком отданы другим проходом, строки всё же просматривает
    // (`viewedUntil`): это не пустой признак.
    ctx.deps.log?.('supplier_crm_sync_filter_suspect', {
      reason: 'empty_first_pass',
      count: 0,
      pass,
    });
  }
}

/**
 * Прочитать и разобрать один проход (признак «поставщик»). Курсор прохода лежит в `ctx.cursor`.
 * Возвращает, есть ли за порцией ещё компании. Остановка по бюджету времени - `ctx.result`.
 */
async function readPass(ctx: RunContext, limit: number): Promise<boolean> {
  const { deps, result } = ctx;
  const saved = ctx.cursor;
  const page = await deps.crm.listSupplierCompanies({
    pass: ctx.pass,
    after: saved,
    limit,
    signal: AbortSignal.timeout(READ_BUDGET_MS),
  });
  result.markerMismatch += page.markerMismatch;
  reportFilterSuspicion(ctx, page, saved === null);
  // Бюджет обработки считается от конца чтения: долгий портал не должен его съедать.
  const processingDeadline = deps.clock.now().getTime() + PROCESS_BUDGET_MS;
  for (const company of page.companies) {
    if (deps.clock.now().getTime() >= processingDeadline) {
      result.stoppedBy = 'budget';
      break;
    }
    const seenAt = ctx.seen.get(company.id);
    const modifiedAt = Date.parse(company.modifiedAt);
    if (seenAt === undefined) {
      ctx.seen.set(company.id, modifiedAt);
      await processCompany(ctx, company);
    } else if (modifiedAt > seenAt) {
      // Пока шёл разбор, компанию изменили (например, вывели из воронки первого прохода и
      // добавили почту): прочитанная версия свежее разобранной, и если пропустить её, курсор
      // уйдёт за компанию, а правка не будет прочитана до полной перечитки. Версия уже
      // прочитана в этом запуске, поэтому предел на неё не тратится (как на повтор по запасу).
      ctx.seen.set(company.id, modifiedAt);
      await processCompany(ctx, { ...company, replayed: true });
    } else {
      // Компания подходит под несколько признаков и эта версия уже разобрана: курсор проходит
      // мимо неё.
      result.duplicates += 1;
    }
    // Повторно читаемые компании курсор не двигают: он и так за ними.
    if (company.replayed !== true) advanceCursor(ctx, company);
  }
  // Чужие строки после последней компании (портал не применил фильтр) пройдены: без этого
  // каждый проход начинал бы чтение с одного и того же места.
  if (result.stoppedBy === 'none' && page.viewedUntil !== null) {
    advanceCursor(ctx, page.viewedUntil);
  }
  return page.hasMore;
}

/** Пауза между порциями: подмена из зависимостей либо настоящий таймер. */
function pause(deps: SupplierCrmSyncDeps, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (deps.sleep !== undefined) return deps.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Позиции курсоров совпадают (чтение не сдвинулось). */
function sameCursor(left: CrmSuppliersCursor | null, right: CrmSuppliersCursor | null): boolean {
  if (left === null || right === null) return left === right;
  return left.modifiedAt === right.modifiedAt && left.id === right.id;
}

/**
 * Разовый проход по компаниям CRM (этап 243): все проходы чтения по очереди, порциями
 * (`pageSize`) с паузой (`pauseMs`) между запросами к порталу, до конца списка либо до
 * `maxCompanies`. Расписания и суточного предела нет; курсор только в памяти запуска, поэтому
 * повторный запуск читает список с начала, а запись идемпотентна (дублей карточек и заметок нет).
 * Нет прав вебхука на CRM - остановка `access_denied` без падения; временный сбой портала
 * пробрасывается вызывающему.
 */
export async function runSupplierCrmPass(
  deps: SupplierCrmSyncDeps,
  options: SupplierCrmSyncOptions = {},
): Promise<SupplierCrmSyncResult> {
  const dryRun = options.dryRun === true;
  const result = emptyResult(dryRun, deps.crm.passes);
  const pageSize = options.pageSize ?? SUPPLIER_CRM_PAGE_SIZE;
  const pauseMs = options.pauseMs ?? SUPPLIER_CRM_PAUSE_MS;
  const ctx: RunContext = {
    deps,
    now: deps.clock.now(),
    dryRun,
    result,
    filter: new OwnCompanyFilter(deps.ownCompanyNames, deps.ownCompanyRequisites),
    domains: new DomainIndex(deps.suppliers),
    ownDomains: ownMailDomains(deps.ownCompanyRequisites),
    pass: '',
    cursor: null,
    seen: new Map(),
    wouldCreate: new Set(),
  };
  try {
    for (const pass of deps.crm.passes) {
      ctx.pass = pass;
      ctx.cursor = null;
      for (;;) {
        const remaining =
          options.maxCompanies === undefined ? pageSize : options.maxCompanies - result.scanned;
        if (remaining <= 0) {
          result.stoppedBy = 'limit';
          return result;
        }
        const before = ctx.cursor;
        const hasMore = await readPass(ctx, Math.min(pageSize, remaining));
        if (result.stoppedBy !== 'none') return result;
        if (!hasMore) break;
        // Порция есть, а чтение не сдвинулось: иначе цикл не кончился бы никогда.
        if (sameCursor(before, ctx.cursor)) {
          result.stoppedBy = 'budget';
          return result;
        }
        await pause(deps, pauseMs);
      }
    }
  } catch (error) {
    if (!(error instanceof ExternalAccessDeniedError)) throw error;
    result.stoppedBy = 'access_denied';
    deps.log?.('supplier_crm_sync_access_denied', {});
  }
  return result;
}
