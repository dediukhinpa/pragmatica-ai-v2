import { beforeEach, describe, expect, test } from 'bun:test';
import { editPricesInSourceFile } from '../../src/agents/prices/price-edit-source';
import { PRICES_PROMPT } from '../../src/agents/prices/prompt';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { priceItemKey } from '../../src/kit/domain/price-diff';
import { PriceEditRefusedError } from '../../src/price-edit-refusal';
import type { ToolContext } from '@business-ai/core';
import type { PriceFileEditor } from '../../src/kit/ports/price-file-editor';
import { SUPPLIER_ID, putFile } from '../agents/support';
import {
  COLUMNS,
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  employeeContext,
  type FullPricesDeps,
} from '../agents/prices-support';

/**
 * Новые форматы правки на месте: pptx, pdf с текстовым слоем (наложение), старый ppt.
 * Редактор подменяется заглушкой с ответом сервиса: проверяется поведение инструмента -
 * статус и сообщение при отказе проверок, имя и пояснение при смене формата, промпт.
 */

const CSV = ['Наименование,Цена,Артикул', 'Болт,100,B1', 'Гайка,200,G1'].join('\n');

let deps: FullPricesDeps;
let ctx: ToolContext;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
  ctx = employeeContext('u-edit-formats', EMPLOYEE_THREAD);
});

async function stage(): Promise<string> {
  putFile(deps, 'price.csv', CSV);
  const out = await stagePriceRows.execute(
    { path: 'price.csv', supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
    deps,
    ctx,
  );
  return out.fileHash;
}

describe('отказ строгих проверок (pdf): статус unsupported_format с причинами', () => {
  const refusing = (reasons: PriceEditRefusedError['reasons']): PriceFileEditor => ({
    editPrices: async (): Promise<never> => {
      throw new PriceEditRefusedError(reasons);
    },
  });

  test('файл не отправляется, причины названы по позициям, копия - по согласию', async () => {
    const fileHash = await stage();
    const key = priceItemKey({ sku: 'G1', productName: 'Гайка' });
    expect(key).not.toBe('');
    const out = await editPricesInSourceFile.execute(
      { supplierId: SUPPLIER_ID, fileHash, mode: 'percent', percent: 5 },
      {
        ...deps,
        priceFileEditor: refusing([
          { code: 'glyph_missing', table: 0, row: 1, col: 1 },
          { code: 'no_fit', table: 0, row: 2, col: 1 },
          { code: 'encrypted' },
        ]),
      },
      ctx,
    );
    expect(out.status).toBe('unsupported_format');
    expect(out.delivered).toBe(false);
    expect(out.changed).toBe(0);
    expect(deps.chat.outbox).toHaveLength(0);
    expect(out.message).toContain('в шрифте файла нет нужных цифр');
    expect(out.message).toContain('не помещается');
    expect(out.message).toContain('файл зашифрован');
    expect(out.message).toContain('ТОЛЬКО');
    expect(out.skipped.map((item) => item.reason)).toContain(
      'новая цена не помещается на месте старой',
    );
    expect(out.skippedCount).toBe(3);
  });

  test('неизвестный код причины выводится как есть, длинный список обрезается числом', async () => {
    const fileHash = await stage();
    const many = Array.from({ length: 14 }, (_, index) => ({
      code: index === 0 ? 'new_code_from_service' : 'no_fit',
      table: 0,
      row: 1,
      col: 1,
    }));
    const out = await editPricesInSourceFile.execute(
      { supplierId: SUPPLIER_ID, fileHash, mode: 'percent', percent: 5 },
      { ...deps, priceFileEditor: refusing(many) },
      ctx,
    );
    expect(out.message).toContain('new_code_from_service');
    expect(out.message).toContain('и ещё 4');
    expect(out.status).toBe('unsupported_format');
  });
});

describe('старый ppt, приведённый к pptx', () => {
  const converting: PriceFileEditor = {
    editPrices: async () => ({
      fileName: 'ppt-result.pptx',
      mimeType: 'application/octet-stream',
      bytes: new TextEncoder().encode('pptx'),
      changed: 2,
      skipped: [],
      convertedFrom: 'ppt',
    }),
  };

  test('отправляется pptx, а не исходное расширение; ответ просит сказать об этом', async () => {
    const fileHash = await stage();
    const out = await editPricesInSourceFile.execute(
      { supplierId: SUPPLIER_ID, fileHash, mode: 'percent', percent: 5 },
      { ...deps, priceFileEditor: converting },
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(out.fileName?.endsWith('.pptx')).toBe(true);
    expect(deps.chat.outbox).toHaveLength(1);
    expect(out.message).toContain('.ppt');
    expect(out.message).toContain('pptx');
  });

  test('обычный файл без смены формата: имя с расширением исходного, пояснения нет', async () => {
    const fileHash = await stage();
    const out = await editPricesInSourceFile.execute(
      { supplierId: SUPPLIER_ID, fileHash, mode: 'percent', percent: 5 },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(out.fileName?.endsWith('.csv')).toBe(true);
    expect(out.message).not.toContain('старом формате .ppt');
  });
});

describe('описание инструмента и промпт: форматы и действия при отказе', () => {
  test('в описании названы pptx, pdf с текстовым слоем и старый ppt', () => {
    const text = editPricesInSourceFile.description;
    expect(text).toContain('pptx');
    expect(text).toContain('pdf с текстовым слоем');
    expect(text).toContain('ppt');
    expect(text).toContain('НЕ отправляется');
    expect(text).toContain('картинках, диаграммах и SmartArt не правятся');
  });

  test('в промпте: форматы, отказ pdf с причинами, ppt уходит как pptx', () => {
    const rule = PRICES_PROMPT.slice(PRICES_PROMPT.indexOf('Правка прайса: структура'));
    const before = PRICES_PROMPT.slice(0, PRICES_PROMPT.indexOf('Правка прайса: структура'));
    expect(before).toContain('pdf с');
    expect(before).toContain('pptx');
    expect(before).toContain('уходит pptx, а не ppt');
    expect(before).toContain('назови их');
    expect(rule).toContain('xlsx-копи');
    expect(rule).toContain('ТОЛЬКО если он согласится');
  });
});
