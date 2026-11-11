import type { Bitrix24PortalClient } from '@business-ai/adapters';
import type { DealFieldMap } from './deal-field-map';
import { DealPurchaseRequestReader } from './deal-purchase-request';
import type { PurchaseRequestReader } from './platform-crm';

/** Ключ, под которым читатель заявок по сделке лежит в `ProjectContext.ports.extra`. */
export const DEAL_REQUESTS_PORTS_KEY = 'pragmatika.dealRequests';

/** Что нужно сборке читателя: платформенные интеграции портала и карта полей из окружения. */
export interface DealRequestPortsEnv {
  /** Интеграции Bitrix24 платформы (`ports(env).portal`); нет - портал не настроен. */
  portal: { portal: Bitrix24PortalClient } | undefined;
  config: { project: { BITRIX24_DEAL_FIELD_MAP?: DealFieldMap | undefined } };
}

/**
 * Читатель заявок по сделке для `ports.extra`. Портала нет - пустой объект: заявка по сделке
 * не разбирается, как до возврата поведения. Карта полей проверена схемой конфигурации.
 */
export function buildDealRequestPorts(env: DealRequestPortsEnv): Record<string, unknown> {
  if (env.portal === undefined) return {};
  const reader = new DealPurchaseRequestReader({
    portal: env.portal.portal,
    fieldMap: env.config.project.BITRIX24_DEAL_FIELD_MAP,
    logger: (event, fields) => {
      console.log(JSON.stringify({ event, ...fields }));
    },
  });
  return { [DEAL_REQUESTS_PORTS_KEY]: reader };
}

/** Достать читателя из `ports.extra`; нет - `undefined` (заявка по сделке не разбирается). */
export function dealRequestsOf(
  extra: Readonly<Record<string, unknown>> | undefined,
): PurchaseRequestReader | undefined {
  const found = extra?.[DEAL_REQUESTS_PORTS_KEY];
  if (found instanceof DealPurchaseRequestReader) return found;
  return undefined;
}
