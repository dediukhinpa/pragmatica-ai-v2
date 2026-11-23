import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { MemoryWebSearch, type PgClient } from '@business-ai/adapters';
import { PostgresPriceRepository } from '../../src/kit/adapters/postgres/price-repository';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import { ORDER_CALC_AGENT_ID } from '../../src/agents/order-calc/deps';
import type { WebSearchHit, WebSearchOptions } from '@business-ai/core';
import {
  BOT_ORDERS,
  startBitrixWorld,
  writeBitrixRules,
  type BitrixWorld,
} from '../lib/bitrix24-world';
import { DualLlmStub, type DualHandler } from '@business-ai/testing/e2e';
import { e2eEnv, openDb } from '../lib/project-env';
import { SHORTLIST_FILE_NAME } from '../lib/employee';
import { ORDER_CALC_MODEL, resetHandoffTables } from '../lib/handoff-core';
import { expectNoLeaks } from '@business-ai/testing/e2e';
import { blocksOf, isRecord, toolResults, userTexts } from '@business-ai/testing/e2e';
import type { PiiSet } from '@business-ai/testing/e2e';

/**
 * Сценарий v2: шорт-лист с веб-кандидатами, обогащёнными по страницам, и две средние стоимости
 * (этап 104, темы 3-4). Боевая сборка на заглушке портала Bitrix24, настоящие pseudonymizer и
 * pii-guard; веб-поиск - страницы в памяти, модель - скрипт. Запросы строит и кандидатов
 * обогащает отдельный вызов модели через шлюз псевдонимизации: заглушка различает его по
 * системному промпту.
 *
 *  v2a - запросы составила модель по полям формы; кандидаты с городом, контактами, ценой и
 *        сроком; две средние (по базе и по интернету) считаются по двум ценам, без порога в
 *        три цены; ПДн страниц модели не уходят;
 *  v2b - модель запросов дала мусор: запасной путь, запрос - название позиции;
 *  v2c - цен нет нигде: обе средние «нет данных», у кандидатов «нет данных»;
 *  v2d - одна цена с сайта: среднее по одной цене, база без цен - «нет данных».
 */

const USER = 1001;
const USER_NAME = { name: 'Милана', lastName: 'Гончарова' };
const TASK_ID = 92;
const RULES_NAME = 'v-shortlist-web-averages';
const ITEM = { name: 'Арматура А500С d12', quantity: 100, unit: 'м' };
const ASK_MARK = 'Нужна арматура';

/** Поставщики базы: по одной цене на позицию, средняя считается по двум ценам. */
const BASE_SUPPLIERS: Array<[string, string, string, number]> = [
  ['sup-e2e-v2-a', 'ООО МеталлТорг Гамма', 'sales@metalltorg-gamma.test', 62_500],
  ['sup-e2e-v2-b', 'ООО Арматурный Двор Дельта', 'info@armdvor-delta.test', 63_100],
];
const BASE_AVERAGE = '62 800 ₽';

/** Страницы веб-поиска: три кандидата, у двух есть цена за тонну. */
const HOST_RICH = 'metallbaza.test';
const HOST_TWO = 'stroysnab.test';
const HOST_BARE = 'forum.test';
const TITLE_RICH = 'Арматура А500С d12 купить оптом - МеталлБаза';
const TITLE_TWO = 'Арматура А500С d12 со склада - СтройСнаб';
const TITLE_BARE = 'Арматура А500С d12 обсуждение на форуме';
/** Названия компаний: после этапа 108 кандидат называется компанией, а не заголовком выдачи. */
const NAME_RICH = 'МеталлБаза';
const NAME_TWO = 'СтройСнаб';
const NAME_BARE = 'Форум Металл';
const CLASSIFIER_MARK = 'отобрать поставщиков из выдачи';
const PHONE_RICH = '+7 (843) 200-11-22';
const EMAIL_RICH = 'sales@metallbaza.test';
const PHONE_TWO = '+7 (4822) 33-44-55';
const PAGES: WebSearchHit[] = [
  {
    title: TITLE_RICH,
    url: `https://${HOST_RICH}/armatura`,
    snippet:
      'Арматура А500С d12 от 61 800 руб. за тонну, Казань. Срок изготовления 3-5 дней. ' +
      `Телефон ${PHONE_RICH}, ${EMAIL_RICH}.`,
  },
  {
    title: TITLE_TWO,
    url: `https://${HOST_TWO}/a500`,
    snippet:
      'Арматура А500С d12, цена 64 000 руб. за тонну, Тверь, доставка 7 дней. ' +
      `Тел. ${PHONE_TWO}.`,
  },
  {
    title: TITLE_BARE,
    url: `https://${HOST_BARE}/topic`,
    snippet: 'Арматура А500С d12: кто что посоветует? Обсуждаем марки и ГОСТы.',
  },
];
const WEB_AVERAGE = '62 900 ₽/т';

/** Сырые данные страниц, которые модель не должна видеть в исходном виде. */
const PII: PiiSet = {
  names: [USER_NAME.name, USER_NAME.lastName],
  phones: [PHONE_RICH, PHONE_TWO],
  emails: [EMAIL_RICH],
};

/** Запросы модели запросов: ответ задаёт сценарий. */
const PLANNED_QUERIES = ['арматура А500С d12 купить оптом', 'арматура А500С d12 цена за тонну'];
const PLANNER_MARK = 'искать поставщиков в интернете';
const ENRICHER_MARK = 'достаёшь';
/**
 * Этап 179: askManagerToChoose заканчивает ход сам (endsTurn), итога модели нет. Ждём то, что
 * показал код: вопрос менеджеру «Кому готовить запросы?» (второе сообщение после шорт-листа).
 */
const SHOWN_TEXT = 'Кому готовить запросы?';
/** Запрос обогащения: поиск по сайту кандидата (этап 108), а не по заголовку выдачи. */
const ENRICH_SITE_QUERY = 'site:metallbaza.test контакты';

type PlannerMode = 'queries' | 'garbage';
type EnrichMode = 'rich' | 'empty' | 'one';
let plannerMode: PlannerMode = 'queries';
let enrichMode: EnrichMode = 'rich';

/** Веб-поиск в памяти, который запоминает запросы: так видно, что искал агент. */
class RecordingWebSearch extends MemoryWebSearch {
  readonly queries: string[] = [];

  override async search(
    query: string,
    limit: number,
    options?: WebSearchOptions,
  ): Promise<WebSearchHit[]> {
    this.queries.push(query);
    return super.search(query, limit, options);
  }
}

const stub = new DualLlmStub();
let db: PgClient;
let rules = '';
const worlds: BitrixWorld[] = [];

interface Tail {
  tool: string | null;
  result: unknown;
}

function parsed(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function tailOf(body: Record<string, unknown>): Tail {
  const messages = Array.isArray(body['messages']) ? body['messages'] : [];
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      if (isRecord(block) && block['type'] === 'tool_use') {
        names.set(String(block['id']), String(block['name']));
      }
    }
  }
  for (const block of [...blocksOf(messages.at(-1))].reverse()) {
    if (!isRecord(block) || block['type'] !== 'tool_result') continue;
    return {
      tool: names.get(String(block['tool_use_id'])) ?? '?',
      result: parsed(block['content']),
    };
  }
  return { tool: null, result: null };
}

function field(result: unknown, name: string): unknown {
  return isRecord(result) ? result[name] : undefined;
}

function requestIdOf(body: Record<string, unknown>): string {
  const id = field(toolResults(body).get('saveIntakeRequest')?.at(-1), 'requestId');
  if (typeof id !== 'string') throw new Error('в истории нет результата saveIntakeRequest');
  return id;
}

/** Поля формы «прочее» из реплики сотрудника. */
function valuesOf(text: string): Record<string, string> {
  const product = /Нужна ([^,]+),/u.exec(text)?.[1];
  const quantity = /, (\d+) м/u.exec(text)?.[1];
  const deadline = /срок до ([^.]+)\./u.exec(text)?.[1];
  const link = /https?:\/\/\S+/u.exec(text)?.[0];
  return {
    ...(product === undefined ? {} : { product }),
    ...(quantity === undefined ? {} : { quantity }),
    ...(deadline === undefined ? {} : { deadline }),
    ...(link === undefined ? {} : { task_link: link }),
  };
}

/** Содержимое пользовательского сообщения «<<<...>>>» вызова вспомогательной модели. */
function helperPayload(body: Record<string, unknown>): Record<string, unknown> {
  const text = userTexts(body).find((item) => item.includes('<<<')) ?? '';
  const json = /<<<([\s\S]*)>>>/u.exec(text)?.[1] ?? '{}';
  const value: unknown = JSON.parse(json);
  return isRecord(value) ? value : {};
}

/** Первый токен вида `[PHONE_n]`/`[EMAIL_n]` среди текстов страницы; нет - undefined. */
function tokenIn(texts: unknown, kind: string): string | undefined {
  const joined = Array.isArray(texts) ? texts.join('\n') : '';
  return new RegExp(`\\[${kind}_\\d+\\]`, 'u').exec(joined)?.[0];
}

/** Ответ модели запросов. */
function plannerReply(): string {
  if (plannerMode === 'garbage') return 'запросы не нужны, ищите сами';
  return JSON.stringify({ queries: PLANNED_QUERIES });
}

/** Ответ классификатора выдачи: все три сайта нужны, названия - компании. */
function classifierReply(payload: Record<string, unknown>): string {
  const names: Record<string, string> = {
    [HOST_RICH]: NAME_RICH,
    [HOST_TWO]: NAME_TWO,
    [HOST_BARE]: NAME_BARE,
  };
  const hits = Array.isArray(payload['hits']) ? payload['hits'] : [];
  const results = hits.flatMap((hit) => {
    const domain = isRecord(hit) ? String(hit['domain']) : '';
    const company = names[domain];
    return company === undefined ? [] : [{ domain, relevant: true, type: 'оптовик', company }];
  });
  return JSON.stringify({ results });
}

/** Ответ модели-обогатителя по странице: контакты приходят токенами, код их восстановит. */
function enricherReply(page: Record<string, unknown>): string {
  const url = String(page['url']);
  if (enrichMode === 'empty') return '{}';
  if (url.includes(HOST_RICH)) {
    return JSON.stringify({
      city: 'Казань',
      phone: tokenIn(page['texts'], 'PHONE'),
      email: tokenIn(page['texts'], 'EMAIL'),
      site: `https://${HOST_RICH}`,
      leadTime: '3-5 дней',
      price: { amount: 61_800, currency: 'RUB', unit: 'т' },
    });
  }
  if (url.includes(HOST_TWO) && enrichMode === 'rich') {
    return JSON.stringify({
      city: 'Тверь',
      phone: tokenIn(page['texts'], 'PHONE'),
      leadTime: '7 дней',
      price: { amount: 64_000, currency: 'RUB', unit: 'т' },
    });
  }
  return '{}';
}

/** Ход «модели» агента «Поиск поставщика» и вспомогательных вызовов (по системному промпту). */
const script: DualHandler = ({ model, raw, body }) => {
  if (model !== ORDER_CALC_MODEL) throw new Error(`неизвестная модель ${model}`);
  if (raw.includes(PLANNER_MARK) && !raw.includes('"tools"')) {
    return { kind: 'text', text: plannerReply() };
  }
  if (raw.includes(CLASSIFIER_MARK) && !raw.includes('"tools"')) {
    return { kind: 'text', text: classifierReply(helperPayload(body)) };
  }
  if (raw.includes(ENRICHER_MARK) && !raw.includes('"tools"')) {
    return { kind: 'text', text: enricherReply(helperPayload(body)) };
  }
  const tail = tailOf(body);
  if (tail.tool === null) {
    return { kind: 'tool', name: 'saveIntakeRequest', input: { source: 'text', items: [ITEM] } };
  }
  const requestId = (): string => requestIdOf(body);
  switch (tail.tool) {
    case 'saveIntakeRequest': {
      const asked = userTexts(body).find((text) => text.includes(ASK_MARK)) ?? '';
      return {
        kind: 'tool',
        name: 'checkRequestCompleteness',
        input: { requestId: requestId(), kind: 'other', values: valuesOf(asked) },
      };
    }
    case 'checkRequestCompleteness':
      // Проверка полноты - только подсказка (этап 140): поиск идёт сразу, без разрешения.
      return { kind: 'tool', name: 'searchKnowledgeSuppliers', input: { requestId: requestId() } };
    case 'searchKnowledgeSuppliers':
      return { kind: 'tool', name: 'searchWeb', input: { requestId: requestId() } };
    case 'searchWeb':
      return { kind: 'tool', name: 'buildShortlist', input: { requestId: requestId() } };
    case 'buildShortlist':
      return {
        kind: 'tool',
        name: 'askManagerToChoose',
        input: { requestId: requestId(), version: String(field(tail.result, 'version')) },
      };
    case 'askManagerToChoose':
      // Этап 179: ход заканчивает сам инструмент, до этого шага модель не доходит.
      return { kind: 'text', text: 'Шорт-лист показан.' };
    default:
      return { kind: 'text', text: `Неожиданный результат инструмента ${tail.tool}` };
  }
};

/** Поставщики базы с прайсом на позицию заявки. */
async function seedBase(): Promise<void> {
  const suppliers = new PostgresSupplierRepository(db);
  const prices = new PostgresPriceRepository(db);
  for (const [id, name, email, price] of BASE_SUPPLIERS) {
    await suppliers.upsert({ id, name, email });
    await prices.saveImport(
      id,
      [
        {
          supplierId: id,
          productName: ITEM.name,
          price,
          currency: 'RUB',
          date: '2026-09-01',
        },
      ],
      `e2e-v2-${id}`,
    );
  }
}

/** Мир с приёмом заявок, проверкой полноты и веб-поиском в памяти. */
async function start(web: RecordingWebSearch): Promise<BitrixWorld> {
  const world = await startBitrixWorld({
    rules,
    flags: { intake: true },
    env: { ORDER_CALC_COMPLETENESS_ENABLED: 'true', WEB_SEARCH_MODEL_ENABLED: 'true' },
    external: { webSearch: web },
  });
  worlds.push(world);
  world.portal.addUser({ id: USER, ...USER_NAME });
  return world;
}

/** Заявка сотрудника: форма «прочее» заполнена, ссылка на задачу есть. */
async function placeOrder(world: BitrixWorld): Promise<string> {
  const link = `http://${world.portal.host}/company/personal/user/1/tasks/task/view/${TASK_ID}/`;
  const employee = world.employee(USER);
  await employee.say(
    BOT_ORDERS,
    `${ASK_MARK} А500С d12, ${ITEM.quantity} м, срок до 30 ноября. Задача: ${link}`,
  );
  await employee.waitText(BOT_ORDERS, (text) => text.includes('Шорт-лист поставщиков'));
  await employee.waitText(BOT_ORDERS, SHOWN_TEXT);
  // Этап 113: вводный текст и карточки из вложения.
  return employee.shortlistText(BOT_ORDERS);
}

/** Строки поставщика в шорт-листе: от «Поставщик: <название>» до следующего пункта. */
function blockOf(shortlist: string, title: string): string[] {
  const lines = shortlist.split('\n');
  const at = lines.findIndex((line) => line.includes(`Поставщик: ${title}`));
  if (at < 0) throw new Error(`в шорт-листе нет поставщика «${title}»`);
  const next = lines.findIndex((line, index) => index > at && line.includes('Поставщик: '));
  return lines.slice(at, next < 0 ? undefined : next);
}

/** Строка сообщения, содержащая `prefix` (перед заголовком средней стоит BB-код `[B]`). */
function lineWith(text: string, prefix: string): string | undefined {
  return text.split('\n').find((line) => line.includes(prefix));
}

/** Тела запросов к вспомогательной модели (без инструментов): по метке в системном промпте. */
function helperBodies(mark: string): string[] {
  return stub.bodies().filter((raw) => raw.includes(mark) && !raw.includes('"tools"'));
}

/** Последний результат инструмента в истории последнего хода агента. */
function lastAgentResult(name: string): unknown {
  const raw = [...stub.bodies()].reverse().find((item) => item.includes('"tools"')) ?? '{}';
  return toolResults(JSON.parse(raw) as Record<string, unknown>).get(name)?.at(-1);
}

async function expectClean(world: BitrixWorld): Promise<void> {
  expect(stub.errors).toEqual([]);
  await expectNoLeaks({
    llm: stub.bodies(),
    logs: world.logs,
    portal: world.portal,
    db,
    pii: PII,
    forbiddenTexts: [],
  });
}

beforeAll(async () => {
  db = openDb();
  stub.start(e2eEnv().llmPort);
  rules = await writeBitrixRules(RULES_NAME, {
    [ORDER_CALC_AGENT_ID]: { users: [String(USER)] },
  });
});

beforeEach(async () => {
  plannerMode = 'queries';
  enrichMode = 'rich';
  await resetHandoffTables(db);
  stub.begin(script);
});

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.dispose();
});

afterAll(async () => {
  await resetHandoffTables(db);
  await db.close();
  await stub.stop();
});

describe('v2a: запросы строит модель, кандидаты обогащены, две средние', () => {
  test('город, контакты, цена и срок с сайта; средние по базе и по интернету', async () => {
    await seedBase();
    const web = new RecordingWebSearch(PAGES);
    const world = await start(web);
    const shortlist = await placeOrder(world);
    // Этап 113: ушли карточки (вложение с GRID и разделителями) и файл Excel шорт-листа.
    const cardBlocks = world.employee(USER).attachBlocks(BOT_ORDERS);
    expect(cardBlocks.some((block) => 'GRID' in block)).toBe(true);
    expect(cardBlocks.some((block) => 'DELIMITER' in block)).toBe(true);
    const xlsx = await world.employee(USER).waitShortlistFile(BOT_ORDERS);
    expect(xlsx.name).toMatch(SHORTLIST_FILE_NAME);
    expect(new TextDecoder().decode(xlsx.bytes.slice(0, 2))).toBe('PK');

    // Запросы построила модель по полям формы; веб-поиск искал именно по ним, а не по
    // названию позиции; поля формы (вид «прочее», тираж, срок) ушли планировщику.
    expect(web.queries.slice(0, PLANNED_QUERIES.length)).toEqual(PLANNED_QUERIES);
    const planner = helperPayload(JSON.parse(helperBodies(PLANNER_MARK)[0] ?? '{}'));
    expect(planner['kind']).toBe('other');
    expect(JSON.stringify(planner['fields'])).toContain('30 ноября');
    // Обогащение: отдельный поиск по названию кандидата (платный, под общим лимитом).
    expect(web.queries).toContain(ENRICH_SITE_QUERY);

    // Две средние стоят перед списком: по базе - по двум ценам (порога в три цены нет),
    // по интернету - по ценам обогащённых кандидатов, каждая подписана числом цен.
    const base = lineWith(shortlist, 'Средняя цена по нашей');
    const internet = lineWith(shortlist, 'Средняя цена по инт');
    expect(base).toContain(BASE_AVERAGE);
    expect(base).toContain('2 поставщика');
    expect(internet).toContain(WEB_AVERAGE);
    expect(internet).toContain('2 поставщика');
    expect(shortlist).not.toContain('Недостаточно цен');

    // Кандидат с полной страницей: город, контакты юрлица (восстановленные), цена, срок.
    const rich = blockOf(shortlist, NAME_RICH).join('\n');
    expect(rich).toContain('Город: Казань');
    expect(rich).toContain(`Контакты: тел. ${PHONE_RICH}, ${EMAIL_RICH}, https://${HOST_RICH}`);
    expect(rich).toContain('Стоимость: 61 800 ₽/т (НДС не указан) (ИЗ ИНТЕРНЕТА)');
    expect(rich).toContain('Срок: 3-5 дней');
    const two = blockOf(shortlist, NAME_TWO).join('\n');
    expect(two).toContain('Город: Тверь');
    expect(two).toContain(`Контакты: тел. ${PHONE_TWO}`);
    expect(two).toContain('Срок: 7 дней');
    // Страница без сведений: везде «нет данных», цена в среднюю не входит.
    const bare = blockOf(shortlist, NAME_BARE).join('\n');
    expect(bare).toContain('Стоимость: нет данных');
    expect(bare).toContain(`Сайт: https://${HOST_BARE}/topic`);

    // Модель агента видит только статусы и числа, а не цены и контакты.
    const built = lastAgentResult('buildShortlist');
    expect(field(built, 'marketStatus')).toBe('ok');
    expect(field(built, 'pricesFound')).toBe(2);
    expect(field(built, 'webMarketStatus')).toBe('ok');
    expect(field(built, 'webPricesFound')).toBe(2);
    expect(JSON.stringify(built)).not.toContain(PHONE_RICH);
    // Телефоны и почта со страниц вспомогательной модели ушли токенами.
    const enrichBodies = helperBodies(ENRICHER_MARK).join('\n');
    expect(enrichBodies).toMatch(/\[PHONE_\d+\]/u);
    await expectClean(world);
  });
});

describe('v2b: модель запросов не помогла', () => {
  test('мусорный ответ - запасной путь: запрос по названию позиции', async () => {
    plannerMode = 'garbage';
    const web = new RecordingWebSearch(PAGES);
    const world = await start(web);
    await placeOrder(world);
    const first = web.queries[0] ?? '';
    expect(first).toContain(ITEM.name);
    expect(PLANNED_QUERIES).not.toContain(first);
    await expectClean(world);
  });
});

describe('v2c: цен нет нигде', () => {
  test('обе средние «нет данных», у веб-кандидатов «нет данных»', async () => {
    enrichMode = 'empty';
    const web = new RecordingWebSearch(PAGES);
    const world = await start(web);
    const shortlist = await placeOrder(world);
    expect(shortlist).toContain('Средняя цена по нашей базе:[/B] нет данных');
    expect(shortlist).toContain('Средняя цена по интернету:[/B] нет данных');
    expect(shortlist).not.toContain('Недостаточно цен');
    const block = blockOf(shortlist, NAME_RICH).join('\n');
    expect(block).toContain('Стоимость: нет данных');
    const built = lastAgentResult('buildShortlist');
    expect(field(built, 'marketStatus')).toBe('none');
    expect(field(built, 'webMarketStatus')).toBe('none');
    expect(field(built, 'webPricesFound')).toBe(0);
    await expectClean(world);
  });
});

describe('v2d: одна цена с сайта', () => {
  test('среднее по интернету считается по одной цене, по базе - «нет данных»', async () => {
    enrichMode = 'one';
    const web = new RecordingWebSearch(PAGES);
    const world = await start(web);
    const shortlist = await placeOrder(world);
    const internet = lineWith(shortlist, 'Средняя цена по инт');
    expect(internet).toContain('61 800 ₽/т (1 поставщик)');
    expect(shortlist).toContain('Средняя цена по нашей базе:[/B] нет данных');
    expect(field(lastAgentResult('buildShortlist'), 'webPricesFound')).toBe(1);
    await expectClean(world);
  });
});
