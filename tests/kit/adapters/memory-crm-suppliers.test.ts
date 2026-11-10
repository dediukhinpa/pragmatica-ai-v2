import { expect, test } from 'bun:test';
import { MemoryCrmSuppliers } from '../../../src/kit/adapters/memory/crm-suppliers';
import type { CrmSupplierCompany } from '../../../src/kit/ports/crm-suppliers';

/** Заглушка CRM в памяти: проходы по признакам «поставщик» (этап 221), как у адаптера портала. */

const FIRST = 'category-8';
const SECOND = 'companyType-SUPPLIER';

function company(id: number, minute: number): CrmSupplierCompany {
  return {
    id: String(id),
    title: `Поставщик ${id}`,
    modifiedAt: new Date(Date.UTC(2026, 9, 1, 9, minute)).toISOString(),
    websites: [],
    emails: [],
    phones: [],
    contacts: [],
  };
}

test('без настройки один проход; состав по умолчанию - во всех проходах', async () => {
  const crm = new MemoryCrmSuppliers();
  expect(crm.passes).toHaveLength(1);
  crm.set(company(1, 1));
  expect((await crm.listSupplierCompanies({ after: null, limit: 5 })).companies).toHaveLength(1);
});

test('компания в обоих проходах отдаётся первым, второй проходит мимо', async () => {
  const crm = new MemoryCrmSuppliers([FIRST, SECOND]);
  crm.set(company(1, 1), [SECOND]);
  crm.set(company(2, 2), [FIRST]);
  crm.set(company(3, 3), [FIRST, SECOND]);
  const first = await crm.listSupplierCompanies({ pass: FIRST, after: null, limit: 10 });
  const second = await crm.listSupplierCompanies({ pass: SECOND, after: null, limit: 10 });
  expect(first.companies.map((item) => item.id)).toEqual(['2', '3']);
  expect(second.companies.map((item) => item.id)).toEqual(['1']);
  expect(second.viewedUntil).toEqual({ modifiedAt: company(3, 3).modifiedAt, id: '3' });
});

test('проход целиком покрыт первым: пусто, но курсор просмотра двигается', async () => {
  const crm = new MemoryCrmSuppliers([FIRST, SECOND]);
  crm.set(company(1, 1), [FIRST, SECOND]);
  const page = await crm.listSupplierCompanies({ pass: SECOND, after: null, limit: 10 });
  expect(page.companies).toEqual([]);
  expect(page.viewedUntil).toEqual({ modifiedAt: company(1, 1).modifiedAt, id: '1' });
});

test('неизвестный проход - ошибка', async () => {
  const crm = new MemoryCrmSuppliers([FIRST]);
  await expect(
    crm.listSupplierCompanies({ pass: 'other', after: null, limit: 5 }),
  ).rejects.toThrow();
});
