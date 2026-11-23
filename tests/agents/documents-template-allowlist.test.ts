import { beforeEach, describe, expect, test } from 'bun:test';
import { findTemplate } from '../../src/agents/documents/find-template';
import { fillTemplate } from '../../src/agents/documents/fill-template';
import { readAllowedTemplate } from '../../src/agents/documents/template-access';
import { isDomainError } from '@business-ai/core';
import { CTX, buildDocument, buildDocumentsDeps, putFile } from './support';

let deps: Awaited<ReturnType<typeof buildDocumentsDeps>>;
const OK = 'templates/КП шаблон.docx';
const OTHER = 'templates/Секретный.docx';

beforeEach(async () => {
  deps = await buildDocumentsDeps();
  putFile(deps, OK, 'tpl');
  putFile(deps, OTHER, 'tpl2');
  putFile(deps, 'прайс.xlsx', 'not a template');
  putFile(deps, 'notes.txt', 'text');
});

const codeOf = async (work: Promise<unknown>): Promise<string | undefined> => {
  const error = await work.catch((e: unknown) => e);
  return isDomainError(error) ? error.code : undefined;
};

describe('R4-SEC-8: allowlist шаблонов', () => {
  test('перечень задан: другой шаблон каталога отклоняется access_denied', async () => {
    const strict = { ...deps, templateAllowlist: [OK] };
    expect(await readAllowedTemplate(strict, OK)).toBeDefined();
    expect(await codeOf(readAllowedTemplate(strict, OTHER))).toBe('access_denied');
    const args = { templatePath: OTHER, document: buildDocument() };
    expect(await codeOf(fillTemplate.execute(args, strict, CTX))).toBe('access_denied');
  });

  test('перечень задан: запись пути нормализуется (./ и обратные слэши)', async () => {
    const strict = { ...deps, templateAllowlist: ['./templates\\КП шаблон.docx'] };
    expect(await readAllowedTemplate(strict, `./${OK}`)).toBeDefined();
  });

  test('пустой явный перечень отклоняет всё', async () => {
    const none = { ...deps, templateAllowlist: [] };
    expect(await codeOf(readAllowedTemplate(none, OK))).toBe('access_denied');
  });

  test('перечня нет: только каталог шаблонов по префиксу и расширению', async () => {
    const scoped = { ...deps, templatesPrefix: 'templates/' };
    expect(await readAllowedTemplate(scoped, OK)).toBeDefined();
    expect(await codeOf(readAllowedTemplate(scoped, 'прайс.xlsx'))).toBe('access_denied');
    expect(await codeOf(readAllowedTemplate(scoped, 'templates/notes.txt'))).toBe('access_denied');
    expect(await codeOf(readAllowedTemplate(scoped, 'templates/нет.docx'))).toBe('not_found');
  });

  test('путь вне каталога через .. не проходит префикс', async () => {
    const scoped = { ...deps, templatesPrefix: 'templates/' };
    expect(await codeOf(readAllowedTemplate(scoped, 'templates/../прайс.xlsx'))).toBe(
      'access_denied',
    );
  });
});

describe('R4-SEC-8: путь шаблона доходит до рендерера', () => {
  test('fillTemplate передаёт нормализованный templatePath', async () => {
    const seen: Array<string | undefined> = [];
    const spy = {
      ...deps,
      renderer: {
        async render(request: Parameters<typeof deps.renderer.render>[0]) {
          seen.push(request.templatePath);
          return deps.renderer.render(request);
        },
      },
    };
    await fillTemplate.execute({ templatePath: `./${OK}`, document: buildDocument() }, spy, CTX);
    expect(seen).toEqual([OK]);
  });
});

describe('R7-12: каталог в перечне (запись с / на конце)', () => {
  const DIR = 'Акты/';
  const IN_DIR = 'Акты/акт сверки.docx';

  beforeEach(() => {
    putFile(deps, IN_DIR, 'tpl');
    putFile(deps, 'Акты/памятка.txt', 'text');
    putFile(deps, 'Актыничего/акт.docx', 'tpl');
  });

  test('файл каталога проходит, соседний каталог с тем же началом и чужой путь нет', async () => {
    const strict = { ...deps, templateAllowlist: [DIR] };
    expect(await readAllowedTemplate(strict, IN_DIR)).toBeDefined();
    expect(await codeOf(readAllowedTemplate(strict, 'Актыничего/акт.docx'))).toBe('access_denied');
    expect(await codeOf(readAllowedTemplate(strict, OK))).toBe('access_denied');
    expect(await codeOf(readAllowedTemplate(strict, 'Акты/памятка.txt'))).toBe('access_denied');
  });

  test('.., абсолютный путь и выход за префикс отклоняются', async () => {
    const strict = { ...deps, templateAllowlist: [DIR] };
    for (const bad of ['Акты/../прайс.xlsx', 'Акты/../templates/Секретный.docx', '/Акты/a.docx',
      '/etc/passwd', 'Акты\\..\\templates\\Секретный.docx', '../Акты/a.docx']) {
      expect(await codeOf(readAllowedTemplate(strict, bad))).toBe('access_denied');
    }
  });

  test('запись каталога с .. или абсолютная ничего не разрешает', async () => {
    for (const entry of ['../', '/', 'Акты/../', '/Акты/']) {
      const strict = { ...deps, templateAllowlist: [entry] };
      expect(await codeOf(readAllowedTemplate(strict, OK))).toBe('access_denied');
      expect(await codeOf(readAllowedTemplate(strict, IN_DIR))).toBe('access_denied');
    }
  });

  test('findTemplate фильтрует тем же перечнем', async () => {
    const strict = { ...deps, templateAllowlist: [DIR, OTHER] };
    const out = await findTemplate.execute({ query: 'акт секретный' }, strict, CTX);
    expect(out.templates.map((t) => t.path).sort()).toEqual([IN_DIR, OTHER].sort());
    const none = await findTemplate.execute({ query: 'кп шаблон' }, strict, CTX);
    expect(none.templates).toEqual([]);
  });
});
