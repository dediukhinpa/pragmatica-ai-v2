import { describe, expect, test } from 'bun:test';
import { safeAttachmentName } from '../../src/chat-attachments';

const MAX_CHARS = 120;
/** Запас под имя в файловой системе (255 байт) за вычетом префикса хэша. */
const MAX_NAME_BYTES = 200;

describe('безопасное имя файла архива', () => {
  test('обычные имена сохраняются как есть, включая кириллицу и пробелы', () => {
    expect(safeAttachmentName('report.pdf')).toBe('report.pdf');
    expect(safeAttachmentName('Счёт №5 от 01.03.xlsx')).toBe('Счёт №5 от 01.03.xlsx');
  });

  test('разделители пути заменяются: выхода из каталога нет', () => {
    expect(safeAttachmentName('../x')).toBe('_x');
    expect(safeAttachmentName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeAttachmentName('a/b')).toBe('a_b');
    expect(safeAttachmentName('x\\y')).toBe('x_y');
    expect(safeAttachmentName('/abs/path.txt')).toBe('_abs_path.txt');
  });

  test('имя не начинается с точки', () => {
    expect(safeAttachmentName('.hidden')).toBe('hidden');
    expect(safeAttachmentName('...doc')).toBe('doc');
    expect(safeAttachmentName('.')).toBe('file');
    expect(safeAttachmentName('..')).toBe('file');
  });

  test('NUL и управляющие символы заменяются', () => {
    expect(safeAttachmentName('a\0b')).toBe('a_b');
    expect(safeAttachmentName('a\nb\rc\td')).toBe('a_b_c_d');
    expect(safeAttachmentName('x\u007fy\u0085z')).toBe('x_y_z');
  });

  test('пустое имя даёт file', () => {
    expect(safeAttachmentName('')).toBe('file');
    expect(safeAttachmentName('   ')).toBe('file');
    expect(safeAttachmentName('\0')).toBe('_');
  });

  test('очень длинное имя режется с сохранением расширения', () => {
    const name = safeAttachmentName(`${'я'.repeat(500)}.pdf`);
    expect([...name].length).toBeLessThanOrEqual(MAX_CHARS);
    expect(name.endsWith('.pdf')).toBe(true);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
  });

  test('длинное имя из латиницы режется по числу знаков', () => {
    const name = safeAttachmentName(`${'a'.repeat(500)}.xlsx`);
    expect(name).toBe(`${'a'.repeat(MAX_CHARS - '.xlsx'.length)}.xlsx`);
  });

  test('длинное «расширение» не сохраняется целиком, длина всё равно в пределах', () => {
    const name = safeAttachmentName(`a.${'b'.repeat(500)}`);
    expect([...name].length).toBeLessThanOrEqual(MAX_CHARS);
  });

  test('суррогатные пары не рвутся при обрезке', () => {
    const name = safeAttachmentName(`${'😀'.repeat(300)}.png`);
    expect(name.endsWith('.png')).toBe(true);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(name).not.toContain('�');
    expect(Buffer.from(name).toString('utf8')).toBe(name);
  });

  test('символы смены направления письма заменяются', () => {
    expect(safeAttachmentName('doc‮fdp.exe')).toBe('doc_fdp.exe');
  });

  test('результат всегда без разделителей и не пуст', () => {
    const samples = ['../..', '....//....', '\\\\server\\share', 'a/../b', '\0\0\0', '.\u0000.'];
    for (const sample of samples) {
      const name = safeAttachmentName(sample);
      expect(name.length).toBeGreaterThan(0);
      expect(/[/\\\0]/.test(name)).toBe(false);
      expect(name.startsWith('.')).toBe(false);
    }
  });
});
