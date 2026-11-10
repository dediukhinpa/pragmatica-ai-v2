import { normalizeEmail, type SupplierCard } from '../../kit/domain/supplier-card';
import { FREE_MAIL_DOMAINS, emailDomain } from './mail-domains';

/**
 * Уровень доверия отправителю письма (этап 233). Доверенный: верная подпись DKIM, выровненная с
 * доменом `From` (собственная проверка ядра), либо адрес или корпоративный домен отправителя уже
 * есть в карточке поставщика (для публичных почтовиков - только точный адрес). Остальное -
 * непроверенный: существующие карточки не дополняются без подтверждения (черновиков карточек с этапа 240 нет).
 * Результат почтового сервера (`Authentication-Results`) основанием не является никогда: SPF на
 * боевом сервере считается по чужому IP, и поддельное письмо получило бы `pass`. Он живёт в
 * отдельном поле `InboxMessage.serverAuth` и нужен только обследованию как справка.
 *
 * Два ослабления проверяются замером до включения и работают только за флагами:
 * `websiteDomain` (домен отправителя совпадает с доменом сайта карточки) и `replyThread` (письмо
 * отвечает на наше исходящее по `In-Reply-To`/`References`).
 */

/** Основания доверия в порядке приоритета. */
export const SENDER_TRUST_BASES = [
  'dkim',
  'card_address',
  'card_domain',
  'card_website',
  'reply_thread',
] as const;
export type SenderTrustBasis = (typeof SENDER_TRUST_BASES)[number];

/** Чем располагает код о письме. */
export interface SenderEvidence {
  /** Верная подпись DKIM, выровненная с доменом `From`. */
  dkimAligned: boolean;
  /** Письмо - ответ на наше исходящее (`InboxMessage.inReplyTo`). */
  replyToOurs: boolean;
}

/** Какие ослабления включены (по умолчанию оба выключены). */
export interface SenderTrustPolicy {
  websiteDomain: boolean;
  replyThread: boolean;
}

/** Итог: доверенный ли отправитель и на каком основании. */
export type SenderTrust =
  | { trusted: true; basis: SenderTrustBasis }
  | { trusted: false; basis: null };

/** Адреса и домены карточки, по которым отправитель узнаётся. */
export interface CardSenderView {
  /** Адреса всех контактов (нормализованные). */
  addresses: ReadonlySet<string>;
  /** Корпоративные домены этих адресов (публичные почтовики не входят). */
  emailDomains: readonly string[];
  /** Хост сайта карточки; пусто, если сайта нет. */
  websiteHost: string;
}

/** Один домен относится к другому: совпадает или является его поддоменом. */
function related(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** Хост сайта: без протокола, пути и «www.», нижний регистр; пусто, если это не адрес. */
function hostOf(website: string | undefined): string {
  if (website === undefined) return '';
  const host = website
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0];
  return host !== undefined && host.includes('.') ? host : '';
}

/** Что карточка говорит об отправителях (читается один раз на карточку). */
export function cardSenderView(card: SupplierCard): CardSenderView {
  const addresses = new Set<string>();
  const domains = new Set<string>();
  for (const contact of card.contacts) {
    if (contact.email === undefined || contact.email.trim() === '') continue;
    const address = normalizeEmail(contact.email);
    addresses.add(address);
    const domain = emailDomain(address);
    if (domain !== '' && !FREE_MAIL_DOMAINS.has(domain)) domains.add(domain);
  }
  return { addresses, emailDomains: [...domains], websiteHost: hostOf(card.website) };
}

/**
 * Все основания, которые к письму применимы, независимо от флагов (по ним считается замер
 * «сколько писем добавило бы ослабление»). Порядок - приоритет `SENDER_TRUST_BASES`.
 */
export function senderTrustBases(
  senderAddress: string,
  evidence: SenderEvidence,
  view: CardSenderView | null,
): SenderTrustBasis[] {
  const bases: SenderTrustBasis[] = [];
  if (evidence.dkimAligned) bases.push('dkim');
  if (view !== null) {
    const address = normalizeEmail(senderAddress);
    const domain = emailDomain(address);
    const corporate = domain !== '' && !FREE_MAIL_DOMAINS.has(domain);
    if (view.addresses.has(address)) bases.push('card_address');
    if (corporate && view.emailDomains.some((own) => related(domain, own))) {
      bases.push('card_domain');
    }
    if (corporate && view.websiteHost !== '' && related(domain, view.websiteHost)) {
      bases.push('card_website');
    }
  }
  if (evidence.replyToOurs) bases.push('reply_thread');
  return bases;
}

/** Основание допустимо при заданной политике. */
function allowed(basis: SenderTrustBasis, policy: SenderTrustPolicy): boolean {
  if (basis === 'card_website') return policy.websiteDomain;
  if (basis === 'reply_thread') return policy.replyThread;
  return true;
}

/**
 * Доверенный ли отправитель карточки. `view = null` - карточки нет (новый поставщик): остаются
 * основания, не зависящие от карточки (DKIM, ответ в наш тред при флаге).
 */
export function classifySender(
  senderAddress: string,
  evidence: SenderEvidence,
  view: CardSenderView | null,
  policy: SenderTrustPolicy,
): SenderTrust {
  const basis = senderTrustBases(senderAddress, evidence, view).find((item) =>
    allowed(item, policy),
  );
  return basis === undefined ? { trusted: false, basis: null } : { trusted: true, basis };
}
