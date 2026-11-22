import { registrableDomain } from '@business-ai/core';
import { isValidInn } from './kit/domain/requisites';
import { normalizeInn } from './kit/domain/supplier-card';
import { normalizeSupplierName } from './kit/domain/shortlist';

/**
 * Идентичность поставщика для «ещё 10» и пополнения базы (этап 8z). Один и тот же поставщик
 * приходит из базы (карточка), из прайса и из интернета под разными названиями, поэтому
 * сравнение идёт по трём ключам: ИНН (только с верной контрольной суммой), домен сайта и
 * нормализованное название. Совпадение ЛЮБОГО ключа - один поставщик.
 */

/** Префиксы ключей: ключи разных видов не пересекаются в одном множестве. */
const INN_PREFIX = 'inn:';
const DOMAIN_PREFIX = 'dom:';
const NAME_PREFIX = 'name:';

/** Короче этого нормализованное название слишком общее, чтобы считаться ключом. */
const NAME_KEY_MIN_CHARS = 3;

/** Что известно о поставщике; любое поле может отсутствовать. */
export interface SupplierIdentityInput {
  name?: string | undefined;
  /** Адрес сайта или хост; регистрируемый домен берётся из него. */
  url?: string | undefined;
  /** ИНН как написан; ключом становится только ИНН с верной контрольной суммой. */
  inn?: string | undefined;
  /** Дополнительные адреса (ссылки на страницы того же поставщика). */
  extraUrls?: readonly string[] | undefined;
}

/** Ключ домена: регистрируемый домен в нижнем регистре; пусто - не адрес сайта. */
export function domainKeyOf(urlOrHost: string | undefined): string | undefined {
  if (urlOrHost === undefined || urlOrHost.trim() === '') return undefined;
  const domain = registrableDomain(urlOrHost.trim());
  return domain === '' ? undefined : domain.toLowerCase();
}

/** ИНН как цифры, если контрольная сумма верна; иначе undefined. */
export function validInnOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const digits = normalizeInn(raw);
  return isValidInn(digits) ? digits : undefined;
}

/** Ключи идентичности поставщика (без повторов, порядок: ИНН, домены, название). */
export function identityKeysOf(input: SupplierIdentityInput): string[] {
  const keys = new Set<string>();
  const inn = validInnOf(input.inn);
  if (inn !== undefined) keys.add(`${INN_PREFIX}${inn}`);
  for (const url of [input.url, ...(input.extraUrls ?? [])]) {
    const domain = domainKeyOf(url);
    if (domain !== undefined) keys.add(`${DOMAIN_PREFIX}${domain}`);
  }
  const name = input.name === undefined ? '' : normalizeSupplierName(input.name);
  if (name.length >= NAME_KEY_MIN_CHARS) keys.add(`${NAME_PREFIX}${name}`);
  return [...keys];
}

/**
 * Множество уже известных поставщиков: «показанные» и «карточки базы». Поставщик входит,
 * если совпал любой его ключ; добавление объединяет все ключи поставщика, так что позднее
 * найденный ИНН или домен узнаёт того же поставщика.
 */
export class SupplierIdentitySet {
  private readonly keys = new Set<string>();

  /** Подготовленные ключи (из сохранённого состояния). */
  static fromKeys(keys: readonly string[]): SupplierIdentitySet {
    const set = new SupplierIdentitySet();
    for (const key of keys) set.keys.add(key);
    return set;
  }

  /** Известен ли поставщик: совпал хотя бы один ключ. */
  has(input: SupplierIdentityInput): boolean {
    return identityKeysOf(input).some((key) => this.keys.has(key));
  }

  /** Запомнить все ключи поставщика; вернуть, был ли он уже известен. */
  add(input: SupplierIdentityInput): boolean {
    const keys = identityKeysOf(input);
    const known = keys.some((key) => this.keys.has(key));
    for (const key of keys) this.keys.add(key);
    return known;
  }

  /** Ключи для сохранения в состоянии (детерминированный порядок). */
  toKeys(): string[] {
    return [...this.keys].sort();
  }

  get size(): number {
    return this.keys.size;
  }
}
