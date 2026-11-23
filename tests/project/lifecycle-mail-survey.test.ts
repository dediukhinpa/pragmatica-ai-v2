import { describe, expect, test } from 'bun:test';
import { FixedClock, MemoryMailboxDirectory } from '@business-ai/adapters';
import { MemorySupplierRepository } from '../../src/kit/adapters/memory/repositories.owned';
import {
  EXIT_ERROR,
  EXIT_OK,
  SURVEY_DEFAULT_MAX_MESSAGES,
  parseSurveyArgs,
  runSurveyCommand,
  type SurveyArgs,
} from '../../src/background-mail-survey';

/** Команда-обследование доверия (этап 233): аргументы, вывод, коды выхода. */

function parsed(argv: string[]): SurveyArgs {
  const args = parseSurveyArgs(argv);
  if ('error' in args) throw new Error(args.error);
  return args;
}

describe('аргументы обследования', () => {
  test('по умолчанию окно два года, все ящики, читаемый вывод', () => {
    expect(parsed([])).toEqual({
      windowDays: 730,
      maxMessagesPerMailbox: SURVEY_DEFAULT_MAX_MESSAGES,
      maxMinutesPerMailbox: 30,
      scope: 'all',
      json: false,
    });
  });

  test('все параметры', () => {
    const argv = ['--days', '183', '--max-messages', '500', '--max-minutes', '5'];
    expect(parsed([...argv, '--scope', 'sources', '--json'])).toEqual({
      windowDays: 183,
      maxMessagesPerMailbox: 500,
      maxMinutesPerMailbox: 5,
      scope: 'sources',
      json: true,
    });
  });

  test('ошибки: неизвестное, без значения, не число, неверная область', () => {
    for (const argv of [
      ['--nope'],
      ['--days'],
      ['--days', '0'],
      ['--days', 'abc'],
      ['--max-messages', '-3'],
      ['--scope', 'everything'],
    ]) {
      expect('error' in parseSurveyArgs(argv)).toBe(true);
    }
  });
});

describe('запуск обследования', () => {
  test('почта не подключена: сообщение и код ошибки', async () => {
    const lines: string[] = [];
    const code = await runSurveyCommand(parsed([]), undefined, (line) => lines.push(line));
    expect(code).toBe(EXIT_ERROR);
    expect(lines.join('\n')).toContain('Почта не подключена');
  });

  test('обследование пустых ящиков: код 0, JSON и текст без данных', async () => {
    const clock = new FixedClock(new Date('2026-11-08T09:00:00.000Z'));
    const mailboxes = new MemoryMailboxDirectory();
    mailboxes.connect('emp-1', 'one@company.test');
    const deps = {
      suppliers: new MemorySupplierRepository(() => clock.now().toISOString()),
      mailboxes,
      clock,
      ownCompanyRequisites: [],
    };
    const text: string[] = [];
    expect(await runSurveyCommand(parsed([]), deps, (line) => text.push(line))).toBe(EXIT_OK);
    expect(text.join('\n')).toContain('Ящики сотрудников');
    const json: string[] = [];
    await runSurveyCommand(parsed(['--json']), deps, (line) => json.push(line));
    expect(JSON.parse(json.join('\n')).groups[0]).toMatchObject({ group: 'employees', total: 0 });
    expect(json.join('')).not.toContain('company.test');
  });
});
