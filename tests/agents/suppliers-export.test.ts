import { beforeEach, describe, expect, test } from 'bun:test';
import {
  FixedClock,
  MemoryAccessPolicy,
  MemoryDepartmentHeads,
  MemoryDirectoryService,
  MemoryIdempotencyStore,
  MemoryTableExporter,
  RulesAccessPolicy,
} from '@business-ai/adapters';
import { executeTool } from '@business-ai/adapters';
import {
  EXPORT_SUPPLIERS_TOOL,
  SUPPLIER_EXPORT_MAX_ROWS,
  exportSuppliers,
} from '../../src/agents/suppliers/export-suppliers';
import {
  SUPPLIER_TEMPLATE_COLUMNS,
  matchSupplierHeaders,
  resolveSupplierColumn,
} from '../../src/agents/suppliers/supplier-template';
import { cardCellValue } from '../../src/agents/suppliers/card-cells';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import { findSupplierTable } from '../../src/agents/suppliers/import-suppliers-file';
import { resolveOperationKey } from '@business-ai/core';
import { supplierExportTools } from '../../src/agents/suppliers/tools';
import { type SupplierCardsHost } from '../../src/agents/suppliers/deps';
import { ACTION_EXPORT_SUPPLIERS } from '../../src/kit/domain/access.owned';
import { createAccessRulesSchema, evaluateAccess } from '@business-ai/core';
import { testProject } from '@business-ai/testing';
import { type SupplierCard } from '../../src/kit/domain/supplier-card';
import { parseExtraRowFields } from '../../src/agents/suppliers/import-row-fields';
import type {
  ExportedFile,
  JsonValue,
  TableExporter,
  TableFormat,
  TableSheet,
} from '@business-ai/core';
import {
  INN_ALPHA,
  INN_BETA,
  INN_GAMMA,
  SCHEDULER_CONTEXT,
  buildSupplierWorld,
  turnContext,
  validInn,
  type SupplierWorld,
} from './suppliers-support';

/**
 * Выгрузка базы поставщиков в xlsx (этап 215): поля называет сотрудник, значения в модель не
 * идут, право `suppliers.export`, пределы строк и размера, аудит без значений.
 */

// Правила доступа знают действия проекта (suppliers.export) и его ограничения (только
// руководителям отделов), а не одни платформенные.
const KNOWN_ACTIONS = testProject().knownAccessActions;
const RESTRICTIONS = testProject().accessRestrictions;
const accessRulesSchema = createAccessRulesSchema(KNOWN_ACTIONS);

const BOT = 'order-calc';
const USER = 'u-100';
const THREAD = `${BOT}/${USER}`;
const SECRET_PHONE = '+79001112233';
const SECRET_EMAIL = 'sales@alfa.example.ru';

/** Выгрузка таблиц, запоминающая листы: тест видит ровно то, что ушло в файл. */
class RecordingExporter implements TableExporter {
  sheets: TableSheet[] = [];
  async export(
    sheets: readonly TableSheet[],
    format: TableFormat,
    fileName: string,
  ): Promise<ExportedFile> {
    this.sheets = [...sheets];
    return new MemoryTableExporter().export(sheets, format, fileName);
  }
}

let world: SupplierWorld;
let access: MemoryAccessPolicy;
let exporter: RecordingExporter;
let host: SupplierCardsHost;
const ctx = () => turnContext(USER, THREAD, BOT);

function sentFiles(): string[] {
  return world.chat.outbox.flatMap((record) =>
    record.file === undefined ? [] : [record.file.name],
  );
}

/** Поставщик без карточки: выгрузке нужны только id и название. */
async function seedBulk(index: number): Promise<void> {
  const id = `bulk-${String(index).padStart(5, '0')}`;
  await world.suppliers.upsert({ id, name: `П${index}` });
}

async function seedCard(name: string, inn: string, extra: Partial<SupplierCard> = {}) {
  await world.suppliers.saveCard({
    id: `sup-${inn}`,
    name,
    inn,
    status: 'active',
    contacts: [{ fullName: 'Иван', phone: SECRET_PHONE, email: SECRET_EMAIL, isPrimary: true }],
    supplies: { categories: ['крепёж', 'метизы'], brands: ['Bosch'], regions: ['Москва'] },
    terms: { payment: 'предоплата 30%', delivery: 'самовывоз' },
    notes: [],
    ...extra,
  });
}

beforeEach(async () => {
  world = buildSupplierWorld();
  access = new MemoryAccessPolicy();
  access.allow({ userId: USER, botId: BOT, action: ACTION_EXPORT_SUPPLIERS });
  exporter = new RecordingExporter();
  world.deps.access = access;
  world.deps.tableExporter = exporter;
  host = world.host;
  await seedCard('Альфа Металл', INN_ALPHA);
  await seedCard('Бета Упаковка', INN_BETA, {
    status: 'inactive',
    supplies: { categories: ['упаковка'], brands: [], regions: [] },
  });
});

describe('exportSuppliers: поля и синонимы', () => {
  test('синонимы и ключи колонок сопоставляются с колонками шаблона', () => {
    expect(resolveSupplierColumn('телефон')?.key).toBe('phone');
    expect(resolveSupplierColumn('  Почта ')?.key).toBe('email');
    expect(resolveSupplierColumn('ИНН')?.key).toBe('inn');
    expect(resolveSupplierColumn('legalAddress')?.key).toBe('legalAddress');
    expect(resolveSupplierColumn('Условия доставки')?.key).toBe('delivery');
    expect(resolveSupplierColumn('цвет глаз директора')).toBeUndefined();
  });

  test('в файл попадают только названные столбцы, название - первым', async () => {
    const out = await exportSuppliers.execute(
      { fields: ['телефон', 'инн', 'почта'] },
      host,
      ctx(),
    );
    expect(out.status).toBe('sent');
    const [sheet] = exporter.sheets;
    expect(sheet?.columns).toEqual(['Название', 'ИНН', 'Телефон', 'Email']);
    expect(sheet?.rows).toHaveLength(2);
    const alpha = sheet?.rows.find((row) => row[0] === 'Альфа Металл');
    expect(alpha).toEqual(['Альфа Металл', INN_ALPHA, SECRET_PHONE, SECRET_EMAIL]);
    expect(sentFiles()).toEqual([out.fileName ?? '']);
  });

  test('повтор поля и «название» не дублируют столбцы', async () => {
    await exportSuppliers.execute(
      { fields: ['название', 'ИНН', 'inn', 'инн'] },
      host,
      ctx(),
    );
    expect(exporter.sheets[0]?.columns).toEqual(['Название', 'ИНН']);
  });

  test('неизвестное поле: понятный отказ со списком допустимых, файла нет', async () => {
    const run = exportSuppliers.execute({ fields: ['телефон', 'цвет глаз'] }, host, ctx());
    await expect(run).rejects.toMatchObject({ code: 'invalid_input' });
    const message = await run.then(() => '', (error: Error) => error.message);
    expect(message).toContain('цвет глаз');
    expect(message).toContain('Телефон');
    expect(message).toContain('ИНН');
    expect(sentFiles()).toEqual([]);
  });

  test('пустой список полей - отказ', async () => {
    await expect(exportSuppliers.execute({ fields: [] }, host, ctx())).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  test('значения ячеек - в формате шаблона: разбор загрузки читает их обратно', async () => {
    await seedCard('Гамма', INN_GAMMA, {
      agencyDiscountPercent: 7.5,
      vatMode: 'with_vat',
      vatRatePercent: 20,
      samplesAvailable: true,
      supplierKind: 'production_and_branding',
      turnoverByYear: [
        { year: 2025, rub: 150_000_000 },
        { year: 2024, rub: 120_000_000 },
      ],
      okved: '32.99',
      legalEntities: [{ name: 'ООО «Гамма»', inn: INN_ALPHA }],
    });
    const card = await world.suppliers.getCard(`sup-${INN_GAMMA}`);
    if (card === null) throw new Error('карточка не записана');
    const cells = new Map(
      SUPPLIER_TEMPLATE_COLUMNS.map((column) => [column.key, cardCellValue(card, column.key)]),
    );
    const parsed = parseExtraRowFields((key) => {
      const value = cells.get(key);
      return value === null || value === undefined ? undefined : String(value);
    });
    expect(parsed.issues).toEqual([]);
    expect(parsed.fields).toMatchObject({
      agencyDiscountPercent: 7.5,
      vatMode: 'with_vat',
      vatRatePercent: 20,
      samplesAvailable: true,
      okved: '32.99',
      turnoverByYear: card.turnoverByYear,
      legalEntities: [{ name: 'ООО «Гамма»', inn: INN_ALPHA }],
    });
  });

  test('у каждой колонки шаблона есть значение или пусто: ни одна не падает', async () => {
    const card = await world.suppliers.getCard(`sup-${INN_ALPHA}`);
    if (card === null) throw new Error('карточка не записана');
    for (const column of SUPPLIER_TEMPLATE_COLUMNS) {
      expect(() => cardCellValue(card, column.key)).not.toThrow();
    }
  });
});

describe('exportSuppliers: фильтр', () => {
  test('статус и категория сужают выгрузку', async () => {
    await exportSuppliers.execute({ fields: ['инн'], status: 'inactive' }, host, ctx());
    expect(exporter.sheets[0]?.rows.map((row) => row[0])).toEqual(['Бета Упаковка']);
    await exportSuppliers.execute({ fields: ['инн'], category: 'КРЕПЁЖ' }, host, ctx());
    expect(exporter.sheets[0]?.rows.map((row) => row[0])).toEqual(['Альфа Металл']);
  });

  test('ничего не нашлось: файла нет, отказ not_found (не кэшируется), аудит empty', async () => {
    await expect(
      exportSuppliers.execute({ fields: ['инн'], query: 'нет такого' }, host, ctx()),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(sentFiles()).toEqual([]);
    expect((await world.audit.list()).map((entry) => entry.result)).toEqual(['empty']);
  });
});

describe('exportSuppliers: значения не идут в модель', () => {
  test('результат содержит счётчики и имя файла, но не значения ячеек', async () => {
    const out = await exportSuppliers.execute(
      { fields: ['телефон', 'почта', 'инн'] },
      host,
      ctx(),
    );
    const json = JSON.stringify(out);
    expect(json).not.toContain(SECRET_PHONE);
    expect(json).not.toContain(SECRET_EMAIL);
    expect(json).not.toContain(INN_ALPHA);
    expect(json).not.toContain('Альфа');
    expect(out).toMatchObject({ status: 'sent', rows: 2 });
    expect(out.fileName).toEndWith('.xlsx');
  });
});

describe('exportSuppliers: права', () => {
  test('нет права suppliers.export - отказ, файла и данных в ответе нет', async () => {
    world.deps.access = new MemoryAccessPolicy();
    await expect(
      exportSuppliers.execute({ fields: ['телефон'] }, host, ctx()),
    ).rejects.toMatchObject({ code: 'access_denied' });
    expect(sentFiles()).toEqual([]);
    expect(exporter.sheets).toEqual([]);
    const [entry] = await world.audit.list();
    expect(entry).toMatchObject({ action: 'suppliers.export', result: 'denied' });
  });

  describe('руководители отделов через политику (этап 234)', () => {
    function rulesPolicy(heads: MemoryDepartmentHeads): RulesAccessPolicy {
      const rules = accessRulesSchema.parse({
        version: 1,
        bots: { [BOT]: { allow: { users: [USER] } } },
      });
      return new RulesAccessPolicy(rules, new MemoryDirectoryService(), KNOWN_ACTIONS, {
        heads,
        restrictions: RESTRICTIONS,
      });
    }

    test('руководитель получает файл', async () => {
      const heads = new MemoryDepartmentHeads();
      heads.set(USER);
      world.deps.access = rulesPolicy(heads);
      const out = await exportSuppliers.execute({ fields: ['телефон'] }, host, ctx());
      expect(out.status).toBe('sent');
    });

    test('допущенный к боту не руководитель: отказ с понятным текстом, файла нет', async () => {
      world.deps.access = rulesPolicy(new MemoryDepartmentHeads());
      const error = await exportSuppliers
        .execute({ fields: ['телефон'] }, host, ctx())
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'access_denied' });
      const message = String((error as Error).message);
      expect(message).toContain('только руководителям отделов');
      expect(message).not.toContain(USER);
      expect(sentFiles()).toEqual([]);
      expect(exporter.sheets).toEqual([]);
    });

    test('справочник руководителей недоступен: отказ, текст про временный сбой', async () => {
      const heads = new MemoryDepartmentHeads();
      heads.set(USER);
      heads.failing = true;
      world.deps.access = rulesPolicy(heads);
      const error = await exportSuppliers
        .execute({ fields: ['телефон'] }, host, ctx())
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'access_denied' });
      expect(String((error as Error).message)).toContain('временный сбой');
      expect(sentFiles()).toEqual([]);
    });
  });

  test('право другого бота не помогает', async () => {
    const other = new MemoryAccessPolicy();
    other.allow({ userId: USER, botId: 'prices', action: ACTION_EXPORT_SUPPLIERS });
    world.deps.access = other;
    await expect(
      exportSuppliers.execute({ fields: ['телефон'] }, host, ctx()),
    ).rejects.toMatchObject({ code: 'access_denied' });
  });

  test('нет политики прав - отказ not_configured (fail closed)', async () => {
    world.deps.access = undefined;
    await expect(
      exportSuppliers.execute({ fields: ['телефон'] }, host, ctx()),
    ).rejects.toMatchObject({ code: 'not_configured' });
    expect(sentFiles()).toEqual([]);
  });

  test('плановый запуск - отказ и запись в аудите (не ход сотрудника)', async () => {
    await expect(
      exportSuppliers.execute({ fields: ['телефон'] }, host, SCHEDULER_CONTEXT),
    ).rejects.toMatchObject({ code: 'access_denied' });
    const [entry] = await world.audit.list();
    expect(entry).toMatchObject({
      action: 'suppliers.export',
      actor: 'system:scheduler',
      result: 'not_employee_turn',
    });
  });

  describe('только руководителям отделов (этап 234)', () => {
    const decide = (
      rules: ReturnType<typeof accessRulesSchema.parse>,
      userId: string,
      isDepartmentHead: boolean | undefined,
      bot = BOT,
    ) =>
      evaluateAccess(
        rules,
        { userId, groups: [], isDepartmentHead },
        bot,
        ACTION_EXPORT_SUPPLIERS,
        KNOWN_ACTIONS,
        RESTRICTIONS,
      );

    test('нет правила действия: руководитель допущен, не руководитель и неизвестный - нет', () => {
      const rules = accessRulesSchema.parse({
        version: 1,
        bots: { [BOT]: { allow: { users: ['boss', 'clerk'] } } },
      });
      expect(ACTION_EXPORT_SUPPLIERS).toBe('suppliers.export');
      expect(decide(rules, 'boss', true).allowed).toBe(true);
      expect(decide(rules, 'clerk', false).reason).toBe('not_department_head');
      // Признак не получен: закрыто, а не «допущен к боту - значит можно».
      expect(decide(rules, 'clerk', undefined).reason).toBe('not_department_head');
    });

    test('руководитель, не допущенный к боту, выгрузку не получает', () => {
      const rules = accessRulesSchema.parse({
        version: 1,
        bots: { [BOT]: { allow: { users: ['boss'] } } },
      });
      expect(decide(rules, 'stranger', true).reason).toBe('not_in_allow_list');
    });

    test('явный запрет сильнее признака руководителя', () => {
      const rules = accessRulesSchema.parse({
        version: 1,
        bots: {
          [BOT]: {
            allow: { users: ['boss', 'clerk'] },
            actions: { [ACTION_EXPORT_SUPPLIERS]: { deny: { users: ['clerk'] } } },
          },
        },
      });
      expect(decide(rules, 'boss', true).allowed).toBe(true);
      expect(decide(rules, 'clerk', true).reason).toBe('explicit_deny');
    });

    test('allow правила действия только сужает круг руководителей; пустой - rule_empty', () => {
      const rules = accessRulesSchema.parse({
        version: 1,
        bots: {
          [BOT]: {
            allow: { users: ['boss', 'clerk'] },
            actions: { [ACTION_EXPORT_SUPPLIERS]: { allow: { users: ['boss'] } } },
          },
          empty: {
            allow: { users: ['boss'] },
            actions: { [ACTION_EXPORT_SUPPLIERS]: { allow: {} } },
          },
        },
      });
      expect(decide(rules, 'boss', true).allowed).toBe(true);
      expect(decide(rules, 'clerk', true).reason).toBe('action_not_permitted');
      expect(decide(rules, 'boss', true, 'empty').reason).toBe('rule_empty');
    });

    test('другие действия по-прежнему наследуют допуск бота', () => {
      const rules = accessRulesSchema.parse({
        version: 1,
        bots: { [BOT]: { allow: { users: ['boss'] } } },
      });
      expect(
        evaluateAccess(rules, { userId: 'boss', groups: [] }, BOT, 'chat.message', KNOWN_ACTIONS)
          .allowed,
      )
        .toBe(true);
    });
  });
});

describe('exportSuppliers: пределы', () => {
  test('строк больше предела - понятный ответ, файл не отправляется', async () => {
    const saved = Array.from({ length: SUPPLIER_EXPORT_MAX_ROWS + 1 }, (_, index) => index);
    for (const index of saved) {
      await seedBulk(index);
    }
    const run = exportSuppliers.execute({ fields: ['инн'] }, host, ctx());
    await expect(run).rejects.toMatchObject({ code: 'invalid_input' });
    const message = await run.then(() => '', (error: Error) => error.message);
    expect(message).toContain(String(SUPPLIER_EXPORT_MAX_ROWS));
    expect(sentFiles()).toEqual([]);
    expect((await world.audit.list()).map((entry) => entry.result)).toEqual(['too_many_rows']);
  });

  test('ровно предел строк проходит', async () => {
    const extra = SUPPLIER_EXPORT_MAX_ROWS - 2;
    for (let index = 0; index < extra; index += 1) {
      await seedBulk(index);
    }
    const out = await exportSuppliers.execute({ fields: ['инн'] }, host, ctx());
    expect(out).toMatchObject({ status: 'sent', rows: SUPPLIER_EXPORT_MAX_ROWS });
  });

  test('файл больше предела размера - понятный ответ, файл не отправляется', async () => {
    const huge: TableExporter = {
      export: async () => ({
        fileName: 'x.xlsx',
        mimeType: 'application/octet-stream',
        bytes: new Uint8Array(2 * 1024 * 1024 + 1),
      }),
    };
    world.deps.tableExporter = huge;
    await expect(exportSuppliers.execute({ fields: ['инн'] }, host, ctx())).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(sentFiles()).toEqual([]);
    expect((await world.audit.list()).map((entry) => entry.result)).toEqual(['too_large']);
  });

  test('нет выгрузки таблиц - not_configured', async () => {
    world.deps.tableExporter = undefined;
    await expect(exportSuppliers.execute({ fields: ['инн'] }, host, ctx())).rejects.toMatchObject({
      code: 'not_configured',
    });
  });
});

describe('exportSuppliers: аудит без значений', () => {
  test('записываются действие, число строк и поля; значений нет', async () => {
    await exportSuppliers.execute(
      { fields: ['телефон', 'инн'], category: 'крепёж', status: 'active' },
      host,
      ctx(),
    );
    const [entry] = await world.audit.list();
    expect(entry).toMatchObject({
      action: 'suppliers.export',
      actor: `user:${USER}`,
      agent: BOT,
      result: 'ok',
    });
    expect(entry?.details).toContain('rows=1');
    expect(entry?.details).toContain('phone');
    expect(entry?.details).toContain('inn');
    expect(entry?.details).toContain('category');
    const dump = JSON.stringify(entry);
    for (const secret of [SECRET_PHONE, SECRET_EMAIL, INN_ALPHA, 'Альфа', 'крепёж']) {
      expect(dump).not.toContain(secret);
    }
  });

  test('сбой аудита не отменяет уже отправленный файл', async () => {
    world.deps.audit = {
      append: async () => {
        throw new Error('аудит недоступен');
      },
      list: async () => [],
    };
    const events: string[] = [];
    world.deps.log = (event) => void events.push(event);
    const out = await exportSuppliers.execute({ fields: ['инн'] }, host, ctx());
    expect(out.status).toBe('sent');
    expect(sentFiles()).toHaveLength(1);
    expect(events).toContain('supplier_export_audit_failed');
  });
});

describe('exportSuppliers: тред, ключ и кэш повтора через рантайм', () => {
  /** Ход сотрудника для рантайма (без идентификатора операции - его строит рантайм). */
  function turnOf(userId: string, turnNumber = 1) {
    const { operationId: _unused, ...turn } = turnContext(userId, `${BOT}/${userId}`, BOT);
    return { ...turn, turnNumber };
  }
  let store: MemoryIdempotencyStore;
  const run = (
    input: Record<string, unknown>,
    turn = turnOf(USER),
  ): Promise<JsonValue> =>
    executeTool(
      {
        agentId: BOT,
        deps: host,
        validators: [],
        idempotency: store,
        inFlight: new Map(),
      },
      exportSuppliers,
      input,
      { turn },
    );
  beforeEach(() => {
    store = new MemoryIdempotencyStore();
  });

  test('файл уходит в тред хода сотрудника', async () => {
    await exportSuppliers.execute({ fields: ['инн'] }, host, ctx());
    const file = world.chat.outbox.find((record) => record.file !== undefined);
    expect(file?.threadId).toBe(THREAD);
  });

  test('ключ зависит от сотрудника и реплики, даже если тред один', async () => {
    const input = { fields: ['инн'] };
    const keyOf = (userId: string, turnNumber: number) =>
      resolveOperationKey(
        exportSuppliers,
        input,
        host,
        THREAD,
        '',
        // Форма хода прежней платформы (объект); нынешняя передаёт только номер реплики.
        { initiator: { kind: 'user', userId }, turnNumber } as unknown as number,
      );
    expect(await keyOf('u-100', 1)).not.toBe(await keyOf('u-200', 1));
    expect(await keyOf('u-100', 1)).not.toBe(await keyOf('u-100', 2));
    expect(await keyOf('u-100', 1)).toBe(await keyOf('u-100', 1));
  });

  // ПРОБЕЛ ПЛАТФОРМЫ: ключ повтора платформы не знает исполнителя (в предшественника приходит
  // только номер реплики), поэтому проверка ждёт правки платформы. См. «Решения владельца».
  test.todo('успешный результат одного сотрудника не отдаётся другому в том же треде', async () => {
    access.allow({ userId: 'u-200', botId: BOT, action: ACTION_EXPORT_SUPPLIERS });
    const shared = (userId: string) => ({ ...turnOf(userId), threadId: THREAD });
    await run({ fields: ['инн'] }, shared(USER));
    const second = await run({ fields: ['инн'] }, shared('u-200'));
    expect(second).toMatchObject({ status: 'sent' });
    expect(second).not.toHaveProperty('fresh');
    expect(sentFiles()).toHaveLength(2);
  });

  test('отказ по правам не кэшируется: после выдачи права тот же запрос даёт файл', async () => {
    world.deps.access = new MemoryAccessPolicy();
    const denied = await run({ fields: ['инн'] });
    expect(denied).toMatchObject({ code: 'access_denied' });
    expect(sentFiles()).toEqual([]);
    const granted = new MemoryAccessPolicy();
    granted.allow({ userId: USER, botId: BOT, action: ACTION_EXPORT_SUPPLIERS });
    world.deps.access = granted;
    const sent = await run({ fields: ['инн'] });
    expect(sent).toMatchObject({ status: 'sent' });
    expect(sent).not.toHaveProperty('fresh');
    expect(sentFiles()).toHaveLength(1);
  });

  test('пустая выборка не кэшируется: после появления поставщика файл собирается', async () => {
    const input = { fields: ['инн'], query: 'Омега' };
    expect(await run(input)).toMatchObject({ code: 'not_found' });
    await seedCard('Омега', INN_GAMMA);
    expect(await run(input)).toMatchObject({ status: 'sent', rows: 1 });
  });

  test('превышение предела строк не кэшируется: после сужения базы файл уходит', async () => {
    const input = { fields: ['инн'] };
    for (let index = 0; index < SUPPLIER_EXPORT_MAX_ROWS; index += 1) await seedBulk(index);
    expect(await run(input)).toMatchObject({ code: 'invalid_input' });
    world.deps.suppliers = buildSupplierWorld().suppliers;
    await world.deps.suppliers.upsert({ id: 'only', name: 'Единственный' });
    expect(await run(input)).toMatchObject({ status: 'sent', rows: 1 });
  });

  test('повтор в той же реплике не шлёт дубль, даже если часы ушли за окно', async () => {
    const clock = world.clock;
    const first = await run({ fields: ['инн'] });
    expect(first).toMatchObject({ status: 'sent' });
    // Повтор после падения процесса: часы ушли на 15 минут, реплика та же.
    clock.advance(15 * 60 * 1000);
    const again = await run({ fields: ['инн'] });
    expect(again).toMatchObject({ status: 'sent', fresh: false });
    expect(sentFiles()).toHaveLength(1);
  });

  test('новая реплика сотрудника - свежая выгрузка', async () => {
    await run({ fields: ['инн'] }, turnOf(USER, 1));
    await run({ fields: ['инн'] }, turnOf(USER, 2));
    expect(sentFiles()).toHaveLength(2);
  });

  test('часы не входят в ключ: граница повтора - реплика хода, а не текущее время', async () => {
    const input = { fields: ['инн'] };
    const keyAt = async (clock: FixedClock) => {
      world.deps.clock = clock;
      return resolveOperationKey(exportSuppliers, input, host, THREAD, '', {
        initiator: { kind: 'user', userId: USER },
        turnNumber: 1,
      } as unknown as number);
    };
    const early = await keyAt(new FixedClock(new Date('2026-05-04T09:00:00.000Z')));
    const late = await keyAt(new FixedClock(new Date('2026-05-04T09:59:00.000Z')));
    expect(late).toBe(early);
  });
});

describe('exportSuppliers: опознающие столбцы и обратная загрузка', () => {
  /** Заголовки первого листа файла, отправленного в чат (CSV заглушки выгрузки). */
  function sentHeaderCells(): string[] {
    const file = world.chat.outbox.find((record) => record.file !== undefined)?.file;
    if (file === undefined) throw new Error('файл не отправлен');
    const lines = new TextDecoder().decode(file.content).split('\n');
    return (lines[1] ?? '').split(';');
  }

  test.each([['сайт'], ['инн'], ['название'], ['телефон'], ['условия оплаты']])(
    'выгрузка «%s»: первые столбцы Название и ИНН, файл узнаётся как шаблон',
    async (field) => {
      await exportSuppliers.execute({ fields: [field] }, host, ctx());
      const header = sentHeaderCells();
      expect(header.slice(0, 2)).toEqual(['Название', 'ИНН']);
      expect(matchSupplierHeaders(header)).not.toBeNull();
    },
  );

  test('разбор листа из файла находит таблицу поставщиков и строки данных', async () => {
    await exportSuppliers.execute({ fields: ['инн'] }, host, ctx());
    const file = world.chat.outbox.find((record) => record.file !== undefined)?.file;
    const lines = new TextDecoder().decode(file?.content).split('\n').slice(1);
    const table = lines.map((line) => line.split(';'));
    const found = findSupplierTable([table]);
    expect(found).not.toBeNull();
    expect(found?.rows).toHaveLength(2);
  });
});

describe('exportSuppliers: формулы не двоятся', () => {
  test('значения и заголовки уходят в сервис как есть, без видимого апострофа', async () => {
    await seedCard('=HYPERLINK("http://x")', INN_GAMMA, { strengths: '+7 надёжный' });
    await exportSuppliers.execute({ fields: ['сильные стороны'] }, host, ctx());
    const [sheet] = exporter.sheets;
    const row = sheet?.rows.find((cells) => String(cells[1]) === INN_GAMMA);
    expect(row?.[0]).toBe('=HYPERLINK("http://x")');
    expect(row?.[2]).toBe('+7 надёжный');
    for (const cell of [...(sheet?.columns ?? []), ...(sheet?.rows.flat() ?? [])]) {
      if (typeof cell === 'string') expect(cell.startsWith("'")).toBe(false);
    }
  });
});

describe('exportSuppliers: обход базы', () => {
  test('база длиннее предела обхода: отказ, а не молчаливое усечение', async () => {
    let pages = 0;
    world.deps.suppliers = {
      ...world.suppliers,
      listPage: async (after: string | null, limit: number) => {
        pages += 1;
        return Array.from({ length: limit }, (_, index) => ({
          id: `p${pages}-${index}`,
          name: `П${index}`,
        }));
      },
      getCards: async () => [],
    } as unknown as typeof world.deps.suppliers;
    const failing = exportSuppliers.execute({ fields: ['инн'] }, host, ctx());
    await expect(failing).rejects.toMatchObject({ code: 'invalid_input' });
    expect(sentFiles()).toEqual([]);
    expect((await world.audit.list()).map((entry) => entry.result)).toEqual(['too_many_rows']);
  });
});

describe('exportSuppliers: размер оценивается до сборки файла', () => {
  test('сумма длин ячеек больше предела: файл не собирается', async () => {
    // Заметки с разным текстом: одинаковые хранилище схлопывает в одну.
    const notes = Array.from({ length: 20 }, (_, index) => ({
      text: `${'я'.repeat(1_990)}${String(index).padStart(2, '0')}`,
      authorId: 'u-1',
      createdAt: '2026-05-04T09:00:00.000Z',
    }));
    for (let index = 0; index < 100; index += 1) {
      await seedCard(`Тяжёлый ${index}`, validInn(String(500000000 + index)), { notes });
    }
    await expect(
      exportSuppliers.execute({ fields: ['note'] }, host, ctx()),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(exporter.sheets).toEqual([]);
    expect(sentFiles()).toEqual([]);
    expect((await world.audit.list()).map((entry) => entry.result)).toEqual(['too_large']);
  });
});

describe('exportSuppliers: группы полей и неоднозначные названия', () => {
  test('«контакты» - ФИО, телефон и почта', async () => {
    await exportSuppliers.execute({ fields: ['контакты'] }, host, ctx());
    expect(exporter.sheets[0]?.columns).toEqual([
      'Название',
      'ИНН',
      'ФИО контакта',
      'Телефон',
      'Email',
    ]);
  });

  test('«реквизиты» - ИНН, КПП, ОГРН, банк, БИК и счета', async () => {
    await exportSuppliers.execute({ fields: ['реквизиты'] }, host, ctx());
    const columns = exporter.sheets[0]?.columns ?? [];
    for (const title of ['КПП', 'ОГРН', 'Банк', 'БИК', 'Расчётный счёт', 'Корр. счёт']) {
      expect(columns).toContain(title);
    }
    expect(columns.slice(0, 2)).toEqual(['Название', 'ИНН']);
  });

  test('группа и отдельное поле схлопываются без повторов', async () => {
    await exportSuppliers.execute({ fields: ['контакты', 'телефон', 'инн'] }, host, ctx());
    const columns = exporter.sheets[0]?.columns ?? [];
    expect(new Set(columns).size).toBe(columns.length);
  });

  test.each([['адрес'], ['Адреса'], ['счёт'], ['скидки'], ['условия']])(
    '«%s» неоднозначно: отказ с короткой подсказкой, файла нет',
    async (field) => {
      const failing = exportSuppliers.execute({ fields: [field] }, host, ctx());
      await expect(failing).rejects.toMatchObject({ code: 'invalid_input' });
      const message = await failing.then(() => '', (error: Error) => error.message);
      expect(message).toContain('уточни');
      expect(message).not.toContain('Должность');
      expect(message.length).toBeLessThan(400);
      expect(sentFiles()).toEqual([]);
    },
  );

  test('подсказка по «адрес» называет варианты', async () => {
    const message = await exportSuppliers
      .execute({ fields: ['адрес'] }, host, ctx())
      .then(() => '', (error: Error) => error.message);
    expect(message).toContain('Юридический адрес');
    expect(message).toContain('Адрес склада');
  });

  test('ключ колонки без неоднозначности принимается как есть', async () => {
    await exportSuppliers.execute({ fields: ['legalAddress'] }, host, ctx());
    expect(exporter.sheets[0]?.columns).toContain('Юридический адрес');
  });
});

describe('exportSuppliers: без черновиков', () => {
  test('столбца «Проверка» нет, даже у автоматически созданной карточки', async () => {
    await seedCard('Автоматическая', INN_GAMMA, {});
    await exportSuppliers.execute({ fields: ['телефон'] }, host, ctx());
    expect(exporter.sheets[0]?.columns).not.toContain('Проверка');
  });

  test('обычные карточки: столбца нет', async () => {
    await exportSuppliers.execute({ fields: ['телефон'] }, host, ctx());
    expect(exporter.sheets[0]?.columns).not.toContain('Проверка');
  });
});

describe('exportSuppliers: аудит отказов и порядок с отправкой', () => {
  test('повтор отказа с тем же идентификатором операции - одна запись', async () => {
    world.deps.access = new MemoryAccessPolicy();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await exportSuppliers.execute({ fields: ['инн'] }, host, ctx()).catch(() => undefined);
    }
    expect((await world.audit.list()).map((entry) => entry.result)).toEqual(['denied']);
  });

  test('повтор успешной операции: файл один, запись аудита ok одна', async () => {
    await exportSuppliers.execute({ fields: ['инн'] }, host, ctx());
    await exportSuppliers.execute({ fields: ['инн'] }, host, ctx());
    expect(sentFiles()).toHaveLength(1);
    expect((await world.audit.list()).map((entry) => entry.result)).toEqual(['ok']);
  });

  test('отправка файла упала: записи ok нет, повтор отправляет и записывает один раз', async () => {
    const realSend = world.chat.sendFile.bind(world.chat);
    let fail = true;
    world.chat.sendFile = async (...args: Parameters<typeof realSend>) => {
      if (fail) throw new Error('канал недоступен');
      return realSend(...args);
    };
    await expect(exportSuppliers.execute({ fields: ['инн'] }, host, ctx())).rejects.toThrow();
    expect(await world.audit.list()).toEqual([]);
    fail = false;
    await exportSuppliers.execute({ fields: ['инн'] }, host, ctx());
    expect(sentFiles()).toHaveLength(1);
    expect((await world.audit.list()).map((entry) => entry.result)).toEqual(['ok']);
  });

  test('ход не сотрудника: запись об отказе без значений', async () => {
    await exportSuppliers
      .execute({ fields: ['телефон'] }, host, SCHEDULER_CONTEXT)
      .catch(() => undefined);
    const [entry] = await world.audit.list();
    expect(entry?.result).toBe('not_employee_turn');
    expect(entry?.details).toContain('rows=0');
  });
});

describe('регистрация инструмента', () => {
  test('без опции supplierExport инструмента у агента нет', () => {
    const names = createOrderCalcAgent({ model: 'm', supplierCards: {} }).tools.map(
      (tool) => tool.name,
    );
    expect(names).not.toContain(EXPORT_SUPPLIERS_TOOL);
  });

  test('с опцией supplierExport инструмент и строка промпта есть', () => {
    const declaration = createOrderCalcAgent({
      model: 'm',
      supplierCards: {},
      supplierExport: true,
    });
    expect(declaration.tools.map((tool) => tool.name)).toContain(EXPORT_SUPPLIERS_TOOL);
    expect(declaration.prompt).toContain(EXPORT_SUPPLIERS_TOOL);
    expect(supplierExportTools().map((tool) => tool.name)).toEqual([EXPORT_SUPPLIERS_TOOL]);
  });

  test('опция выключена: промпт агента прежний', () => {
    const base = createOrderCalcAgent({ model: 'm', supplierCards: {} }).prompt;
    const off = createOrderCalcAgent({ model: 'm', supplierCards: {}, supplierExport: false });
    expect(off.prompt).toBe(base);
  });
});
