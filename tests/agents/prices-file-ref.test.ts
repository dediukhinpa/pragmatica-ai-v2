import { beforeEach, describe, expect, test } from 'bun:test';
import { FILE_REF_HEX_CHARS, FILE_REF_PREFIX, fileRefOf } from '../../src/agents/prices/file-ref';
import { priceDiskSyncInput } from '../../src/agents/prices/price-disk-sync';
import { priceRetryInput } from '../../src/agents/prices/disk-sync-retry';
import { readPriceFile } from '../../src/agents/prices/read-price-file';
import { reportToManager } from '../../src/agents/prices/report-to-manager';
import { stableHash } from '@business-ai/core';
import { isDomainError } from '@business-ai/core';
import { CTX, FILE_REF_SECRET, buildPricesDeps, putFile } from './support';

/** Сбой А (этап 107): путь с фамилией в имени не должен зависеть от переписывания моделью. */

const SURNAME_FILE = 'Обувь/Прайс-лист_ Товар_ Иванова_11.08.2025.csv';
const TABLE = 'Наименование,Цена\nБолт,10';

let deps: Awaited<ReturnType<typeof buildPricesDeps>>;

beforeEach(async () => {
  deps = await buildPricesDeps();
  putFile(deps, SURNAME_FILE, TABLE);
  putFile(deps, 'Обувь/Прайс-лист_ Другой_ Петрова_11.08.2025.csv', TABLE);
});

describe('поручение несёт fileRef, а не путь', () => {
  test('в тексте нет пути и фамилии, есть идентификатор', () => {
    const text = priceDiskSyncInput(SURNAME_FILE, FILE_REF_SECRET);
    expect(text).toContain(fileRefOf(SURNAME_FILE, FILE_REF_SECRET));
    expect(text).not.toContain('Иванова');
    expect(text).not.toContain('Обувь');
    expect(priceRetryInput(SURNAME_FILE, 2, FILE_REF_SECRET)).toContain(fileRefOf(SURNAME_FILE, FILE_REF_SECRET));
  });

  test('fileRef детерминирован и различает файлы', () => {
    expect(fileRefOf(SURNAME_FILE, FILE_REF_SECRET)).toBe(fileRefOf(SURNAME_FILE, FILE_REF_SECRET));
    expect(fileRefOf(SURNAME_FILE, FILE_REF_SECRET)).not.toBe(fileRefOf('другой.csv', FILE_REF_SECRET));
  });
});

describe('fileRef: HMAC с серверным секретом', () => {
  test('не равен бессолевому FNV-хэшу пути и не содержит его', () => {
    const fnv = stableHash(['file-ref', SURNAME_FILE]);
    expect(fileRefOf(SURNAME_FILE, FILE_REF_SECRET)).not.toContain(fnv);
  });

  test('стабилен при одном секрете и различается при разных', () => {
    const first = fileRefOf(SURNAME_FILE, 'секрет-1');
    expect(fileRefOf(SURNAME_FILE, 'секрет-1')).toBe(first);
    expect(fileRefOf(SURNAME_FILE, 'секрет-2')).not.toBe(first);
  });

  test('длина фиксирована константой', () => {
    const ref = fileRefOf(SURNAME_FILE, FILE_REF_SECRET);
    expect(ref).toBe(`${FILE_REF_PREFIX}${ref.slice(FILE_REF_PREFIX.length)}`);
    expect(ref.length).toBe(FILE_REF_PREFIX.length + FILE_REF_HEX_CHARS);
  });

  test('fileRef от другого секрета не разрешается', async () => {
    const error = await readPriceFile
      .execute({ path: fileRefOf(SURNAME_FILE, 'чужой-секрет') }, deps, CTX)
      .catch((e: unknown) => e);
    expect(isDomainError(error) && error.code === 'not_found').toBe(true);
  });
});

describe('readPriceFile: fileRef и восстановление пути', () => {
  test('fileRef читает файл; в ответе реальный путь, как раньше', async () => {
    const out = await readPriceFile.execute({ path: fileRefOf(SURNAME_FILE, FILE_REF_SECRET) }, deps, CTX);
    expect(out.path).toBe(SURNAME_FILE);
    expect(out.markdown).toContain('Болт');
  });

  test('неизвестный fileRef - not_found без подсказок по всему диску', async () => {
    const error = await readPriceFile
      .execute({ path: fileRefOf('нет/такого.csv', FILE_REF_SECRET) }, deps, CTX)
      .catch((e: unknown) => e);
    expect(isDomainError(error) && error.code === 'not_found').toBe(true);
  });

  test('схлопнутые двойные пробелы восстанавливаются', async () => {
    putFile(deps, 'Обувь/Прайс-лист_  Обувь_  Сидорова_11.08.2025.csv', TABLE);
    const out = await readPriceFile.execute(
      { path: 'Обувь/Прайс-лист_ Обувь_ Сидорова_11.08.2025.csv' },
      deps,
      CTX,
    );
    expect(out.path).toBe('Обувь/Прайс-лист_  Обувь_  Сидорова_11.08.2025.csv');
  });

  test('токен ПДн вместо фамилии подставляется по единственному совпадению', async () => {
    const out = await readPriceFile.execute(
      { path: 'Обувь/Прайс-лист_ Товар_ [PERSON_1]_11.08.2025.csv' },
      deps,
      CTX,
    );
    expect(out.path).toBe(SURNAME_FILE);
  });

  test('токен неоднозначен (два файла) - не угадываем, not_found', async () => {
    putFile(deps, 'Обувь/Прайс-лист_ Товар_ Сидорова_11.08.2025.csv', TABLE);
    const error = await readPriceFile
      .execute({ path: 'Обувь/Прайс-лист_ Товар_ [PERSON_1]_11.08.2025.csv' }, deps, CTX)
      .catch((e: unknown) => e);
    expect(isDomainError(error) && error.code === 'not_found').toBe(true);
  });
});

describe('looseMatch: подстановка вместо токена ПДн ограничена', () => {
  const TOKEN_PATH = 'Обувь/Прайс-лист_ Товар_ [PERSON_1]_11.08.2025.csv';
  /** Диск без файла с Ивановой: остаётся только то, что кладёт тест. */
  async function onlyDisk(...names: string[]): Promise<typeof deps> {
    const fresh = await buildPricesDeps();
    for (const name of names) putFile(fresh, name, TABLE);
    return fresh;
  }
  const readNotFound = async (disk: typeof deps): Promise<boolean> => {
    const error = await readPriceFile.execute({ path: TOKEN_PATH }, disk, CTX).catch((e) => e);
    return isDomainError(error) && error.code === 'not_found';
  };

  test('до трёх слов (фамилия имя отчество) подставляются', async () => {
    const name = 'Обувь/Прайс-лист_ Товар_ Иванов Пётр Сергеевич_11.08.2025.csv';
    const out = await readPriceFile.execute({ path: TOKEN_PATH }, await onlyDisk(name), CTX);
    expect(out.path).toBe(name);
  });

  test('четыре слова вместо токена - чужой файл не подходит', async () => {
    const disk = await onlyDisk(
      'Обувь/Прайс-лист_ Товар_ Иванов Пётр Сергеевич Младший_11.08.2025.csv',
    );
    expect(await readNotFound(disk)).toBe(true);
  });

  test('точка в подстановке (инициалы, расширение) - не подходит', async () => {
    const initials = await onlyDisk('Обувь/Прайс-лист_ Товар_ Иванов И.И._11.08.2025.csv');
    const extension = await onlyDisk('Обувь/Прайс-лист_ Товар_ Х.csv_11.08.2025.csv');
    expect(await readNotFound(initials)).toBe(true);
    expect(await readNotFound(extension)).toBe(true);
  });

  test('подстановка не пересекает границу каталога', async () => {
    const disk = await onlyDisk('Обувь/Прайс-лист_ Товар_ Иванов/Сидоров_11.08.2025.csv');
    expect(await readNotFound(disk)).toBe(true);
  });
});

describe('reportToManager: в тексте имя файла, не fileRef', () => {
  test('подпись берётся из реального пути', async () => {
    const sent: string[] = [];
    const original = deps.chat.reply.bind(deps.chat);
    deps.chat.reply = async (thread, message, key) => {
      sent.push(message.text);
      return original(thread, message, key);
    };
    await reportToManager.execute(
      {
        kind: 'scan_skipped',
        path: fileRefOf(SURNAME_FILE, FILE_REF_SECRET),
        fileHash: 'h1',
        issueCodes: [],
        updated: 0,
        needsReview: 0,
      },
      deps,
      CTX,
    );
    expect(sent.join('\n')).not.toContain('fileref:');
    expect(sent.join('\n')).toContain('Прайс-лист_ Товар_ Иванова_11.08.2025.csv');
  });
});
