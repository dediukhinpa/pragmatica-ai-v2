import { describe, expect, test } from 'bun:test';
import type {
  SupplierCrmSyncOptions,
  SupplierCrmSyncResult,
} from '../../src/agents/suppliers/crm-sync';
import {
  EXIT_ERROR,
  EXIT_INCOMPLETE,
  EXIT_OK,
  crmSyncTextPath,
  parseCrmSyncArgs,
  runCrmSyncCommand,
} from '../../src/background-crm-sync';

/** Разовая команда прохода по CRM (этап 243): аргументы, коды выхода, вывод без данных. */

const RESULT: SupplierCrmSyncResult = {
  dryRun: false,
  stoppedBy: 'none',
  needsReview: ['10'],
  passes: 'category-8+companyType-SUPPLIER',
  scanned: 3,
  replayed: 0,
  markerMismatch: 0,
  created: 1,
  enriched: 1,
  unchanged: 1,
  ambiguous: 0,
  skippedOwn: 0,
  noName: 0,
  rejected: 0,
  linkReset: 0,
  linkMismatch: 0,
  conflicts: 0,
  duplicates: 0,
};

describe('parseCrmSyncArgs', () => {
  test('минимум: --report; предела по умолчанию нет', () => {
    expect(parseCrmSyncArgs(['--report', '/r/a.json'])).toEqual({
      dryRun: false,
      reportPath: '/r/a.json',
      maxCompanies: undefined,
      pageSize: undefined,
      pauseMs: undefined,
    });
  });

  test('все параметры', () => {
    expect(
      parseCrmSyncArgs([
        '--dry-run',
        '--report',
        '/r/a.json',
        '--max-companies',
        '50',
        '--page-size',
        '25',
        '--pause-ms',
        '0',
      ]),
    ).toMatchObject({ dryRun: true, maxCompanies: 50, pageSize: 25, pauseMs: 0 });
  });

  test('ошибки: нет отчёта, неизвестный аргумент, не число, нет значения', () => {
    for (const argv of [
      [],
      ['--dry-run'],
      ['--report', 'a.json', '--unknown'],
      ['--report', 'a.json', '--max-companies', '0'],
      ['--report', 'a.json', '--max-companies', 'x'],
      ['--report', 'a.json', '--page-size'],
      ['--report', 'a.json', '--pause-ms', '-1'],
    ]) {
      expect(parseCrmSyncArgs(argv)).toHaveProperty('error');
    }
  });

  test('читаемый вид рядом с JSON', () => {
    expect(crmSyncTextPath('/r/a.json')).toBe('/r/a.txt');
    expect(crmSyncTextPath('/r/a')).toBe('/r/a.txt');
  });
});

describe('runCrmSyncCommand', () => {
  async function run(result: SupplierCrmSyncResult, argv: string[] = ['--report', 'a.json']) {
    const args = parseCrmSyncArgs(argv);
    if ('error' in args) throw new Error(args.error);
    const printed: string[] = [];
    const written: SupplierCrmSyncResult[] = [];
    const seen: SupplierCrmSyncOptions[] = [];
    const code = await runCrmSyncCommand(
      args,
      {
        run: async (options) => {
          seen.push(options);
          return result;
        },
        write: (_path, value) => written.push(value),
      },
      (line) => printed.push(line),
    );
    return { code, printed, written, seen };
  }

  test('конец списка: код 0, отчёт записан, в stdout только счётчики', async () => {
    const { code, printed, written } = await run(RESULT);
    expect(code).toBe(EXIT_OK);
    expect(written).toEqual([RESULT]);
    expect(printed.join('\n')).toContain('created: 1');
    expect(printed.join('\n')).not.toContain('"10"');
  });

  test('предел не передаётся, если не задан; задан - передаётся', async () => {
    expect((await run(RESULT)).seen[0]).toEqual({ dryRun: false });
    const limited = await run(RESULT, ['--report', 'a.json', '--max-companies', '7']);
    expect(limited.seen[0]).toEqual({ dryRun: false, maxCompanies: 7 });
  });

  test('остановка по пределу: код 2; нет прав: код 1', async () => {
    expect((await run({ ...RESULT, stoppedBy: 'limit' })).code).toBe(EXIT_INCOMPLETE);
    expect((await run({ ...RESULT, stoppedBy: 'budget' })).code).toBe(EXIT_INCOMPLETE);
    expect((await run({ ...RESULT, stoppedBy: 'access_denied' })).code).toBe(EXIT_ERROR);
  });
});
