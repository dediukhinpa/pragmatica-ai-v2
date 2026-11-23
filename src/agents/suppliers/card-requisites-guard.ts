import { normalizeSupplierCard, type SupplierCard } from '../../kit/domain/supplier-card';
import { sameValue, shown, type EnrichmentConflict } from './card-enrichment-conflicts';
import { cardFromFields, type SupplierCardFields } from './card-fields';

/**
 * Защита реквизитов от подмены письмом (этап 233). Письмо - классический путь подмены
 * банковских реквизитов: «мы сменили счёт». Поэтому реквизиты юрлица и платёжные сведения из
 * письма НЕ ПИШУТСЯ в существующую карточку ни при каком уровне доверия к отправителю, ни в
 * пустые поля, ни поверх записанных: они возвращаются списком, а карточка получает пометку
 * «реквизиты изменились». Применить их может только человек (сотрудник, подтверждающий пункт).
 * Новая карточка из письма - всегда черновик, поэтому реквизиты в неё пишутся как раньше.
 *
 * Вид источника (`origin`) называет модель, поэтому защита на нём не держится (ревью 233): у
 * инструмента дополнения из чата она включена всегда, а реквизит пишется в пустое поле, только
 * если код доказал, что значение взято из присланного сотрудником документа (`proven`).
 */

/** Поля карточки, которые письмо менять не вправе: ИНН/КПП/ОГРН, адрес и банковские реквизиты. */
const EMAIL_PROTECTED_REQUISITES = [
  'inn',
  'kpp',
  'ogrn',
  'legalAddress',
  'bankName',
  'bik',
  'settlementAccount',
  'correspondentAccount',
] as const;
type ProtectedRequisite = (typeof EMAIL_PROTECTED_REQUISITES)[number];

/** Начало текста пометки на карточке: по нему сотрудник и тест узнают пометку. */
export const REQUISITES_CHANGED_PREFIX = 'Реквизиты изменились';

/** Пустой контекст сборки: для приведения полей источника к виду карточки. */
const PROBE = { userId: '', nowIso: '', source: 'email' } as const;

/** Поле это реквизит, защищённый от письма. */
export function isProtectedRequisite(field: string): boolean {
  return EMAIL_PROTECTED_REQUISITES.some((name) => name === field);
}

/** Реквизиты, которые принимает инструмент дополнения из чата (банковские он не принимает). */
export const CHAT_ENRICHABLE_REQUISITES = ['inn', 'kpp', 'ogrn', 'legalAddress'] as const;

/** Результат разбора полей письма для существующей карточки. */
export interface RequisiteSplit {
  /** Поля письма без реквизитов: их можно дописывать. */
  safe: SupplierCardFields;
  /** Реквизиты письма, отличающиеся от записанных (или записываемые в пустые поля). */
  changes: EnrichmentConflict[];
}

/**
 * Отделить реквизиты от прочих полей письма. Совпавшее с карточкой значение изменением не
 * считается (ничего не пишется и не помечается).
 */
export function splitRequisites(
  card: SupplierCard,
  fields: SupplierCardFields,
  proven: ReadonlySet<string> = new Set(),
): RequisiteSplit {
  const safe: SupplierCardFields = { ...fields };
  const changes: EnrichmentConflict[] = [];
  const current = normalizeSupplierCard(card) as unknown as Record<string, unknown>;
  for (const key of EMAIL_PROTECTED_REQUISITES) {
    if (fields[key] === undefined) continue;
    // Доказано кодом: значение из присланного документа. Здесь оно не отделяется; в заполненное
    // поле запись всё равно не идёт (обогащение пишет только пустые).
    if (proven.has(key)) continue;
    delete safe[key];
    const proposed = (
      normalizeSupplierCard(
        cardFromFields({ [key]: fields[key] }, PROBE, 'probe'),
      ) as unknown as Record<string, unknown>
    )[key];
    if (proposed === undefined || proposed === '') continue;
    const was = current[key];
    const empty = was === undefined || was === '';
    if (!empty && sameValue(key, was, proposed)) continue;
    changes.push({ field: key, current: empty ? '' : shown(was), proposed: shown(proposed) });
  }
  return { safe, changes };
}
