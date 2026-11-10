import { beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock } from '@business-ai/adapters';
import { MemorySupplierRepository } from '../../src/kit/adapters/memory/repositories.owned';
import { isMailSenderTrusted } from '@business-ai/core';
import {
  SENDER_TRUST_BASES,
  cardSenderView,
  classifySender,
  senderTrustBases,
  type SenderEvidence,
  type SenderTrustPolicy,
} from '../../src/agents/suppliers/sender-trust';
import {
  cardFromFields,
  newCardId,
  type SupplierCardFields,
} from '../../src/agents/suppliers/card-fields';
import {
  enrichOrCreateSupplier,
  type EnrichmentDeps,
} from '../../src/agents/suppliers/card-enrichment';
import type { SupplierCard } from '../../src/kit/domain/supplier-card';
import { INN_ALPHA, INN_BETA } from './suppliers-support';

/**
 * Уровень доверия отправителю (этап 233): DKIM, известный адрес и домен карточки (для публичных
 * почтовиков - только точный адрес), ослабления за флагами; реквизиты из письма автоматически
 * не меняются при любом уровне доверия.
 */

const NOW = '2026-11-08T09:00:00.000Z';
const NONE: SenderEvidence = { dkimAligned: false, replyToOurs: false };
const OFF: SenderTrustPolicy = { websiteDomain: false, replyThread: false };
const ON: SenderTrustPolicy = { websiteDomain: true, replyThread: true };

let suppliers: MemorySupplierRepository;
let deps: EnrichmentDeps;

beforeEach(() => {
  const clock = new FixedClock(new Date(NOW));
  suppliers = new MemorySupplierRepository(() => clock.now().toISOString());
  deps = { suppliers, clock };
});

async function seed(fields: SupplierCardFields): Promise<SupplierCard> {
  const base = cardFromFields(
    fields,
    { userId: 'seed', nowIso: '2026-11-01T09:00:00.000Z', source: 'chat' },
    newCardId(fields),
  );
  return suppliers.saveCard(base, { createOnly: true });
}

const ALPHA: SupplierCardFields = {
  name: 'Альфа Снаб',
  inn: INN_ALPHA,
  website: 'https://alfa-snab.example',
  contacts: [
    { email: 'sales@alfa-snab.example', isPrimary: true },
    { email: 'boss.alfa@mail.example' },
  ],
};

describe('классификатор доверия к отправителю', () => {
  test('DKIM с выравниванием по From - доверенный без карточки', async () => {
    const result = classifySender('x@new.example', { ...NONE, dkimAligned: true }, null, OFF);
    expect(result).toEqual({ trusted: true, basis: 'dkim' });
  });

  test('основания доверия не содержат ответа почтового сервера', () => {
    expect(SENDER_TRUST_BASES).not.toContain('mail_server' as never);
  });

  test('ответ почтового сервера и senderAuth без собственного DKIM не дают доверия', () => {
    const settings = { policy: OFF };
    // Сервер сказал pass (SPF по чужому IP релея), своей подписи нет, карточки нет.
    const forged = { senderAuth: 'verified', serverAuth: 'verified', dkim: 'none' } as const;
    expect(isMailSenderTrusted(forged, false, settings)).toBe(false);
    expect(isMailSenderTrusted({ serverAuth: 'verified' }, false, settings)).toBe(false);
    expect(isMailSenderTrusted({ dkim: 'aligned' }, false, settings)).toBe(true);
    // Подпись есть, но ключ в тестовом режиме или домен чужой: доверия нет.
    expect(isMailSenderTrusted({ dkim: 'testing' }, false, settings)).toBe(false);
    expect(isMailSenderTrusted({ dkim: 'unaligned' }, false, settings)).toBe(false);
  });

  test('точный адрес из карточки; домен карточки - для корпоративных', async () => {
    const view = cardSenderView(await seed(ALPHA));
    expect(classifySender('sales@alfa-snab.example', NONE, view, OFF).basis).toBe('card_address');
    expect(classifySender('other@alfa-snab.example', NONE, view, OFF).basis).toBe('card_domain');
    expect(classifySender('x@shop.alfa-snab.example', NONE, view, OFF).basis).toBe('card_domain');
    expect(classifySender('x@evil.example', NONE, view, OFF).trusted).toBe(false);
  });

  test('публичный почтовик: только точный адрес, домен не считается', async () => {
    const view = cardSenderView(await seed(ALPHA));
    expect(classifySender('boss.alfa@mail.example', NONE, view, OFF).basis).toBe('card_address');
    // mail.example не публичный: проверяем настоящий публичный домен ниже.
    const publicView = cardSenderView(
      await seed({ name: 'Бета ИП', inn: INN_BETA, contacts: [{ email: 'beta@mail.ru' }] }),
    );
    expect(classifySender('beta@mail.ru', NONE, publicView, OFF).basis).toBe('card_address');
    expect(classifySender('stranger@mail.ru', NONE, publicView, OFF).trusted).toBe(false);
  });

  test('домен сайта карточки и ответ в наш тред - только за флагами', async () => {
    const card = await seed({
      name: 'Сайт Трейд',
      website: 'https://site-trade.example',
      contacts: [{ email: 'info@old-mail.example' }],
    });
    const view = cardSenderView(card);
    const reply = { ...NONE, replyToOurs: true };
    expect(classifySender('a@site-trade.example', NONE, view, OFF).trusted).toBe(false);
    expect(classifySender('a@site-trade.example', NONE, view, ON).basis).toBe('card_website');
    expect(classifySender('z@other.example', reply, view, OFF).trusted).toBe(false);
    expect(classifySender('z@other.example', reply, view, ON).basis).toBe('reply_thread');
    // Независимо от флагов список применимых оснований полон: по нему считается замер.
    expect(senderTrustBases('a@site-trade.example', reply, view)).toEqual([
      'card_website',
      'reply_thread',
    ]);
  });
});

describe('enrichOrCreateSupplier: доверие и реквизиты', () => {
  const evidence = (value: Partial<SenderEvidence> = {}) => async () => ({ ...NONE, ...value });

  test('непроверенный отправитель: существующая карточка не меняется, новая - только черновик', async () => {
    const card = await seed(ALPHA);
    const out = await enrichOrCreateSupplier(
      deps,
      { key: 'u1', senderKeys: ['someone@unknown.example'] },
      { name: 'Альфа Снаб', inn: INN_ALPHA, categories: ['Ручки'] },
      {
        createIfMissing: true,
        origin: 'email',
        author: 'a',
        existingCards: 'by_trust',
        trust: { evidence: evidence(), policy: OFF },
      },
    );
    expect(out.kind).toBe('ambiguous');
    expect(out.reason).toBe('untrusted_source');
    expect((await suppliers.getCard(card.id))?.supplies.categories).toEqual([]);
    const fresh = await enrichOrCreateSupplier(
      deps,
      { key: 'u2', senderKeys: ['hello@newco.example'] },
      { name: 'Новая Компания', inn: INN_BETA, website: 'https://newco.example' },
      {
        createIfMissing: true,
        origin: 'email',
        author: 'a',
        existingCards: 'by_trust',
        trust: { evidence: evidence(), policy: OFF },
      },
    );
    expect(fresh.kind).toBe('created');
    expect(await suppliers.getCard(fresh.supplierId ?? '')).not.toHaveProperty('isDraft');
  });

  test('доверенный по домену карточки: пустые поля дополняются, DKIM не запрашивается', async () => {
    const card = await seed(ALPHA);
    let asked = 0;
    const out = await enrichOrCreateSupplier(
      deps,
      { key: 'u3', senderKeys: ['manager@alfa-snab.example'] },
      { name: 'Альфа Снаб', inn: INN_ALPHA, categories: ['Ручки'] },
      {
        createIfMissing: false,
        origin: 'email',
        author: 'a',
        existingCards: 'by_trust',
        trust: {
          evidence: async () => {
            asked += 1;
            return NONE;
          },
          policy: OFF,
        },
      },
    );
    expect(out.kind).toBe('enriched');
    expect(out.trustBasis).toBe('card_domain');
    expect(asked).toBe(0);
    expect((await suppliers.getCard(card.id))?.supplies.categories).toEqual(['Ручки']);
  });

  test('доверенный по DKIM чужой домен: допустимые поля пишутся, контакты и сайт - нет', async () => {
    const card = await seed(ALPHA);
    const out = await enrichOrCreateSupplier(
      deps,
      { key: 'u4', senderKeys: ['x@holding.example'] },
      { name: 'Альфа Снаб', inn: INN_ALPHA, categories: ['Ручки'], contacts: [{ email: 'x@holding.example' }] },
      {
        createIfMissing: false,
        origin: 'email',
        author: 'a',
        existingCards: 'by_trust',
        contactDomainGuard: true,
        trust: { evidence: evidence({ dkimAligned: true }), policy: OFF },
      },
    );
    expect(out.kind).toBe('enriched');
    expect(out.trustBasis).toBe('dkim');
    const saved = await suppliers.getCard(card.id);
    expect(saved?.supplies.categories).toEqual(['Ручки']);
    expect(saved?.contacts.some((c) => c.email === 'x@holding.example')).toBe(false);
  });

  const REQUISITES: SupplierCardFields = {
    name: 'Альфа Снаб',
    inn: INN_ALPHA,
    bankName: 'Банк Новый',
    settlementAccount: '40702810900000000001',
    legalAddress: 'г. Другой, ул. Новая, 1',
  };

  // Каждый уровень доверия, включая оба ослабления при включённых флагах: реквизиты письма
  // не применяются ни на одном из них.
  interface LevelSpec {
    sender: string;
    evidence: Partial<SenderEvidence>;
    policy: SenderTrustPolicy;
    contacts?: SupplierCardFields['contacts'];
  }
  const LEVELS: Record<'dkim' | 'card' | 'website' | 'reply', LevelSpec> = {
    dkim: { sender: 'x@holding.example', evidence: { dkimAligned: true }, policy: OFF },
    card: { sender: 'sales@alfa-snab.example', evidence: {}, policy: OFF },
    website: {
      sender: 'x@alfa-snab.example',
      evidence: {},
      policy: ON,
      contacts: [{ email: 'boss.alfa@mail.example', isPrimary: true }],
    },
    reply: { sender: 'x@holding.example', evidence: { replyToOurs: true }, policy: ON },
  };

  for (const level of Object.keys(LEVELS) as Array<keyof typeof LEVELS>) {
    test(`реквизиты из письма не применяются автоматически (доверие: ${level})`, async () => {
      const spec = LEVELS[level];
      const card = await seed({
        ...ALPHA,
        ...(spec.contacts === undefined ? {} : { contacts: spec.contacts }),
        bankName: 'Банк Старый',
        settlementAccount: '40702810900000009999',
      });
      const sender = spec.sender;
      const run = (key: string) =>
        enrichOrCreateSupplier(
          deps,
          { key, senderKeys: [sender] },
          { ...REQUISITES, categories: ['Ручки'] },
          {
            createIfMissing: false,
            origin: 'email',
            author: 'a',
            existingCards: 'by_trust',
            trust: { evidence: evidence(spec.evidence), policy: spec.policy },
          },
        );
      const out = await run(`req-${level}`);
      expect(out.kind).toBe('enriched');
      const saved = await suppliers.getCard(card.id);
      // Прочее дополнено, реквизиты прежние (и пустые не заполнены).
      expect(saved?.supplies.categories).toEqual(['Ручки']);
      expect(saved?.bankName).toBe('Банк Старый');
      expect(saved?.settlementAccount).toBe('40702810900000009999');
      expect(saved?.legalAddress).toBeUndefined();
      const fields = out.requisiteChanges.map((item) => item.field).sort();
      expect(fields).toEqual(['bankName', 'legalAddress', 'settlementAccount']);
      // Пометка на карточке без значений; повтор её не задваивает.
      const marked = saved?.notes.filter((note) => note.text.includes('Реквизиты изменились'));
      expect(marked?.length).toBe(1);
      expect(marked?.[0]?.text).not.toContain('40702810900000000001');
      await run(`req-${level}-again`);
      const again = await suppliers.getCard(card.id);
      expect(again?.notes.filter((n) => n.text.includes('Реквизиты изменились')).length).toBe(1);
    });
  }

  test('режим enrich (подтверждённый отправитель) реквизитов письма тоже не применяет', async () => {
    const card = await seed({ ...ALPHA, inn: undefined });
    const out = await enrichOrCreateSupplier(
      deps,
      { key: 'u5', senderKeys: ['sales@alfa-snab.example'] },
      { name: 'Альфа Снаб', inn: INN_ALPHA, kpp: '770101001', categories: ['Ручки'] },
      { createIfMissing: false, origin: 'email', author: 'a', existingCards: 'enrich' },
    );
    expect(out.requisiteChanges.map((item) => item.field)).toContain('kpp');
    expect((await suppliers.getCard(card.id))?.kpp).toBeUndefined();
  });

  test('чат и документ: сотрудник сам называет реквизиты, ограничение письма не действует', async () => {
    const card = await seed(ALPHA);
    const out = await enrichOrCreateSupplier(
      deps,
      { key: 'u6', supplierId: card.id },
      { name: 'Альфа Снаб', kpp: '770101001' },
      { createIfMissing: false, origin: 'document', author: 'a' },
    );
    expect(out.requisiteChanges).toEqual([]);
    expect((await suppliers.getCard(card.id))?.kpp).toBe('770101001');
  });
});
