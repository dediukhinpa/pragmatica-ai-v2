import { normalizePartyName } from '../../kit/domain/supplier-document';
import type { ContactFields } from './card-fields';
import type { EnrichCardInput } from './enrich-card-tool';

/**
 * Фильтр значений нашей компании при дополнении карточки поставщика из документа (этап 219).
 * В договоре, прайсе и КП рядом стоят реквизиты поставщика и наши: модель может их
 * перепутать, поэтому значения нашей компании код отбрасывает до записи.
 *
 * Сравнение не по полному равенству строк: ИНН/КПП/ОГРН сверяются по цифрам, телефоны - по
 * последним десяти цифрам, адреса, названия и почта - по вхождению нормализованных строк. Строка
 * `OWN_COMPANY_REQUISITES` может быть со словом («ИНН 7701234567», «тел. +7 (900) 123-45-67»):
 * из неё берутся группы цифр. Реквизиты не заданы - поля, которые без них проверить нечем,
 * не пишутся вовсе (fail closed), а не пропускаются.
 */

/** Короче этого вхождение строк не считается совпадением: «5» или «ооо» не наш адрес. */
const MIN_CONTAINMENT_LENGTH = 8;
/** Телефон сравнивается по последним цифрам: «+7», «8» и скобки не важны. */
const PHONE_TAIL_DIGITS = 10;

/** Простые поля, которые нечем проверить без заданных реквизитов нашей компании. */
const REQUISITE_DEPENDENT_KEYS = [
  'inn',
  'kpp',
  'ogrn',
  'legalAddress',
  'address',
  'directorName',
] as const;
/** Цифровые реквизиты: сравниваются по цифрам. */
const CODE_KEYS = ['inn', 'kpp', 'ogrn'] as const;
/** Текстовые поля, сравниваемые по нормализованной строке. */
const TEXT_KEYS = ['name', 'legalAddress', 'address', 'directorName', 'website'] as const;

/** Ключ для сравнения: без регистра, пунктуации, кавычек и пробелов (цифры и буквы остаются). */
function looseKey(text: string): string {
  return normalizePartyName(text).replace(/[^\p{L}\p{N}@]+/gu, '');
}

function digitsOnly(text: string): string {
  return text.replace(/\D+/g, '');
}

/**
 * Числа строки: каждая группа цифр сама по себе и склеенная через пробел, дефис и скобки
 * («7701 234 567», «+7 (900) 123-45-67»). Слова вокруг («ИНН», «тел.») не мешают.
 */
function digitRunsOf(text: string): string[] {
  const normalized = text.normalize('NFKC');
  const runs = new Set<string>();
  for (const part of normalized.match(/\d+/g) ?? []) runs.add(part);
  for (const group of normalized.match(/\d+(?:[ ()-]+\d+)*/g) ?? []) runs.add(digitsOnly(group));
  return [...runs];
}

/** Что убрано из полей и что нельзя было проверить. */
export interface OwnCompanyCleaning {
  fields: EnrichCardInput;
  /** Имена полей, значения которых совпали с нашей компанией (без значений). */
  dropped: string[];
  /** Имена полей, не записанных потому, что реквизиты нашей компании не заданы. */
  unverifiable: string[];
}

/** Значения нашей компании: названия юрлиц и заданные реквизиты (ИНН, КПП, адрес, почта...). */
export class OwnCompanyFilter {
  /** Заданы ли реквизиты: без них проверять ИНН, адреса и контакты нечем. */
  readonly hasRequisites: boolean;
  private readonly textKeys: string[];
  private readonly digitRuns: ReadonlySet<string>;
  private readonly phoneTails: ReadonlySet<string>;

  constructor(names: readonly string[], requisites: readonly string[]) {
    const clean = requisites.filter((item) => item.trim() !== '');
    this.hasRequisites = clean.length > 0;
    this.textKeys = [...names, ...clean].map(looseKey).filter((key) => key !== '');
    const runs = new Set(clean.flatMap(digitRunsOf).filter((run) => run !== ''));
    this.digitRuns = runs;
    this.phoneTails = new Set(
      [...runs]
        .filter((run) => run.length >= PHONE_TAIL_DIGITS)
        .map((run) => run.slice(-PHONE_TAIL_DIGITS)),
    );
  }

  /** Название, адрес, сайт, почта, ФИО: равенство или вхождение нормализованных строк. */
  isOwnText(value: string | undefined): boolean {
    if (value === undefined) return false;
    const key = looseKey(value);
    if (key === '') return false;
    return this.textKeys.some((own) => {
      if (own === key) return true;
      const shortest = Math.min(own.length, key.length);
      return shortest >= MIN_CONTAINMENT_LENGTH && (own.includes(key) || key.includes(own));
    });
  }

  /** ИНН, КПП, ОГРН: по цифрам, форматирование и слова вокруг не важны. */
  isOwnCode(value: string | undefined): boolean {
    if (value === undefined) return false;
    const runs = digitRunsOf(value);
    return runs.some((run) => run !== '' && this.digitRuns.has(run));
  }

  /** Телефон: по последним десяти цифрам. */
  isOwnPhone(value: string | undefined): boolean {
    if (value === undefined) return false;
    const digits = digitsOnly(value);
    if (digits.length < PHONE_TAIL_DIGITS) return digits !== '' && this.digitRuns.has(digits);
    return this.phoneTails.has(digits.slice(-PHONE_TAIL_DIGITS));
  }

  private isOwnContact(contact: ContactFields): boolean {
    return (
      this.isOwnText(contact.email) ||
      this.isOwnPhone(contact.phone) ||
      this.isOwnText(contact.fullName)
    );
  }

  /**
   * Убрать из полей значения нашей компании. Контакт, у которого совпала почта, телефон или
   * ФИО, убирается целиком. Реквизиты не заданы - ИНН, КПП, ОГРН, адреса, ФИО директора,
   * контакты и юрлица с ИНН не пишутся (их нечем проверить).
   */
  clean(fields: EnrichCardInput): OwnCompanyCleaning {
    const kept: EnrichCardInput = { ...fields };
    const dropped: string[] = [];
    const unverifiable: string[] = [];
    const remove = (key: Exclude<keyof EnrichCardInput, 'origin'>, list: string[]): void => {
      delete kept[key];
      list.push(key);
    };
    for (const key of REQUISITE_DEPENDENT_KEYS) {
      if (kept[key] !== undefined && !this.hasRequisites) remove(key, unverifiable);
    }
    for (const key of CODE_KEYS) {
      if (kept[key] !== undefined && this.isOwnCode(kept[key])) remove(key, dropped);
    }
    for (const key of TEXT_KEYS) {
      if (kept[key] !== undefined && this.isOwnText(kept[key])) remove(key, dropped);
    }
    if (kept.contacts !== undefined) {
      if (!this.hasRequisites) remove('contacts', unverifiable);
      else {
        const contacts = kept.contacts.filter((contact) => !this.isOwnContact(contact));
        if (contacts.length !== kept.contacts.length) dropped.push('contacts');
        if (contacts.length > 0) kept.contacts = contacts;
        else delete kept.contacts;
      }
    }
    if (kept.legalEntities !== undefined) {
      const entities = kept.legalEntities.filter(
        (entity) => !this.isOwnText(entity.name) && !this.isOwnCode(entity.inn),
      );
      if (entities.length !== kept.legalEntities.length) dropped.push('legalEntities');
      // ИНН юрлица без заданных реквизитов нашей компании проверить нечем.
      const checked = this.hasRequisites
        ? entities
        : entities.filter((entity) => entity.inn === undefined);
      if (checked.length !== entities.length) unverifiable.push('legalEntities');
      if (checked.length > 0) kept.legalEntities = checked;
      else delete kept.legalEntities;
    }
    return { fields: kept, dropped, unverifiable };
  }
}
