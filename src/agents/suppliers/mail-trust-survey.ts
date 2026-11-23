import { normalizeEmail } from '../../kit/domain/supplier-card';
import {
  DKIM_RESULTS,
  type Clock,
  type DkimResult,
  type InboxMessage,
  type InboxSource,
  type MailboxDirectory,
} from '@business-ai/core';
import { type SupplierRepository } from '../../kit/ports/repositories.owned';
import type { FailureLog } from '@business-ai/core';
import { emailDomain } from './mail-domains';
import { SYSTEM_SENDERS, isOwnAddress, ownAddressesOf, type OwnAddresses } from './mail-enrich';
import {
  SENDER_TRUST_BASES,
  cardSenderView,
  senderTrustBases,
  type CardSenderView,
  type SenderTrustBasis,
} from './sender-trust';

/**
 * Обследование доверия к отправителям почты (этап 233), разовая команда ТОЛЬКО ДЛЯ ЧТЕНИЯ: по
 * ящикам-источникам (info@) и ящикам сотрудников за окно считает, сколько писем были бы
 * доверенными по каждому основанию. Нужно до включения модели доверия: цифры решают, включать
 * ли два ослабления (`websiteDomain`, `replyThread`).
 *
 * Письма делятся на непересекающиеся классы (ревью 233): рассылки, системные и свои отсеиваются;
 * из остальных «письма поставщиков» - те, чей отправитель (точный адрес либо корпоративный домен,
 * публичные почтовики по домену не считаются) есть в карточке поставщика (источник тот же, что у
 * 220b и 221: база карточек, в которую 221 вносит и компании CRM); прочее - «неизвестные
 * отправители» (новые поставщики, банки, госорганы, частные лица, спам без заголовков рассылки).
 * Проценты для решения владельца считаются по каждому классу отдельно.
 *
 * Читаются только заголовки (письма отдаются без тела), страницами по `PAGE_SIZE`, от новых к
 * старым: при пределе пропадают самые старые письма окна, а не свежие. История не копится в
 * памяти. Письмо целиком скачивается лишь затем, чтобы проверить подпись DKIM у писем
 * поставщиков и неизвестных, и сразу забывается. Флаги на сервере не меняются, в базу и файлы
 * ничего не пишется. В итоге только агрегаты: ни адресов, ни тем, ни имён.
 */

/** Окно обследования по умолчанию: два года. */
export const MAIL_TRUST_SURVEY_WINDOW_DAYS = 730;
/** Писем за одно чтение страницы заголовков. */
const PAGE_SIZE = 200;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60_000;
/**
 * Граница, заведомо позже любого письма: с ней адаптер отдаёт каждое письмо одними
 * заголовками (тело старше границы не скачивается), а окно по дате обследование режет само.
 */
const HEADERS_ONLY_BOUNDARY = '9999-12-31T00:00:00.000Z';

/** Какие ящики обходить. */
export type SurveyScope = 'all' | 'sources' | 'employees';
type SurveyGroupName = 'sources' | 'employees';
/** Чем упёрлись в предел. */
type SurveyLimit = 'messages' | 'time';

export interface MailTrustSurveyDeps {
  /** Только чтение: обход карточек, записи нет. */
  suppliers: Pick<SupplierRepository, 'listPage' | 'getCards'>;
  mailboxes: MailboxDirectory;
  clock: Clock;
  /** Реквизиты нашей компании: по ним узнаются свои адреса и домены. */
  ownCompanyRequisites: readonly string[];
  /** Адрес ящика-источника; не задан - все ящики-источники. */
  sourceAddress?: string | undefined;
  /** Монотонное время в мс для предела по времени (подмена в тестах). */
  timeMs?: (() => number) | undefined;
  /** Журнал: только классы событий, без адресов. */
  log?: FailureLog | undefined;
}

export interface MailTrustSurveyOptions {
  windowDays: number;
  /** Предел числа писем в окне на один ящик; дальше ящик не читается. */
  maxMessagesPerMailbox: number;
  /** Предел времени на один ящик, минут. */
  maxMinutesPerMailbox: number;
  scope: SurveyScope;
}

/** Письма класса по доверию (взаимоисключающие корзины, по приоритету оснований). */
interface SurveyTrustBuckets {
  dkim: number;
  cardAddress: number;
  cardDomain: number;
  unverified: number;
}

/** Сколько непроверенных писем стали бы доверенными при каждом из двух ослаблений. */
interface SurveyHypothetical {
  cardWebsite: number;
  replyThread: number;
  either: number;
}

type SurveyDkimCounts = Record<DkimResult | 'unchecked', number>;

/** Числа одного класса писем («письма поставщиков» или «неизвестные отправители»). */
interface SurveyClassStats {
  /** Писем класса. */
  count: number;
  trust: SurveyTrustBuckets;
  /** Справочно: DKIM выровнен и при этом отправитель известен по карточке. */
  dkimAndCard: number;
  hypothetical: SurveyHypothetical;
  dkimResults: SurveyDkimCounts;
  /** Справка: сервер сообщил `pass`. Основанием доверия не является. */
  serverPass: number;
}

interface MailTrustSurveyGroup {
  group: SurveyGroupName;
  /** Ящиков в группе / из них не прочитано из-за сбоя. */
  mailboxes: number;
  failedMailboxes: number;
  /**
   * Запрошенное окно и фактически покрытое, дни: при пределе - «последние N дней» (от самого
   * раннего прочитанного письма до сегодня, наименьшее по ящикам с пределом).
   */
  windowDays: number;
  coveredDays: number;
  /**
   * Возраст самого раннего письма окна, дни (наибольший по ящикам); null - писем нет. Нужен,
   * когда ящик целиком прочитан, но моложе окна: иначе «730 дней» звучало бы как охват.
   */
  oldestDays: number | null;
  /** Чем упёрлись в предел (null - прочитали окно целиком) и в скольких ящиках. */
  limited: SurveyLimit | null;
  limitedMailboxes: number;
  /** Писем в окне всего и по видам. */
  total: number;
  newsletters: number;
  system: number;
  own: number;
  unreadable: number;
  /** Письма поставщиков: адрес или корпоративный домен отправителя есть в карточке. */
  supplier: SurveyClassStats;
  /** Прочие не-рассылки и не свои: отправителя нет в карточках. */
  unknown: SurveyClassStats;
}

export interface MailTrustSurveyResult {
  groups: MailTrustSurveyGroup[];
}

function emptyGroup(
  group: SurveyGroupName,
  mailboxes: number,
  windowDays: number,
): MailTrustSurveyGroup {
  return {
    group,
    mailboxes,
    failedMailboxes: 0,
    windowDays,
    coveredDays: windowDays,
    oldestDays: null,
    limited: null,
    limitedMailboxes: 0,
    total: 0,
    newsletters: 0,
    system: 0,
    own: 0,
    unreadable: 0,
    supplier: emptyClass(),
    unknown: emptyClass(),
  };
}

function emptyClass(): SurveyClassStats {
  const dkimResults = { unchecked: 0 } as SurveyDkimCounts;
  for (const name of DKIM_RESULTS) dkimResults[name] = 0;
  return {
    count: 0,
    trust: { dkim: 0, cardAddress: 0, cardDomain: 0, unverified: 0 },
    dkimAndCard: 0,
    hypothetical: { cardWebsite: 0, replyThread: 0, either: 0 },
    dkimResults,
    serverPass: 0,
  };
}

/** Две последние метки домена: корзина кандидатов (точное родство решает `sender-trust`). */
function bucketOf(domain: string): string {
  return domain.split('.').slice(-2).join('.');
}

/** Индекс карточек: по точному адресу и по корзине домена (почта и сайт). */
class CardIndex {
  private readonly byAddress = new Map<string, CardSenderView[]>();
  private readonly byBucket = new Map<string, CardSenderView[]>();

  add(view: CardSenderView): void {
    for (const address of view.addresses) this.push(this.byAddress, address, view);
    const domains = new Set(view.emailDomains);
    if (view.websiteHost !== '') domains.add(view.websiteHost);
    for (const domain of domains) this.push(this.byBucket, bucketOf(domain), view);
  }

  /** Карточки, которые могут быть связаны с отправителем. */
  candidates(address: string): CardSenderView[] {
    const found = new Set<CardSenderView>(this.byAddress.get(address) ?? []);
    const domain = emailDomain(address);
    if (domain === '') return [...found];
    for (const view of this.byBucket.get(bucketOf(domain)) ?? []) found.add(view);
    return [...found];
  }

  private push(map: Map<string, CardSenderView[]>, key: string, view: CardSenderView): void {
    const list = map.get(key);
    if (list === undefined) map.set(key, [view]);
    else list.push(view);
  }
}

/** Индекс по всем карточкам базы (чтение страницами). */
async function buildIndex(suppliers: MailTrustSurveyDeps['suppliers']): Promise<CardIndex> {
  const index = new CardIndex();
  let after: string | null = null;
  for (;;) {
    const page: Awaited<ReturnType<typeof suppliers.listPage>> = await suppliers.listPage(
      after,
      PAGE_SIZE,
    );
    const last = page[page.length - 1];
    if (last === undefined) return index;
    for (const card of await suppliers.getCards(page.map((item) => item.id))) {
      index.add(cardSenderView(card));
    }
    after = last.id;
  }
}

/** Состояние обхода одного ящика. */
interface BoxProgress {
  /** Дата самого раннего из прочитанных писем окна, мс; null - ни одного. */
  oldestMs: number | null;
  limited: SurveyLimit | null;
}

interface SurveyContext {
  deps: MailTrustSurveyDeps;
  options: MailTrustSurveyOptions;
  index: CardIndex;
  own: OwnAddresses;
  sinceMs: number;
  nowMs: number;
}

/** Итог DKIM письма: готовый из письма либо проверка по требованию; сбой - «не проверено». */
async function dkimOf(box: InboxSource, message: InboxMessage): Promise<DkimResult | null> {
  if (message.dkim !== undefined) return message.dkim;
  try {
    return (await box.verifyDkim?.(message.id)) ?? null;
  } catch {
    return null;
  }
}

/** Учесть одно письмо окна в агрегатах группы. */
async function tally(
  ctx: SurveyContext,
  box: InboxSource,
  message: InboxMessage,
  group: MailTrustSurveyGroup,
): Promise<void> {
  group.total += 1;
  if (message.contentOmitted === 'parse_failed' || message.from === '') {
    group.unreadable += 1;
    return;
  }
  const sender = normalizeEmail(message.from);
  if (SYSTEM_SENDERS.has(sender.split('@')[0] ?? '')) {
    group.system += 1;
    return;
  }
  if (isOwnAddress(ctx.own, sender)) {
    group.own += 1;
    return;
  }
  if (message.bulk === true) {
    group.newsletters += 1;
    return;
  }
  const dkim = await dkimOf(box, message);
  // Основания по всем связанным карточкам и без карточки; флаги ослаблений тут не нужны:
  // замер показывает, что добавило бы каждое основание. Ответ почтового сервера основанием не
  // является и в расчёт доверия не входит.
  const evidence = {
    dkimAligned: dkim === 'aligned',
    replyToOurs: message.inReplyTo !== undefined,
  };
  const bases = new Set<SenderTrustBasis>(senderTrustBases(sender, evidence, null));
  for (const view of ctx.index.candidates(sender)) {
    for (const basis of senderTrustBases(sender, evidence, view)) bases.add(basis);
  }
  const known = bases.has('card_address') || bases.has('card_domain');
  const stats = known ? group.supplier : group.unknown;
  stats.count += 1;
  stats.dkimResults[dkim ?? 'unchecked'] += 1;
  if (message.serverAuth === 'verified') stats.serverPass += 1;
  if (bases.has('dkim') && known) stats.dkimAndCard += 1;
  const strict = SENDER_TRUST_BASES.find(
    (basis) => bases.has(basis) && basis !== 'card_website' && basis !== 'reply_thread',
  );
  switch (strict) {
    case 'dkim':
      stats.trust.dkim += 1;
      return;
    case 'card_address':
      stats.trust.cardAddress += 1;
      return;
    case 'card_domain':
      stats.trust.cardDomain += 1;
      return;
    default:
      stats.trust.unverified += 1;
  }
  const website = bases.has('card_website');
  const reply = bases.has('reply_thread');
  if (website) stats.hypothetical.cardWebsite += 1;
  if (reply) stats.hypothetical.replyThread += 1;
  if (website || reply) stats.hypothetical.either += 1;
}

/**
 * Обойти один ящик страницами заголовков от новых писем к старым; предел числа писем и времени.
 * Страница, где все письма старше окна, конец обхода: дальше только более старые.
 */
async function surveyMailbox(
  ctx: SurveyContext,
  box: InboxSource,
  group: MailTrustSurveyGroup,
): Promise<BoxProgress> {
  const now = ctx.deps.timeMs ?? Date.now;
  const deadline = now() + ctx.options.maxMinutesPerMailbox * MS_PER_MINUTE;
  const progress: BoxProgress = { oldestMs: null, limited: null };
  let counted = 0;
  let cursor = '';
  for (;;) {
    const page = await box.fetchNew(cursor, PAGE_SIZE, {
      anySender: true,
      newestFirst: true,
      receivedSince: HEADERS_ONLY_BOUNDARY,
    });
    let older = 0;
    for (const message of page.messages) {
      if (now() >= deadline) {
        progress.limited = 'time';
        return progress;
      }
      const receivedMs = Date.parse(message.receivedAt);
      if (!Number.isNaN(receivedMs) && receivedMs < ctx.sinceMs) {
        older += 1;
        continue;
      }
      if (counted >= ctx.options.maxMessagesPerMailbox) {
        progress.limited = 'messages';
        return progress;
      }
      await tally(ctx, box, message, group);
      counted += 1;
      if (!Number.isNaN(receivedMs)) {
        progress.oldestMs = Math.min(progress.oldestMs ?? receivedMs, receivedMs);
      }
    }
    if (page.messages.length > 0 && older === page.messages.length) return progress;
    // Конец ящика - курсор, который не сдвинулся: пустая страница при сдвинутом курсоре
    // означает дыру в нумерации UID, за ней ещё есть письма.
    if (page.nextCursor === cursor) return progress;
    cursor = page.nextCursor;
  }
}

/** Свёртка итогов ящика в группу: покрытие «последние N дней» и причина предела. */
function foldProgress(
  ctx: SurveyContext,
  group: MailTrustSurveyGroup,
  progress: BoxProgress,
): void {
  if (progress.oldestMs !== null) {
    const age = Math.floor((ctx.nowMs - progress.oldestMs) / MS_PER_DAY);
    group.oldestDays = Math.max(group.oldestDays ?? 0, age);
  }
  if (progress.limited === null) return;
  group.limitedMailboxes += 1;
  // Если упёрлись в разных местах, названа первая причина: она одна на строку вывода.
  group.limited ??= progress.limited;
  const covered =
    progress.oldestMs === null ? 0 : Math.floor((ctx.nowMs - progress.oldestMs) / MS_PER_DAY);
  group.coveredDays = Math.min(group.coveredDays, Math.max(0, covered));
}

/** Обойти ящики группы; сбой одного ящика не останавливает остальные. */
async function surveyGroup(
  ctx: SurveyContext,
  group: MailTrustSurveyGroup,
  open: ReadonlyArray<() => Promise<InboxSource>>,
): Promise<MailTrustSurveyGroup> {
  for (const connect of open) {
    try {
      const box = await connect();
      foldProgress(ctx, group, await surveyMailbox(ctx, box, group));
    } catch {
      group.failedMailboxes += 1;
      // Без адреса и текста ошибки: она могла нести имя ящика.
      ctx.deps.log?.('mail_trust_survey_mailbox_failed', { group: group.group });
    }
  }
  return group;
}

/**
 * Провести обследование. Только чтение: письма не помечаются, база не пишется.
 * @returns агрегаты по группам «ящики-источники» и «ящики сотрудников»
 */
export async function runMailTrustSurvey(
  deps: MailTrustSurveyDeps,
  options: MailTrustSurveyOptions,
): Promise<MailTrustSurveyResult> {
  const nowMs = deps.clock.now().getTime();
  const wantedAddress = deps.sourceAddress?.trim().toLowerCase();
  const ctx: SurveyContext = {
    deps,
    options,
    index: await buildIndex(deps.suppliers),
    own: ownAddressesOf(deps.ownCompanyRequisites, deps.sourceAddress ?? ''),
    sinceMs: nowMs - options.windowDays * MS_PER_DAY,
    nowMs,
  };
  const groups: MailTrustSurveyGroup[] = [];
  if (options.scope !== 'employees') {
    const found = (deps.mailboxes.sourceMailboxes?.() ?? []).filter(
      (box) => wantedAddress === undefined || box.address.toLowerCase() === wantedAddress,
    );
    if (found.length > 0 || options.scope === 'sources') {
      const group = emptyGroup('sources', found.length, options.windowDays);
      groups.push(await surveyGroup(ctx, group, found.map((box) => async () => box)));
    }
  }
  if (options.scope !== 'sources') {
    const ids = deps.mailboxes.employeeIds?.() ?? [];
    if (ids.length > 0 || options.scope === 'employees') {
      const group = emptyGroup('employees', ids.length, options.windowDays);
      const open = ids.map((id) => () => deps.mailboxes.forEmployee(id));
      groups.push(await surveyGroup(ctx, group, open));
    }
  }
  return { groups };
}

// ------------------------------------------------------------------ вывод

const GROUP_TITLES: Record<SurveyGroupName, string> = {
  sources: 'Ящики-источники (общие адреса)',
  employees: 'Ящики сотрудников',
};

/** «1 день», «2 дня», «5 дней». */
function pluralDays(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return `${count} дней`;
  if (ones === 1) return `${count} день`;
  if (ones >= 2 && ones <= 4) return `${count} дня`;
  return `${count} дней`;
}

function share(part: number, whole: number): string {
  if (whole === 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

function count(part: number, whole: number): string {
  return `${part} (${share(part, whole)})`;
}

const LIMIT_TEXT: Record<SurveyLimit, string> = {
  messages: 'по числу писем',
  time: 'по времени',
};

/** Строка о фактическом окне; при пределе названо «последние N дней из M». */
function windowLine(group: MailTrustSurveyGroup): string {
  if (group.limited === null) {
    const younger =
      group.oldestDays !== null && group.oldestDays < group.windowDays
        ? `; самое раннее письмо ${pluralDays(group.oldestDays)} назад`
        : '';
    return `Окно: ${pluralDays(group.windowDays)}, прочитано целиком${younger}`;
  }
  return (
    `Окно: последние ${pluralDays(group.coveredDays)} из ${group.windowDays}, упёрлись в ` +
    `предел (${LIMIT_TEXT[group.limited]}; ящиков с пределом: ${group.limitedMailboxes}); ` +
    'читалось от новых писем к старым'
  );
}

/** Строки одного класса: корзины доверия, ослабления, итоги DKIM. */
function classLines(title: string, stats: SurveyClassStats, total: number): string[] {
  const { trust, hypothetical, dkimResults } = stats;
  const whole = stats.count;
  const unverified = trust.unverified;
  return [
    `  ${title}: ${count(whole, total)}`,
    '    по доверию (корзины не пересекаются), доли от класса:',
    `      доверенные по DKIM: ${count(trust.dkim, whole)}`,
    `      доверенные по адресу карточки: ${count(trust.cardAddress, whole)}`,
    `      доверенные по домену карточки: ${count(trust.cardDomain, whole)}`,
    `      непроверенные: ${count(trust.unverified, whole)}`,
    `    справочно: DKIM выровнен и отправитель известен по карточке: ${stats.dkimAndCard}`,
    `    справка: почтовый сервер сообщил pass (основанием не является): ${stats.serverPass}`,
    '    если включить ослабления, из непроверенных стали бы доверенными:',
    '      домен отправителя = домен сайта карточки: ' +
      count(hypothetical.cardWebsite, unverified),
    `      ответ в тред нашего исходящего: ${count(hypothetical.replyThread, unverified)}`,
    `      любое из двух: ${count(hypothetical.either, unverified)}`,
    '    итоги DKIM: ' +
      [...DKIM_RESULTS, 'unchecked' as const]
        .map((name) => `${name === 'unchecked' ? 'не проверено' : name} ${dkimResults[name]}`)
        .join(', '),
  ];
}

function groupLines(group: MailTrustSurveyGroup): string[] {
  const read = group.mailboxes - group.failedMailboxes;
  const failed =
    group.failedMailboxes > 0 ? `, не прочитано из-за сбоя: ${group.failedMailboxes}` : '';
  return [
    `${GROUP_TITLES[group.group]}: ${pluralDays(group.coveredDays)}` +
      `${group.limited === null ? '' : ', упёрлись в предел'}`,
    `  ${windowLine(group)}`,
    `  Ящиков: ${group.mailboxes}, прочитано: ${read}${failed}`,
    `  Всего писем в окне: ${group.total}`,
    `  Рассылки и системные: ${count(group.newsletters + group.system, group.total)} ` +
      `(рассылки ${group.newsletters}, системные ${group.system})`,
    `  Собственные: ${group.own}; не разобрано: ${group.unreadable}`,
    ...classLines('Письма поставщиков (отправитель есть в карточке)', group.supplier, group.total),
    ...classLines('Неизвестные отправители (в карточках нет)', group.unknown, group.total),
  ];
}

/** Читаемый вывод: только числа и проценты. */
export function formatMailTrustSurvey(result: MailTrustSurveyResult): string[] {
  const lines = ['Обследование доверия к отправителям почты (только чтение)'];
  if (result.groups.length === 0) lines.push('Ящиков для обследования нет.');
  for (const group of result.groups) lines.push(...groupLines(group));
  return lines;
}
