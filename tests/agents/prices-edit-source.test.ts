import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { SOURCE_CELLS_NAMESPACE } from '../../src/agents/prices/deps';
import { PRICES_PROMPT } from '../../src/agents/prices/prompt';
import { editPricesInSourceFile } from '../../src/agents/prices/price-edit-source';
import { loadSourceCells } from '../../src/agents/prices/source-cells';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { stagingImportId } from '../../src/agents/prices/staging-source';
import { type ToolContext } from '@business-ai/core';
import { MemoryPriceFileEditor } from '../../src/kit/adapters/memory/price-file-editor';
import {
  PriceFileTooLargeError,
  type PriceFileTooLargeReason,
} from '../../src/kit/domain/errors.owned';
import { priceItemKey } from '../../src/kit/domain/price-diff';
import { stableHash } from '@business-ai/core';
import { roundEditedPrice } from '../../src/agents/prices/price-edit-source';
import type { EditPricesRequest } from '../../src/kit/ports/price-file-editor';
import { SUPPLIER_ID, putFile } from './support';
import {
  COLUMNS,
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  employeeContext,
  type FullPricesDeps,
} from './prices-support';

const CSV = [
  'Наименование,Цена,Артикул',
  'Болт,100,B1',
  'Гайка,от 100,G1',
  'Шайба,10.50,S1',
].join('\n');

let deps: FullPricesDeps;
let ctx: ToolContext;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
  ctx = employeeContext('u-edit', EMPLOYEE_THREAD);
});

async function stage(path = 'price.csv'): Promise<{ fileHash: string; importId: string }> {
  putFile(deps, path, CSV);
  const out = await stagePriceRows.execute(
    { path, supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
    deps,
    ctx,
  );
  return { fileHash: out.fileHash, importId: stagingImportId(SUPPLIER_ID, out.fileHash) };
}

describe('координаты ячеек при разборе (staging)', () => {
  test('для каждой позиции сохраняются строка и столбец цены', async () => {
    const { importId } = await stage();
    const cells = await loadSourceCells(deps, importId);
    expect(cells?.path).toBe('price.csv');
    expect(cells?.items[priceItemKey({ sku: 'B1', productName: 'Болт' })]).toEqual([
      { table: 0, row: 1, cols: [1] },
    ]);
    expect(Object.keys(cells?.items ?? {})).toHaveLength(3);
  });

  test('повтор куска не дублирует места; reset сбрасывает координаты', async () => {
    const { importId } = await stage();
    await stagePriceRows.execute(
      { path: 'price.csv', supplierId: SUPPLIER_ID, columns: COLUMNS, reset: false },
      deps,
      ctx,
    );
    const places = (await loadSourceCells(deps, importId))?.items ?? {};
    expect(Object.values(places).every((item) => item.length === 1)).toBe(true);
    await deps.state.delete(SOURCE_CELLS_NAMESPACE, importId);
    expect(await loadSourceCells(deps, importId)).toBeNull();
  });
});

describe('editPricesInSourceFile: файл сотрудника идёт через диск (этап 231)', () => {
  test('источник - приём файлов: правка с диска, результат уходит файлом и убирается', async () => {
    const csv = new TextEncoder().encode(CSV);
    const stored = await deps.intake.put(EMPLOYEE_THREAD, 'price.csv', csv);
    const staged = await stagePriceRows.execute(
      { path: stored.path, supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
      deps,
      ctx,
    );
    let editedDiskCalls = 0;
    const memory = new MemoryPriceFileEditor();
    const spy = {
      editPrices: memory.editPrices.bind(memory),
      editPricesFile: async (request: Parameters<MemoryPriceFileEditor['editPricesFile']>[0]) => {
        editedDiskCalls += 1;
        return memory.editPricesFile(request);
      },
    };
    const sent: Array<{ viaDisk: boolean; text: string; existed: boolean; path: string }> = [];
    const realSend = deps.chat.sendFile.bind(deps.chat);
    deps.chat.sendFile = async (threadId, file, key) => {
      const path = file.disk?.path ?? '';
      sent.push({
        viaDisk: file.disk !== undefined,
        text: file.disk === undefined ? '' : readFileSync(path, 'utf8'),
        existed: path !== '' && existsSync(path),
        path,
      });
      await realSend(threadId, file, key);
    };
    const out = await editPricesInSourceFile.execute(
      { supplierId: SUPPLIER_ID, fileHash: staged.fileHash, mode: 'percent', percent: 10 },
      { ...deps, priceFileEditor: spy },
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(editedDiskCalls).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.viaDisk).toBe(true);
    expect(sent[0]?.text).toContain('Болт,110,B1');
    // Временный результат убран после отправки
    expect(sent[0]?.existed).toBe(true);
    expect(existsSync(sent[0]?.path ?? '')).toBe(false);
  });

  test('сбой отправки: временный результат всё равно убран', async () => {
    const csv = new TextEncoder().encode(CSV);
    const stored = await deps.intake.put(EMPLOYEE_THREAD, 'price.csv', csv);
    const staged = await stagePriceRows.execute(
      { path: stored.path, supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
      deps,
      ctx,
    );
    let path = '';
    deps.chat.sendFile = async (_thread, file) => {
      path = file.disk?.path ?? '';
      throw new Error('канал недоступен');
    };
    await expect(
      editPricesInSourceFile.execute(
        { supplierId: SUPPLIER_ID, fileHash: staged.fileHash, mode: 'percent', percent: 10 },
        deps,
        ctx,
      ),
    ).rejects.toThrow('не доставлен');
    expect(path).not.toBe('');
    expect(existsSync(path)).toBe(false);
  });
});

describe('editPricesInSourceFile', () => {
  test('процент: меняются только цены, текстовая цена перечислена и не тронута', async () => {
    const { fileHash } = await stage();
    const out = await editPricesInSourceFile.execute(
      { supplierId: SUPPLIER_ID, fileHash, mode: 'percent', percent: 10 },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(out.changed).toBe(2);
    expect(out.skippedCount).toBe(1);
    expect(out.skipped[0]?.reason).toContain('от 100');
    expect(out.fileName).toMatch(/^Прайс_.+_\d{2}\.\d{2}\.\d{4}\.csv$/u);
    // Только файл, без подписи кода: итог говорит агент одним сообщением.
    expect(deps.chat.outbox).toHaveLength(1);
    const [file] = deps.chat.outbox;
    expect(file?.threadId).toBe(EMPLOYEE_THREAD);
    expect(file?.message).toBeUndefined();
    expect(out.message).toContain('итоговом ответе скажи сам');
    expect(file?.file?.name).toBe(out.fileName ?? '');
    const text = new TextDecoder().decode(file?.file?.content);
    // Знаков после точки столько же, сколько в исходной ячейке (10.50 -> 11.55).
    expect(text).toBe(
      ['Наименование,Цена,Артикул', 'Болт,110,B1', 'Гайка,от 100,G1', 'Шайба,11.55,S1'].join('\n'),
    );
  });

  test('в сервис передаётся expected - старая цена из исходного файла', async () => {
    const { fileHash } = await stage();
    const seen: Array<{ row: number; expected?: number | string | null | undefined }> = [];
    const spy = {
      editPrices: async (request: EditPricesRequest) => {
        seen.push(...request.edits.map((e) => ({ row: e.row, expected: e.expected })));
        return new MemoryPriceFileEditor().editPrices(request);
      },
    };
    await editPricesInSourceFile.execute(
      { supplierId: SUPPLIER_ID, fileHash, mode: 'percent', percent: 10 },
      { ...deps, priceFileEditor: spy },
      ctx,
    );
    expect(seen).toEqual([
      { row: 1, expected: 100 },
      { row: 3, expected: 10.5 },
    ]);
  });

  test('фиксированная цена по артикулу; неизвестная позиция в skipped', async () => {
    const { fileHash } = await stage();
    const out = await editPricesInSourceFile.execute(
      {
        supplierId: SUPPLIER_ID,
        fileHash,
        mode: 'fixed',
        fixed: [
          { sku: 'S1', price: 12 },
          { sku: 'ZZ', price: 1 },
        ],
      },
      deps,
      ctx,
    );
    expect(out.changed).toBe(1);
    expect(out.skipped.map((item) => item.reason)).toEqual(['позиции нет в разобранном файле']);
    const text = new TextDecoder().decode(deps.chat.outbox[0]?.file?.content);
    expect(text).toContain('Шайба,12,S1');
    expect(text).toContain('Болт,100,B1');
  });

  test('старый импорт без координат: не падает, файл не отправляется', async () => {
    const { fileHash, importId } = await stage();
    await deps.state.delete(SOURCE_CELLS_NAMESPACE, importId);
    const out = await editPricesInSourceFile.execute(
      { supplierId: SUPPLIER_ID, fileHash, mode: 'percent', percent: 5 },
      deps,
      ctx,
    );
    expect(out.status).toBe('no_coordinates');
    expect(out.delivered).toBe(false);
    expect(out.message).toContain('заново');
    expect(deps.chat.outbox).toHaveLength(0);
  });

  test('формат, который не правится на месте (xls): предложение xlsx-копии', async () => {
    // Парсер-заглушка xls не читает: подменяем только имя файла в записи координат.
    const { fileHash, importId } = await stage();
    const cells = await loadSourceCells(deps, importId);
    await deps.state.put(SOURCE_CELLS_NAMESPACE, importId, {
      ...JSON.parse(JSON.stringify(cells)),
      fileName: 'старый.xls',
    });
    const out = await editPricesInSourceFile.execute(
      { supplierId: SUPPLIER_ID, fileHash, mode: 'percent', percent: 5 },
      deps,
      ctx,
    );
    expect(out.status).toBe('unsupported_format');
    expect(out.message).toContain('xlsx-копию');
    expect(deps.chat.outbox).toHaveLength(0);
  });

  test('файл слишком большой для сервиса: статус too_large, не ошибка и не отправка', async () => {
    const { fileHash } = await stage();
    const tooLarge = {
      editPrices: async (): Promise<never> => {
        throw new PriceFileTooLargeError('price.csv');
      },
    };
    const out = await editPricesInSourceFile.execute(
      { supplierId: SUPPLIER_ID, fileHash, mode: 'percent', percent: 10 },
      { ...deps, priceFileEditor: tooLarge },
      ctx,
    );
    expect(out.status).toBe('too_large');
    expect(out.delivered).toBe(false);
    expect(out.changed).toBe(0);
    expect(out.message).toContain('слишком большой');
    // Агент не должен «чинить» отказ новой таблицей: запрет назван в самом ответе
    expect(out.message).toContain('createFile');
    expect(out.message).toContain('Не подменяй исходный файл');
    expect(deps.chat.outbox).toHaveLength(0);
  });

  test('decimals: округление результата до заданного числа знаков', async () => {
    const csv = ['Наименование,Цена,Артикул', 'Болт,595,B1', 'Гайка,100,G1'].join('\n');
    putFile(deps, 'dec.csv', csv);
    const staged = await stagePriceRows.execute(
      { path: 'dec.csv', supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
      deps,
      ctx,
    );
    const out = await editPricesInSourceFile.execute(
      {
        supplierId: SUPPLIER_ID,
        fileHash: staged.fileHash,
        mode: 'percent',
        percent: 15,
        decimals: 1,
      },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    const text = new TextDecoder().decode(deps.chat.outbox[0]?.file?.content);
    // Без decimals было бы «684» (знаков, как в исходной ячейке, - ноль)
    expect(text).toContain('Болт,684.3,B1');
    expect(text).toContain('Гайка,115,G1');
  });

  test('decimals вне 0..4 отклоняется схемой', () => {
    const base = { supplierId: SUPPLIER_ID, fileHash: 'h', mode: 'percent' as const, percent: 5 };
    expect(editPricesInSourceFile.inputSchema.safeParse({ ...base, decimals: 2 }).success).toBe(
      true,
    );
    for (const bad of [-1, 5, 1.5]) {
      expect(editPricesInSourceFile.inputSchema.safeParse({ ...base, decimals: bad }).success).toBe(
        false,
      );
    }
  });

  test('неверные аргументы: percent без значения и fixed без списка', async () => {
    const { fileHash } = await stage();
    const base = { supplierId: SUPPLIER_ID, fileHash };
    await expect(
      editPricesInSourceFile.execute({ ...base, mode: 'percent' }, deps, ctx),
    ).rejects.toThrow();
    await expect(
      editPricesInSourceFile.execute({ ...base, mode: 'fixed' }, deps, ctx),
    ).rejects.toThrow();
  });
});

const TWO_PRICES = [
  'Наименование,Цена опт руб.,Цена руб.,Артикул',
  'Болт,80,100,B1',
  'Гайка,от 50,60,G1',
  'Шайба,8.50,10.50,S1',
].join('\n');

/** Разбор берёт один столбец (розница, индекс 2); опт разбор не видит. */
async function stageTwoPrices(): Promise<string> {
  putFile(deps, 'two.csv', TWO_PRICES);
  const out = await stagePriceRows.execute(
    {
      path: 'two.csv',
      supplierId: SUPPLIER_ID,
      columns: { name: 0, price: 2, sku: 3 },
      reset: true,
    },
    deps,
    ctx,
  );
  return out.fileHash;
}

describe('editPricesInSourceFile: несколько столбцов цен по шапке', () => {
  test('без priceColumns правится только столбец разбора (как раньше)', async () => {
    const fileHash = await stageTwoPrices();
    const out = await editPricesInSourceFile.execute(
      { supplierId: SUPPLIER_ID, fileHash, mode: 'percent', percent: 10 },
      deps,
      ctx,
    );
    expect(out.changed).toBe(3);
    const text = new TextDecoder().decode(deps.chat.outbox[0]?.file?.content);
    expect(text).toContain('Болт,80,110,B1');
  });

  test('оба столбца: один вызов, один файл, округление по каждой ячейке', async () => {
    const fileHash = await stageTwoPrices();
    const out = await editPricesInSourceFile.execute(
      {
        supplierId: SUPPLIER_ID,
        fileHash,
        mode: 'percent',
        percent: 10,
        priceColumns: ['Цена руб.', 'Цена опт руб.'],
      },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(out.changed).toBe(5);
    expect(out.skippedCount).toBe(1);
    expect(out.skipped[0]?.reason).toContain('от 50');
    expect(deps.chat.outbox.filter((m) => m.file !== undefined)).toHaveLength(1);
    const text = new TextDecoder().decode(deps.chat.outbox[0]?.file?.content);
    expect(text).toBe(
      [
        'Наименование,Цена опт руб.,Цена руб.,Артикул',
        'Болт,88,110,B1',
        'Гайка,от 50,66,G1',
        'Шайба,9.35,11.55,S1',
      ].join('\n'),
    );
  });

  test('только опт: розница не тронута', async () => {
    const fileHash = await stageTwoPrices();
    await editPricesInSourceFile.execute(
      {
        supplierId: SUPPLIER_ID,
        fileHash,
        mode: 'percent',
        percent: 10,
        priceColumns: ['цена опт'],
      },
      deps,
      ctx,
    );
    const text = new TextDecoder().decode(deps.chat.outbox[0]?.file?.content);
    expect(text).toContain('Болт,88,100,B1');
  });

  test('неизвестный или неоднозначный столбец: вопрос, файл не отправляется', async () => {
    const fileHash = await stageTwoPrices();
    for (const name of ['Скидочная', 'цена']) {
      const out = await editPricesInSourceFile.execute(
        { supplierId: SUPPLIER_ID, fileHash, mode: 'percent', percent: 10, priceColumns: [name] },
        deps,
        ctx,
      );
      expect(out.status).toBe('unknown_column');
      expect(out.delivered).toBe(false);
      expect(out.message).toContain('Цена опт руб.');
    }
    expect(deps.chat.outbox).toHaveLength(0);
  });

  test('fixed с несколькими столбцами отклоняется', async () => {
    const fileHash = await stageTwoPrices();
    await expect(
      editPricesInSourceFile.execute(
        {
          supplierId: SUPPLIER_ID,
          fileHash,
          mode: 'fixed',
          fixed: [{ sku: 'B1', price: 5 }],
          priceColumns: ['Цена руб.', 'Цена опт руб.'],
        },
        deps,
        ctx,
      ),
    ).rejects.toThrow();
  });
});

describe('промпт агента прайсов: правка прайса не подменяет исходный файл', () => {
  test('запрет createFile и столбцов «было/стало», при отказе - сообщить сотруднику', () => {
    expect(PRICES_PROMPT).toContain('НИКОГДА не подменяй исходный файл');
    expect(PRICES_PROMPT).toContain('createFile');
    expect(PRICES_PROMPT).toContain('«было»/«стало»');
    expect(PRICES_PROMPT).toContain('структура исходного файла не меняется');
    expect(PRICES_PROMPT).toContain('status=too_large');
    expect(PRICES_PROMPT).toContain('decimals');
  });
});

describe('промпт агента прайсов: краткость и столбцы цен', () => {
  test('правила краткости и один вызов на все столбцы', () => {
    expect(PRICES_PROMPT).toContain('ОДНИМ сообщением');
    // Этап 177: итог - результат и один список предупреждений, без допроса и лимита строк.
    expect(PRICES_PROMPT).toContain('ОДИН список предупреждений');
    expect(PRICES_PROMPT).not.toContain('не больше трёх, нумерованно');
    expect(PRICES_PROMPT).not.toContain('Жду ответа');
    expect(PRICES_PROMPT).not.toContain('максимум пять строк');
    expect(PRICES_PROMPT).toContain('Цены в базу не попали, на диск внесите сами');
    expect(PRICES_PROMPT).toContain('вызывай инструмент ОДИН раз');
    expect(PRICES_PROMPT).toContain('priceColumns');
    expect(PRICES_PROMPT).toContain('status=unknown_column');
    expect(PRICES_PROMPT).not.toContain('одну цену на позицию');
  });
});

describe('editPricesInSourceFile: ревью этапа 213', () => {
  const TOO_LARGE_CASES: Array<[PriceFileTooLargeReason, string, string]> = [
    ['file_size', 'без картинок', 'правок'],
    ['structure', 'ячеек', 'без картинок'],
    ['uncompressed', 'картин', 'правок'],
    ['edits', 'правок', 'без картинок'],
    ['temporary', 'позже', 'без картинок'],
  ];

  for (const [reason, has, hasNot] of TOO_LARGE_CASES) {
    test(`too_large, причина ${reason}: совет по причине, а не один на все`, async () => {
      const { fileHash } = await stage();
      const refuse = {
        editPrices: async (): Promise<never> => {
          throw new PriceFileTooLargeError('price.csv', reason);
        },
      };
      const out = await editPricesInSourceFile.execute(
        { supplierId: SUPPLIER_ID, fileHash, mode: 'percent', percent: 10 },
        { ...deps, priceFileEditor: refuse },
        ctx,
      );
      expect(out.status).toBe('too_large');
      expect(out.message).toContain(has);
      expect(out.message).not.toContain(hasNot);
      // Запрет подменять исходник остаётся при любой причине, кроме временной
      if (reason !== 'temporary') expect(out.message).toContain('createFile');
    });
  }

  test('fixed + decimals: фиксированная цена тоже округляется, не игнорируется молча', async () => {
    const { fileHash } = await stage();
    const out = await editPricesInSourceFile.execute(
      {
        supplierId: SUPPLIER_ID,
        fileHash,
        mode: 'fixed',
        fixed: [{ sku: 'S1', price: 12.346 }],
        decimals: 1,
      },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    const text = new TextDecoder().decode(deps.chat.outbox[0]?.file?.content);
    expect(text).toContain('Шайба,12.3,S1');
  });

  test('округление: половина от нуля и без ошибок двоичной дроби', () => {
    expect(roundEditedPrice(1.005, 2)).toBe(1.01);
    expect(roundEditedPrice(2.675, 2)).toBe(2.68);
    expect(roundEditedPrice(0.285, 2)).toBe(0.29);
    expect(roundEditedPrice(-2.5, 0)).toBe(-3);
    expect(roundEditedPrice(-1.005, 2)).toBe(-1.01);
    expect(roundEditedPrice(2.5, 0)).toBe(3);
    expect(roundEditedPrice(1.45, 1)).toBe(1.5);
    expect(roundEditedPrice(110.00000000000001, 2)).toBe(110);
    expect(Object.is(roundEditedPrice(-0.001, 2), 0)).toBe(true);
    expect(roundEditedPrice(1e-7, 2)).toBe(0);
  });

  test('decimals больше знаков в ячейке: предупреждение в ответе инструмента', async () => {
    const { fileHash } = await stage();
    // Болт «100» (0 знаков), Шайба «10.50» (2 знака): запрошено 2
    const out = await editPricesInSourceFile.execute(
      { supplierId: SUPPLIER_ID, fileHash, mode: 'percent', percent: 5, decimals: 2 },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings?.[0]).toContain('знак');
    expect(out.message).toContain(out.warnings?.[0] ?? 'нет');
  });

  test('decimals не больше знаков ячеек: предупреждения нет', async () => {
    const { fileHash } = await stage();
    const out = await editPricesInSourceFile.execute(
      { supplierId: SUPPLIER_ID, fileHash, mode: 'percent', percent: 5, decimals: 0 },
      deps,
      ctx,
    );
    expect(out.warnings ?? []).toEqual([]);
  });

  test('ключ идемпотентности: без decimals прежний, с decimals - другой', async () => {
    const { fileHash, importId } = await stage();
    const base = { supplierId: SUPPLIER_ID, fileHash, mode: 'percent' as const, percent: 5 };
    const legacy = `prices-edit-source:${importId}:${stableHash(['percent', 5, null, null])}`;
    expect(editPricesInSourceFile.idempotencyKey?.(base)).toBe(legacy);
    expect(editPricesInSourceFile.idempotencyKey?.({ ...base, decimals: 1 })).not.toBe(legacy);
    expect(editPricesInSourceFile.idempotencyKey?.({ ...base, decimals: 1 })).not.toBe(
      editPricesInSourceFile.idempotencyKey?.({ ...base, decimals: 2 }),
    );
  });

  test('xls: сообщение просит согласия сотрудника на xlsx-копию', async () => {
    const { fileHash, importId } = await stage();
    const cells = await loadSourceCells(deps, importId);
    await deps.state.put(SOURCE_CELLS_NAMESPACE, importId, {
      ...JSON.parse(JSON.stringify(cells)),
      fileName: 'старый.xls',
    });
    const out = await editPricesInSourceFile.execute(
      { supplierId: SUPPLIER_ID, fileHash, mode: 'percent', percent: 5 },
      deps,
      ctx,
    );
    expect(out.status).toBe('unsupported_format');
    expect(out.message).toContain('согласи');
    expect(out.message).toContain('ТОЛЬКО');
  });
});

describe('промпт агента прайсов: xlsx-копия при unsupported_format', () => {
  const rule = PRICES_PROMPT.slice(PRICES_PROMPT.indexOf('Правка прайса: структура'));

  test('копия разрешена только при unsupported_format и по согласию сотрудника', () => {
    expect(rule).toContain('unsupported_format');
    expect(rule).toContain('xlsx-копи');
    expect(rule).toContain('согласи');
  });

  test('при too_large и для xlsx копия по-прежнему запрещена', () => {
    const exception = rule.slice(rule.indexOf('unsupported_format'));
    expect(exception).toContain('too_large');
    expect(rule).toContain('НИКОГДА не подменяй исходный файл');
  });

  test('файл изменений (sendPriceChangeFile) можно и по прямой просьбе сотрудника', () => {
    expect(rule).toContain('sendPriceChangeFile');
    expect(rule).toContain('прямой просьб');
  });
});
