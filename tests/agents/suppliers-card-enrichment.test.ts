import { beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock } from '@business-ai/adapters';
import { MemorySupplierRepository } from '../../src/kit/adapters/memory/repositories.owned';
import {
  FREE_MAIL_DOMAINS,
  emailDomain,
  enrichOrCreateSupplier,
  type EnrichmentConflict,
  type EnrichmentDeps,
  type EnrichmentFields,
  type EnrichmentOrigin,
  type EnrichmentOptions,
  type EnrichmentSource,
} from '../../src/agents/suppliers/card-enrichment';
import {
  cardFromFields,
  newCardId,
  type SupplierCardFields,
} from '../../src/agents/suppliers/card-fields';
import type { SupplierCard, SupplierCardSource } from '../../src/kit/domain/supplier-card';
import { INN_ALPHA, INN_BETA, INN_BROKEN, INN_GAMMA } from './suppliers-support';

/**
 * Обогащение карточки из источника (этап 218): сопоставление без дублей, запись только в пустые
 * поля, расхождения возвращаются, повтор того же источника ничего не меняет. Данные синтетические.
 */

const AUTHOR = 'u-100';
const NOW = '2026-05-04T09:00:00.000Z';
const NOTE_DATE = '2026-05-04';

let suppliers: MemorySupplierRepository;
let deps: EnrichmentDeps;

beforeEach(() => {
  const clock = new FixedClock(new Date(NOW));
  suppliers = new MemorySupplierRepository(() => clock.now().toISOString());
  deps = { suppliers, clock };
});

/** Карточка в базе до операции (источник `chat`, версия раньше текущего момента). */
async function seed(fields: SupplierCardFields, draft = false): Promise<SupplierCard> {
  const base = cardFromFields(
    fields,
    { userId: 'seed', nowIso: '2026-05-01T09:00:00.000Z', source: 'chat' },
    newCardId(fields),
  );
  return suppliers.saveCard(base, { createOnly: true });
}

const source = (key: string, extra: Partial<EnrichmentSource> = {}): EnrichmentSource => ({
  key,
  label: 'Письмо-1',
  ...extra,
});

const options = (extra: Partial<EnrichmentOptions> = {}): EnrichmentOptions => ({
  createIfMissing: false,
  origin: 'email',
  author: AUTHOR,
  ...extra,
});

const run = (
  src: EnrichmentSource,
  fields: EnrichmentFields,
  extra: Partial<EnrichmentOptions> = {},
) => enrichOrCreateSupplier(deps, src, fields, options(extra));

const all = async (): Promise<SupplierCard[]> => suppliers.searchCards({ limit: 50 });
const card = async (id: string | null): Promise<SupplierCard> => {
  const found = id === null ? null : await suppliers.getCard(id);
  if (found === null) throw new Error('карточки нет');
  return found;
};

describe('enrichOrCreateSupplier: новая карточка', () => {
  test('нет совпадения + createIfMissing: непроверенная карточка и заметка', async () => {
    const out = await run(
      source('k1', { label: 'Прайс-лист' }),
      {
        name: 'Гамма Трейд',
        inn: INN_GAMMA,
        website: 'https://gamma.example',
        contacts: [{ email: 'Sales@Gamma.Example', phone: '8 (900) 123-45-67' }],
        categories: ['Значки'],
        terms: { payment: 'предоплата' },
      },
      { createIfMissing: true, origin: 'crm' },
    );
    expect(out.kind).toBe('created');
    const created = await card(out.supplierId);
    expect(created).not.toHaveProperty('isDraft');
    expect(created.inn).toBe(INN_GAMMA);
    expect(created.website).toBe('https://gamma.example');
    expect(created.contacts).toEqual([
      { email: 'sales@gamma.example', phone: '+79001234567', isPrimary: true },
    ]);
    expect(created.supplies.categories).toEqual(['Значки']);
    expect(created.terms.payment).toBe('предоплата');
    // CHECK suppliers.source допускает только chat/file/email: CRM получает ближайшее, точный
    // источник виден в заметке.
    expect(created.source).toBe('file');
    const note = created.notes.find((item) => item.text.startsWith('Создано из CRM'));
    expect(note?.text).toContain(`«Прайс-лист» ${NOTE_DATE}.`);
    expect(note?.text).toMatch(/\n\[enrich:[0-9a-f]+\]$/);
    expect(note?.authorId).toBe(AUTHOR);
  });

  test('источник вне CHECK получает ближайшее допустимое значение', async () => {
    const cases: ReadonlyArray<readonly [EnrichmentOrigin, SupplierCardSource]> = [
      ['telegram', 'chat'],
      ['document', 'file'],
      ['email', 'email'],
      ['chat', 'chat'],
      ['file', 'file'],
    ];
    for (const [index, [origin, expected]] of cases.entries()) {
      const out = await run(
        source(`k-${origin}`),
        { name: `Поставщик ${index}` },
        { createIfMissing: true, origin },
      );
      expect((await card(out.supplierId)).source).toBe(expected);
    }
  });

  test('без createIfMissing: not_found, в базе ничего нет', async () => {
    const out = await run(source('k1'), { name: 'Гамма Трейд', inn: INN_GAMMA });
    expect(out).toMatchObject({ kind: 'not_found', supplierId: null, conflicts: [] });
    expect(await all()).toEqual([]);
  });

  test('createIfMissing без названия: карточку не завести, not_found', async () => {
    const out = await run(
      source('k1'),
      { website: 'https://x.example' },
      { createIfMissing: true },
    );
    expect(out.kind).toBe('not_found');
    expect(await all()).toEqual([]);
  });

  test('повтор создания того же источника: вторая карточка не заводится', async () => {
    const fields = { name: 'Гамма Трейд', inn: INN_GAMMA };
    const first = await run(source('k1'), fields, { createIfMissing: true });
    const second = await run(source('k1'), fields, { createIfMissing: true });
    expect(first.kind).toBe('created');
    expect(second).toMatchObject({ kind: 'unchanged', supplierId: first.supplierId });
    expect(await all()).toHaveLength(1);
  });
});

describe('enrichOrCreateSupplier: дополнение существующей', () => {
  test('по ИНН: пустые поля, контакт и списки добавлены, прежнее не тронуто', async () => {
    const existing = await seed({
      name: 'Альфа',
      inn: INN_ALPHA,
      contacts: [{ email: 'old@alfa.example', fullName: 'Старый', isPrimary: true }],
      categories: ['Медали'],
    });
    const out = await run(source('k1'), {
      name: 'ООО Альфа',
      inn: INN_ALPHA,
      website: 'https://alfa.example',
      productionCity: 'Тестоград',
      contacts: [{ email: 'new@alfa.example', fullName: 'Новый' }],
      categories: ['Значки', 'медали'],
      terms: { payment: 'по факту', delivery: 'самовывоз' },
    });
    expect(out).toMatchObject({ kind: 'enriched', supplierId: existing.id, conflicts: [] });
    expect(out.addedFields).toEqual(
      expect.arrayContaining([
        'website',
        'productionCity',
        'contacts',
        'supplies.categories',
        'terms.payment',
        'terms.delivery',
      ]),
    );
    const saved = await card(existing.id);
    expect(saved.name).toBe('Альфа');
    expect(saved.website).toBe('https://alfa.example');
    expect(saved.productionCity).toBe('Тестоград');
    expect(saved.contacts.map((contact) => contact.email)).toEqual([
      'old@alfa.example',
      'new@alfa.example',
    ]);
    expect(saved.contacts.filter((contact) => contact.isPrimary)).toHaveLength(1);
    expect(saved.supplies.categories).toEqual(['Медали', 'Значки']);
    expect(saved.updatedBy).toBe(AUTHOR);
    // Источник существующей карточки и признак проверенности не меняются.
    expect(saved.source).toBe('chat');
    expect(saved).not.toHaveProperty('isDraft');
    const note = saved.notes.at(-1);
    expect(note?.text).toStartWith(`Дополнено из письма «Письмо-1» ${NOTE_DATE}.`);
  });

  test('по адресу почты (без ИНН и с другим названием)', async () => {
    const existing = await seed({
      name: 'Альфа',
      contacts: [{ email: 'info@alfa.example', isPrimary: true }],
    });
    const out = await run(source('k1'), {
      name: 'Совсем другое название',
      contacts: [{ email: 'INFO@alfa.example' }],
      website: 'https://alfa.example',
    });
    expect(out).toMatchObject({ kind: 'enriched', supplierId: existing.id });
  });

  test('по названию (без ИНН и почты)', async () => {
    const existing = await seed({ name: 'ООО «Альфа»' });
    const out = await run(source('k1'), { name: 'Альфа', website: 'https://alfa.example' });
    expect(out).toMatchObject({ kind: 'enriched', supplierId: existing.id });
  });

  test('по supplierId источника: поля без названия и ИНН', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const out = await run(source('k1', { supplierId: existing.id }), {
      website: 'https://alfa.example',
    });
    expect(out).toMatchObject({ kind: 'enriched', supplierId: existing.id });
    expect((await card(existing.id)).website).toBe('https://alfa.example');
  });

  test('supplierId карточки с другим ИНН: чужая карточка не подходит', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const out = await run(source('k1', { supplierId: existing.id }), {
      inn: INN_BETA,
      website: 'https://beta.example',
    });
    expect(out.kind).toBe('not_found');
    expect((await card(existing.id)).website).toBeUndefined();
  });

  test('карточка с другим ИНН отбрасывается; одноимённая не даёт второй карточки', async () => {
    const alpha = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const out = await run(
      source('k1'),
      { name: 'Альфа', inn: INN_BETA, website: 'https://beta.example' },
      { createIfMissing: true },
    );
    // Это другое юрлицо, но название занято: решает человек, ничего не пишется.
    expect(out).toMatchObject({ kind: 'ambiguous', candidateIds: [alpha.id] });
    expect(await all()).toHaveLength(1);
    expect((await card(alpha.id)).website).toBeUndefined();
    // С другим названием это просто новая карточка.
    const fresh = await run(
      source('k2'),
      { name: 'Бета', inn: INN_BETA },
      { createIfMissing: true },
    );
    expect(fresh.kind).toBe('created');
    expect(await all()).toHaveLength(2);
  });

  test('неверный ИНН источника не пишется, остальное дополняется', async () => {
    const existing = await seed({ name: 'Альфа', contacts: [{ email: 'a@alfa.example' }] });
    const out = await run(source('k1'), {
      name: 'Альфа',
      inn: INN_BROKEN,
      contacts: [{ email: 'a@alfa.example' }, { phone: '12' }],
      website: 'https://alfa.example',
    });
    expect(out).toMatchObject({ kind: 'enriched', supplierId: existing.id });
    const saved = await card(existing.id);
    expect(saved.inn).toBeUndefined();
    expect(saved.website).toBe('https://alfa.example');
    expect(saved.contacts).toHaveLength(1);
  });
});

describe('enrichOrCreateSupplier: расхождения не пишутся', () => {
  test('заполненное другим значением поле остаётся, расхождение возвращается', async () => {
    const existing = await seed({
      name: 'Альфа',
      inn: INN_ALPHA,
      website: 'https://alfa.example',
      terms: { payment: 'предоплата 100%' },
    });
    const out = await run(source('k1'), {
      name: 'Альфа',
      inn: INN_ALPHA,
      // Тот же сайт в другой записи расхождением не считается.
      website: 'http://www.alfa.example/',
      productionCity: 'Тестоград',
      terms: { payment: 'отсрочка 30 дней' },
    });
    expect(out.kind).toBe('enriched');
    expect(out.addedFields).toEqual(['productionCity']);
    const expected: EnrichmentConflict[] = [
      { field: 'terms.payment', current: 'предоплата 100%', proposed: 'отсрочка 30 дней' },
    ];
    expect(out.conflicts).toEqual(expected);
    const saved = await card(existing.id);
    expect(saved.terms.payment).toBe('предоплата 100%');
    expect(saved.productionCity).toBe('Тестоград');
  });

  test('только расхождения: unchanged, заметки нет, расхождения возвращены', async () => {
    const existing = await seed({
      name: 'Альфа',
      inn: INN_ALPHA,
      website: 'https://alfa.example',
    });
    const out = await run(source('k1'), {
      name: 'Альфа',
      inn: INN_ALPHA,
      website: 'https://other.example',
    });
    expect(out).toMatchObject({ kind: 'unchanged', supplierId: existing.id });
    expect(out.conflicts.map((item) => item.field)).toEqual(['website']);
    const saved = await card(existing.id);
    expect(saved.website).toBe('https://alfa.example');
    expect(saved.notes).toEqual([]);
    expect(saved.updatedAt).toBe(existing.updatedAt);
  });
});

describe('enrichOrCreateSupplier: идемпотентность', () => {
  const fields: EnrichmentFields = {
    name: 'Альфа',
    inn: INN_ALPHA,
    website: 'https://alfa.example',
    contacts: [{ phone: '8 (900) 123-45-67', fullName: 'Иван' }, { email: 'A@alfa.example' }],
    categories: ['Значки'],
  };

  test('повтор того же источника: контакты и заметка не задваиваются', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const first = await run(source('same'), fields);
    const second = await run(source('same'), fields);
    expect(first.kind).toBe('enriched');
    expect(second).toMatchObject({ kind: 'unchanged', addedFields: [] });
    const saved = await card(existing.id);
    expect(saved.contacts).toHaveLength(2);
    expect(saved.notes).toHaveLength(1);
  });

  test('тот же источник с новыми сведениями: поля дополнены, заметка одна', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    await run(source('same'), fields);
    const again = await run(source('same'), { ...fields, productionCity: 'Тестоград' });
    expect(again.kind).toBe('enriched');
    expect(again.addedFields).toEqual(['productionCity']);
    expect((await card(existing.id)).notes).toHaveLength(1);
  });

  test('другой источник с теми же данными: ничего нового, заметки нет', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    await run(source('one'), fields);
    const other = await run(source('two'), fields);
    expect(other.kind).toBe('unchanged');
    expect((await card(existing.id)).notes).toHaveLength(1);
  });

  test('другой источник с новыми сведениями: вторая заметка с другой меткой', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    await run(source('one'), fields);
    await run(source('two'), { name: 'Альфа', productionCity: 'Тестоград' });
    const notes = (await card(existing.id)).notes;
    expect(notes).toHaveLength(2);
    expect(notes[0]?.text.split('\n').at(-1)).not.toBe(notes[1]?.text.split('\n').at(-1));
  });

  test('один и тот же ключ у разных видов источника - разные метки', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    await run(source('id-1'), { name: 'Альфа', website: 'https://alfa.example' });
    await run(
      source('id-1'),
      { name: 'Альфа', productionCity: 'Тестоград' },
      { origin: 'crm' },
    );
    expect((await card(existing.id)).notes).toHaveLength(2);
  });
});

describe('enrichOrCreateSupplier: неоднозначность и бесплатная почта', () => {
  test('несколько карточек с одним адресом: ambiguous, ничего не записано', async () => {
    const first = await seed({ name: 'Альфа', contacts: [{ email: 'shared@corp.example' }] });
    const second = await seed({ name: 'Бета', contacts: [{ email: 'shared@corp.example' }] });
    const out = await run(
      source('k1'),
      { name: 'Новое', contacts: [{ email: 'shared@corp.example' }], website: 'https://n.example' },
      { createIfMissing: true },
    );
    expect(out.kind).toBe('ambiguous');
    expect([...out.candidateIds].sort()).toEqual([first.id, second.id].sort());
    expect(await all()).toHaveLength(2);
    expect((await card(first.id)).website).toBeUndefined();
  });

  test('совпал только корпоративный домен: ambiguous, чужие данные не вносятся', async () => {
    const existing = await seed({
      name: 'Альфа',
      contacts: [{ email: 'info@corp.example', isPrimary: true }],
    });
    const bySite = await run(
      source('k1'),
      { name: 'Другое юрлицо', website: 'https://www.corp.example/about' },
      { createIfMissing: true },
    );
    expect(bySite).toMatchObject({ kind: 'ambiguous', candidateIds: [existing.id] });
    const bySender = await run(
      source('k2', { senderKeys: ['sales@corp.example'] }),
      { name: 'Другое юрлицо' },
      { createIfMissing: true },
    );
    expect(bySender).toMatchObject({ kind: 'ambiguous', candidateIds: [existing.id] });
    expect(await all()).toHaveLength(1);
    expect((await card(existing.id)).website).toBeUndefined();
  });

  test('бесплатный домен не матчит: чужой адрес на том же сервисе - новая карточка', async () => {
    const existing = await seed({
      name: 'Альфа',
      contacts: [{ email: 'boss@gmail.com', isPrimary: true }],
    });
    const out = await run(
      source('k1', { senderKeys: ['other@gmail.com', 'gmail.com'] }),
      { name: 'Бета', contacts: [{ email: 'another@gmail.com' }] },
      { createIfMissing: true },
    );
    expect(out.kind).toBe('created');
    expect(out.supplierId).not.toBe(existing.id);
    expect(await all()).toHaveLength(2);
  });

  test('тот же точный адрес на бесплатном сервисе - та же карточка', async () => {
    const existing = await seed({
      name: 'Альфа',
      contacts: [{ email: 'boss@gmail.com', isPrimary: true }],
    });
    const out = await run(source('k1'), {
      name: 'Альфа Торг',
      contacts: [{ email: 'boss@gmail.com', fullName: 'Босс' }],
      website: 'https://alfa.example',
    });
    expect(out).toMatchObject({ kind: 'enriched', supplierId: existing.id });
    // Контакт с тем же адресом уже есть: он не задваивается и не переписывается.
    const saved = await card(existing.id);
    expect(saved.contacts).toEqual([{ email: 'boss@gmail.com', isPrimary: true }]);
  });

  test('список бесплатных доменов и домен адреса', () => {
    expect(FREE_MAIL_DOMAINS.has('gmail.com')).toBe(true);
    expect(FREE_MAIL_DOMAINS.has('corp.example')).toBe(false);
    expect(emailDomain(' Info@Corp.Example ')).toBe('corp.example');
    expect(emailDomain('без-собаки')).toBe('');
  });
});

describe('enrichOrCreateSupplier: исправления по ревью 218', () => {
  test('1: supplierId без ИНН, а ИНН источника у другой карточки: ambiguous с обеими', async () => {
    const target = await seed({ name: 'Икс' });
    const other = await seed({ name: 'Игрек', inn: INN_ALPHA });
    const out = await run(source('k1', { supplierId: target.id }), {
      inn: INN_ALPHA,
      website: 'https://y.example',
    });
    expect(out.kind).toBe('ambiguous');
    expect([...out.candidateIds].sort()).toEqual([target.id, other.id].sort());
    expect(out.reason).toBe('inn_of_other_card');
    // ИНН другой карточки в целевую не записан, сайт не записан никуда.
    expect((await card(target.id)).inn).toBeUndefined();
    expect((await card(target.id)).website).toBeUndefined();
    expect((await card(other.id)).website).toBeUndefined();
  });

  test('1: supplierId карточки с тем же ИНН: обычное дополнение', async () => {
    const target = await seed({ name: 'Икс', inn: INN_ALPHA });
    const out = await run(source('k1', { supplierId: target.id }), {
      inn: INN_ALPHA,
      website: 'https://x.example',
    });
    expect(out).toMatchObject({ kind: 'enriched', supplierId: target.id });
  });

  test('5: название и собственный домен указывают на одну карточку: она найдена', async () => {
    const existing = await seed({
      name: 'Альфа',
      contacts: [{ email: 'info@corp.example', isPrimary: true }],
    });
    const out = await run(source('k1'), {
      name: 'Альфа',
      website: 'https://www.corp.example',
      productionCity: 'Тестоград',
    });
    expect(out).toMatchObject({ kind: 'enriched', supplierId: existing.id });
    expect((await card(existing.id)).productionCity).toBe('Тестоград');
  });

  test('5: название у одной карточки, домен у другой: ambiguous с обеими', async () => {
    const byName = await seed({ name: 'Альфа' });
    const byDomain = await seed({
      name: 'Бета',
      contacts: [{ email: 'info@corp.example', isPrimary: true }],
    });
    const out = await run(source('k1'), { name: 'Альфа', website: 'https://corp.example' });
    expect(out.kind).toBe('ambiguous');
    expect([...out.candidateIds].sort()).toEqual([byName.id, byDomain.id].sort());
    expect((await card(byName.id)).website).toBeUndefined();
  });

  test('6: слишком длинные значения обрезаются до записи, запись проходит', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const long = 'ж'.repeat(5000);
    const out = await run(source('k1'), {
      name: 'Альфа',
      inn: INN_ALPHA,
      paymentNotes: long,
      terms: { payment: long },
      categories: [long],
    });
    expect(out.kind).toBe('enriched');
    const saved = await card(existing.id);
    expect(saved.paymentNotes?.length).toBeGreaterThan(0);
    expect(saved.paymentNotes?.length).toBeLessThan(long.length);
    expect(saved.terms.payment?.length).toBeLessThan(long.length);
    expect(saved.supplies.categories[0]?.length).toBeLessThan(long.length);
  });

  test('7: подпись источника в заметке без почты, длинных цифр и ФИО', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    await run(
      source('k1', {
        label: 'Письмо ivan.petrov@corp.example тел 79001234567 Иванов Иван Иванович, Петров П.П.',
      }),
      { name: 'Альфа', inn: INN_ALPHA, website: 'https://alfa.example' },
    );
    const text = (await card(existing.id)).notes.at(-1)?.text ?? '';
    expect(text).toStartWith('Дополнено из письма');
    expect(text).not.toContain('ivan.petrov');
    expect(text).not.toContain('79001234567');
    expect(text).not.toContain('Иванов');
    expect(text).not.toContain('Петров');
  });

  test('8: supplierId отвергнут (другой ИНН): не подменяется карточкой по названию', async () => {
    const rejected = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const byName = await seed({ name: 'Бета Трейд' });
    const out = await run(source('k1', { supplierId: rejected.id }), {
      name: 'Бета Трейд',
      inn: INN_BETA,
      website: 'https://beta.example',
    });
    expect(out).toMatchObject({ kind: 'not_found', reason: 'supplier_inn_mismatch' });
    expect((await card(byName.id)).website).toBeUndefined();
    expect((await card(rejected.id)).website).toBeUndefined();
  });

  test('8: supplierId указывает на несуществующую карточку: не подменяется', async () => {
    const byName = await seed({ name: 'Бета Трейд' });
    const out = await run(source('k1', { supplierId: 'no-such-id' }), {
      name: 'Бета Трейд',
      website: 'https://beta.example',
    });
    expect(out).toMatchObject({ kind: 'not_found', reason: 'supplier_missing' });
    expect((await card(byName.id)).website).toBeUndefined();
  });

  test('10: неверный ИНН отбрасывается с предупреждением, а не молча', async () => {
    const existing = await seed({ name: 'Альфа' });
    const out = await run(source('k1'), {
      name: 'Альфа',
      inn: INN_BROKEN,
      website: 'https://alfa.example',
    });
    expect(out).toMatchObject({ kind: 'enriched', supplierId: existing.id });
    expect(out.warnings.some((item) => item.includes('ИНН'))).toBe(true);
    expect(out.warnings.some((item) => item.includes('по названию'))).toBe(true);
    expect((await card(existing.id)).inn).toBeUndefined();
  });

  test('10: верный ИНН предупреждений не даёт', async () => {
    await seed({ name: 'Альфа', inn: INN_ALPHA });
    const out = await run(source('k1'), { name: 'Альфа', inn: INN_ALPHA, website: 'https://a.ex' });
    expect(out.warnings).toEqual([]);
  });

  test('13: список бесплатной почты дополнен', () => {
    for (const domain of [
      'me.com',
      'mail.com',
      'yandex.by',
      'yandex.kz',
      'yandex.ua',
      'gmx.com',
      'gmx.de',
      'gmx.net',
      'zoho.com',
      'aol.com',
      'narod.ru',
    ]) {
      expect(FREE_MAIL_DOMAINS.has(domain)).toBe(true);
    }
  });
});

describe('enrichOrCreateSupplier: гонка создания (ревью 221)', () => {
  test('параллельные создания одного поставщика (с ИНН и без) не дают дубля', async () => {
    // Разный id у карточки с ИНН и без него: уникального индекса по названию в базе нет,
    // поэтому создание сериализуется, а сопоставление повторяется уже под очередью.
    // Второй источник - документ, а не письмо: ИНН из письма в существующую карточку не
    // пишется никогда (этап 233), а здесь проверяется только очередь создания.
    const create = (key: string, fields: EnrichmentFields, origin: EnrichmentOrigin = 'email') =>
      enrichOrCreateSupplier(
        deps,
        source(key),
        fields,
        options({ createIfMissing: true, origin }),
      );
    const results = await Promise.all([
      create('crm:1', { name: 'Вега Трейд' }),
      create('doc:1', { name: 'Вега Трейд', inn: INN_ALPHA }, 'document'),
    ]);
    expect(await suppliers.searchCards({ limit: 50 })).toHaveLength(1);
    expect(results.map((item) => item.kind).sort()).toEqual(['created', 'enriched']);
  });

  test('сбой одного создания не блокирует очередь для следующих', async () => {
    const original = suppliers.saveCard.bind(suppliers);
    let failures = 1;
    suppliers.saveCard = async (...args) => {
      if (failures-- > 0) throw new Error('база недоступна');
      return original(...args);
    };
    const create = (name: string) =>
      enrichOrCreateSupplier(deps, source(name), { name }, options({ createIfMissing: true }));
    const [first, second] = await Promise.allSettled([create('Альфа Опт'), create('Бета Трейд')]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
  });
});
