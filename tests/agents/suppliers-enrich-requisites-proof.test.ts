import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryAccessPolicy } from '@business-ai/adapters';
import {
  cardFromFields,
  newCardId,
  type SupplierCardFields,
} from '../../src/agents/suppliers/card-fields';
import { enrichSupplierCard } from '../../src/agents/suppliers/enrich-card-tool';
import { noteAttachmentText } from '../../src/agents/suppliers/document-source-text';
import { ACTION_CONFIRM_SUPPLIER_CARD } from '../../src/kit/domain/access.owned';
import { type SupplierCard } from '../../src/kit/domain/supplier-card';
import {
  BOT_PRICES,
  INN_ALPHA,
  THREAD_A,
  USER_A,
  buildSupplierWorld,
  turnContext,
  type SupplierWorld,
} from './suppliers-support';

/**
 * Защита реквизитов в `enrichSupplierCard` не зависит от `origin`, который выбирает модель
 * (ревью 233). Реквизит пишется в пустое поле существующей карточки, только если код доказал:
 * значение взято из документа, присланного сотрудником в чат (текст прочитанных вложений треда,
 * письма среди них нет). Остальное - на подтверждение сотрудника.
 */

let world: SupplierWorld;
beforeEach(() => {
  world = buildSupplierWorld();
  const access = new MemoryAccessPolicy();
  access.allow({ userId: USER_A, botId: BOT_PRICES, action: ACTION_CONFIRM_SUPPLIER_CARD });
  world.deps.access = access;
});

const ctx = () => turnContext(USER_A, THREAD_A);

async function seedBare(): Promise<SupplierCard> {
  const fields: SupplierCardFields = {
    name: 'Альфа Снаб',
    contacts: [{ email: 'a@alfa.example' }],
  };
  const card = cardFromFields(
    fields,
    { userId: 'seed', nowIso: '2026-05-01T09:00:00.000Z', source: 'chat' },
    newCardId(fields),
  );
  return world.suppliers.saveCard(card, { createOnly: true });
}

const stored = async (id: string): Promise<SupplierCard> => {
  const card = await world.suppliers.getCard(id);
  if (card === null) throw new Error('карточки нет');
  return card;
};

const CONTRACT = [
  'ДОГОВОР ПОСТАВКИ № 15',
  'Поставщик: ООО «Альфа Снаб», сайт https://alfa.example',
  `ИНН ${INN_ALPHA}, юридический адрес: г. Тестоград, ул. Договорная, 7`,
].join('\n');

const FORWARDED_LETTER = [
  'Добрый день! Мы сменили реквизиты, сайт https://alfa.example',
  `Наш ИНН ${INN_ALPHA}, юридический адрес: г. Подмена, ул. Новая, 1`,
].join('\n');

function input(supplierId: string, sourceText: string, origin: 'document' | 'file' | 'email') {
  return {
    supplierId,
    origin,
    sourceText,
    inn: INN_ALPHA,
    website: 'https://alfa.example',
  };
}

describe('enrichSupplierCard: реквизиты не зависят от origin модели', () => {
  test('письмо под видом document: ИНН не пишется, пометка, прочее пишется', async () => {
    const card = await seedBare();
    const out = await enrichSupplierCard.execute(
      input(card.id, FORWARDED_LETTER, 'document'),
      world.host,
      ctx(),
    );
    expect(out.withheld).toEqual(['inn']);
    expect(out.added).toEqual(['website']);
    expect(out.message).toContain('prepareSupplierCardEdit');
    const saved = await stored(card.id);
    expect(saved.inn).toBeUndefined();
    const note = saved.notes.find((item) => item.text.includes('Реквизиты изменились'));
    expect(note).toBeDefined();
    // Пометка называет поля и источник, но не значения.
    expect(note?.text).toContain('inn');
    expect(note?.text).not.toContain(INN_ALPHA);
    expect(JSON.stringify(out)).not.toContain(INN_ALPHA);
  });

  test('юрадрес из пересланного письма тоже не пишется в пустое поле', async () => {
    const card = await seedBare();
    const out = await enrichSupplierCard.execute(
      {
        supplierId: card.id,
        origin: 'file',
        sourceText: FORWARDED_LETTER,
        legalAddress: 'г. Подмена, ул. Новая, 1',
      },
      world.host,
      ctx(),
    );
    expect(out.withheld).toEqual(['legalAddress']);
    expect((await stored(card.id)).legalAddress).toBeUndefined();
  });

  for (const origin of ['document', 'file'] as const) {
    test(`документ из чата (origin=${origin}): реквизиты пишутся в пустые поля`, async () => {
      const card = await seedBare();
      await noteAttachmentText(world.state, THREAD_A, [{ name: 'Договор.docx', text: CONTRACT }]);
      const out = await enrichSupplierCard.execute(
        {
          supplierId: card.id,
          origin,
          sourceText: CONTRACT,
          inn: INN_ALPHA,
          legalAddress: 'г. Тестоград, ул. Договорная, 7',
        },
        world.host,
        ctx(),
      );
      expect(out.withheld).toBeUndefined();
      expect([...out.added].sort()).toEqual(['inn', 'legalAddress']);
      expect((await stored(card.id)).inn).toBe(INN_ALPHA);
    });
  }

  test('значения нет в присланных файлах (только в sourceText модели): не доказано', async () => {
    const card = await seedBare();
    await noteAttachmentText(world.state, THREAD_A, [
      { name: 'Договор.docx', text: 'Договор без реквизитов поставщика' },
    ]);
    const out = await enrichSupplierCard.execute(
      input(card.id, FORWARDED_LETTER, 'document'),
      world.host,
      ctx(),
    );
    expect(out.withheld).toEqual(['inn']);
    expect((await stored(card.id)).inn).toBeUndefined();
  });

  test('среди вложений было письмо (.eml): доказать нельзя, даже если текст совпал', async () => {
    const card = await seedBare();
    await noteAttachmentText(world.state, THREAD_A, [
      { name: 'Договор.docx', text: CONTRACT },
      { name: 'Новые реквизиты.eml', text: FORWARDED_LETTER },
    ]);
    const out = await enrichSupplierCard.execute(
      input(card.id, CONTRACT, 'document'),
      world.host,
      ctx(),
    );
    expect(out.withheld).toEqual(['inn']);
    expect((await stored(card.id)).inn).toBeUndefined();
  });

  test('вложение с заголовками письма в тексте тоже считается письмом', async () => {
    const card = await seedBare();
    const letter = `От: sales@alfa.example\nТема: Новые реквизиты\n\n${FORWARDED_LETTER}`;
    await noteAttachmentText(world.state, THREAD_A, [{ name: 'вложение.txt', text: letter }]);
    const out = await enrichSupplierCard.execute(
      input(card.id, FORWARDED_LETTER, 'document'),
      world.host,
      ctx(),
    );
    expect(out.withheld).toEqual(['inn']);
  });

  test('модель назвала origin=email: реквизиты защищены, даже если документ доказан', async () => {
    const card = await seedBare();
    await noteAttachmentText(world.state, THREAD_A, [{ name: 'Договор.docx', text: CONTRACT }]);
    const out = await enrichSupplierCard.execute(
      input(card.id, CONTRACT, 'email'),
      world.host,
      ctx(),
    );
    expect(out.withheld).toEqual(['inn']);
    expect((await stored(card.id)).inn).toBeUndefined();
  });

  test('нет записи о вложениях (слова сотрудника): fail closed, на подтверждение', async () => {
    const card = await seedBare();
    const out = await enrichSupplierCard.execute(
      { supplierId: card.id, origin: 'file', messageText: `ИНН ${INN_ALPHA}`, inn: INN_ALPHA },
      world.host,
      ctx(),
    );
    expect(out.withheld).toEqual(['inn']);
    expect((await stored(card.id)).inn).toBeUndefined();
  });
});
