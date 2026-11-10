import {
  PRICE_SCRIPT_KEEP_VERSIONS,
  type NewSupplierPriceScript,
  type SupplierPriceScript,
  type SupplierPriceScriptRepository,
} from '../../ports/supplier-price-scripts';

/** Скрипты разбора прайсов в памяти: версии растут, хранятся последние пять на форму. */
export class MemorySupplierPriceScripts implements SupplierPriceScriptRepository {
  private readonly byKey = new Map<string, SupplierPriceScript[]>();

  private static key(supplierId: string, formHash: string): string {
    return `${supplierId}\u0000${formHash}`;
  }

  async findLatest(supplierId: string, formHash: string): Promise<SupplierPriceScript | null> {
    const versions = this.byKey.get(MemorySupplierPriceScripts.key(supplierId, formHash));
    const last = versions?.[versions.length - 1];
    return last === undefined ? null : { ...last };
  }

  async save(script: NewSupplierPriceScript): Promise<SupplierPriceScript> {
    const key = MemorySupplierPriceScripts.key(script.supplierId, script.formHash);
    const versions = this.byKey.get(key) ?? [];
    const saved: SupplierPriceScript = {
      ...script,
      version: (versions[versions.length - 1]?.version ?? 0) + 1,
    };
    this.byKey.set(key, [...versions, saved].slice(-PRICE_SCRIPT_KEEP_VERSIONS));
    return { ...saved };
  }

  /** Все хранимые версии пары, от старых к новым (для проверок в тестах). */
  versions(supplierId: string, formHash: string): SupplierPriceScript[] {
    return (this.byKey.get(MemorySupplierPriceScripts.key(supplierId, formHash)) ?? []).map(
      (item) => ({ ...item }),
    );
  }
}
