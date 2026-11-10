import { beforeEach, describe, expect, test } from 'bun:test';
import type { AccessRequest } from '@business-ai/core';
import {
  SUPPLIER_MAIL_PROPOSAL_DRAFT_MAX_ITEMS,
  runSupplierMailProposals,
} from '../../src/agents/suppliers/mail-proposals';
import {
  SUPPLIER_MAIL_PROPOSAL_MAX_ITEMS,
  SUPPLIER_MAIL_PROPOSAL_NAMESPACE,
  SUPPLIER_MAIL_PROPOSAL_SEEN_NAMESPACE,
} from '../../src/agents/suppliers/mail-proposal-store';
import { cardFromFields, newCardId } from '../../src/agents/suppliers/card-fields';
import {
  recordMailSupplierProposalDecision,
} from '../../src/agents/suppliers/mail-proposal-decision';
import { DAY_MS, HOUR_MS } from '../../src/kit/domain/time';
import type { EmployeeMailbox, InboxMessage, MailboxDirectory } from '@business-ai/core';
import {
  EMPLOYEE_A,
  EMPLOYEE_B,
  OPTIONS,
  SUPPLIER_VERDICT,
  build,
  hostOf,
  letter,
  supplierOf,
  turnOf,
  type ProposalWorld,
} from './suppliers-mail-proposals-support';
import { validInn } from './suppliers-support';

/**
 * Исправления по ревью этапа 222: ключи «уже в базе», интервал на сотрудника, переполнение
 * черновика, справедливость квоты, неотвеченное предложение, недоступное письмо на «да»,
 * наше название первым, сверка остатка с базой, исчерпанная квота. Данные синтетические.
 */

/** Наш ИНН с верной контрольной суммой: код отличает его от чужого только по реквизитам. */
const OWN_INN = validInn('770123456');

let world: ProposalWorld;
beforeEach(() => {
  world = build({ ownCompanyRequisites: [`ИНН ${OWN_INN}`, 'zakupki@company.test'] });
});

const run = (options = OPTIONS) => runSupplierMailProposals(world.deps, options);
const decide = (input: Parameters<typeof recordMailSupplierProposalDecision.execute>[0]) =>
  recordMailSupplierProposalDecision.execute(input, hostOf(world), turnOf(EMPLOYEE_A));

/** Сохранить поставщика в базу (как карточку, уже существующую до письма). */
async function seedSupplier(n: number): Promise<void> {
  const known = supplierOf(n);
  await world.suppliers.saveCard(
    cardFromFields(
      { name: known.name, inn: known.inn, contacts: [{ email: `sales@${known.domain}` }] },
      { userId: 'seed', nowIso: '2026-10-01T09:00:00.000Z', source: 'chat' },
      newCardId({ name: known.name }),
    ),
  );
}

describe('1. отметки «уже в базе» не берутся из чужих названий и нашего ИНН', () => {
  test('известный поставщик назвал наш ИНН и компанию: новые не глохнут', async () => {
    await seedSupplier(1);
    const known = supplierOf(1);
    world.mailboxes.deliver(
      EMPLOYEE_A,
      letter('k1', 1, {
        body: [
          'Счёт для ООО «Наша Компания»',
          `ИНН ${OWN_INN}`,
          `${known.name} предлагает упаковку.`,
          `Наш ИНН ${known.inn}`,
        ].join('\n'),
      }),
    );
    const fresh = supplierOf(2);
    world.mailboxes.deliver(
      EMPLOYEE_A,
      letter('n1', 2, {
        body: [
          `${fresh.name} предлагает упаковку.`,
          `Счёт на покупателя, ИНН ${OWN_INN}.`,
          `Наш ИНН ${fresh.inn}`,
          `Сайт: https://${fresh.domain}`,
        ].join('\n'),
      }),
    );
    const result = await run();
    expect(result.known).toBe(1);
    expect(result.duplicateSuppliers).toBe(0);
    const [text] = world.sentTo(EMPLOYEE_A);
    expect(text).toContain(fresh.name);
  });

  test('чужое название из письма известного поставщика не закрывает владельца', async () => {
    await seedSupplier(1);
    const known = supplierOf(1);
    world.mailboxes.deliver(
      EMPLOYEE_A,
      letter('k1', 1, {
        body: [
          'По договору с ООО «Левая Фирма» направляем счёт.',
          `${known.name}, ИНН ${known.inn}`,
        ].join('\n'),
      }),
    );
    const left = supplierOf(5);
    world.mailboxes.deliver(
      EMPLOYEE_A,
      letter('n1', 5, {
        body: ['ООО «Левая Фирма» предлагает упаковку.', `ИНН ${left.inn}`].join('\n'),
      }),
    );
    await run();
    const [text] = world.sentTo(EMPLOYEE_A);
    expect(text).toContain('Левая Фирма');
  });

  test('отметок «известен» не больше, чем доменов известных поставщиков', async () => {
    await seedSupplier(1);
    const known = supplierOf(1);
    world.mailboxes.deliver(
      EMPLOYEE_A,
      letter('k1', 1, {
        body: [
          `ИНН ${OWN_INN}`,
          'ООО «Левая Фирма», ООО «Правая Фирма»',
          `${known.name} ИНН ${known.inn}`,
        ].join('\n'),
      }),
    );
    await run();
    const seen = await world.state.list(SUPPLIER_MAIL_PROPOSAL_SEEN_NAMESPACE, null, 100);
    expect(seen).toHaveLength(1);
  });

  test('бесплатная почта с одним лишь нашим ИНН не тратит оценку модели', async () => {
    world.mailboxes.deliver(
      EMPLOYEE_A,
      letter('m1', 1, { from: 'person@gmail.com', body: `Счёт на ИНН ${OWN_INN}` }),
    );
    const result = await run();
    expect(result.skippedFreeMail).toBe(1);
    expect(world.classifier.calls).toBe(0);
  });
});

describe('2. раз в трое суток на каждого сотрудника', () => {
  test('слот открыт из-за другого: второе предложение раньше срока не уходит', async () => {
    let failing = true;
    world.deps.access = {
      isAllowed: async (request: AccessRequest) => {
        if (failing && request.userId === EMPLOYEE_B) throw new Error('справочник недоступен');
        return world.access.isAllowed(request);
      },
    };
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1));
    const first = await run();
    expect(first.accessUnavailable).toBe(1);
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(1);
    // Слот открыт (B недоступен), на следующие сутки у A новое письмо.
    world.clock.advance(DAY_MS);
    world.mailboxes.deliver(EMPLOYEE_A, letter('m2', 2));
    await run();
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(1);
    // Через трое суток от прошлого предложения - можно.
    world.clock.advance(2 * DAY_MS);
    await run();
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(2);
    failing = false;
  });
});

describe('3. переполненный черновик', () => {
  test('сверх предела черновика предложение всё равно уходит, остаток ждёт', async () => {
    const total = SUPPLIER_MAIL_PROPOSAL_DRAFT_MAX_ITEMS + 5;
    for (let n = 1; n <= total; n += 1) {
      world.mailboxes.deliver(EMPLOYEE_A, bulkLetter(n));
    }
    await run({ ...OPTIONS, maxClassifyPerRun: 1000 });
    const [text] = world.sentTo(EMPLOYEE_A);
    expect(text).toBeDefined();
    const left = SUPPLIER_MAIL_PROPOSAL_DRAFT_MAX_ITEMS - SUPPLIER_MAIL_PROPOSAL_MAX_ITEMS;
    expect(text).toContain(`Ещё писем о новых поставщиках: ${left}`);
    // Через интервал сотрудник получает следующее, а не застревает.
    world.clock.advance(3 * DAY_MS);
    await run({ ...OPTIONS, maxClassifyPerRun: 1000 });
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(2);
  });
});

describe('4. справедливость суточной квоты', () => {
  test('следующий день обход начинается с сотрудника после исчерпавшего квоту', async () => {
    for (let n = 1; n <= 5; n += 1) world.mailboxes.deliver(EMPLOYEE_A, letter(`a${n}`, n));
    world.mailboxes.deliver(EMPLOYEE_B, letter('b1', 9));
    const options = { ...OPTIONS, maxClassifyPerRun: 2 };
    await run(options);
    expect(world.sentTo(EMPLOYEE_B)).toEqual([]);
    world.clock.advance(DAY_MS);
    await run(options);
    expect(world.sentTo(EMPLOYEE_B)).toHaveLength(1);
  });
});

describe('5. неотвеченное предложение не теряется', () => {
  test('новое предложение несёт открытые пункты старого, старое закрыто', async () => {
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1));
    world.mailboxes.deliver(EMPLOYEE_A, letter('m2', 2));
    await run();
    const [first] = world.sentTo(EMPLOYEE_A);
    expect(first).toContain('1. ');
    world.mailboxes.deliver(EMPLOYEE_A, letter('m3', 3));
    world.clock.advance(3 * DAY_MS);
    await run();
    const texts = world.sentTo(EMPLOYEE_A);
    expect(texts).toHaveLength(2);
    const second = texts[1] ?? '';
    for (const n of [1, 2, 3]) expect(second).toContain(supplierOf(n).name);
    // «Да» относится к полному новому списку: заведены все три.
    const out = await decide({ decision: 'create' });
    expect(out.items?.map((item) => item.result)).toEqual(['created', 'created', 'created']);
    // Старая запись закрыта, её названия и темы стёрты.
    const entries = await world.state.list(SUPPLIER_MAIL_PROPOSAL_NAMESPACE, null, 100);
    const stored = JSON.stringify(entries);
    expect(stored).not.toContain(supplierOf(1).name);
    expect(stored).toContain('superseded');
  });
});

describe('6. недоступное письмо на «да»', () => {
  type Mode = 'ok' | 'fetch_failed' | 'gone';
  let mode: Mode = 'ok';
  class Directory implements MailboxDirectory {
    constructor(private readonly inner: MailboxDirectory) {}
    employeeIds(): readonly string[] {
      return this.inner.employeeIds?.() ?? [];
    }
    async forEmployee(userId: string): Promise<EmployeeMailbox> {
      const box = await this.inner.forEmployee(userId);
      return new Proxy(box, {
        get: (target, prop) => {
          if (prop === 'getMessage') {
            return async (id: string): Promise<InboxMessage | null> => {
              const found = await target.getMessage(id);
              if (found === null || mode === 'ok') return found;
              if (mode === 'gone') return null;
              return { ...found, body: '', attachments: [], contentOmitted: 'fetch_failed' };
            };
          }
          const value: unknown = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }
  }

  beforeEach(() => {
    mode = 'ok';
    world.deps.mailboxes = new Directory(world.deps.mailboxes);
  });

  test('временный сбой чтения: пункты остаются открытыми, повтор заводит карточки', async () => {
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1));
    world.mailboxes.deliver(EMPLOYEE_A, letter('m2', 2));
    await run();
    mode = 'fetch_failed';
    const out = await decide({ decision: 'create' });
    expect(out.status).toBe('unavailable');
    expect(out.items?.map((item) => item.result)).toEqual(['open', 'open']);
    expect(await world.suppliers.searchCards({ limit: 10 })).toEqual([]);
    mode = 'ok';
    const again = await decide({ decision: 'create' });
    expect(again.status).toBe('done');
    expect(again.items?.map((item) => item.result)).toEqual(['created', 'created']);
  });

  test('письма уже нет: пункт пропущен, но поставщик не отклонён навсегда', async () => {
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1));
    await run();
    mode = 'gone';
    const out = await decide({ decision: 'create' });
    expect(out.items?.map((item) => item.result)).toEqual(['skipped']);
    mode = 'ok';
    world.mailboxes.deliver(EMPLOYEE_A, letter('m9', 1, { subject: 'Снова мы' }));
    world.clock.advance(3 * DAY_MS);
    await run();
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(2);
  });
});

describe('7. наша компания названа в письме первой', () => {
  test('название поставщика берётся у модели, если извлечённое - наше', async () => {
    const supplier = supplierOf(3);
    world.setVerdict(() => ({ ...SUPPLIER_VERDICT, companyName: supplier.name }));
    world.mailboxes.deliver(
      EMPLOYEE_A,
      letter('m1', 3, {
        body: [
          'Генеральному директору ООО «Наша Компания»',
          `${supplier.name} предлагает картонную упаковку.`,
          `ИНН ${supplier.inn}`,
        ].join('\n'),
      }),
    );
    const result = await run();
    expect(result.noName).toBe(0);
    expect(world.sentTo(EMPLOYEE_A)[0]).toContain(supplier.name);
  });
});

describe('8. остаток черновика сверяется с базой перед отправкой', () => {
  test('поставщик, появившийся в базе за время ожидания, не предлагается', async () => {
    const total = 12;
    for (let n = 1; n <= total; n += 1) world.mailboxes.deliver(EMPLOYEE_A, letter(`m${n}`, n));
    await run();
    expect(world.sentTo(EMPLOYEE_A)[0]).toContain('Ещё писем о новых поставщиках: 2');
    await seedSupplier(11);
    world.clock.advance(3 * DAY_MS);
    await run();
    const second = world.sentTo(EMPLOYEE_A)[1] ?? '';
    expect(second).toContain(supplierOf(12).name);
    expect(second).not.toContain(supplierOf(11).name);
  });
});

describe('9. исчерпанная квота не блокирует доставку', () => {
  test('сорвавшееся предложение уходит и при исчерпанной квоте', async () => {
    world.mailboxes.deliver(EMPLOYEE_A, letter('m1', 1));
    world.mailboxes.deliver(EMPLOYEE_A, letter('m2', 2));
    const original = world.chat.reply.bind(world.chat);
    let fail = true;
    world.chat.reply = async (threadId, message, key) => {
      if (fail) throw new Error('канал недоступен');
      return original(threadId, message, key);
    };
    const options = { ...OPTIONS, maxClassifyPerRun: 2 };
    await expect(run(options)).rejects.toThrow('канал недоступен');
    fail = false;
    world.clock.advance(HOUR_MS);
    const result = await run(options);
    expect(result.status).toBe('done');
    expect(world.sentTo(EMPLOYEE_A)).toHaveLength(1);
  });
});

/** Письмо n-го поставщика с уникальным названием (букв хватает на сотни поставщиков). */
function bulkLetter(n: number): InboxMessage {
  const base = supplierOf(n);
  const alphabet = 'абвгдежзиклмнопрстуфхцчшэюя';
  const first = alphabet[Math.floor(n / alphabet.length) % alphabet.length];
  const tag = `${first}${alphabet[n % alphabet.length]}`;
  const name = `ООО «Завод ${tag}»`;
  return letter(`b${n}`, n, {
    body: [
      `${name} предлагает упаковку.`,
      `ИНН ${validInn(String(770_800_000 + n * 7))}`,
      `Сайт: https://${base.domain}`,
    ].join('\n'),
  });
}
