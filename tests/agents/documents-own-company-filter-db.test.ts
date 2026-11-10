import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryAccessPolicy } from '@business-ai/adapters';
import {
  MemoryOwnLegalEntityRepository,
} from '../../src/kit/adapters/memory/own-legal-entity-repository';
import {
  cardFromFields,
  newCardId,
  type SupplierCardFields,
} from '../../src/agents/suppliers/card-fields';
import { createToolContext } from '@business-ai/core';
import { enrichSupplierCardFromContract } from '../../src/agents/documents/contract-card-enrich';
import { noteAttachmentText } from '../../src/agents/suppliers/document-source-text';
import { notePreparedContract } from '../../src/agents/documents/prepared-contract';
import { type DocumentsDeps } from '../../src/agents/documents/deps';
import { ACTION_CONFIRM_SUPPLIER_CARD } from '../../src/kit/domain/access.owned';
import { type SupplierCard } from '../../src/kit/domain/supplier-card';
import type { OwnLegalEntityRepository } from '../../src/kit/ports/own-legal-entities';
import { SYNTH_MASTER_GIFTS, SYNTH_PRAGMATIKA } from '../kit/support/own-entity-fixtures';
import { buildDocumentsDeps } from './support';
import { INN_ALPHA, USER_A, buildSupplierWorld, type SupplierWorld } from './suppliers-support';

/**
 * Этап 230: фильтр «наших реквизитов» при обогащении карточки читает записи наших юрлиц из БД
 * вместе с `OWN_COMPANY_REQUISITES` (объединение); без обоих источников - прежний fail closed.
 */

const BOT = 'documents';
const THREAD = `${BOT}/${USER_A}`;
const AT = '2026-11-08T10:00:00.000Z';
const SUPPLIER_PHONE = '+7 (900) 123-45-67';
const CONTRACT_TEXT = [
  `Покупатель: ${SYNTH_PRAGMATIKA.shortName}, ИНН ${SYNTH_PRAGMATIKA.inn}, ${SYNTH_PRAGMATIKA.legalAddress}.`,
  `Второе наше юрлицо: ${SYNTH_MASTER_GIFTS.shortName}, ИНН ${SYNTH_MASTER_GIFTS.inn}, ` +
    `почта ${SYNTH_MASTER_GIFTS.email}, а также office@env.example.`,
  `Поставщик: ООО «Альфа», ИНН ${INN_ALPHA}, тел. ${SUPPLIER_PHONE}, сайт https://alfa.example.`,
].join('\n');

let world: SupplierWorld;
let host: DocumentsDeps;
let events: string[];

beforeEach(async () => {
  world = buildSupplierWorld();
  const access = new MemoryAccessPolicy();
  access.allow({ userId: USER_A, botId: BOT, action: ACTION_CONFIRM_SUPPLIER_CARD });
  world.deps.access = access;
  events = [];
  host = {
    ...(await buildDocumentsDeps()),
    supplierCards: world.deps,
    log: (event) => void events.push(event),
  };
});

const ctx = () =>
  createToolContext({
    threadId: THREAD,
    agentId: BOT,
    operationId: 'op-filter-db',
    initiator: { kind: 'user', userId: USER_A },
  });

async function seed(fields: SupplierCardFields): Promise<SupplierCard> {
  const card = cardFromFields(
    fields,
    { userId: 'seed', nowIso: '2026-05-01T09:00:00.000Z', source: 'chat' },
    newCardId(fields),
  );
  return world.suppliers.saveCard(card, { createOnly: true });
}

async function run(fields: Record<string, unknown>) {
  const supplierId = String(fields['supplierId']);
  await notePreparedContract(host.state, THREAD, supplierId);
  await noteAttachmentText(host.state, THREAD, [CONTRACT_TEXT]);
  return enrichSupplierCardFromContract.execute(
    enrichSupplierCardFromContract.inputSchema.parse({
      origin: 'document',
      documentKind: 'contract',
      sourceText: CONTRACT_TEXT,
      ...fields,
    }),
    host,
    ctx(),
  );
}

const stored = async (id: string): Promise<SupplierCard> => {
  const card = await world.suppliers.getCard(id);
  if (card === null) throw new Error('карточки нет');
  return card;
};

describe('фильтр наших реквизитов: записи БД', () => {
  test('без env, но с записью БД: наш ИНН и адрес отброшены, поставщик записан', async () => {
    const repo = new MemoryOwnLegalEntityRepository();
    await repo.save('pragmatika', SYNTH_PRAGMATIKA, { updatedBy: 't', at: AT });
    host.ownEntities = repo;
    const existing = await seed({ name: 'Альфа' });
    const out = await run({
      supplierId: existing.id,
      inn: INN_ALPHA,
      legalAddress: SYNTH_PRAGMATIKA.legalAddress,
      website: 'https://alfa.example',
    });
    expect(out.status).toBe('enriched');
    const saved = await stored(existing.id);
    // Записи БД дали источник сверки: ИНН поставщика пишется, наш адрес отброшен.
    expect(saved.inn).toBe(INN_ALPHA);
    expect(saved.legalAddress).toBeUndefined();
    expect(saved.website).toBe('https://alfa.example');
    expect(out.warnings.join(' ')).toContain('отброшены поля');
    expect(out.warnings.join(' ')).not.toContain('не заданы');
  });

  test('объединение: значение из env и значение из БД отбрасываются оба', async () => {
    const repo = new MemoryOwnLegalEntityRepository();
    await repo.save('master_gifts', SYNTH_MASTER_GIFTS, { updatedBy: 't', at: AT });
    host.ownEntities = repo;
    host.ownCompanyRequisites = ['office@env.example'];
    const existing = await seed({ name: 'Альфа' });
    const out = await run({
      supplierId: existing.id,
      contacts: [
        { email: 'office@env.example' },
        { email: SYNTH_MASTER_GIFTS.email },
        { phone: SUPPLIER_PHONE },
      ],
      inn: SYNTH_MASTER_GIFTS.inn,
      website: 'https://alfa.example',
    });
    expect(out.status).toBe('enriched');
    const saved = await stored(existing.id);
    expect(saved.inn).toBeUndefined();
    expect(saved.contacts).toHaveLength(1);
    expect(saved.contacts[0]?.phone).toBeDefined();
  });

  test('ни env, ни записей: прежний fail closed (ИНН не пишется)', async () => {
    host.ownEntities = new MemoryOwnLegalEntityRepository();
    const existing = await seed({ name: 'Альфа' });
    const out = await run({
      supplierId: existing.id,
      inn: INN_ALPHA,
      website: 'https://alfa.example',
    });
    expect((await stored(existing.id)).inn).toBeUndefined();
    expect(out.warnings.join(' ')).toContain('не заданы');
  });

  test('сбой чтения БД: остаётся env, событие в журнале, значения не пишутся без источников', async () => {
    const broken: OwnLegalEntityRepository = {
      get: async () => Promise.reject(new Error('db down')),
      list: async () => Promise.reject(new Error('db down')),
      save: async () => Promise.reject(new Error('db down')),
      saveMany: async () => Promise.reject(new Error('db down')),
    };
    host.ownEntities = broken;
    const existing = await seed({ name: 'Альфа' });
    const out = await run({ supplierId: existing.id, inn: INN_ALPHA });
    expect((await stored(existing.id)).inn).toBeUndefined();
    expect(out.warnings.join(' ')).toContain('не заданы');
    expect(events).toContain('own_requisites_read_failed');
  });
});
