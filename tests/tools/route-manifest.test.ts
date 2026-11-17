import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  collectManifest,
  formatTsv,
  parseCliArgs,
  SERVICE_TABLE,
  type FileRule,
  type RouteRow,
} from '../../tools/route-manifest';

/** Корень репозитория (тест лежит в tests/tools/). */
const ROOT = join(import.meta.dir, '..', '..');
const SCRIPT = join(ROOT, 'tools', 'route-manifest.ts');
const PLATFORM_ROOT = join(ROOT, 'node_modules', '@business-ai', 'adapters', 'src');
const PROJECT_ROOT = join(ROOT, 'src');
/** Сколько ждать один запуск сборщика на реальном дереве, мс. */
const RUN_TIMEOUT_MS = 60_000;
const EXIT_PROBLEMS = 1;
const EXIT_USAGE = 2;
/** Проектные маршруты, которых не хватило на бою (404 у платформенного documents). */
const DOCX_ROUTES = [
  '/docx/amend',
  '/docx/classify',
  '/docx/party-block',
  '/docx/replace-signatory',
];

function has(rows: readonly RouteRow[], service: string, method: string, path: string): boolean {
  return rows.some((r) => r.service === service && r.method === method && r.path === path);
}

function kindOf(rows: readonly RouteRow[], service: string, method: string, path: string): string {
  return rows.find((r) => r.service === service && r.method === method && r.path === path)
    ?.kind ?? 'нет';
}

describe('tools/route-manifest.ts: реальное дерево', () => {
  const result = collectManifest({ platformRoot: PLATFORM_ROOT, projectRoot: PROJECT_ROOT });

  test('сборка идёт без проблем', () => {
    expect(result.problems).toEqual([]);
  });

  test('находит все четыре /docx/* из http-contract-amender.ts как POST documents', () => {
    for (const path of DOCX_ROUTES) {
      expect(has(result.rows, 'documents', 'POST', path)).toBe(true);
      expect(kindOf(result.rows, 'documents', 'POST', path)).toBe('route');
    }
    const sources = result.sources.get('documents POST /docx/amend') ?? [];
    expect(sources.some((s) => s.includes('http-contract-amender.ts'))).toBe(true);
  });

  test('находит маршруты платформенных адаптеров по сервисам', () => {
    const expected: Array<[string, string, string]> = [
      ['documents', 'POST', '/parse'],
      ['documents', 'POST', '/parse-archive'],
      ['documents', 'POST', '/render'],
      ['documents', 'POST', '/xlsx/write'],
      ['documents', 'POST', '/images/recognize-text'],
      ['documents', 'POST', '/images/normalize'],
      ['documents', 'POST', '/edit-prices'],
      ['embeddings', 'POST', '/embed'],
      ['mask', 'POST', '/mask_image'],
      ['pseudonymizer', 'POST', '/pseudonymize'],
      ['pseudonymizer', 'POST', '/restore'],
      ['pseudonymizer', 'POST', '/inflect_signatory'],
      ['pseudonymizer', 'GET', '/health'],
      ['speech', 'POST', '/transcribe'],
      ['speech', 'POST', '/jobs'],
    ];
    for (const [service, method, path] of expected) {
      expect(has(result.rows, service, method, path)).toBe(true);
    }
  });

  test('маршруты с параметром - template, внешние - external', () => {
    expect(kindOf(result.rows, 'speech', 'GET', '/jobs/{jobId}')).toBe('template');
    expect(kindOf(result.rows, 'speech', 'DELETE', '/jobs/{jobId}')).toBe('template');
    expect(kindOf(result.rows, 'gateway', 'POST', '/v1/messages')).toBe('external');
    expect(kindOf(result.rows, 'gateway', 'POST', '/vision/v1/messages')).toBe('external');
  });

  test('порядок детерминированный и вывод повторяется байт в байт', () => {
    const again = collectManifest({ platformRoot: PLATFORM_ROOT, projectRoot: PROJECT_ROOT });
    expect(formatTsv(again.rows)).toBe(formatTsv(result.rows));
    const keys = result.rows.map((r) => `${r.service}\t${r.path}\t${r.method}`);
    expect(keys).toEqual([...keys].sort());
  });

  test('TSV: четыре колонки, сервис и вид из допустимых, без дублей', () => {
    const lines = formatTsv(result.rows).split('\n').filter((l) => l !== '');
    expect(lines.length).toBeGreaterThan(DOCX_ROUTES.length);
    expect(new Set(lines).size).toBe(lines.length);
    for (const line of lines) {
      const cols = line.split('\t');
      expect(cols).toHaveLength(4);
      expect(cols[2]?.startsWith('/')).toBe(true);
      expect(['route', 'template', 'external']).toContain(cols[3] ?? '');
    }
  });

  test('каждая строка таблицы сервисов даёт хотя бы один маршрут', () => {
    expect(result.problems.filter((p) => p.includes('маршрутов в нём не найдено'))).toEqual([]);
    expect(Object.keys(SERVICE_TABLE).length).toBeGreaterThan(10);
  });
});

describe('tools/route-manifest.ts: формы вызова (синтетические исходники)', () => {
  let dir = '';
  const write = (rel: string, text: string): void => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf-8');
  };
  const table: Record<string, FileRule> = {
    'platform:a.ts': { default: { service: 'alpha', kind: 'route' } },
    'platform:b.ts': {
      byBase: {
        docsBaseUrl: { service: 'alpha', kind: 'route' },
        gwBaseUrl: { service: 'gw', kind: 'external', reason: 'снаружи' },
      },
    },
    'platform:c.ts': { default: { service: 'alpha', kind: 'route' }, baseNames: ['base'] },
  };
  const collect = (extra?: Record<string, FileRule>) =>
    collectManifest({
      platformRoot: join(dir, 'platform'),
      projectRoot: join(dir, 'project'),
      table: { ...table, ...extra },
    });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'route-manifest-test.'));
    mkdirSync(join(dir, 'project'), { recursive: true });
    write(
      'platform/consts.ts',
      "export const SHARED_ROUTE = '/shared/route';\nexport const OTHER = `/other`;\n",
    );
    write(
      'platform/a.ts',
      `import { SHARED_ROUTE } from './consts';
const LOCAL = '/local';
export class A {
  private readonly baseUrl: string;
  private readonly messagesPath: string;
  constructor(options: { baseUrl: string; messagesPath?: string }) {
    this.baseUrl = options.baseUrl;
    this.messagesPath = options.messagesPath || '/default/path';
  }
  async literal() {
    return requestJson({ url: \`\${this.baseUrl}/lit\`, method: 'POST' });
  }
  async constants() {
    await requestJson({ url: this.baseUrl + SHARED_ROUTE, method: 'POST' });
    await requestJson({ url: \`\${this.baseUrl}\${LOCAL}\`, method: 'GET' });
  }
  async cond(flag: boolean) {
    await requestJson({ url: \`\${this.baseUrl}\${flag ? '/yes' : '/no'}\`, method: 'POST' });
  }
  async viaParam() {
    await this.post('/p/one', {});
    await this.post('/p/two', {});
  }
  private post(path: string, body: unknown) {
    return this.postHeld(path, body);
  }
  private postHeld(path: string, body: unknown) {
    return requestJson({ url: \`\${this.baseUrl}\${path}\`, method: 'POST', body });
  }
  async field() {
    await requestJson({ url: \`\${this.baseUrl}\${this.messagesPath}\`, method: 'POST' });
  }
  async param(id: string) {
    await requestJson({
      url: \`\${this.baseUrl}/items/\${encodeURIComponent(id)}\`,
      method: 'DELETE',
    });
  }
  async shorthand() {
    const url = \`\${this.baseUrl}/short\`;
    log(url);
    return requestJson({ url, method: 'POST' });
  }
  async plainFetch() {
    return fetch(\`\${this.baseUrl}/plain-get\`);
  }
  async fetchPost() {
    return this.fetchFn(\`\${this.baseUrl}/fetch-post\`, { method: 'POST', body: '{}' });
  }
  async file() {
    return postDocumentsFile({ url: \`\${this.baseUrl}/file-call\`, fileName: 'x' });
  }
  private jobUrl(id: string): string {
    return \`\${this.baseUrl}/jobs/\${encodeURIComponent(id)}\`;
  }
  async job(id: string) {
    await requestJson({ url: this.jobUrl(id), method: 'GET' });
    await fetchWithDeadline(this.fetchFn, this.jobUrl(id), { method: 'DELETE' });
  }
}
`,
    );
    write(
      'platform/b.ts',
      `export class B {
  async two() {
    await requestJson({ url: \`\${this.docsBaseUrl}/from-docs\`, method: 'POST' });
    await requestJson({ url: \`\${this.gwBaseUrl}/from-gw\`, method: 'POST' });
  }
}
`,
    );
    write(
      'platform/c.ts',
      `export function send(base: string) {
  return fetch(\`\${base}/generic-base\`, { method: 'POST' });
}
`,
    );
  });

  afterAll(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  test('понимает литералы, константы (и чужого файла), условия, цепочку параметров', () => {
    const { rows, problems } = collect();
    expect(problems).toEqual([]);
    for (const path of ['/lit', '/shared/route', '/yes', '/no', '/p/one', '/p/two']) {
      expect(has(rows, 'alpha', 'POST', path)).toBe(true);
    }
    expect(has(rows, 'alpha', 'GET', '/local')).toBe(true);
  });

  test('поле this.x из конструктора с запасным значением', () => {
    expect(has(collect().rows, 'alpha', 'POST', '/default/path')).toBe(true);
  });

  test('значение после первого сегмента - параметр, маршрут получает вид template', () => {
    const { rows } = collect();
    expect(kindOf(rows, 'alpha', 'DELETE', '/items/{id}')).toBe('template');
    expect(kindOf(rows, 'alpha', 'GET', '/jobs/{id}')).toBe('template');
    expect(kindOf(rows, 'alpha', 'DELETE', '/jobs/{id}')).toBe('template');
  });

  test('метод: const url + шорткат, fetch без объекта, fetch с методом, postDocumentsFile', () => {
    const { rows } = collect();
    expect(has(rows, 'alpha', 'POST', '/short')).toBe(true);
    expect(has(rows, 'alpha', 'GET', '/plain-get')).toBe(true);
    expect(has(rows, 'alpha', 'POST', '/fetch-post')).toBe(true);
    expect(has(rows, 'alpha', 'POST', '/file-call')).toBe(true);
  });

  test('сервис по имени базового адреса внутри одного файла', () => {
    const { rows } = collect();
    expect(kindOf(rows, 'alpha', 'POST', '/from-docs')).toBe('route');
    expect(kindOf(rows, 'gw', 'POST', '/from-gw')).toBe('external');
  });

  test('голое имя base допустимо только там, где его разрешает таблица', () => {
    expect(has(collect().rows, 'alpha', 'POST', '/generic-base')).toBe(true);
    const strict = collect({ 'platform:c.ts': { default: { service: 'alpha', kind: 'route' } } });
    expect(strict.rows.some((r) => r.path === '/generic-base')).toBe(false);
    // Файл из таблицы без найденных маршрутов - проблема, а не молчаливый пропуск.
    expect(strict.problems.some((p) => p.includes('c.ts'))).toBe(true);
  });

  test('файл с вызовом, которого нет в таблице, - проблема «неопознанный сервис»', () => {
    const unknown = collectManifest({
      platformRoot: join(dir, 'platform'),
      projectRoot: join(dir, 'project'),
      table: {},
    });
    expect(unknown.problems.some((p) => p.includes('неопознанный сервис'))).toBe(true);
    expect(unknown.rows).toEqual([]);
  });
});

describe('tools/route-manifest.ts: проблемы разбора и командная строка', () => {
  let dir = '';
  const run = (...args: string[]) =>
    spawnSync('bun', [SCRIPT, ...args], { encoding: 'utf-8', timeout: RUN_TIMEOUT_MS });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'route-manifest-cli.'));
    mkdirSync(join(dir, 'platform', 'http'), { recursive: true });
    mkdirSync(join(dir, 'project'), { recursive: true });
    writeFileSync(
      join(dir, 'platform', 'http', 'http-foo.ts'),
      [
        'export class F {',
        "  go() { return requestJson({ url: `${this.baseUrl}/foo`, method: 'POST' }); }",
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
  });

  afterAll(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  test('неопознанный сервис: код 1, причина в stderr, манифест в stdout пуст', () => {
    const r = run('--platform-root', join(dir, 'platform'), '--project-root', join(dir, 'project'));
    expect(r.status).toBe(EXIT_PROBLEMS);
    expect(r.stderr).toContain('неопознанный сервис');
    expect(r.stderr).toContain('http-foo.ts');
    expect(r.stdout).toBe('');
  });

  test('неопределимый путь и метод - ошибка, а не пропуск', () => {
    const bad = join(dir, 'bad');
    mkdirSync(join(bad, 'platform'), { recursive: true });
    mkdirSync(join(bad, 'project'), { recursive: true });
    writeFileSync(
      join(bad, 'platform', 'x.ts'),
      [
        'export class X {',
        "  a() { return requestJson({ url: `${this.baseUrl}${this.nope}`, method: 'POST' }); }",
        '  b() { return log(`${this.baseUrl}/no-method`); }',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    const result = collectManifest({
      platformRoot: join(bad, 'platform'),
      projectRoot: join(bad, 'project'),
      table: { 'platform:x.ts': { default: { service: 'alpha', kind: 'route' } } },
    });
    expect(result.problems.some((p) => p.includes('не удалось определить путь'))).toBe(true);
    expect(result.problems.some((p) => p.includes('HTTP-метод'))).toBe(true);
    expect(result.rows).toEqual([]);
  });

  test('неверный вызов: код 2', () => {
    expect(run('--unknown').status).toBe(EXIT_USAGE);
    expect(run('--platform-root').status).toBe(EXIT_USAGE);
    expect(run('--platform-root', join(dir, 'нет-такого')).status).toBe(EXIT_USAGE);
    expect(() => parseCliArgs(['--platform-root'])).toThrow();
  });

  test('на реальном дереве: код 0, в stdout только TSV из четырёх колонок', () => {
    const r = run();
    expect(r.status).toBe(0);
    const lines = r.stdout.split('\n').filter((l) => l !== '');
    expect(lines.length).toBeGreaterThan(DOCX_ROUTES.length);
    for (const line of lines) expect(line.split('\t')).toHaveLength(4);
    for (const path of DOCX_ROUTES) {
      expect(lines).toContain(`documents\tPOST\t${path}\troute`);
    }
  });
});
