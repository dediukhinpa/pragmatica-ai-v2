import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import {
  MemoryChatChannel,
  MemoryDepartmentHeads,
  SystemClock,
  SystemIdGenerator,
  type PgClient,
} from '@business-ai/adapters';
import { PostgresPriceRepository } from '../../src/kit/adapters/postgres/price-repository';
import {
  PostgresPurchaseRequestRepository,
} from '../../src/kit/adapters/postgres/purchase-request-repository';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import { ORDER_CALC_AGENT_ID } from '../../src/agents/order-calc/deps';
import { PAIR_NOTES_CONTEXT_HEADER } from '../../src/agents/suppliers/pair-notes';
import { PRICES_AGENT_ID } from '../../src/agents/prices/deps';
import { SUPPLIER_HELP_TEXT } from '../../src/agents/suppliers/prompt';
import {
  SUPPLIER_TEMPLATE_COLUMNS,
  type SupplierColumnKey,
} from '../../src/agents/suppliers/supplier-template';
import { createAutoSupplierCard } from '../../src/agents/suppliers/draft-card';
import { createService, type ProductionApp, type Service } from '@business-ai/core/compose';
import type { PurchaseRequest } from '../../src/kit/domain/models';
import type { SupplierCard } from '../../src/kit/domain/supplier-card';
import { DualLlmStub, firstToken, stepInTurn, type DualHandler } from '@business-ai/testing/e2e';
import { buildApp, e2eEnv, openDb } from '../lib/project-env';
import {
  E2E_SHUTDOWN_MS,
  E2E_WORKER_INTERVAL_MS,
  ORDER_CALC_MODEL,
  PRICES_MODEL,
  resetHandoffTables,
  settle,
  textsTo,
  waitFor,
} from '../lib/handoff-core';
import { blocksOf, isRecord, userTexts } from '@business-ai/testing/e2e';
import { findLeaks, type PiiSet } from '@business-ai/testing/e2e';

/**
 * Сценарий q: карточки поставщиков (этап 51, `SUPPLIER_CARDS_ENABLED`) на настоящих Postgres,
 * pseudonymizer, documents и pii-guard; чат - заглушка в памяти, модель - скриптованная.
 * Два бота («Актуализация прайса (ИИ агент)» и «Поиск поставщика (ИИ агент)») и несколько
 * сотрудников в треде связки `<бот>/<id>`.
 *
 * Кнопок подтверждения нет (решение владельца 26.10.2026): сотрудник отвечает текстом, модель
 * вызывает `confirmSupplierRequest`, запись делает код.
 *
 *  q1 - свободным текстом: карточка и подсказки ответа, до ответа база пуста, запись и автор,
 *       чужой сотрудник, повтор, поправка в ответе, право на подтверждение;
 *  q2 - дубли: «обнови существующую», «создай новую», «отмена»;
 *  q3 - правка через агента (новый показ вместо «Изменить»), заметка к карточке;
 *  q4 - пачка xlsx с ошибочными строками: отчёт, одно подтверждение, итог;
 *  q5 - приветствие без кнопок; старые кнопки «Помощь» и «Шаблон» ещё работают;
 *  q6 - личный слой связки: чужой сотрудник и чужой бот записей не видят;
 *  q7 - раздел поставщиков в базе знаний, шорт-лист по карточкам;
 *  q8 - повторный прогон миграций на базе с данными;
 *  q9 - добавленный поставщик находится при поиске, оборот по годам, черновик и слияние.
 */

const USER_A = 'emp-e2e-q-a';
const USER_B = 'emp-e2e-q-b';
const USER_C = 'emp-e2e-q-c';
const BOT_PRICES = 'prices';
const BOT_ORDERS = 'orders';
const CONFIRM_ACTION = 'suppliers.confirm_card';

/** Тексты ответов кода (без модели): сверяются по подстроке. */
const CARD_SHOWN = 'как будет сохранена';
/** Отказ показа записи тому, кто не вправе её подтвердить (этап 234). */
const DENIED_MARK = 'только руководители отделов';
const CARD_SAVED = 'Карточка поставщика сохранена.';
const CARD_UPDATED = 'Карточка поставщика обновлена.';
const CANCELLED = 'Отменено, в базу ничего не записано.';
const DUPLICATE_MARK = 'Похоже на существующего';
const REPORT_MARK = 'Проверка файла поставщиков:';
const ECHO_PREFIX = 'Итог ';

/** Подписи старых кнопок приветствия и их id: прежние сообщения ещё могут их нести. */
const BTN_HELP = 'Помощь по поставщикам';
const BTN_TEMPLATE = 'Шаблон для поставщиков';
const BTN_ADD_SUPPLIER = 'Добавить поставщика';
const LEGACY_HELP_BUTTON = 'greeting:supplier-help';
const LEGACY_TEMPLATE_BUTTON = 'greeting:supplier-template';

/**
 * Ответы сотрудника текстом (кнопок нет) и подсказки, которые показывает код. С этапа «свободные
 * ответы» (4c12b333) подсказка - строка «Например: «a» или «b».» без жирного: это образцы, а не
 * команды, ответ разбирает модель. Поэтому сверяем образец в кавычках-ёлочках.
 */
const TEXT_SAVE = 'да, сохраняй';
const TEXT_CANCEL = 'отмена';
const TEXT_UPDATE = 'обнови существующую';
const TEXT_CREATE = 'создай новую';
const TEXT_YES = 'да';
const TEXT_BATCH_NEW = 'записать только новых';
const TEXT_BATCH_UPDATE = 'записать и обновить дубли';
const HINT_SAVE = `«${TEXT_SAVE}»`;
const HINT_CANCEL = `«${TEXT_CANCEL}»`;
const HINT_UPDATE = `«${TEXT_UPDATE}»`;
const HINT_CREATE = `«${TEXT_CREATE}»`;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TEMPLATE_FILE_NAME = 'Шаблон поставщиков.xlsx';
const BATCH_NAMESPACE = 'suppliers:card-batch';
const QUIET_MS = 1_000;
const RUB_PER_MILLION = 1_000_000;
/** Весовые коэффициенты контрольной суммы ИНН юрлица (10 цифр). */
const INN10_WEIGHTS = [2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const INN_MODULUS = 11;
const DIGIT_MODULUS = 10;

/** Валидный ИНН юрлица из первых девяти цифр. */
function makeInn(base9: string): string {
  const sum = INN10_WEIGHTS.reduce((acc, weight, i) => acc + weight * Number(base9[i]), 0);
  return `${base9}${(sum % INN_MODULUS) % DIGIT_MODULUS}`;
}
/** Тот же ИНН с испорченной последней цифрой: контрольная сумма не сходится. */
function breakInn(inn: string): string {
  const last = Number(inn.at(-1));
  return `${inn.slice(0, -1)}${(last + 1) % DIGIT_MODULUS}`;
}

const INN_MAIN = makeInn('770712345');
const INN_ALPHA = makeInn('771234501');
const INN_NEW = makeInn('781234502');
const SEEDED_ID = 'sup-e2e-q-romashka';
const SEEDED_NAME = 'ООО Ромашка-Тест';
const SEEDED_EMAIL = 'office@romashka-test.example';

/** Контакт нового поставщика из текста сотрудника: проходит через псевдонимизацию. */
const CONTACT_PERSON = 'Кузнецов Андрей Петрович';
const CONTACT_PHONE = '+7 (921) 400-11-22';
const CONTACT_EMAIL = 'kuznetsov@novaya-test.example';
const NEW_PHONE = '+7 (921) 500-33-44';
/** Телефон в карточке: код приводит российские номера к `+7XXXXXXXXXX`. */
const CONTACT_PHONE_STORED = '+79214001122';
const NEW_PHONE_STORED = '+79215003344';
const NEW_NAME = 'ООО Новая-Ромашка';
const PERSONAL_MARK = 'зефирбокс';

const MODEL_PII: PiiSet = {
  names: ['Кузнецов', 'Андрей', 'Петрович'],
  phones: [CONTACT_PHONE, NEW_PHONE],
  emails: [CONTACT_EMAIL, SEEDED_EMAIL],
};

const REQUEST: PurchaseRequest = {
  id: 'req-e2e-q-1',
  dealRef: 'D-2026-Q1',
  items: [{ name: 'Квазарит промышленный', quantity: 5, unit: 'т' }],
  createdAt: '2026-10-01T09:00:00.000Z',
};
const KB_WORD = 'квазарит';
const DOC_SEEDED = 'Поставщики/Ромашка-Тест/прайс.txt';
const DOC_FOLDER = 'Поставщики/Прочий/письмо.txt';
const DOC_COMMON = 'kb-e2e-q/регламент.txt';

/**
 * Отдельный pseudonymizer с `PSEUDONYMIZER_MASK_LEGAL_ENTITY=true`. Общий сервис прогона
 * работает с умолчанием `false`: названия организаций он оставляет в тексте (ИНН маскируется
 * всегда). Сценарий проверяется на сервисе с `true`, чтобы убедиться, что названия
 * организаций тоже не уходят модели; путь с умолчанием - `r-supplier-inn-default`.
 */
const MASKING_PSEUDO_OFFSET = 1;
const PSEUDO_READY_ATTEMPTS = 240;
const PSEUDO_READY_PAUSE_MS = 500;
let maskingPseudonymizer: ChildProcess | undefined;
let maskingPseudonymizerUrl = '';

const PSEUDO_STOP_TIMEOUT_MS = 10_000;

/**
 * Останавливает отдельный pseudonymizer и ждёт выхода процесса: следующий файл прогона (r) берёт
 * тот же порт и иначе видит его занятым.
 */
async function stopMaskingPseudonymizer(): Promise<void> {
  const child = maskingPseudonymizer;
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timedOut = await Promise.race([
    exited.then(() => false),
    Bun.sleep(PSEUDO_STOP_TIMEOUT_MS).then(() => true),
  ]);
  if (timedOut) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function startMaskingPseudonymizer(): Promise<void> {
  const env = e2eEnv();
  const root = requiredRoot();
  const port = Number(process.env['E2E_PSEUDO_PORT']) + MASKING_PSEUDO_OFFSET;
  maskingPseudonymizer = spawn(
    `${root}/services/pseudonymizer/.venv/bin/python`,
    // Сервис - вендоренная labops-pii, как в run.sh: без `-I`, иначе PYTHONPATH игнорируется.
    ['-m', 'labops_pii'],
    {
      cwd: env.work,
      stdio: 'ignore',
      env: {
        ...process.env,
        PYTHONPATH: `${root}/vendor/labops-pii`,
        PSEUDONYMIZER_STORE: 'sqlite',
        PSEUDONYMIZER_KEY_SCHEME: 'v2',
        PSEUDONYMIZER_RETENTION_DAYS: '90',
        PSEUDONYMIZER_ADDRESS_MASK: 'on',
        PSEUDONYMIZER_DB: `${env.work}/pseudonymizer-q.sqlite3`,
        PSEUDONYMIZER_HOST: '127.0.0.1',
        PSEUDONYMIZER_PORT: String(port),
        PSEUDONYMIZER_MASK_LEGAL_ENTITY: 'true',
      },
    },
  );
  maskingPseudonymizerUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < PSEUDO_READY_ATTEMPTS; attempt += 1) {
    const ready = await fetch(`${maskingPseudonymizerUrl}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) return;
    await Bun.sleep(PSEUDO_READY_PAUSE_MS);
  }
  throw new Error('pseudonymizer с маскированием юрлица не поднялся');
}

const stub = new DualLlmStub();
let db: PgClient;
let rulesAll = '';
let rulesNarrow = '';
let batchCounter = 0;

/** Запущенная служба: приложение, чат и журнал. */
interface Running {
  app: ProductionApp;
  chat: MemoryChatChannel;
  service: Service;
  dispose(): Promise<void>;
}
const running: Running[] = [];

// -------------------------------------------------------------------------------------------
// Скриптованная модель
// -------------------------------------------------------------------------------------------

/** Последний результат инструмента в истории запроса: имя и разобранное значение. */
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

function cardIdOf(value: unknown): string {
  const cards = isRecord(value) && Array.isArray(value['cards']) ? value['cards'] : [];
  const first = cards[0];
  if (!isRecord(first) || typeof first['id'] !== 'string') {
    throw new Error(`поиск карточки ничего не нашёл: ${JSON.stringify(value)}`);
  }
  return first['id'];
}

/** Токен по виду, а без него (имя не обезличено) - исходное значение. */
function tokenOr(raw: string, kind: string, fallback: string): string {
  return firstToken(raw, kind) ?? fallback;
}

type Decision = 'save' | 'create' | 'update' | 'cancel';

/** Решение из ответа сотрудника: так модель разбирает «да, сохраняй», «отмена» и т.п. */
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

/** Ход «модели»: по реплике сотрудника выбирает инструмент, по его результату - итог. */
const script: DualHandler = ({ model, raw, body }) => {
  if (model !== PRICES_MODEL && model !== ORDER_CALC_MODEL) {
    throw new Error(`неизвестная модель ${model}`);
  }
  const text = humanOf(body);
  if (stepInTurn(body) > 0) {
    const last = lastToolResult(body);
    if (last === null) throw new Error('нет результата инструмента');
    if (last.name === 'findSupplierCard' && text.includes('поменяй')) {
      return {
        kind: 'tool',
        name: 'prepareSupplierCardEdit',
        input: {
          supplierId: cardIdOf(last.value),
          changes: {
            contacts: [{ phone: tokenOr(raw, 'PHONE', NEW_PHONE) }],
            categories: ['метизы'],
          },
        },
      };
    }
    if (last.name === 'findSupplierCard' && text.includes('заметку')) {
      return {
        kind: 'tool',
        name: 'addSupplierNote',
        input: { supplierId: cardIdOf(last.value), text: 'Отгрузка по четвергам.' },
      };
    }
    return { kind: 'text', text: `${ECHO_PREFIX}${last.name}: ${JSON.stringify(last.value)}` };
  }
  // Решение сотрудника текстом (кнопок нет, решение владельца 26.10.2026).
  if (text.startsWith('сохрани, но телефон')) {
    return {
      kind: 'tool',
      name: 'confirmSupplierRequest',
      input: {
        decision: 'save',
        // Телефон берётся из самой реплики: в истории хода уже есть токен прежнего номера.
        changes: { contacts: [{ phone: tokenOr(text, 'PHONE', NEW_PHONE) }] },
      },
    };
  }
  const decision = decisionOf(text);
  if (decision !== undefined) {
    return { kind: 'tool', name: 'confirmSupplierRequest', input: { decision } };
  }
  if (text.includes('добавь поставщика')) {
    const name = /поставщика\s+(.+?),/.exec(text)?.[1] ?? '';
    const inn = /ИНН\s*(\d{10,12}|\[INN_\d+\])/.exec(text)?.[1];
    const category = /поставляют\s+([^.,]+)/.exec(text)?.[1];
    // «оборот 2025=160, 2024=150 млн»: оборот по годам (разд. 10.9), суммы в миллионах.
    const turnoverByYear = [...text.matchAll(/(20\d{2})=(\d+)/g)].map((match) => ({
      year: Number(match[1]),
      rub: Number(match[2]) * RUB_PER_MILLION,
    }));
    return {
      kind: 'tool',
      name: 'prepareSupplierCard',
      input: {
        ...(turnoverByYear.length === 0 ? {} : { turnoverByYear }),
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
  }
  if (text.includes('найди поставщика')) {
    return { kind: 'tool', name: 'findSupplierCard', input: { query: 'Ромашка' } };
  }
  if (text.includes('поменяй') || text.includes('заметку')) {
    return { kind: 'tool', name: 'findSupplierCard', input: { query: 'Ромашка' } };
  }
  if (text.startsWith('запомни')) {
    return {
      kind: 'tool',
      name: 'rememberForMe',
      input: { text: text.replace(/^запомни:?\s*/, ''), kind: 'preference' },
    };
  }
  if (text.includes('что ты помнишь')) {
    return { kind: 'tool', name: 'whatDoYouRemember', input: {} };
  }
  if (text.includes('подсказки')) {
    const scope = text.includes('раздел')
      ? { section: 'suppliers' }
      : text.includes('одного')
        ? { supplierId: SEEDED_ID }
        : {};
    return {
      kind: 'tool',
      name: 'searchKnowledgeSuppliers',
      input: { requestId: REQUEST.id, query: KB_WORD, ...scope },
    };
  }
  return { kind: 'text', text: 'Принято.' };
};

// -------------------------------------------------------------------------------------------
// Запуск службы и помощники чата
// -------------------------------------------------------------------------------------------

/**
 * Руководители отделов (`UF_HEAD`, этап 234): запись карточек доступна только им. Руководители
 * здесь A и B; C допущен к ботам, но руководителем не является - его подтверждение закрыто.
 */
function departmentHeads(): MemoryDepartmentHeads {
  const heads = new MemoryDepartmentHeads();
  heads.set(USER_A, USER_B);
  return heads;
}

async function start(rules: string): Promise<Running> {
  const { app, chat, config } = buildApp(
    new Map(),
    {
      CHAT_BOTS: JSON.stringify({
        [BOT_PRICES]: PRICES_AGENT_ID,
        [BOT_ORDERS]: ORDER_CALC_AGENT_ID,
      }),
      CHAT_GREETING_ENABLED: 'true',
      ACCESS_POLICY_FILE: rules,
      SUPPLIER_CARDS_ENABLED: 'true',
      SUPPLIER_TEMPLATE_PATH: templatePath(),
      PSEUDONYMIZER_URL: maskingPseudonymizerUrl,
    },
    { heads: departmentHeads() },
  );
  const service = createService({
    app,
    chat,
    access: app.access,
    clock: new SystemClock(),
    ids: new SystemIdGenerator(),
    healthPort: 0,
    chatAgentId: config.service.chatAgentId,
    chatBots: config.service.chatBots,
    chatGreetingEnabled: config.service.chatGreetingEnabled,
    chatTurnTimeoutMs: config.service.chatTurnTimeoutMs,
    workerIntervalMs: E2E_WORKER_INTERVAL_MS,
    shutdownTimeoutMs: E2E_SHUTDOWN_MS,
    log: () => undefined,
  });
  await service.start();
  const instance: Running = {
    app,
    chat,
    service,
    async dispose() {
      await service.stop().catch(() => undefined);
      await app.close().catch(() => undefined);
    },
  };
  running.push(instance);
  return instance;
}

/** Тред связки `<бот>/<сотрудник>`. */
function threadOf(bot: string, user: string): string {
  return `${bot}/${user}`;
}

async function say(run: Running, bot: string, user: string, text: string): Promise<void> {
  await run.chat.emit({
    kind: 'message',
    threadId: threadOf(bot, user),
    userId: user,
    botId: bot,
    text,
  });
}

/** Нажатие кнопки по id; `asThread` - тред, из которого пришло нажатие. */
async function pressId(
  run: Running,
  bot: string,
  user: string,
  buttonId: string,
  asThread: string = threadOf(bot, user),
): Promise<void> {
  await run.chat.emit({ kind: 'button', threadId: asThread, userId: user, botId: bot, buttonId });
}

/**
 * Ответ сотрудника текстом (кнопок нет, решение владельца 26.10.2026): модель вызывает
 * `confirmSupplierRequest`, запись делает код. Возвращает результат инструмента, который
 * скрипт «модели» отдал в итоговом тексте.
 */
async function decide(
  run: Running,
  bot: string,
  user: string,
  text: string,
): Promise<Record<string, unknown>> {
  const thread = threadOf(bot, user);
  const mark = `${ECHO_PREFIX}confirmSupplierRequest`;
  const before = countText(run, thread, mark);
  await say(run, bot, user, text);
  await waitCount(run, thread, mark, before + 1);
  return echoed(run, thread, 'confirmSupplierRequest');
}

/** В треде нет ни одной кнопки: все ответы сотруднику - только текст. */
function expectNoButtons(run: Running, thread: string): void {
  const withButtons = run.chat.outbox.filter(
    (item) => item.threadId === thread && (item.message?.buttons?.length ?? 0) > 0,
  );
  expect(withButtons).toEqual([]);
}

function countText(run: Running, thread: string, mark: string): number {
  return textsTo(run.chat, thread).filter((text) => text.includes(mark)).length;
}

/** Ждёт, пока сообщений с `mark` в треде станет не меньше `count`. */
async function waitCount(
  run: Running,
  thread: string,
  mark: string,
  count = 1,
): Promise<void> {
  await waitFor(`«${mark}» x${count} в ${thread}`, () => countText(run, thread, mark) >= count);
}

/** Последнее сообщение треда с `mark`. */
function lastWith(run: Running, thread: string, mark: string): string {
  return textsTo(run.chat, thread).filter((text) => text.includes(mark)).at(-1) ?? '';
}

/** Результат инструмента, который «модель» вернула сотруднику в итоговом тексте. */
function echoed(run: Running, thread: string, tool: string): Record<string, unknown> {
  const line = lastWith(run, thread, `${ECHO_PREFIX}${tool}: `);
  const parsed: unknown = JSON.parse(line.slice(`${ECHO_PREFIX}${tool}: `.length));
  if (!isRecord(parsed)) throw new Error(`результат ${tool} не объект`);
  return parsed;
}

function expectNoLeak(): void {
  expect(stub.errors).toEqual([]);
  expect(findLeaks(stub.bodies(), MODEL_PII)).toEqual([]);
}

// -------------------------------------------------------------------------------------------
// База: заготовки и проверки
// -------------------------------------------------------------------------------------------

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

async function seedCard(): Promise<void> {
  await new PostgresSupplierRepository(db).saveCard(seededCard());
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

/** Текст «добавь поставщика ...» с ИНН и контактом, как его пишет сотрудник. */
function addText(name: string, inn: string, withContact = true): string {
  const contact = withContact
    ? `, контакт ${CONTACT_PERSON}, ${CONTACT_PHONE}, ${CONTACT_EMAIL}`
    : '';
  return `добавь поставщика ${name}, ИНН ${inn}${contact}, поставляют крепёж.`;
}

// -------------------------------------------------------------------------------------------
// xlsx для пачки: шаблон из репозитория плюс строки (openpyxl из venv сервиса documents)
// -------------------------------------------------------------------------------------------

const FILL_SCRIPT = [
  'import json, sys',
  'from openpyxl import load_workbook',
  'template, target, rows_path = sys.argv[1:4]',
  'book = load_workbook(template)',
  'sheet = book["Поставщики"]',
  'for row in json.load(open(rows_path, encoding="utf-8")):',
  '    sheet.append(row)',
  'book.save(target)',
].join('\n');

type TemplateRow = Partial<Record<SupplierColumnKey, string>>;

function templatePath(): string {
  return `${requiredRoot()}/docs/templates/supplier-template.xlsx`;
}

function requiredRoot(): string {
  const root = process.env['E2E_ROOT'];
  if (root === undefined || root === '') throw new Error('нет E2E_ROOT: запускайте через run.sh');
  return root;
}

/** Файл шаблона с добавленными строками (примерная строка шаблона остаётся второй). */
async function buildBatchFile(rows: readonly TemplateRow[]): Promise<Uint8Array> {
  const out = `${e2eEnv().work}/out`;
  batchCounter += 1;
  const target = `${out}/q-batch-${batchCounter}.xlsx`;
  const rowsPath = `${out}/q-batch-${batchCounter}.json`;
  const scriptPath = `${out}/q-fill.py`;
  const table = rows.map((row) =>
    SUPPLIER_TEMPLATE_COLUMNS.map((column) => row[column.key] ?? ''),
  );
  await writeFile(rowsPath, JSON.stringify(table), 'utf8');
  await writeFile(scriptPath, FILL_SCRIPT, 'utf8');
  const python = `${requiredRoot()}/services/documents/.venv/bin/python`;
  const result = spawnSync(python, ['-I', scriptPath, templatePath(), target, rowsPath], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`сборка xlsx не удалась: ${result.stderr}`);
  return new Uint8Array(await readFile(target));
}

async function sendFile(
  run: Running,
  bot: string,
  user: string,
  name: string,
  content: Uint8Array,
): Promise<void> {
  await run.chat.emit({
    kind: 'file',
    threadId: threadOf(bot, user),
    userId: user,
    botId: bot,
    file: { name, mimeType: XLSX_MIME, content },
  });
}

// -------------------------------------------------------------------------------------------
// Подготовка и очистка
// -------------------------------------------------------------------------------------------

beforeAll(async () => {
  db = openDb();
  stub.start(e2eEnv().llmPort);
  await startMaskingPseudonymizer();
  const users = [USER_A, USER_B, USER_C];
  const bots = {
    [PRICES_AGENT_ID]: users,
    [ORDER_CALC_AGENT_ID]: users,
  };
  const rule = (list: readonly string[]) => ({ allow: { users: [...list] } });
  const common = Object.fromEntries(
    Object.keys(bots).map((bot) => [bot, rule(users)]),
  );
  rulesAll = `${e2eEnv().work}/out/access-q-all.json`;
  await writeFile(rulesAll, JSON.stringify({ version: 1, bots: common }), 'utf8');
  // Тот же допуск к ботам, но подтверждать запись карточек разрешено только сотруднику A.
  const narrow = Object.fromEntries(
    Object.keys(bots).map((bot) => [
      bot,
      { ...rule(users), actions: { [CONFIRM_ACTION]: rule([USER_A]) } },
    ]),
  );
  rulesNarrow = `${e2eEnv().work}/out/access-q-narrow.json`;
  await writeFile(rulesNarrow, JSON.stringify({ version: 1, bots: narrow }), 'utf8');
});

async function cleanKnowledge(): Promise<void> {
  await db.query('DELETE FROM knowledge_chunks WHERE document_id IN ($1, $2, $3)', [
    DOC_SEEDED,
    DOC_FOLDER,
    DOC_COMMON,
  ]);
}

beforeEach(async () => {
  await resetHandoffTables(db);
  await db.query('TRUNCATE agent_pair_notes RESTART IDENTITY');
  await cleanKnowledge();
  stub.begin(script);
});

afterEach(async () => {
  for (const instance of running.splice(0)) await instance.dispose();
});

afterAll(async () => {
  await resetHandoffTables(db);
  await db.query('TRUNCATE agent_pair_notes RESTART IDENTITY');
  await cleanKnowledge();
  await db.close();
  await stub.stop();
  await stopMaskingPseudonymizer();
});

// -------------------------------------------------------------------------------------------
// q1: свободным текстом
// -------------------------------------------------------------------------------------------

describe('сценарий q1: добавить поставщика текстом', () => {
  test('карточка показана, база пуста до ответа, запись с автором, повтор безопасен', async () => {
    const run = await start(rulesAll);
    const threadA = threadOf(BOT_PRICES, USER_A);
    await say(run, BOT_PRICES, USER_A, addText(NEW_NAME, INN_NEW));
    await waitCount(run, threadA, CARD_SHOWN);
    await settle(QUIET_MS);

    // Карточку показал код: имя и контакт настоящие, варианты ответа - жирным текстом.
    const shown = lastWith(run, threadA, CARD_SHOWN);
    expect(shown).toContain(`Название: ${NEW_NAME}`);
    expect(shown).toContain(`ИНН: ${INN_NEW}`);
    expect(shown).toContain(CONTACT_PERSON);
    expect(shown).toContain(CONTACT_PHONE_STORED);
    expect(shown).toContain(CONTACT_EMAIL);
    expect(shown).toContain('(основной)');
    expect(shown).toContain('крепёж');
    expect(shown).toContain(HINT_SAVE);
    expect(shown).toContain(HINT_CANCEL);
    expectNoButtons(run, threadA);
    // Запись только кодом по ответу: до него карточек нет, есть лишь запрос подтверждения.
    expect(await supplierCount()).toBe(0);
    expect(await requestRows('suppliers:card-request')).toBe(1);

    // Модель получила статус и ни одной серии из 10 цифр в результате инструмента.
    await waitCount(run, threadA, `${ECHO_PREFIX}prepareSupplierCard`);
    const result = echoed(run, threadA, 'prepareSupplierCard');
    expect(result['status']).toBe('shown');
    expect(JSON.stringify(result)).not.toContain(INN_NEW);

    // Чужой сотрудник: в его треде ничего не ждёт ответа, в базе по-прежнему пусто.
    const foreign = await decide(run, BOT_PRICES, USER_B, TEXT_SAVE);
    expect(foreign['status']).toBe('nothing_pending');
    expect(await supplierCount()).toBe(0);

    // Владелец отвечает «да, сохраняй»: одна карточка, автор и источник записаны.
    const saved = await decide(run, BOT_PRICES, USER_A, TEXT_SAVE);
    expect(saved['status']).toBe('saved');
    expect(String(saved['message'])).toContain(CARD_SAVED);
    expect(await supplierCount()).toBe(1);
    const card = await cardByName('Новая-Ромашка');
    expect(card?.name).toBe(NEW_NAME);
    expect(card?.inn).toBe(INN_NEW);
    expect(card?.createdBy).toBe(USER_A);
    expect(card?.updatedBy).toBe(USER_A);
    expect(card?.source).toBe('chat');
    expect(card?.status).toBe('new');
    expect(card?.contacts).toHaveLength(1);
    expect(card?.contacts[0]?.fullName).toBe(CONTACT_PERSON);
    expect(card?.contacts[0]?.email).toBe(CONTACT_EMAIL);
    expect(card?.contacts[0]?.phone).toBe(CONTACT_PHONE_STORED);
    expect(card?.contacts[0]?.isPrimary).toBe(true);
    expect(card?.supplies.categories).toEqual(['крепёж']);

    // Повторный ответ ничего не меняет: вторая карточка не появляется.
    await decide(run, BOT_PRICES, USER_A, TEXT_SAVE);
    expect(await supplierCount()).toBe(1);
    expectNoButtons(run, threadA);
    expectNoLeak();
  });

  test('«сохрани, но телефон другой»: поправка из ответа накладывается на показ', async () => {
    const run = await start(rulesAll);
    const threadA = threadOf(BOT_PRICES, USER_A);
    await say(run, BOT_PRICES, USER_A, addText(NEW_NAME, INN_NEW));
    await waitCount(run, threadA, CARD_SHOWN);
    const fix = `сохрани, но телефон другой: ${NEW_PHONE}`;
    const saved = await decide(run, BOT_PRICES, USER_A, fix);
    expect(saved['status']).toBe('saved');
    const card = await cardByName('Новая-Ромашка');
    expect(card?.contacts.map((contact) => contact.phone)).toEqual([NEW_PHONE_STORED]);
    expectNoLeak();
  });

  test('без названия карточка не показана, поиск маскирует ИНН и адрес', async () => {
    const run = await start(rulesAll);
    const threadA = threadOf(BOT_PRICES, USER_A);
    await seedCard();
    // Пустое название: проверка отклоняет, подсказок ответа и записи нет.
    await say(run, BOT_PRICES, USER_A, `добавь поставщика: ИНН ${INN_NEW}, поставляют крепёж.`);
    await waitCount(run, threadA, `${ECHO_PREFIX}prepareSupplierCard`);
    expect(echoed(run, threadA, 'prepareSupplierCard')['status']).toBe('invalid');
    expect(countText(run, threadA, CARD_SHOWN)).toBe(0);
    expect(await supplierCount()).toBe(1);

    // Поиск: модели - только последние цифры ИНН и маска адреса.
    await say(run, BOT_PRICES, USER_B, 'найди поставщика Ромашка');
    const threadB = threadOf(BOT_PRICES, USER_B);
    await waitCount(run, threadB, `${ECHO_PREFIX}findSupplierCard`);
    const found = JSON.stringify(echoed(run, threadB, 'findSupplierCard'));
    expect(found).toContain('"hasInn":true');
    expect(found).toContain(`"innLast4":"${INN_MAIN.slice(-4)}"`);
    expect(found).not.toContain(INN_MAIN);
    expect(found).not.toContain(SEEDED_EMAIL);
    expect(found).toContain('o***@romashka-test.example');
    expectNoLeak();
  });

  test('право подтверждать карточки: без него карточка не показана и не записана', async () => {
    const run = await start(rulesNarrow);
    const threadB = threadOf(BOT_PRICES, USER_B);
    await say(run, BOT_PRICES, USER_B, addText(NEW_NAME, INN_NEW, false));
    // Этап 234: показ записи в общую базу доступен только тому, кто вправе её подтвердить
    // (`suppliers.confirm_card`): сотруднику B правило действия право не даёт - карточки нет.
    await waitCount(run, threadB, DENIED_MARK);
    expect(countText(run, threadB, CARD_SHOWN)).toBe(0);
    // Ответ «да» ничего не записывает: показанной карточки, ждущей ответа, нет.
    const denied = await decide(run, BOT_PRICES, USER_B, TEXT_SAVE);
    expect(denied['status']).toBe('nothing_pending');
    await settle(QUIET_MS);
    expect(await supplierCount()).toBe(0);

    // Сотрудник с правом (A) своё сохраняет без проблем.
    const threadA = threadOf(BOT_PRICES, USER_A);
    await say(run, BOT_PRICES, USER_A, addText(NEW_NAME, INN_NEW, false));
    await waitCount(run, threadA, CARD_SHOWN);
    expect((await decide(run, BOT_PRICES, USER_A, TEXT_SAVE))['status']).toBe('saved');
    expect(await supplierCount()).toBe(1);
    expectNoLeak();
  });

  test('не руководитель отдела: допущен к боту, но карточка не показана и не записана', async () => {
    // Этап 234: право записи - признак `UF_HEAD`, а не только допуск к боту (rulesAll).
    const run = await start(rulesAll);
    const threadC = threadOf(BOT_PRICES, USER_C);
    await say(run, BOT_PRICES, USER_C, addText(NEW_NAME, INN_NEW, false));
    await waitCount(run, threadC, DENIED_MARK);
    expect(countText(run, threadC, CARD_SHOWN)).toBe(0);
    await settle(QUIET_MS);
    expect(await supplierCount()).toBe(0);
    expectNoLeak();
  });
});

// -------------------------------------------------------------------------------------------
// q2: дубли
// -------------------------------------------------------------------------------------------

describe('сценарий q2: похожий поставщик уже есть', () => {
  test('«похоже на существующего», «обнови существующую» накладывает поля', async () => {
    await seedCard();
    const run = await start(rulesAll);
    const threadA = threadOf(BOT_PRICES, USER_A);
    // Другое название, но тот же ИНН: совпадение по ИНН.
    await say(run, BOT_PRICES, USER_A, addText(NEW_NAME, INN_MAIN));
    await waitCount(run, threadA, DUPLICATE_MARK);
    const shown = lastWith(run, threadA, DUPLICATE_MARK);
    expect(shown).toContain(`«${SEEDED_NAME}»`);
    expect(shown).toContain('совпадает ИНН');
    // Выбор подсказан образцами ответа (этап 4c12b333): «обнови существующую» и «создай новую»; «да, сохраняй» не звучит.
    expect(shown).toContain(HINT_UPDATE);
    expect(shown).toContain(HINT_CREATE);
    expect(shown).not.toContain(HINT_SAVE);
    expectNoButtons(run, threadA);
    expect(await supplierCount()).toBe(1);
    await waitCount(run, threadA, `${ECHO_PREFIX}prepareSupplierCard`);
    const result = echoed(run, threadA, 'prepareSupplierCard');
    expect(JSON.stringify(result['duplicates'])).toContain('совпадает ИНН');

    const updated = await decide(run, BOT_PRICES, USER_A, TEXT_UPDATE);
    expect(updated['status']).toBe('saved');
    expect(String(updated['message'])).toContain(CARD_UPDATED);
    expect(await supplierCount()).toBe(1);
    const card = await new PostgresSupplierRepository(db).getCard(SEEDED_ID);
    expect(card?.name).toBe(NEW_NAME);
    expect(card?.createdBy).toBe('seed');
    expect(card?.updatedBy).toBe(USER_A);
    // Прежний контакт сохранён, новый добавлен; категории объединены.
    expect(card?.contacts.map((contact) => contact.email).sort()).toEqual(
      [CONTACT_EMAIL, SEEDED_EMAIL].sort(),
    );
    expect(card?.supplies.categories).toEqual(['крепёж']);
    expectNoLeak();
  });

  test('«создай новую» заводит отдельную карточку, «отмена» не пишет ничего', async () => {
    await seedCard();
    const run = await start(rulesAll);
    const threadA = threadOf(BOT_PRICES, USER_A);
    await say(run, BOT_PRICES, USER_A, addText(NEW_NAME, INN_MAIN, false));
    await waitCount(run, threadA, DUPLICATE_MARK);
    const cancelled = await decide(run, BOT_PRICES, USER_A, TEXT_CANCEL);
    expect(cancelled['status']).toBe('cancelled');
    expect(String(cancelled['message'])).toContain(CANCELLED);
    expect(await supplierCount()).toBe(1);
    expect((await new PostgresSupplierRepository(db).getCard(SEEDED_ID))?.name).toBe(SEEDED_NAME);

    await say(run, BOT_PRICES, USER_A, addText(NEW_NAME, INN_MAIN, false));
    await waitCount(run, threadA, DUPLICATE_MARK, 2);
    const created = await decide(run, BOT_PRICES, USER_A, TEXT_CREATE);
    expect(created['status']).toBe('saved');
    expect(await supplierCount()).toBe(2);
    expect((await new PostgresSupplierRepository(db).getCard(SEEDED_ID))?.name).toBe(SEEDED_NAME);
    expectNoLeak();
  });
});

// -------------------------------------------------------------------------------------------
// q3: правка и заметка
// -------------------------------------------------------------------------------------------

describe('сценарий q3: исправить карточку и добавить заметку', () => {
  test('правка через агента: новый показ вытесняет прежний, запись по последнему', async () => {
    await seedCard();
    const run = await start(rulesAll);
    const threadA = threadOf(BOT_PRICES, USER_A);
    await say(run, BOT_PRICES, USER_A, `поменяй у Ромашки телефон на ${NEW_PHONE}`);
    await waitCount(run, threadA, 'после правки');
    const first = lastWith(run, threadA, 'после правки');
    expect(first).toContain(NEW_PHONE_STORED);
    expect(first).toContain(HINT_SAVE);
    expectNoButtons(run, threadA);
    // До ответа карточка прежняя.
    const before = await new PostgresSupplierRepository(db).getCard(SEEDED_ID);
    expect(before?.updatedBy).toBe('seed');
    expect(before?.contacts.some((contact) => contact.phone !== undefined)).toBe(false);

    // «Изменить» теперь текстом: сотрудник просит поправить, агент готовит новый показ.
    await say(run, BOT_PRICES, USER_A, `поменяй у Ромашки телефон на ${NEW_PHONE}`);
    await waitCount(run, threadA, 'после правки', 2);
    expect((await new PostgresSupplierRepository(db).getCard(SEEDED_ID))?.updatedBy).toBe('seed');

    // Ответ относится к последнему показу: правка записана с автором и временем.
    const saved = await decide(run, BOT_PRICES, USER_A, TEXT_SAVE);
    expect(saved['status']).toBe('saved');
    expect(String(saved['message'])).toContain(CARD_UPDATED);
    const after = await new PostgresSupplierRepository(db).getCard(SEEDED_ID);
    expect(after?.updatedBy).toBe(USER_A);
    expect(after?.createdBy).toBe('seed');
    expect(after?.contacts.some((contact) => contact.phone === NEW_PHONE_STORED)).toBe(true);
    expect(after?.supplies.categories.sort()).toEqual(['крепёж', 'метизы']);
    expectNoLeak();
  });

  test('заметка: общая, автор - ответивший, до его ответа в базе её нет', async () => {
    await seedCard();
    const run = await start(rulesAll);
    const threadB = threadOf(BOT_ORDERS, USER_B);
    await say(run, BOT_ORDERS, USER_B, 'добавь заметку к Ромашке');
    await waitCount(run, threadB, 'Добавить заметку к карточке');
    expect(lastWith(run, threadB, 'Добавить заметку к карточке')).toContain('Например: «да» или «нет».');
    expectNoButtons(run, threadB);
    const repo = new PostgresSupplierRepository(db);
    expect((await repo.getCard(SEEDED_ID))?.notes).toHaveLength(0);
    const added = await decide(run, BOT_ORDERS, USER_B, TEXT_YES);
    expect(added['status']).toBe('note_added');
    const notes = (await repo.getCard(SEEDED_ID))?.notes ?? [];
    expect(notes).toHaveLength(1);
    expect(notes[0]?.authorId).toBe(USER_B);
    expect(notes[0]?.text).toBe('Отгрузка по четвергам.');
    expectNoLeak();
  });
});

// -------------------------------------------------------------------------------------------
// q4: пачка xlsx
// -------------------------------------------------------------------------------------------

const BATCH_ROWS: TemplateRow[] = [
  // Строка 3: новая, всё верно.
  {
    name: 'ООО Альфа Крепёж',
    inn: INN_ALPHA,
    email: 'sales@alfa-krep.example',
    phone: '+7 495 100-20-30',
    categories: 'крепёж; метизы',
  },
  // Строка 4: новая без ИНН.
  { name: 'ООО Бета Металл', email: 'info@beta-metal.example', regions: 'Москва; Тверь' },
  // Строка 5: ИНН с неверной контрольной суммой.
  { name: 'ООО Гамма', inn: breakInn(INN_ALPHA), email: 'gamma@gamma.example' },
  // Строка 6: нет названия.
  { email: 'noname@noname.example', phone: '+7 495 100-20-31' },
  // Строка 7: уже есть в базе (по ИНН).
  { name: 'Ромашка Тест Групп', inn: INN_MAIN, phone: '+7 495 777-88-99' },
  // Строка 8: повтор строки 3 внутри файла.
  { name: 'ооо альфа крепёж', email: 'sales@alfa-krep.example' },
  // Строка 9: новая, статус словами.
  { name: 'ООО Дельта Снаб', status: 'действующий', email: 'delta@delta-snab.example' },
  // Строка 10: статус не из списка.
  { name: 'ООО Эпсилон', status: 'неизвестно', email: 'eps@eps.example' },
];

describe('сценарий q4: пачка поставщиков файлом по шаблону', () => {
  test('отчёт по строкам, база пуста до ответа, одно подтверждение на пачку', async () => {
    await seedCard();
    const run = await start(rulesAll);
    const threadA = threadOf(BOT_PRICES, USER_A);
    const modelBefore = stub.requests.length;
    await sendFile(run, BOT_PRICES, USER_A, 'Поставщики.xlsx', await buildBatchFile(BATCH_ROWS));
    await waitCount(run, threadA, REPORT_MARK);
    const report = lastWith(run, threadA, REPORT_MARK);
    // Этап 177 (bec7e8d5): неверные ИНН и статус больше не отказ, а предупреждение - строки 5 и 10
    // записываются с пустым неверным полем, поэтому «можно записать» 5 (строки 3, 4, 5, 9, 10).
    expect(report).toContain('Можно записать новыми: 5.');
    expect(report).toContain('Уже есть в базе: 1.');
    expect(report).toContain('Повторы внутри файла: 1.');
    expect(report).toContain('Без названия (пропущены): 1.');
    expect(report).toContain('Предупреждения (строки записываются, неверные значения оставлены');
    expect(report).toContain('Примерная строка шаблона пропущена.');
    expect(report).toContain('строка 5:');
    expect(report).toContain('строка 6:');
    expect(report).toContain('строка 10:');
    expect(report).toContain('строка 8 повторяет строку 3');
    expect(report).toContain('строка 7:');
    // Значений ячеек (ИНН, адреса) в отчёте об ошибках нет.
    expect(report).not.toContain(breakInn(INN_ALPHA));
    expect(report).not.toContain('gamma@gamma.example');

    // Содержимое файла к модели не уходило; в базе, кроме заготовки, пусто.
    expect(stub.requests.length).toBe(modelBefore);
    expect(await supplierCount()).toBe(1);
    expect(await requestRows(BATCH_NAMESPACE)).toBe(1);
    // Варианты ответа подсказаны образцами, кнопок у отчёта нет.
    const batchHints = [`«${TEXT_BATCH_NEW}»`, `«${TEXT_BATCH_UPDATE}»`, HINT_CANCEL];
    for (const hint of batchHints) expect(report).toContain(hint);
    expectNoButtons(run, threadA);

    // Чужой сотрудник пачку не подтвердит: в его треде ничего не ждёт ответа.
    const foreign = await decide(run, BOT_PRICES, USER_B, TEXT_BATCH_NEW);
    expect(foreign['status']).toBe('nothing_pending');
    await settle(QUIET_MS);
    expect(await supplierCount()).toBe(1);

    // Одно подтверждение: пять новых строк записаны (две с очищенным полем), дубль базы пропущен,
    // строка без названия не пишется.
    const done = await decide(run, BOT_PRICES, USER_A, TEXT_BATCH_NEW);
    expect(done['status']).toBe('batch_done');
    const doneText = String(done['message']);
    expect(doneText).toContain('Записано новых: 5.');
    expect(doneText).toContain('Обновлено существующих: 0.');
    expect(doneText).toContain('Пропущено: 1.');
    expect(doneText).toContain('строка 7');
    expect(await supplierCount()).toBe(6);
    const alpha = await cardByName('Альфа Крепёж');
    expect(alpha?.inn).toBe(INN_ALPHA);
    expect(alpha?.createdBy).toBe(USER_A);
    expect(alpha?.source).toBe('file');
    expect(alpha?.supplies.categories).toEqual(['крепёж', 'метизы']);
    expect((await cardByName('Дельта Снаб'))?.status).toBe('active');
    // Этап 177: карточки с неверным ИНН / статусом записаны, неверное значение оставлено пустым.
    const gamma = await cardByName('Гамма');
    expect(gamma).not.toBeNull();
    expect(gamma?.inn ?? null).toBeNull();
    expect(await cardByName('Эпсилон')).not.toBeNull();
    // Существующая карточка не тронута.
    expect((await new PostgresSupplierRepository(db).getCard(SEEDED_ID))?.updatedBy).toBe('seed');

    // Повторный ответ безопасен: новых карточек нет.
    await decide(run, BOT_PRICES, USER_A, TEXT_BATCH_NEW);
    expect(await supplierCount()).toBe(6);
    expectNoLeak();
  });

  test('«записать и обновить дубли» обновляет существующую; «отмена» пачку отменяет', async () => {
    await seedCard();
    const run = await start(rulesAll);
    const threadA = threadOf(BOT_PRICES, USER_A);
    const rows: TemplateRow[] = [
      { name: 'ООО Зета Трейд', email: 'zeta@zeta-trade.example' },
      { name: 'Ромашка Тест Групп', inn: INN_MAIN, phone: '+7 495 777-88-99', brands: 'Bosch' },
    ];
    await sendFile(run, BOT_PRICES, USER_A, 'Пачка.xlsx', await buildBatchFile(rows));
    await waitCount(run, threadA, REPORT_MARK);
    const cancelled = await decide(run, BOT_PRICES, USER_A, TEXT_CANCEL);
    expect(cancelled['status']).toBe('cancelled');
    expect(await supplierCount()).toBe(1);

    await sendFile(run, BOT_PRICES, USER_A, 'Пачка.xlsx', await buildBatchFile(rows));
    await waitCount(run, threadA, REPORT_MARK, 2);
    const done = await decide(run, BOT_PRICES, USER_A, TEXT_BATCH_UPDATE);
    expect(done['status']).toBe('batch_done');
    expect(String(done['message'])).toContain('Записано новых: 1.');
    expect(String(done['message'])).toContain('Обновлено существующих: 1.');
    expect(await supplierCount()).toBe(2);
    const updated = await new PostgresSupplierRepository(db).getCard(SEEDED_ID);
    expect(updated?.updatedBy).toBe(USER_A);
    expect(updated?.supplies.brands).toEqual(['Bosch']);
    expect(updated?.name).toBe('Ромашка Тест Групп');
    expectNoLeak();
  });

  test('оборот по годам из ячейки: по годам, одной суммой, неверная запись - ошибка', async () => {
    const run = await start(rulesAll);
    const threadA = threadOf(BOT_PRICES, USER_A);
    const rows: TemplateRow[] = [
      { name: 'ООО Год-Первый', turnover: '2025: 160 млн; 2024: 150 млн; 2023: 100 млн' },
      { name: 'ООО Год-Одна-Сумма', turnover: '150 млн' },
      { name: 'ООО Год-Ошибка', turnover: '2025: много' },
    ];
    await sendFile(run, BOT_PRICES, USER_A, 'Оборот.xlsx', await buildBatchFile(rows));
    await waitCount(run, threadA, REPORT_MARK);
    const report = lastWith(run, threadA, REPORT_MARK);
    // Этап 177: непонятный оборот - предупреждение, строка записывается без оборота.
    expect(report).toContain('Можно записать новыми: 3.');
    expect(report).toContain('Предупреждения (строки записываются');
    expect(report).toContain('строка 5:');
    expect((await decide(run, BOT_PRICES, USER_A, TEXT_BATCH_NEW))['status']).toBe('batch_done');

    // Оборот по годам хранится от нового года к старому, без суммы «вообще».
    const byYear = await cardByName('Год-Первый');
    expect(byYear?.turnoverByYear).toEqual([
      { year: 2025, rub: 160 * RUB_PER_MILLION },
      { year: 2024, rub: 150 * RUB_PER_MILLION },
      { year: 2023, rub: 100 * RUB_PER_MILLION },
    ]);
    expect(byYear?.turnoverRub).toBeUndefined();
    // Сумма без года: общий оборот без указания года.
    const single = await cardByName('Год-Одна-Сумма');
    expect(single?.turnoverRub).toBe(150 * RUB_PER_MILLION);
    expect(single?.turnoverByYear ?? []).toEqual([]);
    const broken = await cardByName('Год-Ошибка');
    expect(broken).not.toBeNull();
    expect(broken?.turnoverRub).toBeUndefined();
    expect(broken?.turnoverByYear ?? []).toEqual([]);
    expectNoLeak();
  });

  test('прайс xlsx пачкой не считается: отчёта и карточек нет', async () => {
    const run = await start(rulesAll);
    const threadA = threadOf(BOT_PRICES, USER_A);
    const price = new Uint8Array(
      await readFile(`${e2eEnv().pricesRoot}/Прайс поставщика.xlsx`),
    );
    await sendFile(run, BOT_PRICES, USER_A, 'Прайс.xlsx', price);
    // Прежний путь: бот «Актуализация прайса (ИИ агент)» принял файл и передал агенту.
    await waitCount(run, threadA, 'Прайс.xlsx');
    await settle(QUIET_MS);
    expect(countText(run, threadA, REPORT_MARK)).toBe(0);
    expect(await requestRows(BATCH_NAMESPACE)).toBe(0);
    expect(await supplierCount()).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// q5: «Помощь» и «Шаблон»
// -------------------------------------------------------------------------------------------

describe('сценарий q5: приветствие без кнопок, «Помощь» и «Шаблон» текстом', () => {
  test('действия жирным; старые кнопки «Помощь» и «Шаблон» отвечает код', async () => {
    const run = await start(rulesAll);
    const threadA = threadOf(BOT_PRICES, USER_A);
    await say(run, BOT_PRICES, USER_A, 'Здравствуйте');
    await waitCount(run, threadA, 'Принято.');
    // Приветствие - текст с действиями жирным, кнопок нет (решение владельца 26.10.2026).
    const greeting = lastWith(run, threadA, 'Могу сразу:');
    for (const label of [BTN_ADD_SUPPLIER, BTN_HELP, BTN_TEMPLATE]) {
      expect(greeting).toContain(`**${label}**`);
    }
    expectNoButtons(run, threadA);

    // Действие, написанное текстом, - обычная реплика: её разбирает агент, а не код.
    const modelBeforeText = stub.requests.length;
    await say(run, BOT_PRICES, USER_A, BTN_HELP);
    await waitFor('ход агента на текст «Помощь»', () => stub.requests.length > modelBeforeText);
    expect(textsTo(run.chat, threadA)).not.toContain(SUPPLIER_HELP_TEXT);

    // Кнопки из прежних сообщений по-прежнему работают без модели.
    const modelBefore = stub.requests.length;
    await pressId(run, BOT_PRICES, USER_A, LEGACY_HELP_BUTTON);
    await waitCount(run, threadA, SUPPLIER_HELP_TEXT.split('\n')[0] ?? '');
    expect(textsTo(run.chat, threadA)).toContain(SUPPLIER_HELP_TEXT);

    await pressId(run, BOT_PRICES, USER_A, LEGACY_TEMPLATE_BUTTON);
    await waitFor('файл шаблона', () =>
      run.chat.outbox.some((item) => item.threadId === threadA && item.file !== undefined),
    );
    const file = run.chat.outbox.find((item) => item.threadId === threadA && item.file)?.file;
    expect(file?.name).toBe(TEMPLATE_FILE_NAME);
    // Отдан файл репозитория как есть (путь задан настройкой SUPPLIER_TEMPLATE_PATH).
    const expected = new Uint8Array(await readFile(templatePath()));
    expect(file?.content.length).toBeGreaterThan(0);
    expect([...(file?.content ?? [])]).toEqual([...expected]);
    // Ни «Помощь», ни «Шаблон» к модели не обращаются.
    expect(stub.requests.length).toBe(modelBefore);
    expectNoLeak();
  });
});

// -------------------------------------------------------------------------------------------
// q6: личный слой связки
// -------------------------------------------------------------------------------------------

describe('сценарий q6: личные заметки видны только своей связке', () => {
  test('«запомни» пишется только после «да»; другой сотрудник и бот записи не видят', async () => {
    const run = await start(rulesAll);
    const threadA = threadOf(BOT_PRICES, USER_A);
    await say(run, BOT_PRICES, USER_A, `запомни: ${PERSONAL_MARK} отвечать коротко`);
    await waitCount(run, threadA, `${ECHO_PREFIX}rememberForMe`);
    // До ответа записи нет: код показал «Запомнить: ...?» с подсказкой «Например: «да» или «нет».».
    await waitCount(run, threadA, 'Запомнить: «');
    expect(lastWith(run, threadA, 'Запомнить: «')).toContain('Например: «да» или «нет».');
    expectNoButtons(run, threadA);
    expect(await db.query('SELECT 1 FROM agent_pair_notes')).toHaveLength(0);
    // Чужой сотрудник чужой вопрос подтвердить не может: в его треде ничего не ждёт ответа.
    const stranger = await decide(run, BOT_PRICES, USER_B, TEXT_YES);
    expect(stranger['status']).toBe('nothing_pending');
    expect(await db.query('SELECT 1 FROM agent_pair_notes')).toHaveLength(0);
    const saved = await decide(run, BOT_PRICES, USER_A, TEXT_YES);
    expect(saved['status']).toBe('pair_note_saved');
    expect(String(saved['message'])).toContain('Запомнил.');
    // Повторный ответ остаётся одной записью. Общая база карточек не тронута.
    await decide(run, BOT_PRICES, USER_A, TEXT_YES);
    const stored = await db.query('SELECT bot_id, user_id, text FROM agent_pair_notes');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.['user_id']).toBe(USER_A);
    expect(String(stored[0]?.['text'])).toContain(PERSONAL_MARK);
    expect(await supplierCount()).toBe(0);

    // «Что ты помнишь»: A видит свою запись.
    await say(run, BOT_PRICES, USER_A, 'что ты помнишь');
    await waitCount(run, threadA, `${ECHO_PREFIX}whatDoYouRemember`);
    expect(lastWith(run, threadA, `${ECHO_PREFIX}whatDoYouRemember`)).toContain(PERSONAL_MARK);

    // В ходе A блок заметок идёт справкой; в ходе B и в другом боте A его нет.
    const requestsBeforeB = stub.requests.length;
    const threadB = threadOf(BOT_PRICES, USER_B);
    await say(run, BOT_PRICES, USER_B, 'что ты помнишь');
    await waitCount(run, threadB, `${ECHO_PREFIX}whatDoYouRemember`);
    expect(lastWith(run, threadB, `${ECHO_PREFIX}whatDoYouRemember`)).toContain('"count":0');
    const threadAOrders = threadOf(BOT_ORDERS, USER_A);
    await say(run, BOT_ORDERS, USER_A, 'что ты помнишь');
    await waitCount(run, threadAOrders, `${ECHO_PREFIX}whatDoYouRemember`);
    expect(lastWith(run, threadAOrders, `${ECHO_PREFIX}whatDoYouRemember`)).toContain(
      '"count":0',
    );
    const foreign = stub.requests.slice(requestsBeforeB).map((item) => item.raw);
    expect(foreign.length).toBeGreaterThan(0);
    for (const body of foreign) expect(body).not.toContain(PERSONAL_MARK);
    expect(
      textsTo(run.chat, threadB).concat(textsTo(run.chat, threadAOrders)).join('\n'),
    ).not.toContain(PERSONAL_MARK);

    // У A следующая реплика в своём треде приходит к модели с блоком личных заметок.
    const beforeNext = stub.requests.length;
    await say(run, BOT_PRICES, USER_A, 'Спасибо');
    await waitFor('ход A после записи', () => stub.requests.length > beforeNext);
    const next = stub.requests[beforeNext]?.raw ?? '';
    expect(next).toContain(PAIR_NOTES_CONTEXT_HEADER.slice(0, 20));
    expect(next).toContain(PERSONAL_MARK);
    expectNoLeak();
  });
});

// -------------------------------------------------------------------------------------------
// q7: раздел поставщиков в базе знаний
// -------------------------------------------------------------------------------------------

describe('сценарий q7: поиск в базе знаний ограничивается разделом поставщиков', () => {
  async function seedKnowledge(): Promise<void> {
    const rows: Array<[string, string | null, string]> = [
      [DOC_SEEDED, SEEDED_ID, `${KB_WORD} поставляется партиями по тонне, отгрузка со склада.`],
      [DOC_FOLDER, 'folder:прочий', `${KB_WORD} в наличии, цена по запросу.`],
      [DOC_COMMON, null, `${KB_WORD} проверяется при приёмке по регламенту.`],
    ];
    for (const [documentId, supplierId, content] of rows) {
      await db.query(
        'INSERT INTO knowledge_chunks (document_id, chunk_index, content, source, supplier_id) ' +
          'VALUES ($1, 0, $2, $1, $3)',
        [documentId, content, supplierId],
      );
    }
    await new PostgresPurchaseRequestRepository(db).save(REQUEST);
  }

  function references(run: Running, thread: string): string[] {
    const result = echoed(run, thread, 'searchKnowledgeSuppliers');
    const list = Array.isArray(result['references']) ? result['references'] : [];
    return list
      .filter(isRecord)
      .map((item) => String(item['documentId']))
      .sort();
  }

  test('без раздела вся база, с разделом поставщики, с id один поставщик', async () => {
    await seedCard();
    await seedKnowledge();
    const run = await start(rulesAll);
    const thread = threadOf(BOT_ORDERS, USER_A);

    await say(run, BOT_ORDERS, USER_A, 'подсказки по квазариту');
    await waitCount(run, thread, `${ECHO_PREFIX}searchKnowledgeSuppliers`, 1);
    expect(references(run, thread)).toEqual([DOC_COMMON, DOC_FOLDER, DOC_SEEDED].sort());

    await say(run, BOT_ORDERS, USER_A, 'подсказки раздел поставщиков');
    await waitCount(run, thread, `${ECHO_PREFIX}searchKnowledgeSuppliers`, 2);
    expect(references(run, thread)).toEqual([DOC_FOLDER, DOC_SEEDED].sort());

    await say(run, BOT_ORDERS, USER_A, 'подсказки только одного поставщика');
    await waitCount(run, thread, `${ECHO_PREFIX}searchKnowledgeSuppliers`, 3);
    expect(references(run, thread)).toEqual([DOC_SEEDED]);
    expectNoLeak();
  });
});

// -------------------------------------------------------------------------------------------
// q8: миграции повторно на базе с данными
// -------------------------------------------------------------------------------------------

describe('сценарий q8: повторный прогон миграций на базе с карточками', () => {
  test('идемпотентно: карточка, контакты и заметки на месте, версия схемы прежняя', async () => {
    const repo = new PostgresSupplierRepository(db);
    await repo.saveCard({
      ...seededCard(),
      notes: [{ text: 'Заметка до миграции', authorId: USER_A, createdAt: '2026-09-02T09:00:00Z' }],
    });
    const result = spawnSync('bash', [`${requiredRoot()}/db/migrate.sh`], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    expect(result.status).toBe(0);
    const again = spawnSync('bash', [`${requiredRoot()}/db/migrate.sh`], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    expect(again.status).toBe(0);
    const card = await repo.getCard(SEEDED_ID);
    expect(card?.contacts).toHaveLength(1);
    expect(card?.notes.map((note) => note.text)).toEqual(['Заметка до миграции']);
    const versions = await db.query(
      "SELECT count(*)::int AS n FROM schema_migrations WHERE version = '018_supplier_cards'",
    );
    expect(Number(versions[0]?.['n'])).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------
// q9: добавленный поставщик находится; оборот по годам; черновик и слияние
// -------------------------------------------------------------------------------------------

/** Ответ сотрудника «да, сохраняй»: модель вызывает confirmSupplierRequest, запись делает код. */
async function confirmSave(run: Running, bot: string, user: string): Promise<void> {
  const thread = threadOf(bot, user);
  const before = countText(run, thread, `${ECHO_PREFIX}confirmSupplierRequest`);
  await say(run, bot, user, 'да, сохраняй');
  await waitCount(run, thread, `${ECHO_PREFIX}confirmSupplierRequest`, before + 1);
  expect(echoed(run, thread, 'confirmSupplierRequest')['status']).toBe('saved');
}

const DRAFT_NAME = 'Ромашка Черновик';
// Подпись непроверенной карточки без слова «черновик» (коммит 08b4df4e).
const TURNOVER_TEXT = 'Оборот по годам: 2025 - 160 000 000 руб.; 2024 - 150 000 000 руб.';
const PRICE_DATE = '2026-10-01T00:00:00.000Z';

describe('сценарий q9: поиск, оборот по годам, черновик карточки', () => {
  test('сотрудник добавил поставщика - он находится при поиске у другого сотрудника', async () => {
    const run = await start(rulesAll);
    const threadA = threadOf(BOT_PRICES, USER_A);
    await say(run, BOT_PRICES, USER_A, addText(NEW_NAME, INN_NEW));
    await waitCount(run, threadA, CARD_SHOWN);
    await confirmSave(run, BOT_PRICES, USER_A);

    // Другой сотрудник и другой бот: поиск поставщиков видит новую карточку.
    const threadB = threadOf(BOT_ORDERS, USER_B);
    await say(run, BOT_ORDERS, USER_B, 'найди поставщика Ромашка');
    await waitCount(run, threadB, `${ECHO_PREFIX}findSupplierCard`);
    const found = echoed(run, threadB, 'findSupplierCard');
    const names = (Array.isArray(found['cards']) ? found['cards'] : []).map((card: unknown) =>
      isRecord(card) ? card['name'] : undefined,
    );
    expect(names).toEqual([NEW_NAME]);
    // Те же карточки видит поиск репозитория (его использует и расчёт заказа).
    const repo = new PostgresSupplierRepository(db);
    const byCategory = await repo.searchCards({ category: 'крепёж', limit: 5 });
    expect(byCategory.map((card) => card.name)).toEqual([NEW_NAME]);
    const byInn = await repo.searchCards({ inn: INN_NEW, limit: 5 });
    expect(byInn.map((card) => card.name)).toEqual([NEW_NAME]);
    expectNoLeak();
  });

  test('оборот по годам: показан, записан, читается от нового года к старому', async () => {
    const run = await start(rulesAll);
    const threadA = threadOf(BOT_PRICES, USER_A);
    const turnoverPart = 'оборот 2024=150, 2025=160 млн';
    await say(run, BOT_PRICES, USER_A, `${addText(NEW_NAME, INN_NEW, false)} ${turnoverPart}`);
    await waitCount(run, threadA, CARD_SHOWN);
    expect(lastWith(run, threadA, CARD_SHOWN)).toContain(TURNOVER_TEXT);
    await confirmSave(run, BOT_PRICES, USER_A);
    const card = await cardByName('Новая-Ромашка');
    expect(card?.turnoverByYear).toEqual([
      { year: 2025, rub: 160 * RUB_PER_MILLION },
      { year: 2024, rub: 150 * RUB_PER_MILLION },
    ]);
    expect(card?.turnoverRub).toBeUndefined();
    expectNoLeak();
  });

  test('автоматическая карточка находится без пометки и дополняется кнопками', async () => {
    const repo = new PostgresSupplierRepository(db);
    const prices = new PostgresPriceRepository(db);
    const { card: draft } = await createAutoSupplierCard(
      repo,
      { name: DRAFT_NAME, phone: CONTACT_PHONE, city: 'Казань' },
      { userId: 'price-agent', nowIso: PRICE_DATE, origin: 'прайс.xlsx' },
    );
    await prices.saveImport(
      draft.id,
      [
        {
          supplierId: draft.id,
          productName: 'Квазарит',
          price: 90,
          currency: 'RUB',
          date: PRICE_DATE,
        },
      ],
      'e2e-q9-draft-import',
    );
    const run = await start(rulesAll);
    const threadB = threadOf(BOT_ORDERS, USER_B);
    await say(run, BOT_ORDERS, USER_B, 'найди поставщика Ромашка');
    await waitCount(run, threadB, `${ECHO_PREFIX}findSupplierCard`);
    const found = JSON.stringify(echoed(run, threadB, 'findSupplierCard'));
    expect(found).not.toContain('"draft"');

    // Тот же путь, что у обычной карточки: правка показывается, «да, сохраняй» дополняет её.
    await say(run, BOT_ORDERS, USER_B, 'поменяй телефон и категорию у Ромашки');
    await waitCount(run, threadB, `${ECHO_PREFIX}prepareSupplierCardEdit`);
    await confirmSave(run, BOT_ORDERS, USER_B);
    const edited = await repo.getCard(draft.id);
    expect(edited?.supplies.categories).toContain('метизы');
    expect(edited?.updatedBy).toBe(USER_B);

    expect(edited?.contacts.map((contact) => contact.phone)).toContain(NEW_PHONE_STORED);
    expectNoLeak();
  });
});
