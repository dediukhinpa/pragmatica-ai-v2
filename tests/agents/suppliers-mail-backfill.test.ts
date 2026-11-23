import { beforeEach, describe, expect, test } from 'bun:test';
import { FOREIGN_SENDER_CONFLICT_FIELD } from '../../src/agents/suppliers/card-enrichment';
import { PiiRejectedError } from '@business-ai/core';
import {
  SUPPLIER_MAIL_BACKFILL_WINDOW_DAYS,
  SUPPLIER_MAIL_CURSOR_NAMESPACE,
  SUPPLIER_MAIL_SEEN_NAMESPACE,
} from '../../src/agents/suppliers/mail-enrich';
import { DomainError } from '@business-ai/core';
import { SupplierMailInvalidAnswerError } from '../../src/kit/ports/supplier-mail-classifier';
import { type InboxMessage, type SourceMailbox } from '@business-ai/core';
import { INN_ALPHA } from './suppliers-support';
import {
  OUR_INN,
  SOURCE_ADDRESS,
  SOURCE_ID,
  SUPPLIER_VERDICT,
  allCards,
  build,
  letter,
  otherLetter,
  run,
  seed,
  type World,
} from './suppliers-mail-backfill-support';

/**
 * Разовый проход по общему ящику (этап 220b). Данные синтетические; ящик и классификатор -
 * заглушки. Без Postgres.
 */

let world: World;
beforeEach(() => {
  world = build();
});

describe('новый поставщик', () => {
  test('письмо поставщика создаёт непроверенную карточку; отправитель не подтверждён', async () => {
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    const result = await run(world);
    expect(result).toMatchObject({ status: 'done', scanned: 1, created: 1, stoppedBy: 'none' });
    const [card] = await allCards(world);
    expect(card?.name).toBe('ООО «Вега Трейд»');
    expect(card).not.toHaveProperty('isDraft');
    expect(card?.inn).toBe(INN_ALPHA);
    expect(card?.website).toContain('vega-trade.test');
    expect(card?.source).toBe('email');
    // В заметке указан источник и то, что отправитель не подтверждён.
    const note = card?.notes.map((item) => item.text).join('\n') ?? '';
    expect(note).toContain('info@, отправитель не подтверждён');
  });

  test('окно по умолчанию - два года: письмо в окне читается, старше окна - нет', async () => {
    world.mailboxes.deliverToSource(
      SOURCE_ID,
      letter('old', { receivedAt: '2019-01-01T00:00:00.000Z' }),
    );
    world.mailboxes.deliverToSource(
      SOURCE_ID,
      letter('fresh', {
        receivedAt: '2025-05-01T00:00:00.000Z',
        from: 'sales@other-trade.test',
        body: 'ООО «Омега Трейд», сайт omega-trade.test',
      }),
    );
    const result = await run(world);
    expect(SUPPLIER_MAIL_BACKFILL_WINDOW_DAYS).toBe(730);
    expect(result.skippedOld).toBe(1);
    expect(result.classified).toBe(1);
  });

  test('параметр окна расширяет проход: письмо трёхлетней давности читается', async () => {
    world.mailboxes.deliverToSource(
      SOURCE_ID,
      letter('old', { receivedAt: '2023-05-01T00:00:00.000Z' }),
    );
    const result = await run(world, { windowDays: 2000 });
    expect(result.skippedOld).toBe(0);
    expect(result.created).toBe(1);
  });

  test('чужое название вне текста не принимается: нет названия - нет карточки', async () => {
    world.setVerdict(() => ({ ...SUPPLIER_VERDICT, companyName: 'ООО «Выдуманная»' }));
    world.mailboxes.deliverToSource(
      SOURCE_ID,
      letter('m1', { from: 'someone@gmail.com', body: 'Предлагаем сотрудничество, звоните.' }),
    );
    const result = await run(world);
    expect(result).toMatchObject({ created: 0, noName: 1 });
    expect(await allCards(world)).toEqual([]);
  });

  test('бесплатный адрес и письмо без ИНН и сайта карточку не создают', async () => {
    world.mailboxes.deliverToSource(SOURCE_ID, letter('free', { from: 'sales@gmail.com' }));
    world.mailboxes.deliverToSource(
      SOURCE_ID,
      letter('bare', { body: 'ООО «Вега Трейд» предлагает упаковку, звоните.' }),
    );
    const result = await run(world);
    expect(result).toMatchObject({ created: 0, notCreated: 2 });
    expect(await allCards(world)).toEqual([]);
  });

  test('рассылки, системные и свои отправители пропускаются без модели', async () => {
    world.mailboxes.deliverToSource(SOURCE_ID, letter('b', { bulk: true }));
    world.mailboxes.deliverToSource(SOURCE_ID, letter('s', { from: 'noreply@vega.test' }));
    world.mailboxes.deliverToSource(SOURCE_ID, letter('o', { from: 'boss@company.test' }));
    const result = await run(world);
    expect(result).toMatchObject({ skippedBulk: 1, skippedSystem: 1, skippedOwn: 1 });
    expect(world.classifier.calls).toBe(0);
  });

  test('наши реквизиты из письма не попадают в карточку', async () => {
    world.mailboxes.deliverToSource(
      SOURCE_ID,
      letter('m1', {
        body: `ООО «Вега Трейд». ИНН ${OUR_INN}. Сайт: https://vega-trade.test`,
      }),
    );
    await run(world);
    expect(JSON.stringify(await allCards(world))).not.toContain(OUR_INN);
  });

  test('предела числа созданий нет: все письма разбираются за один запуск', async () => {
    for (let i = 1; i <= 3; i += 1) {
      const host = `firm${i}.test`;
      world.mailboxes.deliverToSource(SOURCE_ID, otherLetter(`m${i}`, host, `Фирма ${i}`));
    }
    const first = await run(world);
    expect(first).toMatchObject({ created: 3, stoppedBy: 'none' });
    expect(await allCards(world)).toHaveLength(3);
  });
});

describe('существующий поставщик: карточка не меняется, предложение уходит в отчёт', () => {
  test('пустые поля карточки попадают в отчёт, сама карточка не тронута', async () => {
    const existing = await seed(world, {
      name: 'Вега Трейд',
      inn: INN_ALPHA,
      contacts: [{ email: 'office@vega-trade.test', isPrimary: true }],
    });
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    const before = JSON.stringify(await allCards(world));
    const result = await run(world);
    expect(result).toMatchObject({ created: 0, proposalLetters: 1 });
    expect(result.reportItems).toBeGreaterThan(0);
    expect(JSON.stringify(await allCards(world))).toBe(before);
    const items = world.file.report?.items ?? [];
    const site = items.find((item) => item.field === 'website');
    expect(site).toMatchObject({
      supplierId: existing.id,
      kind: 'fill',
      was: null,
      approved: false,
      status: 'pending',
    });
    expect(site?.proposed).toContain('vega-trade.test');
    expect(site?.letters).toEqual([{ id: 'm1', receivedAt: '2024-11-11T10:00:00.000Z' }]);
    expect(site?.cardVersion).toBe(existing.updatedAt ?? '');
  });

  test('значение, расходящееся с карточкой, - пункт conflict без patch', async () => {
    await seed(world, {
      name: 'Вега Трейд',
      inn: INN_ALPHA,
      website: 'https://old-site.test',
      contacts: [{ email: 'office@vega-trade.test', isPrimary: true }],
    });
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    await run(world);
    const conflict = world.file.report?.items.find((item) => item.kind === 'conflict');
    expect(conflict).toBeDefined();
    expect(conflict?.patch).toBeUndefined();
  });

  test('отправитель не из доменов карточки: контакты не предлагаются, это conflict', async () => {
    await seed(world, {
      name: 'Вега Трейд',
      inn: INN_ALPHA,
      contacts: [{ email: 'office@vega-trade.test', isPrimary: true }],
    });
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1', { from: 'evil@phish.test' }));
    await run(world);
    const items = world.file.report?.items ?? [];
    expect(items.some((item) => item.kind === 'fill' && item.field === 'contacts')).toBe(false);
    expect(items.some((item) => item.field === FOREIGN_SENDER_CONFLICT_FIELD)).toBe(true);
  });

  test('всё уже в карточке: пунктов нет', async () => {
    await seed(world, {
      name: 'Вега Трейд',
      inn: INN_ALPHA,
      website: 'https://vega-trade.test',
      contacts: [{ email: 'sales@vega-trade.test', isPrimary: true }],
    });
    world.mailboxes.deliverToSource(
      SOURCE_ID,
      letter('m1', { body: `ООО «Вега Трейд». ИНН ${INN_ALPHA}. Сайт: https://vega-trade.test` }),
    );
    const result = await run(world);
    expect(result.reportItems).toBe(0);
  });
});

describe('пробный запуск', () => {
  test('ничего не пишет: ни карточек, ни отметок, ни курсора; отчёт заполняется', async () => {
    await seed(world, {
      name: 'Старая Фирма',
      inn: INN_ALPHA,
      contacts: [{ email: 'office@vega-trade.test', isPrimary: true }],
    });
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    world.mailboxes.deliverToSource(SOURCE_ID, otherLetter('m2', 'new-firm.test', 'Новая Фирма'));
    world.mailboxes.deliverToSource(SOURCE_ID, otherLetter('m3', 'new-firm.test', 'Новая Фирма'));
    const before = JSON.stringify(await allCards(world));
    const result = await run(world, { dryRun: true });
    // Две письма одной новой компании - одна будущая карточка.
    expect(result).toMatchObject({ created: 0, wouldCreate: 1, proposalLetters: 1 });
    expect(JSON.stringify(await allCards(world))).toBe(before);
    expect(await world.state.list(SUPPLIER_MAIL_SEEN_NAMESPACE, null, 50)).toEqual([]);
    expect(await world.state.get(SUPPLIER_MAIL_CURSOR_NAMESPACE, SOURCE_ID)).toBeNull();
    expect(await world.audit.list()).toEqual([]);
    expect(world.file.report?.items.length).toBeGreaterThan(0);
    expect(world.file.report?.run?.dryRun).toBe(true);
  });

  test('после пробного запуска настоящий создаёт карточки', async () => {
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    await run(world, { dryRun: true });
    const result = await run(world);
    expect(result.created).toBe(1);
  });
});

describe('повторный запуск без дублей', () => {
  test('карточки не задваиваются, пункты отчёта и ссылки не повторяются', async () => {
    await seed(world, {
      name: 'Старая Фирма',
      inn: INN_ALPHA,
      contacts: [{ email: 'office@vega-trade.test', isPrimary: true }],
    });
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    world.mailboxes.deliverToSource(SOURCE_ID, otherLetter('m2', 'new-firm.test', 'Новая Фирма'));
    await run(world);
    const cards = (await allCards(world)).length;
    const items = JSON.stringify(world.file.report?.items);
    classifierCallsAfterFirst = world.classifier.calls;
    const second = await run(world);
    // Курсор стоит в конце ящика: разобранные письма даже не перечитываются.
    expect(second).toMatchObject({ created: 0, scanned: 0, reportItems: 0 });
    expect((await allCards(world)).length).toBe(cards);
    expect(JSON.stringify(world.file.report?.items)).toBe(items);
    // Разобранные письма модель не видит повторно.
    expect(world.classifier.calls).toBe(classifierCallsAfterFirst);
  });

  async function twoLetters(): Promise<void> {
    await seed(world, {
      name: 'Старая Фирма',
      inn: INN_ALPHA,
      contacts: [{ email: 'office@vega-trade.test', isPrimary: true }],
    });
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    world.mailboxes.deliverToSource(SOURCE_ID, otherLetter('m2', 'new-firm.test', 'Новая Фирма'));
    await run(world);
  }

  test('потерян курсор: письма перечитаны, отметки пропускают их без модели', async () => {
    await twoLetters();
    const cards = (await allCards(world)).length;
    const items = world.file.report?.items.length;
    await world.state.delete(SUPPLIER_MAIL_CURSOR_NAMESPACE, SOURCE_ID);
    const again = await run(world);
    expect(again).toMatchObject({ scanned: 2, duplicates: 2, modelCalls: 0 });
    expect((await allCards(world)).length).toBe(cards);
    expect(world.file.report?.items.length).toBe(items);
  });

  test('потеряны и отметки: письма разобраны заново, дублей карточек и пунктов нет', async () => {
    await twoLetters();
    const cards = (await allCards(world)).length;
    const items = world.file.report?.items.length;
    for (const entry of await world.state.list(SUPPLIER_MAIL_SEEN_NAMESPACE, null, 50)) {
      await world.state.delete(SUPPLIER_MAIL_SEEN_NAMESPACE, entry.key);
    }
    await world.state.delete(SUPPLIER_MAIL_CURSOR_NAMESPACE, SOURCE_ID);
    const again = await run(world);
    expect(again).toMatchObject({ scanned: 2, created: 0, reportItems: 0 });
    expect((await allCards(world)).length).toBe(cards);
    expect(world.file.report?.items.length).toBe(items);
  });

  test('второе письмо о том же даёт ссылку у прежнего пункта, а не новый пункт', async () => {
    await seed(world, {
      name: 'Старая Фирма',
      inn: INN_ALPHA,
      contacts: [{ email: 'office@vega-trade.test', isPrimary: true }],
    });
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    await run(world);
    const count = world.file.report?.items.length;
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m2', { subject: 'Повторное письмо' }));
    const second = await run(world);
    expect(second.reportItems).toBe(0);
    expect(second.reportReferences).toBeGreaterThan(0);
    expect(world.file.report?.items.length).toBe(count);
    const site = world.file.report?.items.find((item) => item.field === 'website');
    expect(site?.letters.map((ref) => ref.id)).toEqual(['m1', 'm2']);
  });

  test('чтение идёт постранично: более ста писем разобраны за один запуск', async () => {
    for (let i = 1; i <= 120; i += 1) {
      world.mailboxes.deliverToSource(SOURCE_ID, letter(`m${i}`, { bulk: true }));
    }
    const result = await run(world);
    expect(result).toMatchObject({ scanned: 120, skippedBulk: 120, stoppedBy: 'none' });
  });
});

describe('предел обращений к модели', () => {
  test('исчерпание - остановка с отчётом; повтор продолжает с необработанных', async () => {
    for (let i = 1; i <= 5; i += 1) {
      const host = `firm${i}.test`;
      world.mailboxes.deliverToSource(SOURCE_ID, otherLetter(`m${i}`, host, `Фирма ${i}`));
    }
    const first = await run(world, { maxModelCalls: 2 });
    expect(first).toMatchObject({ stoppedBy: 'model_limit', modelCalls: 2, created: 2 });
    expect(world.classifier.calls).toBe(2);
    expect(world.file.report?.run).toMatchObject({ stoppedBy: 'model_limit', modelCalls: 2 });
    const second = await run(world, { maxModelCalls: 2 });
    expect(second).toMatchObject({ stoppedBy: 'model_limit', modelCalls: 2, created: 2 });
    const third = await run(world, { maxModelCalls: 2 });
    expect(third).toMatchObject({ stoppedBy: 'none', modelCalls: 1, created: 1 });
    expect(await allCards(world)).toHaveLength(5);
    expect(world.classifier.calls).toBe(5);
  });
});

describe('сбои классификатора', () => {
  test('ошибка модели: письмо пропущено без записи, остальные идут', async () => {
    world.setVerdict((input) => {
      if (input.subject === 'Плохое') throw new Error('invalid answer');
      return SUPPLIER_VERDICT;
    });
    world.mailboxes.deliverToSource(SOURCE_ID, letter('bad', { subject: 'Плохое' }));
    world.mailboxes.deliverToSource(SOURCE_ID, letter('good'));
    const result = await run(world);
    expect(result).toMatchObject({ classifierFailed: 1, created: 1 });
  });

  test('отказ защиты ПДн: письмо пропущено, проход идёт до конца', async () => {
    world.setVerdict(() => {
      throw new PiiRejectedError(['PERSON']);
    });
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m2'));
    const result = await run(world);
    expect(result).toMatchObject({ classifierFailed: 2, created: 0, stoppedBy: 'none' });
  });

  test('временный сбой останавливает проход на письме; после починки продолжается', async () => {
    world.setVerdict(() => {
      throw new DomainError('external_failure', 'шлюз недоступен', { retryable: true });
    });
    for (let i = 1; i <= 3; i += 1) {
      const host = `firm${i}.test`;
      world.mailboxes.deliverToSource(SOURCE_ID, otherLetter(`m${i}`, host, `Фирма ${i}`));
    }
    const first = await run(world);
    expect(first.stoppedBy).toBe('classifier_outage');
    expect(await world.state.get(SUPPLIER_MAIL_CURSOR_NAMESPACE, SOURCE_ID)).toBeNull();
    world.setVerdict(() => SUPPLIER_VERDICT);
    const second = await run(world);
    expect(second).toMatchObject({ stoppedBy: 'none', created: 3 });
  });
});

describe('нет ПДн в выводе и журнале', () => {
  test('итог прохода и журнал содержат только числа и коды', async () => {
    await seed(world, {
      name: 'Старая Фирма',
      inn: INN_ALPHA,
      contacts: [{ email: 'office@vega-trade.test', isPrimary: true }],
    });
    world.setVerdict(() => {
      throw new DomainError('validation_failed', 'ИНН 7707083893 Иванов');
    });
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    const failed = await run(world);
    world.setVerdict(() => SUPPLIER_VERDICT);
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m2', { subject: 'Тема Иванова' }));
    const ok = await run(world);
    const dump = JSON.stringify([failed, ok, world.logs, await world.audit.list()]);
    for (const secret of ['Иванов', '7707083893', INN_ALPHA, 'vega-trade', 'Петров', '@']) {
      expect(dump).not.toContain(secret);
    }
    for (const value of Object.values(ok)) expect(['number', 'string']).toContain(typeof value);
  });

  test('отметки писем несут только время и исход', async () => {
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    await run(world);
    const entries = await world.state.list(SUPPLIER_MAIL_SEEN_NAMESPACE, null, 10);
    expect(entries).toHaveLength(1);
    expect(Object.keys(entries[0]?.value as object).sort()).toEqual(['at', 'outcome']);
  });
});

describe('ящик не настроен', () => {
  test('адреса нет в каталоге: not_configured, ничего не пишется', async () => {
    const other = build({ sourceAddress: 'nobody@company.test' });
    const result = await run(other);
    expect(result.status).toBe('not_configured');
    expect(other.file.saves).toBe(0);
  });

  test('отчёт другого ящика отклоняется', async () => {
    world.file.report = {
      version: 1,
      mailbox: 'другой-ящик',
      createdAt: 'x',
      updatedAt: 'x',
      items: [],
    };
    await expect(run(world)).rejects.toThrow('backfill_report_mailbox_mismatch');
  });
});

/** Ящик по сценарию: ответ зависит только от курсора (как у настоящего адаптера). */
function scriptedBox(
  script: Record<string, { messages: InboxMessage[]; nextCursor: string }>,
): SourceMailbox {
  return {
    sourceId: SOURCE_ID,
    address: SOURCE_ADDRESS.toLowerCase(),
    fetchNew: async (cursor) => script[cursor] ?? { messages: [], nextCursor: cursor },
    markProcessed: async () => undefined,
  };
}

function worldWithBox(box: SourceMailbox): World {
  const base = build();
  return build({
    mailboxes: {
      forEmployee: base.mailboxes.forEmployee.bind(base.mailboxes),
      sourceMailboxes: () => [box],
    },
  });
}

describe('конец ящика (ревью 220b, п. 1)', () => {
  test('пустая страница со сдвинутым курсором - это дыра в UID, а не конец ящика', async () => {
    // Адаптер за проход смотрит не больше 5000 UID: окно без писем даёт пустую страницу и
    // сдвигает курсор. Проход должен идти дальше, пока курсор не перестанет двигаться.
    const gap = worldWithBox(
      scriptedBox({
        '': { messages: [], nextCursor: 'c5000' },
        c5000: { messages: [letter('m1')], nextCursor: 'c5001' },
        c5001: { messages: [], nextCursor: 'c5001' },
      }),
    );
    const result = await run(gap);
    expect(result).toMatchObject({ scanned: 1, created: 1, stoppedBy: 'none' });
    expect(await gap.state.get(SUPPLIER_MAIL_CURSOR_NAMESPACE, SOURCE_ID)).toEqual({
      cursor: 'c5001',
    });
  });

  test('несколько дыр подряд и пустой ящик: проход завершается', async () => {
    const holes = worldWithBox(
      scriptedBox({
        '': { messages: [], nextCursor: 'c5000' },
        c5000: { messages: [], nextCursor: 'c10000' },
        c10000: { messages: [], nextCursor: 'c10000' },
      }),
    );
    expect(await run(holes)).toMatchObject({ scanned: 0, stoppedBy: 'none' });
  });
});

describe('больное письмо не останавливает проход (ревью 220b, п. 4)', () => {
  const SICK = 'Больное';
  function sickWorld(error: () => Error): World {
    const sick = build();
    sick.setVerdict((input) => {
      if (input.subject === SICK) throw error();
      return SUPPLIER_VERDICT;
    });
    sick.mailboxes.deliverToSource(SOURCE_ID, letter('sick', { subject: SICK }));
    sick.mailboxes.deliverToSource(SOURCE_ID, otherLetter('good', 'firm1.test', 'Фирма 1'));
    return sick;
  }

  test('неразборчивый ответ: ограниченные попытки, пункт «не разобрано», дальше идёт', async () => {
    const sick = sickWorld(() => new SupplierMailInvalidAnswerError());
    const result = await run(sick);
    expect(result).toMatchObject({ stoppedBy: 'none', created: 1, abandoned: 1, modelCalls: 4 });
    const item = sick.file.report?.items.find((entry) => entry.kind === 'unparsed');
    expect(item).toMatchObject({ status: 'pending', letters: [{ id: 'sick' }] });
    // Письмо закрыто, курсор в конце: повторный запуск его не трогает.
    const again = await run(sick);
    expect(again).toMatchObject({ scanned: 0, modelCalls: 0 });
  });

  test('таймаут: то же поведение', async () => {
    const sick = sickWorld(() => new Error('classifier_timeout'));
    const result = await run(sick);
    expect(result).toMatchObject({ stoppedBy: 'none', created: 1, abandoned: 1 });
    expect(sick.file.report?.items.some((entry) => entry.kind === 'unparsed')).toBe(true);
  });

  test('счётчик попыток хранится в состоянии: предел модели не обнуляет его', async () => {
    const sick = sickWorld(() => new SupplierMailInvalidAnswerError());
    const first = await run(sick, { maxModelCalls: 2 });
    expect(first).toMatchObject({ stoppedBy: 'model_limit', abandoned: 0 });
    const second = await run(sick, { maxModelCalls: 5 });
    // Третья попытка по этому письму закрывает его, остальное дочитывается.
    expect(second).toMatchObject({ stoppedBy: 'none', abandoned: 1, created: 1 });
  });

  test('пробный запуск не застревает: письмо пропущено, остальные оценены', async () => {
    const sick = sickWorld(() => new SupplierMailInvalidAnswerError());
    const result = await run(sick, { dryRun: true });
    expect(result).toMatchObject({ stoppedBy: 'none', wouldCreate: 1, abandoned: 1 });
    expect(await sick.state.list(SUPPLIER_MAIL_SEEN_NAMESPACE, null, 50)).toEqual([]);
    expect(await sick.state.get(SUPPLIER_MAIL_CURSOR_NAMESPACE, SOURCE_ID)).toBeNull();
  });

  test('сбои подряд на разных письмах - недоступная модель, проход встаёт', async () => {
    const down = build();
    down.setVerdict(() => {
      throw new SupplierMailInvalidAnswerError();
    });
    for (let i = 1; i <= 5; i += 1) {
      down.mailboxes.deliverToSource(SOURCE_ID, letter(`m${i}`));
    }
    const result = await run(down);
    expect(result.stoppedBy).toBe('classifier_outage');
    // Закрыто не больше одного письма: дальше модель считается недоступной.
    expect(result.abandoned).toBeLessThanOrEqual(1);
  });
});

describe('пробный запуск: счёт «было бы создано» (ревью 220b, п. 9)', () => {
  test('письмо без ИНН, но с тем же доменом, второй карточки не даёт', async () => {
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    world.mailboxes.deliverToSource(
      SOURCE_ID,
      letter('m2', {
        from: 'info@vega-trade.test',
        body: 'ООО «Вега Трейд» предлагает упаковку. Сайт: https://vega-trade.test',
      }),
    );
    const dry = await run(world, { dryRun: true });
    expect(dry.wouldCreate).toBe(1);
    const real = await run(world);
    expect(real.created).toBe(dry.wouldCreate);
  });
});

let classifierCallsAfterFirst = 0;
