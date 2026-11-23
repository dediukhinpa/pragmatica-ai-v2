import { HttpEmbedder, PostgresPairNoteStore, type PgClient } from '@business-ai/adapters';
import type { PairNoteStore } from '@business-ai/core';
import type { ProductionConfig } from '@business-ai/core/compose';
import { ProjectKnowledgeSearch } from './adapters/knowledge-search';
import { PostgresContractNumbering } from './kit/adapters/postgres/contract-numbering';
import { PostgresImportStaging } from './kit/adapters/postgres/import-staging';
import {
  PostgresOwnLegalEntityRepository,
} from './kit/adapters/postgres/own-legal-entity-repository';
import { PostgresPriceRepository } from './kit/adapters/postgres/price-repository';
import { PostgresPriceTableIndex } from './kit/adapters/postgres/price-table-index';
import {
  PostgresPurchaseRequestRepository,
} from './kit/adapters/postgres/purchase-request-repository';
import { PostgresSupplierPriceScripts } from './kit/adapters/postgres/supplier-price-scripts';
import { PostgresSupplierQuoteRepository } from './kit/adapters/postgres/supplier-quote-repository';
import { PostgresSupplierRatingCache } from './kit/adapters/postgres/supplier-rating-cache';
import { PostgresSupplierRepository } from './kit/adapters/postgres/supplier-repository';
import type { KnowledgeSearch } from './kit/ports/knowledge-search.owned';
import type { ContractNumbering } from './kit/ports/contract-numbering';
import type { ImportStaging } from './kit/ports/import-staging';
import type { OwnLegalEntityRepository } from './kit/ports/own-legal-entities';
import type { PriceTableIndex } from './kit/ports/price-table-index';
import type {
  PriceRepository,
  PurchaseRequestRepository,
  SupplierRepository,
} from './kit/ports/repositories.owned';
import type { SupplierPriceScriptRepository } from './kit/ports/supplier-price-scripts';
import type { SupplierQuoteRepository } from './kit/ports/supplier-quote-repository';
import type { SupplierRatingCache } from './kit/ports/supplier-rating-cache';
import type { PragmatikaConfig } from './config';

/** Ключ, под которым порты Прагматики лежат в `ProjectContext.ports.extra`. */
export const PRAGMATIKA_PORTS_KEY = 'pragmatika';

/**
 * Репозитории проекта на общем пуле БД сборки. Строятся один раз в `ports(env)`: пул платформа
 * закрывает сама, проект его не закрывает.
 */
export interface PragmatikaPorts {
  readonly suppliers: SupplierRepository;
  readonly prices: PriceRepository;
  readonly requests: PurchaseRequestRepository;
  readonly staging: ImportStaging;
  readonly quotes: SupplierQuoteRepository;
  readonly ownLegalEntities: OwnLegalEntityRepository;
  readonly contractNumbering: ContractNumbering;
  readonly priceTables: PriceTableIndex;
  readonly priceScripts: SupplierPriceScriptRepository;
  readonly ratingCache: SupplierRatingCache;
  /** Личные заметки карточек: нужны карточкам и при выключенном `PAIR_NOTES_ENABLED`. */
  readonly pairNotes: PairNoteStore;
  /** Поиск по базе знаний с областью проекта (раздел поставщиков, один поставщик). */
  readonly knowledge: KnowledgeSearch;
}

/** Что нужно сборке портов от платформы: пул БД и платформенная часть конфигурации. */
export interface PragmatikaPortsEnv {
  db: PgClient;
  config: ProductionConfig<PragmatikaConfig>;
}

/**
 * Собрать репозитории Прагматики. Поиск по строкам прайсов использует тот же сервис
 * эмбеддингов, что и база знаний платформы; его сбой оставляет поиск по словам, а импорт не
 * роняет (логика внутри `PostgresPriceRepository`).
 */
export function buildPragmatikaPorts(env: PragmatikaPortsEnv): PragmatikaPorts {
  const { db, config } = env;
  const embedder = new HttpEmbedder({
    baseUrl: config.embeddings.baseUrl,
    timeoutMs: config.embeddings.timeoutMs,
  });
  return {
    suppliers: new PostgresSupplierRepository(db),
    prices: new PostgresPriceRepository(db, {
      embedder,
      minCosine: config.project.PRICE_SEARCH_MIN_COSINE,
      log: (event, fields) => {
        console.log(JSON.stringify({ event, ...fields }));
      },
    }),
    requests: new PostgresPurchaseRequestRepository(db),
    staging: new PostgresImportStaging(db),
    quotes: new PostgresSupplierQuoteRepository(db),
    ownLegalEntities: new PostgresOwnLegalEntityRepository(db),
    contractNumbering: new PostgresContractNumbering(db),
    priceTables: new PostgresPriceTableIndex(db),
    priceScripts: new PostgresSupplierPriceScripts(db),
    ratingCache: new PostgresSupplierRatingCache(db),
    pairNotes: new PostgresPairNoteStore(db),
    knowledge: new ProjectKnowledgeSearch(db, embedder),
  };
}

/** Достать порты Прагматики из `ports.extra`; нет - ошибка сборки (программная). */
export function pragmatikaPortsOf(
  extra: Readonly<Record<string, unknown>> | undefined,
): PragmatikaPorts {
  const found = extra?.[PRAGMATIKA_PORTS_KEY];
  if (typeof found !== 'object' || found === null || !('suppliers' in found)) {
    throw new Error('Порты Прагматики не собраны: ports(env) манифеста не вызывался');
  }
  return found as PragmatikaPorts;
}
