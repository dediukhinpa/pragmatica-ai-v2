import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { MemoryFileSource, MemoryScheduler } from '@business-ai/adapters';
import { MemoryKnowledgeSearch } from '../../src/kit/adapters/memory/knowledge-search.owned';
import { createDocumentsAgent } from '../../src/agents/documents/declaration';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import { createPricesAgent } from '../../src/agents/prices/declaration';
import { createSiteExportAgent } from '../../src/agents/site-export/declaration';
import { decodeIdentifiers, encodeIdentifiers, findDigitSeries } from '@business-ai/core';
import type { IdGenerator, ModelRequest } from '@business-ai/core';
import { callTool, say, scriptedRuntime } from '../kit/adapters/mastra/support';
import { digitSeriesOf, wireText } from '@business-ai/testing';
import { ORDER_REQUEST, buildOrderDeps, markRequestsSent } from './order-support';
import { GOOD_DESCRIPTION, buildSiteDeps } from './site-support';
import {
  MODEL_ALIAS,
  SUPPLIER_ID,
  buildDocument,
  buildDocumentsDeps,
  buildPricesDeps,
  lastToolResult,
} from './support';

/**
 * Инвариант ядра: ни один запрос к модели не содержит серии из 10 и более цифр подряд вне
 * токенов замены. Остальные сценарии агентов проверяются тем же правилом автоматически
 * (tests/support/setup.ts), но идут на заглушках с короткими id (`task-1`). Здесь те же четыре
 * агента работают с идентификаторами боевого вида: sha256 файла, UUID задач и заявок,
 * отпечатки, время изменения файла.
 */

/** UUID боевого вида; последняя группа - 12 цифр с верной контрольной суммой ИНН. */
const UUID = '3f2b8c1e-9a4d-4c7b-8123-500100732259';
const REQUEST_ID = 'e2a41c07-55d1-4f0a-9c3e-771234567890';
const EXPORT_ID = `exp-${UUID}`;
const KNOWLEDGE_ID = `kb-${UUID}`;
const DOCUMENT_ID = 'doc-00a1234567890123';
/** Содержимое прайса, у которого sha256 содержит 11 цифр подряд (найдено перебором). */
const PRICE_CSV = 'Наименование,Цена\nБолт 9,12\nГайка,5';
/** Настоящее время изменения файла, мс. */
const REAL_MTIME_MS = 1_760_000_000_000;
/** Размер куска текста в потоке: меньше длины хэша, чтобы он пришёл разрезанным. */
const STREAM_CHUNK_CHARS = 7;

const uuidIds: IdGenerator = { next: (prefix = 'id') => `${prefix}-${UUID}` };
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Проверка сценария: в запросах нет серий цифр, хотя в настоящих значениях они были
 * (иначе сценарий ничего не доказывает).
 */
function expectNoDigitSeries(requests: readonly ModelRequest[], minRequests: number): void {
  expect(requests.length).toBeGreaterThanOrEqual(minRequests);
  for (const request of requests) expect(digitSeriesOf(request)).toEqual([]);
  const original = requests.map((request) => decodeIdentifiers(wireText(request))).join('\n');
  expect(findDigitSeries(original).length).toBeGreaterThan(0);
}

describe('инвариант: модели не уходят серии цифр из технических значений', () => {
  test('«Актуализация прайса (ИИ агент)»: хэш файла и время изменения; инструменты получают ' +
    'настоящий хэш', async () => {
    const deps = await buildPricesDeps();
    (deps.files as MemoryFileSource).put('price.csv', encode(PRICE_CSV), REAL_MTIME_MS);
    const fileHash = sha256(PRICE_CSV);
    expect(findDigitSeries(fileHash)).toHaveLength(1);
    const importKeys: string[] = [];
    const saveImport = deps.prices.saveImport.bind(deps.prices);
    deps.prices.saveImport = async (supplierId, items, key) => {
      importKeys.push(key);
      await saveImport(supplierId, items, key);
    };
    const seen: Array<Record<string, unknown>> = [];
    const { gateway, runtime, spec } = scriptedRuntime(
      createPricesAgent({ model: MODEL_ALIAS }),
      deps,
      (request, call) => {
        if (call > 0) seen.push(lastToolResult(request));
        if (call === 0) return callTool('c-list', 'listPriceFiles', {});
        if (call === 1) {
          // Модель возвращает список как получила: known = файлы прошлого шага.
          return callTool('c-known', 'listPriceFiles', { known: seen[0]?.['files'] });
        }
        if (call === 2) {
          return callTool('c-norm', 'normalizePriceTable', {
            path: 'price.csv',
            supplierId: SUPPLIER_ID,
            columns: { name: 0, price: 1 },
          });
        }
        if (call === 3) {
          const { supplierId, fileHash: hash } = lastToolResult(request);
          const columns = { name: 0, price: 1 };
          const args = { path: 'price.csv', supplierId, fileHash: hash, columns };
          return callTool('c-save', 'savePriceImport', args);
        }
        if (call === 4) {
          return callTool('c-rep', 'reportToManager', {
            kind: 'import_done',
            path: 'price.csv',
            fileHash: seen[2]?.['fileHash'],
            updated: 2,
            needsReview: 0,
          });
        }
        return say(`Прайс обновлён, файл ${String(seen[2]?.['fileHash'])}`);
      },
    );
    const result = await runtime.run(spec, 't1', 'проверь прайсы');

    // Модель видела хэш в буквенном виде и время строкой, а не числом.
    const listed = (seen[0]?.['files'] as Array<Record<string, unknown>>)[0];
    expect(listed).toEqual({
      path: 'price.csv',
      modifiedAt: new Date(REAL_MTIME_MS).toISOString(),
      hash: encodeIdentifiers(fileHash),
      isScan: false,
    });
    // known с закодированным хэшем совпал с диском: изменений нет.
    expect(seen[1]).toEqual({ files: [] });
    // Инструменты получили настоящий sha256, пользователь - тоже.
    expect(importKeys).toHaveLength(1);
    expect(importKeys[0]).toContain(fileHash);
    expect(result.output).toBe(`Прайс обновлён, файл ${fileHash}`);
    expect(deps.chat.outbox[0]?.message?.text).toContain('обновил 2 позиций');
    expectNoDigitSeries(gateway.requests, 6);
  });

  test('поток: идентификатор в тексте, разрезанный на куски, доходит настоящим', async () => {
    const deps = await buildPricesDeps();
    (deps.files as MemoryFileSource).put('price.csv', encode(PRICE_CSV), REAL_MTIME_MS);
    const fileHash = sha256(PRICE_CSV);
    const { gateway, runtime, spec } = scriptedRuntime(
      createPricesAgent({ model: MODEL_ALIAS }),
      deps,
      (request, call) => {
        if (call === 0) return callTool('c-read', 'readPriceFile', { path: 'price.csv' });
        return say(`Файл ${String(lastToolResult(request)['hash'])} прочитан`);
      },
      { gateway: { chunkSize: STREAM_CHUNK_CHARS } },
    );
    let text = '';
    let output = '';
    for await (const event of runtime.stream(spec, 't1', 'прочитай прайс')) {
      if (event.type === 'text_delta') text += event.text;
      if (event.type === 'done') output = event.result.output;
    }
    expect(text).toBe(`Файл ${fileHash} прочитан`);
    expect(output).toBe(text);
    expectNoDigitSeries(gateway.requests, 2);
  });

  test('«Поиск поставщика (ИИ агент)»: UUID заявки и задачи, отпечаток версии, пауза и ' +
    'продолжение', async () => {
    const deps = await buildOrderDeps({ request: { ...ORDER_REQUEST, id: REQUEST_ID } });
    deps.scheduler = new MemoryScheduler(uuidIds);
    const safeRequestId = encodeIdentifiers(REQUEST_ID);
    const { gateway, runtime, spec } = scriptedRuntime(
      createOrderCalcAgent({ model: MODEL_ALIAS, mailbox: true }),
      deps,
      (request, call) => {
        // «Модель» знает заявку только в том виде, в каком её получила.
        const requestId = safeRequestId;
        if (call === 0) {
          return {
            content: '',
            stopReason: 'tool_use',
            toolCalls: ['searchKnowledgeSuppliers', 'searchWeb'].map(
              (name, index) => ({ id: `search-${index}`, name, arguments: { requestId } }),
            ),
          };
        }
        if (call === 1) return callTool('c-build', 'buildShortlist', { requestId });
        if (call === 2) {
          const { version } = lastToolResult(request);
          return callTool('c-ask', 'askManagerToChoose', { requestId, version });
        }
        // Этап 179: askManagerToChoose заканчивает ход; выбор приходит новым ходом менеджера.
        if (call === 3) {
          return callTool('c-choice', 'recordManagerChoice', {
            requestId,
            decision: 'picked',
            picks: ['1', '2'],
          });
        }
        if (call === 4) {
          return callTool('c-select', 'recordSelection', { requestId, supplierIds: ['s1', 's2'] });
        }
        if (call === 5) return callTool('c-remind', 'scheduleReminder', { requestId });
        return say(`Напоминание: ${String(lastToolResult(request)['taskId'])}`);
      },
    );
    const asked = await runtime.run(spec, 't1', `Заявка ${REQUEST_ID}, возьми в работу`);
    expect(asked.status).toBe('completed');
    // Запросы ушли кнопкой «Отправить» под черновиком: учёт отправленного уже есть.
    // Ящик заявки принадлежит менеджеру, который выбирает поставщиков (проверка владельца).
    await markRequestsSent(deps, ['s1', 's2'], { requestId: REQUEST_ID, owner: 'manager' });
    const manager = { context: { initiator: { kind: 'user', userId: 'manager' } } } as const;
    const done = await runtime.run(spec, 't1', 'Берём первого и второго', manager);

    expect(done.status).toBe('completed');
    // Пользователь видит настоящий id задачи.
    expect(done.output).toBe(`Напоминание: task-${UUID}`);
    expect(wireText(gateway.requests.at(-1) as ModelRequest)).toContain(
      encodeIdentifiers(`task-${UUID}`),
    );
    expectNoDigitSeries(gateway.requests, 6);
  });

  test('«Подготовка документов (ИИ агент)»: хэш шаблона, id документа и id фрагмента базы ' +
    'знаний', async () => {
    const base = await buildDocumentsDeps();
    const knowledge = new MemoryKnowledgeSearch(new Map([[KNOWLEDGE_ID, 'КП шаблон: правила']]));
    const deps = { ...base, knowledge };
    deps.files.put('templates/КП шаблон.docx', encode(PRICE_CSV), REAL_MTIME_MS);
    const document = buildDocument({ id: DOCUMENT_ID });
    const { gateway, runtime, spec } = scriptedRuntime(
      createDocumentsAgent({ model: MODEL_ALIAS }),
      deps,
      (request, call) => {
        if (call === 0) return callTool('c-find', 'findTemplate', { query: 'КП шаблон' });
        if (call === 1) {
          const first = (lastToolResult(request)['templates'] as Array<{ path: string }>)[0];
          const safe = { ...document, id: encodeIdentifiers(DOCUMENT_ID) };
          return callTool('c-save', 'saveDocument', { templatePath: first?.path, document: safe });
        }
        return say('КП выпущено');
      },
    );
    const result = await runtime.run(spec, 't1', 'сделай КП по D-1');

    expect(result.output).toBe('КП выпущено');
    expect(deps.chat.outbox[0]?.file?.name).toBe('Заказчик_Коммерческое_предложение_КП-1.docx');
    const found = wireText(gateway.requests[1] as ModelRequest);
    expect(found).toContain(encodeIdentifiers(sha256(PRICE_CSV)));
    expect(found).toContain(encodeIdentifiers(KNOWLEDGE_ID));
    expectNoDigitSeries(gateway.requests, 3);
  });
});
