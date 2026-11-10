import type { DealManagerReader } from '../ports/deal-manager';

/** Зависимости {@link resolveBuyerContact}. */
export interface BuyerContactDeps {
  dealManagers: DealManagerReader;
}

/** Поле контакта «От Заказчика». */
type BuyerContactField = 'name' | 'phone' | 'email';

/**
 * Контакт «От Заказчика». Персональные данные: только для кода сборки договора, не для модели,
 * журналов, заданий и аудита. null в поле - «нет», агент спрашивает у сотрудника.
 */
export interface BuyerContact {
  name: string | null;
  phone: string | null;
  email: string | null;
  /** Какие поля пусты (без значений) - то, что нужно спросить у сотрудника. */
  missing: readonly BuyerContactField[];
}

const FIELDS: readonly BuyerContactField[] = ['name', 'phone', 'email'];

/**
 * Контакт менеджера сделки для договора (`buyer_contact_name/phone/email` в render-data).
 * Менеджер не найден - все поля null и все в `missing`. Сбой портала пробрасывается.
 */
export async function resolveBuyerContact(
  deps: BuyerContactDeps,
  dealRef: string,
): Promise<BuyerContact> {
  const manager = await deps.dealManagers.findDealManager(dealRef);
  const contact = {
    name: manager?.name ?? null,
    phone: manager?.phone ?? null,
    email: manager?.email ?? null,
  };
  return { ...contact, missing: FIELDS.filter((field) => contact[field] === null) };
}
