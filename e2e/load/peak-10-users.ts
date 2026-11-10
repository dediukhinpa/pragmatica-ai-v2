/**
 * Нагрузочный прогон «10 пользователей одновременно написали одному агенту» (этап 239d,
 * решение владельца 11). Запуск и сервисы поднимает `core/scripts/measure/measure-peak-10-users.sh`.
 *
 * Процесс драйвера и есть «app»: настоящая сборка `composeProduction` (рантайм, инструменты,
 * псевдонимизация) на настоящих сервисах documents, pseudonymizer, embeddings, speech и
 * Postgres; модель - скриптовая заглушка, внешние сервисы (портал, vision, веб) не нужны.
 * Ход пользователя = вложение (то, что делает насос чата до рантайма: разбор файла, голос,
 * фото) + ход агента `runtime.run` со скриптом инструментов. Десять ходов стартуют разом.
 *
 * Время ответа 10-го пользователя = максимум времён завершения. Модель отвечает без задержки,
 * поэтому моменты обращения к сервисам совпадают у всех десяти - худший случай.
 *
 * Вывод: одна JSON-строка в stdout (последняя). Только синтетика.
 */
import { readFileSync, statSync } from 'node:fs';
import {
  DEFAULT_CONTRACT_TIMEOUT_MS,
  HttpContractAmender,
} from '../../src/kit/adapters/http/http-contract-amender';
import {
  DEFAULT_DOCUMENTS_RECOGNIZE_TIMEOUT_MS,
  DEFAULT_IMAGE_NORMALIZE_TIMEOUT_MS,
  DEFAULT_IMAGE_TEXT_GATE_TIMEOUT_MS,
  DEFAULT_PARSE_TIMEOUT_MS,
  DocumentsImageMasker,
  HttpDocumentParser,
  HttpImageTextDetector,
  HttpTemplateWorkbook,
  IMAGE_NORMALIZE_ROUTE,
  LocalSpeechToText,
  type PgClient,
} from '@business-ai/adapters';
import { HttpPriceFileEditor } from '../../src/kit/adapters/http/http-price-file-editor';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import { FileSpool } from '@business-ai/adapters';
import { fetchWithDeadline } from '@business-ai/adapters';
import { toRunSpec } from '@business-ai/core';
import { DualLlmStub, type DualHandler } from '@business-ai/testing/e2e';
import { buildApp, e2eEnv, openDb, resetScenarioTables } from '../lib/project-env';
import {
  blocksOf,
  isRecord,
  lastResult,
  userTexts,
  type StubReply,
} from '@business-ai/testing/e2e';
import { BUYER_PII } from '../lib/pii.owned';

// Число пользователей по умолчанию 10 (решение 11); LOAD_USERS=1 - разбор расхода по стадиям.
const USERS = Number(process.env['LOAD_USERS'] ?? 10);
const MIB = 1024 * 1024;
const SAMPLE_MS = 10;
const REQUEST_TIMEOUT_MS = 900_000;
// Общий предел времени сценария (этап 239f): зависший ход или заглушка не держат прогон (а с ним
// flock полных прогонов) бесконечно. Скрипт замера ставит свой `timeout` снаружи с запасом.
const SCENARIO_TIMEOUT_MS = Number(process.env['LOAD_SCENARIO_TIMEOUT_MS'] ?? 1_500_000);
const COLUMNS = { sku: 0, name: 1, price: 2, currency: 3 };
const HEADER_WORD = 'Наименование';
const EDITS_TYPICAL = 200;
const EDITS_HEAVY = 20_000;
const TEMPLATE_EDITS_TYPICAL = 100;
const TEMPLATE_EDITS_HEAVY = 5_000;
const KP_LINES_TYPICAL = 5;
const KP_LINES_HEAVY = 300;
const SEARCH_ITEMS_TYPICAL = 3;
const SEARCH_ITEMS_HEAVY = 25;
const OWN_COMPANY_NAME = 'ООО Прагматика';
const OWN_LINES = ['ИНН 7701001238 КПП 770101001', 'Р/с 40702810712345678901', 'БИК 049900001'];

const [scenario = '', variant = 'typical'] = process.argv.slice(2);
const heavy = variant === 'heavy';
// Цена такая, чтобы итог тяжёлого КП не стал 10-значным числом: ядро принимает его за ИНН
// и отклоняет ход (ложное срабатывание проверки ПДн, не предмет замера).
const KP_UNIT_PRICE = heavy ? 620 : 62_000;
const env = e2eEnv();
const filesDir = `${env.work}/files`;
const docsUrl = env.documentsUrl;
const speechUrl = process.env['LOAD_SPEECH_URL'] ?? '';

// ---------------------------------------------------------------- вспомогательное

/**
 * Трасса по стадиям (LOAD_STAGE_TRACE=1): при каждом обращении к модели - память процесса и
 * пик RssAnon за прошедшую стадию. Осмысленна при LOAD_USERS=1 (десять ходов перемешаны).
 */
const traceStages = process.env['LOAD_STAGE_TRACE'] === '1';
let phase = 'start';
const phasePeaks = new Map<string, number>();
/** Шаг каждого пользователя (сколько результатов инструментов уже в истории): для трассы. */
const userSteps = new Map<number, number>();

function markPhase(label: string): void {
  if (!traceStages) return;
  const usage = process.memoryUsage();
  const anon = statusMib('RssAnon');
  console.error(
    `[stage] ${label} anon=${anon.toFixed(0)} heap=${(usage.heapUsed / MIB).toFixed(0)} ` +
      `ext=${(usage.external / MIB).toFixed(0)} ab=${(usage.arrayBuffers / MIB).toFixed(0)} ` +
      `peak-prev=${(phasePeaks.get(phase) ?? 0).toFixed(0)}`,
  );
  phase = label;
}

const TRACE_TICK_MS = 2000;
let lastTick = 0;
/** Раз в 2 с (LOAD_STAGE_TRACE=timeline): память и сколько пользователей на каком шаге. */
function traceTick(anonNow: number): void {
  const due = Date.now() - lastTick >= TRACE_TICK_MS;
  if (process.env['LOAD_STAGE_TRACE'] !== 'timeline' || !due) return;
  lastTick = Date.now();
  const usage = process.memoryUsage();
  const perStep = new Map<number, number>();
  for (const step of userSteps.values()) perStep.set(step, (perStep.get(step) ?? 0) + 1);
  const steps = [...perStep.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`);
  console.error(
    `[tick] anon=${anonNow.toFixed(0)} heap=${(usage.heapUsed / MIB).toFixed(0)} ` +
      `ext=${(usage.external / MIB).toFixed(0)} ab=${(usage.arrayBuffers / MIB).toFixed(0)} ` +
      `steps=${steps.join(' ')}`,
  );
}

function statusMib(field: string): number {
  const line = readFileSync('/proc/self/status', 'utf8')
    .split('\n')
    .find((item) => item.startsWith(`${field}:`));
  return Number(line?.split(/\s+/)[1] ?? 0) / 1024;
}

/** Номер шага: сколько результатов инструментов уже в истории. */
function stepOf(body: Record<string, unknown>): number {
  const messages = Array.isArray(body['messages']) ? body['messages'] : [];
  let count = 0;
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      if (isRecord(block) && block['type'] === 'tool_result') count += 1;
    }
  }
  return count;
}

/** Номер пользователя по метке `LOADUSER<n>X` в первом сообщении. */
function userOf(body: Record<string, unknown>): number {
  const text = userTexts(body).join('\n');
  const found = /LOADUSER(\d+)X/.exec(text);
  if (found === null) throw new Error('в запросе нет метки пользователя');
  return Number(found[1]);
}

/** Ошибки инструментов в хвосте истории (для отчёта о потерях). */
function lastToolError(body: Record<string, unknown>): string | undefined {
  const messages = Array.isArray(body['messages']) ? body['messages'] : [];
  const last: unknown = messages.at(-1);
  for (const block of blocksOf(last)) {
    if (!isRecord(block) || block['type'] !== 'tool_result') continue;
    const content = JSON.stringify(block['content'] ?? '');
    // Ошибкой считается is_error или результат, начинающийся с {"error": слова внутри текста
    // прайса («превышен», «timeout») ошибкой не являются.
    if (block['is_error'] === true || /^"\{\\"errors?\\"/.test(content)) {
      return content.slice(0, 160);
    }
  }
  return undefined;
}

interface UserResult {
  user: number;
  ok: boolean;
  seconds: number;
  stages: Record<string, number>;
  errors: string[];
}

class Collector {
  readonly toolErrors: string[][] = Array.from({ length: USERS }, () => []);
}
const collector = new Collector();

async function stage<T>(
  result: UserResult,
  name: string,
  work: () => Promise<T>,
  started: number,
): Promise<T | undefined> {
  const begin = Date.now();
  try {
    return await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(`${name}: ${message.slice(0, 140)}`);
    return undefined;
  } finally {
    result.stages[name] = Number(((Date.now() - begin) / 1000).toFixed(1));
    void started;
  }
}

function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

// ---------------------------------------------------------------- сценарии

const priceFile = (user: number): string => `load-${variant}-u${user}.xlsx`;

/** Скрипт прайса: список -> чтение -> поставщик -> разбор -> сохранение -> отчёт. */
const pricesHandler: DualHandler = ({ body }) => {
  const user = userOf(body);
  const err = lastToolError(body);
  if (err !== undefined) collector.toolErrors[user]?.push(err);
  userSteps.set(user, stepOf(body));
  markPhase(`after-tool-${stepOf(body)}`);
  switch (stepOf(body)) {
    case 0:
      return { kind: 'tool', name: 'listPriceFiles', input: { query: priceFile(user) } };
    case 1: {
      const files = lastResult(body, 'listPriceFiles')['files'];
      const first = Array.isArray(files) ? (files[0] as { path?: string } | undefined) : undefined;
      if (first?.path === undefined) return { kind: 'text', text: 'Файл не найден.' };
      return { kind: 'tool', name: 'readPriceFile', input: { path: first.path } };
    }
    case 2:
      return { kind: 'tool', name: 'searchSuppliers', input: { query: `Load Supplier ${user}` } };
    case 3: {
      const read = lastResult(body, 'readPriceFile');
      const suppliers = lastResult(body, 'searchSuppliers')['suppliers'];
      const supplier = Array.isArray(suppliers) ? (suppliers[0] as { id?: string }) : undefined;
      return {
        kind: 'tool',
        name: 'normalizePriceTable',
        input: {
          path: read['path'],
          supplierId: supplier?.id ?? `sup-load-${user}`,
          tableIndex: 0,
          headerRows: headerRows(String(read['markdown'])),
          columns: COLUMNS,
        },
      };
    }
    case 4: {
      const norm = lastResult(body, 'normalizePriceTable');
      const read = lastResult(body, 'readPriceFile');
      return {
        kind: 'tool',
        name: 'savePriceImport',
        input: {
          path: read['path'],
          supplierId: norm['supplierId'],
          fileHash: norm['fileHash'],
          tableIndex: 0,
          headerRows: headerRows(String(read['markdown'])),
          columns: COLUMNS,
        },
      };
    }
    case 5: {
      const norm = lastResult(body, 'normalizePriceTable');
      const saved = lastResult(body, 'savePriceImport');
      return {
        kind: 'tool',
        name: 'reportToManager',
        input: {
          kind: 'import_done',
          path: lastResult(body, 'readPriceFile')['path'],
          fileHash: norm['fileHash'],
          updated: saved['changed'] ?? 0,
          needsReview: 0,
        },
      };
    }
    default:
      return { kind: 'text', text: 'Прайс обработан.' };
  }
};

function headerRows(markdown: string): number {
  for (const line of markdown.split('\n')) {
    const match = /^\|\s*(\d+)\s*\|/.exec(line);
    if (match !== null && line.includes(HEADER_WORD)) return Number(match[1]) + 1;
  }
  throw new Error('нет строки заголовка');
}

/** КП: шаблон -> проверка -> заполнение -> выпуск (данные из чата). */
function kpItems(): Array<{ name: string; quantity: number; unit: string }> {
  const count = heavy ? KP_LINES_HEAVY : KP_LINES_TYPICAL;
  return Array.from({ length: count }, (_, i) => ({
    name: `Арматура А500С d${10 + (i % 20)} партия ${i}`,
    quantity: 10 + i,
    unit: 'т',
  }));
}

function kpDocument(user: number): Record<string, unknown> {
  const lines = kpItems().map((item) => ({
    name: item.name,
    quantity: item.quantity,
    unitPrice: KP_UNIT_PRICE,
  }));
  return {
    id: `doc-${user}`,
    kind: 'commercial_offer',
    number: `КП-2026-${100 + user}`,
    buyer: 'ИП Сидоров Алексей Николаевич',
    seller: OWN_COMPANY_NAME,
    lines,
    total: lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0),
    currency: 'RUB',
    issuedAt: '2026-10-01',
    fieldSources: { buyer: 'employee', seller: 'employee', lines: 'employee', total: 'employee' },
  };
}

const documentsHandler: DualHandler = ({ body }) => {
  const user = userOf(body);
  const err = lastToolError(body);
  if (err !== undefined) collector.toolErrors[user]?.push(err);
  const template = (): string => {
    const templates = lastResult(body, 'findTemplate')['templates'];
    const first = Array.isArray(templates) ? templates[0] : undefined;
    const path = isRecord(first) ? first['path'] : undefined;
    if (typeof path !== 'string') throw new Error('findTemplate не нашёл шаблон');
    return path;
  };
  switch (stepOf(body)) {
    case 0:
      return {
        kind: 'tool',
        name: 'findTemplate',
        input: { query: 'коммерческое предложение', kind: 'commercial_offer' },
      };
    case 1:
      return { kind: 'tool', name: 'validateDocument', input: { document: kpDocument(user) } };
    case 2:
      return {
        kind: 'tool',
        name: 'fillTemplate',
        input: { templatePath: template(), document: kpDocument(user) },
      };
    case 3:
      return {
        kind: 'tool',
        name: 'saveDocument',
        input: { templatePath: template(), document: kpDocument(user) },
      };
    default:
      return { kind: 'text', text: 'Документ выпущен.' };
  }
};

/** Поиск поставщиков и заявка: приём -> поиск по базе знаний -> шорт-лист. */
function items(): Array<{ name: string; quantity: number; unit: string }> {
  const count = heavy ? SEARCH_ITEMS_HEAVY : SEARCH_ITEMS_TYPICAL;
  return Array.from({ length: count }, (_, i) => ({
    name: `Арматура А500С d${10 + i} ГОСТ 34028`,
    quantity: 100 + i,
    unit: 'м',
  }));
}

const orderHandler: DualHandler = ({ body }) => {
  const user = userOf(body);
  const err = lastToolError(body);
  if (err !== undefined) collector.toolErrors[user]?.push(err);
  switch (stepOf(body)) {
    case 0:
      return { kind: 'tool', name: 'saveIntakeRequest', input: { source: 'text', items: items() } };
    case 1: {
      const saved = lastResult(body, 'saveIntakeRequest');
      return {
        kind: 'tool',
        name: 'searchKnowledgeSuppliers',
        input: { requestId: String(saved['requestId']) },
      };
    }
    case 2: {
      const saved = lastResult(body, 'saveIntakeRequest');
      return { kind: 'tool', name: 'buildShortlist', input: { requestId: String(saved['requestId']) } };
    }
    default:
      return { kind: 'text', text: 'Шорт-лист готов.' };
  }
};

/** Лёгкая цепочка для site-export: несколько вызовов поиска по истории (давление на pseudonymizer). */
const siteHandler: DualHandler = ({ body }) => {
  const user = userOf(body);
  const err = lastToolError(body);
  if (err !== undefined) collector.toolErrors[user]?.push(err);
  const step = stepOf(body);
  if (step < 3) {
    return { kind: 'tool', name: 'searchConversationHistory', input: { query: `выгрузка ${step}` } };
  }
  return { kind: 'text', text: 'Выгрузка готова.' };
};

const handlers: Record<string, { agent: string; handler: DualHandler; text: (u: number) => string }> = {
  prices: {
    agent: 'prices',
    handler: pricesHandler,
    text: (u) => `Обработай новый прайс ${priceFile(u)}. LOADUSER${u}X`,
  },
  documents: {
    agent: 'documents',
    handler: documentsHandler,
    text:
      (u) =>
        `Подготовь коммерческое предложение (${kpItems().length} позиций). Покупатель: ИП Сидоров ` +
        `Алексей Николаевич, тел. ${BUYER_PII.phones[0] ?? ''}. LOADUSER${u}X`,
  },
  'order-calc': {
    agent: 'order-calc',
    handler: orderHandler,
    text: (u) => `Нужна арматура, ${items().length} позиций, нужен шорт-лист. LOADUSER${u}X`,
  },
  suppliers: {
    agent: 'order-calc',
    handler: orderHandler,
    text: (u) => `Найди поставщиков арматуры, ${items().length} позиций. LOADUSER${u}X`,
  },
  'site-export': {
    agent: 'site-export',
    handler: siteHandler,
    text: (u) => `Выгрузи позиции на сайт по шаблону. LOADUSER${u}X`,
  },
};

// ---------------------------------------------------------------- вложения (то, что делает насос)

const fetchOpts = { fetchFn: fetch, timeoutMs: REQUEST_TIMEOUT_MS };

// Таймауты клиентов documents - те же, что у боевого ядра (production-config): значения из
// LOAD_APP_ENV, иначе умолчания кода (те же константы, что у ядра: свои копии устаревали).
// Так замер показывает отказы по таймауту, а не обходит их.
const appEnv: Record<string, string> = {};
function clientTimeout(name: string, fallback: number): number {
  const value = Number(appEnv[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function attachments(user: number, result: UserResult, t0: number): Promise<void> {
  const parseMs = clientTimeout('DOCUMENTS_PARSE_TIMEOUT_MS', DEFAULT_PARSE_TIMEOUT_MS);
  const parser = new HttpDocumentParser({ baseUrl: docsUrl, timeoutMs: parseMs });
  const workbook = new HttpTemplateWorkbook({ baseUrl: docsUrl, timeoutMs: parseMs });
  const amender = new HttpContractAmender({
    baseUrl: docsUrl,
    timeoutMs: clientTimeout('DOCUMENTS_CONTRACT_TIMEOUT_MS', DEFAULT_CONTRACT_TIMEOUT_MS),
  });
  const detector = new HttpImageTextDetector({
    baseUrl: docsUrl,
    timeoutMs: clientTimeout('IMAGE_TEXT_GATE_TIMEOUT_MS', DEFAULT_IMAGE_TEXT_GATE_TIMEOUT_MS),
  });
  // Боевой режим tokens: normalize -> detect-text -> recognize-text, каждый шаг со своим сроком.
  const masker = new DocumentsImageMasker({
    baseUrl: docsUrl,
    timeoutMs: clientTimeout('IMAGE_RECOGNIZE_TIMEOUT_MS', DEFAULT_DOCUMENTS_RECOGNIZE_TIMEOUT_MS),
  });
  const normalizeMs = clientTimeout('IMAGE_NORMALIZE_TIMEOUT_MS', DEFAULT_IMAGE_NORMALIZE_TIMEOUT_MS);
  const sheet = `${filesDir}/prices/${priceFile(user)}`;
  const card = `${filesDir}/cards/card-${variant}.jpg`;
  const photo = async (): Promise<void> => {
    const form = new FormData();
    form.append('file', Bun.file(card), 'card.jpg');
    // Как GatewayImageReader.normalize: со сроком из конфигурации, а не голым fetch.
    const response = await fetchWithDeadline(fetch, `${docsUrl}${IMAGE_NORMALIZE_ROUTE}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(normalizeMs),
    });
    if (!response.ok) throw new Error(`normalize ${response.status}`);
    await response.arrayBuffer();
    const detection = await detector.detect({ bytes: readBytes(card), mime: 'image/jpeg' });
    if (detection.cause !== undefined && detection.cause !== detection.result) {
      throw new Error(`ocr ${detection.cause}`);
    }
    const recognized = await masker.mask({ bytes: readBytes(card), mime: 'image/jpeg' });
    if (!recognized.ok) throw new Error(`recognize ${recognized.cause}`);
  };
  switch (scenario) {
    case 'order-calc':
      await stage(result, 'sheet-parse', () => parser.parseFile(priceFile(user), { path: sheet, size: statSync(sheet).size }), t0);
      await stage(result, 'photo', photo, t0);
      break;
    case 'suppliers':
      await stage(result, 'photo', photo, t0);
      break;
    case 'documents-doc':
    case 'documents-docx': {
      const doc = scenario === 'documents-doc';
      const path = doc
        ? `${filesDir}/contracts/contract-${variant}-u${user}.doc`
        : `${filesDir}/contracts/contract-${variant}.docx`;
      const bytes = readBytes(path);
      await stage(
        result,
        'classify',
        () =>
          amender.classify({
            fileName: doc ? 'Договор.doc' : 'Договор.docx',
            bytes,
            templates: [],
            ownInns: ['7701001238'],
            ownNames: [OWN_COMPANY_NAME],
          }),
        t0,
      );
      await stage(
        result,
        'amend',
        () =>
          amender.amend({
            fileName: doc ? 'Договор.doc' : 'Договор.docx',
            bytes,
            own: { name: OWN_COMPANY_NAME, lines: OWN_LINES },
          }),
        t0,
      );
      break;
    }
    case 'prices-edit': {
      const spool = new FileSpool({ dir: `${env.work}/spool` });
      const editor = new HttpPriceFileEditor({
        baseUrl: docsUrl,
        timeoutMs: clientTimeout('DOCUMENTS_RENDER_TIMEOUT_MS', DEFAULT_PARSE_TIMEOUT_MS),
        spool,
      });
      const count = heavy ? EDITS_HEAVY : EDITS_TYPICAL;
      const edits = Array.from({ length: count }, (_, i) => ({ row: i + 2, col: 3, value: 100.5 + i }));
      await stage(
        result,
        'edit-prices',
        async () => {
          const edited = await editor.editPricesFile({
            fileName: priceFile(user),
            file: { path: sheet, size: statSync(sheet).size },
            edits,
          });
          await edited.file.dispose();
        },
        t0,
      );
      break;
    }
    case 'site-export': {
      const path = `${filesDir}/templates-site/site-${variant}.xlsx`;
      const bytes = readBytes(path);
      await stage(result, 'inspect', () => workbook.inspect({ bytes, headerRow: 11 }), t0);
      const count = heavy ? TEMPLATE_EDITS_HEAVY : TEMPLATE_EDITS_TYPICAL;
      const edits = Array.from({ length: count }, (_, i) => ({
        sheet: 'Товары',
        row: 12 + i,
        col: 2,
        value: `Позиция ${i}`,
      }));
      await stage(result, 'write', () => workbook.writeCells({ bytes, edits }), t0);
      break;
    }
    case 'voice': {
      const voice = `${filesDir}/voice/voice-${variant}.ogg`;
      const speech = new LocalSpeechToText({ baseUrl: speechUrl, maxBytes: 200 * MIB, maxSeconds: 300, timeoutMs: 900_000, log: () => {} });
      await stage(
        result,
        'speech',
        () =>
          speech.transcribe({
            bytes: new Uint8Array(0),
            file: { path: voice, size: statSync(voice).size },
            mimeType: 'audio/ogg',
            name: 'v.ogg',
          }),
        t0,
      );
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------- запуск

async function seed(db: PgClient): Promise<void> {
  await resetScenarioTables(db);
  const suppliers = new PostgresSupplierRepository(db);
  for (let i = 0; i < USERS; i += 1) {
    await suppliers.upsert({ id: `sup-load-${i}`, name: `Load Supplier ${i}` });
  }
}

async function main(): Promise<void> {
  const base = scenario.replace(/-doc$|-docx$|-edit$/, '');
  const plan = scenario === 'voice' || scenario === 'prices-edit'
    ? undefined
    : (handlers[scenario] ?? handlers[base]);
  const stub = new DualLlmStub();
  const db = openDb();
  await seed(db);
  stub.start(env.llmPort);
  const llmOnly = plan === undefined;
  if (!llmOnly) stub.begin(plan.handler);
  // Дополнительные переменные приложения: LOAD_APP_ENV="КЛЮЧ=значение,КЛЮЧ2=значение".
  const extra = Object.fromEntries(
    (process.env['LOAD_APP_ENV'] ?? '')
      .split(',')
      .filter((item) => item.includes('='))
      .map((item) => [item.split('=')[0] ?? '', item.split('=').slice(1).join('=')]),
  );
  Object.assign(appEnv, extra);
  const ctx = buildApp(new Map(), {
    ORDER_CALC_INTAKE_ENABLED: 'true',
    SPEECH_TO_TEXT_PROVIDER: 'off',
    ...extra,
  });
  const spec = llmOnly ? undefined : ctx.app.registry.get(plan.agent);
  // Прогрев: боевой pseudonymizer давно тёплый (модели загружены), холодный старт замера не нужен.
  if (spec !== undefined) {
    stub.begin(() => ({ kind: 'text', text: 'ok' }) as StubReply);
    // Первые вызовы грузят модели NER (десятки секунд) и могут получить 503: повторяем до успеха.
    let warm = 0;
    for (let attempt = 0; attempt < 12 && warm < 3; attempt += 1) {
      try {
        await ctx.app.runtime.run(
          toRunSpec(spec),
          `warm-${attempt}`,
          `прогрев ${attempt} ООО Ромашка, тел. +7 902 111-22-33`,
        );
        warm += 1;
      } catch {
        await Bun.sleep(2000);
      }
    }
    stub.begin(plan?.handler ?? (() => ({ kind: 'text', text: 'ok' }) as StubReply));
  }
  Bun.gc(true);
  const baseAnon = statusMib('RssAnon');
  const baseHwm = statusMib('VmHWM');
  let peakAnon = baseAnon;
  // Заглушка модели живёт в этом же процессе и хранит тела всех запросов: в бою их держит
  // шлюз, а не app. Тела обнуляются после ответа, их объём считается отдельно (артефакт замера).
  let stubBodyChars = 0;
  let stubBodyMaxChars = 0;
  const timer = setInterval(() => {
    for (const record of stub.requests) {
      if (record.answered && record.raw.length > 0) {
        stubBodyChars += record.raw.length;
        stubBodyMaxChars = Math.max(stubBodyMaxChars, record.raw.length);
        record.raw = '';
      }
    }
    const anonNow = statusMib('RssAnon');
    peakAnon = Math.max(peakAnon, anonNow);
    if (traceStages) phasePeaks.set(phase, Math.max(phasePeaks.get(phase) ?? 0, anonNow));
    traceTick(anonNow);
  }, SAMPLE_MS);
  const t0 = Date.now();
  const results: UserResult[] = Array.from({ length: USERS }, (_, user) => ({
    user,
    ok: false,
    seconds: 0,
    stages: {},
    errors: [],
  }));
  const finished = new Set<number>();
  const allTurns = Promise.all(
    results.map(async (result) => {
      const begin = Date.now();
      try {
        await attachments(result.user, result, t0);
        if (spec !== undefined && plan !== undefined) {
          const run = await ctx.app.runtime.run(
            toRunSpec(spec),
            `load-${scenario}-${variant}-${result.user}`,
            plan.text(result.user),
          );
          result.stages['agent-run'] = Number(((Date.now() - begin) / 1000).toFixed(1));
          if (run.status !== 'completed') result.errors.push(`run: ${run.status}`);
        }
      } catch (error) {
        result.errors.push(`turn: ${error instanceof Error ? error.message.slice(0, 140) : String(error)}`);
      }
      result.seconds = Number(((Date.now() - begin) / 1000).toFixed(1));
      result.errors.push(...(collector.toolErrors[result.user] ?? []).map((e) => `tool: ${e}`));
      result.ok = result.errors.length === 0;
      finished.add(result.user);
    }),
  );
  // Общий предел сценария: по истечении незавершённые ходы помечаются ошибкой, итог печатается.
  let limitTimer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<'timeout'>((resolve) => {
    limitTimer = setTimeout(() => resolve('timeout'), SCENARIO_TIMEOUT_MS);
  });
  const outcome = await Promise.race([allTurns.then(() => 'done' as const), limit]);
  clearTimeout(limitTimer);
  if (outcome === 'timeout') {
    for (const result of results) {
      if (finished.has(result.user)) continue;
      result.errors.push(`scenario timeout ${SCENARIO_TIMEOUT_MS / 1000} с`);
      result.seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
    }
  }
  clearInterval(timer);
  markPhase('end');
  const times = results.map((r) => r.seconds).sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      scenario,
      variant,
      users: USERS,
      okUsers: results.filter((r) => r.ok).length,
      secondsMedian: times[Math.floor(USERS / 2)],
      secondsTenth: times[USERS - 1],
      wallSeconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
      app: {
        baseAnonMiB: Math.round(baseAnon),
        peakAnonMiB: Math.round(peakAnon),
        vmHWMMiB: Math.round(statusMib('VmHWM')),
        baseVmHWMMiB: Math.round(baseHwm),
      },
      llmRequests: stub.requests.length,
      stubBodiesMiB: Math.round(stubBodyChars / (1024 * 1024)),
      stubBodyMaxMiB: Number((stubBodyMaxChars / (1024 * 1024)).toFixed(1)),
      users_detail: results,
    }),
  );
  await ctx.app.close();
  await db.close();
  await stub.stop();
}

await main();
process.exit(0);
