import { beforeEach, describe, expect, test } from 'bun:test';
import { runSupplierMailProposals } from '../../src/agents/suppliers/mail-proposals';
import { DAY_MS } from '../../src/kit/domain/time';
import {
  EMPLOYEE_A,
  OPTIONS,
  build,
  letter,
  supplierOf,
  type ProposalWorld,
} from './suppliers-mail-proposals-support';

/**
 * Автообогащение существующих карточек по письмам в обзоре почты (решение владельца 10.11.2026,
 * флаг `autoEnrich`): пустые поля заполняются без вопросов, заполненные и реквизиты - никогда.
 * Данные синтетические.
 */

let world: ProposalWorld;
beforeEach(() => {
  world = build();
});

const RISKY_BODY = [
  'Добрый день!',
  `${supplierOf(1).name} предлагает картонную упаковку.`,
  `ИНН ${supplierOf(1).inn}`,
  `Сайт: https://${supplierOf(1).domain}`,
  'Банк: ПАО Тестбанк',
  'БИК 044525225',
  'Р/с 40702810123456789012',
  'Директор Иванов Иван Иванович',
  'С уважением,',
  'Менеджер по продажам',
].join('\n');

async function seedExisting(extra: Record<string, unknown> = {}): Promise<string> {
  const known = supplierOf(1);
  const saved = await world.suppliers.saveCard({
    id: 'seed-1',
    name: known.name,
    status: 'active',
    contacts: [{ email: `boss@${known.domain}`, isPrimary: true }],
    supplies: { categories: [], brands: [], regions: [] },
    terms: {},
    notes: [],
    ...extra,
  });
  return saved.id;
}

async function run(overrides: Parameters<typeof letter>[2] = {}, body = RISKY_BODY) {
  world.setVerdict(() => ({
    kind: 'supplier',
    hasSupplierInfo: true,
    companyName: supplierOf(1).name,
    categories: ['картонную упаковку'],
  }));
  world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1, { body, ...overrides }));
  return runSupplierMailProposals(world.deps, OPTIONS);
}

describe('автообогащение включено', () => {
  beforeEach(() => {
    world.deps.autoEnrich = true;
  });

  test('пустые безопасные поля заполнены без сообщения сотруднику, аудит записан', async () => {
    const id = await seedExisting();
    const result = await run();
    const saved = await world.suppliers.getCard(id);
    expect(saved?.website).toContain(supplierOf(1).domain);
    expect(saved?.supplies.categories.length).toBeGreaterThan(0);
    expect(result.autoEnriched).toBe(1);
    expect(result.autoFields).toBeGreaterThan(0);
    expect(world.sentTo(EMPLOYEE_A)).toEqual([]);
    const audited = (await world.audit.list()).filter((e) => e.action === 'suppliers.card_enrich');
    expect(audited).toHaveLength(1);
    expect(audited[0]?.actor).toBe('supplier-mail-auto-enrich');
    expect(JSON.stringify(audited)).not.toContain(supplierOf(1).domain);
  });

  test('платёжные и юридические реквизиты и директор не применяются, остаётся пометка', async () => {
    const id = await seedExisting();
    const result = await run();
    const saved = await world.suppliers.getCard(id);
    expect(saved?.inn).toBeUndefined();
    expect(saved?.bik).toBeUndefined();
    expect(saved?.settlementAccount).toBeUndefined();
    expect(saved?.bankName).toBeUndefined();
    expect(saved?.directorName).toBeUndefined();
    expect(saved?.notes.some((note) => note.text.includes('Реквизиты изменились'))).toBe(true);
    expect(result.autoWithheld).toBeGreaterThan(0);
    expect(JSON.stringify(world.logs)).not.toContain('40702810123456789012');
  });

  test('заполненное поле не перезаписывается', async () => {
    const id = await seedExisting({
      website: 'https://old-site.test',
      inn: supplierOf(1).inn,
      bik: '044525000',
    });
    const result = await run();
    const saved = await world.suppliers.getCard(id);
    expect(saved?.website).toBe('https://old-site.test');
    expect(saved?.bik).toBe('044525000');
    expect(result.autoConflicts).toBeGreaterThanOrEqual(0);
  });

  test('отправитель не доверенный: карточка не меняется и не помечается', async () => {
    const id = await seedExisting();
    const result = await run({ senderAuth: 'unverified' });
    const saved = await world.suppliers.getCard(id);
    expect(saved?.website).toBeUndefined();
    expect(saved?.supplies.categories).toEqual([]);
    expect(saved?.notes).toEqual([]);
    expect(result.autoUntrusted).toBe(1);
    expect(result.autoEnriched).toBe(0);
  });

  test('второе письмо того же поставщика тоже обогащает (отметка «известен» не глушит)', async () => {
    const id = await seedExisting();
    await run();
    world.classifier.calls = 0;
    world.clock.advance(3 * DAY_MS);
    world.mailboxes.deliver(
      EMPLOYEE_A,
      letter('m2', 1, { body: RISKY_BODY, subject: 'Ещё одно' }),
    );
    await runSupplierMailProposals(world.deps, OPTIONS);
    expect(world.classifier.calls).toBe(1);
    expect((await world.suppliers.getCard(id))?.website).toBeDefined();
  });
});

describe('автообогащение выключено', () => {
  test('поведение прежнее: модель не вызывается, карточка не меняется', async () => {
    const id = await seedExisting();
    const result = await run();
    expect(world.classifier.calls).toBe(0);
    expect(result.known).toBe(1);
    expect(result.autoEnriched).toBe(0);
    const saved = await world.suppliers.getCard(id);
    expect(saved?.website).toBeUndefined();
    expect(saved?.notes).toEqual([]);
    expect(await world.audit.list()).toEqual([]);
  });
});
