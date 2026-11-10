import { beforeEach, describe, expect, test } from 'bun:test';
import {
  MemoryAccessPolicy,
  MemoryFileAuthorship,
  MemoryFileSource,
  MemoryScheduler,
  MemoryStaffDirectory,
} from '@business-ai/adapters';
import { PRICES_AGENT_ID } from '../../src/agents/prices/deps';
import {
  PRICE_DISK_SYNC_MAX_FILES,
  PRICE_DISK_SYNC_RUN_TASK,
  runPriceDiskSync,
} from '../../src/agents/prices/price-disk-sync';
import { answerPriceFileSupplier } from '../../src/agents/prices/answer-price-file-supplier';
import { extractPriceHeader, supplierFolderName } from '../../src/agents/prices/disk-sync-supplier';
import { fileRefOf } from '../../src/agents/prices/file-ref';
import { recordEmployeeContact } from '@business-ai/core';
import { isDomainError, type StaffPerson } from '@business-ai/core';
import type { IdGenerator } from '@business-ai/core';
import {
  RESPONSIBLE_THREAD,
  buildFullPricesDeps,
  encode,
  type FullPricesDeps,
} from './prices-support';
import { CTX, FILE_REF_SECRET, SUPPLIER_ID } from './support';
import { SwitchableAccess } from './suppliers-support';

let counter = 0;
const ids: IdGenerator = { next: (prefix = 'id') => `${prefix}-${(counter += 1)}` };
const MTIME = 1_000;
const BODY = 'Наименование,Цена\nБолт,';

let deps: FullPricesDeps;
let scheduler: MemoryScheduler;
let sequence = 0;

/** Файл на диске; содержимое у каждого своё (хэш файла ключ идемпотентности). */
const put = (path: string, header = ''): void => {
  sequence += 1;
  const text = `${header}${header === '' ? '' : '\n'}${BODY}${sequence}`;
  (deps.files as MemoryFileSource).put(path, encode(text), MTIME);
};
const queued = async (): Promise<string[]> =>
  (await scheduler.claimDue(new Date('2100-01-01T00:00:00Z')))
    .filter((task) => task.name === PRICE_DISK_SYNC_RUN_TASK)
    .map((task) => task.payload);
const questions = (): string[] =>
  deps.chat.outbox
    .filter((item) => item.threadId === RESPONSIBLE_THREAD)
    .map((item) => item.message?.text ?? '');
const allSuppliers = () => deps.suppliers.listPage(null, 100);
const HEAD_CTX = {
  ...CTX,
  threadId: RESPONSIBLE_THREAD,
  initiator: { kind: 'user', userId: 'u-boss' },
} as const;

beforeEach(async () => {
  deps = await buildFullPricesDeps();
  scheduler = new MemoryScheduler(ids);
  await runPriceDiskSync(deps, scheduler);
});

describe('поставщик файла с диска определяет код', () => {
  test('поставщик есть: импорт на него, без вопросов и новых карточек', async () => {
    put('produkciya/МеталлТорг/прайс.csv');
    const result = await runPriceDiskSync(deps, scheduler);
    expect(result).toMatchObject({ enqueued: 1, suppliersCreated: 0, suppliersAsked: 0 });
    expect((await queued())[0]).toContain(`supplierId=${SUPPLIER_ID}`);
    expect(questions()).toEqual([]);
    expect(await allSuppliers()).toHaveLength(1);
  });

  test('нет, название из папки: черновик и импорт, без сообщений', async () => {
    put('produkciya/Ромашка/прайс.csv');
    const result = await runPriceDiskSync(deps, scheduler);
    expect(result).toMatchObject({ enqueued: 1, suppliersCreated: 1, suppliersAsked: 0 });
    const draft = (await allSuppliers()).find((item) => item.name === 'Ромашка');
    expect(draft).toBeDefined();
    expect(await deps.suppliers.getCard(draft?.id ?? '')).not.toHaveProperty('isDraft');
    expect((await queued())[0]).toContain(`supplierId=${draft?.id}`);
    expect(questions()).toEqual([]);
  });

  test('нет, название и ИНН из шапки: черновик с ИНН', async () => {
    put('Разное/прайс.csv', 'Поставщик: ООО «Лотос», ИНН 7707083893\n');
    const result = await runPriceDiskSync(deps, scheduler);
    expect(result).toMatchObject({ enqueued: 1, suppliersCreated: 1 });
    const draft = (await allSuppliers()).find((item) => item.name.includes('Лотос'));
    expect(draft?.inn).toBe('7707083893');
    expect(questions()).toEqual([]);
  });

  test('поставщик находится по ИНН из шапки, даже если папка другая', async () => {
    await deps.suppliers.upsert({ id: 's-inn', name: 'Вектор', inn: '7707083893' });
    put('Разное/прайс.csv', 'ИНН 7707083893\n');
    await runPriceDiskSync(deps, scheduler);
    expect((await queued())[0]).toContain('supplierId=s-inn');
    expect(await allSuppliers()).toHaveLength(2);
  });

  test('совпало несколько поставщиков: вопрос с вариантами, импорта и карточки нет', async () => {
    await deps.suppliers.upsert({ id: 's-r1', name: 'Ромашка' });
    await deps.suppliers.upsert({ id: 's-r2', name: 'ООО «Ромашка»' });
    put('produkciya/Ромашка/прайс.csv');
    const result = await runPriceDiskSync(deps, scheduler);
    expect(result).toMatchObject({ enqueued: 0, suppliersCreated: 0, suppliersAsked: 1 });
    expect(await queued()).toEqual([]);
    const [text] = questions();
    expect(text).toContain('не удалось определить поставщика');
    expect(text).toContain('Возможно: Ромашка, ООО «Ромашка».');
    expect(await allSuppliers()).toHaveLength(3);
  });

  test('только имя файла: вопрос, карточки нет', async () => {
    put('Ромашка прайс.csv');
    const result = await runPriceDiskSync(deps, scheduler);
    expect(result).toMatchObject({ enqueued: 0, suppliersCreated: 0, suppliersAsked: 1 });
    expect(questions()).toHaveLength(1);
    expect(questions()[0]).toContain('«Ромашка прайс.csv»');
    expect(questions()[0]).not.toContain('Возможно');
    expect(await allSuppliers()).toHaveLength(1);
  });

  test('повторный тик: вопрос не дублируется, карточек нет, файл ждёт', async () => {
    put('Ромашка прайс.csv');
    await runPriceDiskSync(deps, scheduler);
    for (let i = 0; i < 3; i += 1) {
      expect(await runPriceDiskSync(deps, scheduler)).toMatchObject({
        enqueued: 0,
        suppliersAsked: 0,
        suppliersCreated: 0,
      });
    }
    expect(questions()).toHaveLength(1);
    expect(await allSuppliers()).toHaveLength(1);
  });

  test('сбой отправки вопроса: запись «задан» не пишется, вопрос уйдёт позже', async () => {
    put('Ромашка прайс.csv');
    const original = deps.chat.reply.bind(deps.chat);
    deps.chat.reply = async () => {
      throw new Error('chat_down');
    };
    expect(await runPriceDiskSync(deps, scheduler)).toMatchObject({ suppliersAsked: 0 });
    expect(questions()).toEqual([]);
    deps.chat.reply = original;
    expect(await runPriceDiskSync(deps, scheduler)).toMatchObject({ suppliersAsked: 1 });
    expect(questions()).toHaveLength(1);
  });

  test('предел за тик считает и новые вопросы; заданные ранее предел не тратят', async () => {
    const total = PRICE_DISK_SYNC_MAX_FILES + 2;
    for (let i = 1; i <= total; i += 1) put(`Файл${i}.csv`);
    const first = await runPriceDiskSync(deps, scheduler);
    expect(first).toMatchObject({ suppliersAsked: PRICE_DISK_SYNC_MAX_FILES });
    expect(questions()).toHaveLength(PRICE_DISK_SYNC_MAX_FILES);
    // Пять уже спрошенных ждут и места не занимают: остаток задаётся вторым тиком.
    const second = await runPriceDiskSync(deps, scheduler);
    expect(second).toMatchObject({ suppliersAsked: 2 });
    expect(questions()).toHaveLength(total);
  });

  test('ответ сотрудника с выбором поставщика: файл импортируется следующим тиком', async () => {
    put('Ромашка прайс.csv');
    await runPriceDiskSync(deps, scheduler);
    const out = await answerPriceFileSupplier.execute(
      { file: 'ромашка  прайс.csv', supplierId: SUPPLIER_ID },
      deps,
      CTX,
    );
    expect(out).toMatchObject({ supplierId: SUPPLIER_ID, created: false, queued: true });
    expect(await runPriceDiskSync(deps, scheduler)).toMatchObject({ enqueued: 1 });
    const [payload] = await queued();
    expect(payload).toContain(`supplierId=${SUPPLIER_ID}`);
    expect(payload).toContain(fileRefOf('Ромашка прайс.csv', FILE_REF_SECRET));
    // Дальше файл известен: ни импорта, ни вопроса.
    expect(await runPriceDiskSync(deps, scheduler)).toMatchObject({ enqueued: 0 });
    expect(questions()).toHaveLength(1);
  });

  test('ответ с названием нового поставщика создаёт только черновик для этого файла', async () => {
    put('Прайс.csv');
    await runPriceDiskSync(deps, scheduler);
    // Новая карточка в общей базе - только с правом руководителя отдела (этап 234).
    deps = { ...deps, access: new SwitchableAccess() };
    const out = await answerPriceFileSupplier.execute(
      { file: 'Прайс.csv', newSupplierName: 'Лотос' },
      deps,
      HEAD_CTX,
    );
    expect(out.created).toBe(true);
    expect(await deps.suppliers.getCard(out.supplierId)).not.toHaveProperty('isDraft');
    await runPriceDiskSync(deps, scheduler);
    expect((await queued())[0]).toContain(`supplierId=${out.supplierId}`);
  });

  test('ответ по файлу, о котором не спрашивали, отклоняется', async () => {
    put('produkciya/Ромашка/прайс.csv');
    const error = await answerPriceFileSupplier
      .execute({ file: 'прайс.csv', newSupplierName: 'Левый' }, deps, CTX)
      .catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('not_found');
    expect(await allSuppliers()).toHaveLength(1);
  });

  test('одно ядро названия (кавычки, без «ООО») - один поставщик', async () => {
    put('produkciya/ООО «Ромашка»/прайс а.csv');
    put('produkciya/ромашка/прайс б.csv');
    await runPriceDiskSync(deps, scheduler);
    const romashka = (await allSuppliers()).filter((item) => /ромашка/i.test(item.name));
    expect(romashka).toHaveLength(1);
    const payloads = await queued();
    expect(payloads).toHaveLength(2);
    expect(payloads.every((text) => text.includes(`supplierId=${romashka[0]?.id}`))).toBe(true);
  });

  test('существующий «ООО "Ромашка"» находится по папке «ромашка»', async () => {
    await deps.suppliers.upsert({ id: 's-r', name: 'ООО "Ромашка"' });
    put('produkciya/ромашка/прайс.csv');
    await runPriceDiskSync(deps, scheduler);
    expect((await queued())[0]).toContain('supplierId=s-r');
    expect(await allSuppliers()).toHaveLength(2);
  });
});

describe('признаки поставщика (чистые функции)', () => {
  test('папка поставщика: после produkciya или префикса, файл должен лежать внутри', () => {
    expect(supplierFolderName('produkciya/Ромашка/2026/прайс.xlsx')).toBe('Ромашка');
    expect(supplierFolderName('produkciya/прайс.xlsx')).toBeNull();
    expect(supplierFolderName('прайс.xlsx')).toBeNull();
    expect(supplierFolderName('Лето/Ромашка/прайс.xlsx', ['Лето'])).toBe('Ромашка');
    expect(supplierFolderName('produkciya/Прайсы/файл.xlsx')).toBeNull();
  });

  test('слово «опт» в имени папки срезается: «Ромашка» и «Ромашка Опт» - одна карточка', () => {
    expect(supplierFolderName('produkciya/Ромашка Опт/прайс.xlsx')).toBe('Ромашка');
    expect(supplierFolderName('produkciya/Ромашка опт./прайс.xlsx')).toBe('Ромашка');
    expect(supplierFolderName('produkciya/ОПТ Ромашка/прайс.xlsx')).toBe('Ромашка');
  });

  test('папка только из слов-шумов не даёт пустое имя - null', () => {
    expect(supplierFolderName('produkciya/Опт/прайс.xlsx')).toBeNull();
    expect(supplierFolderName('produkciya/Опт склад/прайс.xlsx')).toBeNull();
  });

  test('шапка: название и ИНН поставщика, покупатель «Прагматика» не берётся', () => {
    const header = extractPriceHeader(
      'Покупатель: ООО «Прагматика», ИНН 7701234567\nПоставщик: ИП Петров Пётр, ИНН 770712345678',
    );
    expect(header).toEqual({ name: 'ИП Петров Пётр', inn: '770712345678' });
    expect(extractPriceHeader('Наименование | Цена')).toEqual({});
  });
});

describe('адресат вопроса о поставщике - сотрудник, положивший файл (этап 148)', () => {
  const DEPARTMENT = 'department:5';
  const IVANOV: StaffPerson = { userId: 'u-ivanov', lastName: 'Иванов', firstName: 'Иван' };
  const IVANOV_THREAD = 'bot/ivanov';
  const OTHER_THREAD = 'bot/petrov';
  const FILE = 'Разное/Иванов/прайс.csv';
  let logs: string[];
  let staff: MemoryStaffDirectory;
  let authorship: MemoryFileAuthorship;

  /** Подключает каталог сотрудников, авторство и личный тред Иванова. */
  async function withStaff(authors: Parameters<MemoryFileAuthorship['set']>[1] | null) {
    staff = new MemoryStaffDirectory();
    staff.set(DEPARTMENT, [IVANOV]);
    authorship = new MemoryFileAuthorship();
    logs = [];
    deps = {
      ...deps,
      staff,
      authorship,
      staffDepartmentIds: [DEPARTMENT],
      log: (event: string) => void logs.push(event),
    };
    await recordEmployeeContact(
      deps.state,
      deps.clock,
      { threadId: IVANOV_THREAD, userId: IVANOV.userId },
      PRICES_AGENT_ID,
    );
    if (authors !== null) authorship.set(FILE, authors);
  }
  const textsOf = (thread: string): string[] =>
    deps.chat.outbox.filter((item) => item.threadId === thread).map((i) => i.message?.text ?? '');
  const employeeCtx = (threadId: string, userId: string) =>
    ({ ...CTX, threadId, initiator: { kind: 'user', userId } }) as const;

  test('автор найден по фамилии в папке: вопрос ему, а не в общий тред', async () => {
    await withStaff(null);
    put(FILE);
    expect(await runPriceDiskSync(deps, scheduler)).toMatchObject({ suppliersAsked: 1 });
    expect(textsOf(IVANOV_THREAD)).toHaveLength(1);
    expect(textsOf(IVANOV_THREAD)[0]).toContain('прайс.csv');
    expect(questions()).toHaveLength(0);
  });

  test('автор найден по свойству «кем изменён»: вопрос ему', async () => {
    await withStaff(null);
    authorship.set('Разное/прайс.xlsx', {
      creator: null,
      lastModifiedBy: 'Иванов Иван',
      createdAt: null,
      modifiedAt: null,
    });
    put('Разное/прайс.xlsx');
    await runPriceDiskSync(deps, scheduler);
    expect(textsOf(IVANOV_THREAD)).toHaveLength(1);
    expect(questions()).toHaveLength(0);
  });

  test('автор не найден: вопрос уходит в общий тред', async () => {
    await withStaff(null);
    put('Разное/прайс.csv');
    await runPriceDiskSync(deps, scheduler);
    expect(questions()).toHaveLength(1);
    expect(textsOf(IVANOV_THREAD)).toHaveLength(0);
  });

  test('сбой определения автора: общий тред, тик не падает, в журнале код', async () => {
    await withStaff(null);
    staff.activeMembersOf = () => Promise.reject(new Error('каталог недоступен'));
    put(FILE);
    expect(await runPriceDiskSync(deps, scheduler)).toMatchObject({ suppliersAsked: 1 });
    expect(questions()).toHaveLength(1);
  });

  test('необработанный сбой определения автора: общий тред и код ошибки в журнале', async () => {
    await withStaff(null);
    const broken = {
      has: (): boolean => {
        throw new Error('сбой');
      },
    } as unknown as ReadonlySet<string>;
    deps = { ...deps, recipientExcludeUserIds: broken };
    put(FILE);
    expect(await runPriceDiskSync(deps, scheduler)).toMatchObject({ suppliersAsked: 1 });
    expect(questions()).toHaveLength(1);
    expect(textsOf(IVANOV_THREAD)).toHaveLength(0);
    expect(logs).toContain('price_disk_ask_recipient_failed');
  });

  test('не писавший боту автор (этап 217): без флага - общий тред, с флагом - ему', async () => {
    await withStaff(null);
    const newcomer: StaffPerson = { userId: 'u-new', lastName: 'Новиков', firstName: 'Николай' };
    staff.set(DEPARTMENT, [IVANOV, newcomer]);
    const newFile = 'Разное/Новиков/прайс.csv';
    put(newFile);
    deps = { ...deps, botId: 'prices' };
    await runPriceDiskSync(deps, scheduler);
    expect(questions()).toHaveLength(1);
    expect(textsOf('prices/u-new')).toHaveLength(0);

    // Повторный проход с флагом: вопрос по файлу ушёл бы ответственному повторно, поэтому
    // проверяем на втором файле того же автора.
    // Бот пишет первым только при политике доступа, допускающей сотрудника (ревью 217).
    const access = new MemoryAccessPolicy();
    access.allow({ userId: newcomer.userId, botId: PRICES_AGENT_ID, action: 'chat.message' });
    deps = { ...deps, recipientOpenThread: true, access };
    put('Разное/Новиков/второй.csv');
    await runPriceDiskSync(deps, scheduler);
    expect(textsOf('prices/u-new')).toHaveLength(1);
    expect(textsOf('prices/u-new')[0]).toContain('второй.csv');
    const out = await answerPriceFileSupplier.execute(
      { file: 'второй.csv', supplierId: SUPPLIER_ID },
      deps,
      employeeCtx('prices/u-new', newcomer.userId),
    );
    expect(out).toMatchObject({ supplierId: SUPPLIER_ID, queued: true });
  });

  test('ответ от адресата принимается, от ответственного тоже', async () => {
    await withStaff(null);
    put(FILE);
    await runPriceDiskSync(deps, scheduler);
    const out = await answerPriceFileSupplier.execute(
      { file: 'прайс.csv', supplierId: SUPPLIER_ID },
      deps,
      employeeCtx(IVANOV_THREAD, IVANOV.userId),
    );
    expect(out).toMatchObject({ supplierId: SUPPLIER_ID, queued: true });
    put('Разное/Иванов/второй.csv');
    await runPriceDiskSync(deps, scheduler);
    const second = await answerPriceFileSupplier.execute(
      { file: 'второй.csv', supplierId: SUPPLIER_ID },
      deps,
      employeeCtx(RESPONSIBLE_THREAD, 'u-boss'),
    );
    expect(second.queued).toBe(true);
  });

  test('ответ чужого сотрудника отклоняется, запись ответа не создаётся', async () => {
    await withStaff(null);
    put(FILE);
    await runPriceDiskSync(deps, scheduler);
    const error = await answerPriceFileSupplier
      .execute(
        { file: 'прайс.csv', supplierId: SUPPLIER_ID },
        deps,
        employeeCtx(OTHER_THREAD, 'u-petrov'),
      )
      .catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('access_denied');
    expect(await runPriceDiskSync(deps, scheduler)).toMatchObject({ enqueued: 0 });
  });

  test('повторный тик вопрос не дублирует', async () => {
    await withStaff(null);
    put(FILE);
    await runPriceDiskSync(deps, scheduler);
    expect(await runPriceDiskSync(deps, scheduler)).toMatchObject({ suppliersAsked: 0 });
    expect(textsOf(IVANOV_THREAD)).toHaveLength(1);
  });
});

describe('новая карточка по ответу о файле: право руководителя отдела (этап 234)', () => {
  let right: SwitchableAccess;
  beforeEach(async () => {
    right = new SwitchableAccess();
    deps = { ...deps, access: right };
    put('Прайс.csv');
    await runPriceDiskSync(deps, scheduler);
  });
  const answer = (input: { newSupplierName?: string; supplierId?: string }) =>
    answerPriceFileSupplier.execute({ file: 'Прайс.csv', ...input }, deps, HEAD_CTX);

  test('не руководитель: карточка не создаётся, ответ не записан, текст понятный', async () => {
    right.mode = 'deny';
    const error = await answer({ newSupplierName: 'Лотос' }).catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('access_denied');
    expect(String((error as Error).message)).toContain('руководитель отдела');
    expect(await allSuppliers()).toHaveLength(1);
    expect(await runPriceDiskSync(deps, scheduler)).toMatchObject({ enqueued: 0 });
  });

  test('не руководитель может указать существующего поставщика', async () => {
    right.mode = 'deny';
    expect(await answer({ supplierId: SUPPLIER_ID })).toMatchObject({ queued: true });
  });

  test('сбой справочника - временная ошибка, повтор после восстановления проходит', async () => {
    right.mode = 'down';
    const error = await answer({ newSupplierName: 'Лотос' }).catch((e: unknown) => e);
    expect(String((error as Error).message)).toContain('временн');
    expect(await allSuppliers()).toHaveLength(1);
    right.mode = 'allow';
    expect(await answer({ newSupplierName: 'Лотос' })).toMatchObject({ created: true });
    expect(await allSuppliers()).toHaveLength(2);
  });

  test('без политики и вне хода сотрудника создание закрыто', async () => {
    deps = { ...deps, access: undefined };
    const noPolicy = await answer({ newSupplierName: 'Лотос' }).catch((e: unknown) => e);
    expect(isDomainError(noPolicy) && noPolicy.code).toBe('access_denied');
    deps = { ...deps, access: right };
    const noUser = await answerPriceFileSupplier
      .execute({ file: 'Прайс.csv', newSupplierName: 'Лотос' }, deps, {
        ...HEAD_CTX,
        initiator: CTX.initiator,
      })
      .catch((e: unknown) => e);
    expect(isDomainError(noUser) && noUser.code).toBe('access_denied');
    expect(await allSuppliers()).toHaveLength(1);
  });
});
