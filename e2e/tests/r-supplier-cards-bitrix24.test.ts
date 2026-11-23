import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import { type PgClient } from '@business-ai/adapters';
import { EVENT_SKIPPED_NOTICE } from '../lib/project-env';
import { ORDER_CALC_AGENT_ID } from '../../src/agents/order-calc/deps';
import { PRICES_AGENT_ID } from '../../src/agents/prices/deps';
import type { SupplierCard } from '../../src/kit/domain/supplier-card';
import {
  BOT_PRICES,
  startBitrixWorld,
  writeBitrixRules,
  type BitrixWorld,
} from '../lib/bitrix24-world';
import { DualLlmStub, firstToken, stepInTurn, type DualHandler } from '@business-ai/testing/e2e';
import { e2eEnv, openDb } from '../lib/project-env';
import { ORDER_CALC_MODEL, PRICES_MODEL, resetHandoffTables, waitFor } from '../lib/handoff-core';
import { expectNoLeaks } from '@business-ai/testing/e2e';
import { blocksOf, isRecord, userTexts } from '@business-ai/testing/e2e';
import type { PiiSet } from '@business-ai/testing/e2e';
import {
  breakInn,
  buildBatchFile,
  makeInn,
  startMaskingPseudonymizer,
  type MaskingPseudonymizer,
  type TemplateRow,
} from '../lib/supplier-xlsx';

/**
 * Сценарий r-d: карточки поставщиков (этап 51) на настоящем канале Bitrix24 (заглушка
 * портала): добавление текстом (карточка, «Сохранить», автор, дубль), пачка xlsx через
 * скачивание файла с портала (дубль в базе, повтор внутри файла, ошибочные строки),
 * подтверждение только владельцем запроса, повтор файла, кнопка «Шаблон» и недоступный файл.
 * ИНН маскирует отдельный pseudonymizer; модель - скрипт. Значения ячеек подробно проверяет q.
 */

const USER_A = 1001;
const USER_B = 1002;
const ID_A = String(USER_A);
/** Отказ показа записи тому, кто не вправе её подтвердить (этап 234). */
const DENIED_MARK = 'только руководители отделов';
const CONFIRM_ACTION = 'suppliers.confirm_card';

/** Тексты ответов кода (подстроки). */
const CARD_SHOWN = 'как будет сохранена';
const CARD_SAVED = 'Карточка поставщика сохранена.';
const DUPLICATE_MARK = 'Похоже на существующего';
const REPORT_MARK = 'Проверка файла поставщиков:';
const ECHO_PREFIX = 'Итог ';
/** Ответ скрипта модели на нейтральную реплику (барьер порядка). */
const BARRIER_REPLY = 'Принято.';
const DECISION_TOOL = 'confirmSupplierRequest';
/**
 * Кнопок подтверждения нет (решение владельца 26.10.2026): сотрудник отвечает текстом, модель
 * вызывает `confirmSupplierRequest`, запись делает код. Варианты ответа код подсказывает жирным.
 */
const TEXT_SAVE = 'да, сохраняй';
const TEXT_BATCH_NEW = 'записать только новых';
// Жирный текст модели и кода Bitrix24 получает в BB-коде: `**x**` превращается в `[b]x[/b]`.
const bold = (text: string): string => `[b]${text}[/b]`;
// Подсказки ответа с этапа «свободные ответы» (4c12b333) - образцы «Например: «a» или «b».» без
// жирного: ответ разбирает модель, а не код. Сверяем образец в кавычках-ёлочках.
const example = (text: string): string => `«${text}»`;
const HINT_SAVE = example(TEXT_SAVE);
const HINT_CANCEL = example('отмена');
const HINT_UPDATE = example('обнови существующую');
const HINT_CREATE = example('создай новую');
const BTN_TEMPLATE = 'Шаблон для поставщиков';
const TEMPLATE_FILE_NAME = 'Шаблон поставщиков.xlsx';
const BATCH_NAMESPACE = 'suppliers:card-batch';
const CURSOR_NAMESPACE = 'bitrix24-cursor.v1';
const QUIET_MS = 1_500;
/** Сколько сбоев скачивания подряд заказываем: больше любых повторов клиента. */
const DOWNLOAD_FAILURES = 10;

// ИНН с кодом региона 00 (в реальных реквизитах не используется); контрольная сумма верна.
const INN_MAIN = makeInn('000712345');
const INN_ALPHA = makeInn('001234501');
const INN_NEW = makeInn('001234502');
const SEEDED_ID = 'sup-e2e-r-romashka';
const SEEDED_NAME = 'ООО Ромашка-Тест';
const SEEDED_EMAIL = 'office@romashka-test.example';
const NEW_NAME = 'ООО Новая-Ромашка';
const CONTACT_PERSON = 'Кузнецов Андрей Петрович';
/** Телефоны только из диапазона, выделенного для примеров: +7 495 555-01-xx. */
const CONTACT_PHONE = '+7 (495) 555-01-04';
const PHONE_ALPHA = '+7 495 555-01-01';
const PHONE_MAIN = '+7 495 555-01-02';
const PHONE_NO_NAME = '+7 495 555-01-03';
const CONTACT_EMAIL = 'kuznetsov@novaya-test.example';
const CONTACT_PHONE_STORED = '+74955550104';
const ALPHA_EMAIL = 'sales@alfa-krep.example';
const BETA_EMAIL = 'info@beta-metal.example';
const DELTA_EMAIL = 'delta@delta-snab.example';
const GAMMA_EMAIL = 'gamma@gamma.example';

/** ПДн: контакты карточки и ячейки xlsx. В модель и журналы они не попадают. */
const PII: PiiSet = {
  names: ['Кузнецов', 'Андрей', 'Петрович'],
  phones: [CONTACT_PHONE, PHONE_ALPHA, PHONE_MAIN],
  emails: [CONTACT_EMAIL, SEEDED_EMAIL, ALPHA_EMAIL, BETA_EMAIL, DELTA_EMAIL, GAMMA_EMAIL],
};
/** Реквизиты, которых нет в журналах, аудите и очереди (в карточках в БД они законно есть). */
const SECRET_NUMBERS = [INN_MAIN, INN_ALPHA, INN_NEW, breakInn(INN_ALPHA)];
const TYPED_TEXTS = [NEW_NAME, 'Альфа Крепёж', 'Бета Металл', 'Дельта Снаб'];

const BATCH_ROWS: TemplateRow[] = [
  // Строка 3: новая, всё верно.
  {
    name: 'ООО Альфа Крепёж',
    inn: INN_ALPHA,
    email: ALPHA_EMAIL,
    phone: PHONE_ALPHA,
    categories: 'крепёж; метизы',
  },
  // Строка 4: новая без ИНН.
  { name: 'ООО Бета Металл', email: BETA_EMAIL, regions: 'Москва; Тверь' },
  // Строка 5: ИНН с неверной контрольной суммой.
  { name: 'ООО Гамма', inn: breakInn(INN_ALPHA), email: GAMMA_EMAIL },
  // Строка 6: нет названия.
  { email: 'noname@noname.example', phone: PHONE_NO_NAME },
  // Строка 7: уже есть в базе (по ИНН).
  { name: 'Ромашка Тест Групп', inn: INN_MAIN, phone: PHONE_MAIN },
  // Строка 8: повтор строки 3 внутри файла.
  { name: 'ооо альфа крепёж', email: ALPHA_EMAIL },
  // Строка 9: новая, статус словами.
  { name: 'ООО Дельта Снаб', status: 'действующий', email: DELTA_EMAIL },
];

const stub = new DualLlmStub();
let db: PgClient;
let rulesAll = '';
let rulesNarrow = '';
let masking: MaskingPseudonymizer | undefined;
const worlds: BitrixWorld[] = [];

// -------------------------------------------------------------------------------------------
// Скриптованная модель
// -------------------------------------------------------------------------------------------

/** Последний результат инструмента в истории запроса. */
function lastToolResult(body: Record<string, unknown>): { name: string; value: unknown } | null {
  const messages = Array.isArray(body['messages']) ? body['messages'] : [];
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      if (isRecord(block) && block['type'] === 'tool_use') {
        names.set(String(block['id']), String(block['name']));
      }
    }
  }
  let found: { name: string; value: unknown } | null = null;
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      if (!isRecord(block) || block['type'] !== 'tool_result') continue;
      let value: unknown = block['content'];
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch {
          // Оставляем строку как есть.
        }
      }
      found = { name: names.get(String(block['tool_use_id'])) ?? '?', value };
    }
  }
  return found;
}

/** Реплика сотрудника без блока личных заметок, который система ставит перед ней. */
function humanOf(body: Record<string, unknown>): string {
  const text = userTexts(body).at(-1) ?? '';
  const cut = text.lastIndexOf('\n\n');
  return cut < 0 ? text : text.slice(cut + 2);
}

/** Токен по виду, а без него (имя не обезличено) - исходное значение. */
function tokenOr(raw: string, kind: string, fallback: string): string {
  return firstToken(raw, kind) ?? fallback;
}

type Decision = 'save' | 'update' | 'create' | 'cancel';

/** Решение из ответа сотрудника текстом (как его понимает модель по подсказкам кода). */
function decisionOf(text: string): Decision | undefined {
  const lower = text.trim().toLowerCase();
  if (lower === 'отмена' || lower === 'нет') return 'cancel';
  if (lower.startsWith('создай новую')) return 'create';
  if (lower.startsWith('обнови существующую') || lower.startsWith('записать и обновить')) {
    return 'update';
  }
  if (lower === 'да' || lower.startsWith('да, сохраняй') || lower.startsWith('записать только')) {
    return 'save';
  }
  return undefined;
}

/** Ход «модели»: на «добавь поставщика» - карточка; по результату инструмента - итог. */
const script: DualHandler = ({ model, raw, body }) => {
  if (model !== PRICES_MODEL && model !== ORDER_CALC_MODEL) {
    throw new Error(`неизвестная модель ${model}`);
  }
  if (stepInTurn(body) > 0) {
    const last = lastToolResult(body);
    if (last === null) throw new Error('нет результата инструмента');
    return { kind: 'text', text: `${ECHO_PREFIX}${last.name}: ${JSON.stringify(last.value)}` };
  }
  const text = humanOf(body);
  const decision = decisionOf(text);
  if (decision !== undefined) {
    return { kind: 'tool', name: DECISION_TOOL, input: { decision } };
  }
  if (!text.includes('добавь поставщика')) return { kind: 'text', text: 'Принято.' };
  const name = /поставщика\s+(.+?),/.exec(text)?.[1] ?? '';
  const inn = /ИНН\s*(\d{10,12}|\[INN_\d+\])/.exec(text)?.[1];
  const category = /поставляют\s+([^.,]+)/.exec(text)?.[1];
  return {
    kind: 'tool',
    name: 'prepareSupplierCard',
    input: {
      ...(name === '' ? {} : { name }),
      ...(inn === undefined ? {} : { inn }),
      contacts: text.includes('контакт')
        ? [
            {
              fullName: tokenOr(raw, 'PERSON', CONTACT_PERSON),
              phone: tokenOr(raw, 'PHONE', CONTACT_PHONE),
              email: tokenOr(raw, 'EMAIL', CONTACT_EMAIL),
              isPrimary: true,
            },
          ]
        : [],
      ...(category === undefined ? {} : { categories: [category] }),
    },
  };
};

// -------------------------------------------------------------------------------------------
// Запуск, помощники, база
// -------------------------------------------------------------------------------------------

async function start(
  rules: string,
  options: { anonymousDownloads?: boolean } = {},
): Promise<BitrixWorld> {
  if (masking === undefined) throw new Error('pseudonymizer с маскированием не поднят');
  const world = await startBitrixWorld({
    rules,
    flags: { supplierCards: true },
    // Запись карточек - только руководителям отделов (этап 234, `UF_HEAD`): оба сотрудника
    // руководители, поэтому отказ в сценариях идёт от правила действия или от владельца пачки.
    departmentHeads: [USER_A, USER_B],
    ...(options.anonymousDownloads === true ? { anonymousDownloads: true } : {}),
    env: { CHAT_GREETING_ENABLED: 'true', PSEUDONYMIZER_URL: masking.url },
  });
  worlds.push(world);
  return world;
}

function addText(name: string, inn: string, withContact = true): string {
  const contact = withContact
    ? `, контакт ${CONTACT_PERSON}, ${CONTACT_PHONE}, ${CONTACT_EMAIL}`
    : '';
  return `добавь поставщика ${name}, ИНН ${inn}${contact}, поставляют крепёж.`;
}

/** Ответ сотрудника текстом: модель вызывает `confirmSupplierRequest`; возвращает его результат. */
async function decide(
  employee: ReturnType<BitrixWorld['employee']>,
  text: string,
): Promise<Record<string, unknown>> {
  const mark = employee.snapshot(BOT_PRICES);
  await employee.say(BOT_PRICES, text);
  const echo = await employee.waitText(BOT_PRICES, `${ECHO_PREFIX}${DECISION_TOOL}`, {
    since: mark,
  });
  const parsed: unknown = JSON.parse(echo.slice(echo.indexOf('{')));
  if (!isRecord(parsed)) throw new Error('результат решения не объект');
  return parsed;
}

function seededCard(): SupplierCard {
  return {
    id: SEEDED_ID,
    name: SEEDED_NAME,
    inn: INN_MAIN,
    status: 'active',
    contacts: [{ fullName: 'Орлов Сергей', email: SEEDED_EMAIL, isPrimary: true }],
    supplies: { categories: ['крепёж'], brands: [], regions: ['Москва'] },
    terms: {},
    notes: [],
    createdBy: 'seed',
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedBy: 'seed',
    updatedAt: '2026-09-01T09:00:00.000Z',
    source: 'chat',
  };
}

async function supplierCount(): Promise<number> {
  const rows = await db.query('SELECT count(*)::int AS n FROM suppliers');
  return Number(rows[0]?.['n']);
}

async function cardByName(name: string): Promise<SupplierCard | null> {
  const cards = await new PostgresSupplierRepository(db).searchCards({ query: name, limit: 5 });
  return cards[0] ?? null;
}

async function requestRows(namespace: string): Promise<number> {
  const rows = await db.query(
    'SELECT count(*)::int AS n FROM workflow_state WHERE namespace = $1',
    [namespace],
  );
  return Number(rows[0]?.['n']);
}

/** Утечки: модель, журналы, аудит, очередь, курсор. Реквизиты - отдельной проверкой. */
async function expectClean(
  world: BitrixWorld,
  options: { allowEmptyLlm?: boolean } = {},
): Promise<void> {
  expect(stub.errors).toEqual([]);
  await expectNoLeaks({
    llm: stub.bodies(),
    allowEmptyLlm: options.allowEmptyLlm === true,
    logs: world.logs,
    portal: world.portal,
    db,
    pii: PII,
    workflowNamespaces: [CURSOR_NAMESPACE],
    forbiddenTexts: [...TYPED_TEXTS, ...SECRET_NUMBERS],
  });
  // ИНН (в том числе с неверной суммой) не уходит к модели ни одним числом.
  for (const number of SECRET_NUMBERS) expect(stub.bodies().join('\n')).not.toContain(number);
}

beforeAll(async () => {
  db = openDb();
  stub.start(e2eEnv().llmPort);
  masking = await startMaskingPseudonymizer();
  const users = [ID_A, String(USER_B)];
  const rule = (list: readonly string[]): { users: readonly string[] } => ({ users: list });
  rulesAll = await writeBitrixRules('r-cards-all', {
    [PRICES_AGENT_ID]: rule(users),
    [ORDER_CALC_AGENT_ID]: rule(users),
  });
  // Допуск к ботам тот же, а подтверждать запись карточек вправе только сотрудник A.
  const narrow = {
    ...rule(users),
    actions: { [CONFIRM_ACTION]: rule([ID_A]) },
  };
  rulesNarrow = await writeBitrixRules('r-cards-narrow', {
    [PRICES_AGENT_ID]: narrow,
    [ORDER_CALC_AGENT_ID]: narrow,
  });
});

beforeEach(async () => {
  await resetHandoffTables(db);
  await db.query('TRUNCATE agent_pair_notes RESTART IDENTITY');
  stub.begin(script);
});

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.dispose();
});

afterAll(async () => {
  await resetHandoffTables(db);
  await db.query('TRUNCATE agent_pair_notes RESTART IDENTITY');
  await db.close();
  await stub.stop();
  await masking?.stop();
});

// -------------------------------------------------------------------------------------------
// r-d1: текстом
// -------------------------------------------------------------------------------------------

describe('r-d1: добавить поставщика текстом', () => {
  test('карточка, ответ «да, сохраняй», автор, повтор и дубль', async () => {
    const world = await start(rulesAll);
    const employee = world.employee(USER_A);
    await employee.say(BOT_PRICES, addText(NEW_NAME, INN_NEW));
    const shown = await employee.waitText(BOT_PRICES, CARD_SHOWN);
    await employee.waitText(BOT_PRICES, `${ECHO_PREFIX}prepareSupplierCard`);
    expect(shown).toContain(`Название: ${NEW_NAME}`);
    expect(shown).toContain(`ИНН: ${INN_NEW}`);
    expect(shown).toContain(CONTACT_PERSON);
    expect(shown).toContain(CONTACT_PHONE_STORED);
    // Варианты ответа подсказаны образцами, кнопок у карточки нет.
    expect(shown).toContain(HINT_SAVE);
    expect(shown).toContain(HINT_CANCEL);
    expect(Object.keys(employee.lastButtons(BOT_PRICES))).toEqual([]);
    // До ответа в базе пусто: есть только запрос подтверждения.
    expect(await supplierCount()).toBe(0);
    expect(await requestRows('suppliers:card-request')).toBe(1);

    const saved = await decide(employee, TEXT_SAVE);
    expect(saved['status']).toBe('saved');
    expect(String(saved['message'])).toContain(CARD_SAVED);
    expect(await supplierCount()).toBe(1);
    const card = await cardByName('Новая-Ромашка');
    expect(card?.name).toBe(NEW_NAME);
    expect(card?.inn).toBe(INN_NEW);
    expect(card?.createdBy).toBe(ID_A);
    expect(card?.updatedBy).toBe(ID_A);
    expect(card?.contacts[0]?.fullName).toBe(CONTACT_PERSON);
    expect(card?.contacts[0]?.email).toBe(CONTACT_EMAIL);

    // Повторный ответ безопасен: код повторяет прежний итог, вторая карточка не появляется.
    await decide(employee, TEXT_SAVE);
    expect(await supplierCount()).toBe(1);

    // Тот же поставщик ещё раз: «Похоже на существующего», выбор «обновить / создать».
    const before = employee.snapshot(BOT_PRICES);
    await employee.say(BOT_PRICES, addText(NEW_NAME, INN_NEW, false));
    const duplicate = await employee.waitText(BOT_PRICES, DUPLICATE_MARK, { since: before });
    expect(duplicate).toContain(`«${NEW_NAME}»`);
    expect(duplicate).toContain(HINT_UPDATE);
    expect(duplicate).toContain(HINT_CREATE);
    expect(duplicate).toContain(HINT_CANCEL);
    expect(Object.keys(employee.lastButtons(BOT_PRICES))).toEqual([]);
    expect(await supplierCount()).toBe(1);
    await world.idle(QUIET_MS);
    await expectClean(world);
  });

  test('без права подтверждения карточка не показана и не записана', async () => {
    const world = await start(rulesNarrow);
    const employee = world.employee(USER_B);
    await employee.say(BOT_PRICES, addText(NEW_NAME, INN_NEW, false));
    // Этап 234: показ записи в общую базу доступен только тому, кто вправе её подтвердить;
    // правило действия сужает право до сотрудника A - для B карточка не показывается.
    await employee.waitText(BOT_PRICES, DENIED_MARK);
    expect(employee.texts(BOT_PRICES).some((text) => text.includes(CARD_SHOWN))).toBe(false);
    const denied = await decide(employee, TEXT_SAVE);
    expect(denied['status']).toBe('nothing_pending');
    await world.idle(QUIET_MS);
    expect(await supplierCount()).toBe(0);
    await expectClean(world);
  });
});

// -------------------------------------------------------------------------------------------
// r-d2: пачка xlsx
// -------------------------------------------------------------------------------------------

describe('r-d2: пачка поставщиков файлом с портала', () => {
  test('отчёт, подтверждает только владелец, повтор файла - «Уже есть в базе»', async () => {
    await new PostgresSupplierRepository(db).saveCard(seededCard());
    const world = await start(rulesAll);
    const owner = world.employee(USER_A);
    const stranger = world.employee(USER_B);
    const modelBefore = stub.requests.length;
    await owner.sendFile('prices', 'Поставщики.xlsx', await buildBatchFile(BATCH_ROWS));
    const report = await owner.waitText(BOT_PRICES, REPORT_MARK);
    // Этап 177 (bec7e8d5): неверный ИНН - предупреждение, строка 5 записывается с пустым ИНН,
    // поэтому новых 4 (строки 3, 4, 5, 9), а «С ошибками» заменено на «Без названия (пропущены)».
    expect(report).toContain('Можно записать новыми: 4.');
    expect(report).toContain('Уже есть в базе: 1.');
    expect(report).toContain('Повторы внутри файла: 1.');
    expect(report).toContain('Без названия (пропущены): 1.');
    expect(report).toContain('Предупреждения (строки записываются, неверные значения оставлены');
    expect(report).toContain('строка 8 повторяет строку 3');
    // Значений ячеек с предупреждениями в отчёте нет.
    expect(report).not.toContain(breakInn(INN_ALPHA));
    expect(report).not.toContain(GAMMA_EMAIL);
    // Файл разобрал код: модель не вызывалась, база кроме заготовки пуста до ответа владельца.
    expect(stub.requests).toHaveLength(modelBefore);
    expect(await supplierCount()).toBe(1);
    expect(await requestRows(BATCH_NAMESPACE)).toBe(1);
    // Варианты ответа подсказаны образцами, кнопок у отчёта нет.
    const hints = [example(TEXT_BATCH_NEW), example('записать и обновить дубли'), HINT_CANCEL];
    for (const hint of hints) expect(report).toContain(hint);
    expect(Object.keys(owner.lastButtons(BOT_PRICES))).toEqual([]);

    // Чужой сотрудник отвечает «записать только новых»: в его диалоге ничего не ждёт ответа,
    // записи нет, владельцу ничего не приходит.
    const ownerTextsBefore = owner.texts(BOT_PRICES).length;
    const foreign = await decide(stranger, TEXT_BATCH_NEW);
    expect(foreign['status']).toBe('nothing_pending');
    expect(await supplierCount()).toBe(1);
    expect(owner.texts(BOT_PRICES)).toHaveLength(ownerTextsBefore);

    // Владелец: одно подтверждение, четыре новых строки записаны, дубль базы пропущен.
    const result = await decide(owner, TEXT_BATCH_NEW);
    expect(result['status']).toBe('batch_done');
    const done = String(result['message']);
    expect(done).toContain('Записано новых: 4.');
    expect(done).toContain('Пропущено: 1.');
    expect(await supplierCount()).toBe(5);
    const alpha = await cardByName('Альфа Крепёж');
    expect(alpha?.inn).toBe(INN_ALPHA);
    expect(alpha?.createdBy).toBe(ID_A);
    expect(alpha?.source).toBe('file');
    // Этап 177: Гамма записана, неверный ИНН оставлен пустым.
    const gamma = await cardByName('Гамма');
    expect(gamma).not.toBeNull();
    expect(gamma?.inn ?? null).toBeNull();

    // Тот же файл ещё раз: всё уже в базе, новых строк нет.
    const modelAfterDecisions = stub.requests.length;
    const mark = owner.snapshot(BOT_PRICES);
    await owner.sendFile('prices', 'Поставщики.xlsx', await buildBatchFile(BATCH_ROWS));
    const again = await owner.waitText(BOT_PRICES, REPORT_MARK, { since: mark });
    expect(again).toContain('Уже есть в базе');
    expect(again).not.toContain('Можно записать новыми: 4.');
    expect(await supplierCount()).toBe(5);
    // Повторный файл разобрал код: к модели ничего не ушло.
    expect(stub.requests).toHaveLength(modelAfterDecisions);
    await world.idle(QUIET_MS);
    await expectClean(world);
  });
});

// -------------------------------------------------------------------------------------------
// r-d3: шаблон и недоступный файл
// -------------------------------------------------------------------------------------------

describe('r-d3: шаблон и недоступный файл', () => {
  test('приветствие без кнопок: «Шаблон» подсказан жирным, текстом идёт агенту', async () => {
    const world = await start(rulesAll);
    const employee = world.employee(USER_A);
    await employee.say(BOT_PRICES, 'Здравствуйте');
    await employee.waitText(BOT_PRICES, BARRIER_REPLY);
    // Кнопок «Помощь» и «Шаблон» в Bitrix24 больше нет (решение владельца 26.10.2026): действия
    // перечислены в приветствии жирным.
    const greeting = await employee.waitText(BOT_PRICES, 'Могу сразу:');
    expect(greeting).toContain(bold(BTN_TEMPLATE));
    expect(Object.keys(employee.lastButtons(BOT_PRICES))).toEqual([]);
    // Действие, написанное текстом, - обычная реплика: её разбирает агент, файл код не шлёт.
    const modelBefore = stub.requests.length;
    await employee.say(BOT_PRICES, BTN_TEMPLATE);
    await waitFor('ход агента на текст «Шаблон»', () => stub.requests.length > modelBefore);
    await world.idle(QUIET_MS);
    expect(world.portal.uploads.filter((item) => item.name === TEMPLATE_FILE_NAME)).toHaveLength(0);
    await expectClean(world);
  });

  test('сбой скачивания один раз: событие повторяется само, отчёт приходит один', async () => {
    const world = await start(rulesAll);
    const employee = world.employee(USER_A);
    const bytes = await buildBatchFile(BATCH_ROWS);
    world.portal.failNext('download', { kind: '5xx', times: 1 });
    await employee.sendFile('prices', 'Поставщики.xlsx', bytes);
    const report = await employee.waitText(BOT_PRICES, REPORT_MARK);
    // Этап 177: пустая база, новых 5 (строки 3, 4, 5, 9, 10; 5 и 10 - с предупреждением).
    expect(report).toContain('Можно записать новыми: 5.');
    await world.idle(QUIET_MS);
    expect(employee.texts(BOT_PRICES).filter((text) => text.includes(REPORT_MARK))).toHaveLength(1);
    expect(world.logCount('bitrix24_deferred_failed')).toBe(1);
    expect(world.logCount('bitrix24_deferred_gave_up')).toBe(0);
    expect(await requestRows(BATCH_NAMESPACE)).toBe(1);
    expect(await supplierCount()).toBe(0);
    expect(stub.requests).toHaveLength(0);
    await expectClean(world, { allowEmptyLlm: true });
  });

  test('файл недоступен: после трёх попыток понятное уведомление, повтор проходит', async () => {
    const world = await start(rulesAll);
    const employee = world.employee(USER_A);
    const bytes = await buildBatchFile(BATCH_ROWS);
    // Скачивание сыплется 5xx: адаптер повторяет событие, на третьей неудаче пропускает его
    // и сообщает сотруднику (отдельный текст про файл - для отказов без смысла повторять).
    world.portal.failNext('download', { kind: '5xx', times: DOWNLOAD_FAILURES });
    await employee.sendFile('prices', 'Поставщики.xlsx', bytes);
    await employee.waitText(BOT_PRICES, EVENT_SKIPPED_NOTICE);
    await world.idle(QUIET_MS);
    // Не молча и без записи: ни отчёта, ни запроса подтверждения, ни карточек, модель не звали.
    expect(employee.texts(BOT_PRICES)).toEqual([EVENT_SKIPPED_NOTICE]);
    expect(world.logCount('bitrix24_deferred_gave_up')).toBe(1);
    expect(await requestRows(BATCH_NAMESPACE)).toBe(0);
    expect(await supplierCount()).toBe(0);
    expect(stub.requests).toHaveLength(0);

    // Портал снова отдаёт файл: тот же файл, присланный ещё раз, разбирается.
    world.portal.clearFailures();
    await employee.sendFile('prices', 'Поставщики.xlsx', bytes);
    const report = await employee.waitText(BOT_PRICES, REPORT_MARK);
    // Этап 177: пустая база, новых 5 (строки 3, 4, 5, 9, 10; 5 и 10 - с предупреждением).
    expect(report).toContain('Можно записать новыми: 5.');
    expect(await supplierCount()).toBe(0);
    await world.idle(QUIET_MS);
    await expectClean(world, { allowEmptyLlm: true });
  });

  test('портал не прислал имя файла, но указал тип xlsx: файл принят как .xlsx', async () => {
    // Мир без `Content-Disposition`: имя файла в ответе скачивания нет, тип - xlsx. Адаптер
    // называет файл `file-<id>` и берёт расширение по типу содержимого (первый коммит ветки).
    // Без расширения приём файлов отклонил бы такой файл как неизвестный тип.
    const world = await start(rulesAll, { anonymousDownloads: true });
    const employee = world.employee(USER_A);
    const bytes = await buildBatchFile(BATCH_ROWS);
    await employee.sendFile('prices', 'Поставщики.xlsx', bytes);
    const report = await employee.waitText(BOT_PRICES, REPORT_MARK);
    // Этап 177: пустая база, новых 5 (строки 3, 4, 5, 9, 10; 5 и 10 - с предупреждением).
    expect(report).toContain('Можно записать новыми: 5.');
    expect(await requestRows(BATCH_NAMESPACE)).toBe(1);
    expect(world.logCount('bitrix24_deferred_failed')).toBe(0);
    expect(world.logCount('bitrix24_deferred_gave_up')).toBe(0);
    expect(stub.requests).toHaveLength(0);
    await expectClean(world, { allowEmptyLlm: true });
  });
});
