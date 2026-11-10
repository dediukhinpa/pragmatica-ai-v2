import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import {
  SUPPLIER_TEMPLATE_COLUMNS,
  type SupplierColumnKey,
} from '../../src/agents/suppliers/supplier-template';
import { e2eEnv, requireEnv } from './project-env';

/** Весовые коэффициенты контрольной суммы ИНН юрлица (10 цифр). */
const INN10_WEIGHTS = [2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const INN_MODULUS = 11;
const DIGIT_MODULUS = 10;

/** Валидный ИНН юрлица из первых девяти цифр. */
export function makeInn(base9: string): string {
  const sum = INN10_WEIGHTS.reduce((acc, weight, i) => acc + weight * Number(base9[i]), 0);
  return `${base9}${(sum % INN_MODULUS) % DIGIT_MODULUS}`;
}

/** Тот же ИНН с испорченной последней цифрой: контрольная сумма не сходится. */
export function breakInn(inn: string): string {
  const last = Number(inn.at(-1));
  return `${inn.slice(0, -1)}${(last + 1) % DIGIT_MODULUS}`;
}

/** Строка файла поставщиков: значения по ключам колонок шаблона. */
export type TemplateRow = Partial<Record<SupplierColumnKey, string>>;

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const FILL_SCRIPT = [
  'import json, sys',
  'from openpyxl import load_workbook',
  'template, target, rows_path = sys.argv[1:4]',
  'book = load_workbook(template)',
  'sheet = book["Поставщики"]',
  'for row in json.load(open(rows_path, encoding="utf-8")):',
  '    sheet.append(row)',
  'book.save(target)',
].join('\n');

let batchCounter = 0;

/** Путь к файлу-шаблону поставщиков в репозитории. */
export function supplierTemplatePath(): string {
  return `${requireEnv('E2E_PROJECT_ROOT')}/docs/templates/supplier-template.xlsx`;
}

/** Файл шаблона с добавленными строками (примерная строка шаблона остаётся второй). */
export async function buildBatchFile(rows: readonly TemplateRow[]): Promise<Uint8Array> {
  const out = `${e2eEnv().work}/out`;
  batchCounter += 1;
  const target = `${out}/r-batch-${batchCounter}.xlsx`;
  const rowsPath = `${out}/r-batch-${batchCounter}.json`;
  const scriptPath = `${out}/r-fill.py`;
  const table = rows.map((row) =>
    SUPPLIER_TEMPLATE_COLUMNS.map((column) => row[column.key] ?? ''),
  );
  await writeFile(rowsPath, JSON.stringify(table), 'utf8');
  await writeFile(scriptPath, FILL_SCRIPT, 'utf8');
  const python = `${requireEnv('E2E_ROOT')}/services/documents/.venv/bin/python`;
  const result = spawnSync(python, ['-I', scriptPath, supplierTemplatePath(), target, rowsPath], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`сборка xlsx не удалась: ${result.stderr}`);
  return new Uint8Array(await readFile(target));
}

const MASKING_PSEUDO_OFFSET = 1;
const PSEUDO_READY_ATTEMPTS = 240;
const PSEUDO_READY_PAUSE_MS = 500;
const PSEUDO_HOST = '127.0.0.1';
/** Сколько ждём штатного выхода после SIGTERM, прежде чем послать SIGKILL, мс. */
const PSEUDO_STOP_TIMEOUT_MS = 5_000;

/** Отдельный pseudonymizer с маскированием реквизитов юрлица. */
export interface MaskingPseudonymizer {
  /** Адрес для `PSEUDONYMIZER_URL`. */
  url: string;
  /** Остановить процесс и дождаться выхода (SIGKILL по таймауту). */
  stop(): Promise<void>;
}

/** Свободен ли порт на локальном адресе (проверка до запуска процесса). */
async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, PSEUDO_HOST, () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * Отдельный pseudonymizer с `PSEUDONYMIZER_MASK_LEGAL_ENTITY=true`. Общий сервис прогона
 * работает с умолчанием `false` (названия организаций остаются в тексте, ИНН маскируется
 * всегда); этот сервис нужен, чтобы проверить маскировку названий организаций. Процесс на порту
 * `E2E_PSEUDO_PORT + 1`.
 *
 * Порт проверяется до запуска: занятый порт (процесс-сирота прошлого прогона) даёт ошибку, а не
 * «готовность» чужого сервиса. Выход или ошибка процесса прерывают ожидание сразу. Вывод
 * процесса пишется в `<work>/logs/pseudonymizer-masking.log`.
 */
export async function startMaskingPseudonymizer(): Promise<MaskingPseudonymizer> {
  const env = e2eEnv();
  const port = Number(requireEnv('E2E_PSEUDO_PORT')) + MASKING_PSEUDO_OFFSET;
  if (!(await isPortFree(port))) {
    throw new Error(
      `порт ${port} для pseudonymizer с маскированием занят (процесс-сирота прошлого прогона?)`,
    );
  }
  const logsDir = `${env.work}/logs`;
  await mkdir(logsDir, { recursive: true });
  const logPath = `${logsDir}/pseudonymizer-masking.log`;
  const logFd = openSync(logPath, 'a');
  const child: ChildProcess = spawn(
    `${requireEnv('E2E_ROOT')}/services/pseudonymizer/.venv/bin/python`,
    // Сервис - вендоренная labops-pii, как в run.sh: без `-I`, иначе PYTHONPATH игнорируется.
    ['-m', 'labops_pii'],
    {
      cwd: env.work,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        PYTHONPATH: `${requireEnv('E2E_ROOT')}/vendor/labops-pii`,
        PSEUDONYMIZER_STORE: 'sqlite',
        PSEUDONYMIZER_KEY_SCHEME: 'v2',
        PSEUDONYMIZER_RETENTION_DAYS: '90',
        PSEUDONYMIZER_ADDRESS_MASK: 'on',
        PSEUDONYMIZER_DB: `${env.work}/pseudonymizer-r.sqlite3`,
        PSEUDONYMIZER_HOST: PSEUDO_HOST,
        PSEUDONYMIZER_PORT: String(port),
        PSEUDONYMIZER_MASK_LEGAL_ENTITY: 'true',
      },
    },
  );
  // Файл унаследован потомком; в этом процессе дескриптор больше не нужен.
  closeSync(logFd);

  let failure: string | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      failure ??= `процесс завершился (код ${code ?? 'нет'}, сигнал ${signal ?? 'нет'})`;
      resolve();
    });
    child.once('error', (error) => {
      failure ??= `процесс не запущен: ${error.message}`;
      resolve();
    });
  });
  const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null;

  const stop = async (): Promise<void> => {
    if (hasExited() || failure !== undefined) return;
    child.kill('SIGTERM');
    const timedOut = await Promise.race([
      exited.then(() => false),
      Bun.sleep(PSEUDO_STOP_TIMEOUT_MS).then(() => true),
    ]);
    if (timedOut) {
      child.kill('SIGKILL');
      await exited;
    }
  };

  const url = `http://${PSEUDO_HOST}:${port}`;
  for (let attempt = 0; attempt < PSEUDO_READY_ATTEMPTS; attempt += 1) {
    if (failure !== undefined) {
      throw new Error(`pseudonymizer с маскированием не поднялся: ${failure}; лог ${logPath}`);
    }
    const ready = await fetch(`${url}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    // Порт был свободен до запуска, поэтому отвечает именно наш потомок.
    if (ready && failure === undefined) return { url, stop };
    await Bun.sleep(PSEUDO_READY_PAUSE_MS);
  }
  await stop();
  throw new Error(`pseudonymizer с маскированием не поднялся за отведённое время; лог ${logPath}`);
}
