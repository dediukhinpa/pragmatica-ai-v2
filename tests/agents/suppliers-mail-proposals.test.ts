import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryAccessPolicy } from '@business-ai/adapters';
import {
  SUPPLIER_MAIL_PROPOSAL_MAX_ITEMS,
  SUPPLIER_MAIL_PROPOSAL_NAMESPACE,
  SUPPLIER_MAIL_PROPOSAL_SEEN_NAMESPACE,
} from '../../src/agents/suppliers/mail-proposal-store';
import {
  recordMailSupplierProposalDecision,
} from '../../src/agents/suppliers/mail-proposal-decision';
import { runSupplierMailProposals } from '../../src/agents/suppliers/mail-proposals';
import { cardFromFields, newCardId } from '../../src/agents/suppliers/card-fields';
import { DAY_MS, HOUR_MS } from '../../src/kit/domain/time';
import {
  DUE,
  EMPLOYEE_A,
  EMPLOYEE_B,
  EMPLOYEE_NO_BOX,
  OPTIONS,
  OUR_INN,
  SUPPLIER_VERDICT,
  build,
  hostOf,
  letter,
  supplierOf,
  threadOf,
  turnOf,
  type ProposalWorld,
} from './suppliers-mail-proposals-support';

/**
 * Обзор почты сотрудников и предложение завести карточки (этап 222). Данные синтетические;
 * ящики и классификатор - заглушки. Без Postgres.
 */

let world: ProposalWorld;
beforeEach(() => {
  world = build();
});

const run = (options = OPTIONS) => runSupplierMailProposals(world.deps, options);
const at = (iso: string): void => {
  world.clock.advance(new Date(iso).getTime() - world.clock.now().getTime());
};

describe('предложение', () => {
  test('новый поставщик из письма: уходит нумерованное предложение, карточки нет', async () => {
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1));
    world.mailboxes.deliver(EMPLOYEE_A, letter('m2', 2));
    const result = await run();
    expect(result).toMatchObject({ status: 'done', proposed: 1, candidates: 2 });
    const [text] = world.sentTo(EMPLOYEE_A);
    expect(text).toContain('1. «ООО «Бета Трейд»');
    expect(text).toContain('2. «ООО «Гамма Трейд»');
    expect(text).toContain('да');
    expect(text).toContain('нет');
    // Карточки без ответа сотрудника не заводятся.
    expect(await world.suppliers.searchCards({ limit: 10 })).toEqual([]);
    // Другому сотруднику ничего не уходит: в его ящике нет писем.
    expect(world.sentTo(EMPLOYEE_B)).toEqual([]);
  });

  test('не больше 10 пунктов, остаток числом и предлагается в следующий раз', async () => {
    const total = SUPPLIER_MAIL_PROPOSAL_MAX_ITEMS + 3;
    for (let n = 1; n <= total; n += 1) world.mailboxes.deliver(EMPLOYEE_A, letter(`m${n}`, n));
    await run();
    const [first] = world.sentTo(EMPLOYEE_A);
    expect(first).toContain(`${SUPPLIER_MAIL_PROPOSAL_MAX_ITEMS}. `);
    expect(first).not.toContain(`${SUPPLIER_MAIL_PROPOSAL_MAX_ITEMS + 1}. `);
    expect(first).toContain('Ещё писем о новых поставщиках: 3');
    // Сотрудник ответил «нет»: через интервал остаток приходит отдельным предложением
    // (неотвеченное предложение переносится в новое: см. suppliers-mail-proposals-review).
    await recordMailSupplierProposalDecision.execute(
      { decision: 'decline' },
      hostOf(world),
      turnOf(EMPLOYEE_A),
    );
    world.clock.advance(3 * DAY_MS);
    await run();
    const texts = world.sentTo(EMPLOYEE_A);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain('1. ');
    expect(texts[1]).not.toContain('Ещё писем');
  });

  test('сотрудник без подключённого ящика: без ошибок, остальные обработаны', async () => {
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1));
    const result = await run();
    expect(result.notConnected).toBe(1);
    expect(result.failed).toBe(0);
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(1);
    expect(world.sentTo(EMPLOYEE_NO_BOX)).toEqual([]);
  });

  test('сотрудник без права на агента или карточки не получает предложений', async () => {
    const strict = build();
    // Политика без разрешений: никто не допущен.
    strict.deps.access = new MemoryAccessPolicy();
    strict.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1));
    const result = await runSupplierMailProposals(strict.deps, OPTIONS);
    expect(result.skippedDenied).toBeGreaterThan(0);
    expect(strict.sentTo(EMPLOYEE_A)).toEqual([]);
  });

  test('списка исключений нет: читаются все подключённые ящики, и служебный тоже', async () => {
    // Решение владельца 09.11: ящик учётки агентов тоже просматривается.
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1));
    world.mailboxes.deliver(EMPLOYEE_B, letter('m2', 2));
    const result = await run();
    expect(result.scanned).toBe(2);
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(1);
    expect(world.sentTo(EMPLOYEE_B)).toHaveLength(1);
  });

  test('общий ящик-источник (info@, kind=source) в обзор не входит', async () => {
    const source = 'source-info';
    world.mailboxes.connectSource(source, 'info@company.test');
    world.mailboxes.deliverToSource(source, letter('s1', 1));
    // Каталог с настоящим перечнем источников: обзор берёт только employeeIds().
    world.deps.mailboxes = world.mailboxes;
    expect(world.mailboxes.employeeIds()).not.toContain(source);
    const result = await run();
    expect(result.scanned).toBe(0);
    expect(world.classifier.calls).toBe(0);
    expect(world.sentTo(source)).toEqual([]);
    // Письмо источника не тронуто: его разберёт только разовый проход 220b.
    const page = await world.mailboxes.sourceMailboxes()[0]?.fetchNew('', 10);
    expect(page?.messages).toHaveLength(1);
  });
});

describe('что не предлагается', () => {
  test('наш домен и наши реквизиты: письмо не оценивается', async () => {
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1, { from: 'zakupki@company.test' }));
    world.mailboxes.deliver(EMPLOYEE_A, letter('m2', 2, { from: 'colleague@company.test' }));
    const result = await run();
    expect(result.skippedOwn).toBe(2);
    expect(world.classifier.calls).toBe(0);
    expect(world.sentTo(EMPLOYEE_A)).toEqual([]);
  });

  test('письмо с нашим ИНН в тексте не делает нас поставщиком', async () => {
    world.mailboxes.deliver(
      EMPLOYEE_A,
      letter('m1', 1, { body: `ООО «Левая Фирма» просит счёт. ИНН ${OUR_INN}` }),
    );
    await run();
    const [text] = world.sentTo(EMPLOYEE_A);
    expect(text ?? '').not.toContain(OUR_INN);
  });

  test('поставщик уже есть в базе (адрес или ИНН): не предлагается', async () => {
    const known = supplierOf(1);
    await world.suppliers.saveCard(
      cardFromFields(
        { name: known.name, inn: known.inn, contacts: [{ email: `sales@${known.domain}` }] },
        { userId: 'seed', nowIso: '2026-10-01T09:00:00.000Z', source: 'chat' },
        newCardId({ name: known.name }),
      ),
    );
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1));
    world.mailboxes.deliver(EMPLOYEE_A, letter('m2', 1, { from: 'other@another-mail.test' }));
    const result = await run();
    expect(result.known).toBeGreaterThanOrEqual(1);
    expect(world.sentTo(EMPLOYEE_A)).toEqual([]);
  });

  test('рассылка, служебные адреса, почта без ИНН и не-поставщики пропускаются', async () => {
    world.setVerdict((input) =>
      input.senderDomain === 'shop.test'
        ? { kind: 'customer', hasSupplierInfo: false, categories: [] }
        : SUPPLIER_VERDICT,
    );
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1, { bulk: true }));
    world.mailboxes.deliver(EMPLOYEE_A, letter('m2', 2, { from: 'noreply@sys-mail.test' }));
    world.mailboxes.deliver(
      EMPLOYEE_A,
      letter('m3', 3, { from: 'person@gmail.com', body: 'Здравствуйте, есть товар.' }),
    );
    world.mailboxes.deliver(EMPLOYEE_A, letter('m4', 4, { from: 'buyer@shop.test' }));
    const result = await run();
    expect(result).toMatchObject({ skippedBulk: 1, skippedSystem: 1, notSupplier: 1 });
    expect(world.sentTo(EMPLOYEE_A)).toEqual([]);
  });

  test('письма старше окна не разбираются', async () => {
    world.mailboxes.deliver(
      EMPLOYEE_A,
      letter('m1', 1, { receivedAt: new Date(DUE.getTime() - 8 * DAY_MS).toISOString() }),
    );
    const result = await run();
    expect(result.skippedOld).toBe(1);
    expect(world.classifier.calls).toBe(0);
  });

  test('предел оценок за сутки: сверх него письма ждут, слот остаётся открытым', async () => {
    for (let n = 1; n <= 4; n += 1) world.mailboxes.deliver(EMPLOYEE_A, letter(`m${n}`, n));
    const result = await run({ ...OPTIONS, maxClassifyPerRun: 2 });
    expect(result.classified).toBe(2);
    expect(result.stoppedBy).toBe('limit');
    expect(world.sentTo(EMPLOYEE_A)).toEqual([]);
    // Следующий день: остаток дочитывается, предложение уходит одно.
    world.clock.advance(DAY_MS);
    await run({ ...OPTIONS, maxClassifyPerRun: 5 });
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(1);
  });
});

describe('расписание и пояс бизнеса (Екатеринбург)', () => {
  test('до 10:00 по Екатеринбургу не время, в 10:00 - время', async () => {
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1));
    at('2026-10-12T04:59:00.000Z');
    expect((await run()).status).toBe('not_due');
    expect(world.classifier.calls).toBe(0);
    at('2026-10-12T05:00:00.000Z');
    expect((await run()).status).toBe('done');
  });

  test('час берётся по поясу бизнеса, а не по московскому: 06:30 UTC = 11:30 у нас', async () => {
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1));
    at('2026-10-12T06:30:00.000Z');
    expect((await run()).status).toBe('done');
  });

  test('граница суток Екатеринбурга: 23:59, полночь и 09:59 - ещё не время', async () => {
    await run();
    // Через двое суток (по местной дате) - рано, через трое - пора.
    at('2026-10-14T18:59:00.000Z');
    expect((await run()).status).toBe('not_due');
    at('2026-10-14T19:00:00.000Z');
    expect((await run()).status).toBe('not_due');
    at('2026-10-14T23:00:00.000Z');
    expect((await run()).status).toBe('not_due');
    at('2026-10-15T04:59:00.000Z');
    expect((await run()).status).toBe('not_due');
    world.mailboxes.deliver(EMPLOYEE_A, letter('late', 1));
    at('2026-10-15T05:00:00.000Z');
    expect((await run()).status).toBe('done');
  });

  test('строго раз в 3 суток и один раз в день: повторный тик того же дня - не время', async () => {
    expect((await run()).status).toBe('done');
    world.clock.advance(HOUR_MS);
    expect((await run()).status).toBe('not_due');
    world.clock.advance(2 * DAY_MS);
    expect((await run()).status).toBe('not_due');
    world.clock.advance(DAY_MS);
    expect((await run()).status).toBe('done');
  });

  test('интервал и час из настроек', async () => {
    expect((await run({ ...OPTIONS, checkHour: 11 })).status).toBe('not_due');
    expect((await run({ ...OPTIONS, checkHour: 10, intervalDays: 1 })).status).toBe('done');
    world.clock.advance(DAY_MS);
    expect((await run({ ...OPTIONS, intervalDays: 1 })).status).toBe('done');
  });
});

describe('без повторных предложений', () => {
  test('то же письмо в следующем прогоне не предлагается снова', async () => {
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1));
    await run();
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(1);
    // Курсор потерян: письмо читается заново, но отметка письма его закрывает.
    await world.state.clear('suppliers:mail-proposal-cursor.v1');
    world.clock.advance(3 * DAY_MS);
    const result = await run();
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(1);
    expect(result.duplicates).toBe(1);
  });

  test('новое письмо того же поставщика (тот же домен) не предлагается', async () => {
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1));
    await run();
    world.mailboxes.deliver(EMPLOYEE_A, letter('m2', 1, { subject: 'Ещё предложение' }));
    const callsBefore = world.classifier.calls;
    world.clock.advance(3 * DAY_MS);
    const result = await run();
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(1);
    expect(result.duplicateSuppliers).toBe(1);
    // Модель за повтором не ходит.
    expect(world.classifier.calls).toBe(callsBefore);
  });

  test('тот же поставщик с другого домена (по названию и ИНН) не повторяется', async () => {
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1));
    await run();
    world.mailboxes.deliver(EMPLOYEE_A, letter('m2', 1, { from: 'info@vega-other.test' }));
    world.clock.advance(3 * DAY_MS);
    await run();
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(1);
  });

  test('одного поставщика двум сотрудникам предлагают раздельно', async () => {
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1));
    world.mailboxes.deliver(EMPLOYEE_B, letter('m1', 1));
    await run();
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(1);
    expect(world.sentTo(EMPLOYEE_B)).toHaveLength(1);
  });

  test('сбой отправки: слот открыт, повтор шлёт то же предложение без дублей', async () => {
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1));
    const original = world.chat.reply.bind(world.chat);
    let fail = true;
    world.chat.reply = async (threadId, message, key) => {
      if (fail) throw new Error('канал недоступен');
      return original(threadId, message, key);
    };
    await expect(run()).rejects.toThrow('канал недоступен');
    fail = false;
    world.clock.advance(HOUR_MS);
    const result = await run();
    expect(result.status).toBe('done');
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(1);
    // Повторный тик после закрытия слота ничего не шлёт.
    world.clock.advance(HOUR_MS);
    await run();
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(1);
  });
});

describe('персональные данные', () => {
  test('адреса, домены, названия и темы не попадают в журнал и ключи состояния', async () => {
    const supplier = supplierOf(1);
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1, { subject: 'Секретная тема' }));
    world.mailboxes.deliver(EMPLOYEE_A, letter('m2', 2, { from: 'noreply@sys-mail.test' }));
    await run();
    const logged = JSON.stringify(world.logs);
    for (const secret of [supplier.domain, supplier.name, supplier.inn, 'Секретная тема']) {
      expect(logged).not.toContain(secret);
    }
    for (const namespace of [
      SUPPLIER_MAIL_PROPOSAL_SEEN_NAMESPACE,
      'suppliers:mail-proposal-msg.v1',
      'suppliers:mail-proposal-draft.v1',
      'suppliers:mail-proposal-cursor.v1',
      'suppliers:mail-proposal-quota.v1',
    ]) {
      const keys = (await world.state.list(namespace, null, 100)).map((entry) => entry.key);
      for (const secret of [supplier.domain, supplier.inn, 'anna@', 'trade']) {
        expect(keys.join('|')).not.toContain(secret);
      }
      // Идентификатор письма в ключе отметки не виден: только хэш.
      expect(keys.join('|')).not.toContain('m1');
    }
    const proposalKeys = (await world.state.list(SUPPLIER_MAIL_PROPOSAL_NAMESPACE, null, 100)).map(
      (entry) => entry.key,
    );
    expect(proposalKeys.join('|')).not.toContain(supplier.domain);
    // Ключи отметок о поставщике - хэши: ни ИНН, ни домена, ни названия.
    const seen = await world.state.list(SUPPLIER_MAIL_PROPOSAL_SEEN_NAMESPACE, null, 100);
    expect(seen.length).toBeGreaterThan(0);
    for (const entry of seen) expect(entry.key).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('ошибки и устойчивость', () => {
  test('временный сбой модели: письмо ждёт следующего прохода, курсор не двигается', async () => {
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1));
    world.setVerdict(() => {
      throw new Error('classifier_timeout');
    });
    const result = await run();
    expect(result.stoppedBy).toBe('classifier_outage');
    expect(world.sentTo(EMPLOYEE_A)).toEqual([]);
    world.setVerdict(() => SUPPLIER_VERDICT);
    world.clock.advance(HOUR_MS);
    await run();
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(1);
  });

  test('нет писем и нет ящиков: проход без ошибок, слот закрыт', async () => {
    const result = await run();
    expect(result).toMatchObject({ status: 'done', proposed: 0 });
    world.clock.advance(HOUR_MS);
    expect((await run()).status).toBe('not_due');
  });
});
