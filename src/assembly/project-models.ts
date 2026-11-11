import type { FetchFn } from '@business-ai/adapters';
import type { ModelGateway, PlatformServices } from '@business-ai/core';
import { composeHttpApp, createOperatorAlerter } from '@business-ai/core/compose';
import type { ProductionConfig } from '@business-ai/core/compose';
import { PROJECT_EXTERNAL_TEXT_TOOL_NAMES } from '../agents/shared/external-text-tools.owned';
import type { PragmatikaConfig } from '../config';

/** Внешние инструменты, которым токены восстанавливаются без проверки ПДн (веб-поиск). */
const PII_ALLOWED_TOOLS: ReadonlySet<string> = new Set(['searchInternet']);

/** Сервисы платформы, которые нужны шлюзу проекта. */
export type ProjectModelsServices = Pick<
  PlatformServices,
  'chat' | 'clock' | 'telemetry' | 'webSearchQueryPiiAllowed'
>;

/** Что нужно для шлюза проекта: конфигурация сборки и платформенные сервисы. */
export interface ProjectModelsInput {
  config: ProductionConfig<PragmatikaConfig>;
  services: ProjectModelsServices;
  /** Тред оператора: туда уходят оповещения о постоянных сбоях шлюза моделей. */
  alertThreadId: string;
}

/** Подмены для тестов: сеть. */
export interface ProjectModelsOverrides {
  fetchFn?: FetchFn | undefined;
}

/**
 * Шлюзы проекта по сервисам сборки. Платформа свой шлюз (`PlatformServices.models`) проекту не
 * отдаёт, поэтому проект строит собственный; он должен быть ОДИН на сборку: у каждого шлюза свой
 * предел одновременных запросов к псевдонимизатору (`PSEUDONYMIZER_MAX_INFLIGHT`) и своё
 * ограничение частоты оповещений, и лишние экземпляры умножали бы и то и другое.
 */
const gatewayByServices = new WeakMap<ProjectModelsServices, ModelGateway>();

/**
 * Шлюз модели с псевдонимизацией для вызовов вне агентского цикла (оценка писем, рейтинг,
 * разбор страниц). Первый вызов строит шлюз, остальные получают тот же: все пути проекта делят
 * один предел `PSEUDONYMIZER_MAX_INFLIGHT`. Подмены (`overrides`) действуют только при
 * построении. Предел платформенного шлюза агентского цикла отдельный (пробел платформы G-1).
 */
export function projectModels(
  input: ProjectModelsInput,
  overrides: ProjectModelsOverrides = {},
): ModelGateway {
  const { config, services, alertThreadId } = input;
  const existing = gatewayByServices.get(services);
  if (existing !== undefined) return existing;
  const alerter = createOperatorAlerter({
    chat: services.chat,
    threadId: alertThreadId,
    clock: services.clock,
  });
  // Токены в аргументах веб-поиска восстанавливаются без проверки ПДн только со шлюзовым поиском.
  const piiAllowed = services.webSearchQueryPiiAllowed ? PII_ALLOWED_TOOLS : undefined;
  const gateway = composeHttpApp(
    config,
    overrides.fetchFn,
    alerter,
    piiAllowed,
    services.telemetry,
    config.modelPrices,
    new Set(PROJECT_EXTERNAL_TEXT_TOOL_NAMES),
  ).outOfLoopModels;
  gatewayByServices.set(services, gateway);
  return gateway;
}
