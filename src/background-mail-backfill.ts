import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  applyBackfillReport,
  recheckBackfillReport,
  type BackfillApplyDeps,
  type BackfillApplyResult,
  type BackfillRecheckResult,
} from './agents/suppliers/mail-backfill-apply';
import {
  parseBackfillReport,
  renderBackfillReport,
  type BackfillReport,
} from './agents/suppliers/mail-backfill-report';
import {
  runSupplierMailBackfill,
  type SupplierMailBackfillResult,
  type SupplierMailEnrichDeps,
} from './agents/suppliers/mail-enrich';

/**
 * Разовая команда по общему ящику (этап 220b): разбор всех писем и применение подтверждённых
 * пунктов отчёта. Здесь - разбор аргументов, файлы отчёта и вывод; сборка зависимостей - в
 * `src/background-wiring.ts`, запуск - `src/background-cli.ts`. Вывод и журнал без ПДн:
 * счётчики и номера пунктов; ПДн лежат только в файле отчёта (права 600, вне репозитория).
 */

/** Права файлов отчёта: в них контакты и ФИО из писем, читать должен только владелец. */
const REPORT_FILE_MODE = 0o600;
/** Коды выхода: 0 - всё сделано, 1 - ошибка, 2 - остановка по пределу, нужен повторный запуск. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_INCOMPLETE = 2;
const JSON_EXTENSION = '.json';
const TEXT_EXTENSION = '.txt';
const INDENT = 2;

/** Разобранная командная строка. */
export interface BackfillArgs {
  /**
   * `scan` - проход по ящику, `apply` - применение подтверждённых пунктов отчёта, `recheck` -
   * возврат пропущенных `card_changed` пунктов на повторное подтверждение (ящик не читается).
   */
  mode: 'scan' | 'apply' | 'recheck';
  dryRun: boolean;
  reportPath: string;
  address: string | undefined;
  maxModelCalls: number | undefined;
  /** Окно прохода, дней; не задано - значение по умолчанию движка (два года). */
  windowDays: number | undefined;
}

const USAGE =
  'использование: mail-info-backfill [--dry-run] --report <файл.json> [--address <адрес>] ' +
  '[--max-model-calls N] [--days N] | [--dry-run] --apply <файл.json> | ' +
  '[--dry-run] --recheck <файл.json>';

function positiveFlag(value: string | undefined, name: string): number | { error: string } {
  const number = Number(value);
  if (value === undefined || !Number.isInteger(number) || number < 1) {
    return { error: `${name} требует целое число больше нуля` };
  }
  return number;
}

/**
 * Разбор аргументов. Предел обращений к модели: аргумент, иначе `defaultMaxModelCalls` (из
 * окружения). Ошибка - текст для пользователя (без данных).
 */
export function parseBackfillArgs(
  argv: readonly string[],
  defaultMaxModelCalls: number | undefined,
  defaultWindowDays?: number,
): BackfillArgs | { error: string } {
  let dryRun = false;
  let report: string | undefined;
  let apply: string | undefined;
  let recheck: string | undefined;
  let address: string | undefined;
  let maxModelCalls = defaultMaxModelCalls;
  let windowDays = defaultWindowDays;
  let limitGiven = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const value = argv[index + 1];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    const known = ['--report', '--apply', '--recheck', '--address', '--max-model-calls'];
    if (![...known, '--days'].includes(arg)) {
      return { error: `неизвестный аргумент: ${arg}. ${USAGE}` };
    }
    if (value === undefined || value === '' || value.startsWith('--')) {
      return { error: `${arg} требует значение. ${USAGE}` };
    }
    index += 1;
    if (arg === '--report') report = value;
    else if (arg === '--apply') apply = value;
    else if (arg === '--recheck') recheck = value;
    else if (arg === '--address') address = value;
    else {
      const parsed = positiveFlag(value, arg);
      if (typeof parsed !== 'number') return parsed;
      limitGiven = true;
      if (arg === '--max-model-calls') maxModelCalls = parsed;
      else windowDays = parsed;
    }
  }
  const single = apply ?? recheck;
  if (single !== undefined) {
    // Применение и перепроверка работают только с файлом отчёта: ящик и модель не нужны.
    const otherMode = apply !== undefined && recheck !== undefined;
    if (report !== undefined || address !== undefined || limitGiven || otherMode) {
      return { error: `--apply и --recheck не сочетаются с другими режимами. ${USAGE}` };
    }
    return {
      mode: apply !== undefined ? 'apply' : 'recheck',
      dryRun,
      reportPath: single,
      address,
      maxModelCalls,
      windowDays,
    };
  }
  if (report === undefined) return { error: `не указан --report. ${USAGE}` };
  return {
    mode: 'scan',
    dryRun,
    reportPath: report,
    address,
    maxModelCalls,
    windowDays,
  };
}

/** Путь читаемого вида рядом с JSON-файлом: `отчёт.json` -> `отчёт.txt`. */
export function textPathOf(reportPath: string): string {
  return reportPath.endsWith(JSON_EXTENSION)
    ? `${reportPath.slice(0, -JSON_EXTENSION.length)}${TEXT_EXTENSION}`
    : `${reportPath}${TEXT_EXTENSION}`;
}

/** Прочитать отчёт; файла нет - `null`. Испорченный файл - ошибка без цитат из него. */
export function readReportFile(path: string): BackfillReport | null {
  if (!existsSync(path)) return null;
  return parseBackfillReport(readFileSync(path, 'utf8'));
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, text, { mode: REPORT_FILE_MODE });
  renameSync(temp, path);
}

/** Записать отчёт (JSON и читаемый вид) атомарно, с правами 600. */
export function writeReportFiles(path: string, report: BackfillReport): void {
  writeAtomic(path, `${JSON.stringify(report, null, INDENT)}\n`);
  writeAtomic(textPathOf(path), renderBackfillReport(report));
}

/** Строки итога прохода: только счётчики и коды. */
function formatScanResult(result: SupplierMailBackfillResult, dryRun: boolean): string[] {
  const { status, stoppedBy, ...counters } = result;
  const lines = [
    dryRun
      ? 'Пробный запуск: карточки, отметки писем и курсор не пишутся'
      : 'Запуск с записью: новые поставщики заводятся карточками',
    `Итог: ${status}, остановка: ${stoppedBy}`,
    ...Object.entries(counters).map(([name, value]) => `  ${name}: ${String(value)}`),
  ];
  if (stoppedBy !== 'none' && dryRun) {
    // Пробный запуск не пишет ни курсор, ни отметки: повтор начнёт с начала ящика и упрётся в тот
    // же предел. Обещать продолжение нельзя.
    lines.push(
      'Остановка раньше конца ящика: пробный проход не продолжается с места остановки ' +
        '(курсор и отметки не пишутся), повтор начнёт с начала и остановится там же. ' +
        'Увеличьте --max-model-calls либо запустите проход с записью, ' +
        'без --dry-run: он продолжится с места остановки. Отчёт сохранён.',
    );
  } else if (stoppedBy !== 'none') {
    lines.push(
      'Проход остановлен до конца ящика: повторите ту же команду, она продолжит с необработанных ' +
        'писем (разобранные закрыты отметками). Отчёт сохранён.',
    );
  }
  return lines;
}

/** Строки итога применения: счётчики и номера пунктов (хэши), без данных. */
function formatApplyResult(result: BackfillApplyResult, dryRun: boolean): string[] {
  const { items, ...counters } = result;
  return [
    dryRun ? 'Пробное применение: ничего не пишется' : 'Применение подтверждённых пунктов',
    ...Object.entries(counters).map(([name, value]) => `  ${name}: ${String(value)}`),
    ...items.map((item) => {
      const reason = item.reason === undefined ? '' : ` (${item.reason})`;
      return `  пункт ${item.id}: ${item.status}${reason}`;
    }),
  ];
}

/** Строки итога перепроверки: только счётчики. */
function formatRecheckResult(result: BackfillRecheckResult, dryRun: boolean): string[] {
  return [
    dryRun ? 'Пробная перепроверка: отчёт не меняется' : 'Перепроверка пропущенных пунктов',
    ...Object.entries(result).map(([name, value]) => `  ${name}: ${String(value)}`),
    'Вернувшиеся пункты ждут нового подтверждения ("approved": true) и запуска --apply.',
  ];
}

/** Что нужно команде от окружения. */
export interface BackfillCommandDeps {
  /** Зависимости прохода по ящику; нет - почта не подключена. */
  scanDeps?: ((address: string) => SupplierMailEnrichDeps) | undefined;
  applyDeps: BackfillApplyDeps;
  /** Адрес по умолчанию (`INFO_MAILBOX_ENRICH_ADDRESS`). */
  defaultAddress: string | undefined;
  /** Реквизиты наших юрлиц (`OWN_COMPANY_REQUISITES`): без них проход не стартует. */
  ownCompanyRequisites: readonly string[];
  /** Файлы отчёта; в тестах подменяются. */
  files?: {
    read(path: string): BackfillReport | null;
    write(path: string, report: BackfillReport): void;
  };
}

/** Выполнить команду. Возвращает код выхода; вывод - построчно в `print`. */
export async function runBackfillCommand(
  args: BackfillArgs,
  deps: BackfillCommandDeps,
  print: (line: string) => void,
): Promise<number> {
  const files = deps.files ?? { read: readReportFile, write: writeReportFiles };
  if (args.mode === 'apply') return runApply(args, deps, files, print);
  if (args.mode === 'recheck') return runRecheck(args, deps, files, print);
  const address = args.address ?? deps.defaultAddress;
  if (address === undefined) {
    print('не задан адрес ящика: INFO_MAILBOX_ENRICH_ADDRESS или --address');
    return EXIT_ERROR;
  }
  if (deps.scanDeps === undefined) {
    print('почта не подключена (нужны EMPLOYEE_MAILBOX_ENABLED и файл ящиков)');
    return EXIT_ERROR;
  }
  if (deps.ownCompanyRequisites.length === 0) {
    // Без реквизитов наши данные из писем нечем отсеять: проход не запускается.
    print('не заданы OWN_COMPANY_REQUISITES: проход не запускается');
    return EXIT_ERROR;
  }
  const enrichDeps = deps.scanDeps(address);
  const result = await runSupplierMailBackfill(enrichDeps, {
    dryRun: args.dryRun,
    report: files.read(args.reportPath),
    onReport: async (next) => files.write(args.reportPath, next),
    maxModelCalls: args.maxModelCalls,
    windowDays: args.windowDays,
  });
  for (const line of formatScanResult(result, args.dryRun)) print(line);
  if (result.status === 'not_configured') {
    print('ящика-источника с таким адресом нет (нужна запись kind="source" в файле ящиков)');
    return EXIT_ERROR;
  }
  print(`отчёт: ${args.reportPath}`);
  return result.stoppedBy === 'none' ? EXIT_OK : EXIT_INCOMPLETE;
}

async function runApply(
  args: BackfillArgs,
  deps: BackfillCommandDeps,
  files: NonNullable<BackfillCommandDeps['files']>,
  print: (line: string) => void,
): Promise<number> {
  const report = files.read(args.reportPath);
  if (report === null) {
    print('файл отчёта не найден');
    return EXIT_ERROR;
  }
  try {
    const result = await applyBackfillReport(report, deps.applyDeps, { dryRun: args.dryRun });
    for (const line of formatApplyResult(result, args.dryRun)) print(line);
  } finally {
    // Статусы уже применённых пунктов сохраняются и при сбое посреди применения.
    if (!args.dryRun) {
      report.updatedAt = deps.applyDeps.clock.now().toISOString();
      files.write(args.reportPath, report);
    }
  }
  return EXIT_OK;
}

async function runRecheck(
  args: BackfillArgs,
  deps: BackfillCommandDeps,
  files: NonNullable<BackfillCommandDeps['files']>,
  print: (line: string) => void,
): Promise<number> {
  const report = files.read(args.reportPath);
  if (report === null) {
    print('файл отчёта не найден');
    return EXIT_ERROR;
  }
  const result = await recheckBackfillReport(report, deps.applyDeps, { dryRun: args.dryRun });
  for (const line of formatRecheckResult(result, args.dryRun)) print(line);
  if (!args.dryRun) {
    report.updatedAt = deps.applyDeps.clock.now().toISOString();
    files.write(args.reportPath, report);
  }
  return EXIT_OK;
}
