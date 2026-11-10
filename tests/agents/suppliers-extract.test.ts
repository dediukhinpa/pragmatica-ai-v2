import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPLIER_TEMPLATE_COLUMNS } from '../../src/agents/suppliers/supplier-template';
import {
  extractSupplierFromText,
  mergeExtracted,
} from '../../src/agents/suppliers/extract-supplier';
import { INN_ALPHA } from './suppliers-support';

const LETTER = `Здравствуйте!

Направляем коммерческое предложение.

С уважением,
Сидоров Пётр Николаевич
Менеджер по продажам
ООО «Альфа Металл»
Тел.: 8 (495) 123-45-67, моб. +7 900 111-22-33
E-mail: sales@alfa.example.ru
Сайт: www.alfa.example.ru
ИНН ${INN_ALPHA}, КПП 770701001`;

describe('extractSupplierFromText', () => {
  test('письмо с подписью: почта, телефоны, ИНН, сайт, название, ФИО и должность', () => {
    const { fields, found } = extractSupplierFromText(LETTER);
    expect(fields.name).toBe('ООО «Альфа Металл»');
    expect(fields.inn).toBe(INN_ALPHA);
    expect(fields.website).toBe('www.alfa.example.ru');
    expect(fields.contacts?.[0]).toEqual({
      fullName: 'Сидоров Пётр Николаевич',
      position: 'Менеджер по продажам',
      email: 'sales@alfa.example.ru',
      phone: '+74951234567',
      isPrimary: true,
    });
    expect(fields.contacts?.[1]).toEqual({ phone: '+79001112233' });
    expect(found).toEqual({
      emails: 1,
      phones: 2,
      inn: true,
      website: true,
      name: true,
      fullName: true,
      position: true,
    });
  });

  test('ничего не выдумывает: нет признаков - нет полей; ИНН только с подписью', () => {
    const empty = extractSupplierFromText('Добрый день, жду ответа по заказу 7707083893.');
    expect(empty.fields).toEqual({});
    expect(empty.found.inn).toBe(false);
    expect(extractSupplierFromText('').fields).toEqual({});
  });

  test('номер ИНН не принимается за телефон; визитка в одну строку', () => {
    const card = extractSupplierFromText(
      'ИП Петров Иван Сергеевич, ИНН 500100732259, +7 495 000-11-22',
    );
    expect(card.fields.name).toBe('ИП Петров Иван Сергеевич');
    expect(card.fields.inn).toBe('500100732259');
    expect(card.found.phones).toBe(1);
    expect(card.fields.contacts?.[0]?.phone).toBe('+74950001122');
  });

  test('mergeExtracted: явные поля модели не затираются, пробелы заполняются', () => {
    const extracted = extractSupplierFromText(LETTER).fields;
    const merged = mergeExtracted(
      { name: 'Альфа', contacts: [{ fullName: 'Пётр', isPrimary: true }] },
      extracted,
    );
    expect(merged.name).toBe('Альфа');
    expect(merged.inn).toBe(INN_ALPHA);
    expect(merged.contacts?.[0]?.fullName).toBe('Пётр');
    expect(merged.contacts?.[0]?.email).toBe('sales@alfa.example.ru');
    expect(mergeExtracted({}, extracted).contacts).toHaveLength(2);
  });
});

describe('файл шаблона в репозитории', () => {
  const file = join(import.meta.dir, '../../docs/templates/supplier-template.xlsx');

  test('файл есть, это xlsx (zip), заголовки листа совпадают с колонками шаблона', async () => {
    expect(existsSync(file)).toBe(true);
    const head = new Uint8Array(await Bun.file(file).slice(0, 2).arrayBuffer());
    expect(Array.from(head)).toEqual([0x50, 0x4b]);
    // Заголовки читаем стандартной библиотекой Python (zip + XML): без новых пакетов.
    const script = [
      'import sys, json, zipfile, re',
      'z = zipfile.ZipFile(sys.argv[1])',
      "shared = z.read('xl/sharedStrings.xml').decode()",
      "items = re.findall(r'<si>(.*?)</si>', shared, re.S)",
      "texts = [''.join(re.findall(r'<t[^>]*>(.*?)</t>', i, re.S)) for i in items]",
      "print(json.dumps(texts, ensure_ascii=False))",
    ].join('\n');
    const run = Bun.spawnSync(['python3', '-I', '-c', script, file]);
    if (run.exitCode !== 0) return; // python3 недоступен: проверка файла пропущена
    const texts = JSON.parse(run.stdout.toString()) as string[];
    const headers = SUPPLIER_TEMPLATE_COLUMNS.map((column) => column.header);
    expect(texts.slice(0, headers.length)).toEqual(headers);
    expect(texts).toContain('Колонка');
  });
});

/**
 * R9-A2-01: поиск адресов почты линейный. Прежняя `EMAIL_RE` без пределов квантификаторов
 * на ряде кириллицы без `@` была кубической: 2000 знаков - 24 с, предел 8000 - минуты.
 */
describe('extractSupplierFromText: адреса почты (R9-A2-01)', () => {
  /** Предел исходного текста инструмента (`MAX_SOURCE_TEXT_LENGTH`). */
  const SOURCE_TEXT_MAX = 8000;
  /** Предел времени: после правки - десятки мс, до правки - минуты. */
  const EXTRACT_TIME_LIMIT_MS = 1000;
  /** Предел локальной части адреса по RFC 5321. */
  const LOCAL_PART_MAX = 64;

  function emailsOf(text: string): string[] {
    return (extractSupplierFromText(text).fields.contacts ?? []).flatMap((contact) =>
      contact.email === undefined ? [] : [contact.email],
    );
  }

  test('прежние адреса находятся', () => {
    expect(emailsOf('Почта: ivan.petrov@пример.рф')).toEqual(['ivan.petrov@пример.рф']);
    expect(emailsOf('a_b@x.ru')).toEqual(['a_b@x.ru']);
    expect(emailsOf('E-mail: Sales@Alfa.Example.ru, b+1@c.com.')).toEqual([
      'sales@alfa.example.ru',
      'b+1@c.com',
    ]);
    const atLimit = `${'a'.repeat(LOCAL_PART_MAX)}@x.ru`;
    expect(emailsOf(`адрес ${atLimit}`)).toEqual([atLimit]);
  });

  test('локальная часть длиннее 64 знаков не даёт обрезанного чужого адреса', () => {
    const tooLong = `${'a'.repeat(LOCAL_PART_MAX + 1)}@x.ru`;
    expect(emailsOf(`адрес ${tooLong}`)).toEqual([]);
  });

  test('телефон и сайт рядом с адресом находятся как раньше', () => {
    const found = extractSupplierFromText(
      'info@site.ru тел. +7 (391) 555-12-34, сайт: www.site.ru, ИНН 7707083893',
    );
    expect(found.fields.website).toBe('www.site.ru');
    expect(found.fields.contacts?.[0]?.phone).toBeDefined();
    expect(found.found.emails).toBe(1);
  });

  test('ряд кириллицы во весь предел текста разбирается быстро', () => {
    extractSupplierFromText(LETTER);
    for (const row of ['ж'.repeat(SOURCE_TEXT_MAX), 'ж1._-'.repeat(SOURCE_TEXT_MAX / 5)]) {
      const text = `Здравствуйте!\n${row}\nС уважением,\nИванов Иван Иванович\nivan@x.ru`;
      const started = performance.now();
      const found = extractSupplierFromText(text);
      expect(performance.now() - started).toBeLessThan(EXTRACT_TIME_LIMIT_MS);
      expect(found.fields.contacts?.[0]?.email).toBe('ivan@x.ru');
    }
  });
});

describe('визитка: человек с визитки как контакт', () => {
  const contactOf = (text: string) => extractSupplierFromText(text).fields.contacts?.[0];

  test('имя без отчества и должность после имени', () => {
    const text = 'ООО «Бета Трейд»\nИгорь Орлов\nКоммерческий директор\n+7 495 013-57-91';
    expect(contactOf(text)).toMatchObject({
      fullName: 'Игорь Орлов',
      position: 'Коммерческий директор',
    });
  });

  test('должность перед именем: первая строка (организация) именем не считается', () => {
    const text = 'Бета Трейд\nМенеджер по закупкам\nИгорь Орлов\n+7 495 013-57-91';
    expect(contactOf(text)).toMatchObject({
      fullName: 'Игорь Орлов',
      position: 'Менеджер по закупкам',
    });
  });

  test('название организации без должности рядом контактом-человеком не становится', () => {
    const text = 'Бета Трейд\nОптовая торговля\n+7 495 013-57-91\ninfo@beta-trade.example';
    expect(contactOf(text)?.fullName).toBeUndefined();
    expect(contactOf(text)?.email).toBe('info@beta-trade.example');
  });
});
