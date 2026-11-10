import { afterAll, describe, expect, test } from 'bun:test';
import { removeTempDirs } from '@business-ai/testing';
import {
  assertCrossChecks,
  crossCheckErrors,
  isSiteTemplatePath,
  isValidTimeZone,
  pragmatikaConfigSchema,
  type PragmatikaConfig,
} from '../../src/config';
import { buildPragmatika } from './support';

afterAll(removeTempDirs);

const REQUIRED_ENV = {
  PRICES_FILES_ROOT: '/files/prices',
  TEMPLATES_FILES_ROOT: '/files/templates',
  OWN_COMPANY_NAMES: 'Тестовая компания',
};

/** Разобранные предметные переменные с поправками теста. */
function configWith(env: Record<string, string> = {}): PragmatikaConfig {
  return pragmatikaConfigSchema.parse({ ...REQUIRED_ENV, ...env });
}

describe('предметная схема окружения', () => {
  test('без обязательных корней и названий компании разбор падает', () => {
    const result = pragmatikaConfigSchema.safeParse({});
    expect(result.success).toBe(false);
    const names = result.success ? [] : result.error.issues.map((issue) => issue.path[0]);
    expect(names.sort()).toEqual([
      'OWN_COMPANY_NAMES',
      'PRICES_FILES_ROOT',
      'TEMPLATES_FILES_ROOT',
    ]);
  });

  test('пустая строка равна «не задано»: умолчание сохраняется', () => {
    const config = configWith({ BUSINESS_TIMEZONE: '', PRICE_RELEVANCE_MAX_NAMES: '' });
    expect(config.BUSINESS_TIMEZONE).toBe('Europe/Moscow');
    expect(config.PRICE_RELEVANCE_MAX_NAMES).toBe(150);
  });

  test('часовой пояс проверяется, значение в текст ошибки не попадает', () => {
    expect(isValidTimeZone('Europe/Moscow')).toBe(true);
    expect(isValidTimeZone('Не/Пояс')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    const bad = pragmatikaConfigSchema.safeParse({
      ...REQUIRED_ENV,
      BUSINESS_TIMEZONE: 'Не/Пояс',
    });
    expect(bad.success).toBe(false);
  });

  test('путь шаблона сайта: относительный .xlsx без «..»', () => {
    expect(isSiteTemplatePath('site/clean.xlsx')).toBe(true);
    const bads = ['/abs/clean.xlsx', '../clean.xlsx', 'a//b.xlsx', 'clean.docx', 'a\\b.xlsx'];
    for (const bad of bads) {
      expect(isSiteTemplatePath(bad)).toBe(false);
    }
    const result = pragmatikaConfigSchema.safeParse({
      ...REQUIRED_ENV,
      SITE_TEMPLATE_PATH: '../x.xlsx',
    });
    expect(result.success).toBe(false);
  });

  test('виды документов: список из известных, неизвестный вид - ошибка', () => {
    expect(configWith({ DOCUMENTS_ENABLED_KINDS: 'invoice,contract' }).DOCUMENTS_ENABLED_KINDS)
      .toEqual(['invoice', 'contract']);
    expect(
      pragmatikaConfigSchema.safeParse({ ...REQUIRED_ENV, DOCUMENTS_ENABLED_KINDS: 'invoice,x' })
        .success,
    ).toBe(false);
  });

  test('карта полей сделки: только проверка JSON', () => {
    expect(configWith({ BITRIX24_DEAL_FIELD_MAP: '{"a":"b"}' }).BITRIX24_DEAL_FIELD_MAP).toEqual({
      a: 'b',
    });
    expect(
      pragmatikaConfigSchema.safeParse({ ...REQUIRED_ENV, BITRIX24_DEAL_FIELD_MAP: '{не json' })
        .success,
    ).toBe(false);
  });

  test('флаги принимают только true или false', () => {
    expect(
      pragmatikaConfigSchema.safeParse({ ...REQUIRED_ENV, SUPPLIER_CARDS_ENABLED: 'yes' }).success,
    ).toBe(false);
    expect(configWith({ SUPPLIER_CARDS_ENABLED: 'true' }).SUPPLIER_CARDS_ENABLED).toBe('true');
  });
});

describe('проверки связей между переменными', () => {
  const NO_MAILBOX = { employeeMailboxEnabled: false };

  test('по умолчанию связей нарушено нет', () => {
    expect(crossCheckErrors(configWith(), NO_MAILBOX)).toEqual([]);
  });

  test('выгрузка поставщиков требует карточки', () => {
    const config = configWith({ SUPPLIER_EXPORT_ENABLED: 'true' });
    expect(crossCheckErrors(config, NO_MAILBOX)).toEqual([
      'SUPPLIER_EXPORT_ENABLED требует SUPPLIER_CARDS_ENABLED',
    ]);
    const withCards = configWith({
      SUPPLIER_EXPORT_ENABLED: 'true',
      SUPPLIER_CARDS_ENABLED: 'true',
    });
    expect(crossCheckErrors(withCards, NO_MAILBOX)).toEqual([]);
  });

  test('Telegram-источник требует токен читателя', () => {
    const config = configWith({ TELEGRAM_CHANNEL_SOURCE_ENABLED: 'true' });
    expect(crossCheckErrors(config, NO_MAILBOX)).toEqual([
      'TELEGRAM_CHANNEL_SOURCE_ENABLED требует TELEGRAM_READER_TOKEN',
    ]);
  });

  test('предложения по письмам требуют почту сотрудников и реквизиты своей компании', () => {
    const config = configWith({ SUPPLIER_MAIL_PROPOSALS_ENABLED: 'true' });
    expect(crossCheckErrors(config, NO_MAILBOX)).toEqual([
      'SUPPLIER_MAIL_PROPOSALS_ENABLED требует EMPLOYEE_MAILBOX_ENABLED',
      'SUPPLIER_MAIL_PROPOSALS_ENABLED требует OWN_COMPANY_REQUISITES',
    ]);
    expect(() => assertCrossChecks(config, NO_MAILBOX)).toThrow(/Некорректная конфигурация/);
  });

  test('сборка с нарушенной связью падает на старте, не на первой просьбе', () => {
    expect(() => buildPragmatika({ TELEGRAM_CHANNEL_SOURCE_ENABLED: 'true' })).toThrow(
      /TELEGRAM_READER_TOKEN/,
    );
  });
});
