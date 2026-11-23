import type { ModelGateway, PlatformServices } from '@business-ai/core';
import type { ProductionConfig } from '@business-ai/core/compose';
import type { OrderCalcDeps } from '../agents/order-calc';
import { TelegramPostCache } from '../agents/order-calc/telegram-source';
import type { PricesDeps } from '../agents/prices';
import type { SiteExportDeps } from '../agents/site-export';
import type { PragmatikaConfig } from '../config';
import { HttpTelegramChannelSource } from '../kit/adapters/http/http-telegram-channel-source';
import { ModelPriceFileDateFallback } from '../kit/adapters/litellm/price-file-date-model-fallback';
import { ModelPriceMailAssessor } from '../kit/adapters/litellm/price-mail-model-assessor';
import { ModelPriceRelevanceChecker } from '../kit/adapters/litellm/price-relevance-model';
import { ModelShortlistComparer } from '../kit/adapters/litellm/shortlist-model-comparer';
import { ModelSiteTextEditor } from '../kit/adapters/litellm/site-text-model-editor';
import { ModelSupplierRater } from '../kit/adapters/litellm/supplier-model-rater';
import { ModelTelegramPostExtractor } from '../kit/adapters/litellm/telegram-post-extractor';
import {
  ModelSitePagePicker,
  ModelSupplierSiteChooser,
  ModelWebCandidateEnricher,
  ModelWebHitClassifier,
  ModelWebQueryPlanner,
} from '../kit/adapters/litellm/web-candidate-model';
import type { PragmatikaPorts } from '../ports';

/** Всё, что нужно подключению адаптеров на модели. */
export interface ModelAdapterInput {
  /** Шлюз модели с псевдонимизацией: наружу без неё модель не выдаётся. */
  models: ModelGateway;
  config: ProductionConfig<PragmatikaConfig>;
  services: PlatformServices;
  ports: PragmatikaPorts;
  /** Алиасы моделей агентов (id агента -> алиас). */
  modelOf(agentId: string): string;
  /** Почта подключена по-настоящему (не заглушка): без неё оценка писем не создаётся. */
  mailConnected: boolean;
  /** Есть Яндекс-поиск и прямой читатель страниц: нужен обогащению карточек базы. */
  yandexReady: boolean;
  prices: PricesDeps;
  orderCalc: OrderCalcDeps;
  siteExport: SiteExportDeps;
}

/**
 * Подключить адаптеры, которые ходят в модель вне агентского цикла. Все идут через переданный
 * шлюз с псевдонимизацией и алиас агента-владельца; отдельных алиасов нет. Условия те же, что
 * были в сборке до манифеста: флаг выключен - порта нет, поведение прежнее.
 */
export function attachModelAdapters(input: ModelAdapterInput): void {
  const { models, services, modelOf, prices, orderCalc, siteExport } = input;
  const project = input.config.project;
  const pricesModel = modelOf('prices');
  const orderCalcModel = modelOf('order-calc');
  // Сжатие и орфография описаний сайта.
  if (project.SITE_TEXT_EDITOR_ENABLED === 'true') {
    siteExport.textEditor = new ModelSiteTextEditor(models, modelOf('site-export'));
  }
  // Запасной разбор даты из названия прайса.
  if (project.PRICE_FILE_DATE_MODEL_FALLBACK === 'true') {
    prices.priceDateFallback = new ModelPriceFileDateFallback(models, pricesModel);
  }
  // Оценка прайс-писем: только при реально подключённой почте.
  if (input.mailConnected && project.PRICE_MAIL_ASSESSOR_ENABLED === 'true') {
    prices.mailAssessor = new ModelPriceMailAssessor(models, pricesModel);
  }
  // Рейтинг и сравнение кандидатов шорт-листа.
  if (project.SUPPLIER_RATING_MODEL_ENABLED === 'true') {
    orderCalc.supplierRating = {
      rater: new ModelSupplierRater(models, orderCalcModel),
      cache: input.ports.ratingCache,
    };
    orderCalc.shortlistCompare = { comparer: new ModelShortlistComparer(models, orderCalcModel) };
  }
  // Проверка строк прайсов моделью.
  if (project.PRICE_RELEVANCE_ENABLED === 'true') {
    orderCalc.priceRelevance = new ModelPriceRelevanceChecker(models, orderCalcModel);
    orderCalc.priceRelevanceMaxNames = project.PRICE_RELEVANCE_MAX_NAMES;
  }
  if (project.WEB_SEARCH_MODEL_ENABLED === 'true') attachWebModels(input, orderCalcModel);
  if (project.TELEGRAM_CHANNEL_SOURCE_ENABLED === 'true') attachTelegram(input, orderCalcModel);
}

/** Веб-поиск поставщиков с моделью: запросы, обогащение кандидатов, выбор сайтов. */
function attachWebModels(input: ModelAdapterInput, orderCalcModel: string): void {
  const { models, services, orderCalc, config } = input;
  const project = config.project;
  orderCalc.webQueryPlanner = new ModelWebQueryPlanner(models, orderCalcModel);
  orderCalc.webEnrichBudget = {
    maxCandidates: project.WEB_ENRICH_MAX_CANDIDATES,
    maxQueries: project.WEB_ENRICH_MAX_QUERIES,
    concurrency: project.WEB_ENRICH_CONCURRENCY,
  };
  if (project.WEB_ENRICH_SUPPLIERS_ENABLED === 'true' && input.yandexReady) {
    orderCalc.supplierEnrich = { concurrency: project.WEB_ENRICH_CONCURRENCY };
  }
  // Страницы сайтов поставщиков - публичные данные: при отдельном маршруте шлюза извлечение
  // идёт мимо псевдонимизации, а при отказе шлюза - разбором кодом.
  const routed = config.agents.webPageModelRoute && services.webPageModels !== undefined;
  const pageModels =
    routed && services.webPageModels !== undefined ? services.webPageModels : models;
  const strip = services.webPagePiiStrip;
  orderCalc.webEnricher = routed
    ? new ModelWebCandidateEnricher(pageModels, orderCalcModel, {
        ...strip,
        codeFallback: true,
        onFallback: (code) => services.log('web_enrich_page_fallback', { code }),
      })
    : new ModelWebCandidateEnricher(models, orderCalcModel, strip);
  if (project.SUPPLIER_SITE_MODEL_ENABLED === 'true') {
    orderCalc.supplierSiteChooser = new ModelSupplierSiteChooser(pageModels, orderCalcModel, strip);
    orderCalc.sitePagePicker = new ModelSitePagePicker(pageModels, orderCalcModel, strip);
  }
  if (project.WEB_HIT_CLASSIFY_ENABLED === 'true') {
    orderCalc.webClassifier = new ModelWebHitClassifier(models, orderCalcModel);
  }
}

/** Закрытый Telegram-канал как источник шорт-листа. */
function attachTelegram(input: ModelAdapterInput, orderCalcModel: string): void {
  const { models, services, orderCalc, config } = input;
  const project = config.project;
  if (project.TELEGRAM_READER_TOKEN === undefined) return;
  orderCalc.telegramChannel = {
    source: new HttpTelegramChannelSource({
      baseUrl: project.TELEGRAM_READER_BASE_URL ?? config.model.baseUrl,
      timeoutMs: project.TELEGRAM_SEARCH_TIMEOUT_MS,
      channels: project.TELEGRAM_CHANNELS ?? [],
      token: project.TELEGRAM_READER_TOKEN,
      telemetry: services.telemetry,
    }),
    // Текст постов до модели очищается всегда; модель идёт через шлюз с псевдонимизацией.
    extractor: new ModelTelegramPostExtractor(models, orderCalcModel, {
      onReport: services.webPagePiiStrip.onReport,
    }),
    maxPosts: project.TELEGRAM_SEARCH_MAX_POSTS,
    // Кэш разбора постов живёт в памяти процесса.
    cache: new TelegramPostCache(),
  };
}
