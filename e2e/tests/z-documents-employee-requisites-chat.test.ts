import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgClient } from '@business-ai/adapters';
import { isRecord, lastResult, LlmStub, type StubScript } from '@business-ai/testing/e2e';
import { DOCUMENTS_AGENT_ID } from '../../src/agents/documents/deps';
import {
  EMPLOYEE_TEXT_NAMESPACE,
  readEmployeeText,
} from '../../src/agents/documents/employee-messages';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import {
  BOT_DOCUMENTS,
  startBitrixWorld,
  writeBitrixRules,
  type BitrixWorld,
} from '../lib/bitrix24-world';
import { resetHandoffTables } from '../lib/handoff-core';
import { e2eEnv, openDb, OWN_COMPANY } from '../lib/project-env';

/**
 * Сценарий z: реквизит из сообщения сотрудника ДО агента «Подготовка документов» идёт настоящим
 * путём: сообщение в канале Bitrix24 (заглушка портала) -> насос -> хук манифеста
 * `chat.onIncoming` (`projectOnIncoming` в `src/chat-hooks.ts`) -> запись текста в состояние
 * треда -> ход агента -> проверка «реквизит прислал сам сотрудник». Соседний
 * `b-documents-employee-requisites` вызывает `noteEmployeeMessage` вручную и гоняет
 * `runtime.run` напрямую, поэтому путь через канал не проверяет; без хука сценарий красный.
 */

const SUPPLIER_ID = 'sup-employee-chat';
const SUPPLIER_NAME = 'МеталлТорг';
/** Подписанта нет в карточке: его присылает сотрудник. */
const DIRECTOR = 'Сидоров Сергей Петрович';
/** Первое слово ФИО в нормализованном (нижний регистр) тексте треда. */
const DIRECTOR_NORMALIZED = 'сидоров сергей петрович';
/** Сотрудник, приславший подписанта, и сотрудник без подписанта (отрицательный контроль). */
const USER_WITH_SIGNER = 2001;
const USER_WITHOUT_SIGNER = 2002;
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
const NOT_CONFIRMED_MARK = 'внесено со слов сотрудника, в базе не подтверждено';
/** Финальная реплика заглушки модели: по ней видно, что ход агента закончен. */
const DONE_TEXT = 'Готово.';

const llm = new LlmStub();
let db: PgClient;
let rules = '';
const worlds: BitrixWorld[] = [];

function contract(): Record<string, unknown> {
  return {
    id: 'doc-emp-chat-1',
    kind: 'contract',
    number: 'Д-1',
    buyer: OWN_COMPANY,
    seller: SUPPLIER_NAME,
    supplierId: SUPPLIER_ID,
    lines: [{ name: 'Арматура А500С d12', quantity: 10, unitPrice: 62000 }],
    total: 620000,
    currency: 'RUB',
    issuedAt: '2026-10-01',
    requisites: { ...CARD, directorName: DIRECTOR },
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
  return { kind: 'text', text: DONE_TEXT };
};

/** Запустить мир на заглушке портала: бот документов, допуск двух сотрудников. */
async function start(): Promise<BitrixWorld> {
  const world = await startBitrixWorld({ rules });
  worlds.push(world);
  return world;
}

/** Сообщение сотрудника боту документов и ожидание конца хода (файл и итог модели). */
async function ask(world: BitrixWorld, userId: number, text: string): Promise<void> {
  const employee = world.employee(userId);
  await employee.say(BOT_DOCUMENTS, text);
  await employee.waitFile(BOT_DOCUMENTS, () => true);
  await employee.waitText(BOT_DOCUMENTS, DONE_TEXT);
}

/** Результат `handoffForReview` из последнего запроса к модели. */
function handedOver(): Record<string, unknown> {
  expect(llm.scriptErrors).toEqual([]);
  const last = JSON.parse(llm.bodies().at(-1) ?? '{}') as Record<string, unknown>;
  const handed = lastResult(last, 'handoffForReview');
  expect(handed['status']).toBe('awaiting_review');
  return handed;
}

function checklistOf(handed: Record<string, unknown>): unknown[] {
  return Array.isArray(handed['checklist']) ? handed['checklist'] : [];
}

/** Пункт чек-листа «подписант» (тема requisites). */
function signerItem(handed: Record<string, unknown>): Record<string, unknown> {
  const found = checklistOf(handed).find(
    (item) => isRecord(item) && item['topic'] === 'requisites' && item['label'] === 'подписант',
  );
  if (!isRecord(found)) throw new Error('в чек-листе нет пункта «подписант»');
  return found;
}

/** Сколько записей пространства текста сотрудника лежит в БД для треда. */
async function storedRecords(threadId: string): Promise<number> {
  const rows = await db.query(
    'SELECT count(*)::int AS n FROM workflow_state WHERE namespace = $1 AND key = $2',
    [EMPLOYEE_TEXT_NAMESPACE, threadId],
  );
  return Number(rows[0]?.['n']);
}

beforeAll(async () => {
  db = openDb();
  llm.start(e2eEnv().llmPort);
  rules = await writeBitrixRules('z-docs-employee-chat', {
    [DOCUMENTS_AGENT_ID]: { users: [String(USER_WITH_SIGNER), String(USER_WITHOUT_SIGNER)] },
  });
});

beforeEach(async () => {
  // Состояние целиком: вместе с текстом сотрудников сбрасывается и курсор опроса портала, иначе
  // новый портал (нумерация событий с нуля) не отдал бы событий второго мира.
  await resetHandoffTables(db);
  // Карточка без подписанта: остальные реквизиты есть.
  await new PostgresSupplierRepository(db).upsert({
    id: SUPPLIER_ID,
    name: SUPPLIER_NAME,
    ...CARD,
  });
  llm.begin(script);
});

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.dispose();
});

afterAll(async () => {
  await db.close();
  await llm.stop();
});

describe('сценарий z: реквизиты сотрудника через канал чата и мост проекта', () => {
  test('подписант назван в сообщении: проверка проходит, текст записан в состояние', async () => {
    const world = await start();
    const thread = world.employee(USER_WITH_SIGNER).threadOf(BOT_DOCUMENTS);
    await ask(
      world,
      USER_WITH_SIGNER,
      `Подготовь договор Д-1 с ${SUPPLIER_NAME}, арматура А500С d12 - 10 т по 62000. ` +
        `Подписант у них ${DIRECTOR}, в карточке его нет, впиши.`,
    );
    const handed = handedOver();
    // Источник пункта - «со слов сотрудника» без пометки «в базе не подтверждено».
    const source = String(signerItem(handed)['source']);
    expect(source).toContain(SOURCE_MARK);
    expect(source).not.toContain(NOT_CONFIRMED_MARK);
    expect(JSON.stringify(handed['checklist'])).toContain(SOURCE_MARK);
    const warnings = checklistOf(handed).filter(
      (item) => isRecord(item) && item['topic'] === 'warnings',
    );
    expect(JSON.stringify(warnings)).not.toContain(NOT_CONFIRMED_MARK);
    // В состоянии треда - запись с нормализованным текстом сообщения сотрудника.
    expect(await storedRecords(thread)).toBe(1);
    expect(await readEmployeeText(world.app.workflowState, thread)).toContain(DIRECTOR_NORMALIZED);
    // Сотруднику ушёл файл договора и итог модели.
    expect(world.employee(USER_WITH_SIGNER).files(BOT_DOCUMENTS)).toHaveLength(1);
  });

  test('подписанта в сообщении нет: предупреждение «не из базы и не из сообщений»', async () => {
    const world = await start();
    const thread = world.employee(USER_WITHOUT_SIGNER).threadOf(BOT_DOCUMENTS);
    await ask(
      world,
      USER_WITHOUT_SIGNER,
      `Подготовь договор Д-1 с ${SUPPLIER_NAME}, арматура А500С d12 - 10 т по 62000.`,
    );
    const handed = handedOver();
    const warnings = JSON.stringify(
      checklistOf(handed).filter((item) => isRecord(item) && item['topic'] === 'warnings'),
    );
    expect(warnings).toContain('подписант');
    expect(warnings).toContain(NOT_CONFIRMED_MARK);
    expect(String(signerItem(handed)['source'])).toBe(NOT_CONFIRMED_MARK);
    // Сообщение записано (мост работает), но подписанта в нём нет.
    expect(await storedRecords(thread)).toBe(1);
    const stored = await readEmployeeText(world.app.workflowState, thread);
    expect(stored).toContain('подготовь договор');
    expect(stored).not.toContain(DIRECTOR_NORMALIZED);
  });
});
