import { describe, expect, test } from 'bun:test';
import { DEFAULT_ATTACHMENT_MAX_BYTES, DEFAULT_ATTACHMENT_MAX_FILES } from '@business-ai/adapters';
import { parseChatAttachmentsConfig } from '../../src/chat-attachments';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe('разбор настроек хранения файлов чата', () => {
  test('пустое окружение даёт умолчания', () => {
    expect(parseChatAttachmentsConfig({})).toEqual({
      enabled: true,
      retentionDays: 30,
      maxBytes: 3 * GIB,
      maxFileBytes: 20 * MIB,
      maxFilesPerThreadDay: 100,
    });
  });

  test('умолчания размера и числа файлов берутся из констант платформы', () => {
    const config = parseChatAttachmentsConfig({});
    expect(config.maxFileBytes).toBe(DEFAULT_ATTACHMENT_MAX_BYTES);
    expect(config.maxFilesPerThreadDay).toBe(DEFAULT_ATTACHMENT_MAX_FILES * 10);
  });

  test('выключатели: false, 0, no, off в любом регистре', () => {
    for (const value of ['false', '0', 'no', 'off', 'FALSE', 'Off', ' No ']) {
      expect(parseChatAttachmentsConfig({ CHAT_ATTACHMENTS_STORE_ENABLED: value }).enabled).toBe(
        false,
      );
    }
    for (const value of ['true', '1', 'yes', 'on', '', 'мусор']) {
      expect(parseChatAttachmentsConfig({ CHAT_ATTACHMENTS_STORE_ENABLED: value }).enabled).toBe(
        true,
      );
    }
  });

  test('срок хранения: целое 1..365, всё остальное даёт 30', () => {
    const days = (value: string): number =>
      parseChatAttachmentsConfig({ CHAT_ATTACHMENTS_RETENTION_DAYS: value }).retentionDays;
    expect(days('1')).toBe(1);
    expect(days('7')).toBe(7);
    expect(days('365')).toBe(365);
    for (const garbage of ['0', '-5', '366', '1000', '1.5', 'abc', '', '  ', '10d', 'NaN']) {
      expect(days(garbage)).toBe(30);
    }
  });

  test('предел объёма архива: целое больше нуля, мусор даёт 3 ГиБ', () => {
    const bytes = (value: string): number =>
      parseChatAttachmentsConfig({ CHAT_ATTACHMENTS_MAX_BYTES: value }).maxBytes;
    expect(bytes('1048576')).toBe(MIB);
    for (const garbage of ['0', '-1', '1.5', 'много', '', '1e3', '99999999999999999999999']) {
      expect(bytes(garbage)).toBe(3 * GIB);
    }
  });

  test('предел файла: из B24_ATTACHMENT_MAX_BYTES, потолок 100 МиБ, мусор даёт 20 МиБ', () => {
    const limit = (value: string): number =>
      parseChatAttachmentsConfig({ B24_ATTACHMENT_MAX_BYTES: value }).maxFileBytes;
    expect(limit('5242880')).toBe(5 * MIB);
    expect(limit(String(100 * MIB))).toBe(100 * MIB);
    expect(limit(String(500 * MIB))).toBe(100 * MIB);
    for (const garbage of ['0', '-1', 'abc', '', '2.5']) expect(limit(garbage)).toBe(20 * MIB);
  });

  test('файлов на тред за сутки: B24_ATTACHMENT_MAX_FILES x 10, потолок 500', () => {
    const files = (value: string): number =>
      parseChatAttachmentsConfig({ B24_ATTACHMENT_MAX_FILES: value }).maxFilesPerThreadDay;
    expect(files('5')).toBe(50);
    expect(files('50')).toBe(500);
    expect(files('80')).toBe(500);
    for (const garbage of ['0', '-3', 'x', '', '1.5']) expect(files(garbage)).toBe(100);
  });

  test('значения undefined и лишние переменные не мешают', () => {
    const config = parseChatAttachmentsConfig({
      CHAT_ATTACHMENTS_RETENTION_DAYS: undefined,
      SOMETHING_ELSE: 'x',
    });
    expect(config.retentionDays).toBe(30);
  });
});
