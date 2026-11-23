import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import { PostgresWorkflowStateStore, type PgClient } from '@business-ai/adapters';
import { buildInitialImportSummary } from '../../src/agents/prices/initial-import-summary';
import { DISK_SYNC_THREAD_PREFIX } from '../../src/agents/prices/price-disk-sync';
import {
  loadDiskSyncOutcomes,
  queueDiskSyncOutcome,
} from '../../src/agents/prices/disk-sync-outcome';
import { toRunSpec } from '@business-ai/core';
import { buildApp, openDb, resetScenarioTables, type E2eApp } from '../lib/project-env';
import { expectNoLeaks } from '@business-ai/testing/e2e';
import { isRecord, LlmStub, lastResult } from '@business-ai/testing/e2e';
import {
  allToolNames,
  expectItemsInDb,
  formScript,
  makePricesRoot,
  sandboxOverrides,
  SCRIPT_SUPPLIER_PREFIX,
} from '../lib/script-flow';
import { buildFormFile, FORM_PII, PRICE_FORMS, type PriceForm } from '../lib/script-forms';
import { e2eEnv } from '../lib/project-env';

/**
 * Сценарий s111-forms: прайсы сложных форм (синтетические копии форм спайка этапа 111) разбираются
 * скриптом в настоящей песочнице; заглушка LLM «вызывает» runDataScript с детерминированным
 * кодом формы. Позиции идут в staging тем же путём, что и разбор таблицы, и пишутся только
 * через `commitPriceImport` и его валидатор. Проверяется: число позиций, тиражи, основание
 * тиража, сводка «разобрано скриптом», отсутствие ПДн в запросах к модели.
 *
 * Одеяла - известный поставщик; коробки - новый поставщик (карточка-черновик, как при
 * синхронизации диска) и сводка первичного импорта; остальные формы - известный поставщик.
 */

const DONE_TEXT = 'Файл разобран скриптом.';
const NEW_SUPPLIER_FORM = 'boxes';

const llm = new LlmStub();
let db: PgClient;
let ctx: E2eApp;
let root = '';

function supplierIdOf(form: PriceForm): string {
  return `${SCRIPT_SUPPLIER_PREFIX}${form.code}`;
}

beforeAll(async () => {
  db = openDb();
  await resetScenarioTables(db);
  await db.query('TRUNCATE supplier_price_scripts, workflow_state');
  root = await makePricesRoot('s111-forms-prices');
  for (const form of PRICE_FORMS) {
    buildFormFile(`${root}/${form.fileName}`, form.sheets);
    await new PostgresSupplierRepository(db).upsert({
      id: supplierIdOf(form),
      name: `ООО Тест ${form.code}`,
    });
  }
  // Карточку нового поставщика заводит код тика (этап 145), здесь она уже есть как черновик.
  await db.query('UPDATE suppliers SET is_draft = true WHERE id = $1', [
    `${SCRIPT_SUPPLIER_PREFIX}${NEW_SUPPLIER_FORM}`,
  ]);
  llm.start(e2eEnv().llmPort);
  ctx = buildApp(new Map(), sandboxOverrides(root));
});

afterAll(async () => {
  await ctx.app.close();
  await db.close();
  await llm.stop();
});

/** Запуск агента прайсов на файле формы; возвращает итог хода. */
async function runForm(
  form: PriceForm,
  supplier: Parameters<typeof formScript>[1],
  thread: string,
  prompt = 'Разбери прайс',
) {
  llm.begin(formScript(form, supplier, DONE_TEXT));
  const spec = ctx.app.registry.get('prices');
  const result = await ctx.app.runtime
    .run(toRunSpec(spec), thread, prompt)
    .catch((error: unknown) => {
      // Сбой сценария заглушки важнее вторичной ошибки рантайма.
      expect(llm.scriptErrors).toEqual([]);
      throw error;
    });
  expect(llm.scriptErrors).toEqual([]);
  expect(result.status).toBe('completed');
  expect(result.output).toBe(DONE_TEXT);
  return result;
}

/** Сводка последнего runDataScript из тела последнего запроса к модели. */
function scriptSummary(): Record<string, unknown> {
  const last = llm.bodies().at(-1);
  if (last === undefined) throw new Error('модель не вызывалась');
  const run = lastResult(JSON.parse(last) as Record<string, unknown>, 'runDataScript');
  expect(run['ok']).toBe(true);
  const summary = run['summary'];
  if (!isRecord(summary)) throw new Error('в ответе нет сводки');
  return summary;
}

async function expectCleanAndScripted(form: PriceForm): Promise<void> {
  // Скрипт сработал и модели ушла сводка, а не позиции: в запросах нет ПДн шапки файла.
  expect(allToolNames(llm.bodies())).toContain('runDataScript');
  expect(llm.bodies().join('\n')).toMatch(/\[PHONE_\d+\]/);
  await expectNoLeaks({ llm: llm.bodies(), pii: FORM_PII, db });
  expect(form.expected.length).toBeGreaterThan(0);
}

describe('s111: формы прайсов разбираются скриптом', () => {
  for (const form of PRICE_FORMS.filter((item) => item.code !== NEW_SUPPLIER_FORM)) {
    test(`${form.code}: позиции, тиражи и основание тиража`, async () => {
      const supplierId = supplierIdOf(form);
      await runForm(form, { id: supplierId }, `e2e-s111-${form.code}`);
      const summary = scriptSummary();
      expect(summary['accepted']).toBe(true);
      expect(summary['staged']).toBe(form.expected.length);
      expect(summary['scriptVersion']).toBe(1);
      expect(summary['withTiers']).toBe(form.expected.filter((e) => e.tiers.length > 0).length);
      await expectItemsInDb(db, supplierId, form.expected, form.tierBasis);
      await expectCleanAndScripted(form);
    });
  }

  test('boxes: новый поставщик - карточка-черновик, цены, сводка «разобрано скриптом»', async () => {
    const form = PRICE_FORMS.find((item) => item.code === NEW_SUPPLIER_FORM) as PriceForm;
    const thread = `${DISK_SYNC_THREAD_PREFIX}s111-boxes`;
    const state = new PostgresWorkflowStateStore(db);
    const runLabel = '2026-10-27T10:00:00.000Z';
    await queueDiskSyncOutcome(state, thread, runLabel, form.fileName, runLabel);
    const draftId = supplierIdOf(form);
    // Как в поручении тика: поставщика определил код, модель его не ищет и не заводит.
    const prompt = `Поставщик файла уже определён кодом: supplierId=${draftId}. Записывай цены.`;
    await runForm(form, { fromAssignment: true }, thread, prompt);
    const summary = scriptSummary();
    expect(summary['staged']).toBe(form.expected.length);
    const drafts = await db.query('SELECT id FROM suppliers WHERE is_draft');
    expect(drafts.map((row) => row['id'])).toEqual([draftId]);
    await expectItemsInDb(db, draftId, form.expected, form.tierBasis);
    const { outcomes } = await loadDiskSyncOutcomes(state, runLabel);
    expect(outcomes[0]).toMatchObject({ status: 'written', viaScript: true });
    expect(outcomes[0]?.rows).toBe(form.expected.length);
    const text = buildInitialImportSummary(outcomes, false);
    expect(text).toContain('разобрано скриптом: 1');
    await expectCleanAndScripted(form);
  });

  test('сохранённые скрипты лежат за поставщиками (версия 1, автор agent)', async () => {
    const rows = await db.query(
      'SELECT supplier_id, version, created_by FROM supplier_price_scripts',
    );
    expect(rows.length).toBe(PRICE_FORMS.length);
    expect(rows.every((r) => r['version'] === 1 && r['created_by'] === 'agent')).toBe(true);
  });
});
