import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryAccessPolicy } from '@business-ai/adapters';
import {
  cardFromFields,
  newCardId,
  type SupplierCardFields,
} from '../../src/agents/suppliers/card-fields';
import { createDocumentsAgent } from '../../src/agents/documents/declaration';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import { createPricesAgent } from '../../src/agents/prices/declaration';
import { createSiteExportAgent } from '../../src/agents/site-export/declaration';
import { enrichSupplierCard } from '../../src/agents/suppliers/enrich-card-tool';
import { findDigitSeries } from '@business-ai/core';
import { supplierCardsTools } from '../../src/agents/suppliers/tools';
import { noteAttachmentText } from '../../src/agents/suppliers/document-source-text';
import { ACTION_CONFIRM_SUPPLIER_CARD } from '../../src/kit/domain/access.owned';
import { type SupplierCard } from '../../src/kit/domain/supplier-card';
import {
  BOT_PRICES,
  INN_ALPHA,
  INN_BETA,
  INN_BROKEN,
  SCHEDULER_CONTEXT,
  SwitchableAccess,
  THREAD_A,
  USER_A,
  USER_B,
  buildSupplierWorld,
  turnContext,
  type SupplierWorld,
} from './suppliers-support';

/**
 * Инструмент `enrichSupplierCard` (этап 218): дополняет существующую карточку сведениями из
 * присланного материала без вопросов, но только пустые поля и только значениями, найденными в
 * источнике; расхождения с карточкой возвращает модели.
 */

let world: SupplierWorld;
let access: MemoryAccessPolicy;
beforeEach(() => {
  world = buildSupplierWorld();
  access = new MemoryAccessPolicy();
  access.allow({ userId: USER_A, botId: BOT_PRICES, action: ACTION_CONFIRM_SUPPLIER_CARD });
  world.deps.access = access;
});

const ctx = () => turnContext(USER_A, THREAD_A);

async function seed(fields: SupplierCardFields): Promise<SupplierCard> {
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

const LETTER = [
  'Здравствуйте! Наш сайт: https://alfa.example',
  'Отдел продаж: sales@alfa.example, тел. +7 (900) 123-45-67',
  'Условия: предоплата 50%, доставка за наш счёт.',
].join('\n');

/** Минимальный вход: сайт из письма. */
const SIMPLE = {
  website: 'https://alfa.example',
  sourceText: LETTER,
  origin: 'email' as const,
};

describe('enrichSupplierCard: описание инструмента', () => {
  test('побочный эффект, повтор только по кнопке, регистрация в наборе модуля', () => {
    expect(enrichSupplierCard.sideEffect).toBe(true);
    expect(enrichSupplierCard.replay).toBe('confirm');
    expect(supplierCardsTools().map((tool) => tool.name)).toContain('enrichSupplierCard');
  });

  test('есть у четырёх агентов с карточками; у документов - своя обёртка только для договора', () => {
    const names = (tools: ReadonlyArray<{ name: string }>): string[] =>
      tools.map((tool) => tool.name);
    const model = 'm';
    const withCards = [
      createPricesAgent({ model, supplierCards: {} }),
      createOrderCalcAgent({ model, supplierCards: {} }),
      createSiteExportAgent({ model, supplierCards: {} }),
    ];
    for (const agent of withCards) {
      expect(names(agent.tools)).toContain('enrichSupplierCard');
      expect(agent.prompt).toContain('enrichSupplierCard');
    }
    // Агент документов (этап 219): инструмент с тем же именем, но с видом документа во входе
    // (только договор); общего абзаца про дополнение у него нет, есть абзац про договор.
    const documents = createDocumentsAgent({ model, supplierCards: {} });
    expect(names(documents.tools)).toContain('enrichSupplierCard');
    const wrapped = documents.tools.find((tool) => tool.name === 'enrichSupplierCard');
    expect(wrapped).not.toBe(enrichSupplierCard);
    expect(wrapped?.inputSchema.safeParse(SIMPLE).success).toBe(false);
    expect(names(documents.tools)).toContain('createSupplierFromAttachment');
    expect(documents.prompt).not.toContain('Дополнить СУЩЕСТВУЮЩУЮ карточку сведениями');
    const without = [
      createPricesAgent({ model }),
      createOrderCalcAgent({ model }),
      createDocumentsAgent({ model }),
      createSiteExportAgent({ model }),
    ];
    for (const agent of without) expect(names(agent.tools)).not.toContain('enrichSupplierCard');
  });

  test('вход инструмента не содержит оценки и банковских реквизитов', () => {
    const parsed = enrichSupplierCard.inputSchema.parse({
      ...SIMPLE,
      strengths: 'быстро',
      weaknesses: 'дорого',
      defectRatePercent: 3,
      bankName: 'Банк',
      bik: '044525225',
      settlementAccount: '40702810900000000009',
      correspondentAccount: '30101810400000000225',
    }) as Record<string, unknown>;
    for (const key of [
      'strengths',
      'weaknesses',
      'defectRatePercent',
      'bankName',
      'bik',
      'settlementAccount',
      'correspondentAccount',
    ]) {
      expect(key in parsed).toBe(false);
    }
    expect(parsed['website']).toBe('https://alfa.example');
  });
});

describe('enrichSupplierCard: права', () => {
  test('без права suppliers.confirm_card: access_denied, карточка не тронута', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const out = await enrichSupplierCard.execute(
      { ...SIMPLE, supplierId: existing.id },
      world.host,
      turnContext(USER_B, `${BOT_PRICES}/${USER_B}`),
    );
    expect(out.status).toBe('access_denied');
    expect((await stored(existing.id)).website).toBeUndefined();
  });

  test('сбой справочника: ошибка о сбое, повтор после восстановления проходит', async () => {
    const right = new SwitchableAccess();
    world.deps.access = right;
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const input = { ...SIMPLE, supplierId: existing.id };
    right.mode = 'down';
    const failed = await enrichSupplierCard
      .execute(input, world.host, ctx())
      .catch((caught: unknown) => caught);
    expect(String((failed as Error).message)).toContain('временный сбой');
    expect((await stored(existing.id)).website).toBeUndefined();
    right.mode = 'allow';
    const out = await enrichSupplierCard.execute(input, world.host, ctx());
    expect(out.status).not.toBe('access_denied');
    expect((await stored(existing.id)).website).toBeDefined();
  });

  test('нет политики прав: запись запрещена', async () => {
    delete world.deps.access;
    const existing = await seed({ name: 'Альфа' });
    await expect(
      enrichSupplierCard.execute(
        { ...SIMPLE, supplierId: existing.id },
        world.host,
        ctx(),
      ),
    ).rejects.toThrow();
    expect((await stored(existing.id)).website).toBeUndefined();
  });

  test('плановый запуск без сотрудника: отказ', async () => {
    const existing = await seed({ name: 'Альфа' });
    await expect(
      enrichSupplierCard.execute(
        { ...SIMPLE, supplierId: existing.id },
        world.host,
        SCHEDULER_CONTEXT,
      ),
    ).rejects.toThrow();
  });
});

describe('enrichSupplierCard: запись', () => {
  test('значения из источника дописаны в пустые поля, вопрос сотруднику не показан', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const out = await enrichSupplierCard.execute(
      {
        supplierId: existing.id,
        origin: 'email',
        sourceLabel: 'Письмо поставщика',
        sourceText: LETTER,
        website: 'https://alfa.example',
        contacts: [{ email: 'sales@alfa.example', phone: '+7 (900) 123-45-67' }],
        terms: { payment: 'предоплата 50%' },
      },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('enriched');
    expect(out.added).toEqual(expect.arrayContaining(['website', 'contacts', 'terms.payment']));
    expect(world.chat.outbox.length).toBe(0);
    const saved = await stored(existing.id);
    expect(saved.website).toBe('https://alfa.example');
    expect(saved.contacts).toHaveLength(1);
    expect(saved.terms.payment).toBe('предоплата 50%');
    expect(saved.updatedBy).toBe(USER_A);
    expect(saved.notes.at(-1)?.text).toContain('Дополнено из письма «Письмо поставщика»');
    // Аудит: кто и что сделал, без значений полей.
    const entries = await world.audit.list(USER_A);
    expect(entries.map((entry) => entry.action)).toContain('suppliers.card_enrich');
    expect(JSON.stringify(entries)).not.toContain('alfa.example');
  });

  test('значение, которого нет в источнике, отклонено и не записано', async () => {
    const existing = await seed({ name: 'Альфа' });
    const out = await enrichSupplierCard.execute(
      {
        supplierId: existing.id,
        origin: 'email',
        sourceText: LETTER,
        website: 'https://alfa.example',
        directorName: 'Выдуманов В. В.',
        productionCity: 'Нигдеград',
      },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('enriched');
    expect(out.rejected.map((item) => item.field).sort()).toEqual([
      'directorName',
      'productionCity',
    ]);
    const saved = await stored(existing.id);
    expect(saved.website).toBe('https://alfa.example');
    expect(saved.directorName).toBeUndefined();
    expect(saved.productionCity).toBeUndefined();
  });

  test('без текста источника ничего не принимается: no_source', async () => {
    const existing = await seed({ name: 'Альфа' });
    const out = await enrichSupplierCard.execute(
      { supplierId: existing.id, origin: 'chat', website: 'https://alfa.example' },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('no_source');
    expect((await stored(existing.id)).website).toBeUndefined();
  });

  test('слова сотрудника тоже источник (messageText)', async () => {
    const existing = await seed({ name: 'Альфа' });
    const out = await enrichSupplierCard.execute(
      {
        supplierId: existing.id,
        origin: 'chat',
        messageText: 'у Альфы новый сайт https://alfa.example',
        website: 'https://alfa.example',
      },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('enriched');
  });

  test('расхождение с карточкой: не записано, возвращено модели без серий цифр', async () => {
    const existing = await seed({
      name: 'Альфа',
      inn: INN_ALPHA,
      website: 'https://alfa.example',
      terms: { payment: 'оплата на счёт 40702810200000000001' },
    });
    const text = `${LETTER}\nОплата на счёт 40702810900000000009\nГород: Тестоград`;
    const out = await enrichSupplierCard.execute(
      {
        supplierId: existing.id,
        origin: 'document',
        sourceText: text,
        inn: INN_ALPHA,
        terms: { payment: 'оплата на счёт 40702810900000000009' },
        productionCity: 'Тестоград',
      },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('enriched');
    expect(out.added).toEqual(['productionCity']);
    expect(out.conflicts.map((item) => item.field)).toEqual(['terms.payment']);
    expect(out.message).toContain('prepareSupplierCardEdit');
    expect(findDigitSeries(JSON.stringify(out))).toEqual([]);
    expect((await stored(existing.id)).terms.payment).toBe('оплата на счёт 40702810200000000001');
  });

  test('2: расхождение в скрытых от модели полях - только имя поля, без значений', async () => {
    const existing = await seed({
      name: 'Альфа',
      inn: INN_ALPHA,
      directorName: 'Старов Сергей Сергеевич',
      legalAddress: 'г. Прежний, ул. Старая, 1',
    });
    const text = `${LETTER}\nДиректор Новиков Николай Николаевич\nАдрес: г. Новый, ул. Свежая, 2`;
    // Файл прочитан в этом чате: источник доказан, расхождения идут в conflicts, как раньше.
    await noteAttachmentText(world.state, THREAD_A, [{ name: 'Карточка.docx', text }]);
    const out = await enrichSupplierCard.execute(
      {
        supplierId: existing.id,
        origin: 'document',
        sourceText: text,
        directorName: 'Новиков Николай Николаевич',
        legalAddress: 'г. Новый, ул. Свежая, 2',
        website: 'https://alfa.example',
      },
      world.host,
      ctx(),
    );
    expect(out.conflicts.map((item) => item.field).sort()).toEqual([
      'directorName',
      'legalAddress',
    ]);
    for (const item of out.conflicts) expect(Object.keys(item)).toEqual(['field']);
    const json = JSON.stringify(out);
    for (const secret of ['Старов', 'Новиков', 'Прежний', 'Свежая']) {
      expect(json).not.toContain(secret);
    }
    expect((await stored(existing.id)).directorName).toBe('Старов Сергей Сергеевич');
  });

  test('2б: источник не доказан - иной юрадрес не в conflicts, а на подтверждение', async () => {
    const existing = await seed({
      name: 'Альфа',
      inn: INN_ALPHA,
      legalAddress: 'г. Прежний, ул. Старая, 1',
    });
    const out = await enrichSupplierCard.execute(
      {
        supplierId: existing.id,
        origin: 'document',
        sourceText: `${LETTER}\nАдрес: г. Новый, ул. Свежая, 2`,
        legalAddress: 'г. Новый, ул. Свежая, 2',
        website: 'https://alfa.example',
      },
      world.host,
      ctx(),
    );
    expect(out.withheld).toEqual(['legalAddress']);
    expect(out.conflicts).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('Свежая');
    expect((await stored(existing.id)).legalAddress).toBe('г. Прежний, ул. Старая, 1');
  });

  test('7: подпись источника в заметке карточки без почты, цифр и ФИО', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    await enrichSupplierCard.execute(
      {
        ...SIMPLE,
        supplierId: existing.id,
        sourceLabel: 'Письмо ivan.petrov@alfa.example 79001234567 Иванов Иван Иванович',
      },
      world.host,
      ctx(),
    );
    const text = (await stored(existing.id)).notes.at(-1)?.text ?? '';
    expect(text).toContain('Дополнено из письма');
    for (const secret of ['ivan.petrov', '79001234567', 'Иванов']) {
      expect(text).not.toContain(secret);
    }
  });

  test('12: тот же источник с другими полями - отдельная запись аудита', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const text = `${LETTER}\nГород: Тестоград`;
    const base = { supplierId: existing.id, origin: 'email' as const, sourceText: text };
    const withSite = { ...base, website: 'https://alfa.example' };
    await enrichSupplierCard.execute(withSite, world.host, ctx());
    await enrichSupplierCard.execute({ ...base, productionCity: 'Тестоград' }, world.host, ctx());
    const entries = (await world.audit.list(USER_A)).filter(
      (entry) => entry.action === 'suppliers.card_enrich',
    );
    expect(entries).toHaveLength(2);
    // Повтор первого вызова ничего не меняет и записи не добавляет.
    await enrichSupplierCard.execute(withSite, world.host, ctx());
    expect(
      (await world.audit.list(USER_A)).filter((entry) => entry.action === 'suppliers.card_enrich'),
    ).toHaveLength(2);
  });

  test('повтор того же вызова: unchanged, заметка и контакты не задваиваются', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const input = {
      supplierId: existing.id,
      origin: 'email' as const,
      sourceText: LETTER,
      website: 'https://alfa.example',
      contacts: [{ phone: '8 (900) 123-45-67' }],
    };
    const first = await enrichSupplierCard.execute(input, world.host, ctx());
    const second = await enrichSupplierCard.execute(input, world.host, ctx());
    expect(first.status).toBe('enriched');
    expect(second.status).toBe('unchanged');
    const saved = await stored(existing.id);
    expect(saved.notes).toHaveLength(1);
    expect(saved.contacts).toHaveLength(1);
  });
});

describe('enrichSupplierCard: сопоставление', () => {
  test('нет карточки: not_found, новая не заводится', async () => {
    const out = await enrichSupplierCard.execute(
      { ...SIMPLE, name: 'Альфа', sourceText: `${LETTER}\nООО Альфа` },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('not_found');
    expect(out.message).toContain('createSupplierFromAttachment');
    expect(await world.suppliers.searchCards({ limit: 10 })).toEqual([]);
  });

  test('карточка находится без supplierId: по названию и ИНН из источника', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const out = await enrichSupplierCard.execute(
      {
        name: 'Альфа',
        inn: INN_ALPHA,
        origin: 'document',
        sourceText: `Альфа, ИНН ${INN_ALPHA}\n${LETTER}`,
        website: 'https://alfa.example',
      },
      world.host,
      ctx(),
    );
    expect(out).toMatchObject({ status: 'enriched', supplierId: existing.id });
  });

  test('несколько кандидатов: ambiguous с названиями, ничего не записано', async () => {
    await seed({ name: 'Альфа Один', contacts: [{ email: 'sales@alfa.example' }] });
    await seed({ name: 'Альфа Два', contacts: [{ email: 'sales@alfa.example' }] });
    const out = await enrichSupplierCard.execute(
      {
        origin: 'email',
        sourceText: LETTER,
        contacts: [{ email: 'sales@alfa.example' }],
        website: 'https://alfa.example',
      },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('ambiguous');
    expect([...out.matches].sort()).toEqual(['Альфа Два', 'Альфа Один']);
    for (const card of await world.suppliers.searchCards({ limit: 10 })) {
      expect(card.website).toBeUndefined();
    }
  });

  test('8: отвергнутый supplierId (другой ИНН) не подменяется, модели сказано почему', async () => {
    const rejected = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const byName = await seed({ name: 'Бета Трейд' });
    const out = await enrichSupplierCard.execute(
      {
        supplierId: rejected.id,
        name: 'Бета Трейд',
        inn: INN_BETA,
        origin: 'document',
        sourceText: `Бета Трейд, ИНН ${INN_BETA}\n${LETTER}`,
        website: 'https://alfa.example',
      },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('not_found');
    expect(out.message).toContain('другой ИНН');
    expect((await stored(byName.id)).website).toBeUndefined();
    expect((await stored(rejected.id)).website).toBeUndefined();
  });

  test('1: ИНН источника у другой карточки: ambiguous, ИНН не записан в выбранную', async () => {
    const target = await seed({ name: 'Икс' });
    const other = await seed({ name: 'Игрек', inn: INN_ALPHA });
    const out = await enrichSupplierCard.execute(
      {
        supplierId: target.id,
        inn: INN_ALPHA,
        origin: 'document',
        sourceText: `ИНН ${INN_ALPHA}\n${LETTER}`,
        website: 'https://alfa.example',
      },
      world.host,
      ctx(),
    );
    expect(out.status).toBe('ambiguous');
    expect([...out.matches].sort()).toEqual(['Игрек', 'Икс']);
    expect((await stored(target.id)).inn).toBeUndefined();
    expect((await stored(other.id)).website).toBeUndefined();
  });

  test('10: неверный ИНН из источника - в warnings, остальное дополнено', async () => {
    const existing = await seed({ name: 'Альфа' });
    const out = await enrichSupplierCard.execute(
      {
        name: 'Альфа',
        inn: INN_BROKEN,
        origin: 'document',
        sourceText: `Альфа, ИНН ${INN_BROKEN}\n${LETTER}`,
        website: 'https://alfa.example',
      },
      world.host,
      ctx(),
    );
    expect(out).toMatchObject({ status: 'enriched', supplierId: existing.id });
    expect(out.warnings.some((item) => item.includes('ИНН'))).toBe(true);
    expect((await stored(existing.id)).inn).toBeUndefined();
  });
});
