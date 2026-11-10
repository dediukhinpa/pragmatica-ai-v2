import { expect, test } from 'bun:test';
import {
  checkSupplierNameForm,
  startsWithLegalForm,
} from '../../../src/kit/domain/supplier-legal-form';
import { normalizeSupplierName } from '../../../src/kit/domain/shortlist';

test('сокращённые формы в начале названия распознаются', () => {
  for (const name of [
    'ООО «Ромашка»', 'ао Заря', 'ПАО "Газ"', 'ИП Иванов И.И.', 'ЗАО Альфа', 'ОАО «Бета»',
    'НКО Фонд', '«ООО Ромашка»', 'ООО"Ромашка"',
  ]) {
    expect(startsWithLegalForm(name)).toBe(true);
  }
});

test('полные формы в начале названия распознаются', () => {
  expect(startsWithLegalForm('Общество с ограниченной ответственностью «Ромашка»')).toBe(true);
  expect(startsWithLegalForm('Индивидуальный предприниматель Петров')).toBe(true);
  expect(startsWithLegalForm('Публичное акционерное общество Газ')).toBe(true);
});

test('форма не в начале и похожие слова формой не считаются', () => {
  for (const name of ['Ромашка ООО', 'Аомори', 'Ипподром', 'Ромашка', 'Общество любителей']) {
    expect(startsWithLegalForm(name)).toBe(false);
  }
});

test('предупреждение без значения; пустое название не предупреждается', () => {
  const issues = checkSupplierNameForm('Лютик');
  expect(issues).toHaveLength(1);
  expect(issues[0]?.code).toBe('name_legal_form_missing');
  expect(issues[0]?.message).not.toContain('Лютик');
  expect(checkSupplierNameForm('ООО «Ромашка»')).toEqual([]);
  expect(checkSupplierNameForm('   ')).toEqual([]);
});

test('поиск дублей не затронут: форма по-прежнему не различает названия', () => {
  expect(normalizeSupplierName('ООО «Ромашка»')).toBe(normalizeSupplierName('Ромашка'));
});
