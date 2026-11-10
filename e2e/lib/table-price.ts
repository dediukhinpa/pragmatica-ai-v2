import { spawnSync } from 'node:child_process';
import { lastResult, type StubReply, type StubScript } from '@business-ai/testing/e2e';
import { headerRowCount } from './prices-flow';
import { requireEnv } from './project-env';

/** Ячейка синтетической таблицы прайса. */
export type TableCell = string | number;

/** Книга xlsx из строк как есть (openpyxl из окружения documents); первая строка - шапка. */
export function buildTablePrice(
  targetPath: string,
  rows: ReadonlyArray<readonly TableCell[]>,
): void {
  const python = `${requireEnv('E2E_ROOT')}/services/documents/.venv/bin/python`;
  const script = `${requireEnv('E2E_PROJECT_ROOT')}/e2e/fixtures/make_table_price.py`;
  const result = spawnSync(python, ['-I', script, targetPath, JSON.stringify({ rows })], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`сборка прайса не удалась: ${result.stderr}`);
}

/** Колонки в плоской схеме инструментов (необязательные поля этапа 106). */
export type TableColumns = Record<string, unknown>;

/**
 * Сценарий модели на один файл: чтение -> разбор -> запись -> текст. Позиции модель не
 * передаёт: инструмент сам перечитывает файл и сверяет хэш.
 */
export function readNormalizeSaveScript(
  path: string,
  supplierId: string,
  columns: TableColumns,
  doneText: string,
): StubScript {
  return ({ index, body }): StubReply => {
    switch (index) {
      case 0:
        return { kind: 'tool', name: 'readPriceFile', input: { path } };
      case 1: {
        const read = lastResult(body, 'readPriceFile');
        return {
          kind: 'tool',
          name: 'normalizePriceTable',
          input: {
            path,
            supplierId,
            tableIndex: 0,
            headerRows: headerRowCount(String(read['markdown'])),
            columns,
          },
        };
      }
      case 2: {
        const norm = lastResult(body, 'normalizePriceTable');
        const read = lastResult(body, 'readPriceFile');
        return {
          kind: 'tool',
          name: 'savePriceImport',
          input: {
            path,
            supplierId,
            fileHash: norm['fileHash'],
            tableIndex: 0,
            headerRows: headerRowCount(String(read['markdown'])),
            columns,
          },
        };
      }
      default:
        return { kind: 'text', text: doneText };
    }
  };
}
