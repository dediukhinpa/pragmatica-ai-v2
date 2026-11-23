import { beforeEach, describe, expect, test } from 'bun:test';
import type { AnyToolDefinition, ToolContext } from '@business-ai/core';
import { createPricesAgent } from '../../src/agents/prices/declaration';
import { reportToManager } from '../../src/agents/prices/report-to-manager';
import {
  SCAN_READ_GUARD_NOTE,
  SCAN_WAS_READ_CODE,
  withScanReadGuard,
} from '../../src/scan-price-guard';
import {
  PRICES_SCAN_FLOW_PROMPT,
  withScanFlowTools,
} from '../../src/scan-price-flow';
import {
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  employeeContext,
  type FullPricesDeps,
} from '../agents/prices-support';
import { MUG_INVOICE, PNG_HEAD, recognizedScan, scanParserOf, unreadScan } from './scan-fixtures';

/**
 * П7, этап 9v: менеджеру - только реальная неудача. reportToManager scan_skipped для прочитанного
 * скана отклоняется самим инструментом без уведомления; пустой и нечитаемый скан - как раньше.
 */

const guarded = withScanReadGuard(reportToManager as unknown as AnyToolDefinition);
const raw = reportToManager as unknown as AnyToolDefinition;

let deps: FullPricesDeps;
let ctx: ToolContext;
let path: string;

/** Текстовые сообщения итога: адресат - начавший работу сотрудник, а без него менеджер. */
function managerMessages(): string[] {
  return deps.chat.outbox.flatMap((item) =>
    item.message === undefined ? [] : [item.message.text],
  );
}

/** Входные данные итога scan_skipped по файлу. */
function skippedInput(): Record<string, unknown> {
  return {
    kind: 'scan_skipped',
    path,
    fileHash: 'h-scan',
    updated: 0,
    needsReview: 0,
    issueCodes: [],
  };
}

beforeEach(async () => {
  deps = await buildFullPricesDeps();
  ctx = employeeContext('u-guard', EMPLOYEE_THREAD);
  path = (await deps.intake.put(EMPLOYEE_THREAD, 'счёт.png', PNG_HEAD)).path;
});

describe('scan_skipped для прочитанного скана', () => {
  beforeEach(() => {
    deps.parser = scanParserOf(recognizedScan(MUG_INVOICE));
  });

  test('без охраны инструмент сообщает менеджеру «скан без текста» (баг 23.11)', async () => {
    const out = await raw.execute(skippedInput(), deps, ctx);
    expect(out).toMatchObject({ delivered: true });
    expect(managerMessages().join('\n')).toContain('скан, в нём нет текста');
  });

  test('с охраной: ошибка scan_was_read и менеджеру ничего не уходит', async () => {
    await expect(guarded.execute(skippedInput(), deps, ctx)).rejects.toThrow(SCAN_WAS_READ_CODE);
    expect(managerMessages()).toEqual([]);
  });

  test('другие итоги по тому же файлу проходят как раньше', async () => {
    const out = await guarded.execute(
      { ...skippedInput(), kind: 'needs_review', issueCodes: ['complex_table'] },
      deps,
      ctx,
    );
    expect(out).toMatchObject({ delivered: true });
    expect(managerMessages()).toHaveLength(1);
  });
});

describe('scan_skipped для нечитаемого скана: прежний отказ и уведомление', () => {
  test('needsOcr=true: сообщение менеджеру уходит', async () => {
    deps.parser = scanParserOf(unreadScan());
    const out = await guarded.execute(skippedInput(), deps, ctx);
    expect(out).toMatchObject({ delivered: true });
    expect(managerMessages().join('\n')).toContain('скан, в нём нет текста');
  });

  test('текст пуст при needsOcr=false: сообщение менеджеру уходит', async () => {
    deps.parser = scanParserOf({ ...recognizedScan(''), warnings: [] });
    const out = await guarded.execute(skippedInput(), deps, ctx);
    expect(out).toMatchObject({ delivered: true });
    expect(managerMessages()).toHaveLength(1);
  });

  test('парсер не читает картинки: скан не прочитан, сообщение уходит', async () => {
    const parser = scanParserOf(recognizedScan(MUG_INVOICE));
    deps.parser = { parse: parser.parse };
    const out = await guarded.execute(skippedInput(), deps, ctx);
    expect(out).toMatchObject({ delivered: true });
    expect(parser.calls).toBe(0);
  });

  test('файл не открывается: проверить нельзя, сообщение не подавляется', async () => {
    deps.parser = scanParserOf(recognizedScan(MUG_INVOICE));
    const out = await guarded.execute({ ...skippedInput(), path: 'нет такого.png' }, deps, ctx);
    expect(out).toMatchObject({ delivered: true });
    expect(managerMessages()).toHaveLength(1);
  });
});

describe('подключение по флагу PRICES_SCAN_FLOW_ENABLED', () => {
  const base = createPricesAgent({ model: 'test-model', priceEditFirst: true });

  test('выключен: декларация возвращается как есть (прежний набор и описания)', () => {
    expect(withScanFlowTools(base, { enabled: false })).toBe(base);
  });

  test('включён: createScanPriceCopy один раз, reportToManager с охраной, повтор безвреден', () => {
    const once = withScanFlowTools(base, { enabled: true });
    const names = once.tools.map((tool) => tool.name);
    expect(names.filter((name) => name === 'createScanPriceCopy')).toHaveLength(1);
    expect(names).toHaveLength(base.tools.length + 1);
    const report = once.tools.find((tool) => tool.name === 'reportToManager');
    expect(report?.description.endsWith(SCAN_READ_GUARD_NOTE)).toBe(true);
    const twice = withScanFlowTools(once, { enabled: true });
    expect(twice.tools.map((tool) => tool.name)).toEqual(names);
    expect(twice.tools.find((tool) => tool.name === 'reportToManager')?.description).toBe(
      report?.description,
    );
  });

  test('другие агенты не меняются, промпт про сканы называет все три правила', () => {
    const other = { ...base, id: 'documents' };
    expect(withScanFlowTools(other, { enabled: true })).toBe(other);
    expect(PRICES_SCAN_FLOW_PROMPT).toContain('createScanPriceCopy');
    expect(PRICES_SCAN_FLOW_PROMPT).toContain('scan_was_read');
    expect(PRICES_SCAN_FLOW_PROMPT).toContain('needsReview');
  });
});
