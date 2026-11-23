import { describe, expect, test } from 'bun:test';
import {
  checkSupplierRequisites,
  isValidBik,
  isValidCorrespondentAccount,
  isValidInn,
  isValidKpp,
  isValidOgrn,
  isValidSettlementAccount,
  supplierRequisitesRecord,
  validateSupplierRequisites,
} from '../../../src/kit/domain/requisites';

import { ACCOUNT, BIK, CORR, FULL_SUPPLIER } from '../support/supplier-fixtures';

describe('контрольные суммы', () => {
  test('ИНН юрлица и ИП', () => {
    expect(isValidInn('7707083893')).toBe(true);
    expect(isValidInn('500100732259')).toBe(true);
    expect(isValidInn('7707083894')).toBe(false);
    expect(isValidInn('77070838')).toBe(false);
    expect(isValidInn('77070838АБ')).toBe(false);
  });

  test('КПП, БИК, ОГРН', () => {
    expect(isValidKpp('773601001')).toBe(true);
    expect(isValidKpp('7736A1001')).toBe(true);
    expect(isValidKpp('7736a1001')).toBe(false);
    expect(isValidKpp('77360100')).toBe(false);
    expect(isValidBik(BIK)).toBe(true);
    expect(isValidBik('144525225')).toBe(false);
    expect(isValidOgrn('1027700132195')).toBe(true);
    expect(isValidOgrn('304500116000157')).toBe(true);
    expect(isValidOgrn('1027700132196')).toBe(false);
  });

  test('расчётный и корреспондентский счёт проверяются вместе с БИК', () => {
    expect(isValidSettlementAccount(ACCOUNT, BIK)).toBe(true);
    expect(isValidSettlementAccount('40702810200000000002', BIK)).toBe(false);
    expect(isValidSettlementAccount(ACCOUNT, '044525226')).toBe(false);
    expect(isValidCorrespondentAccount(CORR, BIK)).toBe(true);
    expect(isValidCorrespondentAccount('30101810400000000226', BIK)).toBe(false);
  });
});

describe('реквизиты поставщика', () => {
  test('полные и верные: замечаний нет', () => {
    expect(validateSupplierRequisites(FULL_SUPPLIER)).toEqual([]);
  });

  test('не хватает полей: перечислены; КПП у ИП не требуется', () => {
    const check = checkSupplierRequisites({ id: 's', name: 'Х', inn: '7707083893' });
    expect(check.missing).toEqual([
      'legalAddress',
      'bankName',
      'bik',
      'settlementAccount',
      'correspondentAccount',
      'kpp',
    ]);
    const person = checkSupplierRequisites({
      ...FULL_SUPPLIER,
      inn: '500100732259',
      kpp: undefined,
    });
    expect(person.missing).toEqual([]);
  });

  test('неверная контрольная сумма — замечание requisite_invalid без значений', () => {
    const issues = validateSupplierRequisites({ ...FULL_SUPPLIER, inn: '7707083894' });
    expect(issues.map((i) => i.code)).toEqual(['requisite_invalid']);
    expect(issues[0]?.message).not.toContain('7707083894');
  });

  test('плоская запись содержит только заполненное', () => {
    expect(supplierRequisitesRecord({ id: 's', name: 'Х', inn: ' 7707083893 ' })).toEqual({
      inn: '7707083893',
    });
  });
});
