import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryPairNoteStore } from '@business-ai/adapters';
import { confirmSupplierRequest } from '../../src/agents/suppliers/card-decision';
import {
  recordMailSupplierProposalDecision,
} from '../../src/agents/suppliers/mail-proposal-decision';
import { runSupplierMailProposals } from '../../src/agents/suppliers/mail-proposals';
import { type OrderCalcDeps } from '../../src/agents/order-calc/deps';
import {
  EMPLOYEE_A,
  OPTIONS,
  build,
  letter,
  supplierOf,
  threadOf,
  turnOf,
  type ProposalWorld,
} from './suppliers-mail-proposals-support';

/**
 * 222: реквизиты письма не применяются к существующей карточке автоматически, но и не теряются
 * (ревью 233): сотруднику показывается правка карточки с этими реквизитами тем же запросом
 * подтверждения, что у `prepareSupplierCardEdit`; пометка на карточке ссылается на письмо
 * номером и датой, без значений и без темы.
 */

let world: ProposalWorld;
beforeEach(() => {
  world = build();
  world.deps.senderTrust = { policy: { websiteDomain: false, replyThread: false } };
});

/** Хозяин с модулем карточек: общий запрос подтверждения работает в треде сотрудника. */
function hostWithCards(): OrderCalcDeps {
  return {
    mailProposals: world.deps,
    supplierCards: {
      suppliers: world.suppliers,
      chat: world.chat,
      clock: world.clock,
      state: world.state,
      pairNotes: new MemoryPairNoteStore(),
      audit: world.audit,
      access: world.access,
    },
  } as unknown as OrderCalcDeps;
}

const hostWithoutCards = (): OrderCalcDeps =>
  ({ mailProposals: world.deps }) as unknown as OrderCalcDeps;

async function propose(): Promise<void> {
  world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1, { dkim: 'aligned' }));
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

const decide = (host: OrderCalcDeps) =>
  recordMailSupplierProposalDecision.execute({ decision: 'create' }, host, turnOf(EMPLOYEE_A));

describe('222: реквизиты письма и подтверждение сотрудника', () => {
  test('правка с реквизитами показана; «да» применяет их, до этого карточка цела', async () => {
    await propose();
    const id = await seedExisting();
    const out = await decide(hostWithCards());
    expect(out.status).toBe('done');
    expect(out.message).toContain('confirmSupplierRequest');
    // До ответа сотрудника ИНН в карточке нет.
    expect((await world.suppliers.getCard(id))?.inn).toBeUndefined();
    // Сотруднику ушёл показ правки с подсказкой ответа (общий запрос подтверждения).
    const shown = world.sentTo(EMPLOYEE_A).at(-1) ?? '';
    expect(shown).toContain('Сохранить изменения?');
    // Ответ «да, сохраняй» записывает реквизиты.
    const confirmed = await confirmSupplierRequest.execute(
      { decision: 'save' },
      { supplierCards: hostWithCards().supplierCards } as never,
      turnOf(EMPLOYEE_A, threadOf(EMPLOYEE_A)),
    );
    expect(confirmed.status).toBe('saved');
    expect((await world.suppliers.getCard(id))?.inn).toBe(supplierOf(1).inn);
  });

  test('пометка на карточке: номер и дата письма, без значений реквизитов и без темы', async () => {
    await propose();
    const id = await seedExisting();
    await decide(hostWithCards());
    const note = (await world.suppliers.getCard(id))?.notes.find((item) =>
      item.text.includes('Реквизиты изменились'),
    );
    expect(note).toBeDefined();
    expect(note?.text).toContain('Источник: №');
    expect(note?.text).toContain('письмо от 2026-10-11');
    expect(note?.text).not.toContain(supplierOf(1).inn);
    expect(note?.text).not.toContain('Предложение 1');
  });

  test('«нет» на показ правки: реквизиты не применены', async () => {
    await propose();
    const id = await seedExisting();
    await decide(hostWithCards());
    const declined = await confirmSupplierRequest.execute(
      { decision: 'cancel' },
      { supplierCards: hostWithCards().supplierCards } as never,
      turnOf(EMPLOYEE_A, threadOf(EMPLOYEE_A)),
    );
    expect(declined.status).not.toBe('saved');
    expect((await world.suppliers.getCard(id))?.inn).toBeUndefined();
  });

  test('нет модуля карточек у агента: правки нет, остаётся пометка, текст честный', async () => {
    await propose();
    const id = await seedExisting();
    const sentBefore = world.sentTo(EMPLOYEE_A).length;
    const out = await decide(hostWithoutCards());
    expect(out.status).toBe('done');
    expect(out.message).not.toContain('confirmSupplierRequest');
    expect(out.message).toContain('правкой карточки');
    expect(world.sentTo(EMPLOYEE_A).length).toBe(sentBefore);
    const saved = await world.suppliers.getCard(id);
    expect(saved?.inn).toBeUndefined();
    expect(saved?.notes.some((note) => note.text.includes('Реквизиты изменились'))).toBe(true);
  });

  test('в журнале нет значений реквизитов', async () => {
    await propose();
    await seedExisting();
    await decide(hostWithCards());
    expect(JSON.stringify(world.logs)).not.toContain(String(supplierOf(1).inn));
  });
});
