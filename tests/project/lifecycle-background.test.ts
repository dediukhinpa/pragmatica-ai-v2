import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryChatChannel, MemoryCrm, MemoryMailboxDirectory } from '@business-ai/adapters';
import { composeProduction, loadProductionConfig, tempDir } from '@business-ai/testing';
import type { ProductionConfig } from '@business-ai/core/compose';
import { pragmatikaProject, type PragmatikaConfig } from '../../src';
import { clearPragmatikaRuntime, pragmatikaRuntime } from '../../src/runtime';
import { nullDb, pragmatikaEnv } from './support';

/**
 * Разовые команды владельца (проход по общему ящику, обследование доверия, проход по CRM) берут
 * зависимости из собранного приложения, как раньше из `ProductionApp`: состояние должно
 * появляться после сборки агентов, а почта и порт CRM - определять, что доступно.
 */

const ADDRESS = 'info@company.test';
const REQUISITES = 'ООО Тест, ИНН 7701234567';
const MAILBOXES_FILE_MODE = 0o600;
const MAILBOXES_FILE = {
  version: 1,
  mailboxes: [
    {
      employeeId: 'info-source',
      kind: 'source',
      address: ADDRESS,
      mode: 'shared_folder',
      read: { login: 'reader', secret: 'test-secret', inboxFolder: 'INBOX', sentFolder: 'Sent' },
    },
  ],
};

/** Файл ящиков и адреса сервера почты на выдуманных значениях: соединений сборка не открывает. */
function mailEnv(): Record<string, string> {
  const file = join(tempDir(), 'mailboxes.json');
  writeFileSync(file, JSON.stringify(MAILBOXES_FILE), { mode: MAILBOXES_FILE_MODE });
  chmodSync(file, MAILBOXES_FILE_MODE);
  return {
    EMPLOYEE_MAILBOX_ENABLED: 'true',
    OWN_COMPANY_REQUISITES: REQUISITES,
    MAIL_MAILBOXES_FILE: file,
    MAIL_IMAP_HOST: 'imap.test',
    MAIL_SMTP_HOST: 'smtp.test',
    MAIL_ALLOW_PLAINTEXT: 'true',
  };
}

afterEach(() => {
  clearPragmatikaRuntime();
});

function build(envExtra: Record<string, string>, mailConnected: boolean): void {
  const config = loadProductionConfig(pragmatikaEnv(envExtra));
  const db = nullDb();
  const extra = pragmatikaProject.ports?.({
    config: config as unknown as ProductionConfig<PragmatikaConfig>,
    portal: undefined,
    db,
  });
  composeProduction(
    config,
    {
      chat: new MemoryChatChannel(),
      crm: new MemoryCrm(new Map()),
      ...(mailConnected ? { mailboxes: new MemoryMailboxDirectory() } : {}),
      ...(extra ? { extra } : {}),
    },
    { db, mailWarmUp: false },
  );
}

describe('зависимости разовых команд в состоянии приложения', () => {
  test('почта не подключена: применять отчёт можно, прохода по ящику и обследования нет', () => {
    build({ INFO_MAILBOX_ENRICH_ADDRESS: ADDRESS }, false);
    const background = pragmatikaRuntime()?.background;
    expect(background).toBeDefined();
    expect(background?.mailBackfill.scanDeps).toBeUndefined();
    expect(background?.mailBackfill.applyDeps.suppliers).toBeDefined();
    expect(background?.mailBackfill.defaultAddress).toBe(ADDRESS);
    expect(background?.mailSurvey()).toBeUndefined();
    expect(background?.crmPass).toBeUndefined();
  });

  test('почта подключена: проход по ящику получает зависимости под адрес источника', () => {
    build(
      {
        EMPLOYEE_MAILBOX_ENABLED: 'true',
        OWN_COMPANY_REQUISITES: REQUISITES,
        INFO_MAILBOX_ENRICH_ADDRESS: ADDRESS,
        INFO_MAILBOX_ENRICH_MAX_CLASSIFY_PER_RUN: '77',
        INFO_MAILBOX_ENRICH_WINDOW_DAYS: '31',
      },
      true,
    );
    const { mailBackfill } = pragmatikaRuntime()?.background ?? {};
    expect(mailBackfill?.maxModelCalls).toBe(77);
    expect(mailBackfill?.windowDays).toBe(31);
    expect(mailBackfill?.ownCompanyRequisites).toEqual([REQUISITES]);
    const deps = mailBackfill?.scanDeps?.(ADDRESS);
    expect(deps?.sourceAddress).toBe(ADDRESS);
    expect(deps?.ownCompanyRequisites).toEqual([REQUISITES]);
    expect(deps?.mailboxes).toBeDefined();
  });
});

describe('обследование доверия', () => {
  test('собирается при вызове: каталог ящиков в памяти, источник - адрес из настройки', () => {
    build({ ...mailEnv(), INFO_MAILBOX_ENRICH_ADDRESS: ADDRESS }, false);
    const background = pragmatikaRuntime()?.background;
    const deps = background?.mailSurvey();
    expect(deps?.sourceAddress).toBe(ADDRESS);
    expect(deps?.ownCompanyRequisites).toEqual([REQUISITES]);
    expect(deps?.mailboxes).toBeDefined();
    // Каждый вызов - свой каталог: общий с работающей службой не используется.
    expect(background?.mailSurvey()?.mailboxes).not.toBe(deps?.mailboxes);
  });
});
