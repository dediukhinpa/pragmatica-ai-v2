import { beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock, MemoryDocumentParser } from '@business-ai/adapters';
import { searchContractRegistry } from '../../src/agents/documents/contract-registry';
import { DomainError } from '@business-ai/core';
import type { DocumentParser, ParsedDocument } from '@business-ai/core';
import { CTX, buildDocumentsDeps, putFile } from './support';

let deps: Awaited<ReturnType<typeof buildDocumentsDeps>>;

const DIR = 'Юридическая документация';
const PR_2026 = `${DIR}/2026 год Реестр заключенных договоров Прагматика.xlsx`;
const MG_2026 = `${DIR}/2026 год Реестр заключенных договоров Мастер Гифтс.xlsx`;
const HEADER = ['№', 'Дата', 'Контрагент', 'Предмет'];

/** Парсер-заглушка: отдаёт заданные таблицы или падает заданной ошибкой. */
class StubParser implements DocumentParser {
  tables: string[][][] = [];
  failure: Error | undefined;
  parsed: string[] = [];
  async parse(name: string): Promise<ParsedDocument> {
    this.parsed.push(name);
    if (this.failure !== undefined) throw this.failure;
    return {
      text: '',
      tables: this.tables,
      tableNames: this.tables.map(() => 'Реестр'),
      needsOcr: false,
      hasHiddenContent: false,
      hiddenSheets: [],
      truncated: false,
      warnings: [],
    };
  }
}

let parser: StubParser;

beforeEach(async () => {
  deps = await buildDocumentsDeps();
  parser = new StubParser();
  parser.tables = [
    [
      HEADER,
      ['ПР-2026-0001', '2026-03-01', 'ООО «Ромашка»', 'Поставка болтов'],
      ['ПР-2026-0002', '2026-04-01', 'АО Василёк', 'Поставка гаек'],
    ],
  ];
  Object.assign(deps, { parser });
});

const run = (query: string) => searchContractRegistry.execute({ query }, deps, CTX);

describe('чтение реестра договоров', () => {
  test('находит договор контрагента без учёта регистра и называет реестр', async () => {
    putFile(deps, PR_2026, 'x');
    putFile(deps, MG_2026, 'x');
    const out = await run('РОМАШКА');
    expect(out.year).toBe(2026);
    expect(out.matches.length).toBe(2);
    expect(out.matches[0]?.row).toContain('ПР-2026-0001');
    expect(out.matches[0]?.header).toContain('Контрагент');
    expect(out.matches.map((m) => m.entity).sort()).toEqual(['Мастер Гифтс', 'Прагматика']);
    expect(out.registries.every((r) => r.status === 'read')).toBe(true);
    expect(out.instruction).toContain('сообщи сотруднику');
  });

  test('«ё» и «е» не различаются: Василёк находится по «василек»', async () => {
    putFile(deps, PR_2026, 'x');
    const out = await run('василек');
    expect(out.matches.some((m) => m.row.includes('ПР-2026-0002'))).toBe(true);
  });

  test('нет такого контрагента: пустой список и честное «нет»', async () => {
    putFile(deps, PR_2026, 'x');
    putFile(deps, MG_2026, 'x');
    const out = await run('Несуществующий');
    expect(out.matches).toEqual([]);
    expect(out.instruction).toContain('нет');
  });

  test('год берётся из часов: в 2027 читается реестр 2027, а не 2026', async () => {
    deps.clock = new FixedClock(new Date('2027-02-01T00:00:00.000Z'));
    putFile(deps, PR_2026, 'x');
    const missing = await run('Ромашка');
    expect(missing.year).toBe(2027);
    expect(parser.parsed).toEqual([]);
    const pr = missing.registries.find((r) => r.entity === 'Прагматика');
    expect(pr?.status).toBe('not_found');
    expect(pr?.reason).toContain('2027 год Реестр заключенных договоров Прагматика');
    putFile(deps, `${DIR}/2027 год Реестр заключенных договоров Прагматика.xls`, 'x');
    const found = await run('Ромашка');
    expect(found.matches.length).toBe(1);
    expect(parser.parsed).toEqual(['2027 год Реестр заключенных договоров Прагматика.xls']);
  });

  test('реестр не найден: точная причина по каждому юрлицу, молчания нет', async () => {
    const out = await run('Ромашка');
    expect(out.matches).toEqual([]);
    expect(out.registries.map((r) => r.status)).toEqual(['not_found', 'not_found']);
    expect(out.registries[0]?.reason).toBe(
      `папка «${DIR}» не найдена ни в каталоге шаблонов, ни на диске К`,
    );
    expect(out.instruction).toContain('не спрашивай номер и дату');
    expect(out.instruction).toContain('не прочитан');
    expect(out.instruction).toContain('Мастер Гифтс');
  });

  test('файл в другой папке или блокировка Excel реестром не считаются', async () => {
    putFile(deps, '2026 год Реестр заключенных договоров Прагматика.xlsx', 'x');
    putFile(deps, `${DIR}/~$2026 год Реестр заключенных договоров Прагматика.xlsx`, 'x');
    const out = await run('Ромашка');
    expect(out.registries.map((r) => r.status)).toEqual(['not_found', 'not_found']);
  });

  test('ошибка чтения: статус read_error и имя файла в причине', async () => {
    putFile(deps, PR_2026, 'x');
    parser.failure = new DomainError('invalid_input', 'файл повреждён');
    const out = await run('Ромашка');
    const pr = out.registries.find((r) => r.entity === 'Прагматика');
    expect(pr?.status).toBe('read_error');
    expect(pr?.reason).toContain('ошибка чтения файла 2026 год Реестр заключенных договоров');
    expect(pr?.reason).toContain('файл повреждён');
    expect(out.instruction).toContain('Скажи об этом');
  });

  test('без парсера: ошибка чтения, а не пустой ответ', async () => {
    putFile(deps, PR_2026, 'x');
    delete deps.parser;
    const out = await run('Ромашка');
    expect(out.registries.find((r) => r.entity === 'Прагматика')?.status).toBe('read_error');
  });

  test('csv и имя в разложенной форме Юникода (NFD) читаются', async () => {
    deps.parser = new MemoryDocumentParser();
    const name = `${DIR}/2026 год Реестр заключенных договоров Мастер Гифтс.csv`.normalize('NFD');
    putFile(deps, name, '№,Контрагент\nМГ-2026-0001,ООО Тюльпан');
    const out = await run('тюльпан');
    expect(out.matches.length).toBe(1);
    expect(out.matches[0]?.entity).toBe('Мастер Гифтс');
  });

  test('запись на диск у инструмента невозможна: он не помечен побочным эффектом', () => {
    expect(searchContractRegistry.sideEffect).not.toBe(true);
  });
});
