import { describe, expect, test } from 'bun:test';
import { MemorySupplierRepository } from '../../src/kit/adapters/memory/repositories.owned';
import { applyFieldsToCard } from '../../src/agents/suppliers/card-fields';
import { createAutoSupplierCard } from '../../src/agents/suppliers/draft-card';
import { describeSupplierCard } from '../../src/agents/suppliers/card-view';
import { mergeDraftIntoCard, mergePriceLists } from '../../src/agents/suppliers/draft-merge';
import { isDomainError } from '@business-ai/core';
import { type PriceItem } from '../../src/kit/domain/models';
import { FULL_CARD } from '../kit/support/supplier-fixtures';

const NOW = '2026-10-26T10:00:00.000Z';
const CONTEXT = { userId: 'prices-agent', nowIso: NOW, origin: 'Прайс Альфа.xlsx' };
/** ИНН с верной контрольной суммой. */
const INN = '7707083893';

function price(supplierId: string, productName: string, value: number, date: string): PriceItem {
  return { supplierId, productName, price: value, currency: 'RUB', date };
}

describe('автоматически созданная карточка поставщика', () => {
  test('создаётся сразу боевой, с данными шапки и заметкой об источнике', async () => {
    const suppliers = new MemorySupplierRepository();
    const { card, created } = await createAutoSupplierCard(
      suppliers,
      {
        name: ' ООО «Альфа» ',
        inn: INN,
        phone: '8 (495) 123-45-67',
        website: 'alfa.example.ru',
        city: 'Казань',
      },
      CONTEXT,
    );
    expect(created).toBe(true);
    expect(card).toMatchObject({
      name: 'ООО «Альфа»',
      inn: INN,
      website: 'alfa.example.ru',
      productionCity: 'Казань',
      source: 'file',
      status: 'new',
    });
    expect(card.contacts).toEqual([{ phone: '+74951234567', isPrimary: true }]);
    expect(card.notes[0]?.text).toContain('Создано автоматически: агентом прайсов');
    expect(card.notes[0]?.text).toContain('Прайс Альфа.xlsx');
    expect(describeSupplierCard(card, 'Карточка')).not.toContain('не проверено');
    expect(card).not.toHaveProperty('isDraft');
    expect(await suppliers.getCard(card.id)).not.toHaveProperty('isDraft');
  });

  test('нужно только название; неверные ИНН, телефон и сайт отбрасываются', async () => {
    const suppliers = new MemorySupplierRepository();
    const { card } = await createAutoSupplierCard(
      suppliers,
      { name: 'Бета', inn: '1234567890', phone: '12', website: 'не сайт' },
      CONTEXT,
    );
    expect(card.name).toBe('Бета');
    expect(card).not.toHaveProperty('isDraft');
    expect(card.inn).toBeUndefined();
    expect(card.website).toBeUndefined();
    expect(card.contacts).toEqual([]);
  });

  test('почта из шапки в контакте; неверная отбрасывается, телефон остаётся', async () => {
    const suppliers = new MemorySupplierRepository();
    const good = await createAutoSupplierCard(
      suppliers,
      { name: 'Гамма', phone: '8 (495) 123-45-67', email: 'sales@gamma.example.ru' },
      CONTEXT,
    );
    expect(good.card.contacts).toEqual([
      { phone: '+74951234567', email: 'sales@gamma.example.ru', isPrimary: true },
    ]);
    const bad = await createAutoSupplierCard(
      suppliers,
      { name: 'Дельта', phone: '8 (495) 123-45-67', email: 'не почта' },
      CONTEXT,
    );
    expect(bad.card.contacts).toEqual([{ phone: '+74951234567', isPrimary: true }]);
    const onlyEmail = await createAutoSupplierCard(
      suppliers,
      { name: 'Эпсилон', email: 'info@epsilon.example.ru' },
      CONTEXT,
    );
    expect(onlyEmail.card.contacts).toEqual([
      { email: 'info@epsilon.example.ru', isPrimary: true },
    ]);
  });

  test('пустое название - invalid_input', async () => {
    const suppliers = new MemorySupplierRepository();
    const error = await createAutoSupplierCard(suppliers, { name: '  ' }, CONTEXT).catch(
      (e: unknown) => e,
    );
    expect(isDomainError(error) && error.code).toBe('invalid_input');
  });

  test('повтор и уже существующий поставщик: новая карточка не создаётся', async () => {
    const suppliers = new MemorySupplierRepository();
    const first = await createAutoSupplierCard(suppliers, { name: 'Гамма', inn: INN }, CONTEXT);
    const again = await createAutoSupplierCard(suppliers, { name: 'Гамма', inn: INN }, CONTEXT);
    expect(again.created).toBe(false);
    expect(again.card.id).toBe(first.card.id);
    await suppliers.saveCard({ ...FULL_CARD, id: 'real', name: 'Дельта', inn: '7736050003' });
    const known = await createAutoSupplierCard(
      suppliers,
      { name: 'другое имя', inn: '7736050003' },
      CONTEXT,
    );
    expect(known.created).toBe(false);
    expect(known.card.id).toBe('real');
  });

  test('правка кнопками не добавляет признака черновика', async () => {
    const suppliers = new MemorySupplierRepository();
    const { card } = await createAutoSupplierCard(suppliers, { name: 'Эпсилон' }, CONTEXT);
    const edited = applyFieldsToCard(card, { productionCity: 'Тверь' }, {
      userId: 'u-1',
      nowIso: NOW,
      source: 'chat',
    });
    const saved = await suppliers.saveCard(edited);
    expect(saved).not.toHaveProperty('isDraft');
    expect(saved.productionCity).toBe('Тверь');
  });
});

describe('слияние черновика с настоящей карточкой', () => {
  test('mergeDraftIntoCard: пустое берётся из черновика, заполненное не затирается', () => {
    const target = {
      ...FULL_CARD,
      id: 'real',
      name: 'Настоящая',
      website: undefined,
      productionCity: 'Москва',
    };
    const draft = {
      ...FULL_CARD,
      id: 'draft',
      name: 'Черновик',
      website: 'draft.example.ru',
      productionCity: 'Казань',
      contacts: [{ phone: '+74951234567', isPrimary: true }],
      supplies: { categories: ['кружки', 'ручки'], brands: [], regions: [] },
      turnoverByYear: [{ year: 2025, rub: 1_000_000 }],
      notes: [{ text: 'заметка черновика', authorId: 'a', createdAt: NOW }],
    };
    const merged = mergeDraftIntoCard(target, draft, { userId: 'u-1', nowIso: NOW });
    expect(merged.website).toBe('draft.example.ru');
    expect(merged.productionCity).toBe('Москва');
    expect(merged).not.toHaveProperty('isDraft');
    expect(merged.supplies.categories).toEqual([
      ...FULL_CARD.supplies.categories,
      'кружки',
      'ручки',
    ]);
    expect(merged.contacts).toHaveLength(FULL_CARD.contacts.length + 1);
    expect(merged.contacts.filter((contact) => contact.isPrimary)).toHaveLength(1);
    expect(merged.turnoverByYear).toEqual([{ year: 2025, rub: 1_000_000 }]);
    expect(merged.notes.map((note) => note.text)).toContain('заметка черновика');
    expect(merged.notes.at(-1)?.text).toContain('Объединена с непроверенной карточкой «Черновик»');
  });

  test('mergePriceLists: одинаковые позиции дают одну - с более поздней датой', () => {
    const merged = mergePriceLists(
      'real',
      [
        price('real', 'Кружка', 100, '2026-01-01T00:00:00Z'),
        price('real', 'Ручка', 10, '2026-05-01T00:00:00Z'),
      ],
      [
        price('draft', 'кружка', 90, '2026-06-01T00:00:00Z'),
        price('draft', 'Ручка', 9, '2026-02-01T00:00:00Z'),
        price('draft', 'Блокнот', 50, '2026-03-01T00:00:00Z'),
      ],
    );
    expect(merged.map((item) => [item.productName, item.price, item.supplierId])).toEqual([
      ['кружка', 90, 'real'],
      ['Ручка', 10, 'real'],
      ['Блокнот', 50, 'real'],
    ]);
  });
});
