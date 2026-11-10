import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryFileSource } from '@business-ai/adapters';
import {
  parseContractRegistryPath,
  searchContractRegistry,
} from '../../src/agents/documents/contract-registry';
import type { DocumentParser, FileSource, ParsedDocument } from '@business-ai/core';
import { CTX, buildDocumentsDeps, putFile } from './support';

/** Поиск папки реестра по двум корням (шаблоны и диск К). Данные синтетические. */

const DIR = 'Юридическая документация';
const FILE = '2026 год Реестр заключенных договоров Прагматика.xlsx';
const MTIME = 1;

class StubParser implements DocumentParser {
  parsed: string[] = [];
  async parse(name: string): Promise<ParsedDocument> {
    this.parsed.push(name);
    return {
      text: '',
      tables: [[['№', 'Контрагент'], ['ПР-1', 'ООО Тест']]],
      tableNames: ['Реестр'],
      needsOcr: false,
      hasHiddenContent: false,
      hiddenSheets: [],
      truncated: false,
      warnings: [],
    };
  }
}

let deps: Awaited<ReturnType<typeof buildDocumentsDeps>>;
let disk: MemoryFileSource;
let parser: StubParser;

const put = (source: MemoryFileSource, path: string): void =>
  source.put(path, new TextEncoder().encode('x'), MTIME);
const run = () => searchContractRegistry.execute({ query: 'Тест' }, deps, CTX);
const prRegistry = (out: Awaited<ReturnType<typeof run>>) =>
  out.registries.find((r) => r.entity === 'Прагматика');

beforeEach(async () => {
  deps = await buildDocumentsDeps();
  disk = new MemoryFileSource();
  parser = new StubParser();
  Object.assign(deps, { parser, registryFiles: disk });
});

describe('поиск папки реестра договоров', () => {
  test('папка в корне диска К находится, когда в корне шаблонов её нет', async () => {
    putFile(deps, 'Договор.docx', 'x');
    put(disk, `${DIR}/${FILE}`);
    const out = await run();
    expect(prRegistry(out)?.status).toBe('read');
    expect(out.search.foundIn).toBe(`files:${DIR}`);
    expect(out.matches.length).toBe(1);
  });

  test('папка в подкаталоге глубины 2 находится', async () => {
    put(disk, `zakupki/${DIR}/${FILE}`);
    const out = await run();
    expect(prRegistry(out)?.status).toBe('read');
    expect(out.search.foundIn).toBe(`files:zakupki/${DIR}`);
    expect(parser.parsed).toEqual([FILE]);
  });

  test('глубже трёх уровней не ищем', async () => {
    put(disk, `a/b/c/${DIR}/${FILE}`);
    const out = await run();
    expect(prRegistry(out)?.status).toBe('not_found');
  });

  test('корень шаблонов предпочтительнее диска К', async () => {
    putFile(deps, `${DIR}/${FILE}`, 'x');
    put(disk, `${DIR}/${FILE}`);
    const out = await run();
    expect(out.search.foundIn).toBe(`templates:${DIR}`);
  });

  test('не найдена: сообщение перечисляет корни, глубину и имена каталогов', async () => {
    putFile(deps, 'Шаблоны/Договор.docx', 'x');
    put(disk, 'produkciya/Прайс.xlsx');
    put(disk, 'zakupki/Архив/Файл.xlsx');
    const out = await run();
    expect(prRegistry(out)?.status).toBe('not_found');
    expect(out.search.maxDepth).toBe(3);
    expect(out.instruction).toContain('на глубину 3');
    expect(out.instruction).toContain('templates');
    expect(out.instruction).toContain('files');
    expect(out.instruction).toContain('produkciya');
    expect(out.instruction).toContain('zakupki/Архив');
    expect(out.instruction).toContain('Шаблоны');
    expect(out.instruction).toContain('CONTRACT_REGISTRY_PATH');
    // Имён файлов в сообщении нет.
    expect(out.instruction).not.toContain('Прайс.xlsx');
    expect(out.instruction).not.toContain('Договор.docx');
  });

  test('папки нет нигде: точная причина, имена каталогов не более 40, подсказка', async () => {
    for (let i = 0; i < 60; i += 1) put(disk, `каталог${String(i).padStart(2, '0')}/ф.xlsx`);
    putFile(deps, 'Шаблоны/Договор.docx', 'x');
    const out = await run();
    const reason = prRegistry(out)?.reason ?? '';
    expect(reason).toBe(`папка «${DIR}» не найдена ни в каталоге шаблонов, ни на диске К`);
    expect(reason).not.toContain('найдена, но');
    for (const root of out.search.roots) expect(root.topDirs.length).toBeLessThanOrEqual(40);
    expect(out.search.roots.find((r) => r.root === 'files')?.topDirs.length).toBe(40);
    expect(out.instruction).toContain('Шаблоны');
    expect(out.instruction).toContain(`положить реестр в папку «${DIR}» в каталоге шаблонов`);
    expect(out.instruction).toContain('CONTRACT_REGISTRY_PATH');
    expect(out.instruction).toContain('не спрашивай номер и дату');
  });

  test('папка есть, файла реестра нет: другая формулировка', async () => {
    put(disk, `${DIR}/Другое.xlsx`);
    const out = await run();
    const reason = prRegistry(out)?.reason ?? '';
    expect(prRegistry(out)?.status).toBe('not_found');
    expect(reason).toContain('найдена, но файла');
    expect(reason).not.toContain('не найдена ни в каталоге');
  });

  test('мягкое имя папки (регистр, «е» вместо «ё», кавычки, подпапка) находится', async () => {
    put(disk, `Архив/«юридическая документация»/${FILE}`);
    const out = await run();
    expect(prRegistry(out)?.status).toBe('read');
    expect(out.matches.length).toBe(1);
  });

  test('настройка пути files: берёт реестр из заданной папки', async () => {
    deps.contractRegistryPath = 'files:zakupki/Архив/Реестры';
    put(disk, `zakupki/Архив/Реестры/${FILE}`);
    put(disk, `${DIR}/2026 год Реестр заключенных договоров Мастер Гифтс.xlsx`);
    const out = await run();
    expect(prRegistry(out)?.status).toBe('read');
    expect(out.search.foundIn).toBe('files:zakupki/Архив/Реестры');
    expect(out.search.configuredPath).toBe('files:zakupki/Архив/Реестры');
    // Мастер Гифтс в заданной папке нет: берётся найденной папкой автопоиска.
    expect(out.registries.find((r) => r.entity === 'Мастер Гифтс')?.status).toBe('read');
  });

  test('настройка templates: читает корень шаблонов', async () => {
    deps.contractRegistryPath = `templates:Договоры/${DIR}`;
    putFile(deps, `Договоры/${DIR}/${FILE}`, 'x');
    const out = await run();
    expect(prRegistry(out)?.status).toBe('read');
    expect(out.search.foundIn).toBe(`templates:Договоры/${DIR}`);
  });

  test('заданный путь неверен: автопоиск всё равно находит папку', async () => {
    deps.contractRegistryPath = 'files:нет/такой';
    put(disk, `sait/${DIR}/${FILE}`);
    const out = await run();
    expect(prRegistry(out)?.status).toBe('read');
    expect(out.search.foundIn).toBe(`files:sait/${DIR}`);
  });

  test('регистр и NFD в имени папки не мешают', async () => {
    put(disk, `zakupki/${DIR.toUpperCase()}/${FILE}`.normalize('NFD'));
    const out = await run();
    expect(prRegistry(out)?.status).toBe('read');
  });

  test('без второго корня работает как раньше: только шаблоны', async () => {
    delete deps.registryFiles;
    putFile(deps, `${DIR}/${FILE}`, 'x');
    const out = await run();
    expect(prRegistry(out)?.status).toBe('read');
    expect(out.search.roots.map((r) => r.root)).toEqual(['templates']);
  });

  test('корень не читается: read_error с причиной, а не «не найден»', async () => {
    const broken: FileSource = {
      list: async () => {
        throw new Error('нет доступа');
      },
      stat: async () => null,
      read: async () => new Uint8Array(),
      changesSince: async () => [],
    };
    deps.files = broken as typeof deps.files;
    delete deps.registryFiles;
    const out = await run();
    expect(prRegistry(out)?.status).toBe('read_error');
  });
});

describe('разбор CONTRACT_REGISTRY_PATH', () => {
  test('принимает files: и templates:, пусто и мусор отклоняет', () => {
    expect(parseContractRegistryPath('files:zakupki/Юр')).toEqual({
      root: 'files',
      dir: 'zakupki/Юр',
    });
    expect(parseContractRegistryPath(' templates:/Юр/ ')).toBeUndefined();
    expect(parseContractRegistryPath('templates:Юр/')).toEqual({ root: 'templates', dir: 'Юр' });
    expect(parseContractRegistryPath('')).toBeUndefined();
    expect(parseContractRegistryPath('zakupki/Юр')).toBeUndefined();
    expect(parseContractRegistryPath('files:../x')).toBeUndefined();
    expect(parseContractRegistryPath('files:')).toBeUndefined();
  });
});
