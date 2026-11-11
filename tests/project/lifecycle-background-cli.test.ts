import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { removeTempDirs, tempDir } from '@business-ai/testing';
import type { SupplierCrmSyncResult } from '../../src/agents/suppliers/crm-sync';
import {
  BACKGROUND_COMMAND_NAMES,
  runBackgroundCommand,
  type BackgroundCommandEnv,
} from '../../src/background-cli';
import { EXIT_ERROR, EXIT_OK } from '../../src/background-crm-sync';
import type { BackgroundCommands } from '../../src/background-wiring';

afterAll(removeTempDirs);

/**
 * Запуск разовых команд владельца из проекта: имя команды -> разбор аргументов -> команда с
 * зависимостями приложения; в SRC это были три отдельные точки входа (`src/mail-info-backfill.ts`,
 * `src/mail-trust-survey.ts`, `src/crm-suppliers-sync.ts`) без расписания и флага включения.
 */

const REPORT_MODE = 0o600;

const NOTHING: BackgroundCommands = {
  mailBackfill: {
    scanDeps: undefined,
    applyDeps: {} as BackgroundCommands['mailBackfill']['applyDeps'],
    defaultAddress: undefined,
    maxModelCalls: undefined,
    windowDays: undefined,
    ownCompanyRequisites: [],
  },
  mailSurvey: () => undefined,
};

const EMPTY_RESULT: SupplierCrmSyncResult = {
  dryRun: false,
  stoppedBy: 'none',
  needsReview: [],
  passes: 'category-8',
  scanned: 0,
  replayed: 0,
  markerMismatch: 0,
  created: 0,
  enriched: 0,
  unchanged: 0,
  ambiguous: 0,
  skippedOwn: 0,
  noName: 0,
  rejected: 0,
  linkReset: 0,
  linkMismatch: 0,
  conflicts: 0,
  duplicates: 0,
};

const ENV: BackgroundCommandEnv = {
  bitrix24Configured: true,
  ownCompanyRequisitesConfigured: true,
};

async function run(
  argv: string[],
  commands: BackgroundCommands = NOTHING,
  env: BackgroundCommandEnv = ENV,
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const [name = '', ...rest] = argv;
  const code = await runBackgroundCommand(name, rest, commands, env, (line) => lines.push(line));
  return { code, lines };
}

describe('диспетчер разовых команд', () => {
  test('известны три команды прежних точек входа', () => {
    expect([...BACKGROUND_COMMAND_NAMES].sort()).toEqual([
      'crm-suppliers-sync',
      'mail-info-backfill',
      'mail-trust-survey',
    ]);
  });

  test('неизвестная команда: подсказка со списком, код ошибки', async () => {
    const { code, lines } = await run(['nope']);
    expect(code).toBe(EXIT_ERROR);
    expect(lines.join('\n')).toContain('mail-info-backfill');
  });

  test('ошибка аргументов называется, а команда не запускается', async () => {
    const { code, lines } = await run(['mail-info-backfill']);
    expect(code).toBe(EXIT_ERROR);
    expect(lines.join('\n')).toContain('--report');
  });
});

describe('проход по общему ящику', () => {
  test('почта не подключена - проход не стартует', async () => {
    const { code, lines } = await run(['mail-info-backfill', '--report', 'r.json']);
    expect(code).toBe(EXIT_ERROR);
    expect(lines.join('\n')).toContain('не задан адрес ящика');
  });

  test('адрес из настройки по умолчанию, без почты - "не подключена"', async () => {
    const commands: BackgroundCommands = {
      ...NOTHING,
      mailBackfill: { ...NOTHING.mailBackfill, defaultAddress: 'info@company.test' },
    };
    const { code, lines } = await run(['mail-info-backfill', '--report', 'r.json'], commands);
    expect(code).toBe(EXIT_ERROR);
    expect(lines.join('\n')).toContain('почта не подключена');
  });

  test('применение: отчёта нет - ошибка без обращения к ящику', async () => {
    const path = join(tempDir(), 'нет.json');
    const { code, lines } = await run(['mail-info-backfill', '--apply', path]);
    expect(code).toBe(EXIT_ERROR);
    expect(lines).toEqual(['файл отчёта не найден']);
  });
});

describe('обследование доверия', () => {
  test('почта не подключена - сообщение и код ошибки', async () => {
    const { code, lines } = await run(['mail-trust-survey']);
    expect(code).toBe(EXIT_ERROR);
    expect(lines.join('\n')).toContain('Почта не подключена');
  });

  test('зависимости собираются один раз на запуск и только для этой команды', async () => {
    let built = 0;
    const commands: BackgroundCommands = {
      ...NOTHING,
      mailSurvey: () => {
        built += 1;
        return undefined;
      },
    };
    await run(['mail-info-backfill', '--apply', join(tempDir(), 'нет.json')], commands);
    expect(built).toBe(0);
    await run(['mail-trust-survey'], commands);
    expect(built).toBe(1);
  });
});

describe('проход по CRM', () => {
  test('нет вебхука портала или реквизитов - переменные названы, код ошибки', async () => {
    const env = { bitrix24Configured: false, ownCompanyRequisitesConfigured: false };
    const { code, lines } = await run(['crm-suppliers-sync', '--report', 'r.json'], NOTHING, env);
    expect(code).toBe(EXIT_ERROR);
    expect(lines.join('\n')).toContain('BITRIX24_WEBHOOK_URL, OWN_COMPANY_REQUISITES');
  });

  test('порта компаний CRM нет в сборке - "портал CRM-поставщиков не собран"', async () => {
    const { code, lines } = await run(['crm-suppliers-sync', '--report', 'r.json']);
    expect(code).toBe(EXIT_ERROR);
    expect(lines).toEqual(['портал CRM-поставщиков не собран']);
  });

  test('проход получает аргументы, отчёт пишется с правами 600', async () => {
    const dir = tempDir();
    const report = join(dir, 'crm.json');
    const calls: unknown[] = [];
    const commands: BackgroundCommands = {
      ...NOTHING,
      crmPass: {
        run: async (options) => {
          calls.push(options);
          return EMPTY_RESULT;
        },
      },
    };
    const argv = ['crm-suppliers-sync', '--dry-run', '--report', report, '--max-companies', '5'];
    const { code } = await run(argv, commands);
    expect(code).toBe(EXIT_OK);
    expect(calls).toEqual([{ dryRun: true, maxCompanies: 5 }]);
    expect(existsSync(report)).toBe(true);
    expect(statSync(report).mode & 0o777).toBe(REPORT_MODE);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({ stoppedBy: 'none' });
  });
});
