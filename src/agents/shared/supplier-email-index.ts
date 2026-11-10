import type { Supplier } from '../../kit/domain/models';
import type { SupplierRepository } from '../../kit/ports/repositories.owned';

/** Сколько адресов спрашивается у базы поставщиков одним запросом. */
const ADDRESS_LOOKUP_BATCH = 500;

/** Адрес (нижний регистр) -> поставщики с этим адресом. */
export type SupplierEmailIndex = ReadonlyMap<string, readonly Supplier[]>;

/** Привести адрес к виду ключа индекса. */
function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Индекс «адрес -> поставщики» для заданных адресов (единое правило привязки письма к
 * поставщику: все почтовые модули идут через него). Адрес сопоставляется с прежним `email`
 * и с адресом любого контакта; перечня поставщиков с лимитом нет, поэтому поставщик не
 * выпадает в «хвосте» большой базы. Регистр адреса не важен; один адрес у нескольких
 * поставщиков даёт всех (решение при неоднозначности - за вызывающим). В индексе только
 * найденные адреса.
 */
export async function buildSupplierEmailIndex(
  suppliers: SupplierRepository,
  addresses: Iterable<string>,
): Promise<SupplierEmailIndex> {
  const wanted = [...new Set([...addresses].map(normalizeAddress).filter((a) => a !== ''))];
  const index = new Map<string, Supplier[]>();
  for (let from = 0; from < wanted.length; from += ADDRESS_LOOKUP_BATCH) {
    const batch = wanted.slice(from, from + ADDRESS_LOOKUP_BATCH);
    for (const { address, supplier } of await suppliers.findByAddresses(batch)) {
      const key = normalizeAddress(address);
      const bucket = index.get(key);
      if (bucket === undefined) index.set(key, [supplier]);
      else if (!bucket.some((item) => item.id === supplier.id)) bucket.push(supplier);
    }
  }
  return index;
}

/** Поставщики с этим адресом (регистр не важен); пусто, если адрес не из базы поставщиков. */
export function suppliersByAddress(
  index: SupplierEmailIndex,
  address: string,
): readonly Supplier[] {
  return index.get(normalizeAddress(address)) ?? [];
}

/** Поставщики одного адреса запросом к базе (то же правило, что и у индекса). */
export async function findSuppliersByAddress(
  suppliers: SupplierRepository,
  address: string,
): Promise<readonly Supplier[]> {
  return suppliersByAddress(await buildSupplierEmailIndex(suppliers, [address]), address);
}

/**
 * Обойти всех поставщиков страницами по `id` без лимита выборки (для обязанностей, которым
 * нужен весь список: напоминания, сопоставление файлов по названию).
 */
export async function listAllSuppliers(
  suppliers: SupplierRepository,
  pageSize: number = SUPPLIER_LIST_PAGE,
): Promise<Supplier[]> {
  const all: Supplier[] = [];
  let after: string | null = null;
  for (;;) {
    const page: Supplier[] = await suppliers.listPage(after, pageSize);
    all.push(...page);
    const last = page[page.length - 1];
    if (last === undefined || page.length < pageSize) return all;
    after = last.id;
  }
}

/** Поставщиков за одно обращение при полном обходе. */
const SUPPLIER_LIST_PAGE = 500;
