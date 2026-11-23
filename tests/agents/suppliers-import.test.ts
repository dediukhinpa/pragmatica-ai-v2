import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryTableExporter } from '@business-ai/adapters';
import { SUPPLIER_BATCH_MAX_ROWS, SUPPLIER_BATCH_NAMESPACE } from '../../src/agents/suppliers/deps';
import {
  SUPPLIER_TEMPLATE_COLUMNS,
  SUPPLIER_TEMPLATE_EXAMPLE_NAME,
  buildSupplierTemplate,
  buildSupplierTemplateRows,
  matchSupplierHeaders,
  supplierTemplateFile,
} from '../../src/agents/suppliers/supplier-template';
import {
  findSupplierTable,
  importSuppliersFile,
  isSupplierImportCandidate,
  type SupplierImportReport,
} from '../../src/agents/suppliers/import-suppliers-file';
import { supplierCardOutcomeText } from '../../src/agents/suppliers/card-approval';
import { batchRequestSchema } from '../../src/agents/suppliers/card-request';
import {
  INN_ALPHA,
  INN_BETA,
  INN_BROKEN,
  INN_GAMMA,
  THREAD_A,
  THREAD_B,
  USER_A,
  USER_B,
  SwitchableAccess,
  buildSupplierWorld,
  lastShown,
  pressOf,
  type SupplierWorld,
} from './suppliers-support';

let world: SupplierWorld;
beforeEach(() => {
  world = buildSupplierWorld();
});

const HEADERS = SUPPLIER_TEMPLATE_COLUMNS.map((column) => column.header);
const BYTES = new Uint8Array([1, 2, 3]);

/** Строка таблицы по именам колонок шаблона (остальные пусты). */
function row(values: Record<string, string>): string[] {
  return SUPPLIER_TEMPLATE_COLUMNS.map((column) => values[column.key] ?? '');
}

async function importTable(table: string[][], threadId = THREAD_A, userId = USER_A) {
  world.parser.tables = [table];
  return importSuppliersFile(world.deps, {
    agentId: 'prices',
    threadId,
    userId,
    fileName: 'поставщики.xlsx',
    content: BYTES,
  });
}

describe('шаблон', () => {
  test('листы «Поставщики» и «Как заполнить»; пример - одна строка', () => {
    const [data, guide] = buildSupplierTemplateRows();
    expect(data?.name).toBe('Поставщики');
    expect(data?.columns).toEqual(HEADERS);
    expect(data?.rows).toHaveLength(1);
    expect(data?.rows[0]?.[0]).toBe(SUPPLIER_TEMPLATE_EXAMPLE_NAME);
    expect(guide?.name).toBe('Как заполнить');
    expect(guide?.rows.length).toBeGreaterThan(SUPPLIER_TEMPLATE_COLUMNS.length);
  });

  test('buildSupplierTemplate отдаёт файл через TableExporter', async () => {
    const file = await buildSupplierTemplate(new MemoryTableExporter());
    expect(file.fileName).toBe('Шаблон поставщиков.xlsx');
    expect(new TextDecoder().decode(file.bytes)).toContain('Название*');
    const ready = supplierTemplateFile(BYTES);
    expect(ready.fileName).toBe('Шаблон поставщиков.xlsx');
    expect(ready.mimeType).toContain('spreadsheetml');
  });

  test('собственный шаблон распознаётся по заголовкам (разбор того же листа)', () => {
    const [data] = buildSupplierTemplateRows();
    const body = (data?.rows ?? []).map((cells) => cells.map(String));
    const table = [[...(data?.columns ?? [])], ...body];
    const found = findSupplierTable([table]);
    expect(found).not.toBeNull();
    expect(found?.rows).toHaveLength(1);
    expect(found?.rows[0]?.row).toBe(2);
  });

  test('порядок колонок и регистр заголовков не важны; прайс не принимается за шаблон', () => {
    const shuffled = ['E-MAIL', 'НАЗВАНИЕ', 'инн'];
    const columns = matchSupplierHeaders(shuffled);
    expect(columns?.get('name')).toBe(1);
    expect(columns?.get('email')).toBe(0);
    expect(columns?.get('inn')).toBe(2);
    expect(matchSupplierHeaders(['Название', 'Артикул', 'Цена', 'ИНН'])).toBeNull();
    expect(matchSupplierHeaders(['Название', 'Количество'])).toBeNull();
    expect(matchSupplierHeaders(['Название', 'Email'])).toBeNull();
  });

  test('имя файла: таблицы', () => {
    expect(isSupplierImportCandidate('Поставщики.XLSX')).toBe(true);
    expect(isSupplierImportCandidate('scan.pdf')).toBe(false);
  });
});

describe('пачка из файла: право руководителя отдела (этап 234)', () => {
  const table = (): string[][] => [HEADERS, row({ name: 'Альфа', inn: INN_ALPHA })];
  const texts = (): string[] => world.chat.outbox.map((item) => item.message?.text ?? '');

  test('не руководитель: отчёт есть, вопроса и запроса записи нет', async () => {
    const right = new SwitchableAccess();
    right.mode = 'deny';
    world.deps.access = right;
    const outcome = await importTable(table());
    expect(outcome.kind).toBe('no_permission');
    const all = texts().join('\n');
    expect(all).not.toContain('Записать в базу?');
    expect(all).toContain('руководитель отдела');
    expect(await world.state.list(SUPPLIER_BATCH_NAMESPACE, null, 10)).toHaveLength(0);
    expect(await world.suppliers.searchCards({ limit: 10 })).toHaveLength(0);
  });

  test('справочник недоступен: запроса нет; после восстановления - пачка', async () => {
    const right = new SwitchableAccess();
    right.mode = 'down';
    world.deps.access = right;
    expect((await importTable(table())).kind).toBe('access_unavailable');
    expect(texts().join('\n')).toContain('временн');
    expect(await world.state.list(SUPPLIER_BATCH_NAMESPACE, null, 10)).toHaveLength(0);
    right.mode = 'allow';
    expect((await importTable(table())).kind).toBe('shown');
    expect(texts().join('\n')).toContain('Записать в базу?');
  });

  test('руководитель: пачка показывается как раньше', async () => {
    world.deps.access = new SwitchableAccess();
    expect((await importTable(table())).kind).toBe('shown');
  });
});

describe('пачка из файла', () => {
  /** Файл: две хорошие строки, неверный ИНН, пустое название, повтор, пример, пустая строка. */
  function mixedTable(): string[][] {
    return [
      HEADERS,
      row({ name: SUPPLIER_TEMPLATE_EXAMPLE_NAME, inn: '1234567894' }),
      row({ name: 'Альфа', inn: INN_ALPHA, email: 'a@alfa.example.ru', status: 'Действующий' }),
      row({ name: 'Бета', inn: INN_BROKEN }),
      row({ inn: INN_BETA }),
      row({ name: 'Гамма', inn: INN_GAMMA, phone: '+7 900 111-22-33', categories: 'болты; гайки' }),
      row({ name: 'Альфа дубль', inn: INN_ALPHA }),
      row({}),
      row({ name: 'Дельта', email: 'нет-собаки' }),
      row({ name: 'Эпсилон', status: 'неведомый' }),
    ];
  }

  test('отчёт с номерами строк; запись пачки только после одного подтверждения', async () => {
    const outcome = await importTable(mixedTable());
    expect(outcome.kind).toBe('shown');
    if (outcome.kind !== 'shown') return;
    const report: SupplierImportReport = outcome.report;
    // Этап 177: строки с неверными значениями записываются с очисткой (4, 9, 10);
    // пропущена только строка без названия (5).
    expect(report.valid.map((item) => item.row)).toEqual([3, 4, 6, 9, 10]);
    expect(report.duplicates.map((item) => [item.row, item.scope, item.firstRow])).toEqual([
      [7, 'file', 3],
    ]);
    expect(report.invalid.map((item) => item.row)).toEqual([5]);
    expect(report.cleaned.map((item) => item.row)).toEqual([4, 9, 10]);
    expect(report.skippedExamples).toBe(1);
    const shown = await lastShown(world.chat, THREAD_A);
    expect(shown.text).toContain('строка 4: ИНН');
    expect(shown.text).toContain('строка 5: Не указано название');
    expect(shown.text).toContain('строка 7 повторяет строку 3 (совпадает ИНН)');
    expect(shown.text).toContain('Статус: допустимы');
    expect(shown.actions).toEqual(['save', 'cancel']);
    expect(shown.text).toContain('Например: «записать» или «отмена».');
    // До нажатия в базе пусто.
    expect(await world.suppliers.searchCards({ limit: 10 })).toHaveLength(0);

    const result = await world.service.press(pressOf(shown.token, USER_A, THREAD_A, 'save'));
    expect(result).toMatchObject({ kind: 'batch_done', created: 5, updated: 0 });
    expect(result.kind === 'batch_done' && result.warnings?.length).toBe(2);
    const cards = await world.suppliers.searchCards({ limit: 10 });
    expect(cards.map((card) => card.name)).toEqual(['Альфа', 'Бета', 'Гамма', 'Дельта', 'Эпсилон']);
    expect(cards[0]?.status).toBe('active');
    expect(cards[0]?.source).toBe('file');
    expect(cards[0]?.createdBy).toBe(USER_A);
    expect(cards[1]?.inn).toBeUndefined();
    expect(cards[2]?.supplies.categories).toEqual(['болты', 'гайки']);
    // Второе нажатие ничего не пишет.
    const again = await world.service.press(pressOf(shown.token, USER_A, THREAD_A, 'save'));
    expect(again).toEqual({ kind: 'already_done' });
    expect(await world.suppliers.searchCards({ limit: 10 })).toHaveLength(5);
    const stored = batchRequestSchema.parse(
      await world.state.get(SUPPLIER_BATCH_NAMESPACE, shown.token),
    );
    expect(stored.rows).toEqual([]);
  });

  test('название без формы собственности: подсказка, строка пишется как есть', async () => {
    const outcome = await importTable([
      HEADERS,
      row({ name: 'Ромашка', inn: INN_ALPHA }),
      row({ name: 'ООО «Лютик»', inn: INN_BETA }),
    ]);
    if (outcome.kind !== 'shown') throw new Error('ожидался отчёт');
    expect(outcome.report.valid.map((item) => item.warnings.length)).toEqual([1, 0]);
    expect(outcome.report.invalid).toHaveLength(0);
    const shown = await lastShown(world.chat, THREAD_A);
    expect(shown.text).toContain('строка 2: добавьте форму собственности');
    expect(shown.text).not.toContain('строка 3: добавьте');
    expect(shown.actions).toEqual(['save', 'cancel']);
    expect(shown.text).toContain('Например: «записать» или «отмена».');
    await world.service.press(pressOf(shown.token, USER_A, THREAD_A, 'save'));
    const cards = await world.suppliers.searchCards({ limit: 10 });
    expect(cards.map((card) => card.name).sort()).toEqual(['ООО «Лютик»', 'Ромашка']);
  });

  test('чужой тред и чужой сотрудник пачку не подтверждают; отмена не пишет', async () => {
    await importTable([HEADERS, row({ name: 'Альфа', inn: INN_ALPHA })]);
    const { token } = await lastShown(world.chat, THREAD_A);
    expect(await world.service.press(pressOf(token, USER_A, THREAD_B, 'save'))).toEqual({
      kind: 'wrong_thread',
    });
    expect(await world.service.press(pressOf(token, USER_B, THREAD_A, 'save'))).toEqual({
      kind: 'wrong_owner',
    });
    await world.service.cancel({ token, userId: USER_A, threadId: THREAD_A });
    expect(await world.suppliers.searchCards({ limit: 10 })).toHaveLength(0);
    expect((await world.service.lookup(token))?.kind).toBe('batch');
  });

  test('дубли с базой: «Записать только новых» и «Записать и обновить дубли»', async () => {
    await world.suppliers.saveCard({
      id: 'sup-existing',
      name: 'Альфа Металл',
      inn: INN_ALPHA,
      status: 'active',
      contacts: [],
      supplies: { categories: [], brands: [], regions: [] },
      terms: {},
      notes: [],
    });
    const table = [
      HEADERS,
      row({ name: 'Альфа', inn: INN_ALPHA, website: 'alfa.example.ru' }),
      row({ name: 'Бета', inn: INN_BETA }),
    ];
    await importTable(table);
    const first = await lastShown(world.chat, THREAD_A);
    expect(first.text).toContain('Уже есть в базе: 1');
    expect(first.text).toContain('«Альфа» похоже на существующего «Альфа Металл» (совпадает ИНН)');
    expect(first.actions).toEqual(['save', 'update', 'cancel']);
    expect(first.text).toContain(
      'Например: «записать только новых», «записать и обновить дубли» или «отмена».',
    );

    const onlyNew = await world.service.press(pressOf(first.token, USER_A, THREAD_A, 'save'));
    expect(onlyNew).toMatchObject({ kind: 'batch_done', created: 1, updated: 0 });
    expect(supplierCardOutcomeText(onlyNew)).toContain('строка 2: уже есть в базе');
    expect((await world.suppliers.getCard('sup-existing'))?.website).toBeUndefined();

    world.chat.outbox.length = 0;
    const again = row({ name: 'Альфа', inn: INN_ALPHA, website: 'alfa.example.ru' });
    await importTable([HEADERS, again]);
    const second = await lastShown(world.chat, THREAD_A);
    expect(second.actions).toEqual(['update', 'cancel']);
    expect(second.text).toContain('«обновить дубли»');
    const updated = await world.service.press(pressOf(second.token, USER_A, THREAD_A, 'update'));
    expect(updated).toMatchObject({ kind: 'batch_done', created: 0, updated: 1 });
    expect((await world.suppliers.getCard('sup-existing'))?.website).toBe('alfa.example.ru');
    expect(await world.suppliers.searchCards({ limit: 10 })).toHaveLength(2);
  });

  test('ошибка одной строки при записи не валит остальные и идёт в итоговый отчёт', async () => {
    await importTable([
      HEADERS,
      row({ name: 'Альфа', inn: INN_ALPHA }),
      row({ name: 'Бета', inn: INN_BETA }),
      row({ name: 'Гамма', inn: INN_GAMMA }),
    ]);
    const { token } = await lastShown(world.chat, THREAD_A);
    // Между показом и нажатием «Бета» появилась в базе другим путём.
    await world.suppliers.saveCard({
      id: 'sup-beta',
      name: 'Бета',
      inn: INN_BETA,
      status: 'new',
      contacts: [],
      supplies: { categories: [], brands: [], regions: [] },
      terms: {},
      notes: [],
    });
    // Сбой хранилища на «Гамме».
    const original = world.suppliers.saveCard.bind(world.suppliers);
    world.suppliers.saveCard = async (card) => {
      if (card.name === 'Гамма') throw new Error('сбой хранилища');
      return original(card);
    };
    const outcome = await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    expect(outcome).toMatchObject({
      kind: 'batch_done',
      created: 1,
      skipped: [{ row: 3, code: 'duplicate_appeared' }],
      failed: [{ row: 4, code: 'unexpected' }],
    });
    const text = supplierCardOutcomeText(outcome);
    expect(text).toContain('строка 3: в базе появился похожий поставщик');
    expect(text).toContain('строка 4: ошибка (unexpected)');
    world.suppliers.saveCard = original;
    expect((await world.suppliers.searchCards({ inn: INN_ALPHA, limit: 10 })).length).toBe(1);
  });

  test('аудит пачки без ПДн; не шаблон - без сообщений; слишком много строк', async () => {
    const outcome = await importTable([HEADERS, row({ name: 'Альфа', inn: INN_ALPHA })]);
    expect(outcome.kind).toBe('shown');
    const { token } = await lastShown(world.chat, THREAD_A);
    await world.service.press(pressOf(token, USER_A, THREAD_A, 'save'));
    const audit = JSON.stringify(await world.audit.list());
    expect(audit).toContain('suppliers.batch_save');
    expect(audit).toContain('created=1');
    expect(audit).not.toContain('Альфа');
    expect(audit).not.toContain(INN_ALPHA);

    world.chat.outbox.length = 0;
    const price = await importTable([['Название', 'Артикул', 'Цена'], ['Болт', 'A1', '5']]);
    expect(price.kind).toBe('not_template');
    expect(world.chat.outbox).toHaveLength(0);

    const many = Array.from({ length: SUPPLIER_BATCH_MAX_ROWS + 1 }, (_, index) =>
      row({ name: `П${index}` }),
    );
    expect((await importTable([HEADERS, ...many])).kind).toBe('too_many_rows');
    expect(world.chat.outbox).toHaveLength(1);
  });

  test('файл без строк данных и без названий: отчёт без кнопок', async () => {
    const outcome = await importTable([HEADERS, row({ inn: INN_BROKEN })]);
    expect(outcome.kind).toBe('nothing_to_write');
    const message = world.chat.outbox.at(-1)?.message;
    expect(message?.buttons).toBeUndefined();
    expect(message?.text).toContain('строка 2');
  });
});
