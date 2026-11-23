import { beforeEach, describe, expect, test } from 'bun:test';
import type {
  DocumentParser,
  JsonValue,
  ParsedDocument,
  ScriptRunOutcome,
  ScriptSandbox,
  ToolContext,
} from '@business-ai/core';
import { createPricesAgent } from '../../src/agents/prices/declaration';
import { withPriceCopyTools } from '../../src/assembly/price-copy-tools';
import {
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  employeeContext,
  type FullPricesDeps,
} from '../agents/prices-support';

/**
 * Большой docx (этап 9t): скрипт над таблицей из ~200 строк с картинками возвращает до 127 КБ,
 * а модели платформа отдаёт не больше 20 тыс. знаков и 200 строк (или отказывает, если вид
 * `value`). Всю таблицу модель из скрипта не получит и в `createFile` не перепишет: ход
 * закончился пустым ответом. Теперь в обоих случаях ответ говорит, что делать вместо этого.
 */

const ROWS = 212;
const STATS = {
  durationMs: 1,
  queueMs: 0,
  codeBytes: 1,
  inBytes: 1,
  fileBytes: 0,
  outBytes: 127_000,
  exitCode: 0,
  uidSwitched: true,
};
const ZIP_HEAD = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const CODE = 'def run(tables, source):\n    return tables[0]\n';
const COPY_TOOL = 'createPriceFileCopy';

const TABLE = [['Фото', 'Название', 'Цена'], ['', 'Стекло', '140р']];
const PARSER: DocumentParser = {
  async parse(): Promise<ParsedDocument> {
    return {
      text: '',
      tables: [TABLE],
      needsOcr: false,
      hasHiddenContent: false,
      hiddenSheets: [],
      truncated: false,
      warnings: [],
    };
  },
};

/** Песочница, которая отдаёт заданный результат (как скрипт, вернувший всю таблицу). */
function sandboxReturning(result: JsonValue): ScriptSandbox {
  return {
    async run(): Promise<ScriptRunOutcome> {
      return { ok: true, result, stats: STATS };
    },
  };
}

/** Таблица из 212 строк с длинными названиями: заведомо больше предела ответа модели. */
function bigRows(): JsonValue[] {
  return Array.from({ length: ROWS }, (_, index) => [
    '',
    `Стекло закалённое ${index} ${'x'.repeat(200)}`,
    '140р',
  ]);
}

/** Инструмент скрипта из декларации агента прайсов, как его собирает манифест. */
const prices = withPriceCopyTools(
  createPricesAgent({ model: 'test-model', dataScript: true, priceEditFirst: true }),
  { copy: true },
);
const scriptTool = prices.tools.find((tool) => tool.name === 'runDataScript');
if (scriptTool === undefined) throw new Error('runDataScript не подключён');

/** Ответ инструмента в той части, что проверяют тесты. */
interface Answer {
  ok: boolean;
  rowCount?: number;
  truncated?: boolean;
  value?: unknown[];
  message?: string;
  error?: { code: string };
}
const runDataScript = {
  async execute(input: Record<string, unknown>, toolDeps: FullPricesDeps, context: ToolContext) {
    return (await scriptTool.execute(input, toolDeps, context)) as unknown as Answer;
  },
};

let deps: FullPricesDeps;
let path: string;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
  deps.parser = PARSER;
  path = (await deps.intake.put(EMPLOYEE_THREAD, 'стекло прайс опт 2.docx', ZIP_HEAD)).path;
});
const ctx = () => employeeContext('u-script', EMPLOYEE_THREAD);

describe('runDataScript: слишком большой вывод', () => {
  test('table: платформа режет вывод, а ответ называет путь к копии прайса', async () => {
    deps.scriptSandbox = sandboxReturning(bigRows());
    const out = await runDataScript.execute(
      { code: CODE, fileRef: path, resultKind: 'table' },
      deps,
      ctx(),
    );
    // Платформа: модель увидит лишь часть таблицы
    expect(out).toMatchObject({ ok: true, rowCount: ROWS, truncated: true });
    expect((out.value ?? []).length).toBeLessThan(ROWS);
    // Проект: ответ объясняет, что таблицу целиком через модель не передать
    expect(out.message).toContain(COPY_TOOL);
    expect(out.message).toContain('не поместил');
  });

  test('value: отказ платформы дополняется советом, а не только «верни меньше»', async () => {
    deps.scriptSandbox = sandboxReturning(bigRows());
    const out = await runDataScript.execute(
      { code: CODE, fileRef: path, resultKind: 'value' },
      deps,
      ctx(),
    );
    expect(out).toMatchObject({ ok: false, error: { code: 'result_too_large' } });
    expect(out.message).toContain('Результат больше');
    expect(out.message).toContain(COPY_TOOL);
  });

  test('небольшой результат не получает лишних подсказок', async () => {
    deps.scriptSandbox = sandboxReturning([['a', 'b']]);
    const out = await runDataScript.execute(
      { code: CODE, fileRef: path, resultKind: 'table' },
      deps,
      ctx(),
    );
    expect(out).toMatchObject({ ok: true, rowCount: 1 });
    expect(out.message).toBeUndefined();
  });
});
