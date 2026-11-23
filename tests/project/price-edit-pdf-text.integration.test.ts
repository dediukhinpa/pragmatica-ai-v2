import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpDocumentParser } from '@business-ai/adapters';
import { removeTempDirs, tempDir } from '@business-ai/testing';
import { editPriceInFile } from '../../src/price-edit-direct';
import { PriceEditRefusedError } from '../../src/price-edit-refusal';
import { resetSpotCache } from '../../src/price-spots';
import { HttpPriceSpotReader, type PriceSpotMap } from '../../src/price-spots-client';
import { listPriceSpots } from '../../src/price-spots-tool';
import { HttpPriceFileEditor } from '../../src/kit/adapters/http/http-price-file-editor';
import {
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  employeeContext,
  type FullPricesDeps,
} from '../agents/prices-support';

/**
 * Интеграция на НАСТОЯЩЕМ сервисе документов (этап 9r): карта чисел PDF вне таблиц с линиями ->
 * правка `editPriceInFile` по `page/spot` -> PDF с новой ценой в предложении и в колонке без
 * линий. Платформа: `DOCUMENTS_EDIT_PDF=true`, `DOCUMENTS_EDIT_PDF_TEXT` по умолчанию.
 * Пропускается, если не заданы переменные окружения (сервис поднимает сам тест, на
 * 127.0.0.1 в порту этапа):
 *   PRICE_SPOTS_IT_PYTHON      - python с зависимостями сервиса и reportlab;
 *   PRICE_SPOTS_IT_SERVICE_DIR - каталог services/documents платформы;
 *   PRICE_SPOTS_IT_VENDOR_DIR  - каталог vendor/labops-pii платформы (BAI_VENDOR_PII_DIR);
 *   PRICE_SPOTS_PDF_IT_PORT    - порт (по умолчанию 21310).
 * Данные синтетические: реальных документов заказчика нет.
 */

const PYTHON = process.env.PRICE_SPOTS_IT_PYTHON ?? '';
const SERVICE_DIR = process.env.PRICE_SPOTS_IT_SERVICE_DIR ?? '';
const VENDOR_DIR = process.env.PRICE_SPOTS_IT_VENDOR_DIR ?? '';
const PORT = process.env.PRICE_SPOTS_PDF_IT_PORT ?? '21310';
const ENABLED = PYTHON !== '' && SERVICE_DIR !== '' && VENDOR_DIR !== '';
const BASE_URL = `http://127.0.0.1:${PORT}`;
/** Сколько ждём готовности сервиса, мс, и шаг опроса. */
const START_TIMEOUT_MS = 60_000;
const POLL_MS = 250;
/** Запас на сборку PDF перед запуском сервиса, мс. */
const SETUP_MARGIN_MS = 15_000;
/** Срок запросов к сервису в тесте, мс. */
const REQUEST_TIMEOUT_MS = 60_000;
const PDF_NAME = 'Offer_autumn.pdf';

const SPOT_OPTIONS = { baseUrl: BASE_URL, timeoutMs: REQUEST_TIMEOUT_MS };

/**
 * Синтетический PDF без таблицы с линиями на странице 1 (цена в предложении и колонки без линий
 * «Item A ... 1 250,00 USD») и с таблицей с линиями на странице 2, где то же число 400,00 стоит
 * и в ячейке, и в обычной строке. Кириллица - через DejaVu.
 */
const BUILD_PDF = `
import sys
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

pdfmetrics.registerFont(TTFont("DejaVu", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
c = canvas.Canvas(sys.argv[1], pagesize=A4)
c.setFont("DejaVu", 12)
c.drawString(60, 780, "Коммерческое предложение")
c.drawString(60, 740, "Итого за единицу: 1 250,00 USD при заказе партии.")
c.drawString(60, 680, "Item")
c.drawString(260, 680, "Price")
for y, name, price in ((660, "Item A", "1 250,00"), (640, "Item B", "980,50")):
    c.drawString(60, y, name)
    c.drawString(260, y, price)
    c.drawString(340, y, "USD")
c.showPage()
c.setFont("DejaVu", 12)
c.drawString(60, 780, "Страница с таблицей")
left, mid, right = 60, 260, 360
for y in (700, 680, 660):
    c.line(left, y, right, y)
for x in (left, mid, right):
    c.line(x, 700, x, 660)
c.drawString(left + 4, 686, "Item")
c.drawString(mid + 4, 686, "Price")
c.drawString(left + 4, 666, "Bolt")
c.drawString(mid + 4, 666, "400,00")
c.drawString(60, 600, "Скидка поставщика 400,00 USD по договору.")
# Встроенный шрифт - подмножество: в нём должны быть все цифры, иначе новая цена не запишется
c.drawString(60, 560, "Артикул-ref ABC 0123456789")
c.save()
`;

/** Строки текста каждой страницы PDF (pdfplumber) в JSON. */
const DUMP_PDF = `
import json, sys
import pdfplumber
with pdfplumber.open(sys.argv[1]) as pdf:
    print(json.dumps([(page.extract_text() or "") for page in pdf.pages], ensure_ascii=False))
`;

let service: ChildProcess | undefined;
let pdfBytes = new Uint8Array();

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

/** Тексты страниц PDF из байтов. */
function pdfTexts(bytes: Uint8Array): string[] {
  const path = join(tempDir(), 'check.pdf');
  writeFileSync(path, bytes);
  return JSON.parse(python(DUMP_PDF, path)) as string[];
}

beforeAll(async () => {
  if (!ENABLED) return;
  const path = join(tempDir(), PDF_NAME);
  python(BUILD_PDF, path);
  pdfBytes = new Uint8Array(readFileSync(path));
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
      DOCUMENTS_EDIT_PDF: 'true',
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

describe.skipIf(!ENABLED)('цепочка на настоящем сервисе документов (pdf)', () => {
  let deps: FullPricesDeps;
  let path = '';
  const ctx = employeeContext('u-it-pdf', EMPLOYEE_THREAD);

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
    path = (await deps.intake.put(EMPLOYEE_THREAD, PDF_NAME, pdfBytes)).path;
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

  async function readMap(): Promise<PriceSpotMap> {
    const reader = new HttpPriceSpotReader(SPOT_OPTIONS);
    const map = await reader.read({ name: PDF_NAME, bytes: pdfBytes });
    if (map === null) throw new Error('карта мест не получена');
    return map;
  }

  test('карта мест: число в тексте и в колонке без линий, таблицы с линиями нет', async () => {
    const map = await readMap();
    const pdfSpots = map.spots.flatMap((spot) => (spot.kind === 'pdf' ? [spot] : []));
    expect(pdfSpots).toHaveLength(map.spots.length);
    const sentence = pdfSpots.find((spot) => spot.context.includes('Итого за единицу'));
    expect(sentence).toMatchObject({ page: 1, text: '1 250,00', textTable: null });
    const column = pdfSpots.find((spot) => spot.context.startsWith('Item A'));
    expect(column).toMatchObject({ page: 1, text: '1 250,00', header: 'Price' });
    expect(column?.textTable).not.toBeNull();
    // 400,00 в ячейке таблицы с линиями в карту не входит, в обычной строке - входит
    const four = pdfSpots.filter((spot) => spot.text === '400,00');
    expect(four.map((spot) => spot.context)).toEqual(['Скидка поставщика 400,00 USD по договору.']);
    expect(four[0]?.page).toBe(2);
  });

  test('listPriceSpots показывает числа страницы с номером и заголовком столбца', async () => {
    await setupDeps(true);
    const out = await listPriceSpots.execute({ path, page: 1 }, deps, ctx);
    expect(out.status).toBe('ok');
    expect(out.spots.map((spot) => [spot.place, spot.value])).toEqual([
      ['Страница 1', 1250],
      ['Страница 1', 1250],
      ['Страница 1', 980.5],
    ]);
    expect(out.spots.some((spot) => spot.header === 'Price')).toBe(true);
  });

  test('цена в предложении: editPriceInFile -> PDF с новой ценой, колонка не тронута', async () => {
    await setupDeps(true);
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 1250, newPrice: 1300, page: 1, rowText: 'итого' }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(out.changes[0]).toMatchObject({ place: 'Страница 1', textBlock: true, oldPrice: 1250 });
    const [page1] = pdfTexts(sentBytes());
    expect(page1).toContain('Итого за единицу: 1 300,00 USD при заказе партии.');
    expect(page1).toContain('Item A 1 250,00 USD');
    expect(page1).toContain('Item B 980,50 USD');
  });

  test('число в колонке без линий: по названию позиции правится только эта строка', async () => {
    await setupDeps(true);
    const ambiguous = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 1250, newPrice: 1260 }] },
      deps,
      ctx,
    );
    expect(ambiguous.status).toBe('ambiguous');
    expect(ambiguous.variants).toHaveLength(2);
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 1250, newPrice: 1260, rowText: 'item a' }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    const [page1] = pdfTexts(sentBytes());
    expect(page1).toContain('Item A 1 260,00 USD');
    expect(page1).toContain('Итого за единицу: 1 250,00 USD');
  });

  test('400,00 в ячейке и в тексте: вопрос; страница и слова различают место', async () => {
    await setupDeps(true);
    const ambiguous = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 400, newPrice: 450 }] },
      deps,
      ctx,
    );
    expect(ambiguous.status).toBe('ambiguous');
    expect(ambiguous.variants.map((variant) => variant.textBlock === true)).toEqual([false, true]);
    const text = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 400, newPrice: 450, rowText: 'скидка' }] },
      deps,
      ctx,
    );
    expect(text.status).toBe('sent');
    const texts = pdfTexts(sentBytes());
    expect(texts[1]).toContain('Скидка поставщика 450,00 USD по договору.');
    expect(texts[1]).toContain('Bolt 400,00');
  });

  test('ячейка таблицы с линиями правится по table/row/col, как прежде', async () => {
    await setupDeps(true);
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 400, newPrice: 410, row: 1 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(out.changes[0]?.textBlock).toBeUndefined();
    const texts = pdfTexts(sentBytes());
    expect(texts[1]).toContain('Bolt 410,00');
    expect(texts[1]).toContain('Скидка поставщика 400,00 USD по договору.');
  });

  test('число не помещается: отказ с причиной по месту, файл не отправлен', async () => {
    await setupDeps(true);
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 1250, newPrice: 123456789.5, rowText: 'итого' }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('unsupported_format');
    expect(out.delivered).toBe(false);
    expect(out.skipped[0]?.position).toContain('Страница 1');
    expect(out.message).toContain('xlsx-копию');
    expect(sent).toBeUndefined();
  });

  test('без клиента карты (флаг выключен) число вне таблицы не находится', async () => {
    await setupDeps(false);
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 980.5, newPrice: 990 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('not_found');
  });

  test('чужое старое значение: сервис отказывает по месту (mismatch), файл не выдан', async () => {
    const map = await readMap();
    const spot = map.spots.find((item) => item.kind === 'pdf' && item.text === '980,50');
    if (spot?.kind !== 'pdf') throw new Error('число не найдено');
    const editor = new HttpPriceFileEditor({ baseUrl: BASE_URL, timeoutMs: REQUEST_TIMEOUT_MS });
    const attempt = editor.editPrices({
      fileName: PDF_NAME,
      bytes: pdfBytes,
      edits: [{ row: 0, col: 0, value: 990, expected: 979, page: spot.page, spot: spot.spot }],
    });
    const error = await attempt.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PriceEditRefusedError);
    expect((error as PriceEditRefusedError).reasons).toEqual([
      { code: 'mismatch', page: spot.page, spot: spot.spot },
    ]);
  });
});
