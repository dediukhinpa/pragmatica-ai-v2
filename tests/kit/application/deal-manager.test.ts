import { expect, test } from 'bun:test';
import { MemoryDealManagerReader } from '../../../src/kit/adapters/memory/deal-manager-reader';
import { resolveBuyerContact } from '../../../src/kit/application/deal-manager';

const REF = 'deal-1';

test('полный контакт: missing пуст', async () => {
  const dealManagers = new MemoryDealManagerReader();
  dealManagers.set(REF, { name: 'Иванов Иван', phone: '+7 1', email: 'a@b.ru' });
  expect(await resolveBuyerContact({ dealManagers }, REF)).toEqual({
    name: 'Иванов Иван',
    phone: '+7 1',
    email: 'a@b.ru',
    missing: [],
  });
});

test('пустые поля попадают в missing', async () => {
  const dealManagers = new MemoryDealManagerReader();
  dealManagers.set(REF, { name: 'Иванов Иван', phone: null, email: null });
  const contact = await resolveBuyerContact({ dealManagers }, REF);
  expect(contact.phone).toBeNull();
  expect(contact.missing).toEqual(['phone', 'email']);
});

test('менеджера нет: всё null и всё в missing', async () => {
  const contact = await resolveBuyerContact({ dealManagers: new MemoryDealManagerReader() }, REF);
  expect(contact).toEqual({
    name: null,
    phone: null,
    email: null,
    missing: ['name', 'phone', 'email'],
  });
});

test('сбой портала пробрасывается', async () => {
  const dealManagers = new MemoryDealManagerReader();
  dealManagers.failing = true;
  await expect(resolveBuyerContact({ dealManagers }, REF)).rejects.toThrow();
});
