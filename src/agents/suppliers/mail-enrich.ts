import { z } from 'zod';
import { isDomainError } from '@business-ai/core';
import {
  SupplierMailInvalidAnswerError,
  type SupplierMailClassification,
  type SupplierMailClassifier,
} from '../../kit/ports/supplier-mail-classifier';
import {
  type AuditRepository,
  type Clock,
  type InboxMessage,
  type MailboxDirectory,
  type SourceMailbox,
  type WorkflowStateStore,
} from '@business-ai/core';
import { type SupplierRepository } from '../../kit/ports/repositories.owned';
import {
  failureName,
  joinKey,
  readState,
  stableHash,
  writeState,
  type FailureLog,
} from '@business-ai/core';
import type { SupplierCardFields } from './card-fields';
import {
  DomainIndex,
  FREE_MAIL_DOMAINS,
  enrichOrCreateSupplier,
  guardForeignSender,
  prepareFields,
  validInn,
  type EnrichmentFields,
  type EnrichmentOutcome,
} from './card-enrichment';
import { findEnrichmentConflicts } from './card-enrichment-conflicts';
import { isProtectedRequisite } from './card-requisites-guard';
import { type SenderEvidence, type SenderTrustBasis, type SenderTrustPolicy } from './sender-trust';
import { SUPPLIER_AUDIT_ENRICH } from './deps';
import {
  UNPARSED_SUPPLIER_ID,
  addProposals,
  cardVersionOf,
  emptyBackfillReport,
  proposalsFor,
  unparsedProposal,
  type BackfillReport,
  type UnparsedReason,
} from './mail-backfill-report';
import { extractSupplierFromText } from './extract-supplier';
import { OwnCompanyFilter } from './own-company-filter';
import { SourceMatcher, enforceSourceProvenance } from './source-provenance';

/**
 * Разовое обогащение базы поставщиков из ящика-источника (этап 220, вариант «220b»): общий
 * адрес вроде info@, куда поставщики пишут сами. Периодического опроса нет (решение владельца):
 * проход запускает вручную владелец командой `src/mail-info-backfill.ts` и читает ВСЕ письма
 * входящих постранично, без ограничения окном по дате. Классификатор (порт, модель через
 * псевдонимизацию) решает, поставщик ли пишет и есть ли в письме сведения о нём, а запись
 * делает код.
 *
 * Отправитель общего ящика не подтверждён (SPF на почтовом сервере не работает), поэтому:
 * - новых поставщиков проход заводит сам, но с пометкой в заметке (признака черновика нет) и
 *   только по корпоративному адресу, когда в тексте есть ИНН или сайт; рассылки пропускаются,
 *   предела числа создаваемых карточек нет (решение владельца 09.11.2026); в заметке карточки
 *   указано, что отправитель не подтверждён;
 * - существующие карточки проход НЕ меняет: предлагаемые изменения собираются в отчёт
 *   (`mail-backfill-report.ts`), а применяет их отдельный режим по пунктам, подтверждённым
 *   человеком (`mail-backfill-apply.ts`).
 * Каждое значение проверяется по тексту письма (`enforceSourceProvenance`) и фильтром
 * реквизитов нашей компании (`OwnCompanyFilter`); вопросов людям проход не задаёт.
 */

/**
 * Пространство курсора ящика-источника: ключ - служебное имя ящика. Курсор передвигается только
 * после полностью разобранной страницы, поэтому повторный запуск продолжает с места остановки.
 */
export const SUPPLIER_MAIL_CURSOR_NAMESPACE = 'suppliers:mail-enrich-cursor.v1';
/**
 * Пространство отметок «письмо разобрано»: ключ - хэш (ящик, id письма в ящике); в значении
 * только время и исход, без адресов, тем и текстов. Отметки в состоянии, а не в карточках:
 * письма без карточки (не поставщик, рассылка, предложение в отчёт) в карточке отметки не
 * имеют. Чистится по сроку без записи (`WORKFLOW_STATE_STALE_SCOPE`, 90 суток): разовый проход
 * рассчитан на эти сроки, позже повторный запуск разберёт письма заново (карточки при этом не
 * задвоятся: найденная по ИНН или адресу карточка даёт лишь пункт отчёта).
 */
export const SUPPLIER_MAIL_SEEN_NAMESPACE = 'suppliers:mail-enrich-seen.v1';
/**
 * Пространство счётчика повторов оценки письма: ключ - тот же хэш, в значении число попыток и
 * время. Письмо, на котором модель дала временный сбой, ждёт следующего запуска (курсор не
 * двигается), а счётчик не даёт ему держать ящик вечно.
 */
export const SUPPLIER_MAIL_RETRY_NAMESPACE = 'suppliers:mail-enrich-retry.v1';

/**
 * Окно разового прохода по умолчанию, дней (решение владельца: два года). Письма старше
 * границы не разбираются; параметр `--days` команды его меняет.
 */
export const SUPPLIER_MAIL_BACKFILL_WINDOW_DAYS = 730;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Писем за один запрос к ящику. */
const MAIL_PAGE_SIZE = 50;
/**
 * Обращений к модели за один запуск по умолчанию (аргумент команды и
 * `INFO_MAILBOX_ENRICH_MAX_CLASSIFY_PER_RUN` его переопределяют). В ящике около тысячи писем,
 * часть отсеивается без модели (рассылки, свои, системные), остальное дочитывает повторный запуск.
 */
export const SUPPLIER_MAIL_MAX_CLASSIFY_PER_RUN = 500;
/** Сколько попыток терпится неразборчивый ответ модели по одному письму (потом письмо закрыто). */
export const SUPPLIER_MAIL_INVALID_ANSWER_MAX_ATTEMPTS = 3;
/** Сколько проходов терпится временный сбой шлюза по одному письму. */
export const SUPPLIER_MAIL_TRANSIENT_MAX_ATTEMPTS = 24;
/**
 * Сколько сбоев оценки подряд (на любых письмах, без единого успеха между ними) считается
 * недоступной моделью: проход останавливается, а не закрывает письма одно за другим. Больше
 * числа попыток на письмо, чтобы одно «больное» письмо проход не останавливало.
 */
const CLASSIFIER_FAILURE_STREAK_LIMIT = SUPPLIER_MAIL_INVALID_ANSWER_MAX_ATTEMPTS + 1;
/** Сколько ждать ответа классификатора; позже письмо пропускается. */
const CLASSIFY_TIMEOUT_MS = 30_000;
/** Сколько знаков текста письма уходит модели и извлекателю (начало письма несёт суть). */
export const BODY_MAX_CHARS = 4_000;
/** Автор записей в карточках и аудите. */
const SUPPLIER_MAIL_ENRICH_AUTHOR = 'supplier-mail-enrich';
/** Имя обязанности в аудите записей карточек. */
const DUTY = 'supplier-mail-enrich';
/** Пометка в заметке новой карточки: письмо пришло от неподтверждённого отправителя. */
const UNVERIFIED_SENDER_LABEL = 'отправитель не подтверждён';
/** Подпись источника для заметки: тема письма маскируется общим кодом заметки. */
export const SUBJECT_LABEL_MAX_CHARS = 120;

/** Локальные части адресов автоматических отправителей: письма от них не разбираются. */
export const SYSTEM_SENDERS: ReadonlySet<string> = new Set([
  'mailer-daemon',
  'postmaster',
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
]);

/** Строки, с которых начинается цитата или пересланный блок: дальше текст не наш и не новый. */
const REPLY_CUT_PATTERNS: readonly RegExp[] = [
  /^\s*-{2,}.*(?:original message|исходное сообщение|пересылаемое сообщение|forwarded message)/i,
  /^\s*_{10,}\s*$/,
  /^\s*on\s.+\swrote:\s*$/i,
  /^.*\sнаписал(?:а)?:\s*$/i,
  /^.*,\s.*<[^>\s]+@[^>\s]+>:\s*$/,
];
const QUOTED_LINE = /^\s*>/;
/** Почтовый адрес и домен в тексте реквизитов (адреса вырезаются до поиска доменов). */
const EMAIL_IN_REQUISITES = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/g;
const DOMAIN_IN_REQUISITES = /[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/g;

/** Исход обработки письма в отметке. */
const seenSchema = z.object({
  at: z.string().min(1),
  outcome: z.enum([
    'created',
    'proposed',
    'enriched',
    'unchanged',
    'ambiguous',
    'no_name',
    'not_supplier',
    'not_created',
    'skipped',
  ]),
});
type SeenOutcome = z.infer<typeof seenSchema>['outcome'];

const cursorSchema = z.object({ cursor: z.string() });
const retrySchema = z.object({ attempts: z.number().int().min(1), at: z.string().min(1) });

/** Зависимости прохода. */
export interface SupplierMailEnrichDeps {
  suppliers: SupplierRepository;
  state: WorkflowStateStore;
  clock: Clock;
  classifier: SupplierMailClassifier;
  /** Каталог ящиков: берётся ящик-источник с адресом `sourceAddress`. */
  mailboxes: MailboxDirectory;
  /** Адрес ящика-источника (`INFO_MAILBOX_ENRICH_ADDRESS` или аргумент команды). */
  sourceAddress: string;
  /** Названия наших юрлиц (`OWN_COMPANY_NAMES`). */
  ownCompanyNames: readonly string[];
  /** Реквизиты наших юрлиц (`OWN_COMPANY_REQUISITES`); не заданы - fail closed. */
  ownCompanyRequisites: readonly string[];
  /** Аудит записей карточек (без значений); не задан - не пишется. */
  audit?: AuditRepository | undefined;
  /** Журнал событий: только коды и числа. */
  log?: FailureLog | undefined;
  /**
   * Уровень доверия отправителям (этап 233, `MAIL_SENDER_TRUST_ENABLED`). Не задан - как
   * раньше: существующие карточки не меняются, предложения идут в отчёт. Задан - карточка
   * доверенного отправителя дополняется (кроме реквизитов), прочие идут в отчёт.
   */
  senderTrust?: { policy: SenderTrustPolicy } | undefined;
}

/** Параметры запуска. */
export interface SupplierMailBackfillOptions {
  /**
   * Пробный запуск: карточки, отметки писем, курсор и счётчики повторов НЕ пишутся; отчёт
   * предложений по существующим карточкам заполняется (через `onReport`).
   */
  dryRun: boolean;
  /** Отчёт прежнего запуска, который продолжается; `null` - начать новый. */
  report: BackfillReport | null;
  /**
   * Вызывается после каждой страницы и при остановке, ДО записи отметок «разобрано» у писем
   * с предложениями: если отчёт не сохранился, письма разберутся заново.
   */
  onReport(report: BackfillReport): Promise<void>;
  /** Обращений к модели за запуск; не задано - `SUPPLIER_MAIL_MAX_CLASSIFY_PER_RUN`. */
  maxModelCalls?: number | undefined;
  /** Окно, дней: письма старше не разбираются; не задано - `SUPPLIER_MAIL_BACKFILL_WINDOW_DAYS`. */
  windowDays?: number | undefined;
}

/**
 * Почему проход остановился раньше конца ящика: `model_limit` - исчерпан предел обращений к
 * модели, `classifier_outage` - модель недоступна на письме.
 * Во всех случаях повторный запуск продолжает с необработанных писем.
 */
type SupplierMailStop = 'none' | 'model_limit' | 'classifier_outage';

/** Итог запуска: только счётчики (письма, адреса и названия в итог не попадают). */
export interface SupplierMailBackfillResult {
  /** `not_configured` - нет ящика-источника с таким адресом; `done` - проход был. */
  status: 'not_configured' | 'done';
  stoppedBy: SupplierMailStop;
  scanned: number;
  /** Письма без содержимого (слишком большие, не разобрались). */
  skippedOmitted: number;
  /** Автоматические отправители (почтовая система, noreply). */
  skippedSystem: number;
  /** Отправитель - наша компания (в том числе пересылка своих сотрудников). */
  skippedOwn: number;
  /** Письма-рассылки (List-Unsubscribe, Precedence: bulk): не оценивались. */
  skippedBulk: number;
  /** Письма старше окна прохода (не разбираются). */
  skippedOld: number;
  /** Письма, разобранные раньше (повторный запуск). */
  duplicates: number;
  /** Обращения к модели (успешные и нет). */
  modelCalls: number;
  /** Письма, оценённые классификатором успешно. */
  classified: number;
  /** Сбои оценки (модель, отказ защиты ПДн, неверный ответ): письмо пропущено без записи. */
  classifierFailed: number;
  /**
   * Письма, закрытые после предела попыток оценки (модель сбоила на них каждый раз): по ним
   * в отчёте пункт «не разобрано». В пробном запуске - сколько было бы закрыто.
   */
  abandoned: number;
  /** Рассылки, письма клиентов, прочее и поставщики без сведений. */
  notSupplier: number;
  /** Новые карточки. */
  created: number;
  /** Пробный запуск: сколько карточек было бы создано (без повторов одной компании). */
  wouldCreate: number;
  /** Существующие карточки, дополненные письмом доверенного отправителя (этап 233). */
  enrichedExisting: number;
  /** Письма, чьи реквизиты не применены и ушли в отчёт на подтверждение. */
  requisiteLetters: number;
  /** Письма доверенных отправителей по основаниям (только при включённой модели доверия). */
  trustedDkim: number;
  trustedCardAddress: number;
  trustedCardDomain: number;
  trustedCardWebsite: number;
  trustedReplyThread: number;
  /** Письма о существующих карточках, по которым в отчёт внесено хотя бы одно предложение. */
  proposalLetters: number;
  /** Новые пункты отчёта и новые ссылки на письма у прежних пунктов. */
  reportItems: number;
  reportReferences: number;
  /** Письмо о существующей карточке, предложений нет (всё уже записано). */
  unchanged: number;
  /** Несколько подходящих карточек или только общий домен: ничего не записано. */
  ambiguous: number;
  /** Письмо поставщика, но названия нет ни у кода, ни (проверенного) у модели. */
  noName: number;
  /** Нужной карточки нет, а создавать письмо не вправе (адрес, ИНН или сайт). */
  notCreated: number;
  /** Репозиторий отклонил значения письма. */
  rejected: number;
}

function emptyResult(status: SupplierMailBackfillResult['status']): SupplierMailBackfillResult {
  return {
    status,
    stoppedBy: 'none',
    scanned: 0,
    skippedOmitted: 0,
    skippedSystem: 0,
    skippedOwn: 0,
    skippedBulk: 0,
    skippedOld: 0,
    duplicates: 0,
    modelCalls: 0,
    classified: 0,
    classifierFailed: 0,
    abandoned: 0,
    notSupplier: 0,
    created: 0,
    wouldCreate: 0,
    enrichedExisting: 0,
    requisiteLetters: 0,
    trustedDkim: 0,
    trustedCardAddress: 0,
    trustedCardDomain: 0,
    trustedCardWebsite: 0,
    trustedReplyThread: 0,
    proposalLetters: 0,
    reportItems: 0,
    reportReferences: 0,
    unchanged: 0,
    ambiguous: 0,
    noName: 0,
    notCreated: 0,
    rejected: 0,
  };
}

/** Новый текст письма: без цитат (`>`) и всего, что идёт после пересланного блока. */
export function stripQuotedReply(body: string): string {
  const kept: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (REPLY_CUT_PATTERNS.some((pattern) => pattern.test(line))) break;
    if (!QUOTED_LINE.test(line)) kept.push(line);
  }
  return kept.join('\n').trim();
}

/** Домен адреса в нижнем регистре; пусто, если «@» нет. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1).trim().toLowerCase();
}

/** Наши адреса: корпоративные домены целиком, бесплатные адреса - только сами адреса. */
export interface OwnAddresses {
  domains: ReadonlySet<string>;
  addresses: ReadonlySet<string>;
}

/**
 * Домены и адреса нашей компании: из почты и сайтов в реквизитах, плюс адрес ящика-источника.
 * Домен бесплатной почты своим не считается (иначе любое письмо с неё отбросилось бы как наше):
 * такие адреса сравниваются целиком.
 */
export function ownAddressesOf(requisites: readonly string[], sourceAddress: string): OwnAddresses {
  const domains = new Set<string>();
  const addresses = new Set<string>();
  const add = (address: string): void => {
    const domain = domainOf(address);
    if (domain === '') return;
    if (FREE_MAIL_DOMAINS.has(domain)) addresses.add(address);
    else domains.add(domain);
  };
  add(sourceAddress.trim().toLowerCase());
  for (const item of requisites) {
    const text = item.toLowerCase();
    for (const email of text.match(EMAIL_IN_REQUISITES) ?? []) add(email);
    for (const found of text.replace(EMAIL_IN_REQUISITES, ' ').match(DOMAIN_IN_REQUISITES) ?? []) {
      if (!FREE_MAIL_DOMAINS.has(found)) domains.add(found);
    }
  }
  return { domains, addresses };
}

/** Адрес наш: корпоративный домен нашей компании или в точности наш бесплатный адрес. */
export function isOwnAddress(own: OwnAddresses, address: string): boolean {
  return own.domains.has(domainOf(address)) || own.addresses.has(address.toLowerCase());
}

/** Временный ли сбой (шлюз недоступен, таймаут): повтор позже может пройти. */
function isTransientFailure(error: unknown): boolean {
  if (isDomainError(error)) return error.retryable;
  return error instanceof Error && error.message === 'classifier_timeout';
}

/** Контекст одного запуска. */
interface RunContext {
  deps: SupplierMailEnrichDeps;
  box: SourceMailbox;
  now: Date;
  result: SupplierMailBackfillResult;
  filter: OwnCompanyFilter;
  own: OwnAddresses;
  options: SupplierMailBackfillOptions;
  /** Отчёт запуска: сюда вносятся предложения по существующим карточкам. */
  report: BackfillReport;
  /** Предел обращений к модели за запуск. */
  maxModelCalls: number;
  /** Граница окна, мс (письма раньше не разбираются). */
  sinceMs: number;
  /** Индекс доменов карточек; после создания карточки пересоздаётся. */
  domains: DomainIndex;
  /** Пробный запуск: ничего не пишется. */
  dryRun: boolean;
  /** Пробный запуск: компании, которые были бы созданы (повтор письма второй карточки не даёт). */
  wouldCreateKeys: Set<string>;
  /** Отметки писем с пунктами отчёта: пишутся после сохранения отчёта. */
  pendingMarks: Array<{ key: string; outcome: SeenOutcome }>;
  /** Сбоев оценки подряд без успеха между ними (см. `CLASSIFIER_FAILURE_STREAK_LIMIT`). */
  failureStreak: number;
}

/**
 * Обращение к классификатору под таймаутом; отмена сигнала прерывает запрос к модели. Общая
 * для разбора ящика-источника и обзора почты сотрудников (этап 222): ей нужен только порт.
 */
export async function classifyWithTimeout(
  classifier: SupplierMailClassifier,
  message: InboxMessage,
  body: string,
): Promise<SupplierMailClassification> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('classifier_timeout');
        controller.abort(error);
        reject(error);
      }, CLASSIFY_TIMEOUT_MS);
    });
    const names = [
      ...message.attachments.map((file) => file.fileName),
      ...(message.attachmentNames ?? []),
    ];
    const answer = classifier.classify(
      {
        subject: message.subject,
        body,
        attachmentNames: names,
        senderDomain: domainOf(message.from),
      },
      { signal: controller.signal },
    );
    return await Promise.race([answer, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Только слова из текста письма: категории, которых в нём нет дословно, отбрасываются. */
function groundedList(items: readonly string[], matcher: SourceMatcher): string[] {
  return items.filter((item) => matcher.text(item));
}

/**
 * Поля карточки из письма. Основа - код (`extractSupplierFromText`: почта, телефон, ИНН с
 * подписью, сайт, название с формой, ФИО подписи); название и категории модели добавляются,
 * только если встречаются в тексте. Затем каждое значение проходит проверку происхождения и
 * фильтр реквизитов нашей компании.
 */
export function fieldsOf(
  ctx: Pick<RunContext, 'own' | 'filter'>,
  message: InboxMessage,
  verdict: SupplierMailClassification,
  text: string,
): EnrichmentFields {
  const matcher = new SourceMatcher([text]);
  const extracted = extractSupplierFromText(text).fields;
  const sender = message.from.toLowerCase();
  const fields: SupplierCardFields = { ...extracted };
  // Первым в письме часто названа наша компания («Генеральному директору ООО ...»): это не
  // поставщик. Извлечённое название нашей компании отбрасывается до запасного, иначе фильтр ниже
  // удалил бы его и поставщик остался бы без названия, хотя модель его назвала.
  if (fields.name !== undefined && ctx.filter.isOwnText(fields.name)) delete fields.name;
  if (fields.name === undefined && verdict.companyName !== undefined) {
    if (matcher.text(verdict.companyName)) fields.name = verdict.companyName;
  }
  const categories = groundedList(verdict.categories, matcher);
  if (categories.length > 0) fields.categories = categories;
  const contacts = fields.contacts ?? [];
  if (!contacts.some((contact) => contact.email === sender)) contacts.push({ email: sender });
  // Адрес отправителя виден в заголовке письма, поэтому проходит проверку происхождения.
  fields.contacts = contacts.filter(
    (contact) => contact.email === undefined || !isOwnAddress(ctx.own, contact.email),
  );
  if (fields.contacts.length === 0) delete fields.contacts;
  const checked = enforceSourceProvenance(fields, [text]).fields;
  const cleaned = ctx.filter.clean({ ...checked, origin: 'email' }).fields;
  const result: EnrichmentFields = {};
  for (const [key, value] of Object.entries(cleaned)) {
    if (key !== 'origin') Reflect.set(result, key, value);
  }
  return result;
}

/**
 * Отметить письмо разобранным (после записи карточки: сбой между ними даёт повтор без дубля).
 * В пробном запуске не пишет ничего.
 */
async function markSeen(
  ctx: RunContext,
  key: string,
  outcome: SeenOutcome,
): Promise<void> {
  if (ctx.dryRun) return;
  await writeState(ctx.deps.state, SUPPLIER_MAIL_SEEN_NAMESPACE, key, {
    at: ctx.now.toISOString(),
    outcome,
  });
}

/** Запись аудита: кто, какая карточка, сколько полей; значений нет. Сбой аудита не роняет. */
async function auditWrite(
  ctx: RunContext,
  sourceKey: string,
  outcome: EnrichmentOutcome,
): Promise<void> {
  const { audit, log, clock } = ctx.deps;
  if (audit === undefined) return;
  const supplierId = outcome.supplierId ?? '';
  try {
    await audit.append(
      {
        at: clock.now().toISOString(),
        actor: SUPPLIER_MAIL_ENRICH_AUTHOR,
        agent: DUTY,
        action: SUPPLIER_AUDIT_ENRICH,
        details:
          `supplier=${supplierId} fields=${outcome.addedFields.length} ` +
          `conflicts=${outcome.conflicts.length}`,
        result: 'ok',
      },
      joinKey('suppliers-mail-enrich', sourceKey, supplierId),
    );
  } catch (error) {
    log?.('supplier_mail_enrich_audit_failed', { code: failureName(error) });
  }
}

/**
 * Что делать дальше после письма: `deferred` - оценка не удалась, письмо ждёт следующего
 * запуска (курсор стоит), `limit` - предел обращений к модели.
 */
type MessageStep = 'ok' | 'limit' | 'deferred';

/** Домен бесплатной почты или пустой: такой адрес не называет организацию. */
export function isCorporateDomain(domain: string): boolean {
  return domain !== '' && !FREE_MAIL_DOMAINS.has(domain);
}

/** Сколько попыток терпится для сбоя; null - сбой не временный (письмо не повторяется). */
export function retryLimitOf(error: unknown): number | null {
  if (error instanceof SupplierMailInvalidAnswerError) {
    return SUPPLIER_MAIL_INVALID_ANSWER_MAX_ATTEMPTS;
  }
  return isTransientFailure(error) ? SUPPLIER_MAIL_TRANSIENT_MAX_ATTEMPTS : null;
}

/**
 * Закрыть письмо, которое оценить не удалось: пункт «не разобрано» в отчёт (по причине - один
 * пункт на все такие письма) и отметка «пропущено» после сохранения отчёта. Так письмо не
 * теряется молча: владелец увидит его в отчёте и прочтёт сам.
 */
function abandonLetter(
  ctx: RunContext,
  message: InboxMessage,
  key: string,
  reason: UnparsedReason,
): void {
  ctx.result.abandoned += 1;
  ctx.deps.log?.('supplier_mail_enrich_abandoned', { reason });
  const added = addProposals(ctx.report, UNPARSED_SUPPLIER_ID, '', [unparsedProposal(reason)], {
    id: message.id,
    receivedAt: message.receivedAt,
  });
  ctx.result.reportItems += added.items;
  ctx.result.reportReferences += added.references;
  ctx.pendingMarks.push({ key, outcome: 'skipped' });
}

/**
 * Сбой шлюза (недоступен, временная ошибка): курсор не двигаем, письмо разбирается при
 * следующем запуске, а проход останавливается - дальше шлюз, скорее всего, тоже не ответит.
 * После `maxAttempts` запусков письмо закрывается (модель сбоит именно на нём). Пробный запуск
 * счётчик не пишет.
 */
async function deferLetter(
  ctx: RunContext,
  message: InboxMessage,
  key: string,
  maxAttempts: number,
): Promise<MessageStep> {
  if (ctx.dryRun) return 'deferred';
  const known = await readState(ctx.deps.state, SUPPLIER_MAIL_RETRY_NAMESPACE, key, retrySchema);
  const attempts = (known?.attempts ?? 0) + 1;
  if (attempts >= maxAttempts) {
    abandonLetter(ctx, message, key, 'gateway_failure');
    return 'ok';
  }
  await writeState(ctx.deps.state, SUPPLIER_MAIL_RETRY_NAMESPACE, key, {
    attempts,
    at: ctx.now.toISOString(),
  });
  return 'deferred';
}

/**
 * Сбой, привязанный к самому письму (неразборчивый ответ, таймаут на этом письме): причина
 * или `null`, если сбой иной. Такой сбой не значит, что модель недоступна.
 */
function letterFailureReason(error: unknown): UnparsedReason | null {
  if (error instanceof SupplierMailInvalidAnswerError) return 'invalid_answer';
  if (error instanceof Error && error.message === 'classifier_timeout') return 'timeout';
  return null;
}

/** Итог оценки письма: вердикт модели либо шаг, на котором разбор письма кончился. */
type ClassifyOutcome =
  | { kind: 'verdict'; verdict: SupplierMailClassification }
  | { kind: 'step'; step: MessageStep };

/**
 * Оценить письмо у модели. Сбой самого письма (неразборчивый или противоречивый ответ,
 * таймаут) повторяется до `SUPPLIER_MAIL_INVALID_ANSWER_MAX_ATTEMPTS` попыток, число попыток
 * хранится в состоянии (предел модели или обрыв запуска его не обнуляют); потом письмо
 * закрывается пунктом «не разобрано», и проход идёт дальше: одно письмо не держит ящик. Пробный
 * запуск ведёт счёт только в памяти, но не застревает так же. Подряд
 * `CLASSIFIER_FAILURE_STREAK_LIMIT` сбоев без успеха - модель недоступна, проход останавливается.
 */
async function classifyLetter(
  ctx: RunContext,
  message: InboxMessage,
  body: string,
  key: string,
): Promise<ClassifyOutcome> {
  const { result, deps } = ctx;
  const known = ctx.dryRun
    ? null
    : await readState(deps.state, SUPPLIER_MAIL_RETRY_NAMESPACE, key, retrySchema);
  let attempts = known?.attempts ?? 0;
  for (;;) {
    if (result.modelCalls >= ctx.maxModelCalls) {
      // Письмо не разобрано: при повторном запуске оно придёт снова и посчитается там.
      result.scanned -= 1;
      return { kind: 'step', step: 'limit' };
    }
    // Считается до обращения: сбой тоже расходует предел.
    result.modelCalls += 1;
    let reason: UnparsedReason;
    try {
      const verdict = await classifyWithTimeout(deps.classifier, message, body);
      // Сведения о поставщике у письма не-поставщика - противоречие, а не вердикт: как сбой.
      if (!verdict.hasSupplierInfo || verdict.kind === 'supplier') {
        ctx.failureStreak = 0;
        return { kind: 'verdict', verdict };
      }
      deps.log?.('supplier_mail_enrich_classify_failed', { code: 'contradictory_answer' });
      reason = 'contradictory_answer';
    } catch (error) {
      // В журнале только имя ошибки: текст ошибки мог бы нести фрагмент письма.
      deps.log?.('supplier_mail_enrich_classify_failed', { code: failureName(error) });
      const own = letterFailureReason(error);
      if (own === null) {
        result.classifierFailed += 1;
        const limit = retryLimitOf(error);
        const step = limit === null ? 'ok' : await deferLetter(ctx, message, key, limit);
        return { kind: 'step', step };
      }
      reason = own;
    }
    result.classifierFailed += 1;
    ctx.failureStreak += 1;
    attempts += 1;
    if (!ctx.dryRun) {
      await writeState(deps.state, SUPPLIER_MAIL_RETRY_NAMESPACE, key, {
        attempts,
        at: ctx.now.toISOString(),
      });
    }
    if (ctx.failureStreak >= CLASSIFIER_FAILURE_STREAK_LIMIT) {
      return { kind: 'step', step: 'deferred' };
    }
    if (attempts >= SUPPLIER_MAIL_INVALID_ANSWER_MAX_ATTEMPTS) {
      abandonLetter(ctx, message, key, reason);
      return { kind: 'step', step: 'ok' };
    }
  }
}

/** Разобрать одно письмо ящика. */
async function processMessage(ctx: RunContext, message: InboxMessage): Promise<MessageStep> {
  const { result, deps } = ctx;
  result.scanned += 1;
  const receivedMs = Date.parse(message.receivedAt);
  if (!Number.isNaN(receivedMs) && receivedMs < ctx.sinceMs) {
    // Старше окна: тело не скачивалось, отметка не ставится (повтор дёшев).
    result.skippedOld += 1;
    return 'ok';
  }
  const seenKey = stableHash([ctx.box.sourceId, message.id]);
  const seen = await readState(deps.state, SUPPLIER_MAIL_SEEN_NAMESPACE, seenKey, seenSchema);
  if (seen !== null) {
    result.duplicates += 1;
    return 'ok';
  }
  // Ящик читается предпросмотром: пометка `preview_only` при заполненном теле - обычное письмо.
  if (message.contentOmitted !== undefined && message.contentOmitted !== 'preview_only') {
    result.skippedOmitted += 1;
    await markSeen(ctx, seenKey, 'skipped');
    return 'ok';
  }
  const sender = message.from.toLowerCase();
  if (SYSTEM_SENDERS.has(sender.split('@')[0] ?? '')) {
    result.skippedSystem += 1;
    await markSeen(ctx, seenKey, 'skipped');
    return 'ok';
  }
  if (isOwnAddress(ctx.own, sender) || ctx.filter.isOwnText(sender)) {
    result.skippedOwn += 1;
    await markSeen(ctx, seenKey, 'skipped');
    return 'ok';
  }
  if (message.bulk === true) {
    result.skippedBulk += 1;
    await markSeen(ctx, seenKey, 'skipped');
    return 'ok';
  }
  return processFresh(ctx, message, seenKey);
}

/** Письмо в окне прохода, не рассылка и не своё: оценка моделью и запись. */
async function processFresh(
  ctx: RunContext,
  message: InboxMessage,
  seenKey: string,
): Promise<MessageStep> {
  const { result, deps } = ctx;
  // Один раз и до всего остального: извлекатель и модель видят один и тот же текст.
  const body = stripQuotedReply(message.body).slice(0, BODY_MAX_CHARS);
  const outcome = await classifyLetter(ctx, message, body, seenKey);
  if (outcome.kind === 'step') return outcome.step;
  const { verdict } = outcome;
  result.classified += 1;
  if (verdict.kind !== 'supplier' || !verdict.hasSupplierInfo) {
    result.notSupplier += 1;
    await markSeen(ctx, seenKey, 'not_supplier');
    return 'ok';
  }
  return enrichFromLetter(ctx, message, verdict, body, seenKey);
}

/** Подпись источника в заметке новой карточки: ящик, непроверенный отправитель, тема. */
function noteLabelOf(ctx: RunContext, subject: string): string {
  const local = ctx.deps.sourceAddress.trim().toLowerCase().split('@')[0] ?? '';
  return `${local}@, ${UNVERIFIED_SENDER_LABEL}; ${subject}`.slice(0, SUBJECT_LABEL_MAX_CHARS);
}

/**
 * Ключи компании в пробном запуске: ИНН и корпоративный домен отправителя. Настоящий проход
 * находит заведённую карточку по любому из них, поэтому письмо с известным ключом второй
 * карточки не даёт, даже если другого ключа у письма нет.
 */
function companyKeysOf(fields: EnrichmentFields, sender: string): string[] {
  const inn = validInn(fields.inn);
  const domain = domainOf(sender);
  const keys: string[] = [];
  if (inn !== undefined) keys.push(`inn:${inn}`);
  if (isCorporateDomain(domain)) keys.push(`domain:${domain}`);
  return keys;
}

/**
 * Записать сведения письма поставщика в базу. Новую карточку заводит сам код, если адрес
 * корпоративный, а в тексте есть ИНН или сайт, и не больше предела за запуск (отправитель не
 * подтверждён - это видно по заметке). Существующую карточку не меняет: предложения идут в
 * отчёт (`proposeForExisting`).
 */
async function enrichFromLetter(
  ctx: RunContext,
  message: InboxMessage,
  verdict: SupplierMailClassification,
  body: string,
  seenKey: string,
): Promise<MessageStep> {
  const { result, deps } = ctx;
  const sender = message.from.toLowerCase();
  const text = [`От: ${sender}`, `Тема: ${message.subject}`, '', body].join('\n');
  const fields = fieldsOf(ctx, message, verdict, text);
  const mayCreate =
    isCorporateDomain(domainOf(sender)) &&
    (validInn(fields.inn) !== undefined || fields.website !== undefined);
  let outcome: EnrichmentOutcome;
  try {
    outcome = await enrichOrCreateSupplier(
      { suppliers: deps.suppliers, clock: deps.clock, domains: ctx.domains },
      { key: seenKey, label: noteLabelOf(ctx, message.subject), senderKeys: [sender] },
      fields,
      {
        createIfMissing: mayCreate && !ctx.dryRun,
        origin: 'email',
        author: SUPPLIER_MAIL_ENRICH_AUTHOR,
        // Без модели доверия отправитель общего ящика не подтверждён: найденная карточка не
        // меняется (SPF на сервере неверен). С моделью (этап 233) - по DKIM и данным карточки.
        ...(deps.senderTrust === undefined
          ? { existingCards: 'review' as const }
          : {
              existingCards: 'by_trust' as const,
              trust: {
                policy: deps.senderTrust.policy,
                evidence: () => evidenceOf(ctx.box, message),
              },
              // Пробный запуск карточки не пишет, но считает, сколько было бы дополнено.
              dryRun: ctx.dryRun,
            }),
        contactDomainGuard: true,
      },
    );
  } catch (error) {
    // Репозиторий отклонил карточку целиком: повтор даст то же, письмо закрываем.
    if (!(isDomainError(error) && error.code === 'invalid_input')) throw error;
    result.rejected += 1;
    deps.log?.('supplier_mail_enrich_rejected', { code: error.code });
    await markSeen(ctx, seenKey, 'skipped');
    return 'ok';
  }
  switch (outcome.kind) {
    case 'created':
      result.created += 1;
      // Индекс доменов построен до этой карточки: без пересоздания следующее письмо её домена
      // не нашло бы карточку и завело вторую.
      ctx.domains = new DomainIndex(deps.suppliers);
      await auditWrite(ctx, seenKey, outcome);
      await markSeen(ctx, seenKey, 'created');
      return 'ok';
    case 'ambiguous':
      if (outcome.reason === 'untrusted_source' && outcome.candidateIds[0] !== undefined) {
        await proposeForExisting(ctx, message, fields, outcome.candidateIds[0], seenKey);
        return 'ok';
      }
      result.ambiguous += 1;
      await markSeen(ctx, seenKey, 'ambiguous');
      return 'ok';
    case 'not_found':
      if (fields.name === undefined) {
        result.noName += 1;
        await markSeen(ctx, seenKey, 'no_name');
        return 'ok';
      }
      // Сопоставление могло отказать само (`reason`): настоящий проход такую карточку не заведёт.
      if (mayCreate && ctx.dryRun && outcome.reason === undefined) {
        const keys = companyKeysOf(fields, sender);
        if (!keys.some((key) => ctx.wouldCreateKeys.has(key))) result.wouldCreate += 1;
        for (const key of keys) ctx.wouldCreateKeys.add(key);
        return 'ok';
      }
      result.notCreated += 1;
      await markSeen(ctx, seenKey, 'not_created');
      return 'ok';
    case 'enriched':
    case 'unchanged':
      return afterTrustedWrite(ctx, message, fields, outcome, seenKey);
  }
}

/** Счётчик итога по основанию доверия. */
const TRUST_COUNTER = {
  dkim: 'trustedDkim',
  card_address: 'trustedCardAddress',
  card_domain: 'trustedCardDomain',
  card_website: 'trustedCardWebsite',
  reply_thread: 'trustedReplyThread',
} as const satisfies Record<SenderTrustBasis, keyof SupplierMailBackfillResult>;

/** Улики о письме для модели доверия; проверка DKIM у ящика - только когда она нужна. */
async function evidenceOf(box: SourceMailbox, message: InboxMessage): Promise<SenderEvidence> {
  let dkim: Awaited<ReturnType<NonNullable<SourceMailbox['verifyDkim']>>> = null;
  try {
    dkim = message.dkim ?? (await box.verifyDkim?.(message.id)) ?? null;
  } catch {
    // Сбой чтения письма: доверия по DKIM нет, прочие основания остаются.
  }
  return {
    dkimAligned: dkim === 'aligned',
    replyToOurs: message.inReplyTo !== undefined,
  };
}

/**
 * Итог письма, найденная карточка которого могла быть записана (модель доверия включена):
 * счётчики по основаниям, аудит записи и - при реквизитах письма - пункты на подтверждение.
 */
async function afterTrustedWrite(
  ctx: RunContext,
  message: InboxMessage,
  fields: EnrichmentFields,
  outcome: EnrichmentOutcome,
  seenKey: string,
): Promise<MessageStep> {
  const { result } = ctx;
  if (outcome.trustBasis !== undefined) result[TRUST_COUNTER[outcome.trustBasis]] += 1;
  if (outcome.kind === 'enriched') {
    result.enrichedExisting += 1;
    if (!ctx.dryRun) await auditWrite(ctx, seenKey, outcome);
  }
  if (outcome.requisiteChanges.length > 0 && outcome.supplierId !== null) {
    // Реквизиты письма не применены ни при каком доверии: на подтверждение человеку.
    result.requisiteLetters += 1;
    ctx.deps.log?.('supplier_mail_requisites_withheld', {
      fields: outcome.requisiteChanges.length,
    });
    const only: EnrichmentFields = {};
    for (const [key, value] of Object.entries(fields)) {
      if (isProtectedRequisite(key)) Reflect.set(only, key, value);
    }
    await proposeForExisting(ctx, message, only, outcome.supplierId, seenKey);
    return 'ok';
  }
  if (outcome.kind === 'enriched') {
    await markSeen(ctx, seenKey, 'enriched');
    return 'ok';
  }
  result.unchanged += 1;
  await markSeen(ctx, seenKey, 'unchanged');
  return 'ok';
}

/**
 * Предложения по существующей карточке: что письмо добавило бы (пустые поля, новые контакты и
 * элементы списков) и чем расходится с записанным. В карточку ничего не пишется - пункты идут
 * в отчёт; отметка «разобрано» ставится после его сохранения (`flushReport`).
 */
async function proposeForExisting(
  ctx: RunContext,
  message: InboxMessage,
  fields: EnrichmentFields,
  supplierId: string,
  seenKey: string,
): Promise<void> {
  const { result, deps } = ctx;
  const current = await deps.suppliers.getCard(supplierId);
  if (current === null) {
    result.unchanged += 1;
    await markSeen(ctx, seenKey, 'unchanged');
    return;
  }
  const context = { userId: SUPPLIER_MAIL_ENRICH_AUTHOR, nowIso: ctx.now.toISOString() };
  // Те же подготовка и защита от чужого отправителя, что у записи, - но результат не пишется.
  const prepared = prepareFields(fields, context).fields;
  const guarded = guardForeignSender(current, prepared, [message.from.toLowerCase()]);
  const conflicts = [...findEnrichmentConflicts(current, guarded.fields), ...guarded.conflicts];
  const proposals = proposalsFor(current, guarded.fields, conflicts, context);
  if (proposals.length === 0) {
    result.unchanged += 1;
    await markSeen(ctx, seenKey, 'unchanged');
    return;
  }
  const added = addProposals(
    ctx.report,
    supplierId,
    cardVersionOf(current),
    proposals,
    { id: message.id, receivedAt: message.receivedAt },
  );
  result.proposalLetters += 1;
  result.reportItems += added.items;
  result.reportReferences += added.references;
  ctx.pendingMarks.push({ key: seenKey, outcome: 'proposed' });
}

/**
 * Сохранить отчёт и только затем отметить письма с предложениями разобранными: если файл не
 * записался, письма разберутся заново, а не потеряются.
 */
async function flushReport(ctx: RunContext): Promise<void> {
  if (ctx.pendingMarks.length === 0) return;
  const { report } = ctx;
  report.updatedAt = ctx.deps.clock.now().toISOString();
  await ctx.options.onReport(report);
  for (const mark of ctx.pendingMarks.splice(0)) await markSeen(ctx, mark.key, mark.outcome);
}

/**
 * Просмотреть ящик постранично с самого первого письма; курсор сохраняется после каждой
 * полностью разобранной страницы (в пробном запуске не пишется).
 */
async function scanSource(ctx: RunContext): Promise<SupplierMailStop> {
  const { deps, box } = ctx;
  const saved = await readState(
    deps.state,
    SUPPLIER_MAIL_CURSOR_NAMESPACE,
    box.sourceId,
    cursorSchema,
  );
  let cursor = saved?.cursor ?? '';
  try {
    for (;;) {
      // Тело читается у писем любых отправителей: писать в общий ящик может кто угодно. Это
      // предпросмотр (тема и начало текста, без вложений). Окна по дате нет, а `fromStart`
      // нужен, потому что ящик читается с точки подключения, а не с первого письма.
      const page = await box.fetchNew(cursor, MAIL_PAGE_SIZE, {
        anySender: true,
        preview: true,
        fromStart: true,
        // Старые письма приходят без тела (дёшево): граница окна прохода.
        receivedSince: new Date(ctx.sinceMs).toISOString(),
      });
      for (const message of page.messages) {
        const step = await processMessage(ctx, message);
        if (step === 'limit') return 'model_limit';
        if (step === 'deferred') return 'classifier_outage';
      }
      const moved = page.nextCursor !== cursor;
      cursor = page.nextCursor;
      await flushReport(ctx);
      if (!ctx.dryRun) {
        await writeState(deps.state, SUPPLIER_MAIL_CURSOR_NAMESPACE, box.sourceId, { cursor });
      }
      // Конец ящика - только курсор, который не сдвинулся. Пустая страница при сдвинутом курсоре
      // - дыра в нумерации: адаптер за проход смотрит не больше `MAX_UID_SPAN_PER_PASS` UID
      // (удалённые письма, спам, перенос в папки), и ящик за дырой ещё не прочитан. Короткая
      // страница концом тоже не считается: адаптер ограничивает проход и мог отдать меньше.
      if (!moved) return 'none';
    }
  } finally {
    // Остановка посреди страницы: письма с предложениями, уже попавшие в отчёт, не теряются.
    await flushReport(ctx);
  }
}

/** Ящик-источник с адресом из настройки (без учёта регистра); null - такого нет. */
function findSource(deps: SupplierMailEnrichDeps): SourceMailbox | null {
  const wanted = deps.sourceAddress.trim().toLowerCase();
  const sources = deps.mailboxes.sourceMailboxes?.() ?? [];
  return sources.find((box) => box.address.toLowerCase() === wanted) ?? null;
}

/**
 * Разовый проход по ВСЕМ письмам ящика-источника (см. описание модуля). Повторный запуск
 * продолжает с необработанных писем: разобранные закрыты отметками, курсор стоит на странице
 * остановки. Остановка по пределу обращений к модели или созданий - штатная: итог и отчёт
 * сохраняются, `stoppedBy` говорит, что запуск нужно повторить. Постоянный отказ защиты ПДн
 * пропускает письмо без записи. Ошибка записи в базу или отчёт пробрасывается.
 * @throws Error `backfill_report_mailbox_mismatch` - отчёт относится к другому ящику.
 */
export async function runSupplierMailBackfill(
  deps: SupplierMailEnrichDeps,
  options: SupplierMailBackfillOptions,
): Promise<SupplierMailBackfillResult> {
  const box = findSource(deps);
  if (box === null) return emptyResult('not_configured');
  const now = deps.clock.now();
  const report = options.report ?? emptyBackfillReport(box.sourceId, now.toISOString());
  if (report.mailbox !== box.sourceId) throw new Error('backfill_report_mailbox_mismatch');
  const result = emptyResult('done');
  const ctx: RunContext = {
    deps,
    box,
    now,
    result,
    filter: new OwnCompanyFilter(deps.ownCompanyNames, deps.ownCompanyRequisites),
    own: ownAddressesOf(deps.ownCompanyRequisites, deps.sourceAddress),
    options,
    report,
    maxModelCalls: options.maxModelCalls ?? SUPPLIER_MAIL_MAX_CLASSIFY_PER_RUN,
    sinceMs:
      now.getTime() - (options.windowDays ?? SUPPLIER_MAIL_BACKFILL_WINDOW_DAYS) * MS_PER_DAY,
    domains: new DomainIndex(deps.suppliers),
    dryRun: options.dryRun,
    wouldCreateKeys: new Set<string>(),
    pendingMarks: [],
    failureStreak: 0,
  };
  result.stoppedBy = await scanSource(ctx);
  report.run = {
    at: now.toISOString(),
    dryRun: options.dryRun,
    stoppedBy: result.stoppedBy,
    scanned: result.scanned,
    modelCalls: result.modelCalls,
  };
  report.updatedAt = deps.clock.now().toISOString();
  await options.onReport(report);
  return result;
}
