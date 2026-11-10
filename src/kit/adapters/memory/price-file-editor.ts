import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnsupportedPriceFormatError } from '../../domain/errors.owned';
import type {
  EditedPriceDiskFile,
  EditedPriceFile,
  EditPricesFileRequest,
  EditPricesRequest,
  PriceFileEditor,
  SkippedPriceEdit,
} from '../../ports/price-file-editor';

/** Расширения, которые на месте не правятся (как в настоящем сервисе). */
const UNSUPPORTED_EXTENSIONS: readonly string[] = ['.xls', '.pdf'];
/** Разделители CSV: у файла поставщика бывает «;» (Excel) или «,». */
const SEPARATORS: readonly string[] = [';', ','];
/** Число в ячейке: целое или десятичное, точка или запятая. */
const NUMBER_CELL = /^\d+(?:[.,]\d+)?$/;
/** Допуск сравнения старого значения, как в сервисе. */
const EXPECTED_TOLERANCE = 0.01;
const CSV_MIME = 'text/csv; charset=utf-8';

/** Совпадает ли ожидаемое старое значение с ячейкой (числа - с допуском в копейку). */
function matchesExpected(expected: number | string | null | undefined, cell: string): boolean {
  if (expected === undefined || expected === null) return true;
  const have = Number(cell.trim().replace(',', '.'));
  const want = typeof expected === 'number' ? expected : Number(String(expected).replace(',', '.'));
  return Number.isFinite(want) && Math.abs(have - want) <= EXPECTED_TOLERANCE;
}

/**
 * Заглушка правки цен для тестов: файл считается CSV с разделителем «;» или «,», правка
 * меняет только числовые ячейки, остальное копируется как есть.
 * Настоящая правка xlsx/docx - в сервисе.
 */
export class MemoryPriceFileEditor implements PriceFileEditor {
  async editPrices(request: EditPricesRequest): Promise<EditedPriceFile> {
    const lower = request.fileName.toLowerCase();
    const bad = UNSUPPORTED_EXTENSIONS.find((extension) => lower.endsWith(extension));
    if (bad !== undefined) throw new UnsupportedPriceFormatError(bad.slice(1));
    const text = new TextDecoder().decode(request.bytes);
    // Разделитель определяется по первой строке и сохраняется при записи.
    const first = text.split('\n')[0] ?? '';
    const separator = SEPARATORS.find((item) => first.includes(item)) ?? ';';
    const rows = text.split('\n').map((line) => line.split(separator));
    const skipped: SkippedPriceEdit[] = [];
    let changed = 0;
    for (const edit of request.edits) {
      const where = {
        ...(edit.sheet === undefined ? {} : { sheet: edit.sheet }),
        ...(edit.table === undefined ? {} : { table: edit.table }),
        row: edit.row,
        col: edit.col,
      };
      const cell = rows[edit.row]?.[edit.col];
      if (cell === undefined) skipped.push({ ...where, reason: 'ячейка вне таблицы' });
      else if (!NUMBER_CELL.test(cell.trim())) {
        skipped.push({ ...where, reason: 'в ячейке не число (текстовая цена)' });
      } else if (!matchesExpected(edit.expected, cell)) {
        // Как настоящий сервис: старое значение не сошлось - ячейку не пишем.
        skipped.push({ ...where, reason: 'mismatch' });
      } else {
        (rows[edit.row] as string[])[edit.col] = String(edit.value);
        changed += 1;
      }
    }
    return {
      fileName: request.fileName,
      mimeType: CSV_MIME,
      bytes: new TextEncoder().encode(rows.map((row) => row.join(separator)).join('\n')),
      changed,
      skipped,
    };
  }

  /** Для тестов: читает файл целиком и кладёт результат во временный файл. */
  async editPricesFile(request: EditPricesFileRequest): Promise<EditedPriceDiskFile> {
    const bytes = new Uint8Array(await readFile(request.file.path));
    const edited = await this.editPrices({
      fileName: request.fileName,
      bytes,
      edits: request.edits,
    });
    const dir = await mkdtemp(join(tmpdir(), 'memory-editor-'));
    const path = join(dir, 'edited');
    await writeFile(path, edited.bytes);
    const size = (await stat(path)).size;
    return {
      fileName: edited.fileName,
      mimeType: edited.mimeType,
      file: {
        path,
        size,
        dispose: () => rm(dir, { recursive: true, force: true }),
      },
      changed: edited.changed,
      skipped: edited.skipped,
    };
  }
}
