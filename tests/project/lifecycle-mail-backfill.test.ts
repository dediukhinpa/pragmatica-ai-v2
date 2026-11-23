import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackfillReport } from '../../src/agents/suppliers/mail-backfill-report';
import {
  EXIT_ERROR,
  EXIT_INCOMPLETE,
  EXIT_OK,
  parseBackfillArgs,
  readReportFile,
  runBackfillCommand,
  textPathOf,
  writeReportFiles,
  type BackfillArgs,
  type BackfillCommandDeps,
} from '../../src/background-mail-backfill';
import { INN_ALPHA } from '../agents/suppliers-support';
import {
  SOURCE_ID,
  build,
  letter,
  otherLetter,
  seed,
  type World,
} from '../agents/suppliers-mail-backfill-support';
import { removeTempDirs, tempDir } from '@business-ai/testing';

afterAll(removeTempDirs);

/** Команда разового прохода по общему ящику (этап 220b): аргументы, файлы, вывод, коды. */

function parsed(argv: string[], defaults?: number, days?: number): BackfillArgs {
  const args = parseBackfillArgs(argv, defaults, days);
  if ('error' in args) throw new Error(args.error);
  return args;
}

describe('аргументы', () => {
  test('проход: отчёт обязателен, предел модели - аргумент важнее окружения', () => {
    expect(parsed(['--report', 'r.json'], 500)).toMatchObject({
      mode: 'scan',
      dryRun: false,
      reportPath: 'r.json',
      maxModelCalls: 500,
    });
    const full = parsed(
      ['--dry-run', '--report', 'r.json', '--address', 'a@b.test', '--max-model-calls', '5'],
      500,
    );
    expect(full).toMatchObject({
      dryRun: true,
      address: 'a@b.test',
      maxModelCalls: 5,
    });
  });

  test('окно: --days важнее значения по умолчанию, без него - значение из окружения', () => {
    expect(parsed(['--report', 'r.json'], 500).windowDays).toBeUndefined();
    expect(parsed(['--report', 'r.json'], 500, 730).windowDays).toBe(730);
    expect(parsed(['--report', 'r.json', '--days', '90'], 500, 730).windowDays).toBe(90);
    expect('error' in parseBackfillArgs(['--report', 'r.json', '--days', '0'], 500)).toBe(true);
  });

  test('применение: --apply с путём; пробный режим сочетается', () => {
    expect(parsed(['--apply', 'r.json'])).toMatchObject({ mode: 'apply', reportPath: 'r.json' });
    expect(parsed(['--dry-run', '--apply', 'r.json'])).toMatchObject({ dryRun: true });
  });

  test('перепроверка: --recheck с путём, с --dry-run сочетается, с --report нет', () => {
    expect(parsed(['--recheck', 'r.json'])).toMatchObject({
      mode: 'recheck',
      reportPath: 'r.json',
    });
    expect(parsed(['--dry-run', '--recheck', 'r.json'])).toMatchObject({ dryRun: true });
    for (const argv of [
      ['--recheck', 'r.json', '--report', 'r2.json'],
      ['--recheck', 'r.json', '--apply', 'r2.json'],
      ['--recheck', 'r.json', '--days', '3'],
    ]) {
      expect('error' in parseBackfillArgs(argv, undefined)).toBe(true);
    }
  });

  test('ошибки: без режима, неизвестное, пустое значение, нули, смесь режимов', () => {
    for (const argv of [
      [],
      ['--report'],
      ['--bogus'],
      ['--report', 'r.json', '--max-model-calls', '0'],
      ['--report', 'r.json', '--max-created', '2'],
      ['--apply', 'r.json', '--report', 'r2.json'],
      ['--apply', 'r.json', '--address', 'a@b.test'],
    ]) {
      expect('error' in parseBackfillArgs(argv, undefined)).toBe(true);
    }
  });

  test('читаемый вид лежит рядом с JSON', () => {
    expect(textPathOf('/x/report.json')).toBe('/x/report.txt');
    expect(textPathOf('/x/report')).toBe('/x/report.txt');
  });
});

describe('файлы отчёта', () => {
  test('права 600, JSON и читаемый вид, чтение обратно, чужой формат отклоняется', () => {
    const dir = tempDir();
    const path = join(dir, 'report.json');
    const report: BackfillReport = {
      version: 1,
      mailbox: SOURCE_ID,
      createdAt: 'a',
      updatedAt: 'b',
      items: [],
    };
    writeReportFiles(path, report);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(textPathOf(path)).mode & 0o777).toBe(0o600);
    expect(readReportFile(path)).toEqual(report);
    expect(readReportFile(join(dir, 'нет.json'))).toBeNull();
    expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
  });

  test('перезапись файла с правами 644: после записи снова 600 (ревью 220b)', () => {
    const dir = tempDir();
    const path = join(dir, 'report.json');
    writeFileSync(path, '{}');
    writeFileSync(textPathOf(path), 'x');
    chmodSync(path, 0o644);
    chmodSync(textPathOf(path), 0o644);
    writeReportFiles(path, {
      version: 1,
      mailbox: SOURCE_ID,
      createdAt: 'a',
      updatedAt: 'b',
      items: [],
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(textPathOf(path)).mode & 0o777).toBe(0o600);
  });

  test('испорченный файл: ошибка не цитирует содержимое', async () => {
    const path = join(tempDir(), 'bad.json');
    await Bun.write(path, '{"version":1,"items":"Иванов 7707083893"}');
    let message = '';
    try {
      readReportFile(path);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toBe('backfill_report_invalid');
  });
});

/** Команда на заглушках: «файлы» отчёта в памяти. */
function commandWorld(world: World, overrides: Partial<BackfillCommandDeps> = {}) {
  const files = new Map<string, BackfillReport>();
  const printed: string[] = [];
  const deps: BackfillCommandDeps = {
    scanDeps: (address) => ({ ...world.deps, sourceAddress: address }),
    applyDeps: { suppliers: world.suppliers, clock: world.clock, audit: world.audit },
    defaultAddress: 'info@company.test',
    ownCompanyRequisites: world.deps.ownCompanyRequisites,
    files: {
      read: (path) => structuredClone(files.get(path) ?? null),
      write: (path, report) => void files.set(path, structuredClone(report)),
    },
    ...overrides,
  };
  const run = (args: BackfillArgs) => runBackfillCommand(args, deps, (line) => printed.push(line));
  return { files, printed, run };
}

describe('выполнение команды', () => {
  test('проход: код 0, отчёт сохранён, вывод без ПДн', async () => {
    const world = build();
    await seed(world, {
      name: 'Старая Фирма',
      inn: INN_ALPHA,
      contacts: [{ email: 'office@vega-trade.test', isPrimary: true }],
    });
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1', { subject: 'Тема Иванова' }));
    world.mailboxes.deliverToSource(SOURCE_ID, otherLetter('m2', 'new-firm.test', 'Новая Фирма'));
    const command = commandWorld(world);
    const code = await command.run(parsed(['--report', 'r.json']));
    expect(code).toBe(EXIT_OK);
    expect(command.files.get('r.json')?.items.length).toBeGreaterThan(0);
    const output = command.printed.join('\n');
    expect(output).toContain('created: 1');
    expect(output).toContain('proposalLetters: 1');
    for (const secret of ['vega-trade', 'new-firm', INN_ALPHA, 'Иванов', 'Фирма', '@c']) {
      expect(output).not.toContain(secret);
    }
  });

  test('пробный запуск: карточек и отметок нет, печатается, сколько было бы создано', async () => {
    const world = build();
    world.mailboxes.deliverToSource(SOURCE_ID, otherLetter('m1', 'new-firm.test', 'Новая Фирма'));
    const command = commandWorld(world);
    const code = await command.run(parsed(['--dry-run', '--report', 'r.json']));
    expect(code).toBe(EXIT_OK);
    expect(command.printed.join('\n')).toContain('wouldCreate: 1');
    expect(await world.suppliers.searchCards({ limit: 10 })).toEqual([]);
  });

  test('предел модели: код 2, отчёт сохранён, повтор продолжает отчёт', async () => {
    const world = build();
    for (let i = 1; i <= 3; i += 1) {
      const host = `firm${i}.test`;
      world.mailboxes.deliverToSource(SOURCE_ID, otherLetter(`m${i}`, host, `Фирма ${i}`));
    }
    const command = commandWorld(world);
    const first = await command.run(parsed(['--report', 'r.json', '--max-model-calls', '2']));
    expect(first).toBe(EXIT_INCOMPLETE);
    expect(command.printed.join('\n')).toContain('повторите ту же команду');
    expect(command.files.get('r.json')?.run?.stoppedBy).toBe('model_limit');
    const second = await command.run(parsed(['--report', 'r.json', '--max-model-calls', '2']));
    expect(second).toBe(EXIT_OK);
    expect(await world.suppliers.searchCards({ limit: 10 })).toHaveLength(3);
  });

  test('пробный проход у предела модели не обещает продолжения (ревью 220b, п. 5)', async () => {
    const world = build();
    for (let i = 1; i <= 3; i += 1) {
      const host = `firm${i}.test`;
      world.mailboxes.deliverToSource(SOURCE_ID, otherLetter(`m${i}`, host, `Фирма ${i}`));
    }
    const command = commandWorld(world);
    const code = await command.run(
      parsed(['--dry-run', '--report', 'r.json', '--max-model-calls', '2']),
    );
    expect(code).toBe(EXIT_INCOMPLETE);
    const output = command.printed.join('\n');
    expect(output).not.toContain('повторите ту же команду');
    expect(output).toContain('пробный проход не продолжается');
    expect(output).toContain('--max-model-calls');
  });

  test('перепроверка: код 0, пробный режим отчёт не пишет', async () => {
    const world = build();
    await seed(world, {
      name: 'Старая Фирма',
      inn: INN_ALPHA,
      contacts: [{ email: 'office@vega-trade.test', isPrimary: true }],
    });
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    const command = commandWorld(world);
    await command.run(parsed(['--report', 'r.json']));
    const before = JSON.stringify(command.files.get('r.json'));
    command.printed.length = 0;
    expect(await command.run(parsed(['--dry-run', '--recheck', 'r.json']))).toBe(EXIT_OK);
    expect(JSON.stringify(command.files.get('r.json'))).toBe(before);
    expect(command.printed.join('\n')).toContain('reopened: 0');
    expect(await command.run(parsed(['--recheck', 'нет.json']))).toBe(EXIT_ERROR);
  });

  test('нет адреса, почты, реквизитов или ящика - ошибка без запуска модели', async () => {
    const world = build();
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    const args = parsed(['--report', 'r.json']);
    const cases: Array<Partial<BackfillCommandDeps>> = [
      { defaultAddress: undefined },
      { scanDeps: undefined },
      { ownCompanyRequisites: [] },
    ];
    for (const override of cases) {
      const command = commandWorld(world, override);
      expect(await command.run(args)).toBe(EXIT_ERROR);
    }
    // Адреса нет среди ящиков-источников (например, это ящик сотрудника): проход не стартует.
    const missing = commandWorld(world);
    const code = await missing.run(
      parsed(['--report', 'r.json', '--address', 'nobody@company.test']),
    );
    expect(code).toBe(EXIT_ERROR);
    expect(missing.printed.join('\n')).toContain('kind="source"');
    expect(world.classifier.calls).toBe(0);
  });

  test('применение: только подтверждённое, вывод без данных, статусы в отчёте', async () => {
    const world = build();
    const card = await seed(world, {
      name: 'Старая Фирма',
      inn: INN_ALPHA,
      contacts: [{ email: 'office@vega-trade.test', isPrimary: true }],
    });
    world.mailboxes.deliverToSource(SOURCE_ID, letter('m1'));
    const command = commandWorld(world);
    await command.run(parsed(['--report', 'r.json']));
    const report = command.files.get('r.json');
    const site = report?.items.find((item) => item.field === 'website');
    if (report === undefined || site === undefined) throw new Error('нет пункта');
    site.approved = true;
    command.files.set('r.json', report);
    command.printed.length = 0;
    expect(await command.run(parsed(['--apply', 'r.json']))).toBe(EXIT_OK);
    expect((await world.suppliers.getCard(card.id))?.website).toContain('vega-trade.test');
    expect(command.files.get('r.json')?.items.find((i) => i.id === site.id)?.status).toBe(
      'applied',
    );
    const output = command.printed.join('\n');
    expect(output).toContain('applied: 1');
    for (const secret of ['vega-trade', INN_ALPHA]) expect(output).not.toContain(secret);
  });

  test('применение: файла отчёта нет - ошибка', async () => {
    const command = commandWorld(build());
    expect(await command.run(parsed(['--apply', 'нет.json']))).toBe(EXIT_ERROR);
  });
});
