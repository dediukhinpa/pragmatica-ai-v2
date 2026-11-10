import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresPriceRepository } from '../../src/kit/adapters/postgres/price-repository';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import type { PgClient } from '@business-ai/adapters';
import { toRunSpec } from '@business-ai/core';
import { buildApp, e2eEnv, openDb, resetScenarioTables, MANAGER_THREAD } from '../lib/project-env';
import type { E2eApp } from '../lib/project-env';
import { lastResult, LlmStub, type StubScript } from '@business-ai/testing/e2e';
import { COLUMNS, headerRowCount, readFirstFileReply } from '../lib/prices-flow';
import { RecordingProxy } from '@business-ai/testing/e2e';
import { findLeaks } from '@business-ai/testing/e2e';
import { PRICE_FILE_PII } from '../lib/pii.owned';

const SUPPLIER_ID = 'sup-metalloprokat';
const THREAD = 'e2e-prices-thread';
const EXPECTED_ITEMS = 5;

const llm = new LlmStub();
let db: PgClient;
let ctx: E2eApp;
const proxy = new RecordingProxy(e2eEnv().pseudonymizerUrl);

/** Сценарий модели: список файлов -> чтение -> поставщик -> разбор -> сохранение -> отчёт. */
const script: StubScript = ({ index, body }) => {
  switch (index) {
    case 0:
      return { kind: 'tool', name: 'listPriceFiles', input: {} };
    case 1:
      return readFirstFileReply(body);
    case 2:
      return { kind: 'tool', name: 'searchSuppliers', input: { query: 'Металлопрокат' } };
    case 3: {
      const read = lastResult(body, 'readPriceFile');
      const suppliers = lastResult(body, 'searchSuppliers')['suppliers'];
      const supplier = Array.isArray(suppliers) ? (suppliers[0] as { id?: string }) : undefined;
      return {
        kind: 'tool',
        name: 'normalizePriceTable',
        input: {
          path: read['path'],
          supplierId: supplier?.id ?? 'нет-поставщика',
          tableIndex: 0,
          headerRows: headerRowCount(String(read['markdown'])),
          columns: COLUMNS,
        },
      };
    }
    case 4: {
      const norm = lastResult(body, 'normalizePriceTable');
      const read = lastResult(body, 'readPriceFile');
      // Позиции модель не передаёт: инструмент сам перечитывает файл и сверяет хэш.
      return {
        kind: 'tool',
        name: 'savePriceImport',
        input: {
          path: read['path'],
          supplierId: norm['supplierId'],
          fileHash: norm['fileHash'],
          tableIndex: 0,
          headerRows: headerRowCount(String(read['markdown'])),
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

beforeAll(async () => {
  db = openDb();
  await resetScenarioTables(db);
  // Поставщик с контактами: email и ФИО попадут в результат searchSuppliers.
  await new PostgresSupplierRepository(db).upsert({
    id: SUPPLIER_ID,
    name: 'ООО Металлопрокат',
    email: PRICE_FILE_PII.emails[0],
    contactName: 'Иванов Пётр Сергеевич',
  });
  llm.start(e2eEnv().llmPort);
  llm.begin(script);
  const debug = process.env['E2E_DEBUG'] === '1';
  ctx = buildApp(new Map(), debug ? { PSEUDONYMIZER_URL: proxy.start() } : {});
});

afterAll(async () => {
  if (process.env['E2E_DEBUG'] === '1') {
    await llm.dump(`${e2eEnv().work}/out/a-bodies.txt`);
    await Bun.write(`${e2eEnv().work}/out/a-pseudo.json`, JSON.stringify(proxy.records, null, 1));
  }
  await proxy.stop();
  await ctx.app.close();
  await db.close();
  await llm.stop();
});

describe('сценарий a: прайсы', () => {
  let output = '';

  test('агент проходит цепочку и сохраняет позиции в Postgres', async () => {
    const spec = ctx.app.registry.get('prices');
    const result = await ctx.app.runtime.run(toRunSpec(spec), THREAD, 'Обработай новые прайсы');
    output = result.output;
    expect(llm.scriptErrors).toEqual([]);
    expect(result.status).toBe('completed');
    expect(output).toBe('Прайс обработан.');
    expect(llm.requests.length).toBe(7);
  });

  test('позиции прайса лежат в базе с верными ценами', async () => {
    const items = await new PostgresPriceRepository(db).listBySupplier(SUPPLIER_ID);
    expect(items.length).toBe(EXPECTED_ITEMS);
    const bySku = new Map(items.map((item) => [item.sku, item]));
    expect(bySku.get('AR-001')?.price).toBe(62500.5);
    expect(bySku.get('TR-020')?.price).toBe(68900.25);
    expect(bySku.get('LS-010')?.productName).toBe('Лист стальной 3 мм');
    expect(items.every((item) => item.currency === 'RUB')).toBe(true);
  });

  test('модель получила данные прайса, но в обезличенном виде (есть токены)', () => {
    const all = llm.bodies().join('\n');
    expect(all).toContain('Арматура А500С d12');
    expect(all).toMatch(/\[PHONE_\d+\]/);
    expect(all).toMatch(/\[EMAIL_\d+\]/);
    expect(llm.requests.every((request) => request.apiKey !== null)).toBe(true);
  });

  test('заглушка LLM ни разу не получила ФИО, телефон и email из файла', () => {
    expect(findLeaks(llm.bodies(), PRICE_FILE_PII)).toEqual([]);
  });

  test('отчёт ушёл владельцу работы без ПДн', () => {
    // Ход без инициатора-сотрудника идёт в треде THREAD: тред хода и есть чат владельца
    // импорта (адресация этапа 46), поэтому отчёт агента «Актуализация прайса (ИИ агент)» уходит
    // туда, а не в
    // MANAGER_THREAD_ID. Менеджеру из MANAGER_THREAD_ID при этом ничего не уходит.
    const messages = ctx.chat.outbox.filter((item) => item.threadId === THREAD);
    expect(messages.length).toBe(1);
    const text = messages[0]?.message?.text ?? '';
    expect(text).toContain('обновил');
    expect(findLeaks([JSON.stringify(text)], PRICE_FILE_PII)).toEqual([]);
    const toManager = ctx.chat.outbox.filter((item) => item.threadId === MANAGER_THREAD);
    expect(toManager).toEqual([]);
  });

  test('в аудит записано действие агента, и в нём нет ПДн', async () => {
    const rows = await db.query('SELECT actor, agent, action, details, result FROM audit_log');
    // Аудит пишут вызовы инструментов с побочным эффектом (tool-bridge -> recordToolAudit):
    // в сценарии это savePriceImport (шаг 4) и reportToManager (шаг 5), оба успешные.
    // Остальные инструменты сценария (список, чтение, поиск, разбор) без побочных эффектов.
    for (const action of ['savePriceImport', 'reportToManager']) {
      const entries = rows.filter((row) => row['action'] === action);
      expect(entries.length).toBe(1);
      expect(entries[0]).toMatchObject({
        actor: 'agent:prices',
        agent: 'prices',
        action,
        result: 'ok',
      });
      // details: «thread=<тред> key=<16 hex хэша ключа операции>», без аргументов вызова
      expect(String(entries[0]?.['details'])).toMatch(
        new RegExp(`^thread=${THREAD} key=[0-9a-f]{16}$`),
      );
    }
    // Блокировок и ошибок инструментов в успешном сценарии нет
    expect(rows.filter((row) => row['result'] !== 'ok')).toEqual([]);
    expect(findLeaks([JSON.stringify(rows)], PRICE_FILE_PII)).toEqual([]);
  });
});
