import { describe, expect, test } from 'bun:test';
import { loadSourceResult } from '../../src/agents/order-calc/state';
import { searchKnowledgeSuppliers } from '../../src/agents/order-calc/search-sources';
import type { PurchaseRequest } from '../../src/kit/domain/models';
import type { SupplierCard } from '../../src/kit/domain/supplier-card';
import { CTX } from './support';
import { ORDER_REQUEST, REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

/** Этап 135, тема 3, п. 3: карточки находятся по товару, а не по одному слову признака. */

function card(id: string, name: string, categories: string[], brands: string[] = []): SupplierCard {
  return {
    id,
    name,
    status: 'new',
    contacts: [{ fullName: 'Иван', email: `${id}@example.test`, isPrimary: true }],
    supplies: { categories, brands, regions: [] },
    terms: {},
    notes: [],
  };
}

async function found(
  item: { name: string; searchQueries?: string[] },
  cards: readonly SupplierCard[],
): Promise<string[]> {
  const request: PurchaseRequest = {
    ...ORDER_REQUEST,
    items: [{ quantity: 10, unit: 'шт', ...item }],
  };
  const deps: OrderTestDeps = await buildOrderDeps({ request });
  for (const own of cards) await deps.suppliers.saveCard(own);
  await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
  const result = await loadSourceResult(deps, REQUEST_ID, 'knowledge');
  return (result?.candidates ?? []).map((c) => c.supplierId ?? '').sort();
}

describe('карточки поставщиков: совпадение по товару', () => {
  test('слово признака («ароматический») без слова товара карточку не находит', async () => {
    const ids = await found({ name: 'Ароматическая свеча' }, [
      card('clinok', 'Златоустовский клинок', ['ароматические ножи']),
      card('candles', 'Свечной двор', ['свечи ароматические']),
    ]);
    expect(ids).toEqual(['candles']);
  });

  test('чайная пара: категория целиком находит, чужой по одному слову нет', async () => {
    const ids = await found({ name: 'Чайная пара фарфоровая', searchQueries: ['чайная пара'] }, [
      card('arti', 'Арти м', ['чайная пара фарфор']),
      card('rchk', 'РЧК', ['чайные принадлежности для отелей']),
      card('knives', 'Ножи', ['фарфоровые подарки']),
    ]);
    expect(ids).toContain('arti');
    expect(ids).not.toContain('knives');
  });

  test('два значимых слова позиции в названии и брендах достаточно', async () => {
    const ids = await found({ name: 'Термокружка металлическая' }, [
      card('mugs', 'Посуда', ['кружки'], ['термокружка металлическая Thermos']),
      card('metal', 'Металлургия', ['металлические изделия']),
    ]);
    expect(ids).toContain('mugs');
    expect(ids).not.toContain('metal');
  });

  test('позиция из одного слова ищется по этому слову', async () => {
    const ids = await found({ name: 'Мёд' }, [card('honey', 'Пасека', ['мёд'])]);
    expect(ids).toEqual(['honey']);
  });

  test('дубли карточек одного поставщика склеиваются в одного кандидата', async () => {
    const ids = await found({ name: 'Чайная пара' }, [
      card('mc1', 'More Choice', ['чайная пара']),
      card('mc2', 'ООО «More Choice»', ['чайная пара']),
      card('ruby1', 'Рубин', ['чайная пара']),
      card('ruby2', 'Рубин', ['чайная пара']),
    ]);
    expect(ids).toHaveLength(2);
  });
});
