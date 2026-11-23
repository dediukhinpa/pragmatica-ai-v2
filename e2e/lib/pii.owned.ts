
/** Персональные данные из фикстур (синхронно с fixtures/make_fixtures.py). */
export const PRICE_FILE_PII = {
  names: ['Иванов', 'Пётр', 'Петр', 'Сергеевич'],
  phones: ['+7 (902) 123-45-67'],
  emails: ['p.ivanov@metalloprokat-example.ru'],
} as const;
/** ПДн покупателя из запроса менеджера в сценарии «Подготовка документов (ИИ агент)». */
export const BUYER_PII = {
  names: ['Сидоров', 'Алексей', 'Николаевич'],
  phones: ['+7 (913) 555-12-34'],
  emails: [],
} as const;
