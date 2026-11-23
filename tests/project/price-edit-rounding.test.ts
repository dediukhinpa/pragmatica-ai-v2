import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DocumentParser, ParsedDocument, ToolContext } from '@business-ai/core';
import {
  decimalsOfText,
  editPriceInFile,
  roundHalfUp,
} from '../../src/price-edit-direct';
import { loadFollowup } from '../../src/price-edit-followup';
import { resetSpotCache } from '../../src/price-spots';
import type { PriceSpot, PriceSpotMap, PriceSpotReader } from '../../src/price-spots-client';
import {
  configureTurnFileBuffer,
  resetTurnFileBufferForTests,
} from '../../src/turn-file-buffer';
import { MemoryPriceFileEditor } from '../../src/kit/adapters/memory/price-file-editor';
import type { EditPricesRequest, EditedPriceFile } from '../../src/kit/ports/price-file-editor';
import {
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  employeeContext,
  type FullPricesDeps,
} from '../agents/prices-support';

/**
 * Округление новой цены кодом (этап 9u): модель считает цепочку процентов сама, и итог бывал то
 * с копейками, то целым. При включённой отправке одним файлом цена округляется до знаков
 * исходной ячейки (или до `decimals` из просьбы сотрудника); при выключенной - как раньше.
 * Данные синтетические.
 */

const PPTX_NAME = 'Прайс_округление.pptx';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
/** «680 -10% +22% *1,7»: 680 * 0,9 * 1,22 * 1,7 с полной точностью. */
const CHAIN_RESULT = 1269.288;
/** Итог цепочки, округлённый до целого и до копеек. */
const CHAIN_INTEGER = 1269;
const CHAIN_CENTS = 1269.29;

const TABLE = [
  ['Позиция', 'Цена'],
  ['Болт', '680'],
  ['Гайка', '680,50'],
  ['Шайба', '1 250,5'],
  ['Винт', '99.9'],
];
const TEXT = [
  '## Слайд 1: Крепёж',
  '',
  '| Позиция | Цена |',
  '| --- | --- |',
  ...TABLE.slice(1).map((row) => `| ${row.join(' | ')} |`),
].join('\n');

const PROMO: PriceSpot = {
  kind: 'pptx',
  slide: 2,
  shape: '7',
  paragraph: 0,
  start: 8,
  text: '450 ₽',
  context: 'Акция: 450 ₽ за штуку',
};
const SET: PriceSpot = {
  kind: 'pptx',
  slide: 2,
  shape: '8',
  paragraph: 1,
  start: 6,
  text: '1 200,50 руб.',
  context: 'Набор 1 200,50 руб. при заказе',
};

class RecordingEditor extends MemoryPriceFileEditor {
  requests: EditPricesRequest[] = [];

  override async editPrices(request: EditPricesRequest): Promise<EditedPriceFile> {
    this.requests.push(request);
    return {
      fileName: request.fileName,
      mimeType: PPTX_MIME,
      bytes: new TextEncoder().encode('edited'),
      changed: request.edits.length,
      skipped: [],
    };
  }
}

class StubSpotReader implements PriceSpotReader {
  async read(): Promise<PriceSpotMap | null> {
    return { spots: [PROMO, SET], unreachable: [], truncated: false };
  }
}

let deps: FullPricesDeps;
let ctx: ToolContext;
let editor: RecordingEditor;
let path = '';

/** Значение, ушедшее в сервис правки по первой (единственной) правке запроса. */
function writtenValue(): number | undefined {
  return editor.requests[0]?.edits[0]?.value;
}

beforeEach(async () => {
  resetSpotCache();
  deps = await buildFullPricesDeps();
  ctx = employeeContext('u-round', EMPLOYEE_THREAD);
  editor = new RecordingEditor();
  const parsed: ParsedDocument = {
    text: TEXT,
    tables: [TABLE],
    needsOcr: false,
    hasHiddenContent: false,
    hiddenSheets: [],
    truncated: false,
    warnings: [],
  };
  const parser: DocumentParser = { parse: async () => parsed };
  deps = { ...deps, parser, priceFileEditor: editor, priceSpots: new StubSpotReader() };
  const stored = await deps.intake.put(
    EMPLOYEE_THREAD,
    PPTX_NAME,
    new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
  );
  path = stored.path;
  configureTurnFileBuffer({ enabled: true });
});

afterEach(() => {
  resetTurnFileBufferForTests();
});

describe('знаки исходной ячейки', () => {
  test('decimalsOfText: целое, копейки, разряды, валюта', () => {
    expect(decimalsOfText('680')).toBe(0);
    expect(decimalsOfText('680,50')).toBe(2);
    expect(decimalsOfText('680.5')).toBe(1);
    expect(decimalsOfText('1 250,5')).toBe(1);
    expect(decimalsOfText('1 250,75 ₽')).toBe(2);
    expect(decimalsOfText('1 200,50 руб.')).toBe(2);
    expect(decimalsOfText('₽ 99')).toBe(0);
    expect(decimalsOfText('1.234.567')).toBe(0);
    expect(decimalsOfText('1.234,5')).toBe(1);
    expect(decimalsOfText('0,12345678')).toBe(4);
    expect(decimalsOfText('нет числа')).toBeNull();
  });

  test('roundHalfUp: половина вверх без погрешности двоичной дроби', () => {
    expect(roundHalfUp(1.005, 2)).toBe(1.01);
    expect(roundHalfUp(2.5, 0)).toBe(3);
    expect(roundHalfUp(CHAIN_RESULT, 0)).toBe(CHAIN_INTEGER);
    expect(roundHalfUp(CHAIN_RESULT, 2)).toBe(CHAIN_CENTS);
    expect(roundHalfUp(1500.255, 1)).toBe(1500.3);
    expect(roundHalfUp(1e-7, 4)).toBe(0);
  });
});

describe('округление при включённой отправке одним файлом', () => {
  test('целая цена «680»: итог цепочки без копеек', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: CHAIN_RESULT, row: 1 }] },
      deps,
      ctx,
    );
    expect(writtenValue()).toBe(CHAIN_INTEGER);
    expect(out.changes[0]?.newPrice).toBe(CHAIN_INTEGER);
    const followup = await loadFollowup(deps.state, EMPLOYEE_THREAD, deps.clock.now());
    expect(followup?.changes[0]?.newPrice).toBe(CHAIN_INTEGER);
  });

  test('«680,50»: два знака', async () => {
    await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680.5, newPrice: CHAIN_RESULT }] },
      deps,
      ctx,
    );
    expect(writtenValue()).toBe(CHAIN_CENTS);
  });

  test('«1 250,5» с пробелом-разрядом: один знак, половина вверх', async () => {
    await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 1250.5, newPrice: 1500.255 }] },
      deps,
      ctx,
    );
    expect(writtenValue()).toBe(1500.3);
  });

  test('«99.9» с точкой: один знак', async () => {
    await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 99.9, newPrice: 120.04 }] },
      deps,
      ctx,
    );
    expect(writtenValue()).toBe(120);
  });

  test('decimals=0 при дробной ячейке: целое по просьбе сотрудника', async () => {
    await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680.5, newPrice: CHAIN_RESULT, decimals: 0 }] },
      deps,
      ctx,
    );
    expect(writtenValue()).toBe(CHAIN_INTEGER);
  });

  test('decimals=2 при целой ячейке: копейки по просьбе сотрудника', async () => {
    await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: CHAIN_RESULT, row: 1, decimals: 2 }] },
      deps,
      ctx,
    );
    expect(writtenValue()).toBe(CHAIN_CENTS);
  });

  test('число в тексте слайда: знаки берутся из текста числа', async () => {
    await editPriceInFile.execute(
      {
        path,
        edits: [
          { oldPrice: 450, newPrice: 551.7, slide: 2 },
          { oldPrice: 1200.5, newPrice: 1500.456, slide: 2 },
        ],
      },
      deps,
      ctx,
    );
    const values = editor.requests[0]?.edits.map((edit) => edit.value);
    expect(values).toEqual([552, 1500.46]);
  });

  test('правки прежнего вызова хода округляются так же', async () => {
    await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: CHAIN_RESULT, row: 1 }] },
      deps,
      ctx,
    );
    await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680.5, newPrice: CHAIN_RESULT }] },
      deps,
      ctx,
    );
    const values = editor.requests[1]?.edits.map((edit) => edit.value);
    expect(values).toEqual([CHAIN_INTEGER, CHAIN_CENTS]);
  });

  test('округление до нуля или до старой цены - понятный отказ, файл не правится', async () => {
    await expect(
      editPriceInFile.execute(
        { path, edits: [{ oldPrice: 680, newPrice: 680.3, row: 1 }] },
        deps,
        ctx,
      ),
    ).rejects.toThrow('равна старой');
    await expect(
      editPriceInFile.execute(
        { path, edits: [{ oldPrice: 680, newPrice: 0.3, row: 1 }] },
        deps,
        ctx,
      ),
    ).rejects.toThrow('равна нулю');
    expect(editor.requests).toHaveLength(0);
  });
});

describe('при выключенной отправке одним файлом цена пишется как есть', () => {
  test('newPrice не округляется, decimals игнорируется', async () => {
    resetTurnFileBufferForTests();
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: CHAIN_RESULT, row: 1, decimals: 0 }] },
      deps,
      ctx,
    );
    expect(writtenValue()).toBe(CHAIN_RESULT);
    expect(out.changes[0]?.newPrice).toBe(CHAIN_RESULT);
  });
});
