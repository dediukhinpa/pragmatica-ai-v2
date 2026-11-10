import type { OwnLegalEntityData } from '../../../src/kit/domain/own-legal-entity';

/**
 * Синтетические реквизиты наших юрлиц для тестов (этап 230). Числа выдуманы и проходят только
 * контрольные суммы; реальных данных компании в тестах нет.
 */
export const SYNTH_PRAGMATIKA: OwnLegalEntityData = {
  fullName: 'Общество с ограниченной ответственностью «Тест-Альфа»',
  shortName: 'ООО «Тест-Альфа»',
  inn: '1234567005',
  kpp: '123401001',
  legalAddress: '100001, г. Тестоград, ул. Пробная, д. 1, оф. 10',
  postalAddress: '100002, г. Тестоград, ул. Почтовая, д. 2',
  actualAddress: '100003, г. Тестоград, ул. Фактическая, д. 3',
  bankName: 'Тестовый банк ПАО «Пример», г. Тестоград',
  bik: '041234501',
  settlementAccount: '40702810000000000000',
  correspondentAccount: '30101810000000000009',
  signatoryPosition: 'Генеральный директор',
  signatoryName: 'Иванов Пётр Сергеевич',
  signatoryBasis: 'Устава',
  phone: '(900) 111-22-33',
};

export const SYNTH_MASTER_GIFTS: OwnLegalEntityData = {
  fullName: 'Общество с ограниченной ответственностью «Тест-Бета»',
  shortName: 'ООО «Тест-Бета»',
  inn: '2345678009',
  kpp: '234501001',
  legalAddress: '200001, г. Образцов, ул. Макетная, д. 5, оф. 20',
  bankName: 'Образцовый банк ПАО «Макет», г. Образцов',
  bik: '047654301',
  settlementAccount: '40702810000000000004',
  correspondentAccount: '30101810000000000007',
  signatoryPosition: 'Генеральный директор',
  signatoryName: 'Петрова Анна Ивановна',
  signatoryBasis: 'Устава',
  phone: '(900) 444-55-66',
  email: 'office@example.test',
};
