import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryAccessPolicy } from '@business-ai/adapters';
import {
  SUPPLIER_MAIL_PROPOSAL_NAMESPACE,
  SUPPLIER_MAIL_PROPOSAL_SEEN_NAMESPACE,
  openMailProposalBlock,
} from '../../src/agents/suppliers/mail-proposal-store';
import {
  recordMailSupplierProposalDecision,
} from '../../src/agents/suppliers/mail-proposal-decision';
import { runSupplierMailProposals } from '../../src/agents/suppliers/mail-proposals';
import { DAY_MS } from '../../src/kit/domain/time';
import {
  EMPLOYEE_A,
  EMPLOYEE_B,
  OPTIONS,
  build,
  hostOf,
  letter,
  supplierOf,
  threadOf,
  turnOf,
  ADDRESSEE_AGENT,
  type ProposalWorld,
} from './suppliers-mail-proposals-support';
import { SwitchableAccess } from './suppliers-support';

/** Ответ сотрудника на предложение завести карточки из писем (этап 222). Данные синтетические. */

let world: ProposalWorld;

async function proposeThree(): Promise<void> {
  for (let n = 1; n <= 3; n += 1) world.mailboxes.deliver(EMPLOYEE_A, letter(`m${n}`, n));
  await runSupplierMailProposals(world.deps, OPTIONS);
}

beforeEach(() => {
  world = build();
});

const decide = (
  input: Parameters<typeof recordMailSupplierProposalDecision.execute>[0],
  userId = EMPLOYEE_A,
) => recordMailSupplierProposalDecision.execute(input, hostOf(world), turnOf(userId));
const cards = () => world.suppliers.searchCards({ limit: 50 });
const namesOf = async () => (await cards()).map((card) => card.name).sort();

describe('«да»', () => {
  test('все пункты: карточки заведены без вопросов, непроверенные, из письма', async () => {
    await proposeThree();
    const out = await decide({ decision: 'create' });
    expect(out.status).toBe('done');
    expect(out.items?.map((item) => item.result)).toEqual(['created', 'created', 'created']);
    const all = await cards();
    expect(all).toHaveLength(3);
    for (const card of all) {
      expect(card).not.toHaveProperty('isDraft');
      expect(card.source).toBe('email');
      expect(card.inn).toBeDefined();
      expect(card.contacts.some((c) => c.email?.startsWith('sales@') === true)).toBe(true);
    }
    // Запись в аудит: кто, сколько полей, без значений.
    const audited = await world.audit.list();
    expect(audited.filter((entry) => entry.action === 'suppliers.card_enrich')).toHaveLength(3);
    expect(JSON.stringify(audited)).not.toContain('trade.test');
  });

  test('«только 1 и 3»: заведены выбранные, второй отклонён и больше не предлагается', async () => {
    await proposeThree();
    const out = await decide({ decision: 'create', items: [1, 3] });
    expect(out.items?.map((item) => item.result)).toEqual(['created', 'declined', 'created']);
    expect(await namesOf()).toEqual([supplierOf(1).name, supplierOf(3).name].sort());
    // Новое письмо отклонённого поставщика через интервал не предлагается.
    world.mailboxes.deliver(EMPLOYEE_A, letter('m9', 2, { subject: 'Снова мы' }));
    world.clock.advance(3 * DAY_MS);
    await runSupplierMailProposals(world.deps, OPTIONS);
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(1);
  });

  test('повтор того же ответа не плодит дубли (replay безопасен)', async () => {
    await proposeThree();
    await decide({ decision: 'create' });
    const again = await decide({ decision: 'create' });
    expect(['already_done', 'not_asked']).toContain(again.status);
    expect(await cards()).toHaveLength(3);
  });

  test('письмо исчезло из ящика: пункт пропущен, остальные заведены', async () => {
    await proposeThree();
    const box = await world.deps.mailboxes.forEmployee(EMPLOYEE_A);
    const original = box.getMessage.bind(box);
    box.getMessage = async (id) => (id === 'm2' ? null : original(id));
    const out = await decide({ decision: 'create' });
    expect(out.items?.map((item) => item.result)).toEqual(['created', 'skipped', 'created']);
    expect(await cards()).toHaveLength(2);
  });

  test('поставщик успел появиться в базе: пункт exists, дубля нет', async () => {
    await proposeThree();
    const known = supplierOf(2);
    await world.suppliers.saveCard({
      id: 'seed-1',
      name: known.name,
      inn: known.inn,
      status: 'active',
      contacts: [],
      supplies: { categories: [], brands: [], regions: [] },
      terms: {},
      notes: [],
    });
    const out = await decide({ decision: 'create' });
    expect(out.items?.[1]?.result).toBe('exists');
    expect(await cards()).toHaveLength(3);
  });

  test('сотрудник без права suppliers.confirm_card подтверждает своё предложение', async () => {
    // Решение владельца 10.11.2026: отвечает получатель, право руководителя не требуется.
    const chatOnly = new MemoryAccessPolicy();
    for (const userId of [EMPLOYEE_A, EMPLOYEE_B]) {
      chatOnly.allow({ userId, botId: ADDRESSEE_AGENT, action: 'chat.message' });
    }
    world.deps.access = chatOnly;
    await proposeThree();
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(1);
    const out = await decide({ decision: 'create' });
    expect(out.status).toBe('done');
    expect(await cards()).toHaveLength(3);
  });

  test('чужой сотрудник не может ответить на чужое предложение, карточек нет', async () => {
    await proposeThree();
    const out = await recordMailSupplierProposalDecision.execute(
      { decision: 'create' },
      hostOf(world),
      turnOf(EMPLOYEE_B, threadOf(EMPLOYEE_A)),
    );
    expect(out.status).toBe('not_asked');
    expect(await cards()).toEqual([]);
  });

  test('повторного предложения того же поставщика нет', async () => {
    await proposeThree();
    await decide({ decision: 'create' });
    for (let n = 1; n <= 3; n += 1) world.mailboxes.deliver(EMPLOYEE_A, letter(`dup${n}`, n));
    world.clock.advance(3 * DAY_MS);
    await runSupplierMailProposals(world.deps, OPTIONS);
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(1);
  });

  test('сбой справочника руководителей не мешает: право не проверяется', async () => {
    await proposeThree();
    const right = new SwitchableAccess();
    world.deps.access = right;
    right.mode = 'down';
    expect((await decide({ decision: 'create' })).status).toBe('done');
    expect(await cards()).toHaveLength(3);
  });
});

describe('«нет» и неясный ответ', () => {
  test('«нет»: все отклонены, карточек нет, повторно не предлагаются никогда', async () => {
    await proposeThree();
    const out = await decide({ decision: 'decline' });
    expect(out.status).toBe('declined');
    expect(await cards()).toEqual([]);
    for (let n = 1; n <= 3; n += 1) {
      world.mailboxes.deliver(EMPLOYEE_A, letter(`again${n}`, n));
    }
    // Хоть через год.
    world.clock.advance(365 * DAY_MS);
    await runSupplierMailProposals(world.deps, OPTIONS);
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(1);
    const seen = await world.state.list(SUPPLIER_MAIL_PROPOSAL_SEEN_NAMESPACE, null, 100);
    expect(seen.every((entry) => (entry.value as { status: string }).status === 'declined')).toBe(
      true,
    );
  });

  test('«нет, 2 не надо»: отклонён только второй, остальные ждут ответа', async () => {
    await proposeThree();
    const out = await decide({ decision: 'decline', items: [2] });
    expect(out.items?.map((item) => item.result)).toEqual(['open', 'declined', 'open']);
    expect((await decide({ decision: 'create' })).status).toBe('done');
    expect(await cards()).toHaveLength(2);
  });

  test('неясный ответ: карточек нет, вопрос повторяется один раз', async () => {
    await proposeThree();
    const first = await decide({ decision: 'unclear' });
    expect(first).toMatchObject({ status: 'unclear', repeatQuestion: true });
    const second = await decide({ decision: 'unclear' });
    expect(second).toMatchObject({ status: 'unclear', repeatQuestion: false });
    expect(await cards()).toEqual([]);
  });

  test('предложения нет: not_asked', async () => {
    expect((await decide({ decision: 'create' })).status).toBe('not_asked');
  });

  test('чужое предложение недоступно: ответ другого сотрудника ничего не создаёт', async () => {
    await proposeThree();
    const out = await recordMailSupplierProposalDecision.execute(
      { decision: 'create' },
      hostOf(world),
      turnOf(EMPLOYEE_B, threadOf(EMPLOYEE_A)),
    );
    expect(out.status).toBe('not_asked');
    expect(await cards()).toEqual([]);
  });

  test('номер вне списка: ошибка вызова, ничего не создано', async () => {
    await proposeThree();
    const out = await decide({ decision: 'create', items: [7] });
    expect(out.status).toBe('bad_items');
    expect(await cards()).toEqual([]);
  });

  test('не ход сотрудника (плановый запуск): запись запрещена', async () => {
    await proposeThree();
    const { createToolContext } = await import('@business-ai/core');
    const scheduled = createToolContext({
      threadId: threadOf(EMPLOYEE_A),
      agentId: ADDRESSEE_AGENT,
      operationId: 'op-sched',
      initiator: { kind: 'scheduler' },
    });
    await expect(
      recordMailSupplierProposalDecision.execute({ decision: 'create' }, hostOf(world), scheduled),
    ).rejects.toThrow();
    expect(await cards()).toEqual([]);
  });
});

describe('блок состояния хода и очистка', () => {
  test('открытое предложение попадает в системный блок; закрытое - нет', async () => {
    await proposeThree();
    const block = await openMailProposalBlock(world.deps, threadOf(EMPLOYEE_A));
    expect(block?.text).toContain('1. ');
    expect(block?.text).toContain('recordMailSupplierProposalDecision');
    await decide({ decision: 'create' });
    expect(await openMailProposalBlock(world.deps, threadOf(EMPLOYEE_A))).toBeNull();
    expect(await openMailProposalBlock(world.deps, threadOf(EMPLOYEE_B))).toBeNull();
  });

  test('закрытое предложение не хранит названий и тем', async () => {
    await proposeThree();
    await decide({ decision: 'create' });
    const entries = await world.state.list(SUPPLIER_MAIL_PROPOSAL_NAMESPACE, null, 100);
    const text = JSON.stringify(entries.map((entry) => entry.value));
    expect(text).not.toContain(supplierOf(1).name);
    expect(text).not.toContain('Предложение 1');
  });

  test('ПДн нет и в журнале решения', async () => {
    await proposeThree();
    await decide({ decision: 'create' });
    const logged = JSON.stringify(world.logs);
    expect(logged).not.toContain(supplierOf(1).domain);
    expect(logged).not.toContain(supplierOf(1).inn);
  });
});
