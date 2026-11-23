import { beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock, type MemoryFileSource } from '@business-ai/adapters';
import {
  MemoryPriceFileDateFallback,
} from '../../src/kit/adapters/memory/price-file-date-fallback';
import {
  STALE_FILES_LISTED_LIMIT,
  listStalePriceFiles,
} from '../../src/agents/prices/stale-price-files-tool';
import { listPriceFiles } from '../../src/agents/prices/list-price-files';
import { type PricesDeps } from '../../src/agents/prices/deps';
import { DEFAULT_PRICE_STALE_EXCLUDE_PATTERN } from '../../src/kit/domain/price-stale-scope';
import { buildFullPricesDeps, encode, type FullPricesDeps } from './prices-support';
import { CTX } from './support';

/**
 * Справка «какие прайсы устарели» по запросу (тест 28.10.2026): устаревание по дате В НАЗВАНИИ,
 * дата изменения файла не учитывается, сегодняшняя дата - в ответе, область - как у
 * понедельничной проверки.
 */

const TZ = 'Asia/Yekaterinburg';
/** Среда 28.10.2026, 12:00 по Екатеринбургу: не понедельник - справка от расписания не зависит. */
const WEDNESDAY_NOON = new Date('2026-10-28T07:00:00Z');
const FRESH_MTIME_MS = WEDNESDAY_NOON.getTime();
/** Давняя дата изменения: решение по ней приниматься не должно. */
const OLD_MTIME_MS = new Date('2024-01-15T07:00:00Z').getTime();
const BODY = encode('x');
const MUGS = 'produkciya/Кружки/Прайс_Кружки_Сублимация_28.02.2026.xlsx';

let deps: FullPricesDeps;
let files: MemoryFileSource;

function put(path: string, mtimeMs: number = FRESH_MTIME_MS): void {
  files.put(path, BODY, mtimeMs);
}

function run(): ReturnType<typeof listStalePriceFiles.execute> {
  return listStalePriceFiles.execute({}, deps as PricesDeps, CTX);
}

beforeEach(async () => {
  const base = await buildFullPricesDeps();
  deps = { ...base, clock: new FixedClock(WEDNESDAY_NOON), businessTimeZone: TZ };
  files = deps.files as MemoryFileSource;
});

describe('listStalePriceFiles', () => {
  test('файл с датой в названии старше 3 месяцев - в списке, даже со свежей датой изменения', async () => {
    put(MUGS);
    const out = await run();
    expect(out.today).toBe('2026-10-28');
    expect(out.staleMonths).toBe(3);
    expect(out.stale).toEqual([{ path: MUGS, dateInName: '28.02.2026' }]);
    expect(out.moreStale).toBe(0);
  });

  test('свежая дата в названии при давней дате изменения - не устарел', async () => {
    put('produkciya/Текстиль/Прайс_Пледы_01.10.2026.xlsx', OLD_MTIME_MS);
    const out = await run();
    expect(out.stale).toEqual([]);
  });

  test('прайс без даты в названии - отдельно, без запасного разбора моделью', async () => {
    const fallback = new MemoryPriceFileDateFallback();
    deps = { ...deps, priceDateFallback: fallback };
    put('produkciya/Зонты/Прайс_Зонты.xlsx', OLD_MTIME_MS);
    const out = await run();
    expect(out.undated).toEqual([{ path: 'produkciya/Зонты/Прайс_Зонты.xlsx' }]);
    expect(fallback.calls).toBe(0);
  });

  test('область PRICE_STALE_*: вне префикса и в архиве - не в списке', async () => {
    deps = {
      ...deps,
      staleScan: {
        prefixes: ['produkciya/'],
        excludePattern: DEFAULT_PRICE_STALE_EXCLUDE_PATTERN,
      },
    };
    put(MUGS);
    put('Бухгалтерия/Прайс_Канцелярия_01.01.2025.xlsx');
    put('produkciya/Архив/Прайс_Зонты_01.01.2024.xlsx');
    put('produkciya/НЕ БРАТЬ/Прайс_Ручки_01.01.2024.xlsx');
    const out = await run();
    expect(out.stale.map((file) => file.path)).toEqual([MUGS]);
  });

  test('сообщений не отправляет: справка, а не рассылка', async () => {
    put(MUGS);
    await run();
    expect(deps.chat.outbox).toHaveLength(0);
  });

  test('сверх предела - остаток числом', async () => {
    const extra = 7;
    for (let i = 0; i < STALE_FILES_LISTED_LIMIT + extra; i += 1) {
      put(`produkciya/П${String(i).padStart(3, '0')}/Прайс_01.01.2025.xlsx`);
    }
    const out = await run();
    expect(out.stale).toHaveLength(STALE_FILES_LISTED_LIMIT);
    expect(out.moreStale).toBe(extra);
  });
});

describe('listPriceFiles: область прайсов', () => {
  test('с заданной областью - только папка прайсов без архивов', async () => {
    deps = {
      ...deps,
      staleScan: {
        prefixes: ['produkciya/'],
        excludePattern: DEFAULT_PRICE_STALE_EXCLUDE_PATTERN,
      },
    };
    put(MUGS);
    put('Бухгалтерия/Прайс_Канцелярия_01.01.2025.xlsx');
    put('produkciya/Архив/Прайс_Зонты_01.01.2024.xlsx');
    const out = await listPriceFiles.execute({}, deps as PricesDeps, CTX);
    expect(out.files.map((file) => file.path)).toEqual([MUGS]);
  });

  test('без области - весь корень, как раньше', async () => {
    put(MUGS);
    put('Бухгалтерия/Прайс_Канцелярия_01.01.2025.xlsx');
    const out = await listPriceFiles.execute({}, deps as PricesDeps, CTX);
    expect(out.files).toHaveLength(2);
  });
});
