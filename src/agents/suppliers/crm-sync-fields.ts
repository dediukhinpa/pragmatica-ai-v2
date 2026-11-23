import type { CrmSupplierCompany } from '../../kit/ports/crm-suppliers';
import type { ContactFields } from './card-fields';
import { FREE_MAIL_DOMAINS, emailDomain, type EnrichmentFields } from './card-enrichment';

/**
 * Поля карточки из компании CRM (этап 221): сборка контактов и сайта до проверки нашими
 * реквизитами. Вынесено из `crm-sync.ts`, чтобы файл задачи отвечал только за ход прохода.
 */

/** Контактов карточки из одной компании CRM не больше. */
const MAX_CONTACTS_PER_COMPANY = 10;
/** Адрес электронной почты внутри строки реквизитов («Почта: zakupki@firma.ru»). */
const EMAIL_IN_TEXT = /[^\s@<>()"';,]+@([^\s@<>()"';,]+\.[^\s@<>()"';,]+)/gu;
/**
 * Соцсети и мессенджеры: в CRM их часто вносят в поле «сайт», но сайтом компании они не
 * являются, и ссылка на страницу в соцсети в карточке ввела бы сотрудника в заблуждение.
 */
const SOCIAL_HOSTS: readonly string[] = [
  'vk.com',
  'vk.ru',
  'vkontakte.ru',
  't.me',
  'telegram.me',
  'telegram.org',
  'wa.me',
  'whatsapp.com',
  'viber.com',
  'instagram.com',
  'facebook.com',
  'fb.com',
  'ok.ru',
  'twitter.com',
  'x.com',
  'youtube.com',
  'youtu.be',
  'linkedin.com',
  'tiktok.com',
  'dzen.ru',
];

/**
 * Корпоративные домены почты нашей компании из `OWN_COMPANY_REQUISITES`. Адрес на таком домене
 * принадлежит нашему сотруднику, а не поставщику. Бесплатные почтовые сервисы не считаются:
 * домен `gmail.com` ничего не говорит о владельце (точный наш адрес отсеивает `OwnCompanyFilter`).
 */
export function ownMailDomains(requisites: readonly string[]): ReadonlySet<string> {
  const domains = new Set<string>();
  for (const item of requisites) {
    for (const match of item.matchAll(EMAIL_IN_TEXT)) {
      const domain = (match[1] ?? '').toLowerCase().replace(/[.]+$/u, '');
      if (domain !== '' && !FREE_MAIL_DOMAINS.has(domain)) domains.add(domain);
    }
  }
  return domains;
}

/** Адрес на нашем домене (сам домен или его поддомен). */
function isOwnDomainAddress(address: string | undefined, own: ReadonlySet<string>): boolean {
  if (address === undefined || own.size === 0) return false;
  const domain = emailDomain(address);
  return [...own].some((item) => domain === item || domain.endsWith(`.${item}`));
}

/** Узел ссылки: без регистра и `www.`; не разбирается - пустая строка. */
function hostOf(link: string): string {
  const text = link.trim();
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(text) ? text : `https://${text}`);
    return url.hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return '';
  }
}

/** Ссылка ведёт в соцсеть или мессенджер (сам узел или его поддомен). */
function isSocialLink(link: string): boolean {
  const host = hostOf(link);
  return SOCIAL_HOSTS.some((social) => host === social || host.endsWith(`.${social}`));
}

/**
 * Контакты карточки: контакты компании CRM, затем общие почта и телефоны компании. Контакт с
 * почтой на нашем домене - наш сотрудник, он отбрасывается целиком; наш адрес в общих почтах
 * пропускается.
 */
function contactsOf(
  company: CrmSupplierCompany,
  ownDomains: ReadonlySet<string>,
): ContactFields[] {
  const contacts: ContactFields[] = company.contacts
    .filter((contact) => !isOwnDomainAddress(contact.email, ownDomains))
    .map((contact) => ({
      ...(contact.fullName === undefined ? {} : { fullName: contact.fullName }),
      ...(contact.position === undefined ? {} : { position: contact.position }),
      ...(contact.email === undefined ? {} : { email: contact.email }),
      ...(contact.phone === undefined ? {} : { phone: contact.phone }),
    }));
  // Первый телефон пары с первой почтой: пара считается по исходному списку, чтобы телефон не
  // достался чужой почте, если первая (наша) отброшена.
  company.emails.forEach((email, index) => {
    if (isOwnDomainAddress(email, ownDomains)) return;
    const phone = index === 0 ? company.phones[0] : undefined;
    contacts.push({ email, ...(phone === undefined ? {} : { phone }) });
  });
  const firstPhoneUsed = company.emails.length > 0 ? 1 : 0;
  for (const phone of company.phones.slice(firstPhoneUsed)) contacts.push({ phone });
  return contacts.slice(0, MAX_CONTACTS_PER_COMPANY);
}

/** Поля карточки из компании CRM (до проверки нашими реквизитами). */
export function fieldsOf(
  company: CrmSupplierCompany,
  ownDomains: ReadonlySet<string>,
): EnrichmentFields {
  const contacts = contactsOf(company, ownDomains);
  const website = company.websites.find((link) => !isSocialLink(link));
  return {
    ...(company.title === '' ? {} : { name: company.title }),
    ...(company.inn === undefined ? {} : { inn: company.inn }),
    ...(company.kpp === undefined ? {} : { kpp: company.kpp }),
    ...(company.ogrn === undefined ? {} : { ogrn: company.ogrn }),
    ...(company.legalAddress === undefined ? {} : { legalAddress: company.legalAddress }),
    ...(website === undefined ? {} : { website }),
    ...(contacts.length === 0 ? {} : { contacts }),
  };
}
