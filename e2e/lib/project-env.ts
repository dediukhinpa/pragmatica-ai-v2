/**
 * Окружение сквозных сценариев Прагматики поверх мира платформы (`@business-ai/testing/e2e`).
 *
 * Платформенный мир знает один каталог файлов и нейтральные имена; Прагматика держит ещё корни
 * прайсов и шаблонов, четыре модели агентов и свои порты (сотрудники, руководители). Этот файл
 * оставляет сценариям прежние сигнатуры `buildApp(deals, overrides, external)` и `e2eEnv()`.
 * Сгенерированные сценарии импортируют его вместо `lib/env` старого репозитория.
 */
import {
  createPgClient,
  MemoryChatChannel,
  MemoryCrm,
  type PgClient,
} from '@business-ai/adapters';
import {
  chatHooksOf,
  effectiveSchedules,
  lifecycleOf,
  type DepartmentHeadDirectory,
  type MailboxDirectory,
  type StaffDirectory,
} from '@business-ai/core';
import type {
  createService,
  ExternalPorts,
  ProductionApp,
  ProductionConfig,
  ProductionOverrides,
} from '@business-ai/core/compose';
import {
  composeProduction as composeWithTestProject,
  loadProductionConfig,
  type TestConfig,
} from '@business-ai/testing';
import {
  E2E_API_KEY,
  e2eEnv as platformE2eEnv,
  requireEnv,
  type E2eEnv,
} from '@business-ai/testing/e2e';
import { pragmatikaProject, type PragmatikaConfig } from '../../src';
import type { PurchaseRequest } from '../../src/kit/domain/models';

export {
  E2E_API_KEY,
  attachChatPump,
  openDb,
  requireEnv,
} from '@business-ai/testing/e2e';

/** Тред менеджера в сценариях: сюда уходят отчёты и сводки владельцу работы. */
export const MANAGER_THREAD = 'e2e-manager';
/** Собственное юрлицо в сценариях (сторона документа, которой нет в базе поставщиков). */
export const OWN_COMPANY = 'ООО Прагматика';

/** Алиасы моделей агентов: по ним заглушка модели отличает агентов. */
export const E2E_MODELS = {
  PRICES_MODEL: 'e2e-prices',
  DOCUMENTS_MODEL: 'e2e-documents',
  ORDER_CALC_MODEL: 'e2e-order-calc',
  SITE_EXPORT_MODEL: 'e2e-site-export',
} as const;

/** Тексты и признаки платформы, которые она не экспортирует: сценарии сверяют ответ дословно. */
export const CHAT_HANDOFF_CLOSED_TEXT = 'Эта передача уже закрыта, ответ не нужен.';
export const CHAT_HANDOFF_EXPIRED_TEXT = 'Срок ответа истёк, передача закрыта. Повторите просьбу.';
/** Просьба оценить ответ (старая сборка слала её после каждого ответа). */
export const CHAT_FEEDBACK_PROMPT = 'Оцените, пожалуйста, ответ.';
export const EVENT_SKIPPED_NOTICE =
  'Не удалось обработать ваше сообщение. Повторите, пожалуйста, запрос.';

/** Итог остановки службы (платформа не экспортирует тип). */
export interface StopReport {
  /** Текущие задачи и ответы завершились до таймаута. */
  drained: boolean;
}

/** Адреса и пути окружения, поднятого run.sh, плюс корни файлов Прагматики. */
export interface ProjectE2eEnv extends E2eEnv {
  /** Корень прайсов (внутри платформенного `filesRoot`). */
  pricesRoot: string;
  /** Корень шаблонов документов (внутри платформенного `filesRoot`). */
  templatesRoot: string;
}

export function e2eEnv(): ProjectE2eEnv {
  const base = platformE2eEnv();
  return {
    ...base,
    pricesRoot: `${base.filesRoot}/prices`,
    templatesRoot: `${base.filesRoot}/templates`,
  };
}

/** Боевая конфигурация Прагматики, как её прочло бы приложение; `overrides` меняют значения. */
export function e2eConfig(overrides: Record<string, string> = {}): TestConfig {
  const env = e2eEnv();
  return loadProductionConfig({
    PSEUDONYMIZER_URL: env.pseudonymizerUrl,
    PSEUDONYMIZER_API_TOKEN: requireEnv('PSEUDONYMIZER_API_TOKEN'),
    LITELLM_BASE_URL: env.guardUrl,
    LITELLM_API_KEY: E2E_API_KEY,
    DATABASE_URL: env.databaseUrl,
    DOCUMENTS_URL: env.documentsUrl,
    EMBEDDINGS_URL: env.embeddingsUrl,
    FILES_ROOT: env.filesRoot,
    PRICES_FILES_ROOT: env.pricesRoot,
    TEMPLATES_FILES_ROOT: env.templatesRoot,
    INTAKE_ROOT: env.intakeRoot,
    // Файлы созданы только что: порог стабильности отключаем, иначе их не видно.
    STABLE_SECONDS: '0',
    OWNER_THREAD_ID: MANAGER_THREAD,
    OWN_COMPANY_NAMES: OWN_COMPANY,
    // Сценарии, кроме «текст с фото», читают картинки как раньше; режим задан явно.
    IMAGE_TEXT_MODE: 'log_only',
    ...E2E_MODELS,
    ...overrides,
  });
}

/** Параметры службы, которые в бою берутся из манифеста проекта (`main.ts` платформы). */
export type ProjectServiceOptions = Pick<
  Parameters<typeof createService>[0],
  'operatorThreadId' | 'schedules' | 'chatHooks' | 'lifecycle'
>;

/**
 * Плановые задачи, обработчики чата и жизненный цикл манифеста для `createService`: без них
 * служба e2e не запускает мониторинг и не знает кнопок, файлов и сценариев проекта.
 */
export function projectServiceOptions(config: TestConfig): ProjectServiceOptions {
  return {
    operatorThreadId: config.agents.ownerThreadId,
    schedules: effectiveSchedules(
      pragmatikaProject.schedules,
      config as unknown as ProductionConfig<PragmatikaConfig>,
    ),
    chatHooks: chatHooksOf(pragmatikaProject),
    lifecycle: lifecycleOf(pragmatikaProject),
  };
}

/**
 * Сборка приложения Прагматики: платформенная `composeProduction` на манифесте проекта плюс
 * порты проекта (`ProjectManifest.ports`), которые в бою строит `main.ts` на общем клиенте БД.
 * Клиент один на приложение и порты; закрывает его `app.close()`.
 */
export function composeProduction(
  config: TestConfig,
  external: ExternalPorts,
  overrides: ProductionOverrides = {},
): ProductionApp {
  const db =
    overrides.db ??
    createPgClient({ url: config.database.url, maxConnections: config.database.poolSize });
  const projectPorts = pragmatikaProject.ports?.({
    config: config as unknown as ProductionConfig<PragmatikaConfig>,
    portal: undefined,
    db,
  });
  const extra = { ...(projectPorts ?? {}), ...(external.extra ?? {}) };
  return composeWithTestProject(config, { ...external, extra }, { ...overrides, db });
}

/** Собранное приложение вместе с заглушками внешних портов, которые можно осмотреть. */
export interface E2eApp {
  app: ProductionApp;
  chat: MemoryChatChannel;
  crm: MemoryCrm;
  config: TestConfig;
}

/** Внешние порты, которые e2e подставляет вместо «не настроено». */
export interface E2eExternalPorts {
  /**
   * Ящики сотрудников. Если переданы, приложение собирается с `EMPLOYEE_MAILBOX_ENABLED=true`
   * (переменную можно переопределить в `overrides`); без них флаг выключен, как в бою.
   */
  mailboxes?: MailboxDirectory;
  /** Сотрудники отдела закупок с ФИО (адресная недельная сводка по прайсам). */
  staff?: StaffDirectory;
  /**
   * Руководители отделов. От них зависят права «только руководителям» (запись карточек
   * поставщиков и выгрузка): без справочника такие действия закрыты всем, как в бою.
   */
  heads?: DepartmentHeadDirectory;
}

/**
 * composeProduction на настоящих адаптерах (без подмены fetch и БД). Сделки портала в
 * сценариях не поддерживаются: разбор заявки по сделке не перенесён в v2 (пробел платформы).
 */
export function buildApp(
  deals: ReadonlyMap<string, PurchaseRequest> = new Map(),
  overrides: Record<string, string> = {},
  external: E2eExternalPorts = {},
): E2eApp {
  if (deals.size > 0) {
    throw new Error('Сделки портала в e2e v2 не поддерживаются: нет getPurchaseRequest в Crm');
  }
  const { mailboxes, staff, heads } = external;
  const flag = mailboxes === undefined ? {} : { EMPLOYEE_MAILBOX_ENABLED: 'true' };
  const config = e2eConfig({ ...flag, ...overrides });
  const chat = new MemoryChatChannel();
  const crm = new MemoryCrm();
  const ports = {
    chat,
    crm,
    ...(mailboxes === undefined ? {} : { mailboxes }),
    ...(staff === undefined ? {} : { staff }),
    ...(heads === undefined ? {} : { heads }),
  };
  return { app: composeProduction(config, ports), chat, crm, config };
}

/** Очистить таблицы сценария (знания не трогаем: их заполняет индексатор до тестов). */
export async function resetScenarioTables(db: PgClient): Promise<void> {
  await db.query(
    'TRUNCATE price_items, suppliers, idempotency_keys, threads, audit_log ' +
      'RESTART IDENTITY CASCADE',
  );
}
