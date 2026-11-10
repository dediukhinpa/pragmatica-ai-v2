import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  FixedClock,
  MemoryChatChannel,
  MemoryMailboxDirectory,
  MemoryStaffDirectory,
  SystemIdGenerator,
  type PgClient,
} from '@business-ai/adapters';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import { ORDER_CALC_AGENT_ID, type OrderCalcDeps } from '../../src/agents/order-calc/deps';
import { PRICES_AGENT_ID, type PricesDeps } from '../../src/agents/prices/deps';
import { createToolContext, recordWorkOwner } from '@business-ai/core';
import { requestTag } from '../../src/agents/order-calc/reply-routing';
import { saveSent } from '../../src/agents/order-calc/state';
import { workSubject } from '../../src/agents/shared/work-owner.owned';
import { createService, type ProductionApp, type Service } from '@business-ai/core/compose';
import { buildDocx } from '@business-ai/testing';
import { DualLlmStub, type DualHandler } from '@business-ai/testing/e2e';
import { buildApp, e2eEnv, openDb } from '../lib/project-env';
import { projectServiceOptions } from '../lib/project-env';
import {
  E2E_SHUTDOWN_MS,
  E2E_WORKER_INTERVAL_MS,
  PRICES_MODEL,
  resetHandoffTables,
  sendText,
  settle,
  textsTo,
  waitFor,
  waitForText,
  writeAccessRules,
} from '../lib/handoff-core';
import { DIGEST_HEADLINE } from '../lib/employee';
import { toolResults, userTexts } from '@business-ai/testing/e2e';
import { findLeaks, type PiiSet } from '@business-ai/testing/e2e';

/**
 * Сценарий p: плановый мониторинг (этап 50, `MONITORING_ENABLED`) на настоящих Postgres,
 * pseudonymizer и pii-guard. Почта сотрудников - заглушка в памяти, часы службы и зависимостей
 * агентов - `FixedClock`: тест сам переводит время на понедельник 9:00, через 3 дня, через
 * 30 дней, а воркер службы выполняет настоящую задачу `monitoring.tick` из таблицы `jobs`.
 *
 * Три обязанности: сводка по заказам (p1), прайс-файлы с устаревшей датой в названии по
 * понедельникам (p2), письма поставщиков
 * с признаками изменения цен (p3). Модель в них не решает: уведомление приходит без кнопок,
 * агент по письму не запускается, заглушка LLM получает только оценку писем, прошедших
 * кодовый фильтр (p3);
 * письмо разбирается только по просьбе самого сотрудника (readPriceMail).
 */

const TIMEZONE = 'Europe/Moscow';
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const TICK_MS = 15 * MS_PER_MINUTE;
const QUIET_MS = 1_000;
/** Часов в сутках от пятницы 18:00 до субботы 10:00 по Москве. */
const FRIDAY_TO_SATURDAY_HOURS = 16;
const WEEK_DAYS = 7;
/** Дата в названии, заведомо старше 3 месяцев к 12.10.2026, и свежая дата. */
const STALE_FILE_NAME = 'прайс_01.01.2026.xlsx';
const FRESH_FILE_NAME = 'прайс_12.10.2026.xlsx';
const UNDATED_FILE_NAME = 'прайс без даты.xlsx';
const UNDATED_MARK = 'Дата в названии не найдена';
const TRIGGER_INTERVAL_DAYS = 3;

/** Время по Москве (UTC+3), заданное в UTC: пятница 2026-10-09 18:00 MSK. */
const FRIDAY_1800 = new Date('2026-10-09T15:00:00.000Z');
const FRIDAY_SENT_AT = '2026-10-09T09:00:00.000Z';
const SATURDAY_REPLY_AT = '2026-10-10T08:00:00.000Z';
const MONDAY_0845 = new Date('2026-10-12T05:45:00.000Z');
const MONDAY_0900 = new Date('2026-10-12T06:00:00.000Z');
const MONDAY_0930 = new Date('2026-10-12T06:30:00.000Z');
const MONDAY_1000 = new Date('2026-10-12T07:00:00.000Z');
const MONDAY_1030 = new Date('2026-10-12T07:30:00.000Z');
const SUNDAY_LETTER_AT = '2026-10-11T12:00:00.000Z';
const THURSDAY_LETTER_AT = '2026-10-15T07:00:00.000Z';

const USER_A = 'emp-e2e-p-a';
const USER_B = 'emp-e2e-p-b';
const THREAD_A = 'e2e-p-thread-a';
const THREAD_B = 'e2e-p-thread-b';
/** Допущен к боту, но ящик не подключён. */
const USER_NO_MAIL = 'emp-e2e-p-nomail';
const THREAD_NO_MAIL = 'e2e-p-thread-nomail';
/** Тред ответственного за прайсы (`PRICE_RESPONSIBLE_THREAD_ID`). */
const THREAD_RESPONSIBLE = 'e2e-p-thread-resp';
const ADDRESS_A = 'ivanov.a@pragmatika-mail.test';
const ADDRESS_B = 'petrov.b@pragmatika-mail.test';

const SUPPLIER_1 = 'sup-e2e-p-1';
const SUPPLIER_2 = 'sup-e2e-p-2';
const NAME_1 = 'ООО Металл Альфа';
const NAME_2 = 'ООО Болтик Бета';
const EMAIL_1 = 'sales@metall-alfa.test';
const EMAIL_2 = 'info@boltik-beta.test';
const STRANGER_EMAIL = 'promo@random-shop.test';
const REQ_A = 'req-e2e-p-a';
const REQ_B = 'req-e2e-p-b';

/** Предел открытых заказов в сводке по умолчанию, дней. */
const ORDER_DIGEST_OPEN_MAX_DAYS_DEFAULT = 14;
/** Сводка по заказам открывается планом на день (d3fa423f); заявки названы по позициям. */
const DIGEST_MARK = DIGEST_HEADLINE;
/** Позиции заявок: название в сводке строится из них, внутренний id в сводке не показывается. */
const ITEM_OF: Readonly<Record<string, string>> = {
  [REQ_A]: 'Швеллер 12П',
  [REQ_B]: 'Саморез 4х40',
};
const STALE_MARK = 'не обновлялись последние 3 месяца';
const NOTICE_MARK = 'Найдено:';
/** Просьба сотрудника разобрать письмо: после неё скрипт модели читает почту. */
const REQUEST_TEXT = 'Разбери письмо поставщика';
const ATTACHMENT_NAME = 'Прайс.xlsx';

/** Отдел закупок сценария p2b (`PRICE_STAFF_DEPARTMENT`) и его сотрудники с ФИО. */
const STAFF_DEPARTMENT = '5';
const STAFF_NAME_A = 'Иванов Алексей';
const STAFF_NAME_B = 'Петров Борис';
const OUTSIDER_NAME = 'Сторонний Автор';
/** Файлы сценария p2b: настоящие docx со свойствами авторства. */
const DOCX_FILE_NAME = 'прайс_01.01.2026.docx';

/** Каталог файлов сценария внутри корня прайсов: чистится после каждого теста. */
const FILES_DIR = 'e2e-p-monitoring';

const MODEL_PII: PiiSet = {
  names: [],
  phones: [],
  emails: [EMAIL_1, EMAIL_2, STRANGER_EMAIL, ADDRESS_A, ADDRESS_B],
};

const stub = new DualLlmStub();
let db: PgClient;
let rules = '';

/** Запущенная служба с часами, которыми управляет тест. */
interface Running {
  app: ProductionApp;
  chat: MemoryChatChannel;
  service: Service;
  mailboxes: MemoryMailboxDirectory;
  clock: FixedClock;
  logs: string[];
  orderDeps: OrderCalcDeps;
  pricesDeps: PricesDeps;
  dispose(): Promise<void>;
}
const running: Running[] = [];

/**
 * Ход «модели» агента «Актуализация прайса (ИИ агент)»: по просьбе сотрудника читает почту
 * (`readPriceMail`), иначе «Принято.». Кнопок уведомления и их токенов больше нет.
 */
const script: DualHandler = ({ model, body }) => {
  if (model !== PRICES_MODEL) throw new Error(`неизвестная модель ${model}`);
  const read = toolResults(body).get('readPriceMail')?.at(-1);
  if (read !== undefined) {
    return { kind: 'text', text: `Почта прочитана: ${JSON.stringify(read)}` };
  }
  const text = userTexts(body).at(-1) ?? '';
  if (text.includes(REQUEST_TEXT)) return { kind: 'tool', name: 'readPriceMail', input: {} };
  return { kind: 'text', text: 'Принято.' };
};

/**
 * Приложение с мониторингом и службой. Боевая сборка берёт `SystemClock`, поэтому часы в
 * зависимости агентов подменяются на `FixedClock` (тот же объект отдан службе: тик, слоты и
 * реестр обращений идут по времени теста).
 */
async function start(startAt: Date, staff?: MemoryStaffDirectory): Promise<Running> {
  // Проверка диска смотрит весь корень прайсов; общий корень e2e несёт фикстуру без даты в
  // названии, поэтому сценарию отдаётся собственный корень (чистится после каждого теста).
  await mkdir(rootOfPrices(), { recursive: true });
  const mailboxes = new MemoryMailboxDirectory();
  mailboxes.connect(USER_A, ADDRESS_A);
  mailboxes.connect(USER_B, ADDRESS_B);
  const { app, chat, config } = buildApp(
    new Map(),
    {
      CHAT_AGENT_ID: PRICES_AGENT_ID,
      ACCESS_POLICY_FILE: rules,
      MONITORING_ENABLED: 'true',
      BUSINESS_TIMEZONE: TIMEZONE,
      PRICE_RESPONSIBLE_THREAD_ID: THREAD_RESPONSIBLE,
      PRICES_FILES_ROOT: rootOfPrices(),
      ...(staff === undefined ? {} : { PRICE_STAFF_DEPARTMENT: STAFF_DEPARTMENT }),
    },
    { mailboxes, ...(staff === undefined ? {} : { staff }) },
  );
  // Предел «открытых» заказов сводки - по умолчанию 14 дней (ORDER_DIGEST_OPEN_MAX_DAYS).
  // В ProductionApp платформы поля `monitoring` нет: настройки читаются из конфигурации.
  expect({
    enabled: config.agents.monitoringEnabled,
    timezone: config.project['BUSINESS_TIMEZONE'],
    orderDigestOpenMaxDays: config.project['ORDER_DIGEST_OPEN_MAX_DAYS'],
  }).toEqual({
    enabled: true,
    timezone: TIMEZONE,
    orderDigestOpenMaxDays: ORDER_DIGEST_OPEN_MAX_DAYS_DEFAULT,
  });
  const clock = new FixedClock(startAt);
  const orderDeps = { ...(app.agentDeps[ORDER_CALC_AGENT_ID] as OrderCalcDeps), clock };
  const pricesDeps = { ...(app.agentDeps[PRICES_AGENT_ID] as PricesDeps), clock };
  const logs: string[] = [];
  const service = createService({
    app: {
      ...app,
      agentDeps: {
        ...app.agentDeps,
        [ORDER_CALC_AGENT_ID]: orderDeps,
        [PRICES_AGENT_ID]: pricesDeps,
      },
    },
    chat,
    access: app.access,
    clock,
    ids: new SystemIdGenerator(),
    healthPort: 0,
    chatAgentId: config.service.chatAgentId,
    chatTurnTimeoutMs: config.service.chatTurnTimeoutMs,
    ...projectServiceOptions(config),
    workerIntervalMs: E2E_WORKER_INTERVAL_MS,
    shutdownTimeoutMs: E2E_SHUTDOWN_MS,
    log: (event, fields) => {
      logs.push(`${event} ${JSON.stringify(fields ?? {})}`);
    },
  });
  await service.start();
  const instance: Running = {
    app,
    chat,
    service,
    mailboxes,
    clock,
    logs,
    orderDeps,
    pricesDeps,
    async dispose() {
      await service.stop().catch(() => undefined);
      await app.close().catch(() => undefined);
    },
  };
  running.push(instance);
  return instance;
}

function tickCount(run: Running): number {
  return run.logs.filter((line) => line.startsWith('monitoring_tick ')).length;
}

/** Ждёт завершения первого тика после старта службы (он идёт сразу, `firstRunAt = now`). */
async function waitFirstTick(run: Running): Promise<void> {
  await waitFor('первый тик мониторинга', () => tickCount(run) >= 1);
}

/**
 * Переводит часы на `at` и ждёт, пока воркер выполнит ровно ещё один тик из очереди. Сбой
 * обязанности (`monitoring_duty_failed`) обрывает ожидание сразу.
 */
async function advanceTo(run: Running, at: Date): Promise<void> {
  const before = tickCount(run);
  run.clock.advance(at.getTime() - run.clock.now().getTime());
  await waitFor(`тик на ${at.toISOString()}`, () => {
    const failed = run.logs.find((line) => line.startsWith('monitoring_duty_failed'));
    if (failed !== undefined) throw new Error(`обязанность упала: ${failed}`);
    return tickCount(run) > before;
  });
}

/** Сообщения треда, содержащие `mark`. */
function messagesWith(run: Running, threadId: string, mark: string): string[] {
  return textsTo(run.chat, threadId).filter((text) => text.includes(mark));
}

/** Сводки и уведомления монитора по всем тредам (по метке). */
function countAll(run: Running, mark: string): number {
  return run.chat.outbox.filter((item) => item.message?.text?.includes(mark) === true).length;
}

function expectNoModel(): void {
  expect(stub.errors).toEqual([]);
  expect(findLeaks(stub.bodies(), MODEL_PII)).toEqual([]);
}

async function seedSuppliers(): Promise<void> {
  const suppliers = new PostgresSupplierRepository(db);
  await suppliers.upsert({ id: SUPPLIER_1, name: NAME_1, email: EMAIL_1 });
  await suppliers.upsert({ id: SUPPLIER_2, name: NAME_2, email: EMAIL_2 });
}

/** Запросы ушли поставщикам в пятницу; владелец заявки - сотрудник `userId` в треде `threadId`. */
async function sendRequests(
  run: Running,
  requestId: string,
  supplierIds: string[],
  userId: string,
  threadId: string,
): Promise<void> {
  const sentBySupplier = Object.fromEntries(supplierIds.map((id) => [id, FRIDAY_SENT_AT]));
  // Без заявки в учёте сводка назвала бы обе «заявка без названия» и их нельзя было бы различить.
  await run.orderDeps.requests.save({
    id: requestId,
    dealRef: `deal-${requestId}`,
    items: [{ name: ITEM_OF[requestId] ?? requestId, quantity: 1, unit: 'шт' }],
    createdAt: FRIDAY_SENT_AT,
  });
  await saveSent(run.orderDeps, {
    requestId,
    supplierIds,
    sentAt: FRIDAY_SENT_AT,
    sentBySupplier,
    mailboxOwnerId: userId,
  });
  await recordWorkOwner(
    run.orderDeps.state,
    workSubject.order(requestId),
    createToolContext({
      threadId,
      agentId: ORDER_CALC_AGENT_ID,
      operationId: `op-${requestId}`,
      initiator: { kind: 'user', userId },
    }),
  );
}

/** Сотрудник пишет боту «Актуализация прайса (ИИ агент)»: насос заносит его в реестр обращений. */
async function contactBot(run: Running, threadId: string, userId: string): Promise<void> {
  await sendText(run.chat, threadId, userId, 'Здравствуйте');
  await waitForText(`ответ боту ${userId}`, run.chat, threadId, 'Принято.');
}

function rootOfPrices(): string {
  return `${e2eEnv().pricesRoot}/${FILES_DIR}`;
}

/** Файл с заданным содержимым и датой изменения `mtime`. */
async function putBytes(path: string, bytes: Uint8Array, mtime: Date): Promise<void> {
  const full = `${rootOfPrices()}/${path}`;
  await mkdir(full.slice(0, full.lastIndexOf('/')), { recursive: true });
  await writeFile(full, bytes);
  await utimes(full, mtime, mtime);
}

/** Файл прайса с датой изменения `mtime`. */
async function putPriceFile(path: string, mtime: Date): Promise<void> {
  const full = `${rootOfPrices()}/${path}`;
  await mkdir(full.slice(0, full.lastIndexOf('/')), { recursive: true });
  await writeFile(full, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
  await utimes(full, mtime, mtime);
}

beforeAll(async () => {
  db = openDb();
  stub.start(e2eEnv().llmPort);
  rules = await writeAccessRules('p-monitoring', {
    [PRICES_AGENT_ID]: [USER_A, USER_B, USER_NO_MAIL],
  });
});

beforeEach(async () => {
  await resetHandoffTables(db);
  stub.begin(script);
});

afterEach(async () => {
  for (const instance of running.splice(0)) await instance.dispose();
  await rm(`${e2eEnv().pricesRoot}/${FILES_DIR}`, { recursive: true, force: true });
});

afterAll(async () => {
  await resetHandoffTables(db);
  await db.close();
  await stub.stop();
});

describe('сценарий p1: сводка по заказам в понедельник в 9:00', () => {
  test('пятница -> понедельник: по одному сообщению владельцам, без дублей', async () => {
    await seedSuppliers();
    const run = await start(FRIDAY_1800);
    await waitFirstTick(run);
    // Заявка A: запросы ушли обоим поставщикам, ответил первый. Заявка B: ответа нет.
    await sendRequests(run, REQ_A, [SUPPLIER_1, SUPPLIER_2], USER_A, THREAD_A);
    await sendRequests(run, REQ_B, [SUPPLIER_2], USER_B, THREAD_B);
    run.mailboxes.deliver(USER_A, {
      id: 'reply-p-1',
      from: EMAIL_1,
      subject: `Re: Запрос цены ${requestTag(REQ_A)}`,
      body: 'Арматура А500С d12: 62 500 руб. за тонну.',
      receivedAt: SATURDAY_REPLY_AT,
      attachments: [],
      senderAuth: 'verified',
    });

    // Выходные: тик идёт, сводки нет. В понедельник до 9:00 тоже нет.
    const saturday = new Date(FRIDAY_1800.getTime() + FRIDAY_TO_SATURDAY_HOURS * MS_PER_HOUR);
    await advanceTo(run, saturday);
    await advanceTo(run, MONDAY_0845);
    expect(countAll(run, DIGEST_MARK)).toBe(0);

    // 9:00 понедельника: каждый владелец получает своё одно сообщение.
    await advanceTo(run, MONDAY_0900);
    await waitFor('сводки обоим', () => countAll(run, DIGEST_MARK) === 2);
    const digestA = messagesWith(run, THREAD_A, DIGEST_MARK);
    const digestB = messagesWith(run, THREAD_B, DIGEST_MARK);
    expect(digestA).toHaveLength(1);
    expect(digestB).toHaveLength(1);
    expect(digestA[0]).toContain(`• ${ITEM_OF[REQ_A]}`);
    expect(digestA[0]).not.toContain(ITEM_OF[REQ_B]);
    expect(digestA[0]).not.toContain(REQ_A);
    expect(digestA[0]).toContain(`${NAME_1}: ответил (почта`);
    expect(digestA[0]).toContain(`${NAME_2}: нет ответа`);
    expect(digestA[0]).toContain('ответ мог прийти в мессенджере или по телефону');
    expect(digestB[0]).toContain(`• ${ITEM_OF[REQ_B]}`);
    expect(digestB[0]).not.toContain(ITEM_OF[REQ_A]);
    expect(digestB[0]).not.toContain(REQ_B);
    expect(digestB[0]).toContain(': нет ответа');
    // Тексты по шаблону кода: ни адресов, ни имён сотрудников.
    for (const text of [...digestA, ...digestB]) {
      expect(text).not.toContain(EMAIL_1);
      expect(text).not.toContain(ADDRESS_A);
    }

    // Повторные тики того же дня (в том числе повторная доставка задачи) ничего не добавляют.
    await advanceTo(run, new Date(MONDAY_0900.getTime() + TICK_MS));
    await advanceTo(run, new Date(MONDAY_0900.getTime() + 2 * TICK_MS));
    await settle(QUIET_MS);
    expect(countAll(run, DIGEST_MARK)).toBe(2);
    expect(messagesWith(run, THREAD_A, DIGEST_MARK)).toHaveLength(1);

    // Модель по расписанию не вызывалась, в журнале только коды и дата.
    expect(stub.requests).toHaveLength(0);
    const tick = run.logs.filter((line) => line.startsWith('monitoring_tick ')).at(-1) ?? '';
    expect(tick).toContain('"date":"2026-10-12"');
    expect(tick).toContain('"orders_digest":"already_done"');
    expect(tick).not.toContain(REQ_A);
    expectNoModel();
  });

  test('суббота и воскресенье не рабочие дни: сводка за пятницу ждёт понедельника', async () => {
    await seedSuppliers();
    const run = await start(FRIDAY_1800);
    await waitFirstTick(run);
    await sendRequests(run, REQ_A, [SUPPLIER_1], USER_A, THREAD_A);
    const saturdayNoon = new Date(FRIDAY_1800.getTime() + 18 * MS_PER_HOUR);
    await advanceTo(run, saturdayNoon);
    await advanceTo(run, new Date(saturdayNoon.getTime() + MS_PER_DAY));
    await settle(QUIET_MS);
    expect(countAll(run, DIGEST_MARK)).toBe(0);
    await advanceTo(run, MONDAY_0900);
    await waitFor('сводка в понедельник', () => countAll(run, DIGEST_MARK) === 1);
    expect(messagesWith(run, THREAD_A, DIGEST_MARK)[0]).toContain(`• ${ITEM_OF[REQ_A]}`);
    expect(stub.requests).toHaveLength(0);
  });
});

describe('сценарий p2: прайсы на диске с устаревшей датой в названии', () => {
  test('по понедельникам: список, без повтора в тот же день, каждую неделю снова', async () => {
    await seedSuppliers();
    const alpha = NAME_1.replace('ООО ', '');
    const beta = NAME_2.replace('ООО ', '');
    // Дата изменения у всех файлов свежая: решает только дата в названии.
    await putPriceFile(`${alpha}/${STALE_FILE_NAME}`, MONDAY_1030);
    await putPriceFile(`${beta}/${STALE_FILE_NAME}`, MONDAY_1030);
    await putPriceFile(`${beta}/${UNDATED_FILE_NAME}`, MONDAY_1030);
    const run = await start(MONDAY_1030);
    await waitFirstTick(run);

    // Первая проверка: одним сообщением, оба поставщика и блок «без даты», в тред ответственного.
    await waitFor('сообщение о старых прайсах', () =>
      messagesWith(run, THREAD_RESPONSIBLE, STALE_MARK).length === 1,
    );
    const first = messagesWith(run, THREAD_RESPONSIBLE, STALE_MARK)[0] ?? '';
    expect(first).toContain('Металл Альфа');
    expect(first).toContain('Болтик Бета');
    expect(first).toContain('01.01.2026');
    expect(first).toContain(UNDATED_MARK);
    expect(first).toContain(UNDATED_FILE_NAME);

    // Тот же понедельник: слот закрыт, сообщение одно.
    await advanceTo(run, new Date(MONDAY_1030.getTime() + TICK_MS));
    await settle(QUIET_MS);
    expect(countAll(run, STALE_MARK)).toBe(1);

    // Вторник: проверка идёт только по понедельникам.
    const tuesday = new Date(MONDAY_1030.getTime() + MS_PER_DAY);
    await advanceTo(run, tuesday);
    await settle(QUIET_MS);
    expect(countAll(run, STALE_MARK)).toBe(1);

    // Файл первого поставщика обновили (в названии свежая дата): он выпадает из списка.
    await rm(`${rootOfPrices()}/${alpha}/${STALE_FILE_NAME}`);
    await putPriceFile(`${alpha}/${FRESH_FILE_NAME}`, tuesday);
    const nextMonday = new Date(MONDAY_1030.getTime() + WEEK_DAYS * MS_PER_DAY);
    await advanceTo(run, nextMonday);
    await waitFor('напоминание в следующий понедельник', () => countAll(run, STALE_MARK) === 2);
    const second = messagesWith(run, THREAD_RESPONSIBLE, STALE_MARK)[1] ?? '';
    expect(second).toContain('Болтик Бета');
    expect(second).not.toContain('Металл Альфа');

    // Следующий день: ничего нового.
    await advanceTo(run, new Date(nextMonday.getTime() + MS_PER_DAY));
    await settle(QUIET_MS);
    expect(countAll(run, STALE_MARK)).toBe(2);
    expect(stub.requests).toHaveLength(0);
  });

  test('свежая дата в названии при старой дате изменения: сообщения нет вовсе', async () => {
    await seedSuppliers();
    const veryOld = new Date(MONDAY_1030.getTime() - 400 * MS_PER_DAY);
    await putPriceFile(`${NAME_1.replace('ООО ', '')}/${FRESH_FILE_NAME}`, veryOld);
    const run = await start(MONDAY_1030);
    await waitFirstTick(run);
    await settle(QUIET_MS);
    expect(countAll(run, STALE_MARK)).toBe(0);
    expect(countAll(run, UNDATED_MARK)).toBe(0);
    expect(run.logs.some((line) => line.startsWith('monitoring_tick '))).toBe(true);
  });
});

describe('сценарий p2b: сводка по прайсам тем, кто работал с файлом', () => {
  const NAMES: PiiSet = {
    names: [STAFF_NAME_A, STAFF_NAME_B, OUTSIDER_NAME, 'Иванов', 'Петров'],
    phones: [],
    emails: [],
  };

  test('каждому по его файлам, остальные в общий поток; без повтора; ФИО не у модели', async () => {
    await seedSuppliers();
    const alpha = NAME_1.replace('ООО ', '');
    const beta = NAME_2.replace('ООО ', '');
    const staff = new MemoryStaffDirectory();
    staff.set(`department:${STAFF_DEPARTMENT}`, [
      { userId: USER_A, lastName: 'Иванов', firstName: 'Алексей' },
      { userId: USER_B, lastName: 'Петров', firstName: 'Борис' },
    ]);
    const authored = (creator: string, lastModifiedBy: string): Uint8Array =>
      buildDocx({ paragraphs: ['прайс'], authors: { creator, lastModifiedBy } });
    // Первый файл - Иванова (создатель и редактор: одна сводка), второй - Петрова (инициалы
    // в записи), третий - постороннего автора, четвёртый без свойств (4 байта мусора, 422).
    await putBytes(`${alpha}/${DOCX_FILE_NAME}`, authored(STAFF_NAME_A, 'Иванов А.'), MONDAY_0845);
    await putBytes(`${beta}/${DOCX_FILE_NAME}`, authored('Петров Б.', OUTSIDER_NAME), MONDAY_0845);
    await putBytes(
      `${beta}/посторонний_01.01.2026.docx`,
      authored(OUTSIDER_NAME, OUTSIDER_NAME),
      MONDAY_0845,
    );
    await putPriceFile(`${beta}/${STALE_FILE_NAME}`, MONDAY_0845);

    // Служба стартует до 9:00: сотрудники успевают написать боту (реестр обращений), затем
    // часы переходят на понедельник 9:00, и тик отправляет сводки.
    const run = await start(MONDAY_0845, staff);
    await waitFirstTick(run);
    await contactBot(run, THREAD_A, USER_A);
    await contactBot(run, THREAD_B, USER_B);
    await advanceTo(run, MONDAY_0900);

    await waitFor('сводка Иванову', () => messagesWith(run, THREAD_A, STALE_MARK).length === 1);
    await waitFor('сводка Петрову', () => messagesWith(run, THREAD_B, STALE_MARK).length === 1);
    await waitFor('общая сводка', () =>
      messagesWith(run, THREAD_RESPONSIBLE, STALE_MARK).length === 1,
    );
    const forA = messagesWith(run, THREAD_A, STALE_MARK)[0] ?? '';
    const forB = messagesWith(run, THREAD_B, STALE_MARK)[0] ?? '';
    const general = messagesWith(run, THREAD_RESPONSIBLE, STALE_MARK)[0] ?? '';
    expect(forA).toContain(`${alpha}/${DOCX_FILE_NAME}`);
    expect(forA).not.toContain(`${beta}/`);
    expect(forB).toContain(`${beta}/${DOCX_FILE_NAME}`);
    expect(forB).not.toContain(`${alpha}/`);
    expect(forB).not.toContain('посторонний_');
    expect(general).toContain('посторонний_01.01.2026.docx');
    expect(general).toContain(STALE_FILE_NAME);
    expect(general).not.toContain(`${alpha}/`);
    expect(countAll(run, STALE_MARK)).toBe(3);

    // Повторный тик в тот же понедельник: слоты получателей закрыты, ничего нового.
    await advanceTo(run, MONDAY_0930);
    await settle(QUIET_MS);
    expect(countAll(run, STALE_MARK)).toBe(3);

    // ФИО в журналах службы, сообщениях и запросах к модели не появляются.
    const everything = [...run.logs, ...run.chat.outbox.map((item) => item.message?.text ?? '')];
    for (const name of NAMES.names) {
      expect(everything.join('\n')).not.toContain(name);
    }
    expect(stub.errors).toEqual([]);
    expect(findLeaks(stub.bodies(), NAMES)).toEqual([]);
  });
});

describe('сценарий p3: письма поставщиков с триггерами о ценах', () => {
  /** Письмо с подтверждённым отправителем, если не сказано иное. */
  function letter(
    id: string,
    from: string,
    subject: string,
    receivedAt: string,
    extra: { senderAuth?: 'verified' | 'unverified'; attachment?: boolean } = {},
  ) {
    return {
      id,
      from,
      subject,
      body: 'Добрый день, просим учесть изменения с ближайшего месяца.',
      receivedAt,
      attachments: extra.attachment
        ? [
            {
              fileName: ATTACHMENT_NAME,
              mimeType: 'application/vnd.ms-excel',
              bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]),
            },
          ]
        : [],
      senderAuth: extra.senderAuth ?? 'verified',
    } as const;
  }

  async function startWithEmployees(): Promise<Running> {
    await seedSuppliers();
    // До 10:00 первый тик просмотр писем не запускает: сначала сотрудники пишут боту.
    const run = await start(MONDAY_0930);
    await waitFirstTick(run);
    await contactBot(run, THREAD_A, USER_A);
    await contactBot(run, THREAD_B, USER_B);
    return run;
  }

  test('чужие письма не читаются, каждому своё, уведомление без кнопок', async () => {
    const run = await startWithEmployees();
    const modelBefore = stub.requests.length;
    const deliverA = (message: ReturnType<typeof letter>): void => {
      run.mailboxes.deliver(USER_A, message);
    };
    deliverA(
      letter('m-a1', EMAIL_1, 'Повышение цен с 1 ноября', SUNDAY_LETTER_AT, { attachment: true }),
    );
    // Не от поставщика; от поставщика без триггера; от поставщика с неподтверждённым отправителем
    // (подлинность не проверяется, решение владельца 30.10 - письмо читается и уведомляет).
    deliverA(letter('m-a2', STRANGER_EMAIL, 'Повышение цен на всё', SUNDAY_LETTER_AT));
    deliverA(letter('m-a3', EMAIL_1, 'Счёт на оплату', SUNDAY_LETTER_AT));
    run.mailboxes.deliver(
      USER_A,
      letter('m-a4', EMAIL_1, 'Новый прайс-лист', SUNDAY_LETTER_AT, { senderAuth: 'unverified' }),
    );
    run.mailboxes.deliver(
      USER_B,
      letter('m-b1', EMAIL_2, 'Новый прайс-лист на ноябрь', SUNDAY_LETTER_AT),
    );

    await advanceTo(run, MONDAY_1000);
    await waitFor('уведомления всем', () => countAll(run, NOTICE_MARK) === 3);
    await settle(QUIET_MS);

    // По сообщению на письмо: у A два (m-a1 и m-a4 с неподтверждённым отправителем), у B одно.
    const noticeA = messagesWith(run, THREAD_A, NOTICE_MARK);
    const noticeB = messagesWith(run, THREAD_B, NOTICE_MARK);
    expect(noticeA).toHaveLength(2);
    expect(noticeB).toHaveLength(1);
    const noticeA1 = noticeA.find((text) => text.includes('Повышение цен с 1 ноября')) ?? '';
    const noticeA4 = noticeA.find((text) => text.includes('Новый прайс-лист')) ?? '';
    expect(noticeA1).toContain(NAME_1);
    expect(noticeA1).toContain('повышение цен');
    expect(noticeA4).toContain(NAME_1);
    // Письмо не от поставщика и письмо без триггера не показаны.
    for (const text of noticeA) {
      expect(text).not.toContain('Повышение цен на всё');
      expect(text).not.toContain('Счёт на оплату');
      expect(text).not.toContain(STRANGER_EMAIL);
    }
    expect(noticeB[0]).toContain(NAME_2);
    expect(noticeB[0]).not.toContain(NAME_1);
    expect(noticeB[0]).toContain('Новый прайс-лист на ноябрь');
    // Готового «обновления прайса» агент не предлагает: у уведомлений кнопок нет.
    for (const item of run.chat.outbox) {
      if (item.message?.text?.includes(NOTICE_MARK) === true) {
        expect(item.message.buttons ?? []).toEqual([]);
      }
    }
    // Письма не помечены обработанными: просмотр только читает.
    expect(run.mailboxes.processedIds(USER_A)).toEqual([]);
    expect(run.mailboxes.processedIds(USER_B)).toEqual([]);
    // Агент по письму не запускается; модель получила только оценку каждого из трёх писем
    // (заглушка отвечает не по схеме - откат к уведомлению).
    expect(stub.requests).toHaveLength(modelBefore + 3);

    // Повторные тики и следующие сутки: новых уведомлений нет (просмотр раз в 3 суток).
    await advanceTo(run, new Date(MONDAY_1000.getTime() + TICK_MS));
    await advanceTo(run, new Date(MONDAY_1000.getTime() + MS_PER_DAY));
    await settle(QUIET_MS);
    expect(countAll(run, NOTICE_MARK)).toBe(3);

    // Через 3 суток: курсор свой на ящик, старые письма не повторяются, новое - одно уведомление.
    deliverA(letter('m-a5', EMAIL_1, 'Изменение цен на сталь', THURSDAY_LETTER_AT));
    await advanceTo(
      run,
      new Date(MONDAY_1000.getTime() + TRIGGER_INTERVAL_DAYS * MS_PER_DAY + 3 * MS_PER_HOUR),
    );
    await waitFor('новое уведомление сотруднику A', () => countAll(run, NOTICE_MARK) === 4);
    await settle(QUIET_MS);
    expect(messagesWith(run, THREAD_A, NOTICE_MARK)).toHaveLength(3);
    expect(messagesWith(run, THREAD_A, 'Изменение цен на сталь')).toHaveLength(1);
    expect(messagesWith(run, THREAD_B, NOTICE_MARK)).toHaveLength(1);

    expect(stub.requests).toHaveLength(modelBefore + 4);

    // Сотрудник сам просит разобрать письмо: читается только его ящик (readPriceMail).
    await sendText(run.chat, THREAD_A, USER_A, REQUEST_TEXT);
    await waitForText('почта прочитана', run.chat, THREAD_A, 'Почта прочитана:');
    const read = messagesWith(run, THREAD_A, 'Почта прочитана:')[0] ?? '';
    expect(read).toContain('"known":true');
    expect(read).toContain(NAME_1);
    expect(read).not.toContain(NAME_2);
    expect(stub.requests.length).toBeGreaterThan(modelBefore);
    expect(run.logs.filter((line) => line.startsWith('monitoring_duty_failed'))).toEqual([]);
    expectNoModel();
  });

  test('сотрудник без подключённой почты не мешает остальным', async () => {
    await seedSuppliers();
    const run = await start(MONDAY_0930);
    await waitFirstTick(run);
    await contactBot(run, THREAD_NO_MAIL, USER_NO_MAIL);
    await contactBot(run, THREAD_A, USER_A);
    const received = letter('m-a1', EMAIL_1, 'Повышение цен с 1 ноября', SUNDAY_LETTER_AT);
    run.mailboxes.deliver(USER_A, received);
    await advanceTo(run, MONDAY_1000);
    await waitFor('уведомление', () => countAll(run, NOTICE_MARK) === 1);
    await settle(QUIET_MS);
    // Уведомление ушло в тред владельца ящика; сотрудник без ящика пропущен без сбоя задачи.
    expect(messagesWith(run, THREAD_A, NOTICE_MARK)).toHaveLength(1);
    expect(messagesWith(run, THREAD_NO_MAIL, NOTICE_MARK)).toHaveLength(0);
    expect(run.logs.filter((line) => line.startsWith('monitoring_duty_failed'))).toEqual([]);
    // Модель получила два приветствия сотрудников и оценку единственного письма.
    expect(stub.requests).toHaveLength(3);
  });
});
