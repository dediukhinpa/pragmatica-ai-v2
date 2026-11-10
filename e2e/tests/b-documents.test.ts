import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgClient } from '@business-ai/adapters';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import { toRunSpec } from '@business-ai/core';
import { docxText } from '@business-ai/testing/e2e';
import { buildApp, e2eEnv, openDb, OWN_COMPANY, resetScenarioTables } from '../lib/project-env';
import type { E2eApp } from '../lib/project-env';
import {
  isRecord,
  lastResult,
  LlmStub,
  userTexts,
  type StubScript,
} from '@business-ai/testing/e2e';
import { BUYER_PII } from '../lib/pii.owned';
import { findLeaks, REAL_PHONE } from '@business-ai/testing/e2e';

const THREAD = 'e2e-documents-thread';
const WEB_THREAD = 'e2e-documents-web-thread';
const REAL_BUYER = 'ИП Сидоров Алексей Николаевич';
const TOKEN_PATTERN = /\[[A-Z_]+_\d+\]/g;
const UNIT_PRICES: Readonly<Record<string, number>> = {
  'Арматура А500С d12': 62000,
  'Лист стальной 3 мм': 71000,
};

/** Позиции КП, как их назвал сотрудник в чате: источник данных документа - чат. */
const ITEMS = [
  { name: 'Арматура А500С d12', quantity: 10, unit: 'т' },
  { name: 'Лист стальной 3 мм', quantity: 4, unit: 'т' },
];
/** Отметки источников: всё из чата, кроме покупателя в веб-сценарии (см. ниже). */
const CHAT_SOURCES = {
  buyer: 'employee',
  seller: 'employee',
  lines: 'employee',
  total: 'employee',
} as const;

const llm = new LlmStub();
let db: PgClient;
let ctx: E2eApp;

/** Токен нужного вида из первого сообщения менеджера (модель видит только токены). */
function tokenOf(body: Record<string, unknown>, kind: string): string {
  const text = userTexts(body)[0] ?? '';
  const found = (text.match(TOKEN_PATTERN) ?? []).find((token) => token.startsWith(`[${kind}_`));
  if (found === undefined) throw new Error(`В запросе менеджера нет токена ${kind}: «${text}»`);
  return found;
}

/** Документ из данных чата; покупатель собран из токенов, а не из настоящих значений. */
function buildDocument(
  body: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  buyerSource: 'employee' | 'web' = 'employee',
): Record<string, unknown> {
  const lines = ITEMS.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    unitPrice: UNIT_PRICES[item.name] ?? 0,
  }));
  const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  return {
    id: 'doc-1',
    kind: 'commercial_offer',
    number: 'КП-2026-001',
    buyer: `${tokenOf(body, 'PERSON')}, тел. ${tokenOf(body, 'PHONE')}`,
    seller: OWN_COMPANY,
    lines,
    total,
    currency: 'RUB',
    issuedAt: '2026-10-01',
    fieldSources: { ...CHAT_SOURCES, buyer: buyerSource },
    ...extra,
  };
}

function chosenTemplate(body: Record<string, unknown>): string {
  const templates = lastResult(body, 'findTemplate')['templates'];
  const first = Array.isArray(templates) ? templates[0] : undefined;
  const path = isRecord(first) ? first['path'] : undefined;
  if (typeof path !== 'string') throw new Error('findTemplate не нашёл шаблон');
  return path;
}

/** Сценарий модели: шаблон -> проверка -> заполнение -> выпуск (всё из чата). */
const script: StubScript = ({ index, body }) => {
  switch (index) {
    case 0:
      return {
        kind: 'tool',
        name: 'findTemplate',
        input: { query: 'коммерческое предложение', kind: 'commercial_offer' },
      };
    case 1:
      return { kind: 'tool', name: 'validateDocument', input: { document: buildDocument(body) } };
    case 2:
      return {
        kind: 'tool',
        name: 'fillTemplate',
        input: { templatePath: chosenTemplate(body), document: buildDocument(body) },
      };
    case 3:
      return {
        kind: 'tool',
        name: 'saveDocument',
        input: { templatePath: chosenTemplate(body), document: buildDocument(body) },
      };
    default:
      return { kind: 'text', text: 'Документ выпущен.' };
  }
};

beforeAll(async () => {
  db = openDb();
  await resetScenarioTables(db);
  // Продавец — собственное юрлицо из конфигурации; в базе поставщиков его нет.
  await new PostgresSupplierRepository(db).upsert({ id: 'sup-x', name: 'ООО Другой' });
  llm.start(e2eEnv().llmPort);
  llm.begin(script);
  ctx = buildApp();
});

afterAll(async () => {
  await ctx.app.close();
  await db.close();
  await llm.stop();
});

describe('сценарий b: документы', () => {
  test('агент подбирает шаблон, проверяет, заполняет и выпускает документ', async () => {
    const spec = ctx.app.registry.get('documents');
    const input =
      'Подготовь коммерческое предложение: арматура А500С d12 - 10 т по 62000, ' +
      'лист стальной 3 мм - 4 т по 71000. ' +
      `Покупатель: ${REAL_BUYER}, тел. ${REAL_PHONE}. Продавец: ${OWN_COMPANY}.`;
    const result = await ctx.app.runtime.run(toRunSpec(spec), THREAD, input);
    expect(llm.scriptErrors).toEqual([]);
    expect(result.status).toBe('completed');
    expect(result.output).toBe('Документ выпущен.');
    expect(llm.requests.length).toBe(5);
  });

  test('подобран шаблон КП, а не договор; проверка документа прошла без замечаний', async () => {
    const last = JSON.parse(llm.bodies()[4] ?? '{}') as Record<string, unknown>;
    const found = lastResult(last, 'findTemplate')['templates'];
    expect(Array.isArray(found) && found.length).toBe(1);
    expect(JSON.stringify(found)).toContain('Коммерческое предложение шаблон.docx');
    expect(lastResult(last, 'validateDocument')).toEqual({ ok: true, issues: [] });
    expect(lastResult(last, 'saveDocument')['delivered']).toBe(true);
  });

  test('итоговый docx содержит настоящие значения, восстановленные из токенов', () => {
    const files = ctx.chat.outbox.filter((item) => item.file !== undefined);
    expect(files.length).toBe(1);
    expect(files[0]?.threadId).toBe(THREAD);
    const text = docxText(files[0]?.file?.content ?? new Uint8Array());
    expect(text).toContain(REAL_BUYER);
    expect(text).toContain(REAL_PHONE);
    expect(text).toContain(OWN_COMPANY);
    expect(text).toContain('КП-2026-001');
    expect(text).toContain('Арматура А500С d12');
    // 10 * 62000 + 4 * 71000 = 904000
    expect(text).toContain('904000');
    expect(text).not.toContain('{{');
    expect(text).not.toMatch(TOKEN_PATTERN);
  });

  test('заглушка LLM видела только токены: ни ФИО, ни телефона покупателя', () => {
    expect(findLeaks(llm.bodies(), BUYER_PII)).toEqual([]);
    const all = llm.bodies().join('\n');
    expect(all).toMatch(/\[PERSON_\d+\]/);
    expect(all).toMatch(/\[PHONE_\d+\]/);
  });

  test('сделка и CRM не используются: заметок в сделки не пишется', () => {
    expect(ctx.crm.notes.size).toBe(0);
  });
});

/**
 * Сценарий: покупатель найден в интернете; сначала без подтверждения (отказ), затем модель
 * спрашивает сотрудника текстом (кнопок нет), ход заканчивается. Сотрудник отвечает в чате,
 * модель записывает решение инструментом, и документ собирается.
 */
let webTemplate = '';
let webDocument: Record<string, unknown> = {};
const webScript: StubScript = ({ index, body }) => {
  switch (index) {
    case 0:
      return {
        kind: 'tool',
        name: 'findTemplate',
        input: { query: 'коммерческое предложение', kind: 'commercial_offer' },
      };
    case 1:
      // Шаблон и документ запоминаем: во втором ходе (ответ сотрудника) история первого хода
      // модели не передаётся, а токены покупателя в треде те же.
      webTemplate = chosenTemplate(body);
      webDocument = buildDocument(body, {}, 'web');
      return {
        kind: 'tool',
        name: 'saveDocument',
        input: { templatePath: webTemplate, document: webDocument },
      };
    case 2:
      return { kind: 'tool', name: 'askToConfirmWebFields', input: { document: webDocument } };
    case 3:
      return { kind: 'text', text: 'Жду подтверждения данных из интернета.' };
    // Ход 2: сотрудник ответил «подтверждаю».
    case 4:
      return {
        kind: 'tool',
        name: 'recordWebFieldsDecision',
        input: { document: webDocument, decision: 'confirmed' },
      };
    case 5:
      return {
        kind: 'tool',
        name: 'saveDocument',
        input: { templatePath: webTemplate, document: webDocument },
      };
    default:
      return { kind: 'text', text: 'Документ выпущен после подтверждения.' };
  }
};

describe('сценарий b: поля из интернета', () => {
  test('без подтверждения документ не собирается, с подтверждением - уходит в чат', async () => {
    llm.begin(webScript);
    const filesBefore = ctx.chat.outbox.filter((item) => item.file !== undefined).length;
    const spec = ctx.app.registry.get('documents');
    const input =
      'Подготовь коммерческое предложение: арматура А500С d12 - 10 т по 62000, ' +
      'лист стальной 3 мм - 4 т по 71000. Данные покупателя возьми из интернета: ' +
      `${REAL_BUYER}, тел. ${REAL_PHONE}. Продавец: ${OWN_COMPANY}.`;
    const result = await ctx.app.runtime.run(toRunSpec(spec), WEB_THREAD, input);
    expect(llm.scriptErrors).toEqual([]);
    // Модель спросила текстом и закончила ход.
    expect(result.status).toBe('completed');
    const afterBlock = JSON.parse(llm.bodies()[2] ?? '{}') as Record<string, unknown>;
    expect(JSON.stringify(afterBlock)).toContain('web_fields_unconfirmed');
    // С 03.11 (коммит 52f510d3, решение владельца) неподтверждённые поля из интернета - не отказ,
    // а предупреждение: документ собирается сразу, подтверждение его не задерживает.
    expect(ctx.chat.outbox.filter((item) => item.file !== undefined).length).toBe(filesBefore + 1);
    // Вопрос ушёл в тред диалога текстом с примерами ответа (этап 164), кнопок нет.
    const asked = ctx.chat.outbox
      .filter((item) => item.threadId === WEB_THREAD && item.message !== undefined)
      .map((item) => item.message);
    const question = asked.find((message) => message?.text.includes('Взято из интернета'));
    if (question === undefined) throw new Error('вопрос о полях из интернета не показан');
    expect(question.text).toContain('«подтверждаю»');
    expect(question.buttons ?? []).toHaveLength(0);
    // Ответ сотрудника: личность и тред из события канала, решение записывает код по вызову
    // инструмента в ходе сотрудника.
    const employee = { context: { initiator: { kind: 'user', userId: 'e2e-employee' } } } as const;
    const resumed = await ctx.app.runtime.run(
      toRunSpec(spec),
      WEB_THREAD,
      'подтверждаю',
      employee,
    );
    expect(llm.scriptErrors).toEqual([]);
    expect(resumed.status).toBe('completed');
    const filesAfter = ctx.chat.outbox.filter((item) => item.file !== undefined);
    // После подтверждения документ пересобран без предупреждения web_fields_unconfirmed;
    // все файлы идут в тред этого диалога.
    const finalBody = JSON.parse(llm.bodies().at(-1) ?? '{}') as Record<string, unknown>;
    expect(JSON.stringify(lastResult(finalBody, 'saveDocument'))).not.toContain(
      'web_fields_unconfirmed',
    );
    expect(filesAfter.length - filesBefore).toBeGreaterThanOrEqual(1);
    expect(filesAfter.at(-1)?.threadId).toBe(WEB_THREAD);
  });
});
