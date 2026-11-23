import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { e2eEnv, requireEnv } from './project-env';

/** Листы книги: название листа -> строки (значения ячеек строкой, пустая ячейка - ''). */
export type WorkbookDump = Record<string, string[][]>;

/** Предел вывода чтения книги: до 64 МиБ JSON (байт). */
const DUMP_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Сигнатура zip-контейнера (xlsx - это zip): первые байты файла. */
export const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04] as const;

const DUMP_SCRIPT = [
  'import json, sys',
  'from openpyxl import load_workbook',
  'book = load_workbook(sys.argv[1], read_only=True, data_only=True)',
  'dump = {}',
  'for sheet in book.worksheets:',
  '    rows = []',
  '    for row in sheet.iter_rows(values_only=True):',
  '        rows.append(["" if cell is None else str(cell) for cell in row])',
  '    dump[sheet.title] = rows',
  'print(json.dumps(dump, ensure_ascii=False))',
].join('\n');

let dumpCounter = 0;

/** Начинается ли файл с сигнатуры zip (xlsx, docx). */
export function isZip(bytes: Uint8Array): boolean {
  return ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * Содержимое xlsx по листам: файл читает openpyxl из окружения сервиса documents (`-I`: без
 * подхвата кода из текущего каталога). Файл и скрипт лежат в рабочем каталоге прогона.
 */
export async function dumpWorkbook(bytes: Uint8Array): Promise<WorkbookDump> {
  const out = `${e2eEnv().work}/out`;
  dumpCounter += 1;
  const target = `${out}/r-dump-${dumpCounter}.xlsx`;
  const scriptPath = `${out}/r-dump.py`;
  await writeFile(target, bytes);
  await writeFile(scriptPath, DUMP_SCRIPT, 'utf8');
  const python = `${requireEnv('E2E_ROOT')}/services/documents/.venv/bin/python`;
  const result = spawnSync(python, ['-I', scriptPath, target], {
    encoding: 'utf8',
    maxBuffer: DUMP_MAX_BUFFER_BYTES,
  });
  if (result.status !== 0) throw new Error(`чтение xlsx не удалось: ${result.stderr}`);
  const parsed: unknown = JSON.parse(result.stdout);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('openpyxl вернул не объект');
  return parsed as WorkbookDump;
}

/** Все строки листа одной строкой на строку (ячейки через « | »): удобно искать подстроки. */
export function sheetLines(dump: WorkbookDump, sheet: string): string[] {
  const rows = dump[sheet];
  // Молчаливая подстановка пустого листа скрыла бы опечатку в названии листа.
  if (rows === undefined) throw new Error(`в книге нет листа «${sheet}»`);
  return rows.map((row) => row.join(' | '));
}
