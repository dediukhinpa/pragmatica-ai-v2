import {
  EXPECTED_SCHEMA_VERSION,
  MemoryChatChannel,
  MemoryCrm,
  type PgClient,
  type PgRow,
} from '@business-ai/adapters';
import { composeProduction, loadProductionConfig, tempDir } from '@business-ai/testing';
import type { ProductionConfig } from '@business-ai/core/compose';
import { pragmatikaProject, type PragmatikaConfig } from '../../src';

/** Минимальное боевое окружение Прагматики на выдуманных адресах (реальных значений нет). */
export function pragmatikaEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PSEUDONYMIZER_URL: 'http://pseudonymizer.test',
    PSEUDONYMIZER_API_TOKEN: 'test-pseudonymizer-token',
    LITELLM_BASE_URL: 'http://litellm.test',
    LITELLM_API_KEY: 'sk-test',
    DATABASE_URL: 'postgres://app:pw@db.test:5432/agentplatform',
    DOCUMENTS_URL: 'http://documents.test',
    EMBEDDINGS_URL: 'http://embeddings.test',
    FILES_ROOT: tempDir(),
    INTAKE_ROOT: tempDir(),
    PRICES_FILES_ROOT: tempDir(),
    TEMPLATES_FILES_ROOT: tempDir(),
    OWNER_THREAD_ID: 'owner-1',
    OWN_COMPANY_NAMES: 'Тестовая компания',
    PRICES_MODEL: 'prices-alias',
    DOCUMENTS_MODEL: 'documents-alias',
    ORDER_CALC_MODEL: 'order-calc-alias',
    SITE_EXPORT_MODEL: 'site-export-alias',
    MASK_URL: 'http://mask.test',
    MASK_TOKEN: 'test-mask-token',
    ...extra,
  };
}

/** Клиент БД, который ничего не хранит: сеть и настоящая база не нужны. */
export function nullDb(): PgClient {
  const client: PgClient = {
    async query(text): Promise<PgRow[]> {
      if (text.includes('RETURNING key')) return [{ key: 'reserved' }];
      if (text.includes('schema_migrations')) return [{ version: EXPECTED_SCHEMA_VERSION }];
      return [];
    },
    transaction: async (run) => run(client),
    close: async () => undefined,
  };
  return client;
}

/** Боевая сборка Прагматики на заглушках в памяти. */
export function buildPragmatika(envExtra: Record<string, string> = {}) {
  const config = loadProductionConfig(pragmatikaEnv(envExtra));
  const db = nullDb();
  // Порты проекта строит запускающий (main.ts) на общем клиенте БД; тест делает то же.
  const extra = pragmatikaProject.ports?.({
    config: config as unknown as ProductionConfig<PragmatikaConfig>,
    portal: undefined,
    db,
  });
  const app = composeProduction(
    config,
    { chat: new MemoryChatChannel(), crm: new MemoryCrm(new Map()), ...(extra ? { extra } : {}) },
    { db },
  );
  return { config, app };
}
