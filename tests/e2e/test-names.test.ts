import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  NAME_SEPARATOR,
  WILDCARD,
  compareWithBaseline,
  namesOfDir,
  namesOfSource,
  parseBaseline,
} from '../../tools/e2e-test-names';

/** Корень репозитория v2 (тест лежит в tests/e2e/). */
const ROOT = join(import.meta.dir, '..', '..');
const BASELINE_PATH = join(import.meta.dir, 'baseline-names.tsv');
/** Сколько тестов в проектной части эталона (239 pass + 5 skip + 1 flaky минус платформа). */
const BASELINE_PROJECT_TESTS = 110;

describe('tools/e2e-test-names: разбор имён', () => {
  test('вложенные describe склеиваются через « > »', () => {
    const source = "describe('A', () => { describe('B', () => { test('t', () => {}); }); });";
    expect(namesOfSource('tests/x.test.ts', source)).toEqual([
      { status: 'pass', file: 'tests/x.test.ts', name: ['A', 'B', 't'].join(NAME_SEPARATOR) },
    ]);
  });

  test('skip и todo дают статус skip, в том числе у вложенных тестов', () => {
    const source = [
      "describe.skip('S', () => { test('внутри', () => {}); });",
      "test.todo('позже');",
      "test.skip('пропуск', () => {});",
      "it('обычный', () => {});",
    ].join('\n');
    const names = namesOfSource('f', source);
    expect(names.map((n) => n.status)).toEqual(['skip', 'skip', 'skip', 'pass']);
  });

  test('подстановки в шаблоне становятся маской, сумма литералов склеивается', () => {
    const source = [
      'for (const x of xs) { test(`форма ${x}: ок`, () => {}); }',
      "test('а' + 'б', () => {});",
    ].join('\n');
    const names = namesOfSource('f', source).map((n) => n.name);
    expect(names).toEqual([`форма ${WILDCARD}: ок`, 'аб']);
  });

  test('имя из переменной помечается как динамическое', () => {
    const [first] = namesOfSource('f', 'test(title, () => {});');
    expect(first?.name).toContain('динамическое');
  });
});

describe('tools/e2e-test-names: сверка с эталоном', () => {
  test('эталон из junit читается с XML-сущностями', () => {
    const [row] = parseBaseline('pass\ttests/a.test.ts\tа -&gt; б &amp; в\n');
    expect(row?.name).toBe('а -> б & в');
  });

  test('маска покрывает несколько имён эталона, лишнее и пропавшее видны', () => {
    const file = 'tests/a.test.ts';
    const own = namesOfSource(file, 'test(`форма ${x}`, () => {}); test("новый", () => {});');
    const baseline = parseBaseline(
      ['форма 1', 'форма 2', 'старый'].map((name) => `pass\t${file}\t${name}`).join('\n'),
    );
    const result = compareWithBaseline(own, baseline);
    expect(result.present.map((t) => t.name)).toEqual(['форма 1', 'форма 2']);
    expect(result.missing.map((t) => t.name)).toEqual(['старый']);
    expect(result.extra.map((t) => t.name)).toEqual(['новый']);
  });
});

describe('e2e/tests проекта против эталона stage-0', () => {
  const own = namesOfDir(join(ROOT, 'e2e/tests'));
  const baseline = parseBaseline(readFileSync(BASELINE_PATH, 'utf-8'));
  const result = compareWithBaseline(own, baseline);

  test('в эталоне проектной части ровно столько тестов, сколько ожидается', () => {
    expect(baseline.length).toBe(BASELINE_PROJECT_TESTS);
  });

  test('каждое имя эталона есть среди тестов проекта', () => {
    expect(result.missing).toEqual([]);
  });

  test('в проекте нет тестов с именами вне эталона', () => {
    expect(result.extra).toEqual([]);
  });

  test('пропущенные в эталоне тесты пропущены и в проекте', () => {
    const skippedBaseline = baseline.filter((t) => t.status === 'skip').map((t) => t.name);
    const skippedOwn = own.filter((t) => t.status === 'skip').map((t) => t.name);
    expect(skippedOwn.sort()).toEqual(skippedBaseline.sort());
  });
});
