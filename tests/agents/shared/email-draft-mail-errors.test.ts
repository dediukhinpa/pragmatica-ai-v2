import { beforeEach, describe, expect, test } from 'bun:test';
import {
  FixedClock,
  MemoryAuditRepository,
  MemoryIdempotencyStore,
  MemoryIntakeStore,
  MemoryMailboxDirectory,
  MemoryWorkflowStateStore,
} from '@business-ai/adapters';
import {
  EMAIL_DRAFT_NAMESPACE,
  EmailDraftService,
  createEmailDraftKindRegistry,
  createEmailDraftService,
  emailDraftOutcomeText,
  emailDraftSchema,
  prepareEmailDraft,
  type EmailDraft,
  type EmailDraftPress,
  type PrepareEmailDraftInput,
} from '@business-ai/core';
import { MailError, mailErrorTextForEmployee, type MailErrorReason } from '@business-ai/core';
import {
  IN_DOUBT_MIN_AGE_MS,
  type EmployeeMailbox,
  type IdempotencyKey,
  type MailboxDirectory,
  type OutgoingMail,
  type SentMailReceipt,
} from '@business-ai/core';

const KIND = 'test.mail-errors';
const AGENT = 'order-calc';
const THREAD = 'thread-u1';
const ADDRESS = 'ivanov@company.test';
const SUPPLIER_A = { ref: 'sup-a', name: 'МеталлТорг', address: 'sales@metall.test' };
const SUPPLIER_B = { ref: 'sup-b', name: 'Болтик', address: 'info@boltik.test' };
const SUBJECT = 'Запрос цены по заявке req-1';
const BODY = 'Просим прислать цену на швеллер 12П.';

/** Каталог, у которого отправка на заданные адреса отвечает заданной ошибкой адаптера. */
class MailFaultDirectory implements MailboxDirectory {
  readonly failFor = new Map<string, MailErrorReason>();
  /** Сколько раз адаптер вызывали по адресу (проверка «не шлём повторно без нужды»). */
  readonly calls = new Map<string, number>();
  /** Квитанция без сохранённой копии. */
  copyMissing = false;
  constructor(private readonly inner: MemoryMailboxDirectory) {}

  async forEmployee(userId: string): Promise<EmployeeMailbox> {
    const box = await this.inner.forEmployee(userId);
    const self = this;
    return {
      employeeId: box.employeeId,
      address: box.address,
      fetchNew: (cursor, limit) => box.fetchNew(cursor, limit),
      markProcessed: (id) => box.markProcessed(id),
      getMessage: (id) => box.getMessage(id),
      async send(mail: OutgoingMail, key: IdempotencyKey): Promise<SentMailReceipt> {
        const address = mail.to[0] ?? '';
        self.calls.set(address, (self.calls.get(address) ?? 0) + 1);
        const reason = self.failFor.get(address);
        if (reason !== undefined) throw new MailError(reason);
        const receipt = await box.send(mail, key);
        return self.copyMissing ? { ...receipt, sentCopySaved: false } : receipt;
      },
    };
  }
}

interface Harness {
  clock: FixedClock;
  state: MemoryWorkflowStateStore;
  mailboxes: MemoryMailboxDirectory;
  faults: MailFaultDirectory;
  audit: MemoryAuditRepository;
  service: EmailDraftService;
  afterSend: Array<{ refs: string[]; complete: boolean }>;
}

function harness(): Harness {
  const clock = new FixedClock();
  const state = new MemoryWorkflowStateStore();
  const idempotency = new MemoryIdempotencyStore(() => clock.now().getTime());
  const mailboxes = new MemoryMailboxDirectory();
  mailboxes.connect('u1', ADDRESS);
  const faults = new MailFaultDirectory(mailboxes);
  const audit = new MemoryAuditRepository();
  const afterSend: Harness['afterSend'] = [];
  const kinds = createEmailDraftKindRegistry();
  kinds.register({
    id: KIND,
    async revalidate() {
      return [];
    },
    async afterSend(_draft, receipts, options) {
      afterSend.push({ refs: Object.keys(receipts).sort(), complete: options.complete });
    },
  });
  const service = createEmailDraftService({
    state,
    idempotency,
    clock,
    mailboxes: faults,
    intake: new MemoryIntakeStore(clock),
    audit,
    kinds,
  });
  return { clock, state, mailboxes, faults, audit, service, afterSend };
}

function input(overrides: Partial<PrepareEmailDraftInput> = {}): PrepareEmailDraftInput {
  return {
    kind: KIND,
    agentId: AGENT,
    ownerUserId: 'u1',
    threadId: THREAD,
    scopeKey: 'order:req-1',
    fromAddress: ADDRESS,
    to: [SUPPLIER_A, SUPPLIER_B],
    subject: SUBJECT,
    body: BODY,
    attachments: [],
    payload: {},
    ...overrides,
  };
}

function pressOf(draft: Pick<EmailDraft, 'token' | 'ownerUserId' | 'threadId'>): EmailDraftPress {
  return { token: draft.token, userId: draft.ownerUserId, threadId: draft.threadId };
}

async function prepare(h: Harness, overrides: Partial<PrepareEmailDraftInput> = {}) {
  return prepareEmailDraft({ state: h.state, clock: h.clock }, input(overrides));
}

async function storedDraft(h: Harness, token: string): Promise<EmailDraft> {
  return emailDraftSchema.parse(await h.state.get(EMAIL_DRAFT_NAMESPACE, token));
}

describe('отказы почтового адаптера в нажатии «Отправить»', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  test('неверный вход: send_failed с причиной, текст сотруднику без кода ошибки', async () => {
    const { draft } = await prepare(h);
    h.faults.failFor.set(SUPPLIER_A.address, 'auth_failed');
    h.faults.failFor.set(SUPPLIER_B.address, 'auth_failed');
    const outcome = await h.service.press(pressOf(draft));
    expect(outcome.kind).toBe('send_failed');
    if (outcome.kind !== 'send_failed') return;
    expect(outcome.reason).toBe('auth_failed');
    expect(outcome.code).toBe('external_failure');
    const text = emailDraftOutcomeText(outcome);
    expect(text).toContain(mailErrorTextForEmployee('auth_failed'));
    expect(text).not.toContain('external_failure');
    expect(text).not.toContain('Можно нажать');
    expect(h.mailboxes.sentBy('u1')).toHaveLength(0);
  });

  test('сервер недоступен: повторяемая ошибка предлагает подтвердить ещё раз', async () => {
    const { draft } = await prepare(h);
    h.faults.failFor.set(SUPPLIER_A.address, 'server_unavailable');
    h.faults.failFor.set(SUPPLIER_B.address, 'server_unavailable');
    const outcome = await h.service.press(pressOf(draft));
    expect(outcome.kind).toBe('send_failed');
    expect(emailDraftOutcomeText(outcome)).toContain('Можно подтвердить отправку ещё раз.');
  });

  test('в аудит идёт причина, а не детали; текстов и адресов там нет', async () => {
    const { draft } = await prepare(h);
    h.faults.failFor.set(SUPPLIER_A.address, 'sender_refused');
    h.faults.failFor.set(SUPPLIER_B.address, 'sender_refused');
    await h.service.press(pressOf(draft));
    const entries = await h.audit.list();
    expect(entries.some((entry) => entry.result === 'error:sender_refused')).toBe(true);
    const dump = JSON.stringify(entries);
    for (const secret of [SUBJECT, BODY, SUPPLIER_A.address, ADDRESS]) {
      expect(dump).not.toContain(secret);
    }
  });

  test('отказ вида «не настроена отправка» приходит с причиной', async () => {
    const { draft } = await prepare(h, { to: [SUPPLIER_A] });
    h.faults.failFor.set(SUPPLIER_A.address, 'send_not_configured');
    const outcome = await h.service.press(pressOf(draft));
    expect(outcome.kind).toBe('send_failed');
    if (outcome.kind === 'send_failed') {
      expect(outcome.code).toBe('not_configured');
      expect(outcome.reason).toBe('send_not_configured');
    }
  });
});

describe('исход «в сомнении»', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  test('send_in_doubt по получателю: in_doubt, остальным ушло, учёт частичный', async () => {
    const { draft } = await prepare(h);
    h.faults.failFor.set(SUPPLIER_B.address, 'send_in_doubt');
    const outcome = await h.service.press(pressOf(draft));
    expect(outcome.kind).toBe('in_doubt');
    expect(emailDraftOutcomeText(outcome)).toContain('Отправленные');
    expect(h.mailboxes.sentBy('u1').map((mail) => mail.to[0])).toEqual([SUPPLIER_A.address]);
    expect(h.afterSend).toEqual([{ refs: ['sup-a'], complete: false }]);
    const entries = await h.audit.list();
    expect(entries.some((entry) => entry.result === 'in_doubt')).toBe(true);
    const stored = await storedDraft(h, draft.token);
    expect(stored.status).toBe('sending');
    expect(Object.keys(stored.sentTo)).toEqual(['sup-a']);
  });

  test('после «в сомнении» правка и отмена закрыты, пока исход не ясен', async () => {
    const { draft } = await prepare(h);
    h.faults.failFor.set(SUPPLIER_A.address, 'send_in_doubt');
    expect((await h.service.press(pressOf(draft))).kind).toBe('in_doubt');
    // Адаптер не подтвердил отправку: исход неизвестен сразу, а не «отправка идёт».
    expect((await h.service.cancel(pressOf(draft))).kind).toBe('in_doubt');
    expect((await h.service.requestEdit(pressOf(draft))).kind).toBe('in_doubt');
    h.clock.advance(IN_DOUBT_MIN_AGE_MS + 1);
    expect((await h.service.cancel(pressOf(draft))).kind).toBe('in_doubt');
  });

  test('повторное нажатие: отправленным не шлём, сомнительному - снова адаптер', async () => {
    const { draft } = await prepare(h);
    h.faults.failFor.set(SUPPLIER_B.address, 'send_in_doubt');
    await h.service.press(pressOf(draft));
    const second = await h.service.press(pressOf(draft));
    expect(second.kind).toBe('in_doubt');
    expect(h.faults.calls.get(SUPPLIER_A.address)).toBe(1);
    expect(h.faults.calls.get(SUPPLIER_B.address)).toBe(2);
    expect(h.mailboxes.sentBy('u1')).toHaveLength(1);
  });

  test('адаптер нашёл письмо в «Отправленных»: нажатие завершается как отправленное', async () => {
    const { draft } = await prepare(h);
    h.faults.failFor.set(SUPPLIER_B.address, 'send_in_doubt');
    await h.service.press(pressOf(draft));
    h.faults.failFor.delete(SUPPLIER_B.address);
    const outcome = await h.service.press(pressOf(draft));
    expect(outcome.kind).toBe('sent');
    expect((await storedDraft(h, draft.token)).status).toBe('sent');
  });

  test('«в сомнении» важнее обычного сбоя соседнего получателя', async () => {
    const { draft } = await prepare(h);
    h.faults.failFor.set(SUPPLIER_A.address, 'server_unavailable');
    h.faults.failFor.set(SUPPLIER_B.address, 'send_in_doubt');
    expect((await h.service.press(pressOf(draft))).kind).toBe('in_doubt');
  });
});

describe('копия в «Отправленных» не сохранилась', () => {
  test('письмо ушло, сотрудник видит фразу про копию', async () => {
    const h = harness();
    h.faults.copyMissing = true;
    const { draft } = await prepare(h);
    const outcome = await h.service.press(pressOf(draft));
    expect(outcome.kind).toBe('sent');
    if (outcome.kind === 'sent') expect(outcome.copyMissing).toBe(2);
    const text = emailDraftOutcomeText(outcome);
    expect(text).toContain('Письмо отправлено');
    expect(text).toContain('Копия в «Отправленных» не сохранилась');
  });

  test('копия есть: фразы нет', async () => {
    const h = harness();
    const { draft } = await prepare(h);
    const outcome = await h.service.press(pressOf(draft));
    expect(emailDraftOutcomeText(outcome)).not.toContain('Копия');
  });
});
