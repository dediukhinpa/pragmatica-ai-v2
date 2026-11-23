import { normalizeEmail } from '../../kit/domain/supplier-card';

/** Бесплатные почтовые сервисы: домен такого адреса не говорит о компании. */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'mail.ru',
  'inbox.ru',
  'list.ru',
  'bk.ru',
  'internet.ru',
  'yandex.ru',
  'yandex.com',
  'ya.ru',
  'rambler.ru',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'yahoo.com',
  'proton.me',
  'protonmail.com',
  // Дополнение (ревью 218): ещё сервисы и региональные зоны крупных почтовых сервисов.
  'me.com',
  'mac.com',
  'mail.com',
  'email.com',
  'yandex.by',
  'yandex.kz',
  'yandex.ua',
  'yandex.uz',
  'yandex.fr',
  'ukr.net',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'gmx.at',
  'zoho.com',
  'aol.com',
  'msn.com',
  'yahoo.ru',
  'yahoo.de',
  'narod.ru',
  'bk.com',
  'tutanota.com',
  'hey.com',
  'fastmail.com',
]);

/** Домен адреса почты в нижнем регистре; пустая строка, если «@» нет. */
export function emailDomain(address: string): string {
  const email = normalizeEmail(address);
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1);
}
