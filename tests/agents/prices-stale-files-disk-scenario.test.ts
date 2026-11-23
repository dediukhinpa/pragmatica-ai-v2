import { beforeEach, describe, expect, test } from 'bun:test';
import {
  FixedClock,
  MemoryFileAuthorship,
  MemoryStaffDirectory,
  type MemoryChatChannel,
  type MemoryFileSource,
} from '@business-ai/adapters';
import { MemoryPriceTableIndex } from '../../src/kit/adapters/memory/price-table-index';
import { PRICES_AGENT_ID, type PricesDeps } from '../../src/agents/prices/deps';
import { recordEmployeeContact } from '@business-ai/core';
import { runStalePriceFilesCheck } from '../../src/agents/prices/stale-price-files';
import type { StaffPerson } from '@business-ai/core';
import {
  RESPONSIBLE_THREAD,
  buildFullPricesDeps,
  encode,
  type FullPricesDeps,
} from './prices-support';

/**
 * Сценарий на выборке путей как на боевом диске: PRICES_FILES_ROOT = корень диска
 * (ресурсы produkciya, zakupki, sait).
 */

const TZ = 'Europe/Moscow';
const MONDAY_0900 = new Date('2026-10-12T06:00:00Z');
const DEPARTMENT = 'department:5';
const SCAN_PREFIXES = ['produkciya/'];
const EXCLUDE = 'архив|не брать';
const THREAD_POKROVSKAYA = 'bot/pokrovskaya';
const THREAD_BOLOTIN = 'bot/bolotin';

const POKROVSKAYA: StaffPerson = {
  userId: 'u-pokrovskaya',
  lastName: 'Покровская',
  firstName: 'Анна',
};
const BOLOTIN: StaffPerson = { userId: 'u-bolotin', lastName: 'Болотин', firstName: 'Павел' };

const CONTRACT = 'produkciya/2_Контрактная продукция';
const FOOD = `${CONTRACT}/6 Продукты питания_Покровская`;
const CERAMICS = `${CONTRACT}/12 Керамика_бетон_Покровская_Болотин`;
const AROMA = `${CONTRACT}/7 ПромоСувениры_Болотин/Аромапродукция и косметика_Покровская`;

// Просрочены по дате в имени.
const READY_PRICE = 'produkciya/1_Готовая продукция/Прайс_01.01.2026.xlsx';
const FOOD_PRICE = `${FOOD}/Прайс_01.02.2026.xlsx`;
const CERAMICS_PRICE = `${CERAMICS}/Прайс_01.02.2026.xlsx`;
const AROMA_PRICE = `${AROMA}/Прайс_01.02.2026.xlsx`;
// Таблица цен в базе, слова «прайс» в имени и даты нет - «без даты».
const FOOD_TABLE_NO_WORD = `${FOOD}/Список поставки.xlsx`;
// Не в базе и без слова - не попадает.
const FOOD_NOT_INDEXED = `${FOOD}/Фото каталога.xlsx`;
// В базе, но не таблица цен - не попадает.
const FOOD_NOT_TABLE = `${FOOD}/Описание.xlsx`;
// Исключённые папки.
const ARCHIVE_PRICE = 'produkciya/Архив/Прайс_01.01.2025.xlsx';
const DO_NOT_TAKE_PRICE = 'produkciya/1_Готовая продукция/НЕ БРАТЬ/Прайс_01.01.2025.xlsx';
// Вне области проверки.
const ZAKUPKI_KP = 'zakupki/КП_Ромашка_01.02.2026.xlsx';
const ZAKUPKI_SET = 'zakupki/Расчёт набора_01.02.2026.xlsx';
const ZAKUPKI_LOGISTICS = 'zakupki/Логистика/Прайс_логистики_01.01.2026.xlsx';
const SAIT_MATERIAL = 'sait/Материалы_01.02.2026.xlsx';

const TABLE = `Цена\n${Array.from({ length: 6 }, (_, i) => `| Товар ${i} | ${100 + i},50 |`).join('\n')}`;
const NO_TABLE = 'Описание продукции без таблицы.';

const ALL_PATHS = [
  READY_PRICE,
  FOOD_PRICE,
  CERAMICS_PRICE,
  AROMA_PRICE,
  FOOD_TABLE_NO_WORD,
  FOOD_NOT_INDEXED,
  FOOD_NOT_TABLE,
  ARCHIVE_PRICE,
  DO_NOT_TAKE_PRICE,
  ZAKUPKI_KP,
  ZAKUPKI_SET,
  ZAKUPKI_LOGISTICS,
  SAIT_MATERIAL,
];

let deps: FullPricesDeps;
let chat: MemoryChatChannel;
let tables: MemoryPriceTableIndex;

function run(): ReturnType<typeof runStalePriceFilesCheck> {
  return runStalePriceFilesCheck(deps as PricesDeps, { timezone: TZ });
}

/** Пути из строк «• путь — …» в сообщениях заданного треда (или во всех). */
function listed(thread?: string): string[] {
  const messages = thread === undefined ? chat.outbox : chat.outboxOf(thread);
  return messages
    .flatMap((m) => (m.message?.text ?? '').split('\n'))
    .filter((line) => line.startsWith('• '))
    .map((line) => line.slice(2).split(' — ')[0] ?? '');
}

/** Включить настройки прода: префикс produkciya/, исключения, проверка по содержимому. */
function enableScope(): void {
  deps.staleScan = { prefixes: SCAN_PREFIXES, excludePattern: EXCLUDE };
  deps.priceTables = tables;
}

beforeEach(async () => {
  const base = await buildFullPricesDeps();
  const clock = new FixedClock(MONDAY_0900);
  const staff = new MemoryStaffDirectory();
  staff.set(DEPARTMENT, [POKROVSKAYA, BOLOTIN]);
  deps = {
    ...base,
    clock,
    authorship: new MemoryFileAuthorship(),
    staff,
    staffDepartmentIds: [DEPARTMENT],
  };
  chat = deps.chat;
  const files = deps.files as MemoryFileSource;
  for (const path of ALL_PATHS) files.put(path, encode('x'), MONDAY_0900.getTime());
  for (const [userId, threadId] of [
    [POKROVSKAYA.userId, THREAD_POKROVSKAYA],
    [BOLOTIN.userId, THREAD_BOLOTIN],
  ] as const) {
    await recordEmployeeContact(base.state, clock, { threadId, userId }, PRICES_AGENT_ID);
  }
  tables = new MemoryPriceTableIndex();
  tables.put(FOOD_TABLE_NO_WORD, [TABLE]);
  tables.put(FOOD_NOT_TABLE, [NO_TABLE]);
  tables.put(ZAKUPKI_SET, [TABLE]);
  tables.put(ZAKUPKI_KP, [TABLE]);
});

describe('боевой диск: настройки включены', () => {
  test('в сообщениях только нужные файлы produkciya', async () => {
    enableScope();
    const result = await run();
    expect(result.status).toBe('sent');
    // Файл с двумя адресатами встречается в двух сообщениях - сравниваем уникальные пути.
    expect([...new Set(listed())].sort()).toEqual(
      [READY_PRICE, FOOD_PRICE, CERAMICS_PRICE, AROMA_PRICE, FOOD_TABLE_NO_WORD].sort(),
    );
  });

  test('архив, «НЕ БРАТЬ», zakupki и sait не проверяются', async () => {
    enableScope();
    await run();
    const paths = listed();
    for (const excluded of [
      ARCHIVE_PRICE,
      DO_NOT_TAKE_PRICE,
      ZAKUPKI_KP,
      ZAKUPKI_SET,
      ZAKUPKI_LOGISTICS,
      SAIT_MATERIAL,
    ]) {
      expect(paths).not.toContain(excluded);
    }
  });

  test('получатели: личные треды по фамилии, без фамилии - ответственный', async () => {
    enableScope();
    await run();
    expect(listed(THREAD_POKROVSKAYA).sort()).toEqual(
      [FOOD_PRICE, FOOD_TABLE_NO_WORD, CERAMICS_PRICE, AROMA_PRICE].sort(),
    );
    // Две фамилии в самой глубокой папке - уведомление получают оба.
    expect(listed(THREAD_BOLOTIN)).toEqual([CERAMICS_PRICE]);
    // В Аромапродукции берётся только Покровская (Болотин - папкой выше).
    expect(listed(THREAD_BOLOTIN)).not.toContain(AROMA_PRICE);
    expect(listed(RESPONSIBLE_THREAD)).toEqual([READY_PRICE]);
  });

  test('таблица цен без слова «прайс» и без даты попадает в «без даты»', async () => {
    enableScope();
    const result = await run();
    expect(result.undated).toBe(1);
    const text = chat.outboxOf(THREAD_POKROVSKAYA).map((m) => m.message?.text ?? '').join('\n');
    expect(text).toContain('Дата в названии не найдена');
    expect(text).toContain(FOOD_TABLE_NO_WORD);
  });

  test('файл не в базе без слова и файл без таблицы не попадают', async () => {
    enableScope();
    await run();
    expect(listed()).not.toContain(FOOD_NOT_INDEXED);
    expect(listed()).not.toContain(FOOD_NOT_TABLE);
  });

  test('запросы к базе одной пачкой', async () => {
    enableScope();
    await run();
    expect(tables.calls).toBe(1);
  });
});

describe('боевой диск: настройки выключены', () => {
  test('поведение прежнее: архив, zakupki и sait проверяются как раньше', async () => {
    await run();
    const paths = listed();
    expect(paths).toContain(ARCHIVE_PRICE);
    expect(paths).toContain(DO_NOT_TAKE_PRICE);
    expect(paths).toContain(ZAKUPKI_SET);
    expect(paths).toContain(ZAKUPKI_LOGISTICS);
    expect(paths).toContain(SAIT_MATERIAL);
    expect(tables.calls).toBe(0);
  });
});
