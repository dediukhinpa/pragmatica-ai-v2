import { describe, expect, test } from 'bun:test';
import { knownAccessActions } from '@business-ai/core';
import { PRAGMATIKA_MODELS, pragmatikaConfigSchema } from '../../src/config';
import { pragmatikaProject } from '../../src/project';

/**
 * Встроенные списки сняты с эталона прежней сборки (stage-0/baseline): имена, обязательность и
 * умолчания предметных переменных, действия доступа, переменные моделей. Значений окружения
 * заказчика здесь нет.
 */

/** Обязательная переменная без умолчания. */
const REQUIRED = Symbol('required');

/** Предметные переменные Прагматики: имя и умолчание прежней схемы окружения. */
const PROJECT_ENV_DEFAULTS: ReadonlyArray<readonly [string, unknown]> = [
  ['DOCUMENTS_ENABLED_KINDS', undefined],
  ['DOCUMENTS_CONTRACT_TIMEOUT_MS', 600000],
  ['PRICES_FILES_ROOT', REQUIRED],
  ['TEMPLATES_FILES_ROOT', REQUIRED],
  ['TEMPLATES_PREFIX', undefined],
  ['CONTRACT_REGISTRY_PATH', undefined],
  ['SITE_TEMPLATE_PATH', undefined],
  ['MANAGER_THREAD_ID', undefined],
  ['PRICE_RESPONSIBLE_THREAD_ID', undefined],
  ['PRICE_STAFF_DEPARTMENT', undefined],
  ['PRICE_STAFF_EXTRA_USER_IDS', undefined],
  ['PRICE_RECIPIENT_OPEN_THREAD', 'false'],
  ['PRICE_STALE_SCAN_PREFIXES', undefined],
  ['PRICE_STALE_EXCLUDE_PATTERN', undefined],
  ['PRICE_STALE_CONTENT_CHECK', 'false'],
  ['PRICE_RECIPIENT_EXCLUDE_IDS', undefined],
  ['OWN_COMPANY_NAMES', REQUIRED],
  ['OWN_COMPANY_REQUISITES', undefined],
  ['AGENT_HANDOFF_ORDER_CALC_TO_PRICES', 'false'],
  ['AGENT_CALL_ENABLED', 'false'],
  ['BITRIX24_DEAL_FIELD_MAP', undefined],
  ['ORDER_CALC_INTAKE_ENABLED', 'false'],
  ['ORDER_CALC_COMPLETENESS_ENABLED', 'false'],
  ['ORDER_REMINDER_REPLY_ENABLED', 'false'],
  ['DOCUMENTS_COUNTERPARTY_AMEND_ENABLED', 'false'],
  ['OWN_REQUISITES_DB_ENABLED', 'false'],
  ['PRICES_MAILBOX_OWNER_USER_ID', undefined],
  ['PRICE_FILE_DATE_MODEL_FALLBACK', 'false'],
  ['PRICE_MAIL_ASSESSOR_ENABLED', 'true'],
  ['SITE_TEXT_EDITOR_ENABLED', 'false'],
  ['PRICE_MAIL_SUPPLIER_ATTACHMENT_MAX_PER_RUN', 50],
  ['SUPPLIER_RATING_MODEL_ENABLED', 'true'],
  ['SHORTLIST_ATTACH_ENABLED', 'true'],
  ['SHORTLIST_XLSX_ENABLED', 'true'],
  ['WEB_SEARCH_MODEL_ENABLED', 'true'],
  ['WEB_HIT_CLASSIFY_ENABLED', 'true'],
  ['SUPPLIER_SITE_MODEL_ENABLED', 'true'],
  ['PRICE_RELEVANCE_ENABLED', 'true'],
  ['PRICE_RELEVANCE_MAX_NAMES', 150],
  ['PRICE_SEARCH_MIN_COSINE', 0.83],
  ['WEB_ENRICH_MAX_CANDIDATES', 10],
  ['WEB_ENRICH_MAX_QUERIES', 10],
  ['WEB_ENRICH_CONCURRENCY', 3],
  ['WEB_ENRICH_SUPPLIERS_ENABLED', 'false'],
  ['TELEGRAM_CHANNEL_SOURCE_ENABLED', 'false'],
  ['TELEGRAM_READER_TOKEN', undefined],
  ['TELEGRAM_SEARCH_MAX_POSTS', 20],
  ['TELEGRAM_SEARCH_TIMEOUT_MS', 30000],
  ['TELEGRAM_READER_BASE_URL', undefined],
  ['TELEGRAM_CHANNELS', undefined],
  ['WEB_SEARCH_MAX_PER_TURN', 20],
  ['SUPPLIER_CARDS_ENABLED', 'false'],
  ['SUPPLIER_EXPORT_ENABLED', 'false'],
  ['SUPPLIER_TEMPLATE_PATH', '/app/templates/supplier-template.xlsx'],
  ['PRICE_DISK_SYNC_ENABLED', 'false'],
  ['PRICE_DISK_INITIAL_IMPORT_ENABLED', 'false'],
  ['INFO_MAILBOX_ENRICH_ADDRESS', undefined],
  ['INFO_MAILBOX_ENRICH_MAX_CLASSIFY_PER_RUN', 500],
  ['INFO_MAILBOX_ENRICH_WINDOW_DAYS', 730],
  ['SUPPLIER_MAIL_PROPOSALS_ENABLED', 'false'],
  ['SUPPLIER_MAIL_PROPOSALS_AUTO_ENRICH_ENABLED', 'false'],
  ['SUPPLIER_MAIL_PROPOSALS_INTERVAL_DAYS', 3],
  ['SUPPLIER_MAIL_PROPOSALS_CHECK_HOUR', 10],
  ['SUPPLIER_MAIL_PROPOSALS_WINDOW_DAYS', 7],
  ['SUPPLIER_MAIL_PROPOSALS_MAX_CLASSIFY_PER_RUN', 40],
  ['CRM_SUPPLIERS_COMPANY_TYPE', undefined],
  ['CRM_SUPPLIERS_CATEGORY_ID', undefined],
  ['ORDER_DIGEST_OPEN_MAX_DAYS', 14],
  ['BUSINESS_TIMEZONE', 'Europe/Moscow'],
];

/** Минимум, без которого предметная схема не разбирает окружение. */
const REQUIRED_ENV = {
  PRICES_FILES_ROOT: '/files/prices',
  TEMPLATES_FILES_ROOT: '/files/templates',
  OWN_COMPANY_NAMES: 'Тестовая компания',
};

/** Действия доступа прежнего реестра (11): платформенные и проектные вместе. */
const BASELINE_ACCESS_ACTIONS = [
  'chat.button',
  'chat.file',
  'chat.message',
  'documents.update_own_requisites',
  'mail.send_draft',
  'orders.confirm_selection',
  'orders.route_mail',
  'prices.confirm_jump',
  'site.confirm_publish',
  'suppliers.confirm_card',
  'suppliers.export',
];

describe('эталон прежней сборки', () => {
  test('реестр действий доступа: платформенные плюс проектные равны прежнему списку из 11', () => {
    const known = [...knownAccessActions(pragmatikaProject.accessActions)].sort();
    expect(known).toEqual([...BASELINE_ACCESS_ACTIONS].sort());
  });

  test('ограничения действий: выгрузка и подтверждение карточек - руководителям', () => {
    const { headOnlyActions, ruleRequiredActions } = pragmatikaProject.accessRestrictions;
    expect([...(headOnlyActions ?? [])].sort()).toEqual([
      'suppliers.confirm_card',
      'suppliers.export',
    ]);
    expect(ruleRequiredActions).toEqual(['documents.update_own_requisites']);
  });

  test('переменные моделей агентов', () => {
    expect(PRAGMATIKA_MODELS).toEqual({
      prices: 'PRICES_MODEL',
      documents: 'DOCUMENTS_MODEL',
      'order-calc': 'ORDER_CALC_MODEL',
      'site-export': 'SITE_EXPORT_MODEL',
    });
  });

  test('схема знает ровно предметные переменные эталона', () => {
    const names = Object.keys(pragmatikaConfigSchema.shape).sort();
    expect(names).toEqual(PROJECT_ENV_DEFAULTS.map(([name]) => name).sort());
  });

  test('умолчания и обязательность совпадают с прежней схемой', () => {
    const parsed = pragmatikaConfigSchema.parse(REQUIRED_ENV) as Record<string, unknown>;
    for (const [name, expected] of PROJECT_ENV_DEFAULTS) {
      if (expected === REQUIRED) {
        expect(Object.hasOwn(REQUIRED_ENV, name)).toBe(true);
        const { [name as keyof typeof REQUIRED_ENV]: _omitted, ...rest } = REQUIRED_ENV;
        expect(pragmatikaConfigSchema.safeParse(rest).success).toBe(false);
      } else if (Object.hasOwn(REQUIRED_ENV, name)) {
        continue;
      } else {
        expect([name, parsed[name]]).toEqual([name, expected]);
      }
    }
  });
});
