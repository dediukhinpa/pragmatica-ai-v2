import { describe, expect, test } from 'bun:test';
import {
  WEB_FIELDS,
  mergeCandidates,
  shortlistProposalSchema,
  webFieldsOfCandidate,
  type SourceResult,
  type SupplierCandidate,
} from '../../../src/kit/domain/shortlist';
import { WEB_SOURCE_MARK, withWebNote } from '../../../src/kit/domain/supplier-enrichment';
import { parseWebPageFacts } from '../../../src/kit/domain/web-candidate';

/** Происхождение полей шорт-листа (п.6 доработок): какое поле взято из интернета. */

const OPTIONS = { limit: 10, externalId: (name: string): string => `ext-${name}` };

const WEB_CANDIDATE: SupplierCandidate = {
  name: 'Ромашка',
  reference: 'https://romashka.test/price',
  city: 'Пермь',
  address: 'ул. Заводская, 1',
  contacts: 'тел. +70000000004',
  email: 'zakaz@romashka.test',
  leadTime: '5 дней',
  score: 0.7,
};

function web(candidate: SupplierCandidate): SourceResult {
  return { source: 'web', status: 'ok', candidates: [candidate] };
}
function base(candidate: SupplierCandidate): SourceResult {
  return { source: 'knowledge', status: 'ok', candidates: [candidate] };
}

describe('пометка «ИЗ ИНТЕРНЕТА»: одна константа', () => {
  test('заглавными, и пометка значения строится от неё', () => {
    expect(WEB_SOURCE_MARK).toBe('ИЗ ИНТЕРНЕТА');
    expect(withWebNote('Казань')).toBe(`Казань (${WEB_SOURCE_MARK})`);
  });
});

describe('webFieldsOfCandidate: что у веб-кандидата из интернета', () => {
  test('по одному полю на каждое заполненное сведение, сайт - если reference ссылка', () => {
    expect(webFieldsOfCandidate(WEB_CANDIDATE)).toEqual([
      'city',
      'address',
      'contacts',
      'email',
      'leadTime',
      'site',
    ]);
  });

  test('пустое не помечается; reference не ссылка - сайта нет', () => {
    expect(webFieldsOfCandidate({ name: 'А', reference: 'kb:1', score: 1 })).toEqual([]);
    expect(webFieldsOfCandidate({ name: 'А', city: 'Омск', score: 1 })).toEqual(['city']);
  });

  test('перечень полей закрыт', () => {
    expect([...WEB_FIELDS]).toEqual(['city', 'address', 'contacts', 'email', 'leadTime', 'site']);
  });
});

describe('mergeCandidates: происхождение полей', () => {
  test('веб-кандидат без базы: все его заполненные поля помечены', () => {
    const { entries } = mergeCandidates([web({ ...WEB_CANDIDATE, webFields: [...WEB_FIELDS] })], OPTIONS);
    expect(entries[0]?.webFields).toEqual([...WEB_FIELDS]);
  });

  test('запись источника без webFields (до появления поля): выводится для источника web', () => {
    const { entries } = mergeCandidates([web(WEB_CANDIDATE)], OPTIONS);
    expect(entries[0]?.webFields).toEqual([...WEB_FIELDS]);
  });

  test('кандидат базы: ничего не помечено, поля webFields в строке нет', () => {
    const { entries } = mergeCandidates(
      [base({ name: 'Ромашка', supplierId: 's1', city: 'Казань', leadTime: '3 дня', score: 1 })],
      OPTIONS,
    );
    expect(entries[0]?.webFields).toBeUndefined();
    expect(entries[0]?.city).toBe('Казань');
  });

  test('слияние база+веб: у базы есть город - город базы, без пометки; срок взят у веба - помечен', () => {
    const { entries } = mergeCandidates(
      [
        base({ name: 'Ромашка', supplierId: 's1', city: 'Казань', score: 1 }),
        web({ ...WEB_CANDIDATE, webFields: [...WEB_FIELDS] }),
      ],
      OPTIONS,
    );
    const [entry] = entries;
    expect(entry?.city).toBe('Казань');
    expect(entry?.webFields).not.toContain('city');
    expect(entry?.leadTime).toBe('5 дней');
    expect(entry?.webFields).toContain('leadTime');
    expect(entry?.webFields).toContain('contacts');
    expect(entry?.webFields).toContain('address');
    expect(entry?.webFields).toContain('email');
    expect(entry?.webFields).toContain('site');
  });

  test('слияние: у базы все сведения свои - от веба берётся только ссылка', () => {
    const { entries } = mergeCandidates(
      [
        base({
          name: 'Ромашка',
          supplierId: 's1',
          city: 'Казань',
          address: 'ул. Складская, 5',
          contacts: 'info@romashka.test',
          email: 'info@romashka.test',
          leadTime: '3 дня',
          score: 1,
        }),
        web({ ...WEB_CANDIDATE, webFields: [...WEB_FIELDS] }),
      ],
      OPTIONS,
    );
    expect(entries[0]?.webFields).toEqual(['site']);
  });

  test('поле, которое веб-кандидат не заявил как веб, не помечается', () => {
    const { entries } = mergeCandidates(
      [web({ name: 'Ромашка', city: 'Пермь', score: 1, webFields: [] })],
      OPTIONS,
    );
    expect(entries[0]?.webFields).toBeUndefined();
  });

  test('сохранённый шорт-лист: без webFields читается, с webFields сохраняется', () => {
    const raw = {
      requestId: 'r1',
      version: 'v1',
      createdAt: '2026-11-08T00:00:00.000Z',
      managerThreadId: 'mgr',
      truncated: 0,
      sources: [],
      entries: [
        { supplierId: 'a', name: 'А', sources: ['web'], score: 1, references: [], city: 'Омск' },
        {
          supplierId: 'b',
          name: 'Б',
          sources: ['web'],
          score: 1,
          references: [],
          city: 'Омск',
          webFields: ['city'],
        },
      ],
    };
    const parsed = shortlistProposalSchema.parse(raw);
    expect(parsed.entries[0]?.webFields).toBeUndefined();
    expect(parsed.entries[1]?.webFields).toEqual(['city']);
    expect(shortlistProposalSchema.safeParse({
      ...raw,
      entries: [{ ...raw.entries[0], webFields: ['unknown'] }],
    }).success).toBe(false);
  });
});

describe('цена веб-кандидата: НДС по данным страницы', () => {
  const price = { item: 'Мёд', amount: 100, currency: 'RUB' };

  test('vat страницы принимается из закрытого перечня', () => {
    const facts = parseWebPageFacts({
      prices: [
        { ...price, vat: 'included' },
        { ...price, item: 'Орех', vat: 'excluded' },
        { ...price, item: 'Чай', vat: 'none' },
      ],
    });
    expect(facts.prices?.map((p) => p.vat)).toEqual(['included', 'excluded', 'none']);
  });

  test('нет vat, «unknown» или мусор: поля нет («НДС не указан» ставит показ)', () => {
    const facts = parseWebPageFacts({
      prices: [
        price,
        { ...price, item: 'Орех', vat: 'unknown' },
        { ...price, item: 'Чай', vat: '20%' },
      ],
    });
    expect(facts.prices?.map((p) => p.vat)).toEqual([undefined, undefined, undefined]);
  });

  test('прежняя одна цена: vat тоже читается', () => {
    expect(parseWebPageFacts({ price: { ...price, vat: 'excluded' } }).price?.vat).toBe('excluded');
  });
});
