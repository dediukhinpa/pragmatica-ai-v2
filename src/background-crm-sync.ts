import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  SupplierCrmSyncOptions,
  SupplierCrmSyncResult,
} from './agents/suppliers/crm-sync';

/**
 * Разовая команда прохода по компаниям CRM (этап 243): разбор аргументов, файл отчёта и вывод;
 * сборка зависимостей - в `src/background-wiring.ts`, запуск - `src/background-cli.ts`.
 * Расписания у прохода нет. В stdout и журнал идут только счётчики и id компаний CRM
 * (названия, ИНН и контакты - нет).
 */

/** Права файла отчёта: владелец читает id компаний, остальным он не нужен. */
const REPORT_FILE_MODE = 0o600;
/** Коды выхода: 0 - всё сделано, 1 - ошибка, 2 - остановка до конца списка, повторить запуск. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_INCOMPLETE = 2;
const JSON_EXTENSION = '.json';
const TEXT_EXTENSION = '.txt';
const INDENT = 2;

/** Разобранная командная строка. */
export interface CrmSyncArgs {
  dryRun: boolean;
  reportPath: string;
  /** Не задан - без суточной квоты: до конца списка. */
  maxCompanies: number | undefined;
  pageSize: number | undefined;
  pauseMs: number | undefined;
}

const USAGE =
  'использование: crm-suppliers-sync [--dry-run] --report <файл.json> ' +
  '[--max-companies N] [--page-size N] [--pause-ms N]';

function numberFlag(value: string, name: string, min: number): number | { error: string } {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) {
    return { error: `${name} требует целое число не меньше ${String(min)}` };
  }
  return number;
}

/** Разбор аргументов. Ошибка - текст для пользователя (без данных). */
export function parseCrmSyncArgs(argv: readonly string[]): CrmSyncArgs | { error: string } {
  let dryRun = false;
  let report: string | undefined;
  let maxCompanies: number | undefined;
  let pageSize: number | undefined;
  let pauseMs: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (!['--report', '--max-companies', '--page-size', '--pause-ms'].includes(arg)) {
      return { error: `неизвестный аргумент: ${arg}. ${USAGE}` };
    }
    const value = argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      return { error: `${arg} требует значение. ${USAGE}` };
    }
    index += 1;
    if (arg === '--report') {
      report = value;
      continue;
    }
    const parsed = numberFlag(value, arg, arg === '--pause-ms' ? 0 : 1);
    if (typeof parsed !== 'number') return parsed;
    if (arg === '--max-companies') maxCompanies = parsed;
    else if (arg === '--page-size') pageSize = parsed;
    else pauseMs = parsed;
  }
  if (report === undefined) return { error: `не указан --report. ${USAGE}` };
  return { dryRun, reportPath: report, maxCompanies, pageSize, pauseMs };
}

/** Путь читаемого вида рядом с JSON-файлом: `отчёт.json` -> `отчёт.txt`. */
export function crmSyncTextPath(reportPath: string): string {
  return reportPath.endsWith(JSON_EXTENSION)
    ? `${reportPath.slice(0, -JSON_EXTENSION.length)}${TEXT_EXTENSION}`
    : `${reportPath}${TEXT_EXTENSION}`;
}

/** Строки итога: только счётчики и коды. */
export function formatCrmSyncResult(result: SupplierCrmSyncResult): string[] {
  const { dryRun, stoppedBy, needsReview, ...counters } = result;
  return [
    dryRun
      ? 'Пробный запуск: карточки, связи и заметки не пишутся (created/enriched - «было бы»)'
      : 'Запуск с записью: карточки заводятся и дополняются',
    `Остановка: ${stoppedBy}`,
    ...Object.entries(counters).map(([name, value]) => `  ${name}: ${String(value)}`),
    `  needsReview: ${String(needsReview.length)}`,
  ];
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, text, { mode: REPORT_FILE_MODE });
  renameSync(temp, path);
}

/** Записать отчёт (JSON и читаемый вид) атомарно, с правами 600. */
export function writeCrmSyncReport(path: string, result: SupplierCrmSyncResult): void {
  writeAtomic(path, `${JSON.stringify(result, null, INDENT)}\n`);
  const review =
    result.needsReview.length === 0
      ? ['Решения человека не требуются.']
      : [
          'Компании CRM, которые решает человек (id):',
          ...result.needsReview.map((id) => `  ${id}`),
        ];
  writeAtomic(crmSyncTextPath(path), [...formatCrmSyncResult(result), ...review, ''].join('\n'));
}

/** Зависимости команды. */
export interface CrmSyncCommandDeps {
  run: (options: SupplierCrmSyncOptions) => Promise<SupplierCrmSyncResult>;
  write?: (path: string, result: SupplierCrmSyncResult) => void;
}

/** Выполнить проход, сохранить отчёт, вывести итог. Возвращает код выхода. */
export async function runCrmSyncCommand(
  args: CrmSyncArgs,
  deps: CrmSyncCommandDeps,
  print: (line: string) => void,
): Promise<number> {
  const result = await deps.run({
    dryRun: args.dryRun,
    ...(args.maxCompanies === undefined ? {} : { maxCompanies: args.maxCompanies }),
    ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }),
    ...(args.pauseMs === undefined ? {} : { pauseMs: args.pauseMs }),
  });
  (deps.write ?? writeCrmSyncReport)(args.reportPath, result);
  for (const line of formatCrmSyncResult(result)) print(line);
  if (result.stoppedBy === 'none') return EXIT_OK;
  if (result.stoppedBy === 'access_denied') {
    print('Нет прав вебхука на CRM (нужно право crm): проход не закончен');
    return EXIT_ERROR;
  }
  print(
    'Остановка раньше конца списка: повторный запуск безопасен (дублей не будет), ' +
      'он читает список с начала.',
  );
  return EXIT_INCOMPLETE;
}
