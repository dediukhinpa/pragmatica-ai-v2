import { DomainError } from '@business-ai/core';
import { CRM_SUPPLIERS_CURSOR_MARGIN_MS } from '../../ports/crm-suppliers';
import type {
  CrmSupplierCompany,
  CrmSuppliersCursor,
  CrmSuppliers,
  CrmSuppliersPage,
  CrmSuppliersQuery,
} from '../../ports/crm-suppliers';

/** Сколько компаний за одно чтение отдаёт заглушка, если запрос не ограничивает. */
const DEFAULT_PAGE_LIMIT = 50;

/** Порядок курсора: время изменения, затем числовой id (как в адаптере портала). */
function compareCompanies(left: CrmSupplierCompany, right: CrmSupplierCompany): number {
  const byTime = Date.parse(left.modifiedAt) - Date.parse(right.modifiedAt);
  return byTime !== 0 ? byTime : Number(left.id) - Number(right.id);
}

/** Единственный проход заглушки, если проходы не заданы. */
const DEFAULT_PASS = 'default';

/** Строка заглушки: компания и проходы, под признак которых она подходит. */
interface Entry {
  company: CrmSupplierCompany;
  passes: ReadonlySet<string>;
}

/** Порция: повторно читаемые компании, затем новые не больше предела. */
function pageOf(
  replay: readonly CrmSupplierCompany[],
  fresh: readonly CrmSupplierCompany[],
  viewedUntil: CrmSuppliersCursor | null,
  hasMore: boolean,
): CrmSuppliersPage {
  return {
    companies: [
      ...replay.map((company) => ({ ...structuredClone(company), replayed: true })),
      ...fresh.map((company) => structuredClone(company)),
    ],
    hasMore,
    viewedUntil,
    markerMismatch: 0,
  };
}

/**
 * Компании-поставщики CRM в памяти (заглушка и тестовый двойник): состав задаётся вручную.
 * Проходы (признаки «поставщик») - как у адаптера портала: компания, подходящая под несколько,
 * отдаётся первым из подходящих проходов, остальные проходят мимо неё.
 */
export class MemoryCrmSuppliers implements CrmSuppliers {
  private readonly entries = new Map<string, Entry>();
  readonly passes: readonly string[];
  /** Сколько раз читали список. */
  calls = 0;
  /** Имитация сбоя портала. */
  failing = false;

  constructor(passes: readonly string[] = [DEFAULT_PASS]) {
    if (passes.length === 0) throw new Error('Нужен хотя бы один проход.');
    this.passes = passes;
  }

  /**
   * Добавить или заменить компанию (служебный метод заглушки). `memberOf` - проходы, под признак
   * которых она подходит; не задано - все проходы.
   */
  set(company: CrmSupplierCompany, memberOf: readonly string[] = this.passes): void {
    this.entries.set(company.id, {
      company: structuredClone(company),
      passes: new Set(memberOf),
    });
  }

  /** Убрать компанию (служебный метод заглушки). */
  delete(id: string): void {
    this.entries.delete(id);
  }

  async listSupplierCompanies(query: CrmSuppliersQuery): Promise<CrmSuppliersPage> {
    query.signal?.throwIfAborted();
    this.calls += 1;
    if (this.failing) {
      throw new DomainError('external_failure', 'CRM недоступна: компании не прочитать.', {
        retryable: true,
      });
    }
    const passIndex = query.pass === undefined ? 0 : this.passes.indexOf(query.pass);
    const pass = this.passes[passIndex];
    if (pass === undefined) {
      throw new DomainError('invalid_input', 'Неизвестный проход чтения поставщиков CRM.');
    }
    const earlier = this.passes.slice(0, passIndex);
    const limit = query.limit > 0 ? query.limit : DEFAULT_PAGE_LIMIT;
    // Строки прохода по порядку курсора; покрытые более ранним проходом - с пометкой.
    const ordered = [...this.entries.values()]
      .filter((entry) => entry.passes.has(pass))
      .map((entry) => ({
        company: entry.company,
        covered: earlier.some((other) => entry.passes.has(other)),
      }))
      .sort((left, right) => compareCompanies(left.company, right.company));
    const after = query.after;
    const isFresh = (company: CrmSupplierCompany): boolean => {
      if (after === null) return true;
      const byTime = Date.parse(company.modifiedAt) - Date.parse(after.modifiedAt);
      return byTime > 0 || (byTime === 0 && Number(company.id) > Number(after.id));
    };
    // Как у адаптера портала: запас по времени перед курсором читается повторно (replayed) и
    // не занимает предел порции.
    const floor =
      after === null ? null : Date.parse(after.modifiedAt) - CRM_SUPPLIERS_CURSOR_MARGIN_MS;
    const replay = ordered
      .filter(
        (row) =>
          !row.covered &&
          !isFresh(row.company) &&
          floor !== null &&
          Date.parse(row.company.modifiedAt) >= floor,
      )
      .map((row) => row.company);
    const fresh: CrmSupplierCompany[] = [];
    let viewedUntil: CrmSuppliersCursor | null = null;
    let hasMore = false;
    for (const row of ordered.filter((item) => isFresh(item.company))) {
      if (!row.covered && fresh.length >= limit) {
        hasMore = true;
        break;
      }
      if (!row.covered) fresh.push(row.company);
      viewedUntil = { modifiedAt: row.company.modifiedAt, id: row.company.id };
    }
    return pageOf(replay, fresh, viewedUntil, hasMore);
  }
}
