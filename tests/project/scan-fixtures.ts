import type { DocumentParser, ParsedDocument } from '@business-ai/core';

/** Предупреждение разборщика: текст распознан со скана (как у опции `keepScanText`). */
export const SCAN_WARNING =
  'Текст распознан со скана или фото: цифры и названия могут быть прочитаны с ошибками, ' +
  'сверьте с оригиналом.';

/** Синтетический скан-счёт: вымышленные позиции, итого напечатано в скане. */
export const MUG_INVOICE = [
  'Текст с фото: Счёт на оплату № 15 от 20.11.2026',
  '№ Наименование Кол-во Ед. Цена Сумма',
  '1 Кружка керамическая 10 шт 250,00 2 500,00',
  '2 Блюдце фарфоровое 20 шт 120,00 2 400,00',
  '3 Ложка чайная 5 шт 80,50 402,50',
  'Итого: 5 302,50',
].join('\n');

/** Скан-прайс: у одной позиции цена не читается, у другой сумма не сходится. */
export const DOUBTFUL_PRICE_LIST = [
  'Текст с фото: Прайс-лист',
  '1 Кружка керамическая 10 шт 250,00 2 500,00',
  '2 Блюдце фарфоровое 20 шт ??? 2 400,00',
  '3 Ложка чайная 5 шт 80,50 999,00',
  '4 Салфетница пластиковая 4 шт 75,00 300,00',
].join('\n');

/** Начало png: приём файлов сверяет содержимое с расширением. */
export const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Результат разбора скана: распознанный текст без таблиц, `needsOcr` снят. */
export function recognizedScan(text: string): ParsedDocument {
  return {
    text,
    tables: [],
    needsOcr: false,
    hasHiddenContent: false,
    hiddenSheets: [],
    truncated: false,
    warnings: [SCAN_WARNING],
  };
}

/** Скан, который не удалось прочитать: пусто и `needsOcr`. */
export function unreadScan(): ParsedDocument {
  return {
    text: '',
    tables: [],
    needsOcr: true,
    hasHiddenContent: false,
    hiddenSheets: [],
    truncated: false,
    warnings: ['Часть картинок не прочитана'],
  };
}

/** Разборщик, читающий картинки (как `VisionTableDocumentParser`), с заданным результатом. */
export function scanParserOf(document: ParsedDocument): DocumentParser & { calls: number } {
  const parser = {
    readsImages: true,
    calls: 0,
    async parse(): Promise<ParsedDocument> {
      parser.calls += 1;
      return document;
    },
  };
  return parser;
}
