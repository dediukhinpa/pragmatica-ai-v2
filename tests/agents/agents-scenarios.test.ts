import { describe, expect, test } from 'bun:test';
import { createDocumentsAgent } from '../../src/agents/documents/declaration';
import { createPricesAgent } from '../../src/agents/prices/declaration';
import type { ModelRequest } from '@business-ai/core';
import { callTool, say, scriptedRuntime, type Step } from '../kit/adapters/mastra/support';
import {
  MODEL_ALIAS,
  SUPPLIER_ID,
  buildDocument,
  buildDocumentsDeps,
  buildPricesDeps,
  existingPrice,
  lastToolResult,
  priceCsv,
  putFile,
  toolMessages,
} from './support';

const COLUMNS = { name: 0, price: 1 };

/**
 * savePriceImport получает указатель на файл и хэш из normalizePriceTable: позиции модель не
 * передаёт, их перечитывает код.
 */
function saveFromNormalized(request: ModelRequest): Step {
  const { supplierId, fileHash } = lastToolResult(request);
  return callTool('c-save', 'savePriceImport', {
    path: 'price.csv',
    supplierId,
    fileHash,
    columns: COLUMNS,
  });
}

const NORMALIZE = callTool('c-norm', 'normalizePriceTable', {
  path: 'price.csv',
  supplierId: SUPPLIER_ID,
  columns: COLUMNS,
});

describe('агент «Актуализация прайса (ИИ агент)»: сценарии', () => {
  test('модель берётся из параметра, а не жёстко', () => {
    expect(createPricesAgent({ model: MODEL_ALIAS }).model).toBe(MODEL_ALIAS);
    expect(createDocumentsAgent({ model: 'другой-алиас' }).model).toBe('другой-алиас');
  });

  test('прайс обновился: сохранён, менеджеру итог', async () => {
    const deps = await buildPricesDeps();
    await deps.prices.saveImport(SUPPLIER_ID, [existingPrice('Болт', 10)], 'seed');
    putFile(deps, 'price.csv', priceCsv([['Болт', 12], ['Гайка', 5]]));
    const { gateway, runtime, spec } = scriptedRuntime(
      createPricesAgent({ model: MODEL_ALIAS }),
      deps,
      (request, call) => {
        if (call === 0) return callTool('c1', 'readPriceFile', { path: 'price.csv' });
        if (call === 1) return NORMALIZE;
        if (call === 2) return saveFromNormalized(request);
        if (call === 3) {
          const saved = lastToolResult(request);
          return callTool('c-rep', 'reportToManager', {
            kind: 'import_done',
            path: 'price.csv',
            fileHash: 'h-1',
            updated: saved.changed,
            needsReview: 0,
          });
        }
        return say('Прайс обновлён');
      },
    );
    const result = await runtime.run(spec, 't1', 'проверь прайсы');
    expect(result).toMatchObject({ status: 'completed', output: 'Прайс обновлён' });
    const stored = await deps.prices.listBySupplier(SUPPLIER_ID);
    expect(stored.map((i) => [i.productName, i.price])).toEqual([
      ['Болт', 12],
      ['Гайка', 5],
    ]);
    expect(deps.chat.outbox[0]?.message?.text).toBe(
      'Прайс «price.csv»: обновил 2 позиций, 0 на проверку.',
    );
    // Модель получила описание всех инструментов агента и модель-алиас.
    expect(gateway.requests[0]?.model).toBe(MODEL_ALIAS);
    expect(gateway.requests[0]?.tools?.map((t) => t.name)).toContain('savePriceImport');
  });

  test('скачок цены: savePriceImport записывает прайс, агент сообщает о проверке', async () => {
    const deps = await buildPricesDeps();
    await deps.prices.saveImport(SUPPLIER_ID, [existingPrice('Болт', 10)], 'seed');
    putFile(deps, 'price.csv', priceCsv([['Болт', 40]]));
    const { gateway, runtime, spec } = scriptedRuntime(
      createPricesAgent({ model: MODEL_ALIAS }),
      deps,
      (request, call) => {
        if (call === 0) return NORMALIZE;
        if (call === 1) return saveFromNormalized(request);
        if (call === 2) {
          return callTool('c-rep', 'reportToManager', {
            kind: 'import_done',
            path: 'price.csv',
            fileHash: 'h-1',
            updated: 1,
            needsReview: 1,
            issueCodes: [],
          });
        }
        return say('Прайс записан, скачок цены ушёл на проверку');
      },
    );
    await runtime.run(spec, 't1', 'проверь прайсы');
    // Скачок решения человека не требует: запись прошла, модель не получила замечаний.
    expect(toolMessages(gateway.requests[2]).join('\n')).not.toContain('price_jump');
    expect((await deps.prices.listBySupplier(SUPPLIER_ID))[0]?.price).toBe(40);
    expect(deps.chat.outbox).toHaveLength(1);
    expect(deps.chat.outbox[0]?.message?.text).toContain('1 на проверку');
  });

  test('дубли в позициях: валидатор декларации блокирует инструмент', async () => {
    // Полный дубль (то же название и цена) код схлопывает; блокирует дубль с разной ценой.
    const deps = await buildPricesDeps();
    putFile(deps, 'price.csv', priceCsv([['Болт', 10], ['Болт', 12]]));
    const { gateway, runtime, spec } = scriptedRuntime(
      createPricesAgent({ model: MODEL_ALIAS }),
      deps,
      (request, call) => {
        if (call === 0) return NORMALIZE;
        if (call === 1) return saveFromNormalized(request);
        return say('Нашла дубли, нужна проверка');
      },
    );
    await runtime.run(spec, 't1', 'x');
    expect(toolMessages(gateway.requests[2]).at(-1)).toContain('НЕ выполнено');
    expect(toolMessages(gateway.requests[2]).at(-1)).toContain('duplicate_row');
    expect(await deps.prices.listBySupplier(SUPPLIER_ID)).toEqual([]);
  });

  test('скан: не обрабатывается, менеджеру просьба прислать Excel', async () => {
    const deps = await buildPricesDeps();
    putFile(deps, 'scan.jpg', 'binary');
    const { gateway, runtime, spec } = scriptedRuntime(
      createPricesAgent({ model: MODEL_ALIAS }),
      deps,
      (request, call) => {
        if (call === 0) return callTool('c1', 'readPriceFile', { path: 'scan.jpg' });
        if (call === 1) {
          const { hash, needsOcr } = lastToolResult(request);
          if (needsOcr !== true) return say('не скан');
          return callTool('c2', 'reportToManager', {
            kind: 'scan_skipped',
            path: 'scan.jpg',
            fileHash: hash,
          });
        }
        return say('Файл scan.jpg пропущен: скан');
      },
    );
    await runtime.run(spec, 't1', 'x');
    expect(gateway.requests).toHaveLength(3);
    expect(deps.chat.outbox[0]?.message?.text).toContain('скан');
    expect(await deps.prices.listBySupplier(SUPPLIER_ID)).toEqual([]);
    const called = gateway.requests.flatMap((r) =>
      r.messages.flatMap((m) => m.toolCalls?.map((c) => c.name) ?? []),
    );
    expect(called).not.toContain('savePriceImport');
  });
});

describe('агент «Подготовка документов (ИИ агент)»: сценарии', () => {
  test('данные верны: документ выпущен, файл в чате', async () => {
    const deps = await buildDocumentsDeps();
    putFile(deps, 'templates/КП шаблон.docx', 'tpl');
    const document = buildDocument();
    const { runtime, spec } = scriptedRuntime(
      createDocumentsAgent({ model: MODEL_ALIAS }),
      deps,
      (request, call) => {
        if (call === 0) return callTool('c1', 'findTemplate', { query: 'КП шаблон' });
        if (call === 1) {
          const first = (lastToolResult(request).templates as Array<{ path: string }>)[0];
          return callTool('c2', 'saveDocument', { templatePath: first?.path, document });
        }
        return say('КП выпущено');
      },
    );
    const result = await runtime.run(spec, 't1', 'сделай КП по D-1');
    expect(result.output).toBe('КП выпущено');
    expect(deps.chat.outbox[0]?.file?.name).toBe('Заказчик_Коммерческое_предложение_КП-1.docx');
    // Файл ушёл в тред диалога (его дал рантайм), а не в фиксированный тред из настроек.
    expect(deps.chat.outbox[0]?.threadId).toBe('t1');
  });

  test('шаблон не найден: вопрос менеджеру, документ не выпускается', async () => {
    const deps = await buildDocumentsDeps();
    const { gateway, runtime, spec } = scriptedRuntime(
      createDocumentsAgent({ model: MODEL_ALIAS }),
      deps,
      (request, call) => {
        if (call === 0) return callTool('c1', 'findTemplate', { query: 'акт сверки' });
        const templates = lastToolResult(request).templates as unknown[];
        return say(
          templates.length === 0
            ? 'Шаблона «акт сверки» нет. Какой шаблон взять или положить его на диск?'
            : 'нашла',
        );
      },
    );
    const result = await runtime.run(spec, 't1', 'нужен акт сверки');
    expect(result.output).toContain('Какой шаблон взять');
    expect(deps.chat.outbox).toEqual([]);
    expect(gateway.requests).toHaveLength(2);
  });

  test('суммы не сходятся: предупреждение, файл выдан, агент исправляет', async () => {
    const deps = await buildDocumentsDeps();
    putFile(deps, 'templates/КП шаблон.docx', 'tpl');
    const path = 'templates/КП шаблон.docx';
    const { gateway, runtime, spec } = scriptedRuntime(
      createDocumentsAgent({ model: MODEL_ALIAS }),
      deps,
      [
        callTool('c1', 'saveDocument', {
          templatePath: path,
          document: buildDocument({ total: 1 }),
        }),
        callTool('c2', 'saveDocument', { templatePath: path, document: buildDocument() }),
        say('Исправила итог и выпустила КП'),
      ],
    );
    await runtime.run(spec, 't1', 'сделай КП');
    expect(toolMessages(gateway.requests[1])[0]).toContain('total_mismatch');
    // Решение 03.11: расхождение не блокирует, первый файл уходит с предупреждением.
    expect(toolMessages(gateway.requests[1])[0]).not.toContain('blocked');
    expect(deps.chat.outbox).toHaveLength(2);
  });
});
