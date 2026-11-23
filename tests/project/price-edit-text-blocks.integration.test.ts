import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpDocumentParser } from '@business-ai/adapters';
import { removeTempDirs, tempDir } from '@business-ai/testing';
import { editPriceInFile } from '../../src/price-edit-direct';
import { resetSpotCache } from '../../src/price-spots';
import {
  HttpPriceSpotReader,
  type PptxPriceSpot,
  type PriceSpotMap,
} from '../../src/price-spots-client';
import { listPriceSpots } from '../../src/price-spots-tool';
import { HttpPriceFileEditor } from '../../src/kit/adapters/http/http-price-file-editor';
import {
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  employeeContext,
  type FullPricesDeps,
} from '../agents/prices-support';

/**
 * Интеграция на НАСТОЯЩЕМ сервисе документов (этап 9q): чтение карты чисел вне таблиц -> правка
 * `editPriceInFile` -> файл с новой ценой в тексте слайда и в группе фигур. Пропускается, если
 * не заданы переменные окружения (сервис поднимает сам тест, на 127.0.0.1 в порту этапа):
 *   PRICE_SPOTS_IT_PYTHON      - python с зависимостями сервиса (python-pptx, uvicorn, ...);
 *   PRICE_SPOTS_IT_SERVICE_DIR - каталог services/documents платформы;
 *   PRICE_SPOTS_IT_VENDOR_DIR  - каталог vendor/labops-pii платформы (BAI_VENDOR_PII_DIR);
 *   PRICE_SPOTS_IT_PORT        - порт (по умолчанию 21550).
 * Данные синтетические: реальных документов заказчика нет.
 */

const PYTHON = process.env.PRICE_SPOTS_IT_PYTHON ?? '';
const SERVICE_DIR = process.env.PRICE_SPOTS_IT_SERVICE_DIR ?? '';
const VENDOR_DIR = process.env.PRICE_SPOTS_IT_VENDOR_DIR ?? '';
const PORT = process.env.PRICE_SPOTS_IT_PORT ?? '21550';
const ENABLED = PYTHON !== '' && SERVICE_DIR !== '' && VENDOR_DIR !== '';
const BASE_URL = `http://127.0.0.1:${PORT}`;
/** Сколько ждём готовности сервиса, мс, и шаг опроса. */
const START_TIMEOUT_MS = 60_000;
const POLL_MS = 250;
/** Запас на сборку презентации перед запуском сервиса, мс. */
const SETUP_MARGIN_MS = 15_000;
/** Срок запросов к сервису в тесте, мс. */
const REQUEST_TIMEOUT_MS = 60_000;

const SPOT_OPTIONS = { baseUrl: BASE_URL, timeoutMs: REQUEST_TIMEOUT_MS };

/** Синтетическая презентация: таблица, текст, текст из двух run'ов, группа фигур. */
const BUILD_DECK = `
import sys
from pptx import Presentation
from pptx.util import Inches
prs = Presentation()
layout = prs.slide_layouts[6]
# слайд 1: таблица с ценой 680
s1 = prs.slides.add_slide(layout)
table = s1.shapes.add_table(2, 2, Inches(1), Inches(1), Inches(6), Inches(2)).table
for r, row in enumerate([["Позиция", "Цена"], ["Болт М8", "680"]]):
    for c, value in enumerate(row):
        table.cell(r, c).text = value
# слайд 2: текстовый блок с ценой 680 и цена, разбитая на два run
s2 = prs.slides.add_slide(layout)
box = s2.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(1))
box.text_frame.text = "Акция недели: 680 ₽ за штуку"
para = box.text_frame.add_paragraph()
first = para.add_run()
first.text = "Набор: 2 4"
second = para.add_run()
second.text = "00 руб."
# слайд 3: группа фигур с текстом, цена 1 500
s3 = prs.slides.add_slide(layout)
group = s3.shapes.add_group_shape()
inner = group.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(1))
inner.text_frame.text = "Спецпредложение: 1 500 ₽ до конца месяца"
prs.save(sys.argv[1])
`;

/** Все тексты презентации (текстовые блоки, группы, ячейки таблиц) в JSON. */
const DUMP_DECK = `
import json, sys
from pptx import Presentation
def walk(shapes):
    for shape in shapes:
        if shape.shape_type == 6:
            yield from walk(shape.shapes)
        elif shape.has_table:
            for row in shape.table.rows:
                for cell in row.cells:
                    yield cell.text
        elif shape.has_text_frame:
            for paragraph in shape.text_frame.paragraphs:
                yield "".join(run.text for run in paragraph.runs)
prs = Presentation(sys.argv[1])
print(json.dumps([list(walk(slide.shapes)) for slide in prs.slides], ensure_ascii=False))
`;

let service: ChildProcess | undefined;
let deckPath = '';
let deckBytes = new Uint8Array();

/** Запуск python-скрипта; stdout или исключение с кодом (без содержимого файлов). */
function python(code: string, ...args: string[]): string {
  const run = spawnSync(PYTHON, ['-I', '-c', code, ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`python завершился с кодом ${run.status}`);
  return run.stdout;
}

async function waitForService(): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE_URL}/health`)).ok) return;
    } catch {
      // сервис ещё поднимается
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error('сервис документов не поднялся за отведённый срок');
}

/** Место презентации по тексту числа; нет такого - ошибка (в карте только места pptx). */
function pptxSpot(map: PriceSpotMap, text: string): PptxPriceSpot {
  const found = map.spots.find((item) => item.text === text);
  if (found?.kind !== 'pptx') throw new Error('число не найдено');
  return found;
}

/** Тексты презентации из байтов (через python-pptx). */
function deckTexts(bytes: Uint8Array): string[][] {
  const path = join(tempDir(), 'check.pptx');
  writeFileSync(path, bytes);
  return JSON.parse(python(DUMP_DECK, path)) as string[][];
}

beforeAll(async () => {
  if (!ENABLED) return;
  deckPath = join(tempDir(), 'Акции_осень.pptx');
  python(BUILD_DECK, deckPath);
  deckBytes = new Uint8Array(readFileSync(deckPath));
  // Без -I: путь к пакетам сервиса и платформенному ПДн-модулю задаёт PYTHONPATH
  service = spawn(PYTHON, ['-m', 'documents'], {
    cwd: SERVICE_DIR,
    stdio: 'ignore',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: tempDir(),
      DOCUMENTS_HOST: '127.0.0.1',
      DOCUMENTS_PORT: PORT,
      DOCUMENTS_EDIT_ENDPOINTS: 'true',
      DOCUMENTS_EDIT_PPTX: 'true',
      BAI_VENDOR_PII_DIR: VENDOR_DIR,
      PYTHONPATH: `${SERVICE_DIR}:${VENDOR_DIR}`,
    },
  });
  await waitForService();
}, START_TIMEOUT_MS + SETUP_MARGIN_MS);

afterAll(async () => {
  // Сервис гасим и ждём выхода: порт этапа не должен остаться занятым
  if (service !== undefined && service.exitCode === null) {
    const exited = new Promise<void>((resolve) => service?.once('exit', () => resolve()));
    service.kill('SIGTERM');
    await exited;
  }
  removeTempDirs();
});

describe.skipIf(!ENABLED)('цепочка на настоящем сервисе документов', () => {
  let deps: FullPricesDeps;
  let path = '';
  const ctx = employeeContext('u-it', EMPLOYEE_THREAD);

  async function setupDeps(withSpots: boolean): Promise<void> {
    resetSpotCache();
    deps = await buildFullPricesDeps();
    deps = {
      ...deps,
      parser: new HttpDocumentParser({ baseUrl: BASE_URL, timeoutMs: REQUEST_TIMEOUT_MS }),
      priceFileEditor: new HttpPriceFileEditor({
        baseUrl: BASE_URL,
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
      ...(withSpots ? { priceSpots: new HttpPriceSpotReader(SPOT_OPTIONS) } : {}),
    };
    path = (await deps.intake.put(EMPLOYEE_THREAD, 'Акции_осень.pptx', deckBytes)).path;
    captureSentFile();
  }

  /** Байты последнего отправленного сотруднику файла: копия снята в момент отправки. */
  let sent: Uint8Array | undefined;

  /** Файл с диска после отправки удаляется инструментом, поэтому копируем его при отправке. */
  function captureSentFile(): void {
    sent = undefined;
    const send = deps.chat.sendFile.bind(deps.chat);
    deps.chat.sendFile = async (thread, file, key) => {
      sent = file.disk === undefined ? file.content : new Uint8Array(readFileSync(file.disk.path));
      return send(thread, file, key);
    };
  }

  function sentBytes(): Uint8Array {
    if (sent === undefined) throw new Error('файл не отправлен');
    return sent;
  }

  test('карта мест: числа в тексте и в группе, числа таблицы в неё не входят', async () => {
    const reader = new HttpPriceSpotReader({ baseUrl: BASE_URL, timeoutMs: REQUEST_TIMEOUT_MS });
    const map = (await reader.read({ name: 'a.pptx', bytes: deckBytes })) as PriceSpotMap;
    expect(map).not.toBeNull();
    const texts = map.spots.map((spot) => spot.text);
    expect(texts).toContain('680 ₽');
    expect(texts).toContain('2 400 руб.');
    expect(texts).toContain('1 500 ₽');
    expect(pptxSpot(map, '1 500 ₽').shape).toContain('/');
    expect(pptxSpot(map, '1 500 ₽').slide).toBe(3);
    expect(map.spots.some((spot) => spot.kind === 'pptx' && spot.slide === 1)).toBe(false);
  });

  test('listPriceSpots показывает числа с номером слайда', async () => {
    await setupDeps(true);
    const out = await listPriceSpots.execute({ path, slide: 3 }, deps, ctx);
    expect(out.status).toBe('ok');
    expect(out.spots.map((spot) => [spot.place, spot.value])).toEqual([['Слайд 3', 1500]]);
  });

  test('цена в группе фигур: editPriceInFile -> файл с новой ценой', async () => {
    await setupDeps(true);
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 1500, newPrice: 1600, slide: 3 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(out.changes[0]).toMatchObject({ place: 'Слайд 3', textBlock: true, oldPrice: 1500 });
    const texts = deckTexts(sentBytes());
    expect(texts[2]).toEqual(['Спецпредложение: 1 600 ₽ до конца месяца']);
    // остальное не тронуто
    expect(texts[0]).toContain('680');
    expect(texts[1]?.[0]).toBe('Акция недели: 680 ₽ за штуку');
  });

  test('цена, разбитая на два run: правится, текст вокруг цел', async () => {
    await setupDeps(true);
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 2400, newPrice: 2500 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(deckTexts(sentBytes())[1]).toEqual([
      'Акция недели: 680 ₽ за штуку',
      'Набор: 2 500 руб.',
    ]);
  });

  test('680 в таблице и в тексте: вопрос; со слайдом правится нужное место', async () => {
    await setupDeps(true);
    const ambiguous = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 700 }] },
      deps,
      ctx,
    );
    expect(ambiguous.status).toBe('ambiguous');
    expect(ambiguous.variants.map((variant) => variant.place)).toEqual(['Слайд 1', 'Слайд 2']);
    const text = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 700, slide: 2 }] },
      deps,
      ctx,
    );
    expect(text.status).toBe('sent');
    const texts = deckTexts(sentBytes());
    expect(texts[1]?.[0]).toBe('Акция недели: 700 ₽ за штуку');
    expect(texts[0]).toContain('680');
  });

  test('ячейка таблицы правится как прежде (слайд 1)', async () => {
    await setupDeps(true);
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 690, slide: 1 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    const texts = deckTexts(sentBytes());
    expect(texts[0]).toContain('690');
    expect(texts[1]?.[0]).toBe('Акция недели: 680 ₽ за штуку');
  });

  test('без клиента карты (флаг выключен) цена в группе не находится', async () => {
    await setupDeps(false);
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 1500, newPrice: 1600 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('not_found');
  });

  test('пропуск сервиса с локатором: чужое старое значение не пишется', async () => {
    const reader = new HttpPriceSpotReader({ baseUrl: BASE_URL, timeoutMs: REQUEST_TIMEOUT_MS });
    const map = (await reader.read({ name: 'a.pptx', bytes: deckBytes })) as PriceSpotMap;
    const spot = pptxSpot(map, '1 500 ₽');
    const editor = new HttpPriceFileEditor({ baseUrl: BASE_URL, timeoutMs: REQUEST_TIMEOUT_MS });
    const edited = await editor.editPrices({
      fileName: 'a.pptx',
      bytes: deckBytes,
      edits: [
        {
          row: 0,
          col: 0,
          value: 1600,
          expected: 1499,
          slide: spot.slide,
          shape: spot.shape,
          paragraph: spot.paragraph,
          start: spot.start,
        },
      ],
    });
    expect(edited.changed).toBe(0);
    expect(edited.skipped).toEqual([
      {
        row: 0,
        col: 0,
        reason: 'mismatch',
        slide: spot.slide,
        shape: spot.shape,
        paragraph: spot.paragraph,
        start: spot.start,
      },
    ]);
  });
});
