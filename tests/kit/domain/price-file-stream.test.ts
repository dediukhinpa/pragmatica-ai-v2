import { describe, expect, test } from 'bun:test';
import { planSourceReplacement, priceFileStream } from '../../../src/kit/domain/price-file-stream';

describe('поток прайса: имя без даты', () => {
  test('версии с датами разных форматов - один поток', () => {
    const a = priceFileStream('Фабрика/Значки_05_05_2026.xlsx');
    const b = priceFileStream('Фабрика/Значки_01.10.2026.xlsx');
    const c = priceFileStream('фабрика/значки 2026-10-28.XLS');
    expect(a.key).toBe(b.key);
    expect(a.key).toBe(c.key);
    expect(a.date).toEqual({ year: 2026, month: 5, day: 5 });
    expect(b.date).toEqual({ year: 2026, month: 10, day: 1 });
  });

  test('другая папка или другое имя - другой поток', () => {
    const base = priceFileStream('Фабрика/Значки_01.10.2026.xlsx').key;
    expect(priceFileStream('Другая/Значки_01.10.2026.xlsx').key).not.toBe(base);
    expect(priceFileStream('Фабрика/Медали_01.10.2026.xlsx').key).not.toBe(base);
  });

  test('файл без даты: дата null', () => {
    expect(priceFileStream('Фабрика/Значки.xlsx').date).toBeNull();
  });
});

describe('planSourceReplacement', () => {
  const OLD = 'Ф/Значки_05_05_2026.xlsx';
  const NEW = 'Ф/Значки_01.10.2026.xlsx';
  const MEDALS = 'Ф/Медали_01.09.2026.xlsx';

  test('новая версия заменяет старую, чужая линия остаётся', () => {
    const plan = planSourceReplacement([OLD, MEDALS, MEDALS], NEW);
    expect(plan).toEqual({ replaceFiles: [OLD], replaceNull: false, newerFile: null });
  });

  test('старая дата не перетирает новую', () => {
    const plan = planSourceReplacement([NEW, MEDALS], OLD);
    expect(plan.newerFile).toBe(NEW);
    expect(plan.replaceFiles).toEqual([]);
  });

  test('тот же путь заменяется всегда', () => {
    expect(planSourceReplacement([NEW], NEW).replaceFiles).toEqual([NEW]);
  });

  test('строки без файла заменяются, только если других файлов нет', () => {
    expect(planSourceReplacement([null], MEDALS, [], true)).toEqual({
      replaceFiles: [],
      replaceNull: true,
      newerFile: null,
    });
    expect(planSourceReplacement([null], MEDALS).replaceNull).toBe(false);
    expect(planSourceReplacement([null, OLD], MEDALS, [], true).replaceNull).toBe(false);
  });

  test('без даты у одного из файлов входящий заменяет лежащий', () => {
    expect(planSourceReplacement(['Ф/Значки.xlsx'], NEW).replaceFiles).toEqual(['Ф/Значки.xlsx']);
    expect(planSourceReplacement([NEW], 'Ф/Значки.xlsx').newerFile).toBeNull();
  });
});
