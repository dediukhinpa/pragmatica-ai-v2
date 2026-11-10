import { beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock, type MemoryChatChannel, type MemoryFileSource } from '@business-ai/adapters';
import {
  MemoryPriceFileDateFallback,
} from '../../src/kit/adapters/memory/price-file-date-fallback';
import { MemoryPriceTableIndex } from '../../src/kit/adapters/memory/price-table-index';
import { IMPORT_META_NAMESPACE, type PricesDeps } from '../../src/agents/prices/deps';
import {
  PRICE_FILE_FALLBACK_MAX_CALLS,
  runStalePriceFilesCheck,
} from '../../src/agents/prices/stale-price-files';
import { listStalePriceSuppliers } from '../../src/agents/prices/stale-price-suppliers';
import { savePriceUpload } from '../../src/agents/prices/price-state';
import { DAY_MS, HOUR_MS } from '../../src/kit/domain/time';
import { PRICE_FILE_MAX_LISTED } from '../../src/kit/domain/monitoring';
import {
  RESPONSIBLE_THREAD,
  SCHEDULER_CTX,
  buildFullPricesDeps,
  encode,
  type FullPricesDeps,
} from './prices-support';
import type { PriceFileDateFallback } from '../../src/kit/ports/price-file-date-fallback';
import { MANAGER_THREAD, SUPPLIER_ID } from './support';

const TZ = 'Europe/Moscow';
const YEKATERINBURG = 'Asia/Yekaterinburg';
/** Понедельник 2026-10-12, 09:00 по Москве (06:00 UTC) - первый момент проверки. */
const MONDAY_0900 = new Date('2026-10-12T06:00:00Z');
const MONDAY_0859 = new Date('2026-10-12T05:59:00Z');
const MONDAY_1800 = new Date('2026-10-12T15:00:00Z');
const TUESDAY_1030 = new Date('2026-10-13T07:30:00Z');
/** Дата изменения у файлов в тестах всегда свежая: решение по ней не принимается. */
const FRESH_MTIME_MS = MONDAY_0900.getTime();
const BODY = encode('x');
/** Предел страниц истории импортов в проверке (зеркало константы модуля). */
const MAX_IMPORT_META_PAGES = 50;
const WEEK_MS = 7 * DAY_MS;

let deps: FullPricesDeps;
let clock: FixedClock;
let files: MemoryFileSource;
let chat: MemoryChatChannel;

function check(timezone: string = TZ): ReturnType<typeof runStalePriceFilesCheck> {
  return runStalePriceFilesCheck(deps as PricesDeps, { timezone });
}

/** Файл с заданной датой изменения (по умолчанию свежей). */
function put(path: string, mtimeMs: number = FRESH_MTIME_MS): void {
  files.put(path, BODY, mtimeMs);
}

/** Перевести часы на момент `at` (у `FixedClock` есть только сдвиг вперёд/назад). */
function setNow(at: Date): void {
  clock.advance(at.getTime() - clock.now().getTime());
}

function textOf(index = 0): string {
  return chat.outbox[index]?.message?.text ?? '';
}

beforeEach(async () => {
  deps = await buildFullPricesDeps();
  clock = new FixedClock(MONDAY_0900);
  deps = { ...deps, clock };
  files = deps.files as MemoryFileSource;
  chat = deps.chat;
});

describe('расписание: понедельник с 09:00', () => {
  test('понедельник 08:59 - не пишет, 09:00 - пишет', async () => {
    put('Металл/МеталлТорг/прайс_01.01.2026.xlsx');
    setNow(MONDAY_0859);
    expect((await check()).status).toBe('not_due');
    expect(chat.outbox).toHaveLength(0);

    setNow(MONDAY_0900);
    expect(await check()).toMatchObject({ status: 'sent', notified: 1 });
    expect(chat.outbox).toHaveLength(1);
  });

  test('вторник - не пишет: проверка только по понедельникам', async () => {
    put('Металл/МеталлТорг/прайс_01.01.2026.xlsx');
    setNow(TUESDAY_1030);
    expect((await check()).status).toBe('not_due');
    expect(chat.outbox).toHaveLength(0);
  });

  test('недоступен утром: позже в тот же понедельник уходит, во вторник нет', async () => {
    put('Металл/МеталлТорг/прайс_01.01.2026.xlsx');
    setNow(MONDAY_1800);
    expect((await check()).status).toBe('sent');
    setNow(TUESDAY_1030);
    expect((await check()).status).toBe('not_due');
    expect(chat.outbox).toHaveLength(1);
  });

  test('повтор в тот же понедельник не дублирует сообщение', async () => {
    put('a/старый_01.01.2026.xlsx');
    expect((await check()).status).toBe('sent');
    expect((await check()).status).toBe('already_done');
    clock.advance(HOUR_MS);
    expect((await check()).status).toBe('already_done');
    expect(chat.outbox).toHaveLength(1);
  });

  test('повтор после сбоя до слота: тот же ключ, канал не дублирует', async () => {
    put('a/старый_01.01.2026.xlsx');
    await check();
    // Слот потерян (сбой после отправки).
    await deps.state.clear('monitoring.v1');
    await check();
    expect(chat.outbox).toHaveLength(1);
  });

  test('пока файл устарел, он снова в списке каждый понедельник', async () => {
    put('a/старый_01.01.2026.xlsx');
    await check();
    clock.advance(WEEK_MS);
    expect(await check()).toMatchObject({ status: 'sent', notified: 1 });
    clock.advance(WEEK_MS);
    expect((await check()).status).toBe('sent');
    expect(chat.outbox).toHaveLength(3);
    expect(textOf(1)).toContain('a/старый_01.01.2026.xlsx');
  });

  test('файл обновили (новая дата в названии) - в списке больше нет', async () => {
    put('a/старый_01.01.2026.xlsx');
    await check();
    files.remove('a/старый_01.01.2026.xlsx');
    put('a/старый_12.10.2026.xlsx');
    clock.advance(WEEK_MS);
    expect((await check()).status).toBe('nothing');
    expect(chat.outbox).toHaveLength(1);
  });

  test('часовой пояс Asia/Yekaterinburg: понедельник 09:00 локально = 04:00 UTC', async () => {
    put('a/старый_01.01.2026.xlsx');
    setNow(new Date('2026-10-12T03:59:00Z'));
    expect((await check(YEKATERINBURG)).status).toBe('not_due');
    setNow(new Date('2026-10-12T04:00:00Z'));
    expect((await check(YEKATERINBURG)).status).toBe('sent');
    expect((await check(YEKATERINBURG)).status).toBe('already_done');
    expect(chat.outbox).toHaveLength(1);
  });

  test('день недели считается по местному времени, а не по UTC', async () => {
    put('a/старый_01.01.2026.xlsx');
    // Воскресенье 20:00 UTC = понедельник 01:00 в Екатеринбурге: день тот, час ещё ранний.
    setNow(new Date('2026-10-11T20:00:00Z'));
    expect((await check(YEKATERINBURG)).status).toBe('not_due');
    // Понедельник 20:00 UTC = вторник 01:00 в Екатеринбурге: понедельник кончился.
    setNow(new Date('2026-10-12T20:00:00Z'));
    expect((await check(YEKATERINBURG)).status).toBe('not_due');
    expect(chat.outbox).toHaveLength(0);
  });
});

describe('актуальность по дате в названии', () => {
  test('ровно 3 месяца - не устарел, на день больше - устарел', async () => {
    put('a/ровно_12.07.2026.xlsx');
    put('a/на_день_старше_11.07.2026.xlsx');
    expect(await check()).toMatchObject({ status: 'sent', notified: 1 });
    expect(textOf()).toContain('a/на_день_старше_11.07.2026.xlsx');
    expect(textOf()).not.toContain('a/ровно_12.07.2026.xlsx');
  });

  test('только файл ровно 3 месяца - сообщать нечего', async () => {
    put('a/ровно_12.07.2026.xlsx');
    expect((await check()).status).toBe('nothing');
    expect(chat.outbox).toHaveLength(0);
  });

  test('дата изменения старая, дата в названии свежая - в список не попадает', async () => {
    put('a/прайс_01.10.2026.xlsx', MONDAY_0900.getTime() - 400 * DAY_MS);
    expect((await check()).status).toBe('nothing');
    expect(chat.outbox).toHaveLength(0);
  });

  test('дата изменения свежая, дата в названии старая - в списке', async () => {
    put('a/прайс_01.01.2026.xlsx', MONDAY_0900.getTime());
    expect(await check()).toMatchObject({ status: 'sent', notified: 1 });
    expect(textOf()).toContain('a/прайс_01.01.2026.xlsx — 01.01.2026');
  });

  test('дата берётся из названия файла, а не из каталогов пути', async () => {
    put('Архив 01.01.2025/прайс_12.10.2026.xlsx');
    expect((await check()).status).toBe('nothing');
  });

  test('чужие расширения пропускаются, сканы и текстовые прайсы учитываются', async () => {
    put('Металл/заметки_01.01.2026.docm');
    put('Металл/старый_01.01.2026.xlsx.tmp');
    expect((await check()).status).toBe('nothing');

    put('Склад/скан_01.01.2026.jpg');
    put('Склад/прайс_01.01.2026.csv');
    clock.advance(WEEK_MS);
    expect(await check()).toMatchObject({ status: 'sent', notified: 2 });
  });
});

describe('сообщение', () => {
  test('одно сообщение ответственному: группы по поставщикам, дата из названия', async () => {
    put('Металл/МеталлТорг/прайс_01.03.2026.xlsx');
    put('Металл/МеталлТорг/прайс_03.2026.xlsx');
    put('Крепёж/старый_15.01.2026.xlsx');
    await check();
    expect(chat.outbox).toHaveLength(1);
    expect(chat.outbox[0]?.threadId).toBe(RESPONSIBLE_THREAD);
    const text = textOf();
    expect(text).toContain(
      'Прайсы не обновлялись последние 3 месяца (по дате в названии файла):',
    );
    expect(text).toContain(
      'МеталлТорг:\n• Металл/МеталлТорг/прайс_01.03.2026.xlsx — 01.03.2026\n' +
        '• Металл/МеталлТорг/прайс_03.2026.xlsx — 03.2026',
    );
    expect(text).toContain('поставщик не определён:\n• Крепёж/старый_15.01.2026.xlsx — 15.01.2026');
    // Поставщик с названием идёт раньше «не определён».
    expect(text.indexOf('МеталлТорг:')).toBeLessThan(text.indexOf('поставщик не определён:'));
    expect(text).not.toContain('Дата в названии не найдена');
  });

  test('без ответственного адресат - менеджер', async () => {
    const bare = { ...deps, responsibleThreadId: undefined };
    put('a/старый_01.01.2026.xlsx');
    await runStalePriceFilesCheck(bare, { timezone: TZ });
    expect(chat.outboxOf(MANAGER_THREAD)).toHaveLength(1);
  });

  test('поставщик по истории импортов (путь без названия)', async () => {
    put('Разное/f1_01.01.2026.xlsx');
    await deps.state.put(IMPORT_META_NAMESPACE, 's1:abc123', {
      source: 'disk',
      fileName: 'Разное/f1_01.01.2026.xlsx',
      notes: [],
    });
    await check();
    expect(textOf()).toContain('МеталлТорг:\n• Разное/f1_01.01.2026.xlsx — 01.01.2026');
  });

  test('лимит строк: остаток числом, порядок детерминирован, остаток - в понедельник', async () => {
    const total = PRICE_FILE_MAX_LISTED + 3;
    for (let i = 0; i < total; i += 1) {
      put(`Архив/${String(i).padStart(3, '0')}/прайс_01.01.2026.xlsx`);
    }
    const first = await check();
    expect(first).toMatchObject({ status: 'sent', notified: PRICE_FILE_MAX_LISTED, deferred: 3 });
    const text = textOf();
    expect(text.split('\n').filter((line) => line.startsWith('•'))).toHaveLength(
      PRICE_FILE_MAX_LISTED,
    );
    expect(text).toContain('ещё файлов: 3');
    expect(text).toContain('следующий понедельник');
    expect(text).toContain('Архив/000/');
    expect(text).not.toContain('Архив/052/');

    // Через неделю тот же детерминированный порядок и тот же остаток.
    clock.advance(WEEK_MS);
    expect(await check()).toMatchObject({ status: 'sent', notified: PRICE_FILE_MAX_LISTED });
    expect(textOf(1)).toBe(text);
  });
});

describe('файлы без даты в названии', () => {
  test('отдельный блок «проверьте вручную», устаревшие - отдельно', async () => {
    put('Металл/МеталлТорг/прайс_01.01.2026.xlsx');
    put('Металл/МеталлТорг/прайс-новый.xlsx');
    // Не «каталог»: каталоги теперь не прайсы и в «без даты» не попадают (тест ниже).
    put('Крепёж/ассортимент.csv');
    const result = await check();
    expect(result).toMatchObject({ status: 'sent', notified: 3, undated: 2 });
    const text = textOf();
    const staleAt = text.indexOf('не обновлялись последние 3 месяца');
    const undatedAt = text.indexOf('Дата в названии не найдена — проверьте вручную:');
    expect(staleAt).toBeGreaterThanOrEqual(0);
    expect(undatedAt).toBeGreaterThan(staleAt);
    const undatedBlock = text.slice(undatedAt);
    expect(undatedBlock).toContain('МеталлТорг:\n• Металл/МеталлТорг/прайс-новый.xlsx');
    expect(undatedBlock).toContain('поставщик не определён:\n• Крепёж/ассортимент.csv');
    expect(undatedBlock).not.toContain('прайс_01.01.2026');
    // У файла без даты нет суффикса с датой.
    expect(undatedBlock).not.toContain('— 0');
  });

  test('только файлы без даты - пишем только этот блок', async () => {
    put('Склад/прайс-без-даты.xlsx');
    expect(await check()).toMatchObject({ status: 'sent', notified: 1, undated: 1 });
    const text = textOf();
    expect(text.startsWith('Дата в названии не найдена — проверьте вручную:')).toBe(true);
    expect(text).toContain('• Склад/прайс-без-даты.xlsx');
    expect(text).not.toContain('не обновлялись');
    expect(text).not.toContain('запросите обновление');
  });

  test('без даты файл не молчит каждый понедельник, пока имя не исправят', async () => {
    put('Склад/прайс-без-даты.xlsx');
    await check();
    clock.advance(WEEK_MS);
    expect((await check()).status).toBe('sent');
    expect(chat.outbox).toHaveLength(2);
  });
});

describe('нечего сообщать', () => {
  test('нет файлов - ничего не пишется, слот закрыт', async () => {
    expect(await check()).toEqual({ status: 'nothing', notified: 0, deferred: 0, undated: 0 });
    expect(chat.outbox).toHaveLength(0);
    expect((await check()).status).toBe('already_done');
  });

  test('все файлы свежие по дате в названии - молчим', async () => {
    put('Металл/прайс_05.10.2026.xlsx');
    put('Металл/прайс_10.2026.xlsx');
    expect((await check()).status).toBe('nothing');
    expect(chat.outbox).toHaveLength(0);
  });
});

describe('порог поставщиков в базе', () => {
  const FRESH_DAYS = 10;
  const STALE_DAYS = 100;

  async function staleNames(daysAgo: number): Promise<string[]> {
    const uploadedAt = new Date(MONDAY_0900.getTime() - daysAgo * DAY_MS).toISOString();
    await savePriceUpload(deps, SUPPLIER_ID, uploadedAt);
    const out = await listStalePriceSuppliers.execute({}, deps, SCHEDULER_CTX);
    return out.suppliers.map((supplier) => supplier.name);
  }

  test('прайс в базе 10-дневной давности не устарел: порог в месяцах, а не неделя', async () => {
    expect(await staleNames(FRESH_DAYS)).toEqual([]);
  });

  test('прайс в базе старше трёх календарных месяцев устарел', async () => {
    expect(await staleNames(STALE_DAYS)).toEqual(['МеталлТорг']);
  });
});

describe('чтение истории импортов', () => {
  test('история импортов читается с пределом страниц', async () => {
    put('склад/прайс_01.01.2026.xlsx');
    const state = deps.state;
    if (state === undefined) throw new Error('нужно хранилище состояния');
    let pages = 0;
    const originalList = state.list.bind(state);
    state.list = async (namespace, after, limit, options) => {
      const rows = await originalList(namespace, after, limit, options);
      if (namespace === IMPORT_META_NAMESPACE) {
        pages += 1;
        // Хранилище «бесконечное»: каждая страница полная, конец не наступает.
        return Array.from({ length: limit }, (_, i) => ({
          key: `s${pages}-${i}:x`,
          value: { source: 'mail' },
        }));
      }
      return rows;
    };
    expect((await check()).status).toBe('sent');
    expect(pages).toBeGreaterThan(0);
    expect(pages).toBeLessThanOrEqual(MAX_IMPORT_META_PAGES);
  });
});

describe('не прайсы и дата без года', () => {
  test('каталог, презентация, правила и образцы не попадают в «без даты»', async () => {
    put('Склад/Каталог Дом варенья.pdf');
    put('Склад/Прил_18 к РОЗ_Правила хранения прайсов.docx');
    put('Склад/Примеры брендирования.pdf');
    expect(await check()).toEqual({ status: 'nothing', notified: 0, deferred: 0, undated: 0 });
    expect(chat.outbox).toHaveLength(0);
  });

  test('«Прайс ... НЕ БРАТЬ» и «общий» остаются в «без даты»', async () => {
    put('Склад/Прайс_Аромадиффузоры_НЕ БРАТЬ.xlsx');
    put('Склад/Прайс_игрушки_общий.pdf');
    expect(await check()).toMatchObject({ status: 'sent', notified: 2, undated: 2 });
  });

  test('запись без года: ближайшая прошедшая дата относительно часов проверки', async () => {
    // Сейчас 2026-10-12: «01_03» - 1 марта 2026 (устарел), «11.10» - 11 октября 2026 (свежий).
    put('Склад/Прайс_Мельхиор_01_03.xlsx');
    put('Склад/Прайс_Шевроны_11.10.xlsx');
    expect(await check()).toMatchObject({ status: 'sent', notified: 1, undated: 0 });
    expect(textOf()).toContain('• Склад/Прайс_Мельхиор_01_03.xlsx — 01.03.2026');
    expect(textOf()).not.toContain('Шевроны');
  });

  test('«актуально до ...» - срок, а не дата: файл в «без даты»', async () => {
    put('Склад/Прайс матрешки_актуально до 30.07.26.xlsx');
    expect(await check()).toMatchObject({ status: 'sent', notified: 1, undated: 1 });
  });
});

describe('запасной разбор даты моделью', () => {
  const NAME = 'Склад/Прайс_лошади_01 мар 24.pdf';

  function withFallback(
    fallback: PriceFileDateFallback,
  ): ReturnType<typeof runStalePriceFilesCheck> {
    return runStalePriceFilesCheck({ ...deps, priceDateFallback: fallback } as PricesDeps, {
      timezone: TZ,
    });
  }

  test('без разбора файл в «без даты», модель не нужна', async () => {
    put(NAME);
    expect(await check()).toMatchObject({ status: 'sent', undated: 1 });
  });

  test('проверенная дата принимается: файл устарел и идёт в блок устаревших', async () => {
    put(NAME);
    const fallback = new MemoryPriceFileDateFallback(() => ({ year: 2024, month: 3, day: 1 }));
    const result = await withFallback(fallback);
    expect(result).toMatchObject({ status: 'sent', notified: 1, undated: 0 });
    expect(textOf()).toContain('— 01.03.2024');
    expect(fallback.calls).toBe(1);
  });

  test('в запрос к модели уходит только базовое имя файла, без каталога', async () => {
    put(NAME);
    const seen: string[] = [];
    const fallback = new MemoryPriceFileDateFallback((input) => {
      seen.push(input.fileName);
      return null;
    });
    await withFallback(fallback);
    expect(seen).toEqual(['Прайс_лошади_01 мар 24']);
    expect(seen.join('')).not.toContain('Склад');
  });

  test('дата, которой нет в названии, отбрасывается', async () => {
    put(NAME);
    const fallback = new MemoryPriceFileDateFallback(() => ({ year: 2024, month: 5, day: 7 }));
    expect(await withFallback(fallback)).toMatchObject({ status: 'sent', undated: 1 });
  });

  test('дата из будущего отбрасывается', async () => {
    put('Склад/Прайс_лошади_01 мар 27.pdf');
    const fallback = new MemoryPriceFileDateFallback(() => ({ year: 2027, month: 3, day: 1 }));
    expect(await withFallback(fallback)).toMatchObject({ status: 'sent', undated: 1 });
  });

  test('сбой модели - «дата не найдена»', async () => {
    put(NAME);
    const failing: PriceFileDateFallback = {
      resolve: async () => {
        throw new Error('gateway down');
      },
    };
    expect(await withFallback(failing)).toMatchObject({ status: 'sent', undated: 1 });
  });

  test('ответ null - «дата не найдена»', async () => {
    put(NAME);
    expect(await withFallback(new MemoryPriceFileDateFallback())).toMatchObject({
      status: 'sent',
      undated: 1,
    });
  });

  test('модель зовётся только для имён, похожих на прайс, и когда код даты не нашёл', async () => {
    put('Склад/Прайс_с датой_01.01.2026.xlsx');
    put('Склад/Каталог товаров.pdf');
    put('Склад/ведомость.xlsx');
    const fallback = new MemoryPriceFileDateFallback();
    await withFallback(fallback);
    expect(fallback.calls).toBe(0);
  });

  test('число обращений за проверку ограничено', async () => {
    for (let i = 0; i < PRICE_FILE_FALLBACK_MAX_CALLS + 5; i += 1) put(`Склад/Прайс_${i}.xlsx`);
    const fallback = new MemoryPriceFileDateFallback();
    await withFallback(fallback);
    expect(fallback.calls).toBe(PRICE_FILE_FALLBACK_MAX_CALLS);
  });

  test('зависший разбор не держит проверку: отмена по таймауту', async () => {
    put(NAME);
    let aborted = false;
    const hanging: PriceFileDateFallback = {
      resolve: (_input, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    };
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout;
    try {
      expect(await withFallback(hanging)).toMatchObject({ status: 'sent', undated: 1 });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(aborted).toBe(true);
  });
});

describe('область проверки и признак «таблица цен» (PRICE_STALE_*)', () => {
  const TABLE = `Цена\n${Array.from({ length: 6 }, (_, i) => `| Товар ${i} | ${100 + i},50 |`).join('\n')}`;
  const NO_TABLE = 'Описание продукции без таблицы.';
  let tables: MemoryPriceTableIndex;

  /** Выборка путей как на боевом диске. */
  function putDisk(): void {
    put('produkciya/1_Готовая продукция/Прайс_01.01.2026.xlsx');
    put('produkciya/2_Контрактная/6 Питание_Покровская/Остатки_01.02.2026.xlsx');
    put('produkciya/2_Контрактная/6 Питание_Покровская/Справка_01.02.2026.xlsx');
    put('produkciya/2_Контрактная/6 Питание_Покровская/Список.xlsx');
    put('produkciya/2_Контрактная/6 Питание_Покровская/Фото.xlsx');
    put('produkciya/Архив/Прайс_01.01.2025.xlsx');
    put('zakupki/Расчёт набора_01.02.2026.xlsx');
    put('zakupki/Прайс_логистики_01.01.2026.xlsx');
    put('sait/Материалы_01.02.2026.xlsx');
    tables = new MemoryPriceTableIndex();
    tables.put('produkciya/2_Контрактная/6 Питание_Покровская/Остатки_01.02.2026.xlsx', [TABLE]);
    tables.put('produkciya/2_Контрактная/6 Питание_Покровская/Справка_01.02.2026.xlsx', [NO_TABLE]);
    tables.put('produkciya/2_Контрактная/6 Питание_Покровская/Список.xlsx', [TABLE]);
    tables.put('zakupki/Расчёт набора_01.02.2026.xlsx', [TABLE]);
  }

  /** Все пути, попавшие в тексты отправленных сообщений. */
  function listed(): string[] {
    return chat.outbox
      .flatMap((m) => (m.message?.text ?? '').split('\n'))
      .filter((line) => line.startsWith('• '))
      .map((line) => line.slice(2).split(' — ')[0] ?? '');
  }

  test('без настроек: поведение прежнее (всё, включая архив и расчёты)', async () => {
    putDisk();
    await check();
    expect(listed()).toContain('produkciya/Архив/Прайс_01.01.2025.xlsx');
    expect(listed()).toContain('zakupki/Расчёт набора_01.02.2026.xlsx');
  });

  test('префикс и исключение: только produkciya без архива', async () => {
    putDisk();
    deps.staleScan = { prefixes: ['produkciya/'], excludePattern: 'архив|не брать' };
    await check();
    const paths = listed();
    expect(paths.every((p) => p.startsWith('produkciya/'))).toBe(true);
    expect(paths.some((p) => p.includes('Архив'))).toBe(false);
    expect(paths).toContain('produkciya/1_Готовая продукция/Прайс_01.01.2026.xlsx');
  });

  test('флаг включён: слово в имени или таблица; без текста в базе - только по слову', async () => {
    putDisk();
    deps.staleScan = { prefixes: ['produkciya/'], excludePattern: 'архив|не брать' };
    deps.priceTables = tables;
    const result = await check();
    expect(listed().sort()).toEqual([
      'produkciya/1_Готовая продукция/Прайс_01.01.2026.xlsx',
      'produkciya/2_Контрактная/6 Питание_Покровская/Остатки_01.02.2026.xlsx',
      // «без даты»: таблица цен в базе есть, слова в имени нет
      'produkciya/2_Контрактная/6 Питание_Покровская/Список.xlsx',
    ].sort());
    // Фото.xlsx нет в базе, Справка - не таблица: ни просрочены, ни «без даты».
    expect(result.undated).toBe(1);
  });

  test('флаг включён без префиксов: расчёты в zakupki с таблицей цен тоже прайс, сайт - нет', async () => {
    putDisk();
    deps.priceTables = tables;
    await check();
    const paths = listed();
    expect(paths).toContain('zakupki/Расчёт набора_01.02.2026.xlsx');
    expect(paths).toContain('zakupki/Прайс_логистики_01.01.2026.xlsx');
    expect(paths).not.toContain('sait/Материалы_01.02.2026.xlsx');
  });

  test('запросы к базе пачкой: один вызов порта на проверку, слово в имени не запрашивается', async () => {
    putDisk();
    deps.priceTables = tables;
    await check();
    expect(tables.calls).toBe(1);
  });

  test('файл-блокировка Office не попадает в проверку ни при выключенных, ни при включённых настройках', async () => {
    put('produkciya/~$Прайс 01.01.2024.xlsx');
    put('produkciya/Прайс 01.01.2024.xlsx');
    put('produkciya/~$Без даты прайс.xlsx');
    for (const on of [false, true]) {
      if (on) {
        deps.staleScan = { prefixes: ['produkciya/'], excludePattern: 'архив|не брать' };
        deps.priceTables = new MemoryPriceTableIndex();
        setNow(new Date(MONDAY_0900.getTime() + WEEK_MS));
        chat.outbox.length = 0;
      }
      await check();
      expect(listed()).toEqual(['produkciya/Прайс 01.01.2024.xlsx']);
    }
  });

  test('«не прайс» по имени не возвращается проверкой содержимого и не идёт в запрос к порту', async () => {
    put('produkciya/Прайс_зарядники не актуален _01_02_24.xlsx');
    put('produkciya/КП_сувениры из Китая 01.01.2024.xlsx');
    put('produkciya/КП_сувениры без даты.xlsx');
    put('produkciya/Сроки исполнения заказов 22_04_25.xlsx');
    put('produkciya/Прайс 01.01.2024.xlsx');
    const index = new MemoryPriceTableIndex();
    const table = `Цена\n${Array.from({ length: 6 }, (_, i) => `| Товар ${i} | ${100 + i},50 |`).join('\n')}`;
    for (const path of [
      'produkciya/КП_сувениры из Китая 01.01.2024.xlsx',
      'produkciya/КП_сувениры без даты.xlsx',
      'produkciya/Сроки исполнения заказов 22_04_25.xlsx',
    ]) {
      index.put(path, [table]);
    }
    const asked: string[] = [];
    deps.priceTables = {
      verdicts: (paths) => {
        asked.push(...paths);
        return index.verdicts(paths);
      },
    };
    await check();
    expect(listed()).toEqual(['produkciya/Прайс 01.01.2024.xlsx']);
    expect(asked).toEqual([]);
  });

  test('«не актуален» исключается и при выключенных настройках', async () => {
    put('produkciya/Прайс_зарядники не актуален _01_02_24.xlsx');
    put('produkciya/Прайс 01.01.2024.xlsx');
    await check();
    expect(listed()).toEqual(['produkciya/Прайс 01.01.2024.xlsx']);
  });

  test('файл с датой и КП в имени не попадает в просрочку при любых настройках', async () => {
    put('produkciya/КП_сувениры из Китая 01.01.2024.xlsx');
    put('produkciya/Прайс 01.01.2024.xlsx');
    await check();
    expect(listed()).toEqual(['produkciya/Прайс 01.01.2024.xlsx']);
  });
});
