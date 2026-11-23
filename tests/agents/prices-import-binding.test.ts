import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryIdempotencyStore } from '@business-ai/adapters';
import {
  IMPORT_META_NAMESPACE,
  PRICE_DATE_FUTURE_TOLERANCE_MS,
} from '../../src/agents/prices/deps';
import {
  commitPriceImport,
  stagedImportValidator,
} from '../../src/agents/prices/commit-price-import';
import { createPricesAgent } from '../../src/agents/prices/declaration';
import { loadConfirmedPrices } from '../../src/agents/prices/confirmed-prices';
import { normalizePriceTable } from '../../src/agents/prices/normalize-price-table';
import { previewPriceChanges } from '../../src/agents/prices/price-changes';
import { priceImportValidator, savePriceImport } from '../../src/agents/prices/save-price-import';
import { mailRecordId, readPriceMail } from '../../src/agents/prices/price-mail';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { stagingImportId } from '../../src/agents/prices/staging-source';
import { isDomainError } from '@business-ai/core';
import { type PriceItem } from '../../src/kit/domain/models';
import { callTool, say, scriptedRuntime } from '../kit/adapters/mastra/support';
import { CTX, MODEL_ALIAS, SUPPLIER_ID, putFile, toolMessages } from './support';
import {
  COLUMNS,
  buildFullPricesDeps,
  encode,
  mailMessage,
  skuCsv,
  skuItem,
  stageDiskCsv,
  type FullPricesDeps,
  USER_1,
  USER_THREAD_1,
  employeeContext,
} from './prices-support';

const PATH = 'price.csv';
let deps: FullPricesDeps;

beforeEach(async () => {
  deps = await buildFullPricesDeps();
  await deps.prices.saveImport(SUPPLIER_ID, [skuItem('Болт', 100, 'B1')], 'seed', {
    sourceFile: 'price.csv',
  });
});

const storedPrices = async (): Promise<Array<[string, number, string]>> =>
  (await deps.prices.listBySupplier(SUPPLIER_ID)).map((i) => [i.productName, i.price, i.currency]);

/** Положить новую версию файла и получить аргументы savePriceImport с настоящим хэшем. */
async function fileArgs(rows: Array<[string, number, string]>, path = PATH) {
  putFile(deps, path, skuCsv(rows));
  const input = { path, supplierId: SUPPLIER_ID, columns: COLUMNS };
  const { fileHash } = await normalizePriceTable.execute(input, deps, CTX);
  return { ...input, fileHash };
}

const saveCodes = async (args: unknown): Promise<string[]> =>
  (await priceImportValidator.validate(args, deps, CTX)).map((issue) => issue.code);

/** Запуск агента: модель «под влиянием инъекции» сразу зовёт инструмент с этими аргументами. */
async function runAgent(tool: string, args: Record<string, unknown>): Promise<string> {
  const declaration = createPricesAgent({ model: MODEL_ALIAS });
  const { gateway, runtime, spec } = scriptedRuntime(
    declaration,
    deps,
    [callTool('c1', tool, args), say('готово')],
    { runtime: { idempotency: new MemoryIdempotencyStore() } },
  );
  await runtime.run(spec, 't1', 'обнови прайс');
  return toolMessages(gateway.requests[1]).join('');
}

describe('D-3: позиции берутся из файла, а не из аргументов модели', () => {
  test('позиции, число строк и выдуманный хэш от модели: запись не выполняется', async () => {
    const forged: PriceItem[] = [
      { ...skuItem('Болт', 148, 'B1'), date: '2030-01-01T00:00:00.000Z' },
    ];
    for (const [fileHash, price] of [
      ['выдуман-a', 148],
      ['выдуман-b', 219],
    ] as const) {
      const items = forged.map((item) => ({ ...item, price }));
      const reply = await runAgent('savePriceImport', {
        supplierId: SUPPLIER_ID,
        fileHash,
        sourceRowCount: 1,
        items,
      });
      expect(reply).toContain('error');
    }
    expect(await storedPrices()).toEqual([['Болт', 100, 'RUB']]);
  });

  test('выдуманный fileHash при настоящем файле: file_hash_mismatch, база не тронута', async () => {
    const args = await fileArgs([['Болт', 110, 'B1']]);
    expect(await saveCodes({ ...args, fileHash: 'выдуман' })).toEqual(['file_hash_mismatch']);
    const reply = await runAgent('savePriceImport', { ...args, fileHash: 'выдуман' });
    expect(reply).toContain('file_hash_mismatch');
    const direct: unknown = await savePriceImport
      .execute({ ...args, fileHash: 'выдуман' }, deps, CTX)
      .catch((e: unknown) => e);
    expect(isDomainError(direct) && direct.code).toBe('validation_failed');
    expect(await storedPrices()).toEqual([['Болт', 100, 'RUB']]);
  });

  test('файл изменился после чтения: старый хэш не подходит', async () => {
    const args = await fileArgs([['Болт', 110, 'B1']]);
    putFile(deps, PATH, skuCsv([['Болт', 900, 'B1']]));
    expect(await saveCodes(args)).toContain('file_hash_mismatch');
  });

  test('нарезка по 48%: второй шаг записывается, накопленный скачок виден в отчёте', async () => {
    const first = await fileArgs([['Болт', 148, 'B1']]);
    expect(await saveCodes(first)).toEqual([]);
    await savePriceImport.execute(first, deps, CTX);
    expect(await storedPrices()).toEqual([['Болт', 148, 'RUB']]);
    // Подтверждённой остаётся цена до изменения, пока скачок не принят записью.
    expect((await loadConfirmedPrices(deps, SUPPLIER_ID)).map((i) => i.price)).toEqual([100]);

    const second = await fileArgs([['Болт', 219, 'B1']]);
    // Скачок (от подтверждённой цены +119%) решения человека не требует.
    expect(await saveCodes(second)).toEqual([]);
    const reply = await runAgent('savePriceImport', second);
    expect(reply).not.toContain('error');
    expect(await storedPrices()).toEqual([['Болт', 219, 'RUB']]);
  });

  test('накопленный скачок проходит без кнопки, попадает в отчёт и становится опорой', async () => {
    await savePriceImport.execute(await fileArgs([['Болт', 148, 'B1']]), deps, CTX);
    const { fileHash } = await stageDiskCsv(deps, [['Болт', 219, 'B1']]);
    const commit = { supplierId: SUPPLIER_ID, fileHash };
    const codes = async (): Promise<string[]> =>
      (await stagedImportValidator.validate(commit, deps, CTX)).map((issue) => issue.code);
    expect(await codes()).toEqual([]);
    const preview = await previewPriceChanges.execute(commit, deps, CTX);
    expect(preview).not.toHaveProperty('approvalStatus');
    expect(preview.counts.jumps).toBe(1);
    expect(preview.jumpExamples[0]).toMatchObject({
      oldPrice: 148,
      newPrice: 219,
      confirmedPrice: 100,
    });
    await commitPriceImport.execute(commit, deps, CTX);
    expect(await storedPrices()).toEqual([['Болт', 219, 'RUB']]);
    expect((await loadConfirmedPrices(deps, SUPPLIER_ID)).map((i) => i.price)).toEqual([219]);
    // Дальше отсчёт идёт от записанной цены: +10% не скачок.
    const next = await stageDiskCsv(deps, [['Болт', 240, 'B1']]);
    const nextPreview = await previewPriceChanges.execute(
      { supplierId: SUPPLIER_ID, fileHash: next.fileHash },
      deps,
      CTX,
    );
    expect(nextPreview.counts.jumps).toBe(0);
  });

  test('позицию сняли и вернули дороже: скачок от цены до снятия виден, запись идёт', async () => {
    await savePriceImport.execute(await fileArgs([['Гайка', 5, 'G1']]), deps, CTX);
    expect(await storedPrices()).toEqual([['Гайка', 5, 'RUB']]);
    const rows: Array<[string, number, string]> = [
      ['Гайка', 5, 'G1'],
      ['Болт', 300, 'B1'],
    ];
    const back = await fileArgs(rows);
    expect(await saveCodes(back)).toEqual([]);
    const { fileHash } = await stageDiskCsv(deps, rows);
    const preview = await previewPriceChanges.execute(
      { supplierId: SUPPLIER_ID, fileHash },
      deps,
      CTX,
    );
    expect(preview.counts.jumps).toBe(1);
    await savePriceImport.execute(back, deps, CTX);
    expect((await storedPrices()).map(([name]) => name).sort()).toEqual(['Болт', 'Гайка']);
  });

  test('смена валюты при том же числе - скачок: записывается, решения не требует', async () => {
    putFile(deps, PATH, 'Наименование,Цена,Артикул,Валюта\nБолт,100,B1,USD');
    const input = { path: PATH, supplierId: SUPPLIER_ID, columns: { ...COLUMNS, currency: 3 } };
    const { fileHash } = await normalizePriceTable.execute(input, deps, CTX);
    expect(await saveCodes({ ...input, fileHash })).toEqual([]);
    await savePriceImport.execute({ ...input, fileHash }, deps, CTX);
    expect(await storedPrices()).toEqual([['Болт', 100, 'USD']]);
  });

  test('артикул пропал или сменил регистр: скачок виден в отчёте, запись идёт', async () => {
    putFile(deps, PATH, 'Наименование,Цена\nБолт,300');
    const noSku = { path: PATH, supplierId: SUPPLIER_ID, columns: { name: 0, price: 1 } };
    const { fileHash } = await normalizePriceTable.execute(noSku, deps, CTX);
    expect(await saveCodes({ ...noSku, fileHash })).toEqual([]);
    expect(await saveCodes(await fileArgs([['Болт', 300, 'b1']]))).toEqual([]);
    const staged = await stageDiskCsv(deps, [['Болт', 300, 'b1']]);
    const preview = await previewPriceChanges.execute(
      { supplierId: SUPPLIER_ID, fileHash: staged.fileHash },
      deps,
      CTX,
    );
    expect(preview.counts.jumps).toBe(1);
  });

  test('фиксация считает базу на момент записи: изменение базы скачок не блокирует', async () => {
    const { fileHash } = await stageDiskCsv(deps, [['Болт', 140, 'B1']]);
    const commit = { supplierId: SUPPLIER_ID, fileHash };
    expect(await stagedImportValidator.validate(commit, deps, CTX)).toEqual([]);
    // Между проверкой и записью база изменилась: цена упала, теперь это скачок (+133%).
    await deps.prices.saveImport(SUPPLIER_ID, [skuItem('Болт', 60, 'B1')], 'between');
    await commitPriceImport.execute(commit, deps, CTX);
    expect(await storedPrices()).toEqual([['Болт', 140, 'RUB']]);
  });

  test('R9-A5-02: параллельный импорт успел записать прайс - conflict, без записи', async () => {
    const { fileHash } = await stageDiskCsv(deps, [['Болт', 110, 'B1']]);
    const commit = { supplierId: SUPPLIER_ID, fileHash };
    const save = deps.prices.saveImport.bind(deps.prices);
    // Другой импорт пишет прайс уже после проверок фиксации, прямо перед её записью.
    let injected = false;
    deps.prices.saveImport = async (supplierId, items, key, options) => {
      if (!injected) {
        injected = true;
        await save(SUPPLIER_ID, [skuItem('Болт', 105, 'B1')], 'parallel');
      }
      await save(supplierId, items, key, options);
    };
    const error: unknown = await commitPriceImport
      .execute(commit, deps, CTX)
      .catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('conflict');
    expect(isDomainError(error) && error.message).toContain('price_base_changed');
    expect(await storedPrices()).toEqual([['Болт', 105, 'RUB']]);
    // Повторная фиксация сверяется с новым прайсом и проходит.
    deps.prices.saveImport = save;
    await commitPriceImport.execute(commit, deps, CTX);
    expect(await storedPrices()).toEqual([['Болт', 110, 'RUB']]);
  });

  test('позиция чужого поставщика и дата из будущего в staging: отказ', async () => {
    const future = new Date(deps.clock.now().getTime() + 2 * PRICE_DATE_FUTURE_TOLERANCE_MS);
    const cases: Array<[string, PriceItem]> = [
      ['foreign_supplier_item', { ...skuItem('Болт', 101, 'B1'), supplierId: 's2' }],
      ['price_date_out_of_window', { ...skuItem('Болт', 101, 'B1'), date: future.toISOString() }],
    ];
    for (const [code, item] of cases) {
      const fileHash = `h-${code}`;
      // Происхождение пишет stagePriceRows; здесь staging кладётся напрямую, значит и запись
      // происхождения (диск) нужна явно: без неё отправитель считается неподтверждённым.
      await deps.state?.put(IMPORT_META_NAMESPACE, stagingImportId(SUPPLIER_ID, fileHash), {
        source: 'disk',
        notes: [],
      });
      await deps.staging.append(
        stagingImportId(SUPPLIER_ID, fileHash),
        { supplierId: SUPPLIER_ID, fileHash },
        { key: 'k', table: '0', tableRows: 1, items: [item] },
        deps.clock.now(),
      );
      const commit = { supplierId: SUPPLIER_ID, fileHash };
      const codes = (await stagedImportValidator.validate(commit, deps, CTX)).map((i) => i.code);
      expect(codes).toEqual([code]);
      const error: unknown = await commitPriceImport
        .execute(commit, deps, CTX)
        .catch((e: unknown) => e);
      expect(isDomainError(error) && error.code).toBe('validation_failed');
    }
    expect(await storedPrices()).toEqual([['Болт', 100, 'RUB']]);
  });

  test('без хранилища состояния скачок запись не блокирует', async () => {
    const { state: _state, ...withoutState } = deps;
    putFile(deps, PATH, skuCsv([['Болт', 300, 'B1']]));
    const input = { path: PATH, supplierId: SUPPLIER_ID, columns: COLUMNS };
    const { fileHash } = await normalizePriceTable.execute(input, withoutState, CTX);
    const issues = await priceImportValidator.validate({ ...input, fileHash }, withoutState, CTX);
    expect(issues.map((issue) => issue.code)).toEqual([]);
  });
});

describe('D-12: вложение письма - только прайс поставщика-отправителя', () => {
  const attachment = {
    fileName: 'p.csv',
    mimeType: 'text/csv',
    bytes: encode(skuCsv([['Болт', 1, 'B1']])),
  };
  const MAIL_CTX = employeeContext(USER_1, USER_THREAD_1);
  const MAIL_PATH = `mail:${mailRecordId(USER_1, 'm1')}#0`;

  beforeEach(async () => {
    await deps.suppliers.upsert({ id: 's2', name: 'Конкурент', email: 'sales@rival.example' });
    await deps.prices.saveImport('s2', [{ ...skuItem('Болт', 100, 'B1'), supplierId: 's2' }], 's2');
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments: [attachment] }));
    deps.mailboxes.deliver(USER_1,
      mailMessage({ id: 'm2', from: 'stranger@spam.example', attachments: [attachment] }),
    );
    await readPriceMail.execute({ senderQuery: 'spam.example' }, deps, employeeContext(USER_1, USER_THREAD_1));
  });

  test('письмо s1 нельзя разобрать как прайс s2 ни одним инструментом', async () => {
    const input = { path: MAIL_PATH, supplierId: 's2', columns: COLUMNS };
    const attempts: Array<Promise<unknown>> = [
      stagePriceRows.execute({ ...input, reset: true }, deps, MAIL_CTX),
      normalizePriceTable.execute(input, deps, MAIL_CTX),
      savePriceImport.execute({ ...input, fileHash: 'любой' }, deps, MAIL_CTX),
      priceImportValidator.validate(
        { ...input, fileHash: 'любой' },
        deps,
        MAIL_CTX,
      ) as Promise<unknown>,
    ];
    for (const attempt of attempts) {
      const error: unknown = await attempt.catch((e: unknown) => e);
      expect(isDomainError(error) && error.code).toBe('conflict');
    }
    expect(await deps.staging.load(stagingImportId('s2', 'любой'))).toBeNull();
    expect((await deps.prices.listBySupplier('s2')).map((i) => i.price)).toEqual([100]);
    const reply = await runAgent('stagePriceRows', { ...input, reset: true });
    expect(reply).toContain('error');
  });

  test('своему поставщику вложение разбирается; письмо неизвестного - никому', async () => {
    const own = { path: MAIL_PATH, supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true };
    expect((await stagePriceRows.execute(own, deps, MAIL_CTX)).staged).toBe(1);
    const stranger: unknown = await stagePriceRows
      .execute({ ...own, path: `mail:${mailRecordId(USER_1, 'm2')}#0` }, deps, MAIL_CTX)
      .catch((e: unknown) => e);
    // Письмо неизвестного отправителя читается по просьбе, но в базу не разбирается никому.
    expect(isDomainError(stranger) && stranger.code).toBe('conflict');
  });
});
