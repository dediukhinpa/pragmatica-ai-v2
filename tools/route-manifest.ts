#!/usr/bin/env bun
/**
 * Сборщик манифеста HTTP-маршрутов: что именно приложение v2 вызывает у соседних сервисов
 * стека (documents, pseudonymizer, embeddings, mask, speech и др.).
 *
 * Зачем: на бою у платформенного documents не оказалось проектных маршрутов `/docx/*` (404),
 * а предпроверка этого не видела. Манифест строится из исходников адаптеров, а не из памяти:
 * `tools/check-routes.sh` пробует каждый маршрут внутри сети стека.
 *
 * Источники (только чтение): адаптеры платформы `node_modules/@business-ai/adapters/src` и
 * проектный код `src/`. Вывод в stdout: TSV из четырёх колонок, порядок детерминированный:
 *
 *   сервис <TAB> метод <TAB> путь <TAB> вид
 *
 * Вид (колонка 4):
 *   route    - путь без параметров: проверка пробует его;
 *   template - путь с параметром (`/jobs/{jobId}`): проверка его НЕ пробует. Подстановка
 *              `_probe_` дала бы честный 404 («задания нет»), то есть ложный провал; существование
 *              такого маршрута проверяют его соседи без параметра (здесь `POST /jobs`);
 *   external - сервис вне обязательного стека (зарубежный шлюз за mTLS-прокси, приёмник
 *              телеметрии): проба отправила бы запрос за пределы стенда, поэтому проверка
 *              такие строки пропускает и показывает отдельной строкой.
 *
 * Как определяется вызов (синтаксический разбор TypeScript, не поиск строк). Узел «адрес»:
 * шаблонная строка или цепочка `+`, ПЕРВЫМ элементом которой стоит базовый адрес, то есть имя
 * вида `baseUrl`, `documentsBaseUrl`, `base` (`${this.baseUrl}/render`,
 * `this.baseUrl + '/x'`). Хвост адреса вычисляется из:
 *   - строковых литералов и шаблонов;
 *   - констант (`const X = '/route'`) в том же файле и экспортированных констант других файлов
 *     разбора (`IMAGE_MASK_ROUTE`);
 *   - условий `a ? '/x' : '/y'` (каждая ветка - отдельный маршрут) и `a || b`, `a ?? b`;
 *   - параметров функций: значение берётся из аргументов ВСЕХ вызовов этой функции в файле, в
 *     том числе по цепочке (`post(path)` -> `postHeld(path)`);
 *   - полей `this.x`, присвоенных в конструкторе;
 *   - вызовов `encodeURIComponent(id)` и прочих значений после первого сегмента - как параметр
 *     `{id}` (маршрут получает вид template).
 * Путь, который не начинается с литерального `/`, - ошибка, а не молчаливый пропуск.
 *
 * Метод определяется по месту использования адреса:
 *   - свойство `url:` объекта с соседним `method: 'POST'` (requestJson);
 *   - аргумент вызова `fetch`-подобной функции с объектом `{ method }` (fetchWithDeadline,
 *     this.fetchFn); без объекта метода у fetch - GET;
 *   - объект в вызове `postDocumentsFile({ url, ... })` - POST (так он устроен в платформе);
 *   - адрес в `const url = ...`: используются все ссылки на `url` внутри функции;
 *   - адрес в `return` функции (`jobUrl(id)`): используются все вызовы этой функции.
 * Метод, который определить не удалось, - ошибка.
 *
 * Сервис определяется по таблице {@link SERVICE_TABLE}: файл (и при необходимости имя базового
 * адреса: `documentsBaseUrl` и `gatewayBaseUrl` в одном файле) -> сервис. Файл, где найден
 * вызов, но которого нет в таблице, - ошибка («неопознанный сервис»); так новый адаптер платформы
 * после обновления не пройдёт мимо. Обратное тоже ошибка: файл из таблицы, в котором маршрутов
 * не найдено (разбор сломался или адаптер ушёл).
 *
 * Не понимает (и честно скажет ошибкой, если встретит): вычисляемые пути из внешних переменных
 * без литерала, `new URL(path, base)`, адрес, собранный в другом модуле. Сервис sandbox не
 * использует HTTP (JSON-line по unix-сокету) и в манифест не входит.
 *
 * Запуск: `bun tools/route-manifest.ts [--platform-root КАТАЛОГ] [--project-root КАТАЛОГ]
 * [--explain]`. Код выхода: 0 - манифест собран; 1 - есть проблемы (список в stderr); 2 - вызов.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import * as ts from 'typescript';
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------------------------
/** Корень репозитория (файл лежит в tools/). */
const REPO_ROOT = resolve(dirname(import.meta.path), '..');
/** Адаптеры платформы и проектный код по умолчанию. */
const DEFAULT_PLATFORM_ROOT = join(REPO_ROOT, 'node_modules', '@business-ai', 'adapters', 'src');
const DEFAULT_PROJECT_ROOT = join(REPO_ROOT, 'src');
/** Метки корней в ключах таблицы сервисов. */
const PLATFORM_LABEL = 'platform';
const PROJECT_LABEL = 'project';
/** Глубина рекурсии разбора параметров (цепочка post -> postHeld и т.п.). */
const MAX_RESOLVE_DEPTH = 8;
/** Коды выхода. */
const EXIT_OK = 0;
const EXIT_PROBLEMS = 1;
const EXIT_USAGE = 2;
/** Разделитель колонок TSV. */
const TAB = '\t';
/** Имя функции платформы, которая всегда шлёт POST (documents-file-call.ts). */
const POST_DOCUMENTS_FILE = 'postDocumentsFile';
/**
 * Имя базового адреса: baseUrl, documentsBaseUrl, BASE_URL. Голое `base` слишком общее (в
 * проекте так называют и базу имени файла): оно допускается только там, где его явно разрешает
 * правило файла в таблице (`baseNames`).
 */
const BASE_NAME_RE = /^(?:baseUrl|[a-z0-9]+BaseUrl|[A-Z0-9_]*BASE_URL)$/;
/** Имена функций, где отсутствие объекта с методом означает GET. */
const FETCH_LIKE_RE = /fetch/i;
/** Допустимые HTTP-методы манифеста. */
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
/** Расширения исходников разбора и признаки файлов, которые не читаются. */
const SOURCE_EXT = '.ts';
const SKIPPED_FILE_RE = /\.(?:test|spec)\.ts$|\.d\.ts$/;
const SKIPPED_DIRS = new Set(['node_modules', '__tests__', 'tests']);

// ---------------------------------------------------------------------------------------------
// Схемы на границах (Zod)
// ---------------------------------------------------------------------------------------------
const routeKindSchema = z.enum(['route', 'template', 'external']);
/** Вид строки манифеста. */
export type RouteKind = z.infer<typeof routeKindSchema>;

/** Строка манифеста: сервис, метод, путь, вид. */
export const routeRowSchema = z.object({
  service: z.string().regex(/^[a-z][a-z0-9-]*$/),
  method: z.enum(HTTP_METHODS),
  path: z.string().regex(/^\/\S*$/),
  kind: routeKindSchema,
});
/** Строка манифеста. */
export type RouteRow = z.infer<typeof routeRowSchema>;

const serviceRuleSchema = z.object({
  service: z.string().regex(/^[a-z][a-z0-9-]*$/),
  kind: z.enum(['route', 'external']),
  /** Почему сервис вне проверки (для kind=external). */
  reason: z.string().optional(),
});
type ServiceRule = z.infer<typeof serviceRuleSchema>;

const fileRuleSchema = z.object({
  /** Правило по умолчанию для всех адресов файла. */
  default: serviceRuleSchema.optional(),
  /** Правила по имени базового адреса (`documentsBaseUrl`). */
  byBase: z.record(z.string(), serviceRuleSchema).optional(),
  /** Дополнительные имена базового адреса, допустимые только в этом файле (`base`). */
  baseNames: z.array(z.string()).optional(),
});
/** Правило файла: сервис по умолчанию и/или по имени базового адреса. */
export type FileRule = z.infer<typeof fileRuleSchema>;

const cliSchema = z.object({
  platformRoot: z.string().min(1),
  projectRoot: z.string().min(1),
  explain: z.boolean(),
});
/** Разобранные аргументы командной строки. */
export type CliOptions = z.infer<typeof cliSchema>;

// ---------------------------------------------------------------------------------------------
// Таблица «файл -> сервис»
// ---------------------------------------------------------------------------------------------
const DOCUMENTS: ServiceRule = { service: 'documents', kind: 'route' };
const PSEUDONYMIZER: ServiceRule = { service: 'pseudonymizer', kind: 'route' };
const EMBEDDINGS: ServiceRule = { service: 'embeddings', kind: 'route' };
const MASK: ServiceRule = { service: 'mask', kind: 'route' };
const SPEECH: ServiceRule = { service: 'speech', kind: 'route' };
const GATEWAY: ServiceRule = {
  service: 'gateway',
  kind: 'external',
  reason: 'зарубежный шлюз за mTLS-прокси gateway-mtls: проба ушла бы за пределы стека',
};
const BITRIX24: ServiceRule = {
  service: 'bitrix24',
  kind: 'external',
  reason: 'портал Bitrix24 заказчика: внешняя система, из стека не проверяется',
};
const TELEMETRY: ServiceRule = {
  service: 'telemetry',
  kind: 'external',
  reason: 'приёмник телеметрии (alloy) необязателен и не входит в обязательный стек',
};

/**
 * Какой сервис стека обслуживает адаптер. Ключ: `platform:<путь от adapters/src>` или
 * `project:<путь от src>`. Сервис соответствует переменной базового адреса приложения:
 * documents - `DOCUMENTS_URL`, pseudonymizer - `PSEUDONYMIZER_URL`, embeddings - `EMBEDDINGS_URL`,
 * mask - `MASK_URL`, speech - `SPEECH_LOCAL_URL`, gateway - `LITELLM_BASE_URL`.
 */
export const SERVICE_TABLE: Readonly<Record<string, FileRule>> = z
  .record(z.string(), fileRuleSchema)
  .parse({
    'platform:http/http-document-parser.ts': { default: DOCUMENTS },
    'platform:http/http-document-renderer.ts': { default: DOCUMENTS },
    'platform:http/http-file-authorship.ts': { default: DOCUMENTS },
    'platform:http/http-table-exporter.ts': { default: DOCUMENTS },
    'platform:http/http-image-text-detector.ts': { default: DOCUMENTS },
    'platform:http/http-template-workbook.ts': { default: DOCUMENTS },
    'platform:vision/documents-image-masker.ts': { default: DOCUMENTS },
    'platform:vision/gateway-image-reader.ts': {
      byBase: { documentsBaseUrl: DOCUMENTS, gatewayBaseUrl: GATEWAY },
    },
    'platform:http/http-embedder.ts': { default: EMBEDDINGS },
    'platform:http/http-image-masker.ts': { default: MASK },
    'platform:http/http-pseudonymizer.ts': { default: PSEUDONYMIZER },
    'platform:local-speech/local-speech.ts': { default: SPEECH },
    'platform:litellm/anthropic-model-gateway.ts': { default: GATEWAY },
    'platform:anthropic-web-search/anthropic-web-search.ts': { default: GATEWAY },
    'platform:anthropic-web-search/anthropic-web-page-reader.ts': { default: GATEWAY },
    'platform:telemetry/otlp-telemetry.ts': { default: TELEMETRY, baseNames: ['base'] },
    'platform:bitrix24/client.ts': { default: BITRIX24 },
    'project:adapters/http-signatory-inflector.ts': { default: PSEUDONYMIZER },
    'project:docx-pages-client.ts': { default: DOCUMENTS },
    'project:price-spots-client.ts': { default: DOCUMENTS },
    'project:kit/adapters/http/http-contract-amender.ts': { default: DOCUMENTS },
    'project:kit/adapters/http/http-price-file-editor.ts': { default: DOCUMENTS },
    'project:kit/adapters/http/http-telegram-channel-source.ts': { default: GATEWAY },
  });

// ---------------------------------------------------------------------------------------------
// Чтение исходников
// ---------------------------------------------------------------------------------------------
interface SourceFile {
  /** Ключ таблицы: `platform:http/x.ts`. */
  key: string;
  /** Путь от корня репозитория или как задан (для сообщений). */
  display: string;
  sf: ts.SourceFile;
}

/** Список исходников `.ts` каталога в детерминированном порядке. */
function listSources(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    const names = readdirSync(dir).sort();
    for (const name of names) {
      const full = join(dir, name);
      const info = statSync(full);
      if (info.isDirectory()) {
        if (!SKIPPED_DIRS.has(name)) walk(full);
      } else if (name.endsWith(SOURCE_EXT) && !SKIPPED_FILE_RE.test(name)) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

function loadRoot(root: string, label: string): SourceFile[] {
  return listSources(root).map((full) => {
    const rel = relative(root, full).split(sep).join('/');
    const text = readFileSync(full, 'utf-8');
    return {
      key: `${label}:${rel}`,
      display: `${label}/${rel}`,
      sf: ts.createSourceFile(full, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Разбор выражений
// ---------------------------------------------------------------------------------------------
type FunctionLike =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.ConstructorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** Снять скобки, `as`, `!`, `satisfies` вокруг выражения. */
function unwrap(node: ts.Expression): ts.Expression {
  let current: ts.Expression = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Подняться над скобками и приведениями типа: узел, чей родитель - «настоящий» потребитель. */
function outerOf(node: ts.Node): ts.Node {
  let current: ts.Node = node;
  while (
    current.parent !== undefined &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent))
  ) {
    current = current.parent;
  }
  return current;
}

/** Имя последнего идентификатора: `this.baseUrl` -> `baseUrl`, `base` -> `base`. */
function lastName(node: ts.Expression): string | undefined {
  const inner = unwrap(node);
  if (ts.isIdentifier(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text;
  return undefined;
}

/** Имя вызываемой функции: `fn(...)` -> `fn`, `this.fn(...)` -> `fn`. */
function calleeName(call: ts.CallExpression): string | undefined {
  return lastName(call.expression);
}

function nameOfProperty(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Часть адреса: литерал или выражение. */
type Part = { lit: string } | { expr: ts.Expression };

/** Разложить шаблон или цепочку `+` на части; undefined - не адрес-выражение. */
function flattenParts(node: ts.Expression): Part[] | undefined {
  const inner = unwrap(node);
  if (ts.isTemplateExpression(inner)) {
    const parts: Part[] = [];
    if (inner.head.text !== '') parts.push({ lit: inner.head.text });
    for (const span of inner.templateSpans) {
      parts.push({ expr: span.expression });
      if (span.literal.text !== '') parts.push({ lit: span.literal.text });
    }
    return parts;
  }
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = flattenSide(inner.left);
    const right = flattenSide(inner.right);
    return [...left, ...right];
  }
  return undefined;
}

function flattenSide(node: ts.Expression): Part[] {
  const inner = unwrap(node);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
    return [{ lit: inner.text }];
  }
  const nested = ts.isBinaryExpression(inner) || ts.isTemplateExpression(inner)
    ? flattenParts(inner)
    : undefined;
  return nested ?? [{ expr: inner }];
}

/** Узел-адрес: выражение, которое начинается с базового адреса. */
interface UrlSite {
  file: SourceFile;
  node: ts.Expression;
  baseName: string;
  rest: Part[];
}

function findSites(file: SourceFile, extraNames: readonly string[]): UrlSite[] {
  const sites: UrlSite[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isTemplateExpression(node) ||
      (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) {
      const parts = flattenParts(node);
      const first = parts?.[0];
      if (parts !== undefined && first !== undefined && 'expr' in first) {
        const name = lastName(first.expr);
        if (name !== undefined && (BASE_NAME_RE.test(name) || extraNames.includes(name))) {
          sites.push({ file, node, baseName: name, rest: parts.slice(1) });
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file.sf);
  return sites;
}

// ---------------------------------------------------------------------------------------------
// Вычисление пути
// ---------------------------------------------------------------------------------------------
interface Resolver {
  files: SourceFile[];
  /** Экспортированные/верхнеуровневые константы по имени: [файл, инициализатор]. */
  consts: Map<string, Array<{ file: SourceFile; init: ts.Expression }>>;
}

interface EvalCtx {
  file: SourceFile;
  depth: number;
  seen: Set<string>;
}

function buildResolver(files: SourceFile[]): Resolver {
  const consts: Resolver['consts'] = new Map();
  for (const file of files) {
    for (const stmt of file.sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      if ((stmt.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue;
        const list = consts.get(decl.name.text) ?? [];
        list.push({ file, init: decl.initializer });
        consts.set(decl.name.text, list);
      }
    }
  }
  return { files, consts };
}

function cartesian(left: string[], right: string[]): string[] {
  const out: string[] = [];
  for (const a of left) for (const b of right) out.push(a + b);
  return out;
}

/** Имя параметра-подстановки для текста выражения: `encodeURIComponent(jobId)` -> `jobId`. */
function placeholderName(node: ts.Expression): string {
  const ids: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) ids.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  const name = [...ids].reverse().find((id) => id !== 'encodeURIComponent' && id !== 'String');
  return name ?? 'param';
}

/** Вычислить последовательность частей; null - первое значение (путь целиком) не определено. */
function evalParts(parts: Part[], res: Resolver, ctx: EvalCtx): string[] | null {
  let acc: string[] = [''];
  for (const part of parts) {
    let alts: string[] | null;
    if ('lit' in part) {
      alts = [part.lit];
    } else {
      alts = evalExpr(part.expr, res, ctx);
      // Неопределённое значение допустимо только как параметр внутри пути (после `/...`).
      if (alts === null) {
        if (acc.some((a) => !a.includes('/'))) return null;
        alts = [`{${placeholderName(part.expr)}}`];
      }
    }
    acc = cartesian(acc, alts);
  }
  return acc;
}

function evalExpr(raw: ts.Expression, res: Resolver, ctx: EvalCtx): string[] | null {
  const node = unwrap(raw);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node) || isPlus(node)) {
    const parts = flattenParts(node);
    return parts === undefined ? null : evalParts(parts, res, ctx);
  }
  if (ts.isConditionalExpression(node)) {
    const yes = evalExpr(node.whenTrue, res, ctx);
    const no = evalExpr(node.whenFalse, res, ctx);
    return yes === null || no === null ? null : [...yes, ...no];
  }
  if (ts.isBinaryExpression(node) && isFallback(node.operatorToken.kind)) {
    const left = evalExpr(node.left, res, ctx);
    const right = evalExpr(node.right, res, ctx);
    const all = [...(left ?? []), ...(right ?? [])];
    return all.length === 0 ? null : all;
  }
  if (ts.isIdentifier(node)) return evalIdentifier(node, res, ctx);
  if (
    ts.isPropertyAccessExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    return evalThisField(node.name.text, res, ctx);
  }
  return null;
}

function isPlus(node: ts.Node): boolean {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

function isFallback(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken;
}

function enclosingFunction(node: ts.Node): FunctionLike | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (isFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

/** Имя функции для поиска её вызовов: метод, объявление, `const f = () => ...`. */
function functionName(fn: FunctionLike): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name !== undefined) {
    return nameOfProperty(fn.name as ts.PropertyName);
  }
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent)) return nameOfProperty(parent.name);
  return undefined;
}

/** Все вызовы функции с этим именем в файле. */
function callSites(file: SourceFile, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeName(node) === name) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file.sf);
  return calls;
}

function evalIdentifier(id: ts.Identifier, res: Resolver, ctx: EvalCtx): string[] | null {
  // 1. Параметр ближайшей функции: значение из вызовов.
  let fn = enclosingFunction(id);
  while (fn !== undefined) {
    const index = fn.parameters.findIndex(
      (p) => ts.isIdentifier(p.name) && p.name.text === id.text,
    );
    if (index >= 0) return evalParameter(fn, index, res, ctx);
    fn = enclosingFunction(fn);
  }
  // 2. Константа в этом файле, затем экспортированная в другом файле разбора.
  const local = res.consts.get(id.text)?.filter((c) => c.file === ctx.file);
  const candidates = local !== undefined && local.length > 0 ? local : res.consts.get(id.text);
  if (candidates === undefined || candidates.length === 0) return null;
  const values = candidates.map((c) =>
    evalExpr(c.init, res, { ...ctx, file: c.file, depth: ctx.depth + 1 }),
  );
  const first = values[0];
  if (first === undefined || first === null) return null;
  // Одно имя с разными значениями в разных файлах - неоднозначно, не угадываем.
  const same = values.every((v) => v !== null && v.join('|') === first.join('|'));
  return same ? first : null;
}

function evalParameter(
  fn: FunctionLike,
  index: number,
  res: Resolver,
  ctx: EvalCtx,
): string[] | null {
  const name = functionName(fn);
  if (name === undefined || ctx.depth >= MAX_RESOLVE_DEPTH) return null;
  const key = `${ctx.file.key}:${fn.pos}:${index}`;
  if (ctx.seen.has(key)) return null;
  const seen = new Set(ctx.seen).add(key);
  const calls = callSites(ctx.file, name);
  if (calls.length === 0) return null;
  const all: string[] = [];
  for (const call of calls) {
    const arg = call.arguments[index];
    if (arg === undefined) return null;
    const value = evalExpr(arg, res, { file: ctx.file, depth: ctx.depth + 1, seen });
    if (value === null) return null;
    all.push(...value);
  }
  return all;
}

/** `this.x`: правые части присваиваний `this.x = ...` в файле (обычно в конструкторе). */
function evalThisField(name: string, res: Resolver, ctx: EvalCtx): string[] | null {
  if (ctx.depth >= MAX_RESOLVE_DEPTH) return null;
  const all: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.left.name.text === name
    ) {
      const value = evalExpr(node.right, res, { ...ctx, depth: ctx.depth + 1 });
      if (value !== null) all.push(...value);
    }
    ts.forEachChild(node, visit);
  };
  visit(ctx.file.sf);
  return all.length === 0 ? null : all;
}

// ---------------------------------------------------------------------------------------------
// Метод по месту использования адреса
// ---------------------------------------------------------------------------------------------
function methodOfObject(obj: ts.ObjectLiteralExpression): string | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && nameOfProperty(prop.name) === 'method') {
      const value = unwrap(prop.initializer);
      if (ts.isStringLiteral(value)) return value.text.toUpperCase();
    }
  }
  const call = obj.parent;
  if (ts.isCallExpression(call) && calleeName(call) === POST_DOCUMENTS_FILE) return 'POST';
  return undefined;
}

function isUrlProperty(node: ts.Node): boolean {
  return (
    (ts.isPropertyAssignment(node) && nameOfProperty(node.name) === 'url') ||
    ts.isShorthandPropertyAssignment(node) && node.name.text === 'url'
  );
}

/**
 * Методы, с которыми используется выражение-адрес `node` (или вызов функции, которая его
 * возвращает). undefined - определить не удалось.
 */
function usageMethods(node: ts.Node, depth: number, seen: Set<ts.Node>): string[] | undefined {
  if (depth > MAX_RESOLVE_DEPTH || seen.has(node)) return undefined;
  seen.add(node);
  // Шорткат `{ url, ... }`: сам узел - свойство объекта запроса.
  if (ts.isShorthandPropertyAssignment(node) && isUrlProperty(node)) {
    const method = ts.isObjectLiteralExpression(node.parent)
      ? methodOfObject(node.parent)
      : undefined;
    return method === undefined ? undefined : [method];
  }
  const outer = outerOf(node);
  const parent = outer.parent;
  if (parent === undefined) return undefined;
  // Свойство `url:` объекта запроса.
  if (isUrlProperty(parent) && ts.isObjectLiteralExpression(parent.parent)) {
    const method = methodOfObject(parent.parent);
    return method === undefined ? undefined : [method];
  }
  // Аргумент вызова fetch-подобной функции.
  if (ts.isCallExpression(parent) && parent.arguments.some((a) => a === outer)) {
    for (const arg of parent.arguments) {
      const inner = unwrap(arg);
      if (ts.isObjectLiteralExpression(inner)) {
        const method = methodOfObject(inner);
        if (method !== undefined) return [method];
      }
    }
    const name = calleeName(parent);
    return name !== undefined && FETCH_LIKE_RE.test(name) ? ['GET'] : undefined;
  }
  // `const url = ...`: все ссылки на url внутри функции.
  if (ts.isVariableDeclaration(parent) && parent.initializer === outer) {
    return usageOfVariable(parent, depth, seen);
  }
  // `return ...` или тело стрелки: все вызовы этой функции.
  if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === outer)) {
    const fn = enclosingFunction(outer);
    const name = fn === undefined ? undefined : functionName(fn);
    if (fn === undefined || name === undefined) return undefined;
    return usageOfCalls(callSites(sourceOf(outer), name), depth, seen);
  }
  return undefined;
}

function sourceOf(node: ts.Node): SourceFile {
  return { key: '', display: '', sf: node.getSourceFile() };
}

/** Идентификатор стоит на месте имени (`{ url: x }`, `a.url`), а не значения. */
function isNameSlot(id: ts.Identifier): boolean {
  const parent = id.parent;
  return (
    (ts.isPropertyAssignment(parent) && parent.name === id) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === id)
  );
}

function usageOfCalls(calls: ts.CallExpression[], depth: number, seen: Set<ts.Node>) {
  if (calls.length === 0) return undefined;
  const methods: string[] = [];
  for (const call of calls) {
    const found = usageMethods(call, depth + 1, seen);
    if (found === undefined) return undefined;
    methods.push(...found);
  }
  return methods;
}

function usageOfVariable(
  decl: ts.VariableDeclaration,
  depth: number,
  seen: Set<ts.Node>,
): string[] | undefined {
  if (!ts.isIdentifier(decl.name)) return undefined;
  const name = decl.name.text;
  const scope: ts.Node = enclosingFunction(decl) ?? decl.getSourceFile();
  const methods: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name && node !== decl.name && !isNameSlot(node)) {
      // Ссылка в позиции `url` (шорткат) или значения свойства/аргумента. Ссылки, из которых
      // метод не следует (имя спана, запись в журнал), пропускаются: нужна хотя бы одна
      // ссылка, где адрес реально уходит в запрос.
      const target = ts.isShorthandPropertyAssignment(node.parent) ? node.parent : node;
      const found = usageMethods(target, depth + 1, new Set(seen));
      if (found !== undefined) methods.push(...found);
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return methods.length === 0 ? undefined : methods;
}

// ---------------------------------------------------------------------------------------------
// Сборка манифеста
// ---------------------------------------------------------------------------------------------
/** Результат сборки. */
export interface ManifestResult {
  /** Строки манифеста в детерминированном порядке. */
  rows: RouteRow[];
  /** Откуда взят маршрут: ключ `сервис метод путь` -> `файл:строка`. */
  sources: Map<string, string[]>;
  /** Причины отказа: если список не пуст, сборка считается неудачной. */
  problems: string[];
  /** Сведения для оператора (внешние сервисы и т.п.). */
  notes: string[];
}

/** Параметры сборки (корни и таблица; таблица подменяется в тестах). */
export interface CollectOptions {
  platformRoot: string;
  projectRoot: string;
  table?: Readonly<Record<string, FileRule>>;
}

function ruleFor(rule: FileRule | undefined, baseName: string): ServiceRule | undefined {
  return rule?.byBase?.[baseName] ?? rule?.default;
}

function compareRows(a: RouteRow, b: RouteRow): number {
  const left = [a.service, a.path, a.method, a.kind];
  const right = [b.service, b.path, b.method, b.kind];
  for (let i = 0; i < left.length; i += 1) {
    const l = left[i] ?? '';
    const r = right[i] ?? '';
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}

/**
 * Собрать манифест из исходников адаптеров платформы и проекта.
 *
 * @param options корни исходников и (для тестов) таблица сервисов
 * @returns строки манифеста, источники, проблемы и примечания
 */
export function collectManifest(options: CollectOptions): ManifestResult {
  const table = options.table ?? SERVICE_TABLE;
  const files = [
    ...loadRoot(options.platformRoot, PLATFORM_LABEL),
    ...loadRoot(options.projectRoot, PROJECT_LABEL),
  ];
  const res = buildResolver(files);
  const problems: string[] = [];
  const rowMap = new Map<string, RouteRow>();
  const sources = new Map<string, string[]>();
  const routesPerFile = new Map<string, number>();
  const externalNotes = new Set<string>();

  for (const file of files) {
    for (const site of findSites(file, table[file.key]?.baseNames ?? [])) {
      const where = `${file.display}:${lineOf(file.sf, site.node)}`;
      const rule = ruleFor(table[file.key], site.baseName);
      if (rule === undefined) {
        problems.push(
          `${where}: неопознанный сервис (базовый адрес «${site.baseName}»): файл ` +
            `${file.key} не описан в SERVICE_TABLE tools/route-manifest.ts`,
        );
        continue;
      }
      const paths = evalParts(site.rest, res, { file, depth: 0, seen: new Set() });
      if (paths === null || paths.some((p) => !p.startsWith('/'))) {
        problems.push(`${where}: не удалось определить путь после «${site.baseName}»`);
        continue;
      }
      const methods = usageMethods(site.node, 0, new Set());
      if (methods === undefined) {
        problems.push(`${where}: не удалось определить HTTP-метод адреса ${paths.join(', ')}`);
        continue;
      }
      routesPerFile.set(file.key, (routesPerFile.get(file.key) ?? 0) + paths.length);
      if (rule.kind === 'external') {
        externalNotes.add(`${rule.service}: ${rule.reason ?? 'вне стека'}`);
      }
      for (const method of new Set(methods)) {
        for (const path of new Set(paths)) {
          const kind: RouteKind =
            rule.kind === 'external' ? 'external' : path.includes('{') ? 'template' : 'route';
          const row = routeRowSchema.safeParse({ service: rule.service, method, path, kind });
          if (!row.success) {
            problems.push(`${where}: недопустимая строка ${method} ${path}`);
            continue;
          }
          const key = [row.data.service, row.data.method, row.data.path].join(' ');
          rowMap.set(key, row.data);
          sources.set(key, [...(sources.get(key) ?? []), where]);
        }
      }
    }
  }

  // Файл из таблицы, который есть в корне, но маршрутов в нём не найдено: разбор мог сломаться.
  for (const file of files) {
    if (table[file.key] !== undefined && (routesPerFile.get(file.key) ?? 0) === 0) {
      problems.push(`${file.display}: файл есть в SERVICE_TABLE, но маршрутов в нём не найдено`);
    }
  }
  const rows = [...rowMap.values()].sort(compareRows);
  const notes = [...externalNotes].sort().map((n) => `внешний сервис, не пробуется: ${n}`);
  return { rows, sources, problems, notes };
}

/** Манифест в формате TSV: `сервис метод путь вид`, по строке на маршрут. */
export function formatTsv(rows: readonly RouteRow[]): string {
  return rows.map((r) => [r.service, r.method, r.path, r.kind].join(TAB) + '\n').join('');
}

// ---------------------------------------------------------------------------------------------
// Командная строка
// ---------------------------------------------------------------------------------------------
/** Разобрать аргументы; бросает Error с понятным сообщением при неверном вызове. */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  const raw = {
    platformRoot: DEFAULT_PLATFORM_ROOT,
    projectRoot: DEFAULT_PROJECT_ROOT,
    explain: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--explain') {
      raw.explain = true;
    } else if (arg === '--platform-root' || arg === '--project-root') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} требует каталог`);
      if (arg === '--platform-root') raw.platformRoot = resolve(value);
      else raw.projectRoot = resolve(value);
      i += 1;
    } else {
      throw new Error(`неизвестный аргумент: ${String(arg)}`);
    }
  }
  const parsed = cliSchema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
}

const USAGE =
  'использование: bun tools/route-manifest.ts [--platform-root КАТАЛОГ] ' +
  '[--project-root КАТАЛОГ] [--explain]';

/** Точка входа: печатает манифест в stdout, диагностику в stderr; возвращает код выхода. */
export function main(argv: readonly string[]): number {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
    for (const root of [options.platformRoot, options.projectRoot]) {
      if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`нет каталога исходников: ${root}`);
      }
    }
  } catch (error) {
    console.error(`route-manifest: ${error instanceof Error ? error.message : String(error)}`);
    console.error(USAGE);
    return EXIT_USAGE;
  }
  const result = collectManifest(options);
  for (const note of result.notes) console.error(`route-manifest: ${note}`);
  if (options.explain) {
    for (const [key, where] of [...result.sources.entries()].sort()) {
      console.error(`route-manifest: ${key} <- ${[...new Set(where)].join(', ')}`);
    }
  }
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.error(`route-manifest: ОШИБКА ${problem}`);
    console.error(`route-manifest: манифест не собран, проблем: ${result.problems.length}`);
    return EXIT_PROBLEMS;
  }
  process.stdout.write(formatTsv(result.rows));
  return EXIT_OK;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
