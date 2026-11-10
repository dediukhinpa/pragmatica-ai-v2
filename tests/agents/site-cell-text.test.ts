import { describe, expect, test } from 'bun:test';
import {
  compareInvariants,
  extractInvariants,
  normalizeSpaces,
  violatesInvariants,
} from '../../src/agents/site-export/cell-text';

/** Этап 225: пробелы в строковых ячейках и инварианты текста (числа, артикулы, единицы). */

describe('normalizeSpaces', () => {
  test('двойные пробелы и пробелы по краям', () => {
    expect(normalizeSpaces('  Кружка   керамическая  ')).toBe('Кружка керамическая');
  });

  test('неразрывные и узкие пробелы становятся обычными', () => {
    expect(normalizeSpaces('300 мл и более')).toBe('300 мл и более');
  });

  test('пробел перед знаками препинания убирается, после скобки и кавычки - тоже', () => {
    expect(normalizeSpaces('Кружка , объём 10 ,5 л ; цвет : белый !')).toBe(
      'Кружка, объём 10,5 л; цвет: белый!',
    );
    expect(normalizeSpaces('( белая ) и « Ёлка »')).toBe('(белая) и «Ёлка»');
  });

  test('пробел между числом и единицей остаётся одним обычным', () => {
    expect(normalizeSpaces('Объём 300  мл, скидка 15 %')).toBe('Объём 300 мл, скидка 15 %');
  });

  test('переводы строк сохраняются, пробелы по краям строк убираются', () => {
    expect(normalizeSpaces('Набор:  \r\n  - кружка  \n  - ложка ')).toBe(
      'Набор:\n- кружка\n- ложка',
    );
  });

  test('невидимые символы нулевой ширины убираются', () => {
    expect(normalizeSpaces('Кру​жка﻿')).toBe('Кружка');
  });

  test('чистый текст не меняется', () => {
    expect(normalizeSpaces('Кружка, 300 мл.')).toBe('Кружка, 300 мл.');
  });
});

describe('инварианты текста', () => {
  test('числа нормализуются: запятая, разряды, хвостовые нули; величина = число + единица', () => {
    const a = extractInvariants('Вес 10,50 г, тираж 1 000 шт');
    expect(a.quantities).toEqual(['10.5 г', '1000 шт']);
  });

  test('артикул: буквы вместе с цифрами; размеры 10x20x30 артикулом не считаются', () => {
    const a = extractInvariants('Арт. AB-123/5, размер 10x20x30 мм');
    expect([...a.articles]).toEqual(['AB-123/5']);
    expect(a.quantities).toContain('30 мм');
  });

  test('токены маски', () => {
    const a = extractInvariants('Для [ORG_1] и [PERSON_12]');
    expect([...a.masks].sort()).toEqual(['[org_1]', '[person_12]']);
  });

  test('единицы ищутся только после числа и не путаются со словами', () => {
    const a = extractInvariants('5 мес, 3 грамма, 2 м');
    expect(a.quantities).toEqual(['5', '3', '2 м']);
  });

  test('равенство без сжатия: ничего не добавлено и не потеряно', () => {
    const verdict = compareInvariants('Кружка 300 мл, арт. AB-1', 'Кружка, 300 мл. Арт. AB-1');
    expect(verdict.added).toEqual([]);
    expect(verdict.dropped).toEqual([]);
  });

  test('изменённое число и единица - добавлено новое, потеряно старое', () => {
    const verdict = compareInvariants('Объём 300 мл', 'Объём 350 л');
    expect(verdict.added).toEqual(['величина 350 л']);
    expect(verdict.dropped).toEqual(['величина 300 мл']);
  });

  test('изменённый артикул и токен маски', () => {
    const verdict = compareInvariants('Арт. AB-1 для [ORG_1]', 'Арт. AB-2 для [ORG_2]');
    expect(verdict.added).toEqual(['артикул AB-2', 'токен [org_2]']);
  });

  test('сжатие: опущенное число - не нарушение, но попадает в dropped', () => {
    const verdict = compareInvariants('Вес 10 г, высота 5 см', 'Вес 10 г');
    expect(verdict.added).toEqual([]);
    expect(verdict.dropped).toEqual(['величина 5 см']);
  });

  test('сжатие: новое число всё равно нарушение', () => {
    const verdict = compareInvariants('Вес 10 г', 'Вес 12 г');
    expect(verdict.added).toContain('величина 12 г');
    expect(violatesInvariants(verdict, true)).toBe(true);
  });

  test('правило: потеря допустима только при сжатии', () => {
    const verdict = compareInvariants('Вес 10 г, высота 5 см', 'Вес 10 г');
    expect(violatesInvariants(verdict, true)).toBe(false);
    expect(violatesInvariants(verdict, false)).toBe(true);
  });
});

/** Ревью 225: инварианты - мультимножества пар (число, единица), регистр, единицы, «1,500». */
describe('инварианты: пары (число, единица) по порядку', () => {
  test('числа и единицы переставлены между собой: множества те же, пары другие', () => {
    const diff = compareInvariants('Объём 300 мл, вес 500 г', 'Объём 300 г, вес 500 мл');
    expect(diff.added).toEqual(['величина 300 г', 'величина 500 мл']);
    expect(diff.dropped).toEqual(['величина 300 мл', 'величина 500 г']);
    expect(violatesInvariants(diff, true)).toBe(true);
  });

  test('повтор считается: лишняя копия числа - новое, потерянная копия - потеря', () => {
    expect(compareInvariants('5 см и 5 см', '5 см').dropped).toEqual(['величина 5 см']);
    expect(compareInvariants('5 см', '5 см и 5 см').added).toEqual(['величина 5 см']);
  });

  test('порядок величин изменён: без сжатия нарушение, при сжатии допустимо', () => {
    const diff = compareInvariants('Вес 10 г, высота 5 см', 'Высота 5 см, вес 10 г');
    expect(diff.added).toEqual([]);
    expect(diff.dropped).toEqual([]);
    expect(diff.reordered).toBe(true);
    expect(violatesInvariants(diff, false)).toBe(true);
    expect(violatesInvariants(diff, true)).toBe(false);
  });

  test('число без единицы и то же число с единицей - разные величины', () => {
    const diff = compareInvariants('Ёмкость 300 мл', 'Ёмкость 300');
    expect(diff.added).toEqual(['число 300']);
    expect(diff.dropped).toEqual(['величина 300 мл']);
  });
});

describe('инварианты: артикулы с учётом регистра', () => {
  test('смена регистра артикула - изменение', () => {
    const diff = compareInvariants('Арт. AB-12/c', 'Арт. ab-12/C');
    expect(diff.added).toEqual(['артикул ab-12/C']);
    expect(diff.dropped).toEqual(['артикул AB-12/c']);
  });

  test('цифры внутри артикула не считаются отдельными числами', () => {
    const a = extractInvariants('Арт. AB-123/5');
    expect(a.quantities).toEqual([]);
  });

  test('склеенная величина «5000мАч» артикулом не считается', () => {
    const a = extractInvariants('Ёмкость 5000мАч');
    expect(a.articles.size).toBe(0);
    expect(a.quantities).toEqual(['5000 мАч']);
  });
});

describe('инварианты: единицы измерения', () => {
  test.each([
    ['5000 мАч', '5000 мАч'],
    ['20 Вт', '20 Вт'],
    ['2 кВт', '2 кВт'],
    ['2 л', '2 л'],
    ['15 дюйм', '15 дюйм'],
    ['15 дюймов', '15 дюйм'],
    ['3 м²', '3 м²'],
    ['3 м2', '3 м²'],
    ['25 °C', '25 °C'],
    ['25°С', '25 °С'],
    ['64 Гб', '64 Гб'],
    ['2,4 ГГц', '2.4 ГГц'],
  ])('«%s» -> величина «%s»', (text, expected) => {
    expect(extractInvariants(text).quantities).toEqual([expected]);
  });

  test('регистр значимых единиц сохраняется: мАч и мач - разное', () => {
    const diff = compareInvariants('Ёмкость 5000 мАч', 'Ёмкость 5000 мач');
    expect(violatesInvariants(diff, false)).toBe(true);
  });

  test('подмена единицы Вт на кВт - нарушение', () => {
    expect(violatesInvariants(compareInvariants('20 Вт', '20 кВт'), true)).toBe(true);
  });

  test('м² и м - разные единицы', () => {
    expect(violatesInvariants(compareInvariants('3 м²', '3 м'), true)).toBe(true);
  });
});

describe('инварианты: «1,500» не превращается молча', () => {
  test('1,500 и 1500 - разные; 1,500 и 1,5 - разные', () => {
    expect(violatesInvariants(compareInvariants('Вес 1,500 кг', 'Вес 1500 кг'), true)).toBe(true);
    expect(violatesInvariants(compareInvariants('Вес 1,500 кг', 'Вес 1,5 кг'), true)).toBe(true);
  });

  test('запятая и точка в тысячной записи - одно и то же', () => {
    expect(violatesInvariants(compareInvariants('Вес 1,500 кг', 'Вес 1.500 кг'), false)).toBe(
      false,
    );
  });

  test('обычный десятичный хвостовой ноль прежний: 10,50 = 10,5', () => {
    expect(violatesInvariants(compareInvariants('10,50 г', '10,5 г'), false)).toBe(false);
  });
});

describe('normalizeSpaces: строгий режим (артикулы, ссылки, формулы)', () => {
  test('только края и неразрывные: внутренние двойные пробелы и знаки не трогаются', () => {
    expect(normalizeSpaces('  AB  12 , C ', 'strict')).toBe('AB  12 , C');
    expect(normalizeSpaces('AB 12', 'strict')).toBe('AB 12');
    expect(normalizeSpaces('https://x.example/a ?q=1', 'strict')).toBe('https://x.example/a ?q=1');
    expect(normalizeSpaces('=SUM(A1 , B1)', 'strict')).toBe('=SUM(A1 , B1)');
  });

  test('невидимые символы убираются и в строгом режиме', () => {
    expect(normalizeSpaces('AB​-12﻿', 'strict')).toBe('AB-12');
  });

  test('формула и ссылка в обычном режиме тоже не правятся', () => {
    expect(normalizeSpaces('=A1 , B1')).toBe('=A1 , B1');
    expect(normalizeSpaces('https://x.example/a  b ,c')).toBe('https://x.example/a  b ,c');
  });
});
