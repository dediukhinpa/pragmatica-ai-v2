import { describe, expect, test } from 'bun:test';
import { MemorySupplierRepository } from '../../src/kit/adapters/memory/repositories.owned';
import {
  buildSupplierEmailIndex,
  findSuppliersByAddress,
  listAllSuppliers,
  suppliersByAddress,
} from '../../src/agents/shared/supplier-email-index';

describe('индекс адресов поставщиков', () => {
  test('регистр не важен, поставщики без адреса не находятся', async () => {
    const repo = new MemorySupplierRepository();
    await repo.upsert({ id: 's1', name: 'Альфа', email: 'Sales@Alpha.Example' });
    await repo.upsert({ id: 's2', name: 'Без адреса' });
    const index = await buildSupplierEmailIndex(repo, ['SALES@alpha.example', 'other@x.example']);
    expect(index.size).toBe(1);
    expect(suppliersByAddress(index, 'sales@alpha.example').map((s) => s.id)).toEqual(['s1']);
    expect(suppliersByAddress(index, ' SALES@ALPHA.EXAMPLE ').map((s) => s.id)).toEqual(['s1']);
    expect(suppliersByAddress(index, 'other@alpha.example')).toEqual([]);
  });

  test('один адрес у нескольких поставщиков даёт всех', async () => {
    const repo = new MemorySupplierRepository();
    await repo.upsert({ id: 's1', name: 'Альфа', email: 'shared@x.example' });
    await repo.upsert({ id: 's2', name: 'Бета', email: 'SHARED@x.example' });
    const index = await buildSupplierEmailIndex(repo, ['shared@x.example']);
    expect(suppliersByAddress(index, 'shared@x.example').map((s) => s.id).sort()).toEqual([
      's1',
      's2',
    ]);
  });

  test('R6-06-06: поставщик после 2000-го по названию находится по адресу', async () => {
    const repo = new MemorySupplierRepository();
    const LAST = 2_001;
    for (let i = 0; i < LAST; i += 1) {
      const num = String(i).padStart(5, '0');
      await repo.upsert({ id: `s${num}`, name: `Поставщик ${num}`, email: `p${num}@x.example` });
    }
    const lastNum = String(LAST - 1).padStart(5, '0');
    const index = await buildSupplierEmailIndex(repo, [`p${lastNum}@x.example`]);
    expect([...index.values()].flat().map((s) => s.id)).toEqual([`s${lastNum}`]);
  });

  test('адрес второго контакта карточки тоже привязывает поставщика', async () => {
    const repo = new MemorySupplierRepository();
    await repo.saveCard({
      id: 's1',
      name: 'Альфа',
      status: 'new',
      contacts: [
        { email: 'main@alpha.example', isPrimary: true },
        { email: 'Buyer@Alpha.example', isPrimary: false },
      ],
      supplies: { categories: [], brands: [], regions: [] },
      terms: {},
      notes: [],
    });
    const found = await findSuppliersByAddress(repo, 'buyer@alpha.example');
    expect(found.map((s) => s.id)).toEqual(['s1']);
  });

  test('больше пачки адресов: все найдены, повторы не дублируют поставщика', async () => {
    const repo = new MemorySupplierRepository();
    const addresses: string[] = [];
    for (let i = 0; i < 1_200; i += 1) {
      await repo.upsert({ id: `s${i}`, name: `П${i}`, email: `p${i}@x.example` });
      addresses.push(`p${i}@x.example`, `P${i}@X.example`);
    }
    const index = await buildSupplierEmailIndex(repo, addresses);
    expect(index.size).toBe(1_200);
    expect([...index.values()].every((list) => list.length === 1)).toBe(true);
  });

  test('listAllSuppliers обходит всех страницами', async () => {
    const repo = new MemorySupplierRepository();
    for (let i = 0; i < 25; i += 1) {
      await repo.upsert({ id: `s${String(i).padStart(2, '0')}`, name: `П${i}` });
    }
    const all = await listAllSuppliers(repo, 10);
    expect(all.map((s) => s.id)).toHaveLength(25);
    expect(new Set(all.map((s) => s.id)).size).toBe(25);
  });
});
