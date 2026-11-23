import { beforeEach, describe, expect, test } from 'bun:test';
import {
  VisionTableDocumentParser,
  IMAGE_TABLE_WARNINGS,
  VISION_NOTES,
} from '@business-ai/adapters';
import { readPriceFile } from '../../src/agents/prices/read-price-file';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import type { ParsedDocumentWithImages } from '@business-ai/adapters';
import type {
  ImageAttachment,
  ImageReader,
  ImageReadItem,
  ImageReadMode,
  ParsedDocument,
} from '@business-ai/core';
import { CTX, SUPPLIER_ID, buildPricesDeps, putFile } from './support';

const TABLE = '| Наименование | Цена |\n|---|---|\n| Ручка | 15 |\n| Блокнот | 40 |';
const EMPTY_DOC: ParsedDocument = {
  text: '',
  tables: [],
  needsOcr: true,
  hasHiddenContent: false,
  hiddenSheets: [],
  truncated: false,
  warnings: [],
};

let seen: { count: number; mode: ImageReadMode | null };
function reader(status: ImageReadItem['status'], text: string, note?: string): ImageReader {
  return {
    async describe(images: readonly ImageAttachment[], mode: ImageReadMode) {
      seen.count += images.length;
      seen.mode = mode;
      const items = images.map((image) => ({
        name: image.name,
        source: image.source,
        status,
        text,
        ...(note === undefined ? {} : { note }),
      }));
      return {
        items,
        usage: { inputTokens: 0, outputTokens: 0, images: images.length },
      };
    },
  };
}

const base = (images: ParsedDocumentWithImages['images']) => ({
  async parse(): Promise<ParsedDocument> {
    return EMPTY_DOC;
  },
  async parseWithImages(): Promise<ParsedDocumentWithImages> {
    return { document: EMPTY_DOC, images };
  },
});

const PAGE = {
  index: 1,
  placeholder: '[[IMAGE:1]]',
  mime: 'image/jpeg',
  bytes: new Uint8Array([1]),
  location: 'страница 1',
  rendered: true,
};

let deps: Awaited<ReturnType<typeof buildPricesDeps>>;
beforeEach(async () => {
  deps = await buildPricesDeps();
  seen = { count: 0, mode: null };
});

describe('прайс-картинка: зрение в режиме table, затем обычный разбор', () => {
  test('файл-фото даёт таблицу, предупреждение и те же строки в staging', async () => {
    deps.parser = new VisionTableDocumentParser(base([]), reader('ok', TABLE));
    putFile(deps, 'price.webp', 'bytes');
    const page = await readPriceFile.execute({ path: 'price.webp' }, deps, CTX);
    expect(seen.mode).toBe('table');
    expect(page.needsOcr).toBe(false);
    expect(page.tableCount).toBe(1);
    expect(page.warnings).toContain(IMAGE_TABLE_WARNINGS.recognized);
    const staged = await stagePriceRows.execute(
      {
        path: 'price.webp',
        supplierId: SUPPLIER_ID,
        tableIndex: 0,
        headerRows: 1,
        columns: { name: 0, price: 1 },
        defaultCurrency: 'RUB',
        fromRow: 1,
        toRow: 3,
        reset: false,
      },
      deps,
      CTX,
    );
    expect(staged.staged).toBe(2);
  });

  test('скан-pdf: страницы читаются зрением, needsOcr снимается', async () => {
    deps.parser = new VisionTableDocumentParser(base([PAGE]), reader('ok', TABLE));
    putFile(deps, 'scan.pdf', 'bytes');
    const page = await readPriceFile.execute({ path: 'scan.pdf' }, deps, CTX);
    expect(seen.count).toBe(1);
    expect(page.needsOcr).toBe(false);
    expect(page.markdown).toContain('Ручка');
    expect(page.warnings).toContain(IMAGE_TABLE_WARNINGS.recognized);
  });

  test('замена маркера не трактует «$&» и «$$» в распознанном тексте', async () => {
    const tricky = '| Наименование | Цена |\n|---|---|\n| Ручка $& $$ | 15 |';
    const doc = { ...EMPTY_DOC, needsOcr: false, text: 'до [[IMAGE:1]] после' };
    deps.parser = new VisionTableDocumentParser(
      {
        async parse() {
          return doc;
        },
        async parseWithImages() {
          return { document: doc, images: [PAGE] };
        },
      },
      reader('ok', tricky),
    );
    putFile(deps, 'doc.pdf', 'bytes');
    const page = await readPriceFile.execute({ path: 'doc.pdf' }, deps, CTX);
    expect(page.markdown).toContain('Ручка $& $$');
    expect(page.markdown).not.toContain('[[IMAGE:1]]');
  });

  test('часть страниц скана не прочитана: needsOcr остаётся и есть явное предупреждение', async () => {
    const second = { ...PAGE, index: 2, placeholder: '[[IMAGE:2]]', location: 'страница 2' };
    let call = 0;
    const flaky: ImageReader = {
      async describe(images: readonly ImageAttachment[]) {
        const items = images.map((image): ImageReadItem => {
          call += 1;
          return call === 1
            ? { name: image.name, source: image.source, status: 'ok', text: TABLE }
            : {
                name: image.name,
                source: image.source,
                status: 'limit_exceeded',
                text: '',
                note: 'лимит',
              };
        });
        return { items, usage: { inputTokens: 0, outputTokens: 0, images: images.length } };
      },
    };
    deps.parser = new VisionTableDocumentParser(base([PAGE, second]), flaky);
    putFile(deps, 'scan.pdf', 'bytes');
    const page = await readPriceFile.execute({ path: 'scan.pdf' }, deps, CTX);
    expect(page.needsOcr).toBe(true);
    expect(page.tableCount).toBe(1);
    expect(page.warnings.join(' ')).toContain('Прочитана только часть страниц: 1 из 2');
  });

  test('зрение выключено: понятное сообщение, needsOcr остаётся, без падения', async () => {
    deps.parser = new VisionTableDocumentParser(
      base([]),
      reader('disabled', '', VISION_NOTES.disabled),
    );
    putFile(deps, 'price.jpg', 'bytes');
    const page = await readPriceFile.execute({ path: 'price.jpg' }, deps, CTX);
    expect(page.needsOcr).toBe(true);
    expect(page.tableCount).toBe(0);
    expect(page.warnings).toContain(VISION_NOTES.disabled);
  });

  test('сбой читателя целиком не бросает исключение', async () => {
    const broken: ImageReader = {
      async describe() {
        throw new Error('boom');
      },
    };
    deps.parser = new VisionTableDocumentParser(base([PAGE]), broken);
    putFile(deps, 'scan.pdf', 'bytes');
    const page = await readPriceFile.execute({ path: 'scan.pdf' }, deps, CTX);
    expect(page.needsOcr).toBe(true);
    expect(page.warnings.join(' ')).toContain('временно недоступен');
  });

  test('ответ без таблицы: предупреждение, скан не считается прочитанным', async () => {
    deps.parser = new VisionTableDocumentParser(base([]), reader('ok', 'просто текст'));
    putFile(deps, 'price.png', 'bytes');
    const page = await readPriceFile.execute({ path: 'price.png' }, deps, CTX);
    expect(page.needsOcr).toBe(true);
    expect(page.warnings).toContain(IMAGE_TABLE_WARNINGS.noTable);
  });
});
