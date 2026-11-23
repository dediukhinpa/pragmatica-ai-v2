import type { ValidationIssue } from '@business-ai/core';

/** Код предупреждения: в наименовании нет формы собственности. */
const NAME_LEGAL_FORM_MISSING_CODE = 'name_legal_form_missing';

/** Подсказка сотруднику (значение наименования в текст не входит). */
const NAME_LEGAL_FORM_HINT =
  'В наименовании нет формы собственности (например, ООО «Название»): добавьте её.';

/** Сокращённые формы собственности (в нижнем регистре, без точек). */
const SUPPLIER_LEGAL_FORMS_SHORT: readonly string[] = [
  'ооо', 'оао', 'зао', 'пао', 'нао', 'ао', 'ип', 'нко', 'ано', 'тоо', 'одо', 'чп', 'кфх',
  'гуп', 'муп', 'фгуп', 'пк', 'тсж',
];

/** Полные формы собственности (в нижнем регистре, «ё» заменена на «е»). */
const SUPPLIER_LEGAL_FORMS_FULL: readonly string[] = [
  'общество с ограниченной ответственностью',
  'общество с дополнительной ответственностью',
  'публичное акционерное общество',
  'непубличное акционерное общество',
  'закрытое акционерное общество',
  'открытое акционерное общество',
  'акционерное общество',
  'индивидуальный предприниматель',
  'автономная некоммерческая организация',
  'некоммерческая организация',
  'товарищество с ограниченной ответственностью',
  'крестьянское фермерское хозяйство',
  'государственное унитарное предприятие',
  'муниципальное унитарное предприятие',
  'частное предприятие',
];

/** Знаки перед формой и между её словами: кавычки, скобки, точки, дефисы, пробелы. */
const NON_WORD = /[^\p{L}\p{N}]+/gu;

/** Слова наименования: нижний регистр, «ё» -> «е», без знаков (точки в «О.О.О.» убираются). */
function wordsOf(name: string): string[] {
  return name
    .toLowerCase()
    .replaceAll('ё', 'е')
    .split(NON_WORD)
    .filter((word) => word !== '');
}

const FULL_FORM_WORDS: readonly (readonly string[])[] = SUPPLIER_LEGAL_FORMS_FULL.map(wordsOf);

/**
 * Начинается ли наименование с формы собственности: сокращённой (целым словом, поэтому
 * «Аомори» не считается за «АО») или полной. Регистр и кавычки перед формой не важны.
 */
export function startsWithLegalForm(name: string): boolean {
  const words = wordsOf(name);
  const first = words[0];
  if (first === undefined) return false;
  if (SUPPLIER_LEGAL_FORMS_SHORT.includes(first)) return true;
  return FULL_FORM_WORDS.some((form) => form.every((word, index) => words[index] === word));
}

/**
 * Предупреждения по наименованию (не блокируют запись): пока одно - нет формы собственности.
 * Пустое наименование не предупреждается: его ловит `validateSupplierCard`. Наименование не
 * меняется, текст значения не содержит.
 */
export function checkSupplierNameForm(name: string): ValidationIssue[] {
  if (name.trim() === '' || startsWithLegalForm(name)) return [];
  return [{ code: NAME_LEGAL_FORM_MISSING_CODE, message: NAME_LEGAL_FORM_HINT }];
}
