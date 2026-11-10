import { beforeEach, describe, expect, test } from 'bun:test';
import {
  UNPARSED_SUPPLIER_ID,
  parseBackfillReport,
  type BackfillReport,
  type BackfillReportItem,
} from '../../src/agents/suppliers/mail-backfill-report';
import {
  applyBackfillReport,
  recheckBackfillReport,
} from '../../src/agents/suppliers/mail-backfill-apply';
import type { SupplierCard } from '../../src/kit/domain/supplier-card';
import { INN_ALPHA } from './suppliers-support';
import {
  RECEIVED_AT,
  SOURCE_ID,
  allCards,
  build,
  letter,
  run,
  seed,
  type World,
} from './suppliers-mail-backfill-support';

/** Применение подтверждённых пунктов отчёта разового прохода (этап 220b). */

let world: World;
let supplierId = '';

beforeEach(async () => {
  world = build();
  const card = await seed(world, {
    name: 'Старая Фирма',
    inn: INN_ALPHA,
    contacts: [{ email: 'office@vega-trade.test', isPrimary: true }],
  });
  supplierId = card.id;
  world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
  await run(world);
});

function report(): BackfillReport {
  const current = world.file.report;
  if (current === null) throw new Error('отчёта нет');
  return structuredClone(current);
}

function item(source: BackfillReport, field: string): BackfillReportItem {
  const found = source.items.find((entry) => entry.field === field && entry.kind === 'fill');
  if (found === undefined) throw new Error(`нет пункта ${field}`);
  return found;
}

const applyDeps = (): Parameters<typeof applyBackfillReport>[1] => ({
  suppliers: world.suppliers,
  clock: world.clock,
  audit: world.audit,
  log: world.deps.log,
});

describe('применение отчёта', () => {
  test('без подтверждения ничего не применяется', async () => {
    const source = report();
    const before = JSON.stringify(await allCards(world));
    const result = await applyBackfillReport(source, applyDeps(), { dryRun: false });
    expect(result.applied).toBe(0);
    expect(result.notApproved).toBe(source.items.length);
    expect(JSON.stringify(await allCards(world))).toBe(before);
  });

  test('применяются только подтверждённые пункты', async () => {
    const source = report();
    item(source, 'website').approved = true;
    const result = await applyBackfillReport(source, applyDeps(), { dryRun: false });
    expect(result.applied).toBe(1);
    const card = await world.suppliers.getCard(supplierId);
    expect(card?.website).toContain('vega-trade.test');
    // Контакт не подтверждён - не добавлен.
    expect(card?.contacts.some((contact) => contact.email === 'sales@vega-trade.test')).toBe(false);
    expect(item(source, 'website')).toMatchObject({ status: 'applied' });
    expect(card?.notes.some((note) => note.text.includes('по подтверждению'))).toBe(true);
    expect((await world.audit.list()).some((entry) => entry.details.includes('item='))).toBe(true);
  });

  async function editCard(change: (card: SupplierCard) => SupplierCard): Promise<void> {
    world.clock.advance(60_000);
    const card = await world.suppliers.getCard(supplierId);
    if (card === null) throw new Error('карточки нет');
    await world.suppliers.saveCard(
      { ...change(card), updatedAt: world.clock.now().toISOString() },
      { expectedUpdatedAt: card.updatedAt },
    );
  }

  test('правка другого поля после отчёта пункту не мешает (ревью 220b, п. 3)', async () => {
    const source = report();
    item(source, 'website').approved = true;
    await editCard((card) => ({ ...card, strengths: 'правка сотрудника' }));
    const result = await applyBackfillReport(source, applyDeps(), { dryRun: false });
    expect(result).toMatchObject({ applied: 1, skippedChanged: 0 });
    expect((await world.suppliers.getCard(supplierId))?.website).toContain('vega-trade.test');
  });

  test('правка того же поля: пункт пропущен с причиной, карточка не тронута', async () => {
    const source = report();
    item(source, 'contacts').approved = true;
    await editCard((card) => ({
      ...card,
      contacts: [...card.contacts, { email: 'other@vega-trade.test', isPrimary: false }],
    }));
    const result = await applyBackfillReport(source, applyDeps(), { dryRun: false });
    expect(result).toMatchObject({ applied: 0, skippedChanged: 1 });
    expect(item(source, 'contacts')).toMatchObject({ status: 'skipped', reason: 'card_changed' });
    const card = await world.suppliers.getCard(supplierId);
    expect(card?.contacts.some((contact) => contact.email === 'sales@vega-trade.test')).toBe(false);
  });

  test('--recheck возвращает пропущенный card_changed на повторное подтверждение', async () => {
    const source = report();
    const stale = item(source, 'contacts');
    stale.approved = true;
    await editCard((card) => ({
      ...card,
      contacts: [...card.contacts, { email: 'other@vega-trade.test', isPrimary: false }],
    }));
    await applyBackfillReport(source, applyDeps(), { dryRun: false });
    const before = JSON.stringify(source);
    const dry = await recheckBackfillReport(source, applyDeps(), { dryRun: true });
    expect(dry.reopened).toBe(1);
    expect(JSON.stringify(source)).toBe(before);
    const result = await recheckBackfillReport(source, applyDeps(), { dryRun: false });
    expect(result).toMatchObject({ reopened: 1, alreadyPresent: 0, unchanged: 0 });
    const reopened = item(source, 'contacts');
    expect(reopened).toMatchObject({ status: 'pending', approved: false });
    expect(reopened.reason).toBeUndefined();
    expect(reopened.proposed).toContain('other@vega-trade.test');
    expect(reopened.proposed).toContain('sales@vega-trade.test');
    expect(reopened.letters).toEqual(stale.letters);
    // Подтверждён заново - применяется и дописывает контакт письма.
    reopened.approved = true;
    const applied = await applyBackfillReport(source, applyDeps(), { dryRun: false });
    expect(applied.applied).toBe(1);
    const card = await world.suppliers.getCard(supplierId);
    expect(card?.contacts.map((contact) => contact.email)).toContain('sales@vega-trade.test');
  });

  test('--recheck: сведения уже в карточке - пункт закрыт как already_present', async () => {
    const source = report();
    item(source, 'contacts').approved = true;
    await editCard((card) => ({
      ...card,
      contacts: [
        ...card.contacts,
        {
          email: 'sales@vega-trade.test',
          fullName: 'Петров Пётр Петрович',
          position: 'Менеджер по продажам',
          phone: '+74951112233',
          isPrimary: false,
        },
      ],
    }));
    await applyBackfillReport(source, applyDeps(), { dryRun: false });
    const result = await recheckBackfillReport(source, applyDeps(), { dryRun: false });
    expect(result.reopened).toBe(0);
    expect(item(source, 'contacts')).toMatchObject({
      status: 'skipped',
      reason: 'already_present',
    });
  });

  test('--recheck не трогает прочие пункты', async () => {
    const source = report();
    item(source, 'website').approved = true;
    const snapshot = JSON.stringify(source);
    const result = await recheckBackfillReport(source, applyDeps(), { dryRun: false });
    expect(result).toMatchObject({ reopened: 0 });
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  test('повторное применение безопасно: пункт закрыт, заметка не задваивается', async () => {
    const source = report();
    item(source, 'website').approved = true;
    await applyBackfillReport(source, applyDeps(), { dryRun: false });
    const notes = (await world.suppliers.getCard(supplierId))?.notes.length;
    const again = await applyBackfillReport(source, applyDeps(), { dryRun: false });
    expect(again).toMatchObject({ applied: 0, alreadyResolved: 1 });
    expect((await world.suppliers.getCard(supplierId))?.notes.length).toBe(notes);
  });

  test('запись прошла, а отчёт не сохранился: повтор узнаёт пункт по заметке', async () => {
    const source = report();
    item(source, 'website').approved = true;
    const stale = structuredClone(source);
    await applyBackfillReport(source, applyDeps(), { dryRun: false });
    const again = await applyBackfillReport(stale, applyDeps(), { dryRun: false });
    expect(again.applied).toBe(0);
    expect(item(stale, 'website').status).toBe('applied');
  });

  test('пункт conflict не применяется даже подтверждённый', async () => {
    const source = report();
    source.items.push({
      ...item(source, 'website'),
      id: 'conflict-1',
      kind: 'conflict',
      patch: undefined,
      approved: true,
    });
    const result = await applyBackfillReport(source, applyDeps(), { dryRun: false });
    expect(result).toMatchObject({ applied: 0, skippedNotApplicable: 1 });
  });

  test('карточки больше нет: пункт пропущен', async () => {
    const source = report();
    const entry = item(source, 'website');
    entry.approved = true;
    entry.supplierId = 'sup-missing';
    const result = await applyBackfillReport(source, applyDeps(), { dryRun: false });
    expect(result.skippedMissing).toBe(1);
  });

  test('пробное применение ничего не пишет и отчёт не меняет', async () => {
    const source = report();
    item(source, 'website').approved = true;
    const snapshot = JSON.stringify(source);
    const before = JSON.stringify(await allCards(world));
    const result = await applyBackfillReport(source, applyDeps(), { dryRun: true });
    expect(result.applied).toBe(1);
    expect(JSON.stringify(await allCards(world))).toBe(before);
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  test('итог содержит только счётчики и номера пунктов', async () => {
    const source = report();
    item(source, 'website').approved = true;
    const result = await applyBackfillReport(source, applyDeps(), { dryRun: false });
    const dump = JSON.stringify(result);
    for (const secret of ['vega-trade', INN_ALPHA, '@']) expect(dump).not.toContain(secret);
  });
});

describe('сверка записываемого с тем, что подтвердил человек (ревью 220b, п. 7)', () => {
  test('номер пункта не совпадает с содержимым: не применяется', async () => {
    const source = report();
    const entry = item(source, 'website');
    entry.approved = true;
    entry.proposed = 'https://подмена.test';
    const result = await applyBackfillReport(source, applyDeps(), { dryRun: false });
    expect(result).toMatchObject({ applied: 0, skippedNotApplicable: 1 });
    expect((await world.suppliers.getCard(supplierId))?.website).toBeUndefined();
  });

  test('patch пишет не то поле, что в пункте: не применяется', async () => {
    const source = report();
    const entry = item(source, 'website');
    entry.approved = true;
    entry.patch = { strengths: 'подставленное' };
    const result = await applyBackfillReport(source, applyDeps(), { dryRun: false });
    expect(result).toMatchObject({ applied: 0, skippedNotApplicable: 1 });
    expect((await world.suppliers.getCard(supplierId))?.strengths).toBeUndefined();
  });

  test('patch пишет то же поле, но другое значение: не применяется', async () => {
    const source = report();
    const entry = item(source, 'website');
    entry.approved = true;
    entry.patch = { website: 'https://other.test' };
    const result = await applyBackfillReport(source, applyDeps(), { dryRun: false });
    expect(result).toMatchObject({ applied: 0, skippedNotApplicable: 1 });
  });

  test('схема отчёта отвергает служебные ключи patch (статус, заметка, очистка)', () => {
    for (const patch of [{ status: 'blocked' }, { note: 'x' }, { clear: ['website'] }, {}]) {
      const broken = report();
      item(broken, 'website').patch = patch as never;
      expect(() => parseBackfillReport(JSON.stringify(broken))).toThrow('backfill_report_invalid');
    }
    expect(() => parseBackfillReport(JSON.stringify(report()))).not.toThrow();
  });

  test('пункт «не разобрано» применению не подлежит', async () => {
    const source = report();
    source.items.push({
      id: 'unparsed-1',
      supplierId: UNPARSED_SUPPLIER_ID,
      kind: 'unparsed',
      field: 'letter',
      was: null,
      proposed: 'invalid_answer',
      cardVersion: '',
      letters: [{ id: 'm9', receivedAt: RECEIVED_AT }],
      approved: true,
      status: 'pending',
    });
    const result = await applyBackfillReport(source, applyDeps(), { dryRun: false });
    expect(result.skippedNotApplicable).toBe(1);
  });
});
