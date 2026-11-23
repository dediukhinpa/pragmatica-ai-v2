import { beforeEach, describe, expect, test } from 'bun:test';
import {
  recordMailSupplierProposalDecision,
} from '../../src/agents/suppliers/mail-proposal-decision';
import { runSupplierMailProposals } from '../../src/agents/suppliers/mail-proposals';
import {
  EMPLOYEE_A,
  OPTIONS,
  build,
  hostOf,
  letter,
  supplierOf,
  turnOf,
  type ProposalWorld,
} from './suppliers-mail-proposals-support';

/**
 * Обзор почты сотрудников (222) с моделью доверия (этап 233). Предложение поставщика строится
 * по письму; пока сотрудник отвечал, карточка появилась в базе: что письмо может в ней менять.
 */

let world: ProposalWorld;
beforeEach(() => {
  world = build();
});

const decide = () =>
  recordMailSupplierProposalDecision.execute({ decision: 'create' }, hostOf(world), turnOf(EMPLOYEE_A));

async function propose(overrides: Parameters<typeof letter>[2] = {}): Promise<void> {
  world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1, overrides));
  await runSupplierMailProposals(world.deps, OPTIONS);
}

async function seedExisting(): Promise<string> {
  const known = supplierOf(1);
  const saved = await world.suppliers.saveCard({
    id: 'seed-1',
    name: known.name,
    status: 'active',
    contacts: [{ email: `boss@${known.domain}`, isPrimary: true }],
    supplies: { categories: [], brands: [], regions: [] },
    terms: {},
    notes: [],
  });
  return saved.id;
}

describe('222 с моделью доверия', () => {
  test('модель выключена: письмо без подтверждения сервера карточку не меняет (как раньше)', async () => {
    await propose({ senderAuth: 'unverified' });
    const id = await seedExisting();
    const out = await decide();
    expect(out.items?.[0]?.result).toBe('skipped');
    expect((await world.suppliers.getCard(id))?.website).toBeUndefined();
  });

  test('домен отправителя есть в карточке: сайт дописан, ИНН из письма - нет, пометка', async () => {
    world.deps.senderTrust = { policy: { websiteDomain: false, replyThread: false } };
    await propose({ senderAuth: 'unverified' });
    const id = await seedExisting();
    const out = await decide();
    expect(out.status).toBe('done');
    expect(out.message).toContain('НЕ применены');
    const saved = await world.suppliers.getCard(id);
    expect(saved?.website).toContain(supplierOf(1).domain);
    expect(saved?.inn).toBeUndefined();
    expect(saved?.notes.some((note) => note.text.includes('Реквизиты изменились'))).toBe(true);
    expect(JSON.stringify(world.logs)).not.toContain(String(supplierOf(1).inn));
  });

  test('чужой домен без DKIM: карточка не меняется и не помечается', async () => {
    world.deps.senderTrust = { policy: { websiteDomain: false, replyThread: false } };
    await propose({ senderAuth: 'unverified', from: 'sales@intruder.test' });
    const id = await seedExisting();
    await decide();
    const saved = await world.suppliers.getCard(id);
    expect(saved?.website).toBeUndefined();
    expect(saved?.notes).toEqual([]);
  });

  test('сервер сказал pass, своего DKIM нет: чужой домен карточку не меняет', async () => {
    world.deps.senderTrust = { policy: { websiteDomain: false, replyThread: false } };
    await propose({ senderAuth: 'verified', serverAuth: 'verified', from: 'sales@intruder.test' });
    const id = await seedExisting();
    await decide();
    const saved = await world.suppliers.getCard(id);
    expect(saved?.website).toBeUndefined();
    expect(saved?.contacts.some((c) => c.email === 'sales@intruder.test')).toBe(false);
    expect(saved?.notes).toEqual([]);
  });

  test('DKIM выровнен у письма: основание dkim, реквизиты всё равно не пишутся', async () => {
    world.deps.senderTrust = { policy: { websiteDomain: false, replyThread: false } };
    await propose({ senderAuth: 'unverified', from: 'sales@intruder.test', dkim: 'aligned' });
    const id = await seedExisting();
    await decide();
    const saved = await world.suppliers.getCard(id);
    expect(saved?.inn).toBeUndefined();
    expect(saved?.contacts.some((c) => c.email === 'sales@intruder.test')).toBe(false);
  });
});
