import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { MemoryWebPageReader, MemoryWebSearch, type PgClient } from '@business-ai/adapters';
import { PostgresPriceRepository } from '../../src/kit/adapters/postgres/price-repository';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import { ORDER_CALC_AGENT_ID } from '../../src/agents/order-calc/deps';
import type { SupplierCard } from '../../src/kit/domain/supplier-card';
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
 * Сценарий «Татьяна» (этап 108, тема 6): жалобы боевого теста `order/2486` одним проходом.
 * Боевая сборка на заглушке портала Bitrix24 (задача с текстом, чатом и фото), настоящие
 * pseudonymizer и pii-guard; веб-поиск и чтение сайтов - страницы в памяти, модель - скрипт.
 *
 *  1. Ссылка на задачу -> агент читает задачу и чат -> поиск сразу (этап 140: проверка полноты
 *     поиск не блокирует) и ОДИН вопрос (код, «Уже понял: ...») под итогом поиска;
 *  2. ответ «бюджет - самая дешёвая, персонализация будет позже» -> без второго вопроса и без
 *     повторного поиска;
 *  3. шорт-лист: сначала поставщики нашей базы (прайсы мёда и орехов, карточка «Медовый дом»),
 *     затем веб-компании без площадок, зарубежья и тары; у каждой веб-компании заполнено хотя
 *     бы одно из город/контакты/цена;
 *  4. итоговое сообщение собрано из чисел buildShortlist и совпадает с шорт-листом;
 *  5. расход платных вызовов (поиск и чтение сайтов) на заявку фиксируется числом.
 */

const USER = 1001;
const USER_NAME = { name: 'Татьяна', lastName: 'Воронцова' };
const TASK_ID = 108;
const TASK_CHAT_ID = 2486;
const RULES_NAME = 'z-order-tatyana-search-quality';
const ASK_MARK = 'Нужен расчёт по задаче';
const ANSWER_MARK = 'самая дешёвая цена';
const FINAL_MARK = 'Итог поиска';
/** Начало строки о недостающем под шорт-листом (собирает код, shortlist-message.ts). */
const REMINDER_MARK = 'Для точного письма поставщику можно добавить:';
const ANSWER_ACCEPTED = 'Данные дополнены.';
/** Фраза о непрочитанных фото: строит код (photo-hint.ts), один раз на заявку (этап 189). */
const PHOTO_HINT_MARK = 'В задаче есть фото, которые я не смог прочитать';

const ITEMS = [
  { name: 'Мёд в банках', quantity: 30, unit: 'шт' },
  { name: 'Орехи в банках', quantity: 30, unit: 'шт' },
];
/** Ответ сотрудника: бюджет назван, персонализация отложена, тираж подтверждён. */
const ANSWER =
  `Бюджет - ${ANSWER_MARK}, персонализация будет позже, тираж верно.`;

/** Задача портала: текст, два сообщения чата и одно фото. */
const TASK_TITLE = 'Подарочные наборы: мёд и орехи в банках';
const TASK_DESCRIPTION =
  'Нужны подарочные наборы. Мёд в банках - 30 шт. Орехи в банках - 30 шт. ' +
  'Готово к 20 декабря. Фото банок во вложении.';
const CHAT_DIMENSIONS = 'Банки стеклянные на 250 мл, высота 9 см, крышка металлическая.';
const CHAT_SAMPLE = 'Образец нужен до заказа, пришлите один набор.';
const PHOTO_NAME = 'банки.jpg';

/** Поставщики базы: прайсы мёда и орехов и карточка без прайса. */
const BASE_HONEY = 'Пасека Липовая';
const BASE_NUTS = 'Кедровый Бор';
const BASE_CARD = 'Медовый дом Деликатесы';
const BASE_NOISE = 'Стеклодув';
const BASE_ORDER = [BASE_HONEY, BASE_NUTS, BASE_CARD];

/**
 * Домены выдачи: настоящие компании - свои домены из двух меток (регистрируемый домен
 * `x.example.test` у всех один, а склейка идёт по нему).
 */
const HOST_HONEY = 'medovar-opt.test';
const HOST_NUTS = 'orehovaya-lavka.test';
const HOST_PASEKA = 'paseka-dar.test';
const HOST_JARS = 'banki-opt.test';
const HOST_FORUM = 'forum-pchelovodov.test';
const WEB_NAMES = ['Медовар', 'Ореховая лавка', 'Пасека Дар'];
const PHONE_HONEY = '+7 (495) 100-20-30';
const EMAIL_HONEY = 'sales@medovar-opt.test';
const PHONE_NUTS = '+7 (812) 300-40-50';

/** Выдача: компании, дубль домена, площадки, зарубежье, тара и форум. */
const HITS: WebSearchHit[] = [
  {
    title: 'Медовар - мёд оптом от производителя, цена от 380 руб. за банку',
    url: `https://${HOST_HONEY}/opt`,
    snippet: 'Мёд оптом в банках, фасовка, подарочные наборы. Москва, контакты на сайте.',
  },
  {
    title: 'Медовар: мёд в банках 250 мл оптом...',
    url: `https://${HOST_HONEY}/banki`,
    snippet: 'Мёд в банках 250 мл оптом от пасеки, контакты и цены.',
  },
  {
    title: 'Ореховая лавка - орехи в банках оптом',
    url: `https://${HOST_NUTS}/`,
    snippet:
      'Орехи в банках оптом, Санкт-Петербург, цена от 520 руб. за банку, контакты ' +
      `${PHONE_NUTS}.`,
  },
  {
    title: 'Пасека Дар - мёд и орехи в подарочных банках',
    url: `https://${HOST_PASEKA}/catalog`,
    snippet: 'Мёд и орехи в банках для подарков, контакты, доставка по России.',
  },
  {
    title: 'Мёд в банках купить на OZON',
    url: 'https://www.ozon.ru/category/med/',
    snippet: 'Мёд в банках, контакты продавцов, цены.',
  },
  {
    title: 'Орехи в банках - Яндекс Маркет',
    url: 'https://market.yandex.ru/catalog/orehi',
    snippet: 'Орехи в банках, контакты магазинов, сравнить цены.',
  },
  {
    title: 'Мёд в банках оптом Киев',
    url: 'https://prom.ua/medu',
    snippet: 'Мёд в банках оптом, контакты, Киев.',
  },
  {
    title: 'Мёд оптом Казахстан',
    url: 'https://magnumopt.kz/med',
    snippet: 'Мёд в банках оптом, контакты, Алматы.',
  },
  {
    title: 'Стеклянные банки для мёда и орехов оптом',
    url: `https://${HOST_JARS}/`,
    snippet: 'Банки стеклянные для мёда, орехов, контакты, оптовые цены на тару.',
  },
  {
    title: 'Какой мёд лучше брать в банках - форум пчеловодов',
    url: `https://${HOST_FORUM}/topic/1`,
    snippet: 'Обсуждаем мёд в банках, орехи, контакты фасовщиков.',
  },
];
/** Домены, которых в шорт-листе быть не должно (ссылки) и их названия-заголовки. */
const EXCLUDED_MARKERS = ['ozon', 'market.yandex', 'prom.ua', 'magnumopt', HOST_JARS, HOST_FORUM];

/** Страницы сайтов для чтения: у «Медовара» полные, у «Пасеки Дар» - только город. */
const PAGES: Record<string, Array<{ url: string; text: string; title?: string }>> = {
  [HOST_HONEY]: [
    {
      url: `https://${HOST_HONEY}/contacts`,
      title: 'Контакты Медовар',
      text:
        'ООО Медовар, Москва. Телефон отдела продаж ' +
        `${PHONE_HONEY}, почта ${EMAIL_HONEY}. Мёд липовый в банках 250 мл от 380 руб.`,
    },
  ],
  [HOST_PASEKA]: [
    {
      url: `https://${HOST_PASEKA}/`,
      title: 'Пасека Дар',
      text: 'Пасека Дар, город Тула. Мёд и орехи в подарочных банках.',
    },
  ],
};

const PII: PiiSet = {
  names: [USER_NAME.name, USER_NAME.lastName],
  phones: [PHONE_HONEY, PHONE_NUTS],
  emails: [EMAIL_HONEY],
};

/** Метки системных промптов вспомогательных вызовов модели. */
const PLANNER_MARK = 'искать поставщиков в интернете';
const CLASSIFIER_MARK = 'отобрать поставщиков из выдачи';
const ENRICHER_MARK = 'достаёшь';
const PLANNED_QUERIES = [
  'мёд в банках оптом производитель',
  'орехи в банках оптом',
  'подарочные наборы мёд орехи опт',
];

/** Веб-поиск в памяти, который считает платные обращения и запоминает запросы. */
class CountingWebSearch extends MemoryWebSearch {
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
/** Номер заявки: в новом ходе результата saveIntakeRequest в истории уже нет. */
let savedRequestId = '';

function parsed(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

interface Tail {
  tool: string | null;
  result: unknown;
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

/** Содержимое пользовательского сообщения «<<<...>>>» вызова вспомогательной модели. */
function helperPayload(body: Record<string, unknown>): Record<string, unknown> {
  const text = userTexts(body).find((item) => item.includes('<<<')) ?? '';
  const json = /<<<([\s\S]*)>>>/u.exec(text)?.[1] ?? '{}';
  const value: unknown = JSON.parse(json);
  return isRecord(value) ? value : {};
}

function tokenIn(texts: unknown, kind: string): string | undefined {
  const joined = Array.isArray(texts) ? texts.join('\n') : '';
  return new RegExp(`\\[${kind}_\\d+\\]`, 'u').exec(joined)?.[0];
}

/** Вердикты классификатора по доменам выдачи (код отсеял площадки и зарубежье до вызова). */
function classifierReply(payload: Record<string, unknown>): string {
  const hits = Array.isArray(payload['hits']) ? payload['hits'] : [];
  const results = hits.flatMap((hit) => {
    const domain = isRecord(hit) ? String(hit['domain']) : '';
    const verdicts: Record<string, Record<string, unknown>> = {
      [HOST_HONEY]: { relevant: true, type: 'производитель', company: WEB_NAMES[0] },
      [HOST_NUTS]: { relevant: true, type: 'оптовик', company: WEB_NAMES[1] },
      [HOST_PASEKA]: { relevant: true, type: 'магазин', company: WEB_NAMES[2] },
      [HOST_JARS]: { relevant: false, type: 'тара', company: 'Банки Опт' },
      [HOST_FORUM]: { relevant: false, type: 'прочее', company: null },
    };
    const verdict = verdicts[domain];
    return verdict === undefined ? [] : [{ domain, ...verdict }];
  });
  return JSON.stringify({ results });
}

/** Сведения со страницы: контакты приходят токенами, код их восстановит. */
function enricherReply(page: Record<string, unknown>): string {
  const url = String(page['url']);
  const texts = page['texts'];
  if (url.includes(HOST_HONEY)) {
    return JSON.stringify({
      city: 'Москва',
      phone: tokenIn(texts, 'PHONE'),
      email: tokenIn(texts, 'EMAIL'),
      site: `https://${HOST_HONEY}`,
      price: { amount: 380, currency: 'RUB', unit: 'шт' },
    });
  }
  if (url.includes(HOST_NUTS)) {
    return JSON.stringify({
      city: 'Санкт-Петербург',
      phone: tokenIn(texts, 'PHONE'),
      price: { amount: 520, currency: 'RUB', unit: 'шт' },
    });
  }
  if (url.includes(HOST_PASEKA)) return JSON.stringify({ city: 'Тула' });
  return '{}';
}

/** Что сообщила модель после buildShortlist: числа берутся из ответа инструмента. */
function finalText(built: unknown): string {
  const shown = Number(field(built, 'baseSuppliersShown'));
  const withPrice = Number(field(built, 'baseSuppliersWithPrice'));
  const hints = Number(field(built, 'documentHints'));
  return `${FINAL_MARK}: из нашей базы ${shown} (с ценой ${withPrice}), документов ${hints}.`;
}

/** Результат чтения задачи, сохранённый в первом ходе, для фразы о фото. */
let readResult: unknown = null;
/** Ответ buildShortlist, который видела модель: из него строится сверка итога с показом. */
let builtResult: unknown = null;

const script: DualHandler = ({ model, raw, body }) => {
  if (model !== ORDER_CALC_MODEL) throw new Error(`неизвестная модель ${model}`);
  const helper = !raw.includes('"tools"');
  if (helper && raw.includes(PLANNER_MARK)) {
    return { kind: 'text', text: JSON.stringify({ queries: PLANNED_QUERIES }) };
  }
  if (helper && raw.includes(CLASSIFIER_MARK)) {
    return { kind: 'text', text: classifierReply(helperPayload(body)) };
  }
  if (helper && raw.includes(ENRICHER_MARK)) {
    return { kind: 'text', text: enricherReply(helperPayload(body)) };
  }
  const tail = tailOf(body);
  const asked = userTexts(body).find((text) => text.includes(ASK_MARK)) ?? '';
  const link = /https?:\/\/\S+/u.exec(asked)?.[0] ?? '';
  const answered = userTexts(body).some((text) => text.includes(ANSWER_MARK));
  const requestId = savedRequestId;
  if (tail.tool === null) {
    if (answered) {
      // Второй ход: только то, что назвал сотрудник; отложенное идёт в deferred, не в values.
      return {
        kind: 'tool',
        name: 'checkRequestCompleteness',
        input: {
          requestId,
          kind: 'custom_product',
          values: { budget: 'самая дешёвая цена' },
          deferred: ['personalization_tech', 'personalization_size'],
        },
      };
    }
    return { kind: 'tool', name: 'readIntakeSource', input: { link } };
  }
  switch (tail.tool) {
    case 'readIntakeSource':
      readResult = tail.result;
      return {
        kind: 'tool',
        name: 'saveIntakeRequest',
        input: { source: 'task', link, items: ITEMS },
      };
    case 'saveIntakeRequest': {
      const id = field(tail.result, 'requestId');
      if (typeof id !== 'string') {
        throw new Error(`нет requestId: ${JSON.stringify(tail.result).slice(0, 300)}`);
      }
      savedRequestId = id;
      // Значения берутся из текста задачи и её чата; бюджета и персонализации там нет.
      return {
        kind: 'tool',
        name: 'checkRequestCompleteness',
        input: {
          requestId: id,
          kind: 'custom_product',
          values: {
            product: 'Мёд и орехи в банках',
            quantity: '30',
            production_date: 'к 20 декабря',
            dimensions: '250 мл, высота 9 см',
            material_color: 'стекло, металлическая крышка',
            sample: 'да',
            task_link: link,
          },
        },
      };
    }
    case 'checkRequestCompleteness': {
      // Подсказка поиск не блокирует (этап 140). Второй ход: сотрудник дополнил данные, поиск
      // не повторяется, напоминать не о чем.
      if (answered) return { kind: 'text', text: ANSWER_ACCEPTED };
      return { kind: 'tool', name: 'searchKnowledgeSuppliers', input: { requestId } };
    }
    case 'searchKnowledgeSuppliers':
      return { kind: 'tool', name: 'searchWeb', input: { requestId } };
    case 'searchWeb':
      return { kind: 'tool', name: 'buildShortlist', input: { requestId } };
    case 'buildShortlist':
      builtResult = tail.result;
      return {
        kind: 'tool',
        name: 'askManagerToChoose',
        input: { requestId, version: String(field(tail.result, 'version')) },
      };
    case 'askManagerToChoose': {
      // Этап 179: askManagerToChoose заканчивает ход сам (endsTurn), до этого шага модель не
      // доходит; ветка оставлена как страховка на случай продолжения хода.
      const raws = [...stub.bodies()].reverse();
      const last = raws.find((item) => item.includes('"tools"')) ?? '{}';
      const built = toolResults(JSON.parse(last) as Record<string, unknown>).get('buildShortlist');
      // Недостающее напоминается один раз, под итогом поиска: вопрос кода как есть; фразу
      // о фото строит код, не модель (этап 189).
      const check = toolResults(JSON.parse(last) as Record<string, unknown>)
        .get('checkRequestCompleteness')
        ?.at(-1);
      const question = String(field(check, 'question') ?? '');
      return { kind: 'text', text: `${finalText(built?.at(-1))}\n\n${question}`.trim() };
    }
    default:
      return { kind: 'text', text: `Неожиданный результат инструмента ${tail.tool}` };
  }
};

function card(id: string, name: string): SupplierCard {
  return {
    id,
    name,
    status: 'new',
    contacts: [],
    supplies: { categories: [], brands: [], regions: [] },
    terms: {},
    notes: [],
  };
}

/** Синтетическая база: два поставщика с прайсами, карточка без прайса и «шум» про стекло. */
async function seedBase(): Promise<void> {
  const suppliers = new PostgresSupplierRepository(db);
  const prices = new PostgresPriceRepository(db);
  const price = async (id: string, name: string, productName: string, amount: number) => {
    await suppliers.saveCard(card(id, name));
    await prices.saveImport(
      id,
      [{ supplierId: id, productName, price: amount, currency: 'RUB', date: '2026-09-01' }],
      `e2e-108-${id}`,
    );
  };
  await price('sup-e2e-108-honey', BASE_HONEY, 'Мёд липовый 0,5 кг', 400);
  await price('sup-e2e-108-nuts', BASE_NUTS, 'Лесной орех очищенный', 900);
  await price('sup-e2e-108-noise', BASE_NOISE, 'Медаль из стекла', 100);
  await suppliers.saveCard(card('sup-e2e-108-house', BASE_CARD));
}

interface Spend {
  searches: number;
  siteSearches: number;
  fetches: number;
}

let web: CountingWebSearch;
let reader: MemoryWebPageReader;

async function start(): Promise<BitrixWorld> {
  const world = await startBitrixWorld({
    rules,
    flags: { intake: true },
    env: { ORDER_CALC_COMPLETENESS_ENABLED: 'true', WEB_SEARCH_MODEL_ENABLED: 'true' },
    external: { webSearch: web, webPageReader: reader },
  });
  worlds.push(world);
  world.portal.addUser({ id: USER, ...USER_NAME });
  world.portal.addTask({
    id: TASK_ID,
    title: TASK_TITLE,
    description: TASK_DESCRIPTION,
    createdBy: USER,
    responsibleId: USER,
    chatId: TASK_CHAT_ID,
    files: [PHOTO_NAME],
  });
  world.portal.addTaskChatMessage(TASK_ID, { text: CHAT_DIMENSIONS, authorId: USER });
  world.portal.addTaskChatMessage(TASK_ID, { text: CHAT_SAMPLE, authorId: USER });
  return world;
}

function spendOf(): Spend {
  const siteSearches = web.queries.filter((query) => query.startsWith('site:')).length;
  return {
    searches: web.queries.length,
    siteSearches,
    fetches: reader.calls.length,
  };
}

/** Тексты бота, содержащие метку. */
function botTexts(world: BitrixWorld, mark: string): string[] {
  return world
    .employee(USER)
    .texts(BOT_ORDERS)
    .filter((text) => text.includes(mark));
}

/** Названия поставщиков шорт-листа в порядке показа. */
function suppliersOf(shortlist: string): string[] {
  return [...shortlist.matchAll(/Поставщик: (.+?) \(/gu)].map((match) => match[1] ?? '');
}

/** Строки блока поставщика: от «Поставщик: <название>» до следующего пункта. */
function blockOf(shortlist: string, name: string): string {
  const lines = shortlist.split('\n');
  const at = lines.findIndex((line) => line.includes(`Поставщик: ${name}`));
  if (at < 0) throw new Error(`в шорт-листе нет поставщика «${name}»`);
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((line) => /^\d+\. Поставщик:/u.test(line));
  return lines.slice(at, end < 0 ? undefined : at + 1 + end).join('\n');
}

beforeAll(async () => {
  db = openDb();
  stub.start(e2eEnv().llmPort);
  rules = await writeBitrixRules(RULES_NAME, {
    [ORDER_CALC_AGENT_ID]: { users: [String(USER)] },
  });
});

beforeEach(async () => {
  savedRequestId = '';
  readResult = null;
  builtResult = null;
  web = new CountingWebSearch(HITS);
  reader = new MemoryWebPageReader(PAGES);
  await resetHandoffTables(db);
  stub.begin(script);
});

afterEach(async () => {
  if (stub.errors.length > 0) console.log('[e2e-108] ошибки скрипта:', stub.errors);
  for (const world of worlds.splice(0)) await world.dispose();
});

afterAll(async () => {
  await resetHandoffTables(db);
  await db.close();
  await stub.stop();
});

describe('Татьяна: один вопрос, база выше веба, итог согласован с шорт-листом', () => {
  test('задача -> вопрос -> «позже» -> шорт-лист -> итог', async () => {
    await seedBase();
    const world = await start();
    const employee = world.employee(USER);
    const link = `http://${world.portal.host}/company/personal/user/1/tasks/task/view/${TASK_ID}/`;

    // Шаг 1: задача прочитана вместе с чатом и фото; поиск не ждёт ответа, шорт-лист и один
    // вопрос о недостающем приходят в одном проходе (этап 140).
    await employee.say(BOT_ORDERS, `${ASK_MARK}: ${link}`);
    await employee.waitText(BOT_ORDERS, (text) => text.includes('Шорт-лист поставщиков'));
    // Этап 179 (+ 87b72512): шорт-лист, вопрос выбора и строку о недостающем («Для точного
    // письма поставщику можно добавить: ...») показывает код, итога модели («Итог поиска» с
    // вопросом «Не хватает», «Уже понял») нет: ждём вопрос кода.
    const question = await employee.waitText(BOT_ORDERS, (text) =>
      text.includes(REMINDER_MARK),
    );
    expect(readResult).toMatchObject({ kind: 'task', imageCount: 1, chatUnavailable: false });
    expect(JSON.stringify(field(readResult, 'comments'))).toContain('250 мл');
    expect(question).toContain('бюджет');
    expect(question).toContain('технология и количество цветов персонализации');
    // Известное из задачи и чата не спрашивается повторно.
    const missing = question.slice(question.indexOf(REMINDER_MARK));
    expect(missing).not.toContain('габариты');
    expect(missing).not.toContain('тираж');
    expect(missing).not.toContain('образец');
    expect(botTexts(world, REMINDER_MARK)).toHaveLength(1);
    // Фразу о фото (imageCount=1, прочитанных нет) показал код отдельной строкой, один раз.
    const photoTexts = botTexts(world, PHOTO_HINT_MARK);
    expect(photoTexts).toHaveLength(1);
    expect(photoTexts[0]?.split('\n\n').at(-2)).toContain(PHOTO_HINT_MARK);
    expect(spendOf()).toEqual(EXPECTED_SPEND);

    // Шаг 2: «персонализация будет позже» закрывает пункт; второго вопроса и нового поиска нет.
    const before = employee.snapshot(BOT_ORDERS);
    await employee.say(BOT_ORDERS, ANSWER);
    await employee.waitText(BOT_ORDERS, ANSWER_ACCEPTED, { since: before });
    expect(botTexts(world, REMINDER_MARK)).toHaveLength(1);
    expect(botTexts(world, PHOTO_HINT_MARK)).toHaveLength(1);
    expect(spendOf()).toEqual(EXPECTED_SPEND);

    // Шаг 3: шорт-лист - сначала база, затем веб-компании.
    const shortlist = world.employee(USER).shortlistText(BOT_ORDERS);
    // Этап 113: ушли карточки (вложение с GRID и разделителями) и файл Excel шорт-листа.
    const cardBlocks = world.employee(USER).attachBlocks(BOT_ORDERS);
    expect(cardBlocks.some((block) => 'GRID' in block)).toBe(true);
    expect(cardBlocks.some((block) => 'DELIMITER' in block)).toBe(true);
    const xlsx = await world.employee(USER).waitShortlistFile(BOT_ORDERS);
    expect(xlsx.name).toMatch(SHORTLIST_FILE_NAME);
    expect(new TextDecoder().decode(xlsx.bytes.slice(0, 2))).toBe('PK');
    const names = suppliersOf(shortlist);
    expect(names.slice(0, BASE_ORDER.length).sort()).toEqual([...BASE_ORDER].sort());
    expect(names.slice(BASE_ORDER.length).sort()).toEqual([...WEB_NAMES].sort());
    expect(shortlist).not.toContain(BASE_NOISE);
    for (const marker of EXCLUDED_MARKERS) expect(shortlist).not.toContain(marker);
    // У каждой веб-компании есть хотя бы город, контакты или цена.
    for (const name of WEB_NAMES) {
      const block = blockOf(shortlist, name);
      const filled = ['Город', 'Контакты', 'Цена'].some(
        (label) => new RegExp(`${label}: (?!не указано)`, 'u').test(block),
      );
      expect(filled).toBe(true);
    }
    expect(blockOf(shortlist, WEB_NAMES[0] ?? '')).toContain(PHONE_HONEY);

    // Шаг 4: итог построен из чисел buildShortlist и совпадает с показом.
    // Этап 179: итога модели в чате нет; числа берём из ответа buildShortlist, как раньше брал
    // модель, и сверяем с тем, что реально показал код.
    const final = finalText(builtResult);
    const baseShown = names.filter((name) => BASE_ORDER.includes(name)).length;
    expect(final).toContain(`из нашей базы ${baseShown} (с ценой 2)`);
    expect(final).toContain('документов 0');

    // Шаг 5: расход платных вызовов на заявку (фиксируется числом).
    const spend = spendOf();
    console.log(`[e2e-108] расход на заявку: ${JSON.stringify(spend)}`);
    expect(web.queries.slice(0, PLANNED_QUERIES.length)).toEqual(PLANNED_QUERIES);
    expect(spend.searches).toBe(PLANNED_QUERIES.length + spend.siteSearches);
    // Поиск `site:` идёт только по кандидатам, у которых страница не закрыла город и контакты.
    expect(spend).toEqual(EXPECTED_SPEND);

    expect(stub.errors).toEqual([]);
    await expectNoLeaks({
      llm: stub.bodies(),
      logs: world.logs,
      portal: world.portal,
      db,
      pii: PII,
      forbiddenTexts: [],
    });
  });
});

/**
 * Расход сценария (зафиксирован намеренно: рост числа платных вызовов должен быть заметен):
 * 3 запроса плана + 2 поиска `site:` (у «Ореховой лавки» сайт не прочитался, у «Пасеки Дар»
 * страница без контактов; у «Медовара» страница закрыла город и контакты - поиска нет) = 5
 * поисков; чтений сайта - по одному на каждую из трёх показанных веб-компаний.
 */
const EXPECTED_SPEND: Spend = { searches: 5, siteSearches: 2, fetches: 3 };
