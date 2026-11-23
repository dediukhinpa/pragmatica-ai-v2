/**
 * Статический список имён сквозных тестов проекта (без запуска сервисов).
 *
 * Запуск: `bun tools/e2e-test-names.ts [каталог tests] [--compare эталон.txt]`.
 * Вывод в формате эталона `stage-0/baseline/e2e-tests.txt`: `статус<TAB>файл<TAB>полное имя`,
 * полное имя = имена `describe` через « > » и имя теста. Статус `skip` у `describe.skip`,
 * `test.skip` и `test.todo`, остальные - `pass` (ожидаемый). С `--compare` печатается ещё
 * сверка с эталоном: какие имена эталона есть в проекте, каких нет.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

/** Разделитель имён вложенных блоков, как в отчёте bun. */
export const NAME_SEPARATOR = ' > ';
/** Метка имени, которое не удалось вычислить статически. */
export const DYNAMIC_NAME = '<динамическое имя>';
/** Подстановка `${...}` в имени теста: при сверке с эталоном заменяет любой текст. */
export const WILDCARD = '<*>';
const TEST_FUNCTIONS = new Set(['test', 'it']);
const SKIP_MODIFIERS = new Set(['skip', 'todo']);
const STATUS_PASS = 'pass';
const STATUS_SKIP = 'skip';
const COMPARE_FLAG = '--compare';
const DEFAULT_TESTS_DIR = 'e2e/tests';
const TEST_SUFFIX = '.test.ts';

export interface TestName {
  status: string;
  file: string;
  name: string;
}

interface CallKind {
  kind: 'test' | 'describe';
  skipped: boolean;
}

/** Значение строкового выражения (литерал, шаблон без подстановок, сумма литералов). */
function literalText(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => WILDCARD + span.literal.text).join('');
  }
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalText(node.left);
    const right = literalText(node.right);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  return undefined;
}

/** Вид вызова: `test(`, `it.skip(`, `describe.skip(` и т.п.; иначе undefined. */
function callKind(expr: ts.Expression): CallKind | undefined {
  if (ts.isIdentifier(expr)) {
    if (TEST_FUNCTIONS.has(expr.text)) return { kind: 'test', skipped: false };
    if (expr.text === 'describe') return { kind: 'describe', skipped: false };
    return undefined;
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const base = callKind(expr.expression);
    if (base === undefined) return undefined;
    return { kind: base.kind, skipped: base.skipped || SKIP_MODIFIERS.has(expr.name.text) };
  }
  return undefined;
}

/** Имена тестов одного файла в порядке обхода. */
export function namesOfSource(file: string, source: string): TestName[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const out: TestName[] = [];
  const visit = (node: ts.Node, path: string[], skipped: boolean): void => {
    if (ts.isCallExpression(node)) {
      const kind = callKind(node.expression);
      const first = node.arguments[0];
      if (kind !== undefined && first !== undefined) {
        const title = literalText(first) ?? DYNAMIC_NAME;
        const isSkipped = skipped || kind.skipped;
        if (kind.kind === 'test') {
          out.push({
            status: isSkipped ? STATUS_SKIP : STATUS_PASS,
            file,
            name: [...path, title].join(NAME_SEPARATOR),
          });
        } else {
          ts.forEachChild(node, (child) => visit(child, [...path, title], isSkipped));
        }
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, path, skipped));
  };
  visit(sf, [], false);
  return out;
}

/** Имена всех тестов каталога; файл - `tests/<имя>` как в эталоне. */
export function namesOfDir(dir: string): TestName[] {
  const out: TestName[] = [];
  const files = readdirSync(dir).filter((f) => f.endsWith(TEST_SUFFIX)).sort();
  for (const f of files) {
    out.push(...namesOfSource(`tests/${f}`, readFileSync(join(dir, f), 'utf8')));
  }
  return out;
}

/** Эталон снят из junit: в именах стоят XML-сущности. */
function unescapeXml(text: string): string {
  return text
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/** Строка эталона `статус<TAB>файл<TAB>имя` -> запись. */
export function parseBaseline(text: string): TestName[] {
  return text
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const [status = '', file = '', ...rest] = line.split('\t');
      return { status, file, name: unescapeXml(rest.join('\t')) };
    });
}

export interface Comparison {
  present: TestName[];
  missing: TestName[];
  extra: TestName[];
}

/** Имя с подстановками -> регулярное выражение; обычное имя сравнивается как есть. */
function nameMatcher(name: string): (candidate: string) => boolean {
  if (!name.includes(WILDCARD)) return (candidate) => candidate === name;
  const source = name
    .split(WILDCARD)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.+');
  const regex = new RegExp(`^${source}$`);
  return (candidate) => regex.test(candidate);
}

/** Сверка с эталоном по паре (файл, имя): статус не сравнивается (skip/pass - решение сценария). */
export function compareWithBaseline(own: TestName[], baseline: TestName[]): Comparison {
  const matchers = own.map((t) => ({ file: t.file, test: nameMatcher(t.name) }));
  const isOwn = (b: TestName): boolean =>
    matchers.some((m) => m.file === b.file && m.test(b.name));
  const isInBaseline = (o: TestName): boolean => {
    const match = nameMatcher(o.name);
    return baseline.some((b) => b.file === o.file && match(b.name));
  };
  return {
    present: baseline.filter(isOwn),
    missing: baseline.filter((b) => !isOwn(b)),
    extra: own.filter((o) => !isInBaseline(o)),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const cmpIndex = args.indexOf(COMPARE_FLAG);
  const baselinePath = cmpIndex >= 0 ? args[cmpIndex + 1] : undefined;
  const positional = args.filter((_, i) => i !== cmpIndex && i !== cmpIndex + 1);
  const dir = resolve(positional[0] ?? DEFAULT_TESTS_DIR);
  if (!existsSync(dir)) throw new Error(`нет каталога тестов: ${dir}`);
  const own = namesOfDir(dir);
  if (baselinePath === undefined) {
    for (const t of own) console.log(`${t.status}\t${t.file}\t${t.name}`);
  } else {
    const result = compareWithBaseline(own, parseBaseline(readFileSync(baselinePath, 'utf8')));
    const baselineFiles = new Set(own.map((t) => t.file));
    const inScope = result.missing.filter((t) => baselineFiles.has(t.file));
    console.log(`в проекте: ${own.length}; есть из эталона: ${result.present.length}`);
    console.log(`нет в проекте (файл есть, теста нет): ${inScope.length}`);
    for (const t of inScope) console.log(`  ${t.file}\t${t.name}`);
    console.log(`лишних (нет в эталоне): ${result.extra.length}`);
    for (const t of result.extra) console.log(`  ${t.file}\t${t.name}`);
  }
}
