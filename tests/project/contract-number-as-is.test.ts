import { describe, expect, test } from 'bun:test';
import { resolveRenderContext } from '../../src/agents/documents/contract-number';
import { prepareSupplierDocument } from '../../src/agents/documents/prepare-supplier-document';
import { CONTRACT_TEMPLATES } from '../../src/agents/documents/template-registry';
import { buildDocumentsDeps } from '../agents/support';
import type { DealDocument } from '../../src/kit/domain/index.shim';

/**
 * Номер договора (этап 8y): номер сотрудника принимается как есть, составной тоже, для любого
 * шаблона и юрлица; системный номер не подставляется и не «присваивается». Данные синтетические.
 */

const COMPOSITE_NUMBERS = ['1535/10', '103/11-26 / 17/10', 'А-15'] as const;

function draft(number: string): DealDocument {
  return {
    id: '',
    kind: 'contract',
    number,
    buyer: '',
    seller: 'ООО «Поставка-Тест»',
    lines: [],
    total: 0,
    currency: 'RUB',
    issuedAt: '2026-11-10',
    supplierId: 'sup-1',
  };
}

describe('номер договора принимается как есть', () => {
  const templates = CONTRACT_TEMPLATES.filter((item) => item.variant !== 'nda');

  test('есть шаблоны обоих юрлиц', () => {
    expect(new Set(templates.map((item) => item.entity)).size).toBeGreaterThan(1);
  });

  for (const number of COMPOSITE_NUMBERS) {
    test(`номер «${number}» не меняется ни в одном шаблоне`, async () => {
      const deps = await buildDocumentsDeps();
      for (const template of templates) {
        const context = await resolveRenderContext(draft(number), deps, template.fileName, 'issue');
        expect(context.document.number).toBe(number);
        expect(context.document.number).not.toMatch(/^(МГ|ПР)-\d{4}-\d{4}$/u);
      }
    });
  }

  test('номера нет - остаётся пустым (маркер в файле), счётчик не вызывается', async () => {
    const deps = await buildDocumentsDeps();
    for (const template of templates) {
      const context = await resolveRenderContext(draft(''), deps, template.fileName, 'issue');
      expect(context.document.number).toBe('');
    }
  });

  test('описание сборки не обещает «номер присвоит система» и разрешает номер сотрудника', () => {
    expect(prepareSupplierDocument.description).not.toContain('присвоит система');
    expect(prepareSupplierDocument.description).toContain('принимается как есть');
  });
});
