import { z } from 'zod';

/**
 * Сведения о поставщике базы, найденные в интернете (реестры юрлиц и сайт поставщика).
 * Живут только в состоянии и в сообщении менеджеру: в карточку поставщика их записывает
 * сотрудник через существующую правку карточки, сам код карточку не меняет. ФИО руководителя
 * с реестра сюда не попадает никогда.
 */

/** Срок хранения результата обогащения в кэше, дней: повторно за тех же не платим. */
export const SUPPLIER_ENRICH_CACHE_DAYS = 30;

/**
 * Единый индикатор шорт-листа: параметр взят из интернета (веб-поиск, чтение страницы,
 * обогащение карточки). Заглавными, как просил заказчик (08.11); другой формулировки для
 * этого нигде нет: ни «из интернета», ни «по данным сайта», ни «веб».
 */
export const WEB_SOURCE_MARK = 'ИЗ ИНТЕРНЕТА';
/** Пометка совпадения только по названию: у названий-тёзок бывают разные города. */
export const ENRICH_NAME_MATCH_NOTE = 'совпадение по названию, проверьте';
/** Пометка почты из интернета в тексте запроса поставщику. */
export const ENRICH_EMAIL_REVIEW_NOTE = 'из интернета, проверьте';

/**
 * Как найденное сопоставлено с поставщиком: `inn` - ИНН страницы реестра совпал с карточкой;
 * `name` - только по названию (проверить); `site` - с сайта, указанного в самой карточке.
 */
export const ENRICH_MATCHES = ['inn', 'name', 'site'] as const;
export type EnrichMatch = (typeof ENRICH_MATCHES)[number];

/** Найденное: только то, что нужно сотруднику; ФИО людей не хранится. */
export interface SupplierEnrichment {
  match: EnrichMatch;
  city?: string | undefined;
  address?: string | undefined;
  phone?: string | undefined;
  email?: string | undefined;
  site?: string | undefined;
  /** ИНН и ОГРН страницы: нужны, чтобы предложить сохранить их в карточку при совпадении. */
  inn?: string | undefined;
  ogrn?: string | undefined;
}

export const supplierEnrichmentSchema: z.ZodType<SupplierEnrichment, z.ZodTypeDef, unknown> =
  z.object({
    match: z.enum(ENRICH_MATCHES),
    city: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    phone: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    site: z.string().min(1).optional(),
    inn: z.string().min(1).optional(),
    ogrn: z.string().min(1).optional(),
  });

/** Есть ли в найденном хоть одно полезное сведение (кроме самих реквизитов). */
export function hasEnrichmentData(value: SupplierEnrichment): boolean {
  return [value.city, value.phone, value.email, value.site].some((item) => item !== undefined);
}

/** Контакты найденного одной строкой: телефон, почта. */
export function enrichmentContactsLine(value: SupplierEnrichment): string {
  return [value.phone, value.email].filter((item) => item !== undefined).join(', ');
}

/** Значение с пометкой источника: «Казань (ИЗ ИНТЕРНЕТА)». */
export function withWebNote(text: string): string {
  return `${text} (${WEB_SOURCE_MARK})`;
}
