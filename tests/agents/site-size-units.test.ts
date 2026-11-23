import { describe, expect, test } from 'bun:test';
import {
  convertSize,
  convertSizeParts,
  SIZE_SEPARATOR,
  headerUnit,
} from '../../src/agents/site-export/size-units';
import { SITE_EXPORT_PROMPT } from '../../src/agents/site-export/prompt';

/** Этап 225: столбец «Размер упаковки» - единица из шапки и перевод значения. */

describe('единица из шапки', () => {
  test('боевая шапка: мм между запятыми', () => {
    expect(headerUnit('Размер упаковки, мм, (ш-в-г) (размер сувенира)')).toBe('мм');
  });

  test('см и м в скобках или после запятой', () => {
    expect(headerUnit('Размер упаковки (см)')).toBe('см');
    expect(headerUnit('Размер, м')).toBe('м');
  });

  test('единицы нет - null', () => {
    expect(headerUnit('Размер упаковки (ш-в-г)')).toBeNull();
  });
});

/** Решение владельца 14 (09.11, отменяет решение 12): запись `260×220×110`, знак «×» U+00D7. */
describe('фиксированный формат записи размера', () => {
  test('разделитель - знак умножения U+00D7, не латинская x', () => {
    expect(SIZE_SEPARATOR).toBe('\u00d7');
    expect(SIZE_SEPARATOR).not.toBe('x');
  });

  test('два измерения: 260×220, без пробелов', () => {
    expect(convertSize('260×220', 'мм')).toEqual({ ok: true, value: '260×220' });
  });

  test('три измерения: 260×220×110', () => {
    expect(convertSize('260×220×110', 'мм')).toEqual({ ok: true, value: '260×220×110' });
  });

  test('в записи нет латинской x ни при каком вводе', () => {
    for (const input of ['260x220x110', '260 X 220 X 110', '260*220*110', '260х220х110 мм']) {
      const result = convertSize(input, 'мм');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).not.toMatch(/[xXхХ*\s]/);
    }
  });
});

describe('нормализация разделителей ввода в «×»', () => {
  const EXPECTED = { ok: true, value: '260×220×110' } as const;

  test.each([
    ['латинская x', '260x220x110'],
    ['латинская X', '260X220X110'],
    ['кириллическая х', '260х220х110'],
    ['кириллическая Х', '260Х220Х110'],
    ['звёздочка', '260*220*110'],
    ['знак умножения', '260×220×110'],
    ['знак умножения U+2715', '260\u2715220\u2715110'],
    ['пробелы вокруг x', '260 x 220 x 110'],
    ['пробелы вокруг х', '260 х 220 х 110'],
    ['пробелы вокруг *', '260 * 220 * 110'],
    ['пробелы вокруг ×', '260 × 220 × 110'],
    ['с единицей в конце', '260x220x110 мм'],
    ['три числа через дефис (ш-в-г)', '260-220-110'],
    ['дефис с пробелами', '260 - 220 - 110'],
    ['длинное тире', '260\u2013220\u2013110'],
  ])('%s', (_name, input) => {
    expect(convertSize(input, 'мм')).toEqual(EXPECTED);
  });

  test('два измерения из каждой записи', () => {
    for (const input of ['260x220', '260х220', '260*220', '260 × 220', '260 x 220 мм']) {
      expect(convertSize(input, 'мм')).toEqual({ ok: true, value: '260×220' });
    }
  });

  test('разные разделители в одном значении - отказ', () => {
    expect(convertSize('240x240-50', 'мм').ok).toBe(false);
    expect(convertSize('240*240x50', 'мм')).toEqual({ ok: true, value: '240×240×50' });
  });
});

describe('единицы шапки: перевод в мм и в см', () => {
  test('см -> мм: 26×22×11 см', () => {
    expect(convertSize('26×22×11 см', 'мм')).toEqual({ ok: true, value: '260×220×110' });
  });

  test('мм -> см: дробь с запятой', () => {
    expect(convertSize('260×220×110 мм', 'см')).toEqual({ ok: true, value: '26×22×11' });
    expect(convertSize('125×200×30 мм', 'см')).toEqual({ ok: true, value: '12,5×20×3' });
  });

  test('м -> мм', () => {
    expect(convertSize('0,26 x 0,22 x 0,11 м', 'мм')).toEqual({ ok: true, value: '260×220×110' });
  });

  test('разные единицы у чисел: ближайшая справа', () => {
    expect(convertSize('10 см × 2 дм х 5 мм', 'мм')).toEqual({ ok: true, value: '100×200×5' });
    expect(convertSize('10 x 2 дм x 5 см', 'мм')).toEqual({ ok: true, value: '1000×200×50' });
  });

  test('без единицы: мм при шапке в мм, иначе отказ с названием единицы шапки', () => {
    expect(convertSize('260×220×110', 'мм')).toEqual({ ok: true, value: '260×220×110' });
    const refused = convertSize('26×22×11', 'см');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain('см');
  });

  test('часть чисел без единицы справа от последней единицы - отказ', () => {
    expect(convertSize('10 см x 20 x 30', 'мм').ok).toBe(false);
  });

  test('одно число с подписью ширины: перевод; число вместо строки в dimensions', () => {
    expect(convertSize('ширина 5 см', 'мм')).toEqual({ ok: true, value: '50' });
    expect(convertSizeParts({ width: 25 }, 'мм')).toEqual({ ok: true, value: '25' });
    expect(convertSizeParts({ width: 2.5 }, 'мм')).toEqual({ ok: true, value: '2,5' });
    expect(convertSizeParts({ width: 25 }, 'см').ok).toBe(false);
  });
});

/** Решение 14.1: порядок берётся по смыслу подписей, а не по порядку чисел источника. */
describe('порядок Ш×В×Г по подписям источника', () => {
  const EXPECTED = { ok: true, value: '260×220×110' } as const;

  test.each([
    ['Ш/В/Г списком перед значением', 'Ш×В×Г 260×220×110'],
    ['Ш/В/Г списком после значения', '260×220×110 (Ш×В×Г)'],
    ['подпись перед числом, порядок Ш В Г', 'ш 260, в 220, г 110 мм'],
    ['подпись перед числом, порядок Г В Ш', 'г 110, в 220, ш 260 мм'],
    ['подпись перед числом, порядок В Ш Г', 'в 220, ш 260, г 110 мм'],
    ['словами в порядке Г Ш В', 'глубина 110 мм, ширина 260 мм, высота 220 мм'],
    ['словами с единицей см', 'ширина 26 см, высота 22 см, глубина 11 см'],
    ['подпись после числа, порядок В Г Ш', '220 (В) × 110 (Г) × 260 (Ш)'],
    ['подпись после числа без скобок', '110 г 260 ш 220 в мм'],
    ['список В×Ш×Г', 'В×Ш×Г 220×260×110'],
    ['список Г×В×Ш', 'Г×В×Ш 110×220×260'],
    ['длина, высота, глубина', 'длина 260, высота 220, глубина 110 мм'],
    ['Д×В×Г', 'Д×В×Г 260×220×110'],
    ['W/H/D списком', 'W/H/D 260×220×110'],
    ['W H D в другом порядке', 'D 110, H 220, W 260 мм'],
    ['width/height/depth словами', 'height 220 mm, depth 110 mm, width 260 mm'],
    ['см латиницей', 'W 26 cm, H 22 cm, D 11 cm'],
    ['L×H×D (length, height, depth)', 'L×H×D 260×220×110'],
  ])('%s', (_name, input) => {
    expect(convertSize(input, 'мм')).toEqual(EXPECTED);
  });

  test('два измерения с подписями: Ш и В в любом порядке', () => {
    expect(convertSize('в 220, ш 260 мм', 'мм')).toEqual({ ok: true, value: '260×220' });
    expect(convertSize('Ш×В 260×220', 'мм')).toEqual({ ok: true, value: '260×220' });
  });

  test('подписи и единицы шапки вместе: см -> мм', () => {
    expect(convertSize('в 22 см, ш 26 см, г 11 см', 'мм')).toEqual(EXPECTED);
  });

  test('L×W×H - длина с шириной: порядок неясен', () => {
    const result = convertSize('L×W×H 30×20×10', 'мм');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('order_unclear');
  });

  test('«длина» вместе с шириной - неоднозначно: размер не определён', () => {
    const result = convertSize('длина 30, ширина 20, высота 10 см', 'мм');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('order_unclear');
  });

  test('«длина» без глубины - неоднозначно', () => {
    const result = convertSize('длина 30, высота 10 см', 'мм');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('order_unclear');
  });

  test('ось указана дважды или пропущена ширина - отказ, а не угадывание', () => {
    expect(convertSize('ш 10, ш 20 мм', 'мм').ok).toBe(false);
    expect(convertSize('в 10, г 20 мм', 'мм').ok).toBe(false);
  });

  test('подписано не каждое число - отказ', () => {
    expect(convertSize('ш 10, 20, г 30 мм', 'мм').ok).toBe(false);
  });
});

describe('структурный ввод dimensions: код сам ставит Ш×В×Г', () => {
  test('поля в любом порядке собираются в ширина×высота×глубина', () => {
    expect(convertSizeParts({ depth: '110', width: '260', height: '220' }, 'мм')).toEqual({
      ok: true,
      value: '260×220×110',
    });
  });

  test('единицы шапки: сантиметры в мм, числа и строки', () => {
    expect(convertSizeParts({ height: '22 см', width: '26 см', depth: '11 см' }, 'мм')).toEqual({
      ok: true,
      value: '260×220×110',
    });
    expect(convertSizeParts({ width: '260 мм', height: 220, depth: 110 }, 'см').ok).toBe(false);
    expect(convertSizeParts({ width: '260 мм', height: '220 мм' }, 'см')).toEqual({
      ok: true,
      value: '26×22',
    });
  });

  test('два измерения: ширина и высота', () => {
    expect(convertSizeParts({ height: '220', width: '260' }, 'мм')).toEqual({
      ok: true,
      value: '260×220',
    });
  });

  test('длина, высота, глубина - тройка однозначна', () => {
    expect(convertSizeParts({ length: '260', height: '220', depth: '110' }, 'мм')).toEqual({
      ok: true,
      value: '260×220×110',
    });
  });

  test('длина без полной тройки - порядок неясен', () => {
    const result = convertSizeParts({ length: '260', width: '220' }, 'мм');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('order_unclear');
  });

  test('не передано ни одного измерения - отказ', () => {
    expect(convertSizeParts({}, 'мм').ok).toBe(false);
  });
});

/** Решение 15: порядок неясен - вопросов нет, ячейка пуста, позиция в предупреждении. */
describe('порядок неясен (неподписанные измерения)', () => {
  test('unlabeled с тремя и двумя числами: order_unclear', () => {
    for (const unlabeled of ['260×220×110', '260 x 220 мм', '10-20 см']) {
      const result = convertSizeParts({ unlabeled }, 'мм');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('order_unclear');
    }
  });

  test('сообщение для агента запрещает вопросы сотруднику и не просит уточнить', () => {
    const result = convertSizeParts({ unlabeled: '260x220x110' }, 'мм');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('вопросов не задавай');
      expect(result.message).toContain('Размеры не удалось определить для');
      expect(result.message).not.toMatch(/уточни|переспроси|попроси/i);
    }
  });

  test('unlabeled с одним числом: ширина это или высота - неизвестно, не записывается', () => {
    const result = convertSizeParts({ unlabeled: '5 см' }, 'мм');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('order_unclear');
  });

  test('unlabeled вместе с полями осей - отказ', () => {
    expect(convertSizeParts({ unlabeled: '1x2', width: '1' }, 'мм').ok).toBe(false);
  });
});

describe('дефис между двумя числами (согласовано с решением 15)', () => {
  test('«5-10» - возможный диапазон: размер не определён, без просьбы переспросить', () => {
    for (const input of ['5-10 см', '10-15', '240-240', '240 - 240', '24\u201324 см']) {
      const result = convertSize(input, 'мм');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('order_unclear');
        expect(result.message).toContain('диапазоном');
        expect(result.message).not.toMatch(/уточни|переспроси|попроси/i);
      }
    }
  });

  test('с «×» то же самое записывается', () => {
    expect(convertSize('5×10 см', 'мм')).toEqual({ ok: true, value: '50×100' });
  });
});

describe('перевод размера: неразбираемое', () => {
  test('неразбираемое значение - отказ с причиной (не order_unclear)', () => {
    for (const bad of ['большая', '10x20x30x40', 'от 10 до 20 см', '10 x y', '', '0x1x2']) {
      const result = convertSize(bad, 'мм');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message.length).toBeGreaterThan(10);
        expect(result.kind).toBe('unparsable');
      }
    }
  });
});

/** Ревью 225. */
describe('единица в шапке: латиница', () => {
  test('mm, cm, dm, m между разделителями', () => {
    expect(headerUnit('Размер упаковки, mm, (ш-в-г)')).toBe('мм');
    expect(headerUnit('Размер упаковки (cm)')).toBe('см');
    expect(headerUnit('Размер упаковки, MM')).toBe('мм');
    expect(headerUnit('Размер, m')).toBe('м');
  });

  test('латиница внутри слова единицей не считается', () => {
    expect(headerUnit('Размер упаковки (ш-в-г) cmyk')).toBeNull();
  });
});

describe('точность зависит от единицы шапки', () => {
  test('мм в метрах: 0,001 м, а не 0', () => {
    expect(convertSize('1x2x3 мм', 'м')).toEqual({ ok: true, value: '0,001×0,002×0,003' });
  });

  test('мм в сантиметрах: десятые доли мм сохраняются', () => {
    expect(convertSize('1x2x3 мм', 'см')).toEqual({ ok: true, value: '0,1×0,2×0,3' });
    expect(convertSize('ширина 0,5 мм', 'см')).toEqual({ ok: true, value: '0,05' });
  });

  test('значение меньше 0,1 мм после округления даёт ноль: отказ, не запись 0', () => {
    const refused = convertSize('ширина 0,04 мм', 'м');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain('0,1');
    expect(convertSize('0,04x10x10 мм', 'см').ok).toBe(false);
  });

  test('в мм прежнее округление до десятых', () => {
    expect(convertSize('1,26x2x3 мм', 'мм')).toEqual({ ok: true, value: '1,3×2×3' });
  });
});

describe('разряды в числах', () => {
  test('«1 000x200x300» разбирается как тысяча', () => {
    expect(convertSize('1 000x200x300', 'мм')).toEqual({ ok: true, value: '1000×200×300' });
    expect(convertSize('1 000 x 2 000 x 300 мм', 'мм')).toEqual({
      ok: true,
      value: '1000×2000×300',
    });
  });

  test('разряды с дробью и единицей', () => {
    expect(convertSize('1 000,5x2x3 см', 'мм')).toEqual({ ok: true, value: '10005×20×30' });
  });
});

describe('число без единицы: только при шапке в мм', () => {
  test('шапка в см, единицы в значении нет - отказ с названием единицы шапки', () => {
    const refused = convertSize('10x20x30', 'см');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain('см');
  });

  test('часть чисел без единицы справа от последней единицы - отказ', () => {
    expect(convertSize('10 см x 20 x 30', 'мм').ok).toBe(false);
  });

  test('ближайшая единица справа по-прежнему работает', () => {
    expect(convertSize('10 x 2 дм x 5 см', 'мм')).toEqual({ ok: true, value: '1000×200×50' });
  });
});


describe('промпт агента: формат размера и решение 15', () => {
  const prompt = SITE_EXPORT_PROMPT;

  test('формат «×», порядок ширина×высота×глубина, латинской x в образце нет', () => {
    expect(prompt).toContain('260×220×110');
    expect(prompt).toContain('ширина×высота×глубина');
    expect(prompt).not.toMatch(/ширина x высота|ш x в x г|\bx\b.*глубина/i);
    expect(prompt).not.toContain('ш x в x г');
  });

  test('порядок берётся по смыслу подписей, а не по порядку чисел', () => {
    expect(prompt).toContain('ПО СМЫСЛУ');
    expect(prompt).toContain('W/H/D');
  });

  test('при неясном порядке вопросов не задавать, предупреждение в итоге', () => {
    expect(prompt).toMatch(/вопросов\s+сотруднику НЕ задавай/);
    expect(prompt).toContain('Размеры не удалось определить для: <позиции>.');
    expect(prompt).toContain('Пришлите данные — дополню');
    expect(prompt).not.toMatch(/уточняющий вопрос|задай вопрос сотруднику/i);
  });
});
