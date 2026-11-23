import { DomainError } from '@business-ai/core';
import {
  MAX_CONTACTS,
  MAX_NOTE_LENGTH,
  MAX_SUPPLY_ITEMS,
  normalizeEmail,
  normalizeInn,
  normalizePhone,
  normalizeSupplierCard,
  validateSupplierCard,
  type SupplierCard,
  type SupplierCardSource,
  type SupplierNote,
} from '../../kit/domain/supplier-card';
import { isValidInn } from '../../kit/domain/requisites';
import { type Supplier } from '../../kit/domain/models';
import type { Clock } from '@business-ai/core';
import type { SupplierRepository } from '../../kit/ports/repositories.owned';
import { stableHash } from '@business-ai/core';
import { maskDigitSeries, maskEmail, maskPhone } from './card-view';
import { sanitizeSupplierCard } from './card-sanitize';
import { cardFromFields, type SupplierCardFields } from './card-fields';
import { findEnrichmentConflicts, type EnrichmentConflict } from './card-enrichment-conflicts';
import { createAutoSupplierCard } from './draft-card';
import { mergeDraftIntoCard } from './draft-merge';
import { REQUISITES_CHANGED_PREFIX, splitRequisites } from './card-requisites-guard';
import { FREE_MAIL_DOMAINS, emailDomain } from './mail-domains';
import {
  cardSenderView,
  classifySender,
  type SenderEvidence,
  type SenderTrustBasis,
  type SenderTrustPolicy,
} from './sender-trust';

export { FREE_MAIL_DOMAINS, emailDomain };

/**
 * Обогащение карточек поставщиков из источника (этап 218).
 *
 * Общий узел для загрузчика почты (этап 124), инструмента `enrichSupplierCard` и плановых
 * разборщиков писем, CRM, договоров: сопоставить сведения с существующей карточкой (ИНН,
 * адрес, домен, название) и либо дополнить её, либо завести новую. Дополнение пишет
 * только пустые поля, новые контакты и элементы списков; значения, расходящиеся с карточкой,
 * не пишутся, а возвращаются списком (`conflicts`): их меняет сотрудник через подтверждение.
 * Первая половина файла (сопоставление, слияние, запись) вынесена из загрузчика почты без
 * изменения поведения; вторая - `enrichOrCreateSupplier`.
 */

/** Сколько карточек читает обход при построении индекса доменов за один запрос. */
const DOMAIN_INDEX_PAGE = 500;
/** Сколько раз повторяется запись карточки, если её изменили между чтением и записью. */
const CONFLICT_RETRIES = 1;

/** Зависимости сопоставления и записи: подмножество репозитория поставщиков. */
export type EnrichmentSuppliers = Pick<
  SupplierRepository,
  'findByAddresses' | 'findDuplicates' | 'get' | 'getCard' | 'saveCard' | 'addNote' | 'listPage'
>;

/** Кто и когда пишет: автор правки и момент (ISO). */
export interface BuildContext {
  userId: string;
  nowIso: string;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Корректный ИНН (с контрольной суммой) цифрами; иначе undefined. */
export function validInn(value: string | null | undefined): string | undefined {
  const digits = value === null || value === undefined ? '' : normalizeInn(value);
  return digits !== '' && isValidInn(digits) ? digits : undefined;
}

function probeIssues(fields: SupplierCardFields, context: BuildContext): string[] {
  const probe = cardFromFields(fields, { ...context, source: 'email' }, 'probe');
  return validateSupplierCard(normalizeSupplierCard(probe)).map((issue) => issue.code);
}

/**
 * Поля без значений, которые проверка карточки отклонила бы (неверный ИНН, сайт, адрес или
 * телефон из писем): письма неряшливы, а карточку из-за одного поля терять нельзя.
 */
export function sanitizeFields(
  fields: SupplierCardFields,
  context: BuildContext,
): SupplierCardFields {
  const next: SupplierCardFields = { ...fields };
  const issues = probeIssues(next, context);
  if (issues.includes('inn_invalid')) delete next.inn;
  if (issues.includes('website_invalid')) delete next.website;
  if (next.contacts !== undefined) {
    const sound = next.contacts.filter(
      (contact) =>
        !probeIssues({ name: 'probe', contacts: [contact] }, context).some((code) =>
          code.startsWith('contact_'),
        ),
    );
    if (sound.length === 0) delete next.contacts;
    else next.contacts = sound.map((contact, index) => ({ ...contact, isPrimary: index === 0 }));
  }
  return next;
}

/** Содержимое карточки без служебных полей правки и заметок: для «изменилось ли». */
function contentSignature(card: SupplierCard): string {
  const { updatedAt: _at, updatedBy: _by, notes: _notes, ...rest } = card;
  return JSON.stringify(Object.entries(rest).sort(([a], [b]) => compareText(a, b)));
}

/**
 * Карточка, дополненная данными источника: только пустые поля, новые контакты и элементы
 * списков (`mergeDraftIntoCard`). Служебную заметку «объединена с ...»
 * слияние добавляет всегда, а здесь она ложна и ломала бы идемпотентность, поэтому заметки
 * остаются прежними.
 */
export function enrichCard(
  target: SupplierCard,
  fields: SupplierCardFields,
  context: BuildContext,
): { card: SupplierCard; changed: boolean } {
  const donor = cardFromFields(fields, { ...context, source: 'email' }, 'donor');
  const merged = mergeDraftIntoCard(target, donor, context);
  merged.notes = target.notes;
  merged.contacts = merged.contacts.slice(0, MAX_CONTACTS);
  merged.supplies = {
    ...merged.supplies,
    categories: merged.supplies.categories.slice(0, MAX_SUPPLY_ITEMS),
  };
  const changed = contentSignature(merged) !== contentSignature(target);
  return { card: changed ? merged : target, changed };
}

/** Индекс «домен -> поставщики» по основному адресу карточек; строится один раз по требованию. */
export class DomainIndex {
  private index: Map<string, string[]> | null = null;

  constructor(private readonly suppliers: Pick<SupplierRepository, 'listPage'>) {}

  async lookup(domains: readonly string[]): Promise<string[]> {
    this.index ??= await this.build();
    const ids = new Set<string>();
    for (const domain of domains) for (const id of this.index.get(domain) ?? []) ids.add(id);
    return [...ids];
  }

  /**
   * Занести поставщика, появившегося или изменившегося после построения индекса. Индекс не
   * построен - ничего не делает (он прочтёт поставщика сам при первом обращении).
   */
  add(supplier: Pick<Supplier, 'id' | 'email'>): void {
    if (this.index === null) return;
    for (const [domain, ids] of this.index) {
      const rest = ids.filter((id) => id !== supplier.id);
      if (rest.length === 0) this.index.delete(domain);
      else if (rest.length !== ids.length) this.index.set(domain, rest);
    }
    const domain = emailDomain(supplier.email ?? '');
    if (domain === '' || FREE_MAIL_DOMAINS.has(domain)) return;
    this.index.set(domain, [...(this.index.get(domain) ?? []), supplier.id]);
  }

  private async build(): Promise<Map<string, string[]>> {
    const index = new Map<string, string[]>();
    let after: string | null = null;
    for (;;) {
      const page: Supplier[] = await this.suppliers.listPage(after, DOMAIN_INDEX_PAGE);
      for (const supplier of page) {
        const domain = emailDomain(supplier.email ?? '');
        if (domain !== '' && !FREE_MAIL_DOMAINS.has(domain)) {
          index.set(domain, [...(index.get(domain) ?? []), supplier.id]);
        }
      }
      const last = page[page.length - 1];
      if (last === undefined) return index;
      after = last.id;
    }
  }
}

/**
 * Что известно о поставщике для сопоставления с базой. Группа досье загрузчика почты
 * (`SupplierGroup`) подходит сюда как есть.
 */
export interface MatchQuery {
  name: string;
  /** ИНН цифрами и с верной контрольной суммой (`validInn`). */
  inn?: string | undefined;
  /** Адреса почты в нормализованном виде. */
  emails: readonly string[];
  /** Отправители: адреса (с «@») или домены; по ним находится корпоративный домен. */
  senderKeys: readonly string[];
  /** Карточки, на которые указал сам источник (карточка должна существовать). */
  existingIds: readonly string[];
}

/** Корпоративные домены запроса: отправители без «@» и домены адресов, кроме бесплатной почты. */
function queryDomains(query: MatchQuery): string[] {
  const raw = [
    ...query.senderKeys.map((key) => (key.includes('@') ? emailDomain(key) : key.toLowerCase())),
    ...query.emails.map(emailDomain),
  ];
  return [...new Set(raw.filter((domain) => domain !== '' && !FREE_MAIL_DOMAINS.has(domain)))];
}

/** Сила совпадения: меньше - надёжнее. */
const RANK = { existing: 0, inn: 1, email: 2, domain: 3, name: 4 } as const;
type MatchRank = (typeof RANK)[keyof typeof RANK];

/**
 * Почему сопоставление отказало (только режим обогащения): `supplier_inn_mismatch` - указанная
 * карточка есть, но с другим ИНН; `supplier_missing` - указанной карточки нет;
 * `inn_of_other_card` - ИНН источника записан у другой карточки, а указанная ИНН не имеет;
 * `untrusted_source` - карточка найдена, но источник не подтверждён (`existingCards: 'review'`).
 */
type MatchReason =
  | 'supplier_inn_mismatch'
  | 'supplier_missing'
  | 'inn_of_other_card'
  | 'untrusted_source';

/** Итог сопоставления; при неоднозначности - карточки-кандидаты (для вопроса человеку). */
export type MatchResult =
  | { kind: 'found'; supplierId: string }
  | { kind: 'none'; reason?: MatchReason }
  | { kind: 'ambiguous'; candidateIds: string[]; reason?: MatchReason };

/** Режим сопоставления. */
export interface MatchOptions {
  /**
   * Режим `enrichOrCreateSupplier` (этап 218). Без него поведение загрузчика почты (этап 124)
   * не меняется. В режиме обогащения: домен только подкрепляет признак, а не равен ему;
   * отвергнутая карточка из `existingIds` не подменяется другой; ИНН источника, записанный у
   * другой карточки, не вносится в указанную без ИНН.
   */
  enrichment?: boolean;
}

/**
 * Найти существующую карточку: по `existingIds` (карточка должна существовать), ИНН,
 * адресам, домену и названию. Карточка с другим ИНН отбрасывается: это другое юрлицо.
 * Если лучшему рангу соответствует несколько карточек, выбирать нельзя - `ambiguous`.
 */
export async function findMatch(
  query: MatchQuery,
  suppliers: EnrichmentSuppliers,
  domains: DomainIndex,
  options: MatchOptions = {},
): Promise<MatchResult> {
  const enrichment = options.enrichment === true;
  const ranks = new Map<string, MatchRank>();
  const offer = (id: string, rank: MatchRank): void => {
    const known = ranks.get(id);
    if (known === undefined || rank < known) ranks.set(id, rank);
  };
  const innHits = new Set<string>();
  const domainHits = new Set<string>();
  for (const id of query.existingIds) {
    if ((await suppliers.get(id)) !== null) offer(id, RANK.existing);
  }
  const addresses = [
    ...query.emails,
    ...query.senderKeys.filter((key) => key.includes('@')).map(normalizeEmail),
  ];
  for (const hit of await suppliers.findByAddresses(addresses)) {
    offer(hit.supplier.id, RANK.email);
  }
  const duplicates = await suppliers.findDuplicates({
    name: query.name,
    ...(query.inn === undefined ? {} : { inn: query.inn }),
    contacts: query.emails.map((email) => ({ email })),
  });
  for (const duplicate of duplicates) {
    const reasons = duplicate.reasons;
    if (reasons.includes('inn')) {
      offer(duplicate.supplierId, RANK.inn);
      innHits.add(duplicate.supplierId);
    } else if (reasons.includes('email')) offer(duplicate.supplierId, RANK.email);
    else offer(duplicate.supplierId, RANK.name);
  }
  const domainList = queryDomains(query);
  if (domainList.length > 0) {
    for (const id of await domains.lookup(domainList)) {
      // Режим обогащения: домен нужен лишь как подкрепление, ранг даёт сильнейший другой признак.
      if (enrichment) domainHits.add(id);
      else offer(id, RANK.domain);
    }
  }
  /** Карточка существует и не принадлежит другому юрлицу (ИНН записан и отличается). */
  const isUsable = async (id: string): Promise<boolean> => {
    const stored = await suppliers.get(id);
    const storedInn = stored?.inn === undefined ? undefined : normalizeInn(stored.inn);
    const hasOtherInn = storedInn !== undefined && storedInn !== '' && storedInn !== query.inn;
    const differs = query.inn !== undefined && hasOtherInn;
    return stored !== null && !differs;
  };
  const usableOf = async (): Promise<Array<{ id: string; rank: MatchRank }>> => {
    const result: Array<{ id: string; rank: MatchRank }> = [];
    for (const [id, rank] of ranks) if (await isUsable(id)) result.push({ id, rank });
    return result;
  };
  let usable = await usableOf();
  if (enrichment) {
    const refusal = await enrichmentRefusal(query, suppliers, usable, innHits);
    if (refusal !== null) return refusal;
    // Нет ни одного недоменного признака: остаётся только домен, он общий у холдинга.
    if (usable.length === 0) {
      for (const id of domainHits) offer(id, RANK.domain);
      usable = await usableOf();
    }
  }
  if (usable.length === 0) return { kind: 'none' };
  const best = Math.min(...usable.map((item) => item.rank));
  const top = usable.filter((item) => item.rank === best);
  const [only] = top;
  const candidateIds = top.map((item) => item.id);
  // Домен общий у холдинга и нескольких юрлиц, а ИНН не сверить: без второго признака
  // (адрес, ИНН, название, id) чужие данные в карточку не вносятся - решает оператор.
  if (best === RANK.domain) return { kind: 'ambiguous', candidateIds };
  if (enrichment && best === RANK.name) {
    // Совпало только название, а корпоративный домен указывает на другую карточку.
    const usableOthers: string[] = [];
    for (const id of domainHits) {
      if (!candidateIds.includes(id) && (await isUsable(id))) usableOthers.push(id);
    }
    if (usableOthers.length > 0) {
      return { kind: 'ambiguous', candidateIds: [...candidateIds, ...usableOthers] };
    }
  }
  return top.length === 1 && only !== undefined
    ? { kind: 'found', supplierId: only.id }
    : { kind: 'ambiguous', candidateIds };
}

/**
 * Отказы режима обогащения, когда выбор по `existingIds` ненадёжен: указанная карточка
 * отвергнута (её нет или ИНН другой) - другой карточкой её не заменяем; указанная без ИНН, а ИНН
 * источника уже записан у другой карточки - человек решает, какая из них нужна.
 */
async function enrichmentRefusal(
  query: MatchQuery,
  suppliers: EnrichmentSuppliers,
  usable: ReadonlyArray<{ id: string; rank: MatchRank }>,
  innHits: ReadonlySet<string>,
): Promise<MatchResult | null> {
  if (query.existingIds.length === 0) return null;
  const chosen = usable.filter((item) => query.existingIds.includes(item.id));
  if (chosen.length === 0) {
    let present = false;
    for (const id of query.existingIds) present ||= (await suppliers.get(id)) !== null;
    return { kind: 'none', reason: present ? 'supplier_inn_mismatch' : 'supplier_missing' };
  }
  if (query.inn === undefined) return null;
  const foreign = usable.filter(
    (item) => innHits.has(item.id) && !query.existingIds.includes(item.id),
  );
  if (foreign.length === 0) return null;
  let lacksInn = false;
  for (const item of chosen) {
    const stored = await suppliers.get(item.id);
    lacksInn ||= stored?.inn === undefined || normalizeInn(stored.inn) === '';
  }
  if (!lacksInn) return null;
  return {
    kind: 'ambiguous',
    candidateIds: [...chosen, ...foreign].map((item) => item.id),
    reason: 'inn_of_other_card',
  };
}

/** Заметка, которую запись добавляет в той же операции, что и поля (атомарно). */
export interface EnrichmentNote {
  note: SupplierNote;
  /** Метка в конце текста: по ней повтор узнаёт, что заметка уже есть. */
  marker: string;
}

/** Есть ли у карточки заметка с этой меткой (читаются последние заметки карточки). */
function hasMarker(card: SupplierCard, marker: string): boolean {
  return card.notes.some((note) => note.text.endsWith(marker));
}

/**
 * Записать карточку; при конфликте версий перечитать и повторить с тем же результатом слияния.
 * `note` (необязательно) добавляется той же записью, если заметки с такой меткой ещё нет: поля
 * и заметка не расходятся при сбое между двумя записями.
 */
export async function saveEnriched(
  suppliers: EnrichmentSuppliers,
  supplierId: string,
  fields: SupplierCardFields,
  context: BuildContext,
  source?: SupplierCardSource,
  note?: EnrichmentNote,
): Promise<{ changed: boolean; card: SupplierCard }> {
  for (let attempt = 0; ; attempt += 1) {
    const current = await suppliers.getCard(supplierId);
    if (current === null) throw new DomainError('not_found', 'Карточка исчезла во время загрузки.');
    const { card, changed } = enrichCard(current, fields, context);
    if (!changed && source === undefined) return { changed: false, card: current };
    const withSource: SupplierCard = source === undefined ? card : { ...card, source };
    const next: SupplierCard =
      note === undefined || hasMarker(card, note.marker)
        ? withSource
        : { ...withSource, notes: [...withSource.notes, note.note] };
    try {
      const saved = await suppliers.saveCard(next, {
        ...(current.updatedAt === undefined ? {} : { expectedUpdatedAt: current.updatedAt }),
      });
      return { changed: true, card: saved };
    } catch (error) {
      const conflict = error instanceof DomainError && error.code === 'conflict';
      if (!conflict || attempt >= CONFLICT_RETRIES) throw error;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Обогащение или создание карточки из источника (этап 218)
// ---------------------------------------------------------------------------------------------

/** Откуда пришли сведения: чат, файл, письмо, CRM, документ, канал Telegram. */
export const ENRICHMENT_ORIGINS = ['chat', 'file', 'email', 'crm', 'document', 'telegram'] as const;
export type EnrichmentOrigin = (typeof ENRICHMENT_ORIGINS)[number];

/** Источник в родительном падеже: «Дополнено из <источник> <дата>». */
const ORIGIN_LABELS: Readonly<Record<EnrichmentOrigin, string>> = {
  chat: 'чата',
  file: 'файла',
  email: 'письма',
  crm: 'CRM',
  document: 'документа',
  telegram: 'канала Telegram',
};

/**
 * Какое значение `suppliers.source` пишется новой карточке. CHECK таблицы допускает только
 * chat/file/email (миграция 018) и миграцией не расширяется: источник вне списка получает
 * ближайшее допустимое значение, а точный источник виден в заметке карточки.
 */
const CARD_SOURCE_OF: Readonly<Record<EnrichmentOrigin, SupplierCardSource>> = {
  chat: 'chat',
  telegram: 'chat',
  file: 'file',
  document: 'file',
  crm: 'file',
  email: 'email',
};

/** Предел подписи источника в заметке (имя файла, тема): остальное обрезается. */
const MAX_SOURCE_LABEL_LENGTH = 120;
/** Длина даты в заметке: `YYYY-MM-DD`. */
const DATE_LENGTH = 10;
const NOTE_MARKER_PREFIX = 'enrich:';
/** Метка заметки «реквизиты изменились» и длина хэша в ней. */
const REQUISITES_MARKER_PREFIX = 'requisites:';
const MARKER_HASH_LENGTH = 12;
/** Сколько знаков ключа источника показывается в пометке как номер. */
const SOURCE_REF_LENGTH = 8;

/** Источник сведений для одной операции. */
export interface EnrichmentSource {
  /**
   * Стабильный ключ источника: тот же документ или письмо дают тот же ключ. По нему повтор
   * не задваивает заметку (хэш текста, id письма, id компании CRM).
   */
  key: string;
  /** Подпись источника для заметки (имя файла, тема): без персональных данных. */
  label?: string | undefined;
  /** Отправитель письма или домен: помогает найти карточку по домену. */
  senderKeys?: readonly string[] | undefined;
  /** Карточка, на которую указал сам источник (например, найденная поиском по базе). */
  supplierId?: string | undefined;
  /**
   * Дата получения письма (ISO): попадает в пометку «Реквизиты изменились», чтобы сотрудник
   * нашёл письмо в ящике. Тема и значения в пометку не идут.
   */
  receivedAt?: string | undefined;
}

/** Параметры операции. */
export interface EnrichmentOptions {
  /** Нет подходящей карточки: завести новую (иначе `not_found`). */
  createIfMissing: boolean;
  origin: EnrichmentOrigin;
  /** Кто пишет (идентификатор в `createdBy`/`updatedBy` и в заметке). */
  author: string;
  /**
   * Что делать с найденной карточкой (по умолчанию `enrich`). `review`: источник не
   * подтверждён (письмо без почтовой проверки отправителя) - карточка не меняется, итог
   * `ambiguous` с причиной `untrusted_source`. Любой, кто знает ИНН или название, иначе мог бы
   * дописать в чужую карточку свои данные.
   */
  existingCards?: 'enrich' | 'review' | 'by_trust';
  /**
   * Для `existingCards: 'by_trust'` (этап 233): карточка дополняется, только если отправитель
   * доверенный (`classifySender`: DKIM, адрес или домен этой карточки, ослабления по флагам);
   * иначе - как `review`. `evidence` вызывается лениво, только когда одних данных карточки
   * мало (проверка DKIM у ящика-источника скачивает письмо целиком).
   */
  trust?: {
    evidence: () => Promise<SenderEvidence>;
    policy: SenderTrustPolicy;
  };
  /**
   * Пробный режим: сопоставление и расчёт те же, но карточка и заметки не пишутся; итог
   * `enriched` означает «была бы дополнена».
   */
  dryRun?: boolean;
  /**
   * Контакты и сайт источника дописываются в найденную карточку, только если отправитель
   * (`senderKeys`) относится к ней: его корпоративный домен совпадает с доменом почты или сайта
   * карточки либо его адрес в ней уже записан. Иначе контакты и сайт не пишутся, а в `conflicts`
   * попадает расхождение с полем `FOREIGN_SENDER_CONFLICT_FIELD` (на проверку человеку).
   */
  contactDomainGuard?: boolean;
  /**
   * Защита реквизитов независимо от `origin` (ревью 233): вид источника называет модель, и по
   * нему защиту отключать нельзя. Если поле задано, ИНН/КПП/ОГРН/юрадрес/банковские поля
   * отделяются от записи (пометка «Реквизиты изменились»), кроме перечисленных здесь: их код
   * доказал как значения из присланного сотрудником документа. Пустое множество - защищено всё.
   * Не задано - прежнее поведение: защита только при `origin === 'email'` (там всегда всё).
   */
  provenRequisites?: ReadonlySet<string> | undefined;
  /**
   * Белый список записи (автообогащение без вопросов человеку): после отделения реквизитов
   * из полей источника остаётся только то, что вернёт функция. Применяется к найденной
   * карточке; создание новых карточек не затрагивает.
   */
  writableFilter?: ((fields: SupplierCardFields) => SupplierCardFields) | undefined;
}

/** Зависимости операции. */
export interface EnrichmentDeps {
  suppliers: EnrichmentSuppliers;
  clock: Pick<Clock, 'now'>;
  /** Индекс доменов, общий для пачки операций; без него строится на каждый вызов. */
  domains?: DomainIndex | undefined;
}

/** Поля источника: без заметки, статуса и команд правки (они не для обогащения). */
export type EnrichmentFields = Omit<
  SupplierCardFields,
  | 'status'
  | 'note'
  | 'clear'
  | 'removeContacts'
  | 'removeCategories'
  | 'removeBrands'
  | 'removeRegions'
>;

/**
 * Итог операции. `created` - заведена новая карточка; `enriched` - записаны новые
 * сведения; `unchanged` - всё уже было; `ambiguous` - несколько подходящих карточек (или только
 * общий домен), ничего не записано; `not_found` - карточки нет, а создавать не просили.
 */
export interface EnrichmentOutcome {
  kind: 'created' | 'enriched' | 'unchanged' | 'ambiguous' | 'not_found';
  supplierId: string | null;
  /** Кандидаты при `ambiguous`. */
  candidateIds: string[];
  /** Что записано: имена полей без значений (`contacts`, `terms.payment`, ...). */
  addedFields: string[];
  /** Значения источника, расходящиеся с карточкой: не записаны. */
  conflicts: EnrichmentConflict[];
  /** Причина отказа сопоставления (`ambiguous`/`not_found`), если она особая. */
  reason?: MatchReason | undefined;
  /** Что отброшено при подготовке (неверный ИНН, не прошедшие проверку поля): не молча. */
  warnings: string[];
  /**
   * Реквизиты письма (ИНН/КПП, адрес, банковские), которые НЕ записаны в существующую карточку
   * при любом уровне доверия (этап 233): их применяет только человек. Значения - ПДн, в журнал
   * и аудит не попадают.
   */
  requisiteChanges: EnrichmentConflict[];
  /** Основание доверия к отправителю при `existingCards: 'by_trust'`. */
  trustBasis?: SenderTrustBasis | undefined;
}

export type { EnrichmentConflict };

/** Поле расхождения «отправитель не из доменов карточки»: контакты и сайт не записаны. */
export const FOREIGN_SENDER_CONFLICT_FIELD = 'contacts.sender_domain';

const EMPTY_OUTCOME: EnrichmentOutcome = {
  kind: 'not_found',
  supplierId: null,
  candidateIds: [],
  addedFields: [],
  conflicts: [],
  warnings: [],
  requisiteChanges: [],
};

function clip(value: string, max: number): string {
  return value.trim().slice(0, max).trim();
}

/** Хост сайта: без протокола, пути и «www.», в нижнем регистре; пусто, если это не адрес. */
function websiteHost(website: string | undefined): string {
  if (website === undefined) return '';
  const host = website
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0];
  return host !== undefined && host.includes('.') ? host : '';
}

/** Поля, которые не копируются в донора как «пустые поля»: структура разбирается отдельно. */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  'name',
  'contacts',
  'categories',
  'brands',
  'regions',
  'terms',
]);

/** Предупреждение о неверном ИНН: без него сотрудник не узнает, что сверки по ИНН не было. */
const INN_DROPPED_WARNING =
  'Указанный ИНН неверен (не прошла контрольная сумма) и не использован: карточка ищется ' +
  'по названию, почте и домену без сверки по ИНН. Проверьте ИНН по документу.';

/** Результат подготовки: поля для записи и что отброшено. */
export interface PreparedFields {
  fields: SupplierCardFields;
  warnings: string[];
}

/** Поле с заданным значением (пустые строки и списки значением не считаются). */
function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return !Array.isArray(value) || value.length > 0;
}

/**
 * Подготовка полей источника: служебные команды отброшены, адреса и телефоны приведены к
 * виду записи (иначе повтор не узнает уже записанный контакт), неверные значения убраны.
 * Убрать значения нужно до сравнения и записи: репозиторий отклоняет карточку целиком.
 * Проверяет общий санитайзер карточки, а записываются значения из ЕГО копии: он режет длинные
 * тексты, и запись исходного значения репозиторий отклонил бы (`invalid_input`).
 */
export function prepareFields(raw: EnrichmentFields, context: BuildContext): PreparedFields {
  const fields: SupplierCardFields = { ...raw };
  const name = fields.name?.trim() ?? '';
  if (name === '') delete fields.name;
  else fields.name = name;
  if (fields.contacts !== undefined) {
    const contacts = fields.contacts.flatMap((contact) => {
      const { email: rawEmail, phone: rawPhone, ...rest } = contact;
      const email = rawEmail === undefined ? '' : normalizeEmail(rawEmail);
      const phone = rawPhone === undefined ? '' : normalizePhone(rawPhone);
      const next = {
        ...rest,
        ...(email === '' ? {} : { email }),
        ...(phone === '' ? {} : { phone }),
      };
      return Object.keys(next).some((key) => key !== 'isPrimary') ? [next] : [];
    });
    if (contacts.length === 0) delete fields.contacts;
    else fields.contacts = contacts;
  }
  const sound = sanitizeFields(fields, context);
  const cleaned = sanitizeSupplierCard(
    cardFromFields(sound, { ...context, source: 'email' }, 'probe'),
  ).card;
  const result: SupplierCardFields = { ...sound };
  for (const key of Object.keys(sound)) {
    if (STRUCTURAL_KEYS.has(key)) continue;
    const value: unknown = Reflect.get(cleaned, key);
    if (value === undefined) Reflect.deleteProperty(result, key);
    else Reflect.set(result, key, value);
  }
  if (result.name !== undefined) result.name = cleaned.name;
  if (result.contacts !== undefined) {
    const kept = cleaned.contacts.filter((contact) =>
      Object.keys(contact).some((key) => key !== 'isPrimary'),
    );
    if (kept.length === 0) delete result.contacts;
    else result.contacts = kept;
  }
  for (const key of ['categories', 'brands', 'regions'] as const) {
    if (result[key] === undefined) continue;
    const list = cleaned.supplies[key];
    if (list.length === 0) delete result[key];
    else result[key] = list;
  }
  if (result.terms !== undefined) {
    const terms = Object.fromEntries(
      Object.entries(cleaned.terms).filter(([, value]) => hasValue(value)),
    );
    if (Object.keys(terms).length === 0) delete result.terms;
    else result.terms = terms;
  }
  return { fields: result, warnings: droppedWarnings(raw, result) };
}

/** Что из полей источника отброшено проверкой: неверный ИНН отдельным текстом, прочее списком. */
function droppedWarnings(raw: EnrichmentFields, kept: SupplierCardFields): string[] {
  const warnings: string[] = [];
  if (hasValue(raw.inn) && !hasValue(kept.inn)) warnings.push(INN_DROPPED_WARNING);
  const dropped = Object.entries(raw)
    .filter(([key, value]) => key !== 'inn' && hasValue(value) && !hasValue(Reflect.get(kept, key)))
    .map(([key]) => key);
  if (dropped.length > 0) {
    warnings.push(`Не прошли проверку и не записаны: ${dropped.join(', ')}.`);
  }
  return warnings;
}

/** Ключ запроса сопоставления из полей источника. */
function queryOf(fields: SupplierCardFields, source: EnrichmentSource): MatchQuery {
  const emails = (fields.contacts ?? []).flatMap((contact) =>
    contact.email === undefined ? [] : [contact.email],
  );
  const host = websiteHost(fields.website);
  const inn = validInn(fields.inn);
  return {
    name: fields.name ?? '',
    ...(inn === undefined ? {} : { inn }),
    emails,
    // Сайт поставщика - тоже домен: карточка с почтой на этом домене кандидат (не автосовпадение).
    senderKeys: [...(source.senderKeys ?? []), ...(host === '' ? [] : [host])],
    existingIds: source.supplierId === undefined ? [] : [source.supplierId],
  };
}

function hasIdentity(query: MatchQuery): boolean {
  return (
    query.name !== '' ||
    query.inn !== undefined ||
    query.emails.length > 0 ||
    query.existingIds.length > 0
  );
}

/** Почтовый адрес в тексте подписи. */
const EMAIL_IN_TEXT = /[^\s@<>()"',;]+@[^\s@<>()"',;]+/g;
/** Телефон с разделителями: цифры, пробелы, скобки, дефисы. */
const PHONE_IN_TEXT = /\+?\d[\d\s().-]{8,}\d/g;
/** Минимум цифр, с которого запись в подписи считается телефоном. */
const MIN_PHONE_DIGITS = 10;
/** Фамилия, имя и отчество подряд: отчество узнаётся по окончанию. */
const FULL_NAME_IN_TEXT =
  /\p{Lu}\p{Ll}+\s+\p{Lu}\p{Ll}+\s+\p{Lu}\p{Ll}*(?:ович|евич|ьич|овна|евна|ична|кызы|оглы)/gu;
/** Фамилия с инициалами в любом порядке: «Петров П.П.», «П. П. Петров». */
const INITIALS_IN_TEXT =
  /\p{Lu}\p{Ll}+\s+\p{Lu}\.\s*(?:\p{Lu}\.)?|\p{Lu}\.\s*(?:\p{Lu}\.\s*)?\p{Lu}\p{Ll}+/gu;
const NAME_MASK = 'ФИО';

/**
 * Подпись источника без персональных данных: она остаётся в заметке карточки, которую видят все,
 * и в ответах модели. Почта, телефон, длинные цифровые ряды и ФИО заменяются масками. Подпись
 * приходит от модели или из темы письма, поэтому доверять ей нельзя.
 */
function maskSourceLabel(label: string): string {
  return maskDigitSeries(
    label
      .replace(EMAIL_IN_TEXT, (match) => maskEmail(match))
      .replace(PHONE_IN_TEXT, (match) =>
        match.replace(/\D/g, '').length >= MIN_PHONE_DIGITS ? maskPhone(match) : match,
      )
      .replace(FULL_NAME_IN_TEXT, NAME_MASK)
      .replace(INITIALS_IN_TEXT, NAME_MASK),
  );
}

/** Подпись источника для заметки: маска ПДн, затем предел длины. */
function labelOf(source: EnrichmentSource): string {
  return clip(maskSourceLabel(source.label ?? ''), MAX_SOURCE_LABEL_LENGTH);
}

/** Заметка «Дополнено из <источник> <дата>» с меткой идемпотентности в конце. */
function buildNote(
  source: EnrichmentSource,
  options: EnrichmentOptions,
  nowIso: string,
  verb: 'Дополнено' | 'Создано',
): EnrichmentNote {
  const label = labelOf(source);
  const marker = `\n[${NOTE_MARKER_PREFIX}${stableHash([options.origin, source.key])}]`;
  const head =
    `${verb} из ${ORIGIN_LABELS[options.origin]}` +
    `${label === '' ? '' : ` «${label}»`} ${nowIso.slice(0, DATE_LENGTH)}.`;
  return {
    note: {
      text: `${head.slice(0, MAX_NOTE_LENGTH - marker.length)}${marker}`,
      authorId: options.author,
      createdAt: nowIso,
    },
    marker,
  };
}

/** Имена полей, изменившихся между двумя версиями карточки (без служебных и заметок). */
function changedFields(before: SupplierCard, after: SupplierCard): string[] {
  const skip = new Set(['updatedAt', 'updatedBy', 'notes', 'source']);
  const flatten = (card: SupplierCard): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [key, value] of Object.entries(card)) {
      if (skip.has(key)) continue;
      if ((key === 'supplies' || key === 'terms') && typeof value === 'object' && value !== null) {
        for (const [inner, innerValue] of Object.entries(value)) {
          out.set(`${key}.${inner}`, JSON.stringify(innerValue));
        }
      } else {
        out.set(key, JSON.stringify(value));
      }
    }
    return out;
  };
  const was = flatten(before);
  const now = flatten(after);
  return [...now.keys()].filter((key) => now.get(key) !== was.get(key)).sort(compareText);
}

/** Один домен относится к другому: совпадает или является его поддоменом. */
function sameOrganisation(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** Корпоративные домены карточки: почта контактов и сайт (бесплатная почта домена не даёт). */
function cardCorporateDomains(card: SupplierCard): string[] {
  const domains = new Set<string>();
  for (const contact of card.contacts) {
    const domain = emailDomain(contact.email ?? '');
    if (domain !== '' && !FREE_MAIL_DOMAINS.has(domain)) domains.add(domain);
  }
  const host = websiteHost(card.website);
  if (host !== '') domains.add(host);
  return [...domains];
}

/** Результат проверки отправителя: допустимые поля и расхождения для человека. */
export interface SenderGuardResult {
  fields: SupplierCardFields;
  conflicts: EnrichmentConflict[];
}

/**
 * Проверка «письмо пришло от этой организации» (`contactDomainGuard`). Адрес отправителя
 * бесплатной почты сравнивается целиком, корпоративный - по домену. Чужой отправитель: контакты
 * и сайт убираются целиком. Свой: убираются только адреса других доменов (в тексте письма
 * бывают чужие адреса). Карточка без доменов отправителя не подтверждает - сначала человек.
 */
export function guardForeignSender(
  card: SupplierCard,
  fields: SupplierCardFields,
  senderKeys: readonly string[],
): SenderGuardResult {
  const domains = cardCorporateDomains(card);
  const known = new Set(card.contacts.flatMap((c) => (c.email === undefined ? [] : [c.email])));
  const addresses = senderKeys.filter((key) => key.includes('@')).map(normalizeEmail);
  const senderDomains = senderKeys
    .map((key) => (key.includes('@') ? emailDomain(key) : key.toLowerCase()))
    .filter((domain) => domain !== '' && !FREE_MAIL_DOMAINS.has(domain));
  const domainTrusted = senderDomains.some((d) => domains.some((own) => sameOrganisation(d, own)));
  const trusted = domainTrusted || addresses.some((address) => known.has(address));
  const conflict = (proposed: string): EnrichmentConflict => ({
    field: FOREIGN_SENDER_CONFLICT_FIELD,
    current: domains.join(', '),
    proposed,
  });
  const next: SupplierCardFields = { ...fields };
  if (!trusted) {
    const dropped = next.contacts !== undefined || next.website !== undefined;
    delete next.contacts;
    delete next.website;
    const proposed = [...new Set([...senderDomains, ...addresses.map(emailDomain)])].join(', ');
    return { fields: next, conflicts: dropped ? [conflict(proposed)] : [] };
  }
  const foreign: string[] = [];
  if (next.contacts !== undefined) {
    const kept = next.contacts.filter((contact) => {
      const domain = emailDomain(contact.email ?? '');
      if (domain === '' || known.has(normalizeEmail(contact.email ?? ''))) return true;
      const corporate = !FREE_MAIL_DOMAINS.has(domain);
      const own = corporate && domains.some((d) => sameOrganisation(domain, d));
      if (!own) foreign.push(domain);
      return own;
    });
    if (kept.length === 0) delete next.contacts;
    else next.contacts = kept;
  }
  return { fields: next, conflicts: foreign.length > 0 ? [conflict(foreign.join(', '))] : [] };
}

/**
 * Очередь создания карточек. В базе нет уникального индекса по ИНН и названию (идентификатор
 * карточки выводится из ИНН либо названия, поэтому карточки «с ИНН» и «без» одной компании
 * получают разные id), а вызовы идут из нескольких мест процесса: письма (этап 220), CRM
 * (этап 221), инструмент агента. Без очереди два параллельных создания одной компании обе не
 * находят друг друга и заводят дубль. Очередь одна на процесс (служба одна); при нескольких
 * экземплярах службы нужен уникальный индекс в базе.
 */
let creationQueue: Promise<unknown> = Promise.resolve();

/** Выполнить после всех поставленных ранее; сбой предыдущего очередь не останавливает. */
function inCreationQueue<T>(task: () => Promise<T>): Promise<T> {
  const run = creationQueue.then(task, task);
  creationQueue = run.catch(() => undefined);
  return run;
}

/**
 * Обогатить существующую карточку сведениями из источника или завести непроверенную.
 *
 * Сопоставление - `findMatch` (ИНН, адрес, домен, название; карточка с другим ИНН не
 * подходит; несколько кандидатов или один общий домен - `ambiguous`, ничего не пишется).
 * Найдена: пишутся только пустые поля, новые контакты и элементы списков, значения, которые
 * расходятся с карточкой, возвращаются в `conflicts` и не пишутся. Заметка «Дополнено из ...»
 * идёт той же записью и несёт метку источника: повтор того же источника ничего не меняет и
 * заметку не задваивает. Не найдена: при `createIfMissing` создаётся карточка
 * (сразу боевая), иначе `not_found`.
 * @throws DomainError `invalid_input` - репозиторий отклонил карточку; прочие ошибки записи.
 */
export function enrichOrCreateSupplier(
  deps: EnrichmentDeps,
  source: EnrichmentSource,
  rawFields: EnrichmentFields,
  options: EnrichmentOptions,
): Promise<EnrichmentOutcome> {
  // Сопоставление и создание идут одним шагом под очередью: сопоставление повторяется после
  // чужого создания и находит только что заведённую карточку. Режим без создания очередь не
  // занимает (он только дополняет существующие карточки).
  if (!options.createIfMissing) return enrichOrCreateUnlocked(deps, source, rawFields, options);
  return inCreationQueue(() => enrichOrCreateUnlocked(deps, source, rawFields, options));
}

/** Обогащение без очереди создания (см. {@link enrichOrCreateSupplier}). */
async function enrichOrCreateUnlocked(
  deps: EnrichmentDeps,
  source: EnrichmentSource,
  rawFields: EnrichmentFields,
  options: EnrichmentOptions,
): Promise<EnrichmentOutcome> {
  const nowIso = deps.clock.now().toISOString();
  const context: BuildContext = { userId: options.author, nowIso };
  const { fields, warnings } = prepareFields(rawFields, context);
  const query = queryOf(fields, source);
  if (!hasIdentity(query)) return { ...EMPTY_OUTCOME, warnings };
  const domains = deps.domains ?? new DomainIndex(deps.suppliers);
  const match = await findMatch(query, deps.suppliers, domains, { enrichment: true });
  if (match.kind === 'ambiguous') {
    return {
      ...EMPTY_OUTCOME,
      kind: 'ambiguous',
      candidateIds: match.candidateIds,
      reason: match.reason,
      warnings,
    };
  }
  if (match.kind === 'none') {
    // Указанную источником карточку отвергли: другую вместо неё не берём и не создаём.
    if (match.reason !== undefined) return { ...EMPTY_OUTCOME, reason: match.reason, warnings };
    if (!options.createIfMissing || fields.name === undefined) {
      return { ...EMPTY_OUTCOME, warnings };
    }
    return createFromSource(deps, source, fields, options, context, warnings);
  }
  const current = await deps.suppliers.getCard(match.supplierId);
  if (current === null) return { ...EMPTY_OUTCOME, warnings };
  let trustBasis: SenderTrustBasis | undefined;
  if (options.existingCards === 'by_trust' && options.trust !== undefined) {
    const judged = await judgeSender(current, source.senderKeys ?? [], options.trust);
    if (!judged.trusted) return untrustedOutcome(current.id, warnings);
    trustBasis = judged.basis;
  } else if (options.existingCards === 'review' || options.existingCards === 'by_trust') {
    // Источник не подтверждён (по `by_trust` без данных о доверии - тоже): найденную карточку
    // не меняем, решает человек.
    return untrustedOutcome(current.id, warnings);
  }
  const guarded =
    options.contactDomainGuard === true
      ? guardForeignSender(current, fields, source.senderKeys ?? [])
      : { fields, conflicts: [] };
  // Письмо не вправе менять реквизиты существующей карточки (классическая подмена счёта):
  // они отделяются от прочих полей и возвращаются на подтверждение человеку.
  const isLetter = options.origin === 'email';
  const split =
    isLetter || options.provenRequisites !== undefined
      ? splitRequisites(current, guarded.fields, isLetter ? undefined : options.provenRequisites)
      : { safe: guarded.fields, changes: [] };
  // Автообогащение: поверх защиты реквизитов оставляем только поля белого списка.
  const writable =
    options.writableFilter === undefined ? split.safe : options.writableFilter(split.safe);
  const conflicts = [...findEnrichmentConflicts(current, writable), ...guarded.conflicts];
  const base = {
    supplierId: current.id,
    candidateIds: [],
    conflicts,
    warnings,
    requisiteChanges: split.changes,
    trustBasis,
  };
  if (options.dryRun === true) {
    const trial = enrichCard(current, writable, context);
    const addedFields = trial.changed ? changedFields(current, trial.card) : [];
    return { ...base, kind: trial.changed ? 'enriched' : 'unchanged', addedFields };
  }
  if (split.changes.length > 0) {
    await markRequisitesChanged(deps, current, split.changes, options, source);
  }
  if (!enrichCard(current, writable, context).changed) {
    return { ...base, kind: 'unchanged', addedFields: [] };
  }
  const saved = await saveEnriched(
    deps.suppliers,
    current.id,
    writable,
    context,
    undefined,
    buildNote(source, options, nowIso, 'Дополнено'),
  );
  if (!saved.changed) return { ...base, kind: 'unchanged', addedFields: [] };
  return { ...base, kind: 'enriched', addedFields: changedFields(current, saved.card) };
}

/** Итог «отправитель не подтверждён»: карточка найдена, но не меняется. */
function untrustedOutcome(supplierId: string, warnings: string[]): EnrichmentOutcome {
  return {
    ...EMPTY_OUTCOME,
    kind: 'ambiguous',
    candidateIds: [supplierId],
    reason: 'untrusted_source',
    warnings,
  };
}

/** Доверие к отправителю письма относительно найденной карточки. */
async function judgeSender(
  card: SupplierCard,
  senderKeys: readonly string[],
  trust: NonNullable<EnrichmentOptions['trust']>,
): Promise<ReturnType<typeof classifySender>> {
  const sender = senderKeys.find((key) => key.includes('@')) ?? '';
  const view = cardSenderView(card);
  const none: SenderEvidence = { dkimAligned: false, replyToOurs: false };
  // Сначала без обращений к письму (адрес и домен карточки); ленивое основание - если не хватило.
  const quick = classifySender(sender, none, view, trust.policy);
  if (quick.trusted) return quick;
  return classifySender(sender, await trust.evidence(), view, trust.policy);
}

/** Текст пометки о неприменённых реквизитах: названия полей, значений нет. */
function requisitesNote(
  changes: readonly EnrichmentConflict[],
  marker: string,
  source: EnrichmentSource,
): string {
  const names = changes.map((item) => item.field).join(', ');
  return (
    `${REQUISITES_CHANGED_PREFIX}: в источнике указаны иные значения (${names}); не применены, ` +
    `нужно подтверждение сотрудника. ${sourceReference(source)}${marker}`
  );
}

/**
 * Ссылка на источник для пометки: внутренний номер (начало ключа источника) и дата письма,
 * если известна. Ни темы, ни адресов, ни значений: по номеру и дате письмо находят в ящике.
 */
function sourceReference(source: EnrichmentSource): string {
  const date = source.receivedAt?.slice(0, DATE_LENGTH);
  const when = date === undefined || date === '' ? '' : `, письмо от ${date}`;
  return `Источник: № ${source.key.slice(0, SOURCE_REF_LENGTH)}${when}.`;
}

/**
 * Пометить карточку «реквизиты изменились» (один раз на одинаковое предложение). Пишется только
 * в доверенных режимах: карточке непроверенного отправителя пометка не ставится (`review`).
 */
async function markRequisitesChanged(
  deps: EnrichmentDeps,
  card: SupplierCard,
  changes: readonly EnrichmentConflict[],
  options: EnrichmentOptions,
  source: EnrichmentSource,
): Promise<void> {
  const marker = ` [${REQUISITES_MARKER_PREFIX}${stableHash(
    changes.map((item) => [item.field, item.proposed]),
  ).slice(0, MARKER_HASH_LENGTH)}]`;
  if (hasMarker(card, marker)) return;
  await deps.suppliers.addNote(card.id, {
    text: requisitesNote(changes, marker, source).slice(0, MAX_NOTE_LENGTH),
    authorId: options.author,
    createdAt: deps.clock.now().toISOString(),
  });
}

/** Завести карточку из источника и дописать в неё остальные сведения. */
async function createFromSource(
  deps: EnrichmentDeps,
  source: EnrichmentSource,
  fields: SupplierCardFields,
  options: EnrichmentOptions,
  context: BuildContext,
  warnings: string[],
): Promise<EnrichmentOutcome> {
  const draft = await createAutoSupplierCard(
    deps.suppliers,
    {
      name: fields.name ?? '',
      inn: fields.inn,
      website: fields.website,
      city: fields.productionCity,
    },
    {
      ...context,
      origin: labelOf(source) || ORIGIN_LABELS[options.origin],
      basis: `создана автоматически из ${ORIGIN_LABELS[options.origin]}`,
    },
  );
  // Название или ИНН совпали с карточкой, которую сопоставление отвергло (другой ИНН):
  // решает человек, новую карточку не заводим.
  if (!draft.created) {
    return { ...EMPTY_OUTCOME, kind: 'ambiguous', candidateIds: [draft.card.id], warnings };
  }
  const saved = await saveEnriched(
    deps.suppliers,
    draft.card.id,
    fields,
    context,
    CARD_SOURCE_OF[options.origin],
    buildNote(source, options, context.nowIso, 'Создано'),
  );
  return {
    kind: 'created',
    supplierId: saved.card.id,
    candidateIds: [],
    addedFields: changedFields(draft.card, saved.card),
    conflicts: [],
    warnings,
    requisiteChanges: [],
  };
}
