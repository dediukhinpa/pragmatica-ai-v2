import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgClient } from '@business-ai/adapters';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import { noteEmployeeMessage } from '../../src/agents/documents/employee-messages';
import { toRunSpec } from '@business-ai/core';
import { buildApp, e2eEnv, openDb, OWN_COMPANY, resetScenarioTables } from '../lib/project-env';
import type { E2eApp } from '../lib/project-env';
import { isRecord, lastResult, LlmStub, type StubScript } from '@business-ai/testing/e2e';

const THREAD_OK = 'e2e-employee-requisite-thread';
const THREAD_NO = 'e2e-employee-requisite-missing-thread';
const THREAD_ABSENT = 'e2e-employee-requisite-absent-thread';
const THREAD_DIVERGE = 'e2e-employee-requisite-diverge-thread';
const SUPPLIER_ID = 'sup-employee';
const SUPPLIER_NAME = 'МеталлТорг';
/** Подписанта нет в карточке: его присылает сотрудник. */
const DIRECTOR = 'Сидоров Сергей Петрович';
/** Настоящие публичные реквизиты: контрольные суммы сходятся. */
const CARD = {
  inn: '7707083893',
  kpp: '773601001',
  ogrn: '1027700132195',
  legalAddress: 'г. Москва, ул. Вавилова, 19',
  bankName: 'ПАО Сбербанк',
  bik: '044525225',
  settlementAccount: '40702810200000000001',
  correspondentAccount: '30101810400000000225',
};
const SOURCE_MARK = 'со слов сотрудника';

const llm = new LlmStub();
let db: PgClient;
let ctx: E2eApp;

/** Другой настоящий ИНН (контрольная сумма сходится): расходится с карточкой. */
const OTHER_INN = '7736050003';

function contract(overrides: Record<string, string> = {}): Record<string, unknown> {
  return {
    id: 'doc-emp-1',
    kind: 'contract',
    number: 'Д-1',
    buyer: OWN_COMPANY,
    seller: SUPPLIER_NAME,
    supplierId: SUPPLIER_ID,
    lines: [{ name: 'Арматура А500С d12', quantity: 10, unitPrice: 62000 }],
    total: 620000,
    currency: 'RUB',
    issuedAt: '2026-10-01',
    requisites: { ...CARD, directorName: DIRECTOR, ...overrides },
    fieldSources: {
      buyer: 'employee',
      seller: 'knowledge',
      lines: 'employee',
      total: 'employee',
      requisites: 'knowledge',
      'requisites.directorName': 'employee',
    },
  };
}

function chosenTemplate(body: Record<string, unknown>): string {
  const templates = lastResult(body, 'findTemplate')['templates'];
  const first = Array.isArray(templates) ? templates[0] : undefined;
  const path = isRecord(first) ? first['path'] : undefined;
  if (typeof path !== 'string') throw new Error('findTemplate не нашёл шаблон');
  return path;
}

/** Модель: шаблон договора, затем передача на проверку (отметка employee ставится моделью). */
function scriptFor(document: () => Record<string, unknown>): StubScript {
  return ({ index, body }) => {
    if (index === 0) {
      return {
        kind: 'tool',
        name: 'findTemplate',
        input: { query: 'договор поставки', kind: 'contract' },
      };
    }
    if (index === 1) {
      return {
        kind: 'tool',
        name: 'handoffForReview',
        input: { templatePath: chosenTemplate(body), document: document() },
      };
    }
    return { kind: 'text', text: 'Готово.' };
  };
}

const script: StubScript = ({ index, body }) => {
  if (index === 0) {
    return {
      kind: 'tool',
      name: 'findTemplate',
      input: { query: 'договор поставки', kind: 'contract' },
    };
  }
  if (index === 1) {
    return {
      kind: 'tool',
      name: 'handoffForReview',
      input: { templatePath: chosenTemplate(body), document: contract() },
    };
  }
  return { kind: 'text', text: 'Готово.' };
};

const sentTo = (threadId: string) => ctx.chat.outbox.filter((item) => item.threadId === threadId);

/**
 * С 03.11 (коммит 6f99cf0a, решение владельца) в чат уходит только файл, а чек-лист приходит
 * модели в `message` результата инструмента: итог сотруднику пишет одно сообщение модели.
 * Поэтому тексты про «со слов» проверяем в `message`, а в чате - что кроме файла ничего нет.
 */
function modelMessage(handed: Record<string, unknown>): string {
  const message = handed['message'];
  if (typeof message !== 'string') throw new Error('handoffForReview не вернул message');
  return message;
}

function chatText(threadId: string): string {
  return sentTo(threadId)
    .map((item) => item.message?.text ?? '')
    .join('\n');
}

beforeAll(async () => {
  db = openDb();
  await resetScenarioTables(db);
  // Карточка без подписанта: остальные реквизиты есть.
  await new PostgresSupplierRepository(db).upsert({
    id: SUPPLIER_ID,
    name: SUPPLIER_NAME,
    ...CARD,
  });
  llm.start(e2eEnv().llmPort);
  ctx = buildApp();
});

afterAll(async () => {
  await ctx.app.close();
  await db.close();
  await llm.stop();
});

describe('сценарий b: реквизиты, присланные сотрудником', () => {
  test('нет в карточке, прислан в чате: договор передан «со слов сотрудника»', async () => {
    llm.begin(script);
    const text =
      `Подготовь договор Д-1 с ${SUPPLIER_NAME}, арматура А500С d12 - 10 т по 62000. ` +
      `Подписант у них ${DIRECTOR}, в карточке его нет, впиши.`;
    // Как обработчик входящих сообщений чата: текст запоминается до запуска агента.
    await noteEmployeeMessage(ctx.app.workflowState, THREAD_OK, text);
    const spec = ctx.app.registry.get('documents');
    const result = await ctx.app.runtime.run(toRunSpec(spec), THREAD_OK, text);
    expect(llm.scriptErrors).toEqual([]);
    expect(result.status).toBe('completed');
    const last = JSON.parse(llm.bodies().at(-1) ?? '{}') as Record<string, unknown>;
    const handed = lastResult(last, 'handoffForReview');
    expect(handed['status']).toBe('awaiting_review');
    const outbox = sentTo(THREAD_OK);
    expect(outbox.filter((item) => item.file !== undefined).length).toBe(1);
    expect(chatText(THREAD_OK)).toBe('');
    const message = modelMessage(handed);
    expect(message).toContain('с ваших слов');
    expect(message).toContain('подписант');
    expect(message).toContain('не подписан');
    expect(JSON.stringify(handed['checklist'])).toContain(SOURCE_MARK);
  });

  test('значения нет в сообщениях, но модель отметила employee: предупреждение, файл', async () => {
    llm.begin(script);
    const text = `Подготовь договор Д-1 с ${SUPPLIER_NAME}, арматура А500С d12 - 10 т по 62000.`;
    await noteEmployeeMessage(ctx.app.workflowState, THREAD_NO, text);
    await ctx.app.runtime.run(toRunSpec(ctx.app.registry.get('documents')), THREAD_NO, text);
    expect(llm.scriptErrors).toEqual([]);
    const last = JSON.parse(llm.bodies().at(-1) ?? '{}') as Record<string, unknown>;
    expect(JSON.stringify(last)).toContain('requisite_not_in_base');
    // С 01.11 (коммит 06379dd6) пропуски и расхождения с базой - предупреждения: договор
    // выдаётся, а замечание идёт первым в чек-листе (блокируют только арифметика и веб-данные).
    const handed = lastResult(last, 'handoffForReview');
    expect(handed['status']).toBe('awaiting_review');
    const checklist = Array.isArray(handed['checklist']) ? handed['checklist'] : [];
    const warnings = checklist.filter((item) => isRecord(item) && item['topic'] === 'warnings');
    expect(JSON.stringify(warnings)).toContain('подписант');
    const outbox = sentTo(THREAD_NO);
    expect(outbox.filter((item) => item.file !== undefined)).toHaveLength(1);
  });

  // Решение владельца: значение вносится в документ, но сотрудник получает обязательное
  // предупреждение; источник пункта чек-листа подменяет код, а не отметка модели.
  test('значение не из базы и не из сообщений: внесено в документ с предупреждением', async () => {
    llm.begin(script);
    const text = `Подготовь договор Д-1 с ${SUPPLIER_NAME}, арматура А500С d12 - 10 т по 62000.`;
    await noteEmployeeMessage(ctx.app.workflowState, THREAD_ABSENT, text);
    await ctx.app.runtime.run(toRunSpec(ctx.app.registry.get('documents')), THREAD_ABSENT, text);
    expect(llm.scriptErrors).toEqual([]);
    const last = JSON.parse(llm.bodies().at(-1) ?? '{}') as Record<string, unknown>;
    const handed = lastResult(last, 'handoffForReview');
    expect(handed['status']).toBe('awaiting_review');
    const checklist = Array.isArray(handed['checklist']) ? handed['checklist'] : [];
    // Предупреждение есть и обещает именно то, что происходит: «внесено», не «не вносят».
    const warnings = JSON.stringify(
      checklist.filter((item) => isRecord(item) && item['topic'] === 'warnings'),
    );
    expect(warnings).toContain('подписант');
    expect(warnings).toContain('внесено со слов сотрудника, в базе не подтверждено');
    expect(warnings).not.toContain('не вносят');
    // Значение внесено в документ: пункт чек-листа несёт его вместе с честным источником.
    // В результате инструмента для модели ФИО псевдонимизировано, поэтому ищем по названию;
    // само значение проверяем ниже в сообщении сотруднику (там реальный текст).
    const signer = checklist.find(
      (item) => isRecord(item) && item['topic'] === 'requisites' && item['label'] === 'подписант',
    );
    expect(isRecord(signer)).toBe(true);
    expect(isRecord(signer) ? signer['source'] : undefined).toBe(
      'внесено со слов сотрудника, в базе не подтверждено',
    );
    const outbox = sentTo(THREAD_ABSENT);
    expect(outbox.filter((item) => item.file !== undefined)).toHaveLength(1);
    // Чек-лист модели псевдонимизирован (ФИО не доходит до неё), в чат кроме файла ничего нет.
    expect(chatText(THREAD_ABSENT)).toBe('');
    const message = modelMessage(handed);
    expect(message).toContain('подписант');
    expect(message).not.toContain(DIRECTOR);
    expect(message).toContain('не подтверждено');
  });

  // Решение владельца: расходящееся с карточкой значение тоже вносится, но с предупреждением
  // и значением из карточки; подписант (нет в карточке, нет в чате) по-прежнему с замечанием.
  test('значение расходится с карточкой и не из сообщений: внесено с предупреждением', async () => {
    llm.begin(scriptFor(() => contract({ inn: OTHER_INN })));
    const text = `Подготовь договор Д-1 с ${SUPPLIER_NAME}, арматура А500С d12 - 10 т по 62000.`;
    await noteEmployeeMessage(ctx.app.workflowState, THREAD_DIVERGE, text);
    await ctx.app.runtime.run(toRunSpec(ctx.app.registry.get('documents')), THREAD_DIVERGE, text);
    expect(llm.scriptErrors).toEqual([]);
    const last = JSON.parse(llm.bodies().at(-1) ?? '{}') as Record<string, unknown>;
    const handed = lastResult(last, 'handoffForReview');
    expect(handed['status']).toBe('awaiting_review');
    const checklist = Array.isArray(handed['checklist']) ? handed['checklist'] : [];
    const note = 'внесено со слов сотрудника, отличается от карточки поставщика';
    const warnings = JSON.stringify(
      checklist.filter((item) => isRecord(item) && item['topic'] === 'warnings'),
    );
    expect(warnings).toContain(note);
    // Модель видит ИНН карточки псевдонимом ([INN_n]), настоящие цифры в её запрос не уходят.
    expect(warnings).toMatch(/в карточке: \[INN_\d+\]/);
    expect(warnings).not.toContain(CARD.inn);
    expect(warnings).toContain('подписант');
    const inn = checklist.find(
      (item) => isRecord(item) && item['topic'] === 'requisites' && item['label'] === 'ИНН',
    );
    const innSource = isRecord(inn) ? String(inn['source']) : '';
    expect(innSource).toStartWith(`${note} (в карточке: `);
    expect(innSource).not.toContain(CARD.inn);
    const outbox = sentTo(THREAD_DIVERGE);
    expect(outbox.filter((item) => item.file !== undefined)).toHaveLength(1);
    // Чек-лист идёт модели (6f99cf0a): в нём пометка о расхождении без настоящих цифр.
    expect(chatText(THREAD_DIVERGE)).toBe('');
    const message = modelMessage(handed);
    expect(message).toContain('отличается от карточки поставщика');
    expect(message).toContain('в карточке: ');
    expect(message).not.toContain(OTHER_INN);
  });
});
