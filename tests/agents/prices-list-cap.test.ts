import { beforeEach, describe, expect, test } from 'bun:test';
import { MAX_LISTED_PRICE_FILES, listPriceFiles } from '../../src/agents/prices/list-price-files';
import { MAX_SIMILAR_FILE_HINTS } from '../../src/agents/prices/price-sources';
import { readPriceFile } from '../../src/agents/prices/read-price-file';
import { isDomainError } from '@business-ai/core';
import { CTX, buildPricesDeps, putFile } from './support';

/** Сбой Б (этап 107): список файлов не раздувает ответ, not_found подсказывает имена. */

let deps: Awaited<ReturnType<typeof buildPricesDeps>>;

beforeEach(async () => {
  deps = await buildPricesDeps();
});

describe('listPriceFiles: предел и фильтр', () => {
  test('сверх предела: обрезка, truncated, total и подсказка уточнить запрос', async () => {
    const extra = 25;
    for (let i = 0; i < MAX_LISTED_PRICE_FILES + extra; i += 1) putFile(deps, `p${i}.csv`, 'x');
    const out = await listPriceFiles.execute({}, deps, CTX);
    expect(out.files).toHaveLength(MAX_LISTED_PRICE_FILES);
    expect(out.truncated).toBe(true);
    expect(out.total).toBe(MAX_LISTED_PRICE_FILES + extra);
    expect(out.hint).toContain('query');
  });

  test('ровно в пределе: без пометок', async () => {
    for (let i = 0; i < MAX_LISTED_PRICE_FILES; i += 1) putFile(deps, `p${i}.csv`, 'x');
    const out = await listPriceFiles.execute({}, deps, CTX);
    expect(out.files).toHaveLength(MAX_LISTED_PRICE_FILES);
    expect(out.truncated).toBeUndefined();
  });

  test('query - подстрока пути без учёта регистра', async () => {
    putFile(deps, 'Обувь/Прайс_Ромашка.csv', 'x');
    putFile(deps, 'Одежда/другой.csv', 'x');
    const out = await listPriceFiles.execute({ query: 'ромашка' }, deps, CTX);
    expect(out.files.map((f) => f.path)).toEqual(['Обувь/Прайс_Ромашка.csv']);
  });

  test('query сужает и список изменений (known)', async () => {
    putFile(deps, 'a-one.csv', 'x');
    putFile(deps, 'b-two.csv', 'x');
    const out = await listPriceFiles.execute({ known: [], query: 'two' }, deps, CTX);
    expect(out.files.map((f) => f.path)).toEqual(['b-two.csv']);
  });
});

describe('readPriceFile: not_found с подсказкой', () => {
  test('перечисляет не более 10 похожих имён, остальной диск не показывает', async () => {
    for (let i = 0; i < 15; i += 1) putFile(deps, `Прайс-лист_Ромашка_${i}.csv`, 'x');
    putFile(deps, 'совсем_другое.csv', 'x');
    const error = await readPriceFile
      .execute({ path: 'Прайс-лист_ Ромашка_ [PERSON_1]_11.csv' }, deps, CTX)
      .catch((e: unknown) => e);
    expect(isDomainError(error) && error.code === 'not_found').toBe(true);
    const message = (error as Error).message;
    expect(message.match(/Ромашка_\d+\.csv/g)).toHaveLength(MAX_SIMILAR_FILE_HINTS);
    expect(message).not.toContain('совсем_другое');
  });

  test('похожих нет: прежнее сообщение без списка', async () => {
    putFile(deps, 'совсем_другое.csv', 'x');
    const error = await readPriceFile
      .execute({ path: 'нет-такого.csv' }, deps, CTX)
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe('Файл нет-такого.csv не найден.');
  });
});
