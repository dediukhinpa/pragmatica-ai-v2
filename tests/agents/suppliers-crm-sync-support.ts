import { FixedClock, MemoryAuditRepository, MemoryWorkflowStateStore } from '@business-ai/adapters';
import { MemoryCrmSuppliers } from '../../src/kit/adapters/memory/crm-suppliers';
import { MemorySupplierRepository } from '../../src/kit/adapters/memory/repositories.owned';
import {
  cardFromFields,
  newCardId,
  type SupplierCardFields,
} from '../../src/agents/suppliers/card-fields';
import {
  type SupplierCrmSyncDeps,
  type SupplierCrmSyncOptions,
} from '../../src/agents/suppliers/crm-sync';
import type { SupplierCard } from '../../src/kit/domain/supplier-card';
import type { CrmSupplierCompany } from '../../src/kit/ports/crm-suppliers';

/** Общая сборка для тестов синхронизации с CRM (этап 221); данные синтетические. */

/** Условный момент запуска разового прохода. */
export const MONDAY_NOON = new Date('2026-10-12T09:00:00.000Z');
export const OUR_INN = '7701234567';
export const OUR_PHONE = '+7 (900) 123-45-67';
/** Параметры прохода в тестах: пауз между порциями нет. */
export const OPTIONS: SupplierCrmSyncOptions = { pauseMs: 0 };

export interface World {
  deps: SupplierCrmSyncDeps;
  clock: FixedClock;
  state: MemoryWorkflowStateStore;
  suppliers: MemorySupplierRepository;
  crm: MemoryCrmSuppliers;
  audit: MemoryAuditRepository;
  logs: Array<{ event: string; fields: Record<string, unknown> }>;
}

export function build(
  overrides: Partial<SupplierCrmSyncDeps> = {},
  start = MONDAY_NOON,
  passes?: readonly string[],
): World {
  const clock = new FixedClock(start);
  const state = new MemoryWorkflowStateStore();
  const suppliers = new MemorySupplierRepository(() => clock.now().toISOString());
  const crm = new MemoryCrmSuppliers(passes);
  const audit = new MemoryAuditRepository();
  const logs: World['logs'] = [];
  const deps: SupplierCrmSyncDeps = {
    suppliers,
    state,
    clock,
    crm,
    ownCompanyNames: ['ООО «Наша Компания»'],
    ownCompanyRequisites: [`ИНН ${OUR_INN}`, OUR_PHONE, 'zakupki@company.test'],
    audit,
    log: (event, fields = {}) => logs.push({ event, fields }),
    ...overrides,
  };
  return { deps, clock, state, suppliers, crm, audit, logs };
}

/** Время изменения с шагом в минуту от 1 октября. */
export function at(minute: number): string {
  return new Date(Date.UTC(2026, 9, 1, 9, minute)).toISOString();
}

export function company(
  id: number,
  minute: number,
  extra: Partial<CrmSupplierCompany> = {},
): CrmSupplierCompany {
  return {
    id: String(id),
    title: `Поставщик ${id}`,
    modifiedAt: at(minute),
    websites: [],
    emails: [],
    phones: [],
    contacts: [],
    ...extra,
  };
}

export async function allCards(world: World): Promise<SupplierCard[]> {
  return world.suppliers.searchCards({ limit: 50 });
}

export async function seed(world: World, fields: SupplierCardFields): Promise<SupplierCard> {
  const base = cardFromFields(
    fields,
    { userId: 'seed', nowIso: '2026-10-01T09:00:00.000Z', source: 'chat' },
    newCardId(fields),
  );
  return world.suppliers.saveCard(base, { createOnly: true });
}
