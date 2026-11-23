import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFile, unlink } from 'node:fs/promises';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import { type PgClient } from '@business-ai/adapters';
import { createAutoSupplierCard } from '../../src/agents/suppliers/draft-card';
import { toRunSpec } from '@business-ai/core';
import { FULL_SUPPLIER } from '../../tests/kit/support/supplier-fixtures';
import { buildApp, e2eEnv, openDb, resetScenarioTables } from '../lib/project-env';
import type { E2eApp } from '../lib/project-env';
import { isRecord, toolResults, LlmStub, type StubScript } from '@business-ai/testing/e2e';

/**
 * Сценарий y1 (этап 105, темы 1 и 4): «Документы» с `DOCUMENTS_ENABLED_KINDS=contract` и
 * `SUPPLIER_CARDS_ENABLED`. Настоящая боевая сборка, Postgres и сервис documents; модель - скрипт.
 *  - договоры и NDA готовятся: шаблон NDA находится, `prepareSupplierDocument` собирает NDA;
 *  - счёт и закрывающие отклоняются кодом понятным сообщением, схема инструментов не меняется;
 *  - у агента есть карточки поставщиков (поиск и «покажи черновики»), реквизиты черновика
 *    выходят с предупреждением «реквизиты не проверены»;
 *  - без флага карточек инструментов карточек у «Документов» нет.
 */

const THREAD = 'e2e-documents-contracts-thread';
const NDA_FILE = 'МГ Соглашение NDA.docx';
const OFFER_FILE = 'Коммерческое предложение шаблон.docx';
const DISABLED_TEXT = 'Сейчас агент готовит только договоры и NDA';
const DRAFT_NAME = 'ООО Квазар Черновик Документов';
const NDA_FIELDS = {
  seller_representative: 'директора Иванова И. И.',
  seller_position: 'директор',
  seller_authority_basis: 'Устава',
  nda_penalty_amount: '50000',
  contract_number: '15/26',
  contract_date: '2026-10-01',
};
const CARD_TOOLS = ['findSupplierCard', 'prepareSupplierCard', 'confirmSupplierRequest'];
const ISSUED_AT = '2026-10-21';
const SUPPLIER_TEMPLATE_RELATIVE = 'docs/templates/supplier-template.xlsx';

const llm = new LlmStub();
let db: PgClient;
let ctx: E2eApp;
let draftId = '';

/** Путь шаблона NDA из ответа findTemplate (шаг 0). */
function ndaPath(body: Record<string, unknown>): string {
  const first = toolResults(body).get('findTemplate')?.[0];
  const match = isRecord(first) ? first['match'] : undefined;
  const template = isRecord(match) ? match['template'] : undefined;
  const path = isRecord(template) ? template['path'] : undefined;
  if (typeof path !== 'string') throw new Error('findTemplate не нашёл шаблон NDA');
  return path;
}

const script: StubScript = ({ index, body }) => {
  switch (index) {
    case 0:
      return { kind: 'tool', name: 'findTemplate', input: { query: 'NDA', kind: 'contract' } };
    case 1:
      return { kind: 'tool', name: 'findTemplate', input: { query: 'счёт', kind: 'invoice' } };
    case 2:
      return {
        kind: 'tool',
        name: 'prepareSupplierDocument',
        input: {
          kind: 'closing',
          requestId: 'req-y',
          supplierId: FULL_SUPPLIER.id,
          number: '1',
          issuedAt: ISSUED_AT,
        },
      };
    case 3:
      return {
        kind: 'tool',
        name: 'prepareSupplierDocument',
        input: {
          kind: 'contract',
          supplierId: FULL_SUPPLIER.id,
          templatePath: ndaPath(body),
          issuedAt: ISSUED_AT,
          templateFields: NDA_FIELDS,
        },
      };
    case 4:
      return { kind: 'tool', name: 'findSupplierCard', input: { query: DRAFT_NAME } };
    case 5:
      return { kind: 'tool', name: 'getSupplierRequisites', input: { supplierId: draftId } };
    default:
      return { kind: 'text', text: 'Проверка завершена.' };
  }
};

beforeAll(async () => {
  db = openDb();
  await resetScenarioTables(db);
  const suppliers = new PostgresSupplierRepository(db);
  await suppliers.upsert(FULL_SUPPLIER);
  const draft = await createAutoSupplierCard(
    suppliers,
    { name: DRAFT_NAME },
    { userId: 'price-agent', nowIso: ISSUED_AT, origin: 'прайс.xlsx' },
  );
  draftId = draft.card.id;
  // Шаблон NDA кладётся в корень шаблонов под именем из реестра (содержимое не важно для поиска).
  const { templatesRoot } = e2eEnv();
  await copyFile(`${templatesRoot}/${OFFER_FILE}`, `${templatesRoot}/${NDA_FILE}`);
  llm.start(e2eEnv().llmPort);
  llm.begin(script);
  ctx = buildApp(new Map(), {
    DOCUMENTS_ENABLED_KINDS: 'contract',
    SUPPLIER_CARDS_ENABLED: 'true',
    PAIR_NOTES_ENABLED: 'true',
    SUPPLIER_TEMPLATE_PATH: `${process.env['E2E_PROJECT_ROOT'] ?? ''}/${SUPPLIER_TEMPLATE_RELATIVE}`,
  });
});

afterAll(async () => {
  // Копия шаблона NDA убирается: общий каталог шаблонов нужен соседним сценариям без неё.
  await unlink(`${e2eEnv().templatesRoot}/${NDA_FILE}`);
  await ctx.app.close();
  await db.close();
  await llm.stop();
});

describe('сценарий y: «Документы» только с договорами и NDA, карточки поставщиков', () => {
  test('ход агента: NDA готовится, счёт и закрывающие отклонены, черновик с предупреждением', async () => {
    const spec = ctx.app.registry.get('documents');
    const result = await ctx.app.runtime.run(
      toRunSpec(spec),
      THREAD,
      'Подготовь NDA с поставщиком, проверь счёт и закрывающие, покажи черновики карточек.',
    );
    expect(llm.scriptErrors).toEqual([]);
    expect(result.status).toBe('completed');
    const last = JSON.parse(llm.bodies().at(-1) ?? '{}') as Record<string, unknown>;
    const results = toolResults(last);

    // NDA: шаблон найден, отказа по виду нет, документ собран из карточки.
    const nda = results.get('findTemplate')?.[0];
    expect(isRecord(nda) ? nda['disabledReason'] : 'нет ответа').toBeUndefined();
    expect(JSON.stringify(nda)).toContain(NDA_FILE);
    const prepared = results.get('prepareSupplierDocument')?.[1];
    expect(JSON.stringify(prepared)).not.toContain(DISABLED_TEXT);
    expect(isRecord(prepared) ? prepared['ready'] : null).toBe(true);

    // Счёт и закрывающие: отказ кодом с понятным сообщением, шаблонов не отдано.
    const invoice = results.get('findTemplate')?.[1];
    expect(isRecord(invoice) ? invoice['disabledReason'] : '').toContain(DISABLED_TEXT);
    expect(isRecord(invoice) ? invoice['templates'] : null).toEqual([]);
    const closing = results.get('prepareSupplierDocument')?.[0];
    expect(isRecord(closing) ? closing['ready'] : null).toBe(false);
    expect(JSON.stringify(closing)).toContain(DISABLED_TEXT);

    // Карточки у «Документов»: автоматически созданная карточка находится без пометки.
    const found = results.get('findSupplierCard')?.[0];
    expect(JSON.stringify(found)).toContain(DRAFT_NAME);
    expect(JSON.stringify(found)).not.toContain('не проверено');

    // Реквизиты автоматической карточки: поля `unverified` в ответе больше нет (78052fb4,
    // черновиков нет), предупреждения «не проверены» тоже.
    const requisites = results.get('getSupplierRequisites')?.[0];
    expect(isRecord(requisites) ? requisites['unverified'] : null).toBeUndefined();
    expect(JSON.stringify(requisites)).not.toContain('реквизиты не проверены');
  });

  test('схемы и состав инструментов: карточки есть, виды в схеме все (флаг её не меняет)', () => {
    const names = ctx.app.registry.get('documents').tools.map((tool) => tool.name);
    for (const name of CARD_TOOLS) expect(names).toContain(name);
    const find = ctx.app.registry.get('documents').tools.find((t) => t.name === 'findTemplate');
    const schema = JSON.stringify((find?.inputSchema as unknown as { shape: unknown }).shape);
    for (const kind of ['commercial_offer', 'invoice', 'contract', 'closing']) {
      expect(schema).toContain(kind);
    }
  });

  test('приветствие и промпт: только договоры и NDA', () => {
    const spec = ctx.app.registry.get('documents');
    const text = [spec.prompt, spec.greeting?.role, ...(spec.greeting?.examples ?? [])]
      .join('\n')
      .toLowerCase();
    expect(text).toContain('договоры и nda');
    for (const word of ['коммерческ', 'закрывающ', 'invoice']) expect(text).not.toContain(word);
  });

  test('без SUPPLIER_CARDS_ENABLED инструментов карточек у «Документов» нет', async () => {
    const plain = buildApp(new Map(), { DOCUMENTS_ENABLED_KINDS: 'contract' });
    try {
      const names = plain.app.registry.get('documents').tools.map((tool) => tool.name);
      for (const name of CARD_TOOLS) expect(names).not.toContain(name);
    } finally {
      await plain.app.close();
    }
  });
});
